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
import { createAdminRouter, AdminRuntime, formatRepository, renderConfigPage } from '../src/admin/index.js';
import { AdminJobQueue, BoundedJobLogger, JobEventStore, computeJobStats, createJobEvent, readDailyStats, redactSensitiveString } from '../src/jobs/index.js';

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
  assert.deepEqual(audit.map(event => event.result), ['failure', 'attempt', 'success', 'failure']);
  assert.deepEqual(audit[1].fieldsChanged, ['OCR_LLM_TOKEN', 'PORT']);
  assert.deepEqual(audit[2].fieldsChanged, ['OCR_LLM_TOKEN', 'PORT']);
  assert.equal(audit[2].restartRequired, true);
  assert.equal(JSON.stringify(audit).includes('replacement-token'), false);
});

test('admin config success audit failure does not fail committed editor save', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-success-audit-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir });
  await manager.ensureStorageDir();
  const initial = await manager.load();
  const originalAppend = manager.appendConfigAudit.bind(manager);
  let calls = 0;
  manager.appendConfigAudit = async event => {
    calls += 1;
    if (event.result === 'success') throw new Error('audit disk full after commit');
    return originalAppend(event);
  };
  const originalError = console.error;
  console.error = () => {};
  let saved;
  try {
    saved = await manager.applyEditorForm(new Map([
      ['revision', String(initial.revision)],
      ['value_MAX_REVIEW_COMMENTS', '31'],
    ]), { expectedRevision: initial.revision, clientAddress: '203.0.113.10' });
  } finally {
    console.error = originalError;
  }

  assert.equal(calls, 2);
  assert.equal(saved.state.revision, 1);
  assert.equal(saved.state.config.maxComments, 31);
  assert.equal((await manager.load()).config.maxComments, 31);
});

test('admin config summary exposes bot version', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-version-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir, BOT_VERSION: 'test-version' }, dataDir: dir });
  await manager.ensureStorageDir();

  const state = await manager.load();

  assert.equal(state.config.version, 'test-version');
  assert.equal(state.summary.values.version.value, 'test-version');
});

test('admin config rejects concurrent stale editor submissions without losing the first update', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir });
  await manager.ensureStorageDir();
  const initial = await manager.load();

  const originalReadOverrideState = manager.readOverrideState.bind(manager);
  let initialReads = 0;
  let releaseInitialReads;
  const bothInitialReads = new Promise(resolve => { releaseInitialReads = resolve; });
  manager.readOverrideState = async () => {
    const state = await originalReadOverrideState();
    if (initialReads < 2) {
      initialReads += 1;
      if (initialReads === 2) releaseInitialReads();
      await bothInitialReads;
    }
    return state;
  };

  const originalWriteOverrides = manager.writeOverrides.bind(manager);
  let writeAttempts = 0;
  let releaseWriteAttempts;
  const bothWriteAttempts = new Promise(resolve => { releaseWriteAttempts = resolve; });
  manager.writeOverrides = async (...args) => {
    writeAttempts += 1;
    if (writeAttempts === 2) releaseWriteAttempts();
    await bothWriteAttempts;
    return originalWriteOverrides(...args);
  };

  const submit = maxComments => manager.applyEditorForm(new Map([
    ['revision', String(initial.revision)],
    ['value_MAX_REVIEW_COMMENTS', String(maxComments)],
  ]), { expectedRevision: initial.revision, clientAddress: '203.0.113.10' });

  const settled = await Promise.allSettled([submit(31), submit(32)]);
  const fulfilled = settled.filter(result => result.status === 'fulfilled');
  const rejected = settled.filter(result => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /Config override revision 1 does not match expected revision 0/);

  const state = await manager.load();
  assert.equal(state.revision, 1);
  assert.equal(state.overrides.MAX_REVIEW_COMMENTS, fulfilled[0].value.state.overrides.MAX_REVIEW_COMMENTS);
});

test('admin config pending restart writes share override lock without deadlock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-lock-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir });
  await manager.ensureStorageDir();
  const initial = await manager.load();

  let releasePersist;
  const persistStarted = new Promise(resolve => {
    releasePersist = resolve;
  });
  let unblockPersist;
  const waitBeforePersist = new Promise(resolve => {
    unblockPersist = resolve;
  });

  const write = manager.writeOverrides(
    { MAX_REVIEW_COMMENTS: '31' },
    {
      expectedRevision: initial.revision,
      beforePersist: async () => {
        releasePersist();
        await waitBeforePersist;
      },
    },
  );
  await persistStarted;
  const pending = manager.writePendingRestart({ keys: ['PORT'], revision: 99, createdAt: '2026-06-01T00:00:00.000Z' });
  unblockPersist();

  await write;
  await pending;
  const state = await manager.load();
  assert.equal(state.overrides.MAX_REVIEW_COMMENTS, '31');
  assert.deepEqual(state.pendingRestart.keys, ['PORT']);

  await manager.clearPendingRestartAfterSuccessfulBind({ desiredPort: 3007, runningPort: 3007 });
  const cleared = await manager.load();
  assert.equal(cleared.overrides.MAX_REVIEW_COMMENTS, '31');
  assert.equal(cleared.pendingRestart, null);
});

