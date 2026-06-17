import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  authorizePayload,
  buildReviewComment,
  copyProxyHeaders,
  csvSet,
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
    headers: { 'x-internal-token': 'wrong' },
    on() {
      throw new Error('body reader should not be attached before auth');
    },
  };
  assert.equal(verifyInternalToken('secret', req.headers['x-internal-token']), false);
  await assert.rejects(readRequestBody(req, 64 * 1024 * 1024), /body reader should not be attached/);
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
