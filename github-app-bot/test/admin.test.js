import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConfigManager, loadConfig } from '../src/config.js';
import { createAdminRouter, AdminRuntime } from '../src/admin/index.js';
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
    headers: { host: 'juya.011070.xyz', 'x-real-ip': '127.0.0.1' },
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
      headers: { host: 'juya.011070.xyz', 'x-real-ip': '203.0.113.5', 'x-forwarded-for': `198.51.100.${attempt}` },
      body: new URLSearchParams({ password: 'wrong-password' }).toString(),
    });
  }

  const limited = await router.route({
    method: 'POST',
    url: '/admin/login',
    headers: { host: 'juya.011070.xyz', 'x-real-ip': '203.0.113.5', 'x-forwarded-for': '198.51.100.99' },
    body: new URLSearchParams({ password: 'wrong-password' }).toString(),
  });
  assert.match(limited.body, /Too many failed attempts/);
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