test('admin config accumulates restart markers across sequential restart-required edits', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-restart-merge-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir });
  await manager.ensureStorageDir();
  await manager.writeOverrides({ PORT: '3008' });
  await manager.writeOverrides({ PORT: '3008', JOB_LOG_MAX_BYTES: '8192' });

  const state = await manager.load();

  assert.deepEqual(state.pendingRestart.keys, ['JOB_LOG_MAX_BYTES', 'PORT']);
  assert.equal(state.pendingRestart.sinceRevision, 1);
});

test('admin config legacy pending restart migration does not deadlock under locked clear', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-legacy-lock-'));
  const pendingRestartFile = path.join(dir, 'pending-restart.json');
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir, pendingRestartFile });
  await manager.ensureStorageDir();
  await fs.writeFile(pendingRestartFile, JSON.stringify({ keys: ['PORT'], revision: 1, createdAt: '2026-06-01T00:00:00.000Z' }));

  const result = await manager.clearPendingRestartAfterSuccessfulBind({ desiredPort: 3007, runningPort: 3007 });
  const state = await manager.load();
  assert.equal(result.cleared, true);
  assert.equal(state.pendingRestart, null);
});

test('admin config clears non-port pending restart after successful process restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-non-port-restart-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir });
  await manager.ensureStorageDir();
  await manager.writePendingRestart({ keys: ['JOB_LOG_MAX_BYTES', 'RETENTION_INTERVAL_HOURS'], sinceRevision: 4, createdAt: '2026-01-01T00:00:00.000Z' });

  const result = await manager.clearPendingRestartAfterSuccessfulBind({ desiredPort: 3008, runningPort: 3007 });
  const state = await manager.load();

  assert.deepEqual(result, { cleared: true, reason: 'restart-applied' });
  assert.equal(state.pendingRestart, null);
});

test('admin config audit compaction shares audit writer lock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-audit-lock-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir });
  await manager.ensureStorageDir();
  const auditFile = path.join(dir, 'audit', 'config-audit.jsonl');
  await fs.mkdir(path.dirname(auditFile), { recursive: true });
  await fs.writeFile(auditFile, `${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', result: 'success', fieldsChanged: ['PORT'] })}\n`, 'utf8');

  let releaseAppend;
  const appendStarted = new Promise(resolve => { releaseAppend = resolve; });
  let unblockAppend;
  const waitBeforeAppend = new Promise(resolve => { unblockAppend = resolve; });
  const freshRecord = { timestamp: '2026-02-01T00:00:00.000Z', result: 'success', fieldsChanged: ['MAX_REVIEW_COMMENTS'] };
  const append = manager.withAuditWriteLock(async () => {
    releaseAppend();
    await waitBeforeAppend;
    await fs.appendFile(auditFile, `${JSON.stringify(freshRecord)}\n`, 'utf8');
  });
  await appendStarted;
  const compact = manager.compactConfigAudit({ retentionDays: 7, now: new Date('2026-02-02T00:00:00.000Z') });
  unblockAppend();
  await append;
  await compact;

  const records = (await fs.readFile(auditFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.fieldsChanged), [['MAX_REVIEW_COMMENTS']]);
});

test('admin config audit write failure prevents persisting editor overrides', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-'));
  const auditFile = path.join(dir, 'audit', 'config-audit.jsonl');
  await fs.mkdir(auditFile, { recursive: true });
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir, auditFile });
  await manager.ensureStorageDir();
  const initial = await manager.load();

  await assert.rejects(() => manager.applyEditorForm(new Map([
    ['revision', String(initial.revision)],
    ['value_MAX_REVIEW_COMMENTS', '31'],
  ]), { expectedRevision: initial.revision, clientAddress: '203.0.113.10' }), /EISDIR|illegal operation on a directory/);

  const state = await manager.load();
  assert.equal(state.revision, 0);
  assert.equal(state.overrides.MAX_REVIEW_COMMENTS, undefined);
  assert.equal(state.config.maxComments, 30);
});

