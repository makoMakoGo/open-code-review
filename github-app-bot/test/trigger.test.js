import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  authorizePayload,
  buildFailureComment,
  buildInvalidOcrOutputFailure,
  buildOcrStatusSummary,
  buildReviewComment,
  buildStaleReviewComment,
  classifyReviewFailure,
  copyProxyHeaders,
  csvSet,
  extractInternalTokenFromHeaders,
  isTrigger,
  readRequestBody,
  loadConfig,
  shouldDiscardStaleReview,
  validateOcrResult,
  verifyGitHubSignature,
  verifyInternalToken,
} from '../src/server.js';

const baseConfig = {
  triggerPhrases: csvSet('/ocr review'),
  allowedUsers: csvSet('owner-login,friend-login'),
  allowedUserIDs: csvSet('123456789'),
  allowedRepoOwners: csvSet('owner-login'),
};

function payload(overrides = {}) {
  return {
    action: 'created',
    issue: { number: 7, pull_request: {} },
    comment: { body: '/ocr review', id: 1 },
    sender: { login: 'friend-login', id: 1 },
    repository: { owner: { login: 'owner-login' }, private: false },
    installation: { id: 42 },
    ...overrides,
  };
}

test('matches exact slash command after trimming whitespace', () => {
  const triggers = csvSet('/ocr review');
  assert.equal(isTrigger('  /ocr review\n', triggers), true);
});

test('rejects partial and extended commands', () => {
  const triggers = csvSet('/ocr review');
  assert.equal(isTrigger('/ocr', triggers), false);
  assert.equal(isTrigger('/ocr review now', triggers), false);
});

test('authorizes sender by login case-insensitively', () => {
  assert.deepEqual(authorizePayload(payload({ sender: { login: 'FRIEND-login', id: 1 } }), baseConfig), { ok: true });
});

test('authorizes sender by numeric GitHub id', () => {
  assert.deepEqual(authorizePayload(payload({ sender: { login: 'renamed-user', id: 123456789 } }), baseConfig), { ok: true });
});

test('rejects sender outside login and id allowlists', () => {
  assert.deepEqual(authorizePayload(payload({ sender: { login: 'random', id: 2 } }), baseConfig), { ok: false, reason: 'sender not allowed' });
});

test('rejects private repositories when public-only mode is enabled', () => {
  assert.deepEqual(authorizePayload(payload({ repository: { owner: { login: 'owner-login' }, private: true } }), baseConfig), { ok: false, reason: 'private repo ignored' });
});

test('verifies GitHub HMAC signatures over the raw body', () => {
  const body = Buffer.from('{"zen":"non-empty"}');
  const signature = 'sha256=' + cryptoHmac('secret', body);
  assert.equal(verifyGitHubSignature('secret', body, signature), true);
  assert.equal(verifyGitHubSignature('secret', body, 'sha256=' + cryptoHmac('other', body)), false);
});

test('builds right-side single-line review comments', () => {
  assert.deepEqual(buildReviewComment({ path: 'src/app.js', content: 'Fix this', start_line: 4, end_line: 4 }), {
    path: 'src/app.js',
    body: 'Fix this',
    line: 4,
    side: 'RIGHT',
  });
});

test('extracts internal proxy tokens from OCR-supported auth headers', () => {
  assert.equal(extractInternalTokenFromHeaders({ authorization: 'Bearer secret' }), 'secret');
  assert.equal(extractInternalTokenFromHeaders({ authorization: 'secret' }), 'secret');
  assert.equal(extractInternalTokenFromHeaders({ 'x-api-key': 'secret' }), 'secret');
  assert.equal(extractInternalTokenFromHeaders({}), '');
});

test('requires the internal token for LLM proxy access', () => {
  assert.equal(verifyInternalToken('secret', 'secret'), true);
  assert.equal(verifyInternalToken('secret', 'wrong'), false);
  assert.equal(verifyInternalToken('', 'secret'), false);
});

test('proxy header copying strips internal token and sets configured user agent', () => {
  const req = {
    headers: {
      host: 'localhost',
      authorization: 'Bearer token',
      'x-internal-token': 'secret',
      'user-agent': 'client',
      cookie: 'session=secret',
      'proxy-authorization': 'Basic secret',
    },
  };
  assert.deepEqual(copyProxyHeaders(req, {
    llmProxyUserAgent: 'bot-agent',
    llmProxyXApp: 'cli',
    llmProxyUpstreamAuthHeader: 'authorization',
    llmProxyUpstreamToken: 'Bearer upstream',
  }), {
    'user-agent': 'bot-agent',
    'x-app': 'cli',
    authorization: 'Bearer upstream',
  });
});

test('loadConfig rejects non-numeric concurrency', () => {
  assert.throws(() => loadConfig({ ...validEnv(), OCR_CONCURRENCY: 'many' }), /OCR_CONCURRENCY must be an integer/);
});

