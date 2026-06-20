import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConfigManager, loadConfig } from '../src/config.js';
import { createAdminRouter, AdminRuntime, formatRepository } from '../src/admin/index.js';
import { AdminJobQueue, JobEventStore, createJobEvent } from '../src/jobs/index.js';

const env = {
  PORT: '3007',
  BOT_TRIGGER_PHRASE: '/juya review',
  BOT_TRIGGER_PHRASES: '/juya review',
  ALLOWED_USERS: 'alice',
  ALLOWED_USER_IDS: '',
  ALLOWED_REPO_OWNERS: 'alice',
  BOT_REPO_ROOT: '/data/repos',
  GITHUB_APP_ID: '12345',
  GITHUB_WEBHOOK_SECRET: 'webhook-secret',
  OCR_LLM_URL: 'http://127.0.0.1:3007/llm/anthropic',
  OCR_LLM_TOKEN: 'ocr-token',
  OCR_LLM_MODEL: 'glm-5.2',
};

test('admin config manager applies overrides without leaking secrets in summaries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir });
  await manager.ensureStorageDir();
  await manager.writeOverrides({ OCR_CONCURRENCY: '3', OCR_LLM_TOKEN: 'new-secret' });

  const state = await manager.load();
  assert.equal(state.config.ocrConcurrency, 3);
  assert.equal(state.summary.values.ocrConcurrency.value, 3);
  assert.equal(state.summary.secrets.ocrLlmToken.set, true);
  assert.equal(JSON.stringify(state.summary).includes('new-secret'), false);
});

test('admin config rejects dashboard edits to admin credentials and data root', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir });
  await manager.ensureStorageDir();

  await assert.rejects(() => manager.writeOverrides({ ADMIN_PASSWORD: 'new-password' }), /ADMIN_PASSWORD cannot be edited/);
  await assert.rejects(() => manager.writeOverrides({ ADMIN_DATA_DIR: '/tmp/other' }), /ADMIN_DATA_DIR cannot be edited/);
});

test('admin config applies secret blank keep clear replace semantics', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir });
  await manager.ensureStorageDir();
  await manager.setRawOverride('LLM_PROXY_INTERNAL_TOKEN', 'first-secret');
  await manager.applySecretOverride('LLM_PROXY_INTERNAL_TOKEN', { value: '' });
  assert.equal((await manager.readOverrides()).LLM_PROXY_INTERNAL_TOKEN, 'first-secret');
  await manager.applySecretOverride('LLM_PROXY_INTERNAL_TOKEN', { value: 'second-secret' });
  assert.equal((await manager.readOverrides()).LLM_PROXY_INTERNAL_TOKEN, 'second-secret');
  await manager.applySecretOverride('LLM_PROXY_INTERNAL_TOKEN', { clear: true });
  assert.equal((await manager.readOverrides()).LLM_PROXY_INTERNAL_TOKEN, '');
});

test('admin config normalizes keys before routing save semantics', async () => {
  const calls = [];
  const manager = {
    async applySecretOverride(key, edit) { calls.push(['secret', key, edit]); },
    async setRawOverride(key, value) { calls.push(['raw', key, value]); },
  };
  const { saveAdminConfigOverride } = await import('../src/server.js');

  await saveAdminConfigOverride({
    configManager: manager,
    request: { headers: { host: 'juya.011070.xyz' } },
    form: new Map([['key', ' OCR_LLM_TOKEN '], ['value', 'replacement']]),
  });
  assert.deepEqual(calls, [['secret', 'OCR_LLM_TOKEN', { value: 'replacement', clear: false }]]);

  await assert.rejects(() => saveAdminConfigOverride({
    configManager: manager,
    request: { headers: { host: 'juya.011070.xyz' } },
    form: new Map([['key', ' ADMIN_ALLOWED_HOSTS '], ['value', 'other.example']]),
  }), /must keep the current admin host allowed/);
});