test('admin config audit retention compacts JSONL by event timestamp inside a file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir });
  await manager.ensureStorageDir();
  const auditFile = path.join(dir, 'audit', 'config-audit.jsonl');
  await fs.mkdir(path.dirname(auditFile), { recursive: true });
  const oldRecord = { timestamp: '2026-01-01T00:00:00.000Z', result: 'success', fieldsChanged: ['PORT'] };
  const freshRecord = { timestamp: '2026-02-01T00:00:00.000Z', result: 'failure', fieldsChanged: ['MAX_REVIEW_COMMENTS'] };
  await fs.writeFile(auditFile, `${JSON.stringify(oldRecord)}\n${JSON.stringify(freshRecord)}\n`, 'utf8');
  const oldMtime = new Date('2026-01-01T00:00:00.000Z');
  await fs.utimes(auditFile, oldMtime, oldMtime);

  const result = await manager.pruneConfigAudit({ retentionDays: 7, now: new Date('2026-02-02T00:00:00.000Z') });
  assert.deepEqual(result, { retained: 1, removed: 1 });
  const retained = (await fs.readFile(auditFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(retained, [freshRecord]);
});

test('admin retention compacts config audit JSONL by event timestamp, not file mtime', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-retention-audit-'));
  const store = new JobEventStore({ adminDir: dir });
  const auditFile = path.join(dir, 'audit', 'config-audit.jsonl');
  await fs.mkdir(path.dirname(auditFile), { recursive: true });
  const oldRecord = { timestamp: '2026-01-01T00:00:00.000Z', result: 'success', fieldsChanged: ['PORT'] };
  const freshRecord = { timestamp: '2026-02-01T00:00:00.000Z', result: 'success', fieldsChanged: ['MAX_REVIEW_COMMENTS'] };
  await fs.writeFile(auditFile, `${JSON.stringify(oldRecord)}\n${JSON.stringify(freshRecord)}\n`, 'utf8');
  const oldMtime = new Date('2026-01-01T00:00:00.000Z');
  await fs.utimes(auditFile, oldMtime, oldMtime);

  const runtime = new AdminRuntime({ eventStore: store, configProvider: () => ({ jobLogRetentionDays: 14, jobHistoryRetentionDays: 90, statsRetentionDays: 365, configAuditRetentionDays: 7, jobLogMaxBytes: 4096 }) });
  const result = await runtime.runRetention({ now: '2026-02-02T00:00:00.000Z' });
  const retained = (await fs.readFile(auditFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

  assert.equal(result.audit.compacted, 1);
  assert.equal(result.audit.recordsRemoved, 1);
  assert.deepEqual(retained, [freshRecord]);
});

test('admin config editor exposes one admin password row and canonical admin data dir', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-'));
  const manager = new ConfigManager({
    env: { ...env, ADMIN_PASSWORD: 'a-secure-admin-password', ADMIN_DATA_DIR: dir },
    dataDir: dir,
  });
  await manager.ensureStorageDir();

  const state = await manager.load();
  const adminPasswordFields = state.summary.fields.filter(field => field.envKey === 'ADMIN_PASSWORD');
  assert.equal(adminPasswordFields.length, 1);
  const [adminPasswordField] = adminPasswordFields;
  assert.equal(adminPasswordField.name, 'adminPassword');
  assert.equal(adminPasswordField.secret, true);
  assert.equal(adminPasswordField.set, true);
  assert.equal(adminPasswordField.editable, false);
  assert.equal(adminPasswordField.adminDashboardEnabled, true);
  assert.equal(adminPasswordField.adminDashboardDisabledReason, '');

  const configHtml = renderConfigPage({ csrfToken: 'csrf', config: state.summary, adminRoot: dir, section: 'admin' });
  assert.equal((configHtml.match(/<code>ADMIN_PASSWORD<\/code>/g) ?? []).length, 1);
  assert.equal((configHtml.match(/<code>ADMIN_STORAGE_DIR<\/code>/g) ?? []).length, 0);
  assert.match(configHtml, /dashboard enabled/);

  assert.equal(state.summary.values.adminEnabled.value, true);
  assert.equal(state.summary.values.adminDisabledReason.value, '');
  assert.equal(state.summary.fields.find(field => field.name === 'adminEnabled'), undefined);
  assert.equal(state.summary.fields.find(field => field.name === 'adminDisabledReason'), undefined);

  const adminDataDirFields = state.summary.fields.filter(field => field.name === 'adminDataDir');
  assert.equal(adminDataDirFields.length, 1);
  assert.equal(adminDataDirFields[0].envKey, 'ADMIN_DATA_DIR');
  assert.equal(state.summary.fields.find(field => field.name === 'adminStorageDir'), undefined);
});

test('admin config editor groups fields and renders searchable sections', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-'));
  const manager = new ConfigManager({
    env: { ...env, ADMIN_PASSWORD: 'a-secure-admin-password', ADMIN_DATA_DIR: dir },
    dataDir: dir,
  });
  await manager.ensureStorageDir();
  const state = await manager.load();

  for (const field of state.summary.fields) {
    assert.equal(typeof field.group, 'string');
    assert.match(field.group, /^(service|access|github|ocr|proxy|admin|retention)$/);
  }

  const byEnv = Object.fromEntries(state.summary.fields.map(field => [field.envKey, field]));
  assert.equal(byEnv.PORT.group, 'service');
  assert.equal(byEnv.BOT_TRIGGER_PHRASES.group, 'access');
  assert.equal(byEnv.GITHUB_APP_ID.group, 'github');
  assert.equal(byEnv.OCR_LLM_URL.group, 'ocr');
  assert.equal(byEnv.LLM_PROXY_TARGET_URL.group, 'proxy');
  assert.equal(byEnv.ADMIN_PASSWORD.group, 'admin');
  assert.equal(byEnv.JOB_HISTORY_RETENTION_DAYS.group, 'retention');

  const groups = [];
  for (const field of state.summary.fields) {
    if (groups[groups.length - 1] !== field.group) groups.push(field.group);
  }
  assert.deepEqual(groups, ['service', 'access', 'github', 'ocr', 'proxy', 'admin', 'retention']);

  const serviceHtml = renderConfigPage({ csrfToken: 'csrf', config: state.summary, adminRoot: dir, section: 'service' });
  const adminHtml = renderConfigPage({ csrfToken: 'csrf', config: state.summary, adminRoot: dir, section: 'admin' });
  const ocrHtml = renderConfigPage({ csrfToken: 'csrf', config: state.summary, adminRoot: dir, section: 'ocr' });
  assert.match(serviceHtml, /data-config-editor/);
  assert.match(serviceHtml, /settings-subnav/);
  assert.match(serviceHtml, /settings-item/);
  assert.match(serviceHtml, /\/admin\/config\?section=service/);
  assert.match(serviceHtml, /\/admin\/config\?section=ocr/);
  assert.match(serviceHtml, /\/admin\/config\?section=admin/);
  assert.match(serviceHtml, /id="config-group-service"/);
  assert.match(serviceHtml, /id="config-field-PORT"/);
  assert.equal((serviceHtml.match(/id="config-field-ADMIN_PASSWORD"/g) ?? []).length, 0);
  assert.match(adminHtml, /id="config-field-ADMIN_PASSWORD"/);
  assert.match(ocrHtml, /id="config-field-OCR_LLM_URL"/);
  assert.equal((serviceHtml.match(/href="\/admin\/config\?section=/g) ?? []).length, 7);
});

test('admin config editor exposes legacy trigger phrase and startup-fixed fields', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-config-'));
  const manager = new ConfigManager({ env: { ...env, ADMIN_DATA_DIR: dir }, dataDir: dir });
  await manager.ensureStorageDir();
  const state = await manager.load();
  const triggerPhraseFields = state.summary.fields.filter(field => field.envKey === 'BOT_TRIGGER_PHRASE');
  assert.equal(triggerPhraseFields.length, 1);
  const [triggerPhraseField] = triggerPhraseFields;

  assert.equal(triggerPhraseField.editable, true);
  assert.equal(triggerPhraseField.effectiveValue, '/juya review');
  for (const envKey of ['JOB_LOG_MAX_BYTES', 'RETENTION_INTERVAL_HOURS']) {
    const fieldRows = state.summary.fields.filter(field => field.envKey === envKey);
    assert.equal(fieldRows.length, 1);
    const [field] = fieldRows;
    assert.equal(field.restartRequired, true);
    assert.equal(field.hotReloadable, false);
  }
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
  const nullOriginLogin = await router.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz', origin: 'null' }, body: new URLSearchParams({ password: 'x' }).toString() });
  assert.equal(nullOriginLogin.status, 200);
  assert.match(nullOriginLogin.body, /Invalid password/);
  const nullOriginConfig = await router.route({ method: 'POST', url: '/admin/config', headers: { host: 'juya.011070.xyz', origin: 'null' }, body: new URLSearchParams({ revision: '0' }).toString() });
  assert.equal(nullOriginConfig.status, 403);

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
    loadSecurityConfig: () => ({ adminPassword: 'a-secure-admin-password', allowedHosts: 'juya.011070.xyz:8080', trustProxy: true, cookieSecure: false }),
  });
  const forwardedHttp = await httpTrusted.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz:8080', origin: 'http://juya.011070.xyz:8080', 'x-forwarded-proto': 'http' }, body: new URLSearchParams({ password: 'x' }).toString() });
  assert.equal(forwardedHttp.status, 200);
  const secureProxyHttp = createAdminRouter({
    adminPassword: 'a-secure-admin-password',
    allowedHosts: 'juya.011070.xyz:8080',
    loadSecurityConfig: () => ({ adminPassword: 'a-secure-admin-password', allowedHosts: 'juya.011070.xyz:8080', trustProxy: true, cookieSecure: true }),
  });
  const secureProxyHttpResponse = await secureProxyHttp.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz:8080', origin: 'http://juya.011070.xyz:8080', 'x-forwarded-proto': 'http' }, body: new URLSearchParams({ password: 'x' }).toString() });
  assert.equal(secureProxyHttpResponse.status, 403);
  const defaultHttpsPort = createAdminRouter({ adminPassword: 'a-secure-admin-password', allowedHosts: 'juya.011070.xyz:443' });
  const defaultHttpsPortResponse = await defaultHttpsPort.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz:443', origin: 'https://juya.011070.xyz' }, body: new URLSearchParams({ password: 'x' }).toString() });
  assert.equal(defaultHttpsPortResponse.status, 200);

  const defaultHttpPort = createAdminRouter({
    adminPassword: 'a-secure-admin-password',
    allowedHosts: 'juya.011070.xyz:80',
    loadSecurityConfig: () => ({ adminPassword: 'a-secure-admin-password', allowedHosts: 'juya.011070.xyz:80', trustProxy: true, cookieSecure: false }),
  });
  const defaultHttpPortResponse = await defaultHttpPort.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz:80', origin: 'http://juya.011070.xyz', 'x-forwarded-proto': 'http' }, body: new URLSearchParams({ password: 'x' }).toString() });
  assert.equal(defaultHttpPortResponse.status, 200);

  const localhostHttp = createAdminRouter({
    adminPassword: 'a-secure-admin-password',
    allowedHosts: 'localhost',
    loadSecurityConfig: () => ({ adminPassword: 'a-secure-admin-password', allowedHosts: 'localhost', trustProxy: false, cookieSecure: false }),
  });
  const localhostHttpResponse = await localhostHttp.route({ method: 'POST', url: '/admin/login', headers: { host: 'localhost:3007', origin: 'http://localhost:3007' }, body: new URLSearchParams({ password: 'x' }).toString() });
  assert.equal(localhostHttpResponse.status, 200);

  const publicHttpWithoutProxy = createAdminRouter({
    adminPassword: 'a-secure-admin-password',
    allowedHosts: 'juya.011070.xyz:8080',
    loadSecurityConfig: () => ({ adminPassword: 'a-secure-admin-password', allowedHosts: 'juya.011070.xyz:8080', trustProxy: false, cookieSecure: false }),
  });
  const publicHttpWithoutProxyResponse = await publicHttpWithoutProxy.route({ method: 'POST', url: '/admin/login', headers: { host: 'juya.011070.xyz:8080', origin: 'http://juya.011070.xyz:8080' }, body: new URLSearchParams({ password: 'x' }).toString() });
  assert.equal(publicHttpWithoutProxyResponse.status, 403);

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

test('job completed events reject active statuses', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-terminal-status-'));
  const store = new JobEventStore({ adminDir: dir });
  const jobId = cryptoRandomUuid();
  await store.append(createJobEvent({ type: 'job.queued', jobId, data: { repository: 'alice/repo', pullNumber: 1 } }));

  await assert.rejects(
    () => store.append(createJobEvent({ type: 'job.completed', jobId, data: { status: 'running' } })),
    /job.completed requires terminal status: running/,
  );
  assert.equal(store.diagnostics().pendingEventCount, 0);
  const replayed = await store.replay({ force: true });
  assert.equal(replayed.jobs[0].status, 'queued');
});

test('admin queue drain outer failure records diagnostic without rejecting', async () => {
  const queue = new AdminJobQueue({ handler: async () => ({ outcome: 'succeeded' }) });
  queue.queuedJobs = {
    length: 1,
    shift: () => {
      throw new Error('queue metadata corrupted');
    },
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    await queue.drain();
  } finally {
    console.error = originalError;
  }
  assert.equal(queue.diagnostics.some(item => item.id === 'queue-drain'), true);
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

test('shutdown persists interrupted active job state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-interrupted-'));
  const store = new JobEventStore({ adminDir: dir });
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const queue = new AdminJobQueue({
    store,
    configProvider: () => loadConfig(env),
    handler: async (_payload, { signal }) => {
      started();
      await once(signal, 'abort');
      throw signal.reason;
    },
  });

  await queue.enqueue({ key: 'alice/repo#11@12', payload: {}, metadata: { owner: 'alice', repo: 'repo', pullNumber: 11 } });
  await startedPromise;
  queue.stop();
  await queue.shutdown({ timeoutMs: 1000 });

  const replayed = await store.replay({ force: true });
  assert.equal(replayed.jobs[0].status, 'interrupted');
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

test('job event compaction drops expired terminal jobs while preserving active and retained terminal jobs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-compact-retention-'));
  const store = new JobEventStore({ adminDir: dir });
  const oldId = cryptoRandomUuid();
  const retainedId = cryptoRandomUuid();
  const activeId = cryptoRandomUuid();

  await store.append(createJobEvent({ type: 'job.queued', jobId: oldId, timestamp: '2026-01-01T00:00:00.000Z', data: { repository: 'alice/old', pullNumber: 1 } }));
  await store.append(createJobEvent({ type: 'job.completed', jobId: oldId, timestamp: '2026-01-01T00:10:00.000Z', data: { status: 'succeeded', finishedAt: '2026-01-01T00:10:00.000Z', result: { outcome: 'succeeded', commentsGenerated: 1 } } }));
  await store.append(createJobEvent({ type: 'job.queued', jobId: retainedId, timestamp: '2026-05-01T00:00:00.000Z', data: { repository: 'alice/retained', pullNumber: 2 } }));
  await store.append(createJobEvent({ type: 'job.completed', jobId: retainedId, timestamp: '2026-05-01T00:10:00.000Z', data: { status: 'succeeded', finishedAt: '2026-05-01T00:10:00.000Z', result: { outcome: 'succeeded', commentsGenerated: 2 } } }));
  await store.append(createJobEvent({ type: 'job.queued', jobId: activeId, timestamp: '2026-01-01T00:00:00.000Z', data: { repository: 'alice/active', pullNumber: 3 } }));
  await store.append(createJobEvent({ type: 'job.started', jobId: activeId, timestamp: '2026-01-01T00:05:00.000Z', data: { startedAt: '2026-01-01T00:05:00.000Z' } }));

  const result = await store.compact({
    now: '2026-06-01T00:00:00.000Z',
    terminalJobsBefore: '2026-03-03T00:00:00.000Z',
    terminalDetailsBefore: '2026-03-03T00:00:00.000Z',
  });
  const replayed = await store.replay({ force: true });
  const eventsText = await fs.readFile(path.join(dir, 'jobs', 'events.jsonl'), 'utf8');

  assert.equal(result.terminalJobsDropped, 1);
  assert.equal(replayed.jobs.some(job => job.id === oldId), false);
  assert.equal(replayed.jobs.find(job => job.id === retainedId).status, 'succeeded');
  assert.equal(replayed.jobs.find(job => job.id === activeId).status, 'running');
  assert.equal(eventsText.includes(oldId), false);
  assert.equal(eventsText.includes(retainedId), true);
  assert.equal(eventsText.includes(activeId), true);
});