test('loadConfig requires internal token when LLM proxy is enabled', () => {
  assert.throws(() => loadConfig({
    ...validEnv(),
    LLM_PROXY_TARGET_URL: 'https://provider.example.com/anthropic/v1/messages',
  }), /LLM_PROXY_INTERNAL_TOKEN is required/);
});

test('loadConfig requires upstream proxy auth fields to be paired', () => {
  assert.throws(() => loadConfig({
    ...validEnv(),
    LLM_PROXY_UPSTREAM_AUTH_HEADER: 'authorization',
  }), /LLM_PROXY_UPSTREAM_AUTH_HEADER and LLM_PROXY_UPSTREAM_TOKEN must be set together/);
});

test('invalid internal token can be rejected before reading proxy body', async () => {
  const req = {
    headers: { authorization: 'Bearer wrong' },
    on() {
      throw new Error('body reader should not be attached before auth');
    },
  };
  assert.equal(verifyInternalToken('secret', extractInternalTokenFromHeaders(req.headers)), false);
  await assert.rejects(readRequestBody(req, 64 * 1024 * 1024), /body reader should not be attached/);
});
test('classifies OCR timeout without pretending progress is available', () => {
  const failure = classifyReviewFailure({ phase: 'ocr', timedOut: true, timeoutMs: 1800000, message: 'ocr review timed out' }, { jobTimeoutMs: 1800000 });
  assert.equal(failure.kind, 'job_timeout');
  assert.equal(failure.retryable, true);
  assert.deepEqual(failure.details, ['Timeout: 30m']);
  const body = buildFailureComment(failure, 'owner/repo#7@123');
  assert.match(body, /review exceeded the 30m job timeout/);
  assert.doesNotMatch(body, /Files reviewed before timeout/);
  assert.match(body, /Diagnostic id: `owner\/repo#7@123`/);
});

test('classifies OCR provider auth and rate-limit failures without leaking raw output', () => {
  const auth = classifyReviewFailure({ phase: 'ocr', message: 'provider returned 401 unauthorized: invalid api key' }, { jobTimeoutMs: 1800000 });
  assert.equal(auth.kind, 'provider_auth_failed');
  assert.equal(auth.retryable, false);
  assert.doesNotMatch(buildFailureComment(auth, 'owner/repo#7@123'), /invalid api key/);

  const rateLimit = classifyReviewFailure({ phase: 'ocr', message: 'provider returned 403 rate limit exceeded' }, { jobTimeoutMs: 1800000 });
  assert.equal(rateLimit.kind, 'provider_rate_limited');
  assert.equal(rateLimit.retryable, true);
});

test('classifies OCR config, provider availability, and runtime failures', () => {
  const config = classifyReviewFailure({ phase: 'ocr', message: 'OCR environment: unsupported auth_header value "x-internal-token"' }, { jobTimeoutMs: 1800000 });
  assert.equal(config.kind, 'ocr_config_error');
  assert.equal(config.retryable, false);

  const unavailable = classifyReviewFailure({ phase: 'ocr', message: 'fetch failed: ECONNRESET' }, { jobTimeoutMs: 1800000 });
  assert.equal(unavailable.kind, 'provider_unavailable');
  assert.equal(unavailable.retryable, true);

  const unknown = classifyReviewFailure({ phase: 'ocr', message: 'unexpected runtime failure' }, { jobTimeoutMs: 1800000 });
  assert.equal(unknown.kind, 'ocr_runtime_error');
  assert.equal(unknown.retryable, false);
});

test('detects stale review results when PR head or base changes during OCR', () => {
  const reviewed = { headSha: 'old-head', baseSha: 'old-base', baseRef: 'main' };
  assert.equal(shouldDiscardStaleReview(reviewed, { head: { sha: 'new-head' }, base: { sha: 'old-base', ref: 'main' } }), true);
  assert.equal(shouldDiscardStaleReview(reviewed, { head: { sha: 'old-head' }, base: { sha: 'new-base', ref: 'main' } }), true);
  assert.equal(shouldDiscardStaleReview(reviewed, { head: { sha: 'old-head' }, base: { sha: 'old-base', ref: 'release' } }), true);
  assert.equal(shouldDiscardStaleReview(reviewed, { head: { sha: 'old-head' }, base: { sha: 'old-base', ref: 'main' } }), false);
  const body = buildStaleReviewComment(reviewed, { head: { sha: 'new-head' }, base: { sha: 'new-base', ref: 'release' } }, 'owner/repo#7@123');
  assert.match(body, /PR changed while OpenCodeReview was running/);
  assert.match(body, /Reviewed head: `old-head`/);
  assert.match(body, /Current head: `new-head`/);
  assert.match(body, /Reviewed base: `main@old-base`/);
  assert.match(body, /Current base: `release@new-base`/);
  assert.match(body, /Diagnostic id: `owner\/repo#7@123`/);
});