test('admin router stays hidden when disabled and serves dashboard after login', async () => {
  const disabled = createAdminRouter({ adminPassword: '', allowedHosts: 'juya.011070.xyz' });
  const disabledResponse = await disabled.route({ method: 'GET', url: '/admin/', headers: { host: 'juya.011070.xyz' } });
  assert.equal(disabledResponse.status, 404);

  const router = createAdminRouter({
    adminPassword: 'a-secure-admin-password',
    allowedHosts: 'juya.011070.xyz',
    secureCookies: true,
    loadDashboard: () => ({ summary: { queued: 0, running: 0, succeeded: 1, failed: 0 }, recentJobs: [], diagnostics: [] }),
  });
  const login = await router.route({
    method: 'POST',
    url: '/admin/login',
    headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz' },
    body: new URLSearchParams({ password: 'a-secure-admin-password' }).toString(),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers['set-cookie'].join('; ');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const dashboard = await router.route({ method: 'GET', url: '/admin/', headers: { host: 'juya.011070.xyz', cookie } });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.body, /Open Code Review Admin/);
});

test('admin router rate limit ignores spoofed forwarded-for and rejects private hosts by default', async () => {
  const privateHost = createAdminRouter({ adminPassword: 'a-secure-admin-password', allowedHosts: 'juya.011070.xyz' });
  const privateHostResponse = await privateHost.route({ method: 'GET', url: '/admin/login', headers: { host: '192.168.1.10' } });
  assert.equal(privateHostResponse.status, 403);

  const router = createAdminRouter({ adminPassword: 'a-secure-admin-password', allowedHosts: 'juya.011070.xyz' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await router.route({
      method: 'POST',
      url: '/admin/login',
      headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz', 'x-real-ip': '203.0.113.5', 'x-forwarded-for': `198.51.100.${attempt}` },
      body: new URLSearchParams({ password: 'wrong-password' }).toString(),
    });
  }

  const limited = await router.route({
    method: 'POST',
    url: '/admin/login',
    headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz', 'x-real-ip': '203.0.113.6', 'x-forwarded-for': '198.51.100.99' },
    body: new URLSearchParams({ password: 'wrong-password' }).toString(),
  });
  assert.match(limited.body, /Too many failed attempts/);
});

test('admin POST requires same-origin metadata and trusts proxy headers only when enabled', async () => {
  const router = createAdminRouter({ adminPassword: 'a-secure-admin-password', allowedHosts: 'juya.011070.xyz' });
  const noOrigin = await router.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz' }, body: new URLSearchParams({ password: 'x' }).toString() });
  assert.equal(noOrigin.status, 403);

  const trusted = createAdminRouter({ adminPassword: 'a-secure-admin-password', allowedHosts: 'juya.011070.xyz', loadSecurityConfig: () => ({ adminPassword: 'a-secure-admin-password', allowedHosts: 'juya.011070.xyz', trustProxy: true }) });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await trusted.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz', 'x-real-ip': '203.0.113.7' }, body: new URLSearchParams({ password: 'bad' }).toString() });
  }
  const limited = await trusted.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz', 'x-real-ip': '203.0.113.7' }, body: new URLSearchParams({ password: 'bad' }).toString() });
  assert.match(limited.body, /Too many failed attempts/);
});

test('disabled admin POST remains hidden before origin validation', async () => {
  const router = createAdminRouter({ adminPassword: '', allowedHosts: 'juya.011070.xyz' });
  const response = await router.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz' }, body: new URLSearchParams({ password: 'x' }).toString() });
  assert.equal(response.status, 404);
});

test('admin POST origin must match protocol host and port', async () => {
  const router = createAdminRouter({ adminPassword: 'a-secure-admin-password', allowedHosts: 'juya.011070.xyz:8443' });
  const wrongPort = await router.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz:8443', origin: 'https://juya.011070.xyz' }, body: new URLSearchParams({ password: 'x' }).toString() });
  assert.equal(wrongPort.status, 403);
  const wrongProtocol = await router.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz:8443', origin: 'http://juya.011070.xyz:8443' }, body: new URLSearchParams({ password: 'x' }).toString() });
  assert.equal(wrongProtocol.status, 403);
  const sameOrigin = await router.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz:8443', origin: 'https://juya.011070.xyz:8443' }, body: new URLSearchParams({ password: 'x' }).toString() });
  assert.equal(sameOrigin.status, 200);
  assert.match(sameOrigin.body, /Invalid password/);
  const httpTrusted = createAdminRouter({
    adminPassword: 'a-secure-admin-password',
    allowedHosts: 'juya.011070.xyz:8080',
    loadSecurityConfig: () => ({ adminPassword: 'a-secure-admin-password', allowedHosts: 'juya.011070.xyz:8080', trustProxy: true }),
  });
  const forwardedHttp = await httpTrusted.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz:8080', origin: 'http://juya.011070.xyz:8080', 'x-forwarded-proto': 'http' }, body: new URLSearchParams({ password: 'x' }).toString() });
  assert.equal(forwardedHttp.status, 200);
});

test('admin queue persists job history and replay marks active jobs interrupted', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-jobs-'));
  const store = new JobEventStore({ adminDir: dir });
  const queue = new AdminJobQueue({
    store,
    configProvider: () => loadConfig(env),
    handler: async () => ({ outcome: 'succeeded_with_warnings', commentsGenerated: 2, commentsPosted: 1 }),
  });

  const result = await queue.enqueue({
    key: 'alice/repo#1@2',
    payload: { ok: true },
    metadata: { owner: 'alice', repo: 'repo', pullNumber: 1, actor: 'alice', trigger: '/juya review' },
  });
  assert.equal(result.queued, true);
  await queue.drain();

  const replayed = await store.replay();
  assert.equal(replayed.jobs[0].status, 'succeeded_with_warnings');
  assert.equal(replayed.jobs[0].repository.fullName, 'alice/repo');
});