test('job log events omit log payloads from events file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-log-events-'));
  const store = new JobEventStore({ adminDir: dir });
  const jobId = cryptoRandomUuid();
  const largeLog = 'x'.repeat(64 * 1024);

  await store.append({ type: 'job.log', jobId, data: { level: 'info', message: largeLog, fields: { stdout: largeLog } } });
  const eventsText = await fs.readFile(path.join(dir, 'jobs', 'events.jsonl'), 'utf8');
  const [event] = eventsText.trim().split('\n').map(line => JSON.parse(line));

  assert.equal(Buffer.byteLength(eventsText, 'utf8') < 1024, true);
  assert.deepEqual(event.data, { level: 'info' });
  assert.equal(eventsText.includes(largeLog.slice(0, 128)), false);
});

test('bounded job logger enforces byte cap with one terminal truncation marker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-logs-'));
  const jobId = cryptoRandomUuid();
  const logger = new BoundedJobLogger({ adminDir: dir, maxBytes: 650, maxMessageLength: 200, maxEntries: 100, compactInterval: 1 });

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

test('bounded job logger flushes pending writes and recovers after write failure', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-logger-flush-'));
  const jobId = cryptoRandomUuid();
  const logger = new BoundedJobLogger({ adminDir: dir, maxBytes: 4096 });

  const pending = logger.append(jobId, { level: 'info', message: 'first pending write' });
  await logger.flush();
  await pending;
  assert.deepEqual((await logger.read(jobId)).entries.map(entry => entry.message), ['first pending write']);

  const blockedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-logger-fail-'));
  const logsPath = path.join(blockedDir, 'logs-file');
  await fs.writeFile(logsPath, 'not a directory', 'utf8');
  const failingLogger = new BoundedJobLogger({ logsDir: logsPath, maxBytes: 4096 });
  await assert.rejects(() => failingLogger.append(jobId, { message: 'will fail' }), /ENOTDIR/);
  await assert.doesNotReject(() => failingLogger.flush());
  await fs.rm(logsPath, { force: true });
  await fs.mkdir(logsPath, { recursive: true });
  await failingLogger.append(jobId, { message: 'recovered write' });
  assert.deepEqual((await failingLogger.read(jobId)).entries.map(entry => entry.message), ['recovered write']);
});

