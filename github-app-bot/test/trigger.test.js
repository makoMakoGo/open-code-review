import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  authorizePayload,
  buildFailureComment,
  buildReviewComment,
  classifyReviewFailure,
  copyProxyHeaders,
  csvSet,
  extractInternalTokenFromHeaders,
  isTrigger,
  readRequestBody,
  loadConfig,
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
test('classifies OCR timeout with generated progress summary', () => {
  const error = new Error('ocr review timed out after 1800000ms: {"status":"success","summary":{"files_reviewed":37,"comments":9,"elapsed":"36m19s"}}');
  const failure = classifyReviewFailure(error, { jobTimeoutMs: 1800000 });
  assert.equal(failure.kind, 'job_timeout');
  assert.equal(failure.retryable, true);
  assert.deepEqual(failure.details, [
    'Timeout: 30m',
    'Files reviewed before timeout: 37',
    'Comments generated before timeout: 9',
    'OCR elapsed time: 36m19s',
  ]);
  const body = buildFailureComment(failure, 'owner/repo#7@123');
  assert.match(body, /review exceeded the 30m job timeout/);
  assert.match(body, /Files reviewed before timeout: 37/);
  assert.match(body, /Diagnostic id: `owner\/repo#7@123`/);
});

test('classifies provider auth and rate-limit failures without leaking raw output', () => {
  const auth = classifyReviewFailure(new Error('provider returned 401 unauthorized: invalid api key'), { jobTimeoutMs: 1800000 });
  assert.equal(auth.kind, 'provider_auth_failed');
  assert.equal(auth.retryable, false);
  assert.doesNotMatch(buildFailureComment(auth, 'owner/repo#7@123'), /invalid api key/);

  const rateLimit = classifyReviewFailure(new Error('provider returned 429 too many requests: concurrency limit exceeded'), { jobTimeoutMs: 1800000 });
  assert.equal(rateLimit.kind, 'provider_rate_limited');
  assert.equal(rateLimit.retryable, true);
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
