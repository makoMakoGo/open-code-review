import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import http from 'node:http';
import { once } from 'node:events';
import { ConfigManager, loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { createAdminRouter, AdminRuntime, formatRepository } from '../src/admin/index.js';
import { AdminJobQueue, BoundedJobLogger, JobEventStore, computeJobStats, createJobEvent, readDailyStats } from '../src/jobs/index.js';

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

test('admin config editor form validates whole candidate, confirms high-risk changes, and audits attempts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir, ADMIN_ALLOWED_HOSTS: 'juya.011070.xyz' }, dataDir: dir });
  await manager.ensureStorageDir();
  const initial = await manager.load();

  await assert.rejects(() => manager.applyEditorForm(new Map([
    ['revision', String(initial.revision)],
    ['value_PORT', '3008'],
  ]), { expectedRevision: initial.revision, clientAddress: '203.0.113.10', currentHost: 'juya.011070.xyz' }), /High-risk config changes require confirmation: PORT/);

  const saved = await manager.applyEditorForm(new Map([
    ['revision', String(initial.revision)],
    ['value_PORT', '3008'],
    ['confirm_PORT', '1'],
    ['secret_OCR_LLM_TOKEN', 'replace'],
    ['value_OCR_LLM_TOKEN', 'replacement-token'],
  ]), { expectedRevision: initial.revision, clientAddress: '203.0.113.10', currentHost: 'juya.011070.xyz' });
  assert.deepEqual(saved.changedKeys, ['OCR_LLM_TOKEN', 'PORT']);
  assert.equal(saved.restartRequired, true);

  await assert.rejects(() => manager.applyEditorForm(new Map([
    ['revision', String(saved.state.revision)],
    ['value_ADMIN_ALLOWED_HOSTS', 'other.example'],
    ['confirm_ADMIN_ALLOWED_HOSTS', '1'],
  ]), { expectedRevision: saved.state.revision, clientAddress: '203.0.113.10', currentHost: 'juya.011070.xyz' }), /must keep the current admin host allowed/);

  const auditText = await fs.readFile(path.join(dir, 'audit', 'config-audit.jsonl'), 'utf8');
  const audit = auditText.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(audit.map(event => event.result), ['failure', 'success', 'failure']);
  assert.deepEqual(audit[1].fieldsChanged, ['OCR_LLM_TOKEN', 'PORT']);
  assert.equal(audit[1].restartRequired, true);
  assert.equal(JSON.stringify(audit).includes('replacement-token'), false);
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

test('admin router uses configured session TTL, cookie security, flash, and security headers', async () => {
  const router = createAdminRouter({
    adminPassword: 'a-secure-admin-password',
    allowedHosts: 'juya.011070.xyz',
    secureCookies: true,
    loadSecurityConfig: () => ({
      adminPassword: 'a-secure-admin-password',
      allowedHosts: 'juya.011070.xyz',
      trustProxy: false,
      cookieSecure: false,
      sessionTtlMs: 60 * 60 * 1000,
    }),
    loadDashboard: () => ({ summary: {}, recentJobs: [], diagnostics: [] }),
    loadConfig: () => ({ revision: 0, fields: [] }),
    saveConfig: () => ({ changedKeys: [] }),
  });
  const login = await router.route({
    method: 'POST',
    url: '/admin/login',
    headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz' },
    body: new URLSearchParams({ password: 'a-secure-admin-password' }).toString(),
  });
  const cookies = login.headers['set-cookie'];
  assert.match(cookies.join('; '), /Max-Age=3600/);
  assert.doesNotMatch(cookies.join('; '), /Secure/);
  const cookie = cookies.join('; ');

  const post = await router.route({
    method: 'POST',
    url: '/admin/config',
    headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz', 'x-forwarded-proto': 'https', cookie },
    body: new URLSearchParams({ _csrf: extractCsrfFromCookie(cookie), revision: '0' }).toString(),
  });
  assert.equal(post.status, 303);
  const config = await router.route({ method: 'GET', url: '/admin/config', headers: { host: 'juya.011070.xyz', cookie } });
  assert.equal(config.headers['permissions-policy'].includes('geolocation=()'), true);
  assert.match(config.body, /Configuration unchanged/);
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

test('queued jobs use latest start-time config snapshot', async () => {
  const startedModels = [];
  let currentModel = 'initial-model';
  let releaseFirstJob;
  const firstJobStarted = new Promise(resolve => { releaseFirstJob = resolve; });
  const queue = new AdminJobQueue({
    configProvider: () => loadConfig({ ...env, OCR_LLM_MODEL: currentModel }),
    handler: async (_payload, context) => {
      startedModels.push(context.config.ocrEnv.OCR_LLM_MODEL);
      if (startedModels.length === 1) await firstJobStarted;
      return { outcome: 'succeeded' };
    },
  });

  await queue.enqueue({ key: 'alice/repo#1@1', payload: {}, metadata: { owner: 'alice', repo: 'repo', pullNumber: 1 } });
  currentModel = 'updated-model';
  await queue.enqueue({ key: 'alice/repo#2@2', payload: {}, metadata: { owner: 'alice', repo: 'repo', pullNumber: 2 } });
  releaseFirstJob();
  await queue.drain();

  assert.deepEqual(startedModels, ['initial-model', 'updated-model']);
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

test('config manager migrates and clears legacy pending restart marker after matching bind', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir });
  await manager.writePendingRestart({ keys: ['PORT'], sinceRevision: 4, createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(await fileExists(path.join(dir, 'pending-restart.json')), false);
  const state = await manager.load();
  assert.deepEqual(state.pendingRestart.keys, ['PORT']);
  const preserved = await manager.clearPendingRestartAfterSuccessfulBind({ desiredPort: 3008, runningPort: 3007 });
  assert.equal(preserved.cleared, false);
  assert.equal((await manager.load()).pendingRestart.required, true);
  const cleared = await manager.clearPendingRestartAfterSuccessfulBind({ desiredPort: 3008, runningPort: 3008 });
  assert.equal(cleared.cleared, true);
  assert.equal((await manager.load()).pendingRestart, null);

  await fs.writeFile(path.join(dir, 'pending-restart.json'), JSON.stringify({ keys: ['PORT'], sinceRevision: 5 }));
  const migrated = await manager.readPendingRestart();
  assert.deepEqual(migrated.keys, ['PORT']);
  assert.equal(await fileExists(path.join(dir, 'pending-restart.json')), false);
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


test('job event store serializes concurrent appends and reports corrupt middle lines without losing truncated tails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-events-'));
  const store = new JobEventStore({ adminDir: dir });
  const ids = Array.from({ length: 12 }, () => cryptoRandomUuid());

  await Promise.all(ids.map((jobId, index) => store.append(createJobEvent({
    type: 'job.queued',
    jobId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    data: { repository: `alice/repo-${index}`, pullNumber: index + 1 },
  }))));

  const eventsFile = path.join(dir, 'jobs', 'events.jsonl');
  await fs.appendFile(eventsFile, '{"id":"corrupt-middle"\n{"id":"truncated-tail"', 'utf8');
  const replayed = await store.replay({ force: true });

  assert.equal(replayed.jobs.length, ids.length);
  assert.equal(replayed.corruptions.length, 1);
  assert.equal(replayed.truncatedTail.lineNumber, ids.length + 2);
  assert.equal(replayed.degraded, true);
  const recoveredId = cryptoRandomUuid();
  await store.append(createJobEvent({ type: 'job.queued', jobId: recoveredId, timestamp: '2026-01-01T12:00:00.000Z', data: { repository: 'alice/recovered', pullNumber: 99 } }));
  const recovered = await store.replay({ force: true });
  assert.equal(recovered.jobs.length, ids.length + 1);
  assert.equal(recovered.truncatedTail, null);
  assert.equal(recovered.corruptions.length, 0);
  assert.equal(recovered.jobs.some(job => job.id === recoveredId), true);
});

test('job event compaction preserves active jobs and structured terminal failure outcome', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-compact-'));
  const store = new JobEventStore({ adminDir: dir });
  const activeId = cryptoRandomUuid();
  const failedId = cryptoRandomUuid();

  await store.append(createJobEvent({ type: 'job.queued', jobId: activeId, timestamp: '2026-01-01T00:00:00.000Z', data: { repository: 'alice/active', pullNumber: 1 } }));
  await store.append(createJobEvent({ type: 'job.queued', jobId: failedId, timestamp: '2025-01-01T00:00:00.000Z', data: { repository: 'alice/failed', pullNumber: 2 } }));
  await store.append(createJobEvent({ type: 'job.failed', jobId: failedId, timestamp: '2025-01-01T00:05:00.000Z', data: { errorKind: 'provider_rate_limited', errorMessage: 'raw provider said token=secret', result: { outcome: 'failed', failure: { kind: 'provider_rate_limited', reason: 'rate limit' }, commentsGenerated: 4, commentsPosted: 0 } } }));

  const result = await store.compact({ now: '2026-06-01T00:00:00.000Z', terminalDetailsBefore: '2025-06-01T00:00:00.000Z' });
  const replayed = await store.replay({ force: true });
  const active = replayed.jobs.find(job => job.id === activeId);
  const failed = replayed.jobs.find(job => job.id === failedId);

  assert.equal(result.terminalDetailsCompacted, 1);
  assert.equal(active.status, 'queued');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorKind, 'provider_rate_limited');
  assert.deepEqual(failed.result.failure, { kind: 'provider_rate_limited' });
  assert.equal(JSON.stringify(failed).includes('raw provider said'), false);
});

test('bounded job logger enforces byte cap with one terminal truncation marker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-logs-'));
  const jobId = cryptoRandomUuid();
  const logger = new BoundedJobLogger({ adminDir: dir, maxBytes: 650, maxMessageLength: 200, maxEntries: 100 });

  for (let index = 0; index < 12; index += 1) {
    await logger.append(jobId, { level: 'info', message: `line-${index}-${'x'.repeat(90)}` });
  }
  await logger.append(jobId, { level: 'error', message: 'after-cap-should-not-appear' });

  const logs = await logger.read(jobId);
  const truncations = logs.entries.filter(entry => entry.message === 'LOG_TRUNCATED');
  assert.equal(truncations.length, 1);
  assert.equal(logs.entries.at(-1).message, 'LOG_TRUNCATED');
  assert.equal(logs.entries.some(entry => entry.message.includes('after-cap-should-not-appear')), false);
});