test('admin queue shutdown waits for logger flush and records flush timeout diagnostics', async () => {
  let releaseFlush;
  let shutdownSettled = false;
  const blockingLogger = { flush: () => new Promise(resolve => { releaseFlush = resolve; }) };
  const queue = new AdminJobQueue({ handler: async () => ({ outcome: 'succeeded' }), logger: blockingLogger });

  const shutdown = queue.shutdown({ timeoutMs: 1000 }).then(() => { shutdownSettled = true; });
  await Promise.resolve();
  assert.equal(shutdownSettled, false);
  releaseFlush();
  await shutdown;
  assert.equal(shutdownSettled, true);

  const hangingQueue = new AdminJobQueue({ handler: async () => ({ outcome: 'succeeded' }), logger: { flush: () => new Promise(() => {}) } });
  await hangingQueue.shutdown({ timeoutMs: 1 });
  const diagnostics = hangingQueue.snapshot().diagnostics;
  assert.equal(diagnostics.some(item => item.id === 'job-log-flush' && /Timed out/.test(item.message)), true);
});

test('admin retention deletes expired and orphan logs, keeps active logs, preserves retained jobs, and writes daily stats', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-retention-'));
  const store = new JobEventStore({ adminDir: dir });
  const logger = new BoundedJobLogger({ adminDir: dir, maxBytes: 4096 });
  const activeId = cryptoRandomUuid();
  const failedId = cryptoRandomUuid();
  const orphanId = cryptoRandomUuid();
  const now = '2026-06-01T00:00:00.000Z';
  const oldMtime = new Date('2026-05-01T00:00:00.000Z');

  await store.append(createJobEvent({ type: 'job.queued', jobId: activeId, timestamp: '2026-05-31T00:00:00.000Z', data: { repository: 'alice/active', pullNumber: 1 } }));
  await store.append(createJobEvent({ type: 'job.queued', jobId: failedId, timestamp: '2026-05-01T00:00:00.000Z', data: { repository: 'alice/failed', pullNumber: 2 } }));
  await store.append(createJobEvent({ type: 'job.failed', jobId: failedId, timestamp: '2026-05-01T00:05:00.000Z', data: { errorKind: 'ocr_runtime_error', errorMessage: 'stack with secret=hidden', result: { outcome: 'failed', failure: { kind: 'ocr_runtime_error', reason: 'runtime' }, commentsGenerated: 3, commentsPosted: 1 } } }));
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

test('admin retention removes expired terminal jobs from compacted event history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-retention-history-'));
  const store = new JobEventStore({ adminDir: dir });
  const oldId = cryptoRandomUuid();
  const retainedId = cryptoRandomUuid();
  const activeId = cryptoRandomUuid();
  const now = '2026-06-01T00:00:00.000Z';

  await store.append(createJobEvent({ type: 'job.queued', jobId: oldId, timestamp: '2026-01-01T00:00:00.000Z', data: { repository: 'alice/old-retention', pullNumber: 1 } }));
  await store.append(createJobEvent({ type: 'job.completed', jobId: oldId, timestamp: '2026-01-01T00:01:00.000Z', data: { status: 'succeeded', finishedAt: '2026-01-01T00:01:00.000Z', result: { outcome: 'succeeded' } } }));
  await store.append(createJobEvent({ type: 'job.queued', jobId: retainedId, timestamp: '2026-05-15T00:00:00.000Z', data: { repository: 'alice/retained-retention', pullNumber: 2 } }));
  await store.append(createJobEvent({ type: 'job.completed', jobId: retainedId, timestamp: '2026-05-15T00:01:00.000Z', data: { status: 'succeeded', finishedAt: '2026-05-15T00:01:00.000Z', result: { outcome: 'succeeded' } } }));
  await store.append(createJobEvent({ type: 'job.queued', jobId: activeId, timestamp: '2026-01-01T00:00:00.000Z', data: { repository: 'alice/active-retention', pullNumber: 3 } }));

  const runtime = new AdminRuntime({ eventStore: store, configProvider: () => ({ jobLogRetentionDays: 14, jobHistoryRetentionDays: 90, statsRetentionDays: 365, configAuditRetentionDays: 365, jobLogMaxBytes: 4096 }) });
  const result = await runtime.runRetention({ now });
  const replayed = await store.replay({ force: true });
  const eventsText = await fs.readFile(path.join(dir, 'jobs', 'events.jsonl'), 'utf8');
  const stats = await readDailyStats({ adminDir: dir });

  assert.equal(result.events.terminalJobsDropped, 1);
  assert.equal(replayed.jobs.some(job => job.id === oldId), false);
  assert.equal(replayed.jobs.some(job => job.id === retainedId), true);
  assert.equal(replayed.jobs.some(job => job.id === activeId), true);
  assert.equal(eventsText.includes(oldId), false);
  assert.deepEqual(stats.records.map(record => record.day).sort(), ['2026-01-01', '2026-05-15']);
});