test('admin runtime interrupts active replayed jobs and refreshes history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-runtime-'));
  const store = new JobEventStore({ adminDir: dir });
  const activeJob = createJobEvent({ type: 'job.queued', jobId: cryptoRandomUuid(), data: { repository: 'alice/repo', pullNumber: 2 } });
  await store.append(activeJob);

  const runtime = new AdminRuntime({ eventStore: store });
  await runtime.initialize();
  const interrupted = await store.replay();
  assert.equal(interrupted.jobs[0].status, 'interrupted');

  await store.append(createJobEvent({ type: 'job.completed', jobId: activeJob.jobId, data: { status: 'succeeded', repository: 'alice/repo', pullNumber: 2 } }));
  const jobs = await runtime.jobs();
  assert.equal(jobs[0].status, 'succeeded');
});

test('admin runtime does not double count persisted active jobs and live queue', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-runtime-'));
  const store = new JobEventStore({ adminDir: dir });
  await store.append(createJobEvent({ type: 'job.queued', jobId: cryptoRandomUuid(), data: { repository: 'alice/repo', pullNumber: 2 } }));
  const runtime = new AdminRuntime({ eventStore: store, queue: { snapshot: () => ({ running: null, queuedCount: 1, queued: [] }) } });
  const dashboard = await runtime.dashboard();
  assert.equal(dashboard.summary.queued, 1);
  assert.equal(dashboard.summary.running, 0);
});

test('config manager writes port override and restart marker in one state file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir });
  await manager.setRawOverride('PORT', '3008');
  const rawState = JSON.parse(await fs.readFile(path.join(dir, 'config-overrides.json'), 'utf8'));
  assert.equal(rawState.overrides.PORT, '3008');
  assert.deepEqual(rawState.pendingRestart.keys, ['PORT']);
  const state = await manager.load();
  assert.equal(state.pendingRestart.sinceRevision, rawState.revision);
});

test('admin repository formatter renders object full name', () => {
  assert.equal(formatRepository({ owner: 'alice', name: 'repo', fullName: 'alice/repo' }), 'alice/repo');
  assert.equal(formatRepository({ owner: 'alice', name: 'repo' }), 'alice/repo');
});

test('failed review results persist as failed events with failure kind', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-failed-'));
  const store = new JobEventStore({ adminDir: dir });
  const queue = new AdminJobQueue({
    store,
    configProvider: () => loadConfig(env),
    handler: async () => ({ outcome: 'failed', failure: { kind: 'provider_rate_limited', reason: 'rate limit' } }),
  });

  await queue.enqueue({ key: 'alice/repo#3@4', payload: {}, metadata: { owner: 'alice', repo: 'repo', pullNumber: 3 } });
  await queue.drain();

  const replayed = await store.replay();
  assert.equal(replayed.jobs[0].status, 'failed');
  assert.equal(replayed.jobs[0].errorKind, 'provider_rate_limited');
});

function cryptoRandomUuid() {
  return crypto.randomUUID();
}