test('admin retention deletes expired and orphan logs, keeps active logs, compacts details, and writes daily stats', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-retention-'));
  const store = new JobEventStore({ adminDir: dir });
  const logger = new BoundedJobLogger({ adminDir: dir, maxBytes: 4096 });
  const activeId = cryptoRandomUuid();
  const failedId = cryptoRandomUuid();
  const orphanId = cryptoRandomUuid();
  const now = '2026-06-01T00:00:00.000Z';
  const oldMtime = new Date('2026-05-01T00:00:00.000Z');

  await store.append(createJobEvent({ type: 'job.queued', jobId: activeId, timestamp: '2026-05-31T00:00:00.000Z', data: { repository: 'alice/active', pullNumber: 1 } }));
  await store.append(createJobEvent({ type: 'job.queued', jobId: failedId, timestamp: '2026-02-01T00:00:00.000Z', data: { repository: 'alice/failed', pullNumber: 2 } }));
  await store.append(createJobEvent({ type: 'job.failed', jobId: failedId, timestamp: '2026-02-01T00:05:00.000Z', data: { errorKind: 'ocr_runtime_error', errorMessage: 'stack with secret=hidden', result: { outcome: 'failed', failure: { kind: 'ocr_runtime_error', reason: 'runtime' }, commentsGenerated: 3, commentsPosted: 1 } } }));
  await logger.append(activeId, { message: 'active log' });
  await logger.append(failedId, { message: 'expired terminal log' });
  await fs.mkdir(path.join(dir, 'jobs', 'logs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'jobs', 'logs', `${orphanId}.jsonl`), '{"timestamp":"2026-01-01T00:00:00.000Z","level":"info","message":"orphan","fields":{}}\n');
  await fs.utimes(logger.logPath(activeId), oldMtime, oldMtime);
  await fs.utimes(logger.logPath(failedId), oldMtime, oldMtime);
  await fs.utimes(path.join(dir, 'jobs', 'logs', `${orphanId}.jsonl`), oldMtime, oldMtime);

  const runtime = new AdminRuntime({ eventStore: store, logger, configProvider: () => ({ jobLogRetentionDays: 14, jobHistoryRetentionDays: 90, statsRetentionDays: 365, configAuditRetentionDays: 365, jobLogMaxBytes: 4096 }) });
  const result = await runtime.runRetention({ now });
  const replayed = await store.replay({ force: true });
  const stats = await readDailyStats({ adminDir: dir });

  assert.equal(result.logs.expiredDeleted, 1);
  assert.equal(result.logs.orphanDeleted, 1);
  assert.equal(result.logs.skippedActive, 1);
  await fs.access(logger.logPath(activeId));
  await assert.rejects(() => fs.access(logger.logPath(failedId)), /ENOENT/);
  await assert.rejects(() => fs.access(path.join(dir, 'jobs', 'logs', `${orphanId}.jsonl`)), /ENOENT/);
  assert.equal(replayed.jobs.find(job => job.id === failedId).result.failure.kind, 'ocr_runtime_error');
  assert.equal(stats.records.length, 1);
  assert.equal(stats.records[0].failureKinds.ocr_runtime_error, 1);
});

test('job stats compute windowed rates percentiles comments failure kinds repos and daily trend', () => {
  const jobs = [
    { id: cryptoRandomUuid(), status: 'succeeded', queuedAt: '2026-05-31T23:00:00.000Z', startedAt: '2026-05-31T23:05:00.000Z', finishedAt: '2026-05-31T23:15:00.000Z', updatedAt: '2026-05-31T23:15:00.000Z', repository: { owner: 'alice', name: 'repo', fullName: 'alice/repo' }, result: { commentsGenerated: 4, commentsPosted: 3 } },
    { id: cryptoRandomUuid(), status: 'failed', queuedAt: '2026-05-30T00:00:00.000Z', startedAt: '2026-05-30T00:10:00.000Z', finishedAt: '2026-05-30T00:40:00.000Z', updatedAt: '2026-05-30T00:40:00.000Z', repository: { owner: 'alice', name: 'repo', fullName: 'alice/repo' }, errorKind: 'provider_unavailable', result: { commentsGenerated: 0, commentsPosted: 0 } },
  ];

  const stats = computeJobStats(jobs, { now: '2026-06-01T00:00:00.000Z' });

  assert.equal(stats.total.jobs, 2);
  assert.equal(stats.total.successRate, 0.5);
  assert.equal(stats.total.durationP50Ms, 10 * 60 * 1000);
  assert.equal(stats.total.durationP95Ms, 30 * 60 * 1000);
  assert.equal(stats.total.queueWaitP50Ms, 5 * 60 * 1000);
  assert.equal(stats.total.averageCommentsGenerated, 2);
  assert.equal(stats.total.failureKinds.provider_unavailable, 1);
  assert.equal(stats.total.repos['alice/repo'], 2);
  assert.deepEqual(stats.dailyTrend.map(day => day.day), ['2026-05-30', '2026-05-31']);
});


test('admin retention soft cap records early deletion and last run state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-soft-cap-'));
  const store = new JobEventStore({ adminDir: dir });
  const logger = new BoundedJobLogger({ adminDir: dir, maxBytes: 4096 });
  const jobId = cryptoRandomUuid();

  await store.append(createJobEvent({ type: 'job.queued', jobId, timestamp: '2026-05-01T00:00:00.000Z', data: { repository: 'alice/soft-cap', pullNumber: 4 } }));
  await store.append(createJobEvent({ type: 'job.completed', jobId, timestamp: '2026-05-01T00:01:00.000Z', data: { status: 'succeeded', result: { outcome: 'succeeded', commentsGenerated: 1, commentsPosted: 1 } } }));
  await logger.append(jobId, { message: 'large retained log '.repeat(80) });
  await fs.writeFile(path.join(dir, 'retention-state.json'), `${JSON.stringify({ seed: 'x'.repeat(256) })}\n`);

  const before = await fs.stat(logger.logPath(jobId));
  const runtime = new AdminRuntime({ eventStore: store, logger, configProvider: () => ({ jobLogRetentionDays: 14, jobHistoryRetentionDays: 90, statsRetentionDays: 365, configAuditRetentionDays: 365, jobLogMaxBytes: 4096, adminDataMaxBytes: 1 }) });
  const result = await runtime.runRetention({ now: '2026-06-01T00:00:00.000Z' });
  const status = await runtime.retentionStatus();

  assert.equal(result.softCap.applied, true);
  assert.equal(result.softCap.earlyDeletion.some(item => item.kind === 'job-log' && item.jobId === jobId), true);
  assert.equal(result.softCap.bytesReclaimed >= before.size, true);
  assert.equal(status.lastRun.bytesReclaimed, result.bytesReclaimed);
});