test('admin retention keeps expired terminal jobs when stats aggregation fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-retention-stats-failure-'));
  const store = new JobEventStore({ adminDir: dir });
  const oldId = cryptoRandomUuid();
  await store.append(createJobEvent({ type: 'job.queued', jobId: oldId, timestamp: '2026-01-01T00:00:00.000Z', data: { repository: 'alice/old-retention', pullNumber: 1 } }));
  await store.append(createJobEvent({ type: 'job.completed', jobId: oldId, timestamp: '2026-01-01T00:01:00.000Z', data: { status: 'succeeded', finishedAt: '2026-01-01T00:01:00.000Z', result: { outcome: 'succeeded' } } }));
  await fs.mkdir(path.join(dir, 'stats', 'daily-stats.jsonl'), { recursive: true });

  const runtime = new AdminRuntime({ eventStore: store, configProvider: () => ({ jobLogRetentionDays: 14, jobHistoryRetentionDays: 90, statsRetentionDays: 365, configAuditRetentionDays: 365, jobLogMaxBytes: 4096 }) });
  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await runtime.runRetention({ now: '2026-06-01T00:00:00.000Z' });
  } finally {
    console.error = originalError;
  }
  const replayed = await store.replay({ force: true });

  assert.equal(result.stats, null);
  assert.equal(result.events.terminalJobsDropped, 0);
  assert.equal(replayed.jobs.some(job => job.id === oldId), true);
});