test('classifies non-OCR failures by phase instead of provider heuristics', () => {
  const git = classifyReviewFailure({ phase: 'git', command: 'git', timedOut: true, timeoutMs: 180000, message: 'git fetch timed out after 180000ms' }, { jobTimeoutMs: 1800000 });
  assert.equal(git.kind, 'git_error');
  assert.equal(git.details[0], 'Timeout: 3m');

  const github = classifyReviewFailure({ status: 502, message: 'GitHub API 502' }, { jobTimeoutMs: 1800000 });
  assert.equal(github.kind, 'github_api_error');
  assert.equal(github.retryable, true);

  const runtime = classifyReviewFailure(new Error('unexpected runtime failure'), { jobTimeoutMs: 1800000 });
  assert.equal(runtime.kind, 'bot_runtime_error');
});

test('builds invalid OCR JSON failures with safe diagnostics only', () => {
  const failure = buildInvalidOcrOutputFailure('{not json');
  assert.equal(failure.kind, 'invalid_ocr_output');
  assert.deepEqual(failure.details, [
    'OCR stdout bytes: 9',
    'OCR stdout sha256: 92072df399cb74703f8e86f450d552bc0bb01eeeb98a90985a1b7772c8fd0016',
  ]);
  const body = buildFailureComment(failure, 'owner/repo#7@123');
  assert.doesNotMatch(body, /not json/);
  assert.match(body, /Diagnostic id: `owner\/repo#7@123`/);
});

test('validates OCR JSON shape and summarizes warning statuses safely', () => {
  assert.equal(validateOcrResult({ status: 'success', comments: [] }), true);
  assert.equal(validateOcrResult({ status: 'completed_with_errors', comments: [{ path: 'a.js' }], warnings: [{ message: 'secret provider output' }] }), true);
  assert.equal(validateOcrResult({ status: 'completed_with_warnings', comments: [], warnings: [{ message: 'sensitive detail' }] }), true);
  assert.equal(validateOcrResult({ status: 'weird', comments: [] }), false);
  assert.equal(validateOcrResult({ status: 'success' }), false);
  assert.equal(validateOcrResult({ status: 'success', comments: {} }), false);
  assert.equal(validateOcrResult({ status: 'completed_with_warnings', comments: [] }), false);
  assert.equal(validateOcrResult({ status: 'completed_with_errors', comments: [], warnings: [] }), false);
  assert.equal(validateOcrResult({ status: 'completed_with_errors', comments: [], warnings: {} }), false);

  const errorSummary = buildOcrStatusSummary({ status: 'completed_with_errors', warnings: [{ message: 'secret provider output' }] }, 'owner/repo#7@123');
  assert.match(errorSummary, /some files may not have been reviewed/);
  assert.match(errorSummary, /Warnings: 1/);
  assert.match(errorSummary, /Diagnostic id: `owner\/repo#7@123`/);
  assert.doesNotMatch(errorSummary, /secret provider output/);

  const warningSummary = buildOcrStatusSummary({ status: 'completed_with_warnings', comments: [], warnings: [{ type: 'warning', message: 'sensitive detail' }] }, 'owner/repo#7@123');
  assert.match(warningSummary, /completed with warnings/);
  assert.match(warningSummary, /Warnings: 1/);
  assert.match(warningSummary, /Diagnostic id: `owner\/repo#7@123`/);
  assert.doesNotMatch(warningSummary, /sensitive detail/);
});

test('classifies GitHub API rate limits separately from permission errors', () => {
  const rateLimited = classifyReviewFailure({ status: 403, message: 'API rate limit exceeded', response: { headers: { 'x-ratelimit-remaining': '0' } } }, { jobTimeoutMs: 1800000 });
  assert.equal(rateLimited.kind, 'github_rate_limited');
  assert.equal(rateLimited.retryable, true);

  const permission = classifyReviewFailure({ status: 403, message: 'Resource not accessible by integration', response: { headers: {} } }, { jobTimeoutMs: 1800000 });
  assert.equal(permission.kind, 'github_api_error');
  assert.equal(permission.retryable, false);
});

function validEnv() {
  return {
    BOT_TRIGGER_PHRASE: '/ocr review',
    ALLOWED_USERS: 'owner-login',
    ALLOWED_REPO_OWNERS: 'owner-login',
    BOT_REPO_ROOT: '/data/repos',
    GITHUB_APP_ID: '123',
    GITHUB_WEBHOOK_SECRET: 'secret',
    OCR_LLM_URL: 'https://api.example.com',
    OCR_LLM_TOKEN: 'token',
    OCR_LLM_MODEL: 'model',
  };
}

function cryptoHmac(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