test('admin jobs route validates ids and renders escaped redacted detail logs', async () => {
  const jobId = cryptoRandomUuid();
  const router = createAdminRouter({
    adminPassword: 'a-secure-admin-password',
    allowedHosts: 'juya.011070.xyz',
    loadDashboard: () => ({ summary: {}, recentJobs: [], diagnostics: [] }),
    loadJob: ({ jobId: requestedJobId }) => requestedJobId === jobId ? {
      id: jobId,
      repository: { owner: 'alice', name: 'repo', fullName: 'alice/repo' },
      pullNumber: 7,
      actor: '<script>alert(1)</script>',
      diagnosticId: 'alice/repo#7@99',
      queuedAt: '2026-06-01T00:00:00.000Z',
      startedAt: '2026-06-01T00:01:00.000Z',
      finishedAt: '2026-06-01T00:02:00.000Z',
      status: 'failed',
      failure: { kind: 'provider_auth_failed', reason: 'Authorization: Bearer secret-token-123456' },
      runtimeSettings: { ocrConcurrency: 2, OCR_LLM_TOKEN: 'must-not-render' },
      logs: { entries: [{ timestamp: '2026-06-01T00:01:30.000Z', level: 'error', message: 'provider token=super-secret-value', fields: { safe: 'ok', api_key: 'hidden-value' } }] },
    } : null,
  });
  const cookie = await loginCookie(router);

  const invalid = await router.route({ method: 'GET', url: '/admin/jobs/not-a-uuid', headers: { host: 'juya.011070.xyz', cookie } });
  assert.equal(invalid.status, 404);

  const detail = await router.route({ method: 'GET', url: `/admin/jobs/${jobId}`, headers: { host: 'juya.011070.xyz', cookie } });
  assert.equal(detail.status, 200);
  assert.match(detail.body, /alice\/repo#7/);
  assert.match(detail.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(detail.body, /Authorization=•••••••• ••••••••/);
  assert.match(detail.body, /token=••••••••/);
  assert.match(detail.body, /&quot;api_key&quot;: &quot;••••••••&quot;/);
  assert.doesNotMatch(detail.body, /secret-token-123456/);
  assert.doesNotMatch(detail.body, /must-not-render/);
  assert.doesNotMatch(detail.body, /super-secret-value/);
  assert.doesNotMatch(detail.body, /<script>alert/);
});

test('admin jobs route preserves filters in pagination links', async () => {
  const router = createAdminRouter({
    adminPassword: 'a-secure-admin-password',
    allowedHosts: 'juya.011070.xyz',
    loadJobs: ({ request }) => ({
      jobs: [{ id: cryptoRandomUuid(), status: 'failed', repository: { owner: 'alice', name: 'repo', fullName: 'alice/repo' }, pullNumber: 3, actor: 'alice', diagnosticId: 'diag-1', queuedAt: '2026-06-01T00:00:00.000Z' }],
      filters: { owner: request.query.get('owner'), repository: request.query.get('repository'), state: request.query.get('state'), failureKind: request.query.get('failureKind'), diagnosticId: request.query.get('diagnosticId'), from: request.query.get('from'), to: request.query.get('to') },
      pagination: { page: 2, pageSize: 1, total: 3, totalPages: 3, hasPrev: true, hasNext: true, prevPage: 1, nextPage: 3 },
      validationMessages: ['from must be a valid date'],
    }),
  });
  const cookie = await loginCookie(router);
  const response = await router.route({ method: 'GET', url: '/admin/jobs?owner=alice&repository=repo&state=failed&failureKind=provider_unavailable&diagnosticId=diag&from=bad-date&to=2026-06-01&size=1&page=2', headers: { host: 'juya.011070.xyz', cookie } });

  assert.equal(response.status, 200);
  assert.match(response.body, /from must be a valid date/);
  assert.match(response.body, /page=1/);
  assert.match(response.body, /page=3/);
  assert.match(response.body, /owner=alice/);
  assert.match(response.body, /failureKind=provider_unavailable/);
  assert.match(response.body, /from=bad-date/);
});

test('job stats report skipped and stale outside success rate denominator', () => {
  const jobs = [
    { id: cryptoRandomUuid(), status: 'succeeded', queuedAt: '2026-06-01T00:00:00.000Z', startedAt: '2026-06-01T00:00:00.000Z', finishedAt: '2026-06-01T00:01:00.000Z', updatedAt: '2026-06-01T00:01:00.000Z', repository: { owner: 'alice', name: 'repo', fullName: 'alice/repo' } },
    { id: cryptoRandomUuid(), status: 'failed', queuedAt: '2026-06-01T00:02:00.000Z', startedAt: '2026-06-01T00:02:00.000Z', finishedAt: '2026-06-01T00:03:00.000Z', updatedAt: '2026-06-01T00:03:00.000Z', repository: { owner: 'alice', name: 'repo', fullName: 'alice/repo' } },
    { id: cryptoRandomUuid(), status: 'skipped', queuedAt: '2026-06-01T00:04:00.000Z', finishedAt: '2026-06-01T00:04:00.000Z', updatedAt: '2026-06-01T00:04:00.000Z', repository: { owner: 'alice', name: 'repo', fullName: 'alice/repo' } },
    { id: cryptoRandomUuid(), status: 'stale', queuedAt: '2026-06-01T00:05:00.000Z', finishedAt: '2026-06-01T00:05:00.000Z', updatedAt: '2026-06-01T00:05:00.000Z', repository: { owner: 'alice', name: 'repo', fullName: 'alice/repo' } },
  ];
  const stats = computeJobStats(jobs, { now: '2026-06-02T00:00:00.000Z' });
  assert.equal(stats.total.succeeded, 1);
  assert.equal(stats.total.failed, 1);
  assert.equal(stats.total.skipped, 1);
  assert.equal(stats.total.stale, 1);
  assert.equal(stats.total.successRate, 0.5);
  assert.equal(stats.total.failureRate, 0.5);
});

test('core health route survives admin runtime failures', async () => {
  const config = loadConfig({ ...env, ADMIN_PASSWORD: 'a-secure-admin-password', ADMIN_ALLOWED_HOSTS: 'juya.011070.xyz' });
  const server = createServer(config, { adminRuntime: { dashboard: async () => { throw new Error('admin storage down'); } } });
  await listen(server);
  try {
    const health = await requestJson(server, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    const admin = await requestText(server, 'GET', '/admin/', { host: 'juya.011070.xyz' });
    assert.equal(admin.status, 303);
  } finally {
    await server.shutdown({ timeoutMs: 1000 });
  }
});

test('graceful shutdown stops new review jobs', async () => {
  const config = loadConfig(env);
  const queue = new AdminJobQueue({
    handler: async () => ({ outcome: 'succeeded' }),
    configProvider: () => config,
  });
  const server = createServer(config, { queue, adminRuntime: { dashboard: () => ({}) } });
  await listen(server);
  await server.shutdown({ timeoutMs: 1000 });
  const result = await queue.enqueue({ key: 'alice/repo#9@10', payload: {}, metadata: { owner: 'alice', repo: 'repo', pullNumber: 9 } });
  assert.equal(result.stopped, true);
});

async function loginCookie(router) {
  const login = await router.route({
    method: 'POST',
    url: '/admin/login',
    headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz' },
    body: new URLSearchParams({ password: 'a-secure-admin-password' }).toString(),
  });
  assert.equal(login.status, 303);
  return login.headers['set-cookie'].join('; ');
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}

function serverPort(server) {
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.ok(address);
  return address.port;
}

async function requestJson(server, method, pathName, headers = {}) {
  const response = await requestText(server, method, pathName, headers);
  return { ...response, body: JSON.parse(response.body) };
}

function requestText(server, method, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: serverPort(server), method, path: pathName, headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function extractCsrfFromCookie(cookie) {
  const match = cookie.match(/ocr_admin_csrf=([^;]+)/);
  assert.ok(match, 'csrf cookie missing');
  return decodeURIComponent(match[1]);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function cryptoRandomUuid() {
  return crypto.randomUUID();
}