test('admin retention keeps fresh orphan logs and aggregate stats under soft cap', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-retention-'));
  const store = new JobEventStore({ adminDir: dir });
  const logger = new BoundedJobLogger({ adminDir: dir, maxBytes: 4096 });
  const orphanId = cryptoRandomUuid();
  await fs.mkdir(path.join(dir, 'jobs', 'logs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'jobs', 'logs', `${orphanId}.jsonl`), '{"timestamp":"2026-06-01T00:00:00.000Z","level":"info","message":"fresh orphan","fields":{}}\n');
  await fs.mkdir(path.join(dir, 'stats'), { recursive: true });
  const statsFile = path.join(dir, 'stats', 'daily-stats.jsonl');
  await fs.writeFile(statsFile, `${JSON.stringify({ day: '2026-06-01', jobs: 1 })}\n`);
  await fs.writeFile(path.join(dir, 'retention-state.json'), `${JSON.stringify({ seed: 'x'.repeat(512) })}\n`);

  const runtime = new AdminRuntime({ eventStore: store, logger, configProvider: () => ({ jobLogRetentionDays: 14, jobHistoryRetentionDays: 90, statsRetentionDays: 365, configAuditRetentionDays: 365, jobLogMaxBytes: 4096, adminDataMaxBytes: 1 }) });
  const result = await runtime.runRetention({ now: '2026-06-01T00:00:00.000Z' });

  await fs.access(path.join(dir, 'jobs', 'logs', `${orphanId}.jsonl`));
  await fs.access(statsFile);
  assert.equal(result.logs.orphanDeleted, 0);
  assert.equal(result.softCap.earlyDeletion.some(item => item.path === 'stats/daily-stats.jsonl'), false);
});

test('admin log redaction covers query credentials and folded auth headers', () => {
  const redacted = redactSensitiveString('https://example.test/?apiKey=abc123&x=1\nAuthorization: Bearer first\n second\nProxy: Basic dXNlcjpwYXNz');
  assert.doesNotMatch(redacted, /abc123/);
  assert.doesNotMatch(redacted, /Bearer first/);
  assert.doesNotMatch(redacted, /dXNlcjpwYXNz/);
  assert.match(redacted, /apiKey=\[REDACTED\]/);
  assert.match(redacted, /Authorization: \[REDACTED\]/);
  assert.match(redacted, /Basic \[REDACTED\]/);
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

test('admin dashboard merges persisted daily stats after job retention', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-dashboard-stats-'));
  const store = new JobEventStore({ adminDir: dir });
  await fs.mkdir(path.join(dir, 'stats'), { recursive: true });
  await fs.writeFile(path.join(dir, 'stats', 'daily-stats.jsonl'), `${JSON.stringify({ day: '2026-01-01', jobs: 3, succeeded: 2, failed: 1, successRate: 2 / 3, commentsGeneratedTotal: 7, commentsPostedTotal: 5 })}\n`, 'utf8');

  const runtime = new AdminRuntime({ eventStore: store });
  const dashboard = await runtime.dashboard();

  assert.deepEqual(dashboard.stats.dailyTrend.map(day => day.day), ['2026-01-01']);
  assert.equal(dashboard.stats.dailyTrend[0].jobs, 3);
  assert.equal(dashboard.stats.dailyTrend[0].commentsGeneratedTotal, 7);
});

test('job event compaction preserves progress phase timeline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-compact-progress-'));
  const store = new JobEventStore({ adminDir: dir });
  const jobId = cryptoRandomUuid();
  await store.append(createJobEvent({ type: 'job.queued', jobId, timestamp: '2026-01-01T00:00:00.000Z', data: { repository: 'alice/repo', pullNumber: 1 } }));
  await store.append(createJobEvent({ type: 'job.progress', jobId, timestamp: '2026-01-01T00:00:30.000Z', data: { progress: { phase: 'checkout', message: 'Checking out', percent: 25 } } }));
  await store.append(createJobEvent({ type: 'job.completed', jobId, timestamp: '2026-01-01T00:01:00.000Z', data: { status: 'succeeded', finishedAt: '2026-01-01T00:01:00.000Z', result: { outcome: 'succeeded' } } }));

  await store.compact({ now: '2026-06-01T00:00:00.000Z', terminalDetailsBefore: '2026-06-01T00:00:00.000Z' });
  const eventsText = await fs.readFile(path.join(dir, 'jobs', 'events.jsonl'), 'utf8');
  const replayed = await store.replay({ force: true });

  assert.equal(replayed.jobs[0].phaseTimeline.some(item => item.progress.phase === 'checkout'), true);
  assert.equal(replayed.jobs[0].progress.phase, 'checkout');
  assert.match(eventsText, /"phase":"queued"/);
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

test('admin retention soft cap deletes every eligible log and reports unmet target', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-soft-cap-unmet-'));
  const store = new JobEventStore({ adminDir: dir });
  const logger = new BoundedJobLogger({ adminDir: dir, maxBytes: 20_000 });
  const jobIds = [cryptoRandomUuid(), cryptoRandomUuid()];

  for (const [index, jobId] of jobIds.entries()) {
    await store.append(createJobEvent({ type: 'job.queued', jobId, timestamp: `2026-05-${20 + index}T00:00:00.000Z`, data: { repository: `alice/soft-cap-${index}`, pullNumber: index + 1 } }));
    await store.append(createJobEvent({ type: 'job.completed', jobId, timestamp: `2026-05-${20 + index}T00:01:00.000Z`, data: { status: 'succeeded', result: { outcome: 'succeeded', commentsGenerated: 1, commentsPosted: 1 } } }));
    await logger.append(jobId, { message: `retained soft cap log ${index} `.repeat(120) });
    await fs.utimes(logger.logPath(jobId), new Date('2026-05-31T00:00:00.000Z'), new Date('2026-05-31T00:00:00.000Z'));
  }

  const runtime = new AdminRuntime({ eventStore: store, logger, configProvider: () => ({ jobLogRetentionDays: 14, jobHistoryRetentionDays: 90, statsRetentionDays: 365, configAuditRetentionDays: 365, jobLogMaxBytes: 20_000, adminDataMaxBytes: 1 }) });
  const result = await runtime.runRetention({ now: '2026-06-01T00:00:00.000Z' });

  for (const jobId of jobIds) await assert.rejects(() => fs.access(logger.logPath(jobId)), /ENOENT/);
  assert.equal(result.softCap.earlyDeletion.filter(item => item.kind === 'job-log').length, 2);
  assert.equal(result.softCap.targetBytes, 1);
  assert.equal(result.softCap.targetMet, false);
  assert.equal(result.softCap.stillOverCap, true);
  assert.equal(result.softCap.bytesAfter > result.softCap.targetBytes, true);
  assert.equal(result.softCap.overageBytes, result.softCap.bytesAfter - result.softCap.targetBytes);
  assert.equal(result.diagnostics.some(item => item.id === 'retention.softCap.stillOverCap'), true);
  const status = await runtime.retentionStatus();
  assert.equal(status.lastRun.softCap.stillOverCap, true);
  assert.equal(status.lastRun.ok, false);
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
    const loginBody = new URLSearchParams({ password: 'a-secure-admin-password' }).toString();
    const login = await requestText(server, 'POST', '/admin/login', { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz', 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(loginBody)) }, loginBody);
    assert.equal(login.status, 303);
    const cookie = Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'].join('; ') : login.headers['set-cookie'];
    const originalError = console.error;
    console.error = () => {};
    let admin;
    try {
      admin = await requestText(server, 'GET', '/admin/', { host: 'juya.011070.xyz', cookie });
    } finally {
      console.error = originalError;
    }
    assert.equal(admin.status, 500);
    const healthAfterAdminFailure = await requestJson(server, 'GET', '/health');
    assert.equal(healthAfterAdminFailure.status, 200);
    assert.equal(healthAfterAdminFailure.body.ok, true);
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

function requestText(server, method, pathName, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: serverPort(server), method, path: pathName, headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
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
