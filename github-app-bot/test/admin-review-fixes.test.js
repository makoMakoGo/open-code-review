import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import {
  AdminRuntime,
  createAdminRouter,
  deriveServiceHealth,
  renderConfigPage,
  renderDashboardPage,
  renderJobsPage,
  renderJobDetailPage,
  renderLoginPage,
  renderMetricsPage,
} from '../src/admin/index.js';
import { AdminJobQueue, createJobEvent, JobEventStore } from '../src/jobs/index.js';

function extractCsrfFromCookie(cookieHeader) {
  const match = String(cookieHeader).match(/(?:^|;\s*)ocr_admin_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function extractI18nDictionaries(html) {
  const match = html.match(/var I18N=(\{[\s\S]*?\});function dict\(\)/);
  assert.ok(match, 'expected I18N dict in body script');
  return JSON.parse(match[1]);
}

function cssVariables(block) {
  return new Map([...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)].map((match) => [match[1], match[2].trim()]));
}

function resolveCssColor(name, variables, seen = new Set()) {
  assert.ok(!seen.has(name), `cyclic CSS variable ${name}`);
  seen.add(name);
  const raw = variables.get(name) ?? name;
  const variable = raw.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (variable) return resolveCssColor(variable[1], variables, seen);
  const hex = raw.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255, a: 1 };
  }
  const rgba = raw.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  assert.ok(rgba, `unsupported CSS color ${raw}`);
  return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: rgba[4] == null ? 1 : Number(rgba[4]) };
}

function compositeColor(foreground, background) {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
}

function relativeLuminance(color) {
  const linear = (channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

function contrastRatio(left, right) {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function runApplyLangOnSettingsNav(html) {
  const match = html.match(/var I18N=(\{[\s\S]*?\});function dict\(\)/);
  assert.ok(match, 'expected I18N dict in body script');
  const i18n = JSON.parse(match[1]);
  const dict = i18n.en;
  assert.ok(dict, 'expected English dictionary');

  const anchors = [...html.matchAll(/<a class="settings-subnav-link[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => {
    const inner = m[1];
    const label = inner.match(/data-i18n="([^"]+)"[^>]*>([^<]*)</);
    const count = inner.match(/class="settings-count"[^>]*>([^<]*)</);
    assert.ok(label, 'expected leaf data-i18n label');
    assert.ok(count, 'expected settings-count span');
    return {
      key: label[1],
      labelText: label[2],
      countText: count[1],
    };
  });
  assert.ok(anchors.length > 0, 'expected settings subnav anchors');

  for (const anchor of anchors) {
    // Simulate applyLang leaf replacement: only the data-i18n node changes.
    const translated = dict[anchor.key];
    assert.equal(typeof translated, 'string');
    assert.notEqual(translated, '');
    // Count sibling must remain a pure number after init.
    assert.match(anchor.countText, /^\d+$/);
  }
}

async function appendEventRecords(filePath, records) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8');
}

function assertPersistenceFailureSnapshot(dashboard, diagnosticId, pendingEventCount = null) {
  const warning = dashboard.diagnostics.find(item => item.id === diagnosticId);
  assert.ok(warning, `expected ${diagnosticId} diagnostic`);
  if (pendingEventCount != null) assert.equal(warning.pendingEventCount, pendingEventCount);
  assert.notEqual(dashboard.serviceStatus.health, 'healthy');
  assert.equal(dashboard.serviceStatus.storage.writable, false);
  assert.equal(
    dashboard.serviceStatus.diagnostics.runtimeWarnings,
    dashboard.diagnostics.filter(item => item.level === 'warn' && !item.id.startsWith('events.')).length,
  );
}

test('deriveServiceHealth never reports healthy for missing or degraded signals', () => {
  assert.equal(deriveServiceHealth(null), 'unavailable');
  assert.equal(deriveServiceHealth(undefined), 'unavailable');
  assert.equal(deriveServiceHealth({}), 'unavailable');
  assert.equal(deriveServiceHealth({ storage: {}, diagnostics: {} }), 'unavailable');
  assert.equal(deriveServiceHealth({
    storage: { writable: false, degraded: false },
    diagnostics: { degraded: false, corruptEvents: 0, invalidEvents: 0, truncatedTail: false },
  }), 'unavailable');
  assert.equal(deriveServiceHealth({
    storage: { writable: true, degraded: true },
    diagnostics: { degraded: false, corruptEvents: 0, invalidEvents: 0, truncatedTail: false },
  }), 'degraded');
  assert.equal(deriveServiceHealth({
    storage: { writable: true, degraded: false },
    diagnostics: { degraded: true, corruptEvents: 0, invalidEvents: 0, truncatedTail: false },
  }), 'degraded');
  assert.equal(deriveServiceHealth({
    storage: { writable: true, degraded: false },
    diagnostics: { degraded: false, corruptEvents: 2, invalidEvents: 0, truncatedTail: false },
  }), 'degraded');
  assert.equal(deriveServiceHealth({
    storage: { writable: true, degraded: false },
    diagnostics: { degraded: false, corruptEvents: 0, invalidEvents: 0, truncatedTail: false },
  }), 'healthy');
});

test('dashboard includes runtime config failure in the same snapshot and clears it on recovery', async (t) => {
  t.mock.method(console, 'error', () => {});
  let configReads = 0;
  const runtime = new AdminRuntime({
    configProvider: () => {
      configReads += 1;
      if (configReads === 2) throw new Error('runtime config unavailable');
      return { version: 'test', port: 3007 };
    },
  });

  const failed = await runtime.dashboard();
  assert.equal(failed.serviceStatus.health, 'degraded');
  assert.equal(failed.serviceStatus.storage.writable, true);
  assert.equal(failed.serviceStatus.diagnostics.runtimeWarnings, 1);
  assert.deepEqual(failed.diagnostics.map((item) => item.id), ['persistence.runtimeConfig']);

  const recovered = await runtime.dashboard();
  assert.equal(recovered.serviceStatus.health, 'healthy');
  assert.equal(recovered.serviceStatus.diagnostics.runtimeWarnings, 0);
  assert.equal(recovered.diagnostics.some((item) => item.id === 'persistence.runtimeConfig'), false);
});

test('dashboard exposes a failing storage size probe in the same snapshot', async (t) => {
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-storage-size-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  const readdir = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', async (target, ...args) => {
    if (target === adminDir) {
      const error = new Error('directory size unavailable');
      error.code = 'EACCES';
      throw error;
    }
    return readdir(target, ...args);
  });
  const runtime = new AdminRuntime({ adminDir, configProvider: () => ({ version: 'test', port: 3007 }) });

  const dashboard = await runtime.dashboard();
  assert.equal(dashboard.serviceStatus.health, 'degraded');
  assert.equal(dashboard.serviceStatus.storage.writable, true);
  assert.equal(dashboard.serviceStatus.storage.degraded, true);
  assert.equal(dashboard.serviceStatus.diagnostics.runtimeWarnings, 1);
  assert.deepEqual(dashboard.diagnostics.filter((item) => item.id === 'storage.size').map((item) => item.message), [
    'Could not read admin data directory size: directory size unavailable',
  ]);
});

test('dashboard performs one event replay probe and clears a recovered read failure', async (t) => {
  t.mock.method(console, 'error', () => {});
  let replayAttempts = 0;
  const eventStore = {
    replay: async () => {
      replayAttempts += 1;
      if (replayAttempts === 1) throw new Error('event history unavailable');
      return { jobs: [], degraded: false, corruptions: [], invalidEvents: [], truncatedTail: null };
    },
  };
  const runtime = new AdminRuntime({ eventStore });

  const failed = await runtime.dashboard();
  assert.equal(replayAttempts, 1);
  assert.equal(failed.serviceStatus.health, 'degraded');
  assert.equal(failed.serviceStatus.storage.writable, true);
  assert.equal(failed.diagnostics.some((item) => item.id === 'persistence.eventReplay'), true);

  const recovered = await runtime.dashboard();
  assert.equal(replayAttempts, 2);
  assert.equal(recovered.serviceStatus.health, 'healthy');
  assert.equal(recovered.diagnostics.some((item) => item.id === 'persistence.eventReplay'), false);
});

test('storage writability recovers through the production status probe without reinitializing', async (t) => {
  t.mock.method(console, 'error', () => {});
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-write-probe-'));
  const adminDir = path.join(rootDir, 'admin');
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  let storageUnavailable = true;
  const writeFile = fs.writeFile.bind(fs);
  t.mock.method(fs, 'writeFile', async (target, ...args) => {
    if (path.basename(String(target)) === '.writability-probe' && storageUnavailable) {
      await writeFile(target, 'partial', args[1]);
      const error = new Error('storage write failed after creating probe');
      error.code = 'EIO';
      throw error;
    }
    return writeFile(target, ...args);
  });
  const configManager = {
    ensureStorageDir: async () => {
      if (storageUnavailable) throw new Error('storage is read-only');
    },
    load: async () => ({ summary: { values: {} }, config: {} }),
  };
  const runtime = new AdminRuntime({ adminDir, configManager });

  await runtime.initialize();
  const failed = await runtime.dashboard();
  assert.equal(failed.serviceStatus.health, 'unavailable');
  assert.equal(failed.serviceStatus.storage.writable, false);
  assert.equal(failed.diagnostics.some((item) => item.id === 'storage.write'), true);
  assert.deepEqual((await fs.readdir(adminDir)).filter(name => name === '.writability-probe'), []);

  storageUnavailable = false;
  const recovered = await runtime.dashboard();
  assert.equal(recovered.serviceStatus.health, 'healthy');
  assert.equal(recovered.serviceStatus.storage.writable, true);
  assert.equal(recovered.diagnostics.some((item) => item.id === 'storage.write'), false);
});

test('interrupted recovery remains pending until its event is durably replayed', async (t) => {
  t.mock.method(console, 'error', () => {});
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-interrupted-outbox-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  let eventWritesBlocked = false;
  const store = new JobEventStore({
    adminDir,
    appendRecords: async (filePath, records) => {
      if (eventWritesBlocked) throw new Error('event history is read-only');
      await appendEventRecords(filePath, records);
    },
  });
  const jobId = '44444444-4444-4444-8444-444444444444';
  await store.appendMany([
    createJobEvent({ type: 'job.queued', jobId, timestamp: '2026-07-10T08:00:00.000Z', data: { repository: 'alice/recovery', pullNumber: 4 } }),
    createJobEvent({ type: 'job.started', jobId, timestamp: '2026-07-10T08:01:00.000Z', data: { startedAt: '2026-07-10T08:01:00.000Z' } }),
  ]);
  const runtime = new AdminRuntime({ adminDir, eventStore: store, configProvider: () => ({ version: 'test', port: 3007 }) });
  await runtime.refresh();

  eventWritesBlocked = true;
  await runtime.markInterruptedJobs();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const failed = await runtime.dashboard();
    assertPersistenceFailureSnapshot(failed, 'job-event-store', 1);
    assert.equal(failed.recentJobs.find(job => job.id === jobId).status, 'running');
    assert.equal(store.diagnostics().pendingEventCount, 1);
    assert.equal(failed.diagnostics.some(item => item.id === 'storage.write' || item.id === 'storage.writeCleanup'), false);
  }

  eventWritesBlocked = false;
  const recovered = await runtime.dashboard();
  assert.equal(recovered.recentJobs.find(job => job.id === jobId).status, 'interrupted');
  assert.equal(store.diagnostics().pendingEventCount, 0);
  assert.equal(recovered.diagnostics.some(item => item.id === 'job-event-store'), false);
  assert.equal(recovered.serviceStatus.storage.writable, true);
  assert.equal(recovered.serviceStatus.health, 'healthy');
});

test('fixed serialized write probe bounds cleanup leaks and removes its stale file on recovery', async (t) => {
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-write-cleanup-'));
  const probePath = path.join(adminDir, '.writability-probe');
  const rm = fs.rm.bind(fs);
  t.after(() => rm(adminDir, { recursive: true, force: true }));
  let cleanupBlocked = true;
  t.mock.method(fs, 'rm', async (target, ...args) => {
    if (target === probePath && cleanupBlocked) {
      try {
        await fs.stat(target);
      } catch (error) {
        if (error?.code === 'ENOENT') return rm(target, ...args);
        throw error;
      }
      const error = new Error('probe unlink denied');
      error.code = 'EACCES';
      throw error;
    }
    return rm(target, ...args);
  });
  const runtime = new AdminRuntime({ adminDir, configProvider: () => ({ version: 'test', port: 3007 }) });

  const failedSnapshots = await Promise.all([runtime.dashboard(), runtime.dashboard(), runtime.dashboard()]);
  for (const failed of failedSnapshots) assertPersistenceFailureSnapshot(failed, 'storage.writeCleanup');
  assert.deepEqual((await fs.readdir(adminDir)).filter(name => name === '.writability-probe'), ['.writability-probe']);

  cleanupBlocked = false;
  const recovered = await runtime.dashboard();
  assert.deepEqual((await fs.readdir(adminDir)).filter(name => name === '.writability-probe'), []);
  assert.equal(recovered.diagnostics.some(item => item.id === 'storage.writeCleanup'), false);
  assert.equal(recovered.serviceStatus.storage.writable, true);
  assert.equal(recovered.serviceStatus.health, 'healthy');
});

test('terminal event backlog flushes before a later job event and restores replay state', async (t) => {
  t.mock.method(console, 'error', () => {});
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-terminal-outbox-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  let writesBlocked = false;
  let terminalFailureInjected = false;
  const successfulBatches = [];
  const store = new JobEventStore({
    adminDir,
    appendRecords: async (filePath, records) => {
      if (!terminalFailureInjected && records.some(event => event.type === 'job.completed' || event.type === 'job.failed')) {
        terminalFailureInjected = true;
        writesBlocked = true;
      }
      if (writesBlocked) throw new Error('terminal event write failed');
      successfulBatches.push(records.map(event => ({ type: event.type, jobId: event.jobId })));
      await appendEventRecords(filePath, records);
    },
  });
  let configReads = 0;
  let releaseSecondStart;
  const secondStartGate = new Promise(resolve => { releaseSecondStart = resolve; });
  const queue = new AdminJobQueue({
    store,
    configProvider: async () => {
      configReads += 1;
      if (configReads === 2) await secondStartGate;
      return {};
    },
    handler: async () => ({ outcome: 'succeeded' }),
  });
  const runtime = new AdminRuntime({ adminDir, eventStore: store, queue, configProvider: () => ({ version: 'test', port: 3007 }) });

  const firstResult = await queue.enqueue({ key: 'first-job', payload: {}, metadata: { owner: 'alice', repo: 'first', pullNumber: 1 } });
  await queue.drainPromise;
  const firstJobId = firstResult.job.jobId;
  assert.equal((await store.replay({ force: true })).jobs.find(job => job.id === firstJobId).status, 'running');
  assert.equal(store.diagnostics().pendingEventCount, 1);
  await runtime.refresh();
  await runtime.markInterruptedJobs();
  assert.equal(store.diagnostics().pendingEventCount, 1, 'pending terminal transition must suppress interrupted recovery');

  const secondResult = await queue.enqueue({ key: 'second-job', payload: {}, metadata: { owner: 'alice', repo: 'second', pullNumber: 2 } });
  const secondDrain = queue.drainPromise;
  const secondJobId = secondResult.job.jobId;
  const failed = await runtime.dashboard();
  assertPersistenceFailureSnapshot(failed, 'job-event-store', 2);
  assert.equal(failed.recentJobs.find(job => job.id === firstJobId).status, 'running');

  writesBlocked = false;
  const recovered = await runtime.dashboard();
  const repairedBatch = successfulBatches.find(batch => batch.some(event => event.jobId === firstJobId && event.type === 'job.completed'));
  assert.deepEqual(repairedBatch.slice(0, 2), [
    { type: 'job.completed', jobId: firstJobId },
    { type: 'job.queued', jobId: secondJobId },
  ]);
  assert.equal(recovered.recentJobs.find(job => job.id === firstJobId).status, 'succeeded');
  assert.equal(store.diagnostics().pendingEventCount, 0);
  assert.equal(recovered.serviceStatus.storage.writable, true);
  assert.equal(recovered.serviceStatus.health, 'healthy');

  releaseSecondStart();
  await secondDrain;
});

test('semantic terminal event rejection becomes a persisted failed transition', async (t) => {
  t.mock.method(console, 'error', () => {});
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-semantic-terminal-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  const store = new JobEventStore({ adminDir });
  const queue = new AdminJobQueue({
    store,
    configProvider: () => ({}),
    handler: async () => ({ outcome: 'running' }),
  });

  const result = await queue.enqueue({ key: 'semantic-terminal', payload: {}, metadata: { owner: 'alice', repo: 'semantic', pullNumber: 3 } });
  await queue.drainPromise;
  const replayed = await store.replay({ force: true });
  assert.equal(replayed.jobs.find(job => job.id === result.job.jobId).status, 'failed');
  assert.equal(store.diagnostics().pendingEventCount, 0);
  assert.deepEqual(store.diagnostics().warnings, []);
});

test('mixed valid and invalid appendMany batch leaves file and outbox unchanged', async (t) => {
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-batch-atomicity-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  const store = new JobEventStore({ adminDir });
  const jobId = '15151515-1515-4515-8515-151515151515';
  const validQueued = createJobEvent({ type: 'job.queued', jobId, timestamp: '2026-07-10T11:20:00.000Z', data: { repository: 'alice/atomic', pullNumber: 16 } });
  const invalidCompleted = createJobEvent({ type: 'job.completed', jobId, timestamp: '2026-07-10T11:21:00.000Z', data: { status: 'running' } });

  await assert.rejects(() => store.appendMany([validQueued, invalidCompleted]), error => {
    assert.equal(error.name, 'EventSemanticError');
    assert.notEqual(error.eventRetained, true);
    return true;
  });
  assert.equal(store.diagnostics().pendingEventCount, 0);
  assert.deepEqual(store.diagnostics().warnings, []);
  assert.deepEqual((await store.replay({ force: true })).jobs, []);
  await assert.rejects(() => fs.readFile(path.join(adminDir, 'jobs', 'events.jsonl'), 'utf8'), error => error?.code === 'ENOENT');
});

test('older invalid pending event reports newly staged additions as retained', async (t) => {
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-batch-retained-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  const store = new JobEventStore({ adminDir });
  const olderJobId = '16161616-1616-4616-8616-161616161616';
  store.pendingEvents.push(createJobEvent({ type: 'job.completed', jobId: olderJobId, timestamp: '2026-07-10T11:30:00.000Z', data: { status: 'running' } }));
  const newJobId = '17171717-1717-4717-8717-171717171717';
  const newQueued = createJobEvent({ type: 'job.queued', jobId: newJobId, timestamp: '2026-07-10T11:31:00.000Z', data: { repository: 'alice/retained', pullNumber: 17 } });

  await assert.rejects(() => store.append(newQueued), error => {
    assert.equal(error.name, 'PendingEventWriteError');
    assert.equal(error.eventRetained, true);
    return true;
  });
  assert.equal(store.diagnostics().pendingEventCount, 1);
  assert.equal(store.pendingEvents[0].id, newQueued.id);
  assert.equal(store.diagnostics().integrityFailureCount, 1);
});

test('ambiguous event write reconciles stable IDs without duplicate replay effects', async (t) => {
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-idempotent-outbox-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  let failAfterWrite = false;
  const store = new JobEventStore({
    adminDir,
    appendRecords: async (filePath, records) => {
      await appendEventRecords(filePath, records);
      if (failAfterWrite) throw new Error('writer failed after durable append');
    },
  });
  const runtime = new AdminRuntime({ adminDir, eventStore: store, configProvider: () => ({ version: 'test', port: 3007 }) });
  const jobId = '77777777-7777-4777-8777-777777777777';
  await store.appendMany([
    createJobEvent({ type: 'job.queued', jobId, timestamp: '2026-07-10T09:00:00.000Z', data: { repository: 'alice/idempotent', pullNumber: 7 } }),
    createJobEvent({ type: 'job.started', jobId, timestamp: '2026-07-10T09:01:00.000Z', data: { startedAt: '2026-07-10T09:01:00.000Z' } }),
  ]);
  const logEvent = createJobEvent({ id: '88888888-8888-4888-8888-888888888888', type: 'job.log', jobId, timestamp: '2026-07-10T09:02:00.000Z', data: { level: 'info', message: 'once' } });
  const completedEvent = createJobEvent({ id: '99999999-9999-4999-8999-999999999999', type: 'job.completed', jobId, timestamp: '2026-07-10T09:03:00.000Z', data: { status: 'succeeded', finishedAt: '2026-07-10T09:03:00.000Z' } });

  failAfterWrite = true;
  await assert.rejects(() => store.appendMany([logEvent, completedEvent]), /writer failed after durable append/);
  assert.equal(store.diagnostics().pendingEventCount, 2);
  const recovered = await runtime.dashboard();
  assert.equal(recovered.recentJobs.find(job => job.id === jobId).status, 'succeeded');
  assert.equal(runtime.replay.jobs.find(job => job.id === jobId).logCount, 1);
  assert.equal(recovered.serviceStatus.health, 'healthy');
  assert.equal(recovered.serviceStatus.storage.writable, true);
  assert.equal(recovered.serviceStatus.diagnostics.runtimeWarnings, recovered.diagnostics.filter(item => item.level === 'warn').length);
  assert.equal(recovered.diagnostics.some(item => item.id === 'job-event-store'), false);

  const records = (await fs.readFile(path.join(adminDir, 'jobs', 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.filter(event => event.id === logEvent.id).length, 1);
  assert.equal(records.filter(event => event.id === completedEvent.id).length, 1);
  assert.equal(store.diagnostics().pendingEventCount, 0);
  assert.deepEqual(store.diagnostics().warnings, []);
});

test('same event ID with different content rejects without changing history', async (t) => {
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-event-id-conflict-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  const store = new JobEventStore({ adminDir });
  const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const eventId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const original = createJobEvent({ id: eventId, type: 'job.queued', jobId, timestamp: '2026-07-10T10:30:00.000Z', data: { repository: 'alice/original', pullNumber: 11 } });
  await store.append(original);
  const eventsPath = path.join(adminDir, 'jobs', 'events.jsonl');
  const before = await fs.readFile(eventsPath, 'utf8');
  const conflict = createJobEvent({ id: eventId, type: 'job.queued', jobId, timestamp: '2026-07-10T10:30:00.000Z', data: { repository: 'alice/changed', pullNumber: 11 } });

  await assert.rejects(() => store.append(conflict), /conflicts with different persisted content/);
  assert.equal(await fs.readFile(eventsPath, 'utf8'), before);
  assert.equal(store.diagnostics().pendingEventCount, 0);
  const replayed = await store.replay({ force: true });
  assert.equal(replayed.jobs.find(job => job.id === jobId).repository.fullName, 'alice/original');
});

test('event identity reconciliation reloads rewritten history and normalizes UUID case', async (t) => {
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-event-identity-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  const store = new JobEventStore({ adminDir });
  const jobId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const event = createJobEvent({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', type: 'job.queued', jobId, timestamp: '2026-07-10T10:40:00.000Z', data: { repository: 'alice/reloaded', pullNumber: 12 } });
  const eventsPath = path.join(adminDir, 'jobs', 'events.jsonl');
  await store.append(event);

  await fs.writeFile(eventsPath, '', 'utf8');
  await store.append(event);
  assert.equal((await fs.readFile(eventsPath, 'utf8')).trim().split('\n').length, 1);

  const upperLogId = 'FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF';
  const upperLog = { id: upperLogId, type: 'job.log', jobId: jobId.toUpperCase(), timestamp: '2026-07-10T10:41:00.000Z', data: { level: 'info' } };
  const lowerLog = { ...upperLog, id: upperLogId.toLowerCase(), jobId };
  await fs.appendFile(eventsPath, `${JSON.stringify(upperLog)}\n${JSON.stringify(lowerLog)}\n`, 'utf8');
  const replayed = await store.replay({ force: true });
  assert.equal(replayed.jobs.find(job => job.id === jobId).logCount, 1);
  assert.equal(replayed.invalidEvents.length, 0);
});

test('event submitted before an initial store read failure remains pending for flush', async (t) => {
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-initial-read-outbox-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  const eventsPath = path.join(adminDir, 'jobs', 'events.jsonl');
  const readFile = fs.readFile.bind(fs);
  let readsBlocked = true;
  t.mock.method(fs, 'readFile', async (target, ...args) => {
    if (target === eventsPath && readsBlocked) {
      const error = new Error('event history cannot be read');
      error.code = 'EACCES';
      throw error;
    }
    return readFile(target, ...args);
  });
  const store = new JobEventStore({ adminDir });
  const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const event = createJobEvent({ type: 'job.queued', jobId, timestamp: '2026-07-10T10:00:00.000Z', data: { repository: 'alice/read-recovery', pullNumber: 10 } });

  await assert.rejects(() => store.append(event), /event history cannot be read/);
  assert.equal(store.diagnostics().pendingEventCount, 1);
  assert.equal(store.diagnostics().warnings[0].affectsWritability, true);
  const invalid = createJobEvent({ type: 'job.completed', jobId, timestamp: '2026-07-10T10:01:00.000Z', data: { status: 'running' } });
  await assert.rejects(() => store.append(invalid), /job.completed requires terminal status: running/);
  assert.equal(store.diagnostics().pendingEventCount, 1);
  assert.equal(store.diagnostics().integrityFailureCount, 0);

  readsBlocked = false;
  await store.flushPending();
  const replayed = await store.replay({ force: true });
  assert.equal(replayed.jobs.find(job => job.id === jobId).status, 'queued');
  assert.equal(store.diagnostics().pendingEventCount, 0);
});

test('event store repair failure remains a writability diagnostic until the repair succeeds', async (t) => {
  t.mock.method(console, 'error', () => {});
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-event-repair-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  const store = new JobEventStore({ adminDir });
  const jobId = '12121212-1212-4212-8212-121212121212';
  await store.append(createJobEvent({ type: 'job.queued', jobId, timestamp: '2026-07-10T10:50:00.000Z', data: { repository: 'alice/repair', pullNumber: 13 } }));
  const eventsPath = path.join(adminDir, 'jobs', 'events.jsonl');
  await fs.appendFile(eventsPath, '{"truncated":', 'utf8');
  await store.replay({ force: true });
  const rename = fs.rename.bind(fs);
  let repairsBlocked = true;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target === eventsPath && repairsBlocked) {
      const error = new Error('event history repair denied');
      error.code = 'EACCES';
      throw error;
    }
    return rename(source, target);
  });
  const runtime = new AdminRuntime({ adminDir, eventStore: store, configProvider: () => ({ version: 'test', port: 3007 }) });

  const failed = await runtime.dashboard();
  assertPersistenceFailureSnapshot(failed, 'job-event-store', 0);
  assert.equal(store.diagnostics().writeFailure, 'event history repair denied');

  repairsBlocked = false;
  const recovered = await runtime.dashboard();
  assert.equal(recovered.serviceStatus.health, 'healthy');
  assert.equal(recovered.serviceStatus.storage.writable, true);
  assert.equal(recovered.diagnostics.some(item => item.id === 'job-event-store'), false);
});

test('startup retries interrupted recovery after event replay access returns', async (t) => {
  t.mock.method(console, 'error', () => {});
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-deferred-recovery-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  const jobId = '13131313-1313-4313-8313-131313131313';
  const seedStore = new JobEventStore({ adminDir });
  await seedStore.appendMany([
    createJobEvent({ type: 'job.queued', jobId, timestamp: '2026-07-10T11:00:00.000Z', data: { repository: 'alice/deferred', pullNumber: 14 } }),
    createJobEvent({ type: 'job.started', jobId, timestamp: '2026-07-10T11:01:00.000Z', data: { startedAt: '2026-07-10T11:01:00.000Z' } }),
  ]);
  const eventsPath = path.join(adminDir, 'jobs', 'events.jsonl');
  const readFile = fs.readFile.bind(fs);
  let readsBlocked = true;
  t.mock.method(fs, 'readFile', async (target, ...args) => {
    if (target === eventsPath && readsBlocked) {
      const error = new Error('startup replay denied');
      error.code = 'EACCES';
      throw error;
    }
    return readFile(target, ...args);
  });
  const runtime = new AdminRuntime({ adminDir, eventStore: new JobEventStore({ adminDir }), configProvider: () => ({ version: 'test', port: 3007 }) });

  await runtime.initialize();
  assert.equal(runtime.interruptedRecoveryPending, true);
  readsBlocked = false;
  const recovered = await runtime.dashboard();
  assert.equal(recovered.recentJobs.find(job => job.id === jobId).status, 'interrupted');
  assert.equal(runtime.interruptedRecoveryPending, false);
  assert.equal(recovered.serviceStatus.health, 'healthy');
  assert.equal(recovered.serviceStatus.storage.writable, true);
});

test('failed event compaction remains visible until compaction itself succeeds', async (t) => {
  t.mock.method(console, 'error', () => {});
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-compact-recovery-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  const store = new JobEventStore({ adminDir });
  const jobId = '14141414-1414-4414-8414-141414141414';
  await store.append(createJobEvent({ type: 'job.queued', jobId, timestamp: '2026-07-10T11:10:00.000Z', data: { repository: 'alice/compact', pullNumber: 15 } }));
  const eventsPath = path.join(adminDir, 'jobs', 'events.jsonl');
  const rename = fs.rename.bind(fs);
  let compactionBlocked = true;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target === eventsPath && compactionBlocked) {
      const error = new Error('event compaction denied');
      error.code = 'EACCES';
      throw error;
    }
    return rename(source, target);
  });
  const runtime = new AdminRuntime({ adminDir, eventStore: store, configProvider: () => ({ version: 'test', port: 3007 }) });

  await assert.rejects(() => store.compact(), /event compaction denied/);
  const failed = await runtime.dashboard();
  assertPersistenceFailureSnapshot(failed, 'job-event-store', 0);
  assert.equal(store.diagnostics().writeFailure, 'event compaction denied');

  compactionBlocked = false;
  await store.compact();
  const recovered = await runtime.dashboard();
  assert.equal(recovered.diagnostics.some(item => item.id === 'job-event-store'), false);
  assert.equal(recovered.serviceStatus.health, 'healthy');
  assert.equal(recovered.serviceStatus.storage.writable, true);
});

test('queue log persistence diagnostic clears after the next successful append', async (t) => {
  t.mock.method(console, 'error', () => {});
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-queue-log-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  let appendAttempts = 0;
  let firstWriteFinished;
  const firstWrite = new Promise(resolve => { firstWriteFinished = resolve; });
  let releaseSecondWrite;
  const secondWriteGate = new Promise(resolve => { releaseSecondWrite = resolve; });
  const queue = new AdminJobQueue({
    logger: {
      append: async () => {
        appendAttempts += 1;
        if (appendAttempts === 1) throw new Error('log store unavailable');
      },
    },
    handler: async (_payload, { logger }) => {
      await logger.info('first write');
      firstWriteFinished();
      await secondWriteGate;
      await logger.info('second write');
      return { outcome: 'succeeded' };
    },
  });
  const runtime = new AdminRuntime({ adminDir, queue, configProvider: () => ({ version: 'test', port: 3007 }) });
  await queue.enqueue({ key: 'log-recovery', payload: {} });
  const drain = queue.drainPromise;
  await firstWrite;
  const failedDiagnostic = queue.snapshot().diagnostics.find((item) => item.id === 'job-log-store');
  assert.equal(failedDiagnostic.affectsWritability, true);
  const failed = await runtime.serviceStatus(queue.snapshot(), {
    stats: { daily: { degraded: false } },
    retention: { config: {}, lastRun: null, diagnostics: [] },
  });
  assert.equal(failed.health, 'unavailable');
  assert.equal(failed.storage.writable, false);

  releaseSecondWrite();
  await drain;
  assert.equal(queue.snapshot().diagnostics.some((item) => item.id === 'job-log-store'), false);
  const recovered = await runtime.serviceStatus(queue.snapshot(), {
    stats: { daily: { degraded: false } },
    retention: { config: {}, lastRun: null, diagnostics: [] },
  });
  assert.equal(recovered.health, 'healthy');
  assert.equal(recovered.storage.writable, true);
});

test('retention persistence failure controls writability until a successful retry', async (t) => {
  t.mock.method(console, 'error', () => {});
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-retention-write-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  const statePath = path.join(adminDir, 'retention-state.json');
  await fs.mkdir(statePath);
  const runtime = new AdminRuntime({ adminDir, configProvider: () => ({ version: 'test', port: 3007 }) });
  const queue = { running: null, queuedCount: 0, queued: [], diagnostics: [] };
  const stats = { daily: { degraded: false } };

  const result = { ok: true, diagnostics: [] };
  await runtime.persistRetentionResult(result);
  const failed = await runtime.serviceStatus(queue, {
    stats,
    retention: { config: {}, lastRun: result, diagnostics: result.diagnostics },
  });
  assert.equal(result.ok, false);
  assert.equal(failed.storage.writable, false);

  await fs.rm(statePath, { recursive: true });
  await runtime.persistRetentionResult(result);
  const recovered = await runtime.serviceStatus(queue, {
    stats,
    retention: { config: {}, lastRun: result, diagnostics: result.diagnostics },
  });
  const persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.some((item) => item.id === 'retention.persist'), false);
  assert.equal(persisted.lastRun.ok, true);
  assert.equal(persisted.lastRun.diagnostics.some((item) => item.id === 'retention.persist'), false);
  assert.equal(recovered.storage.writable, true);
});

test('job log read failure degrades health without claiming storage is not writable', async (t) => {
  t.mock.method(console, 'error', () => {});
  const jobId = '22222222-2222-4222-8222-222222222222';
  let logReads = 0;
  let failLogRead = true;
  const logger = {
    read: async () => {
      logReads += 1;
      if (failLogRead) throw new Error('job log unavailable');
      return { entries: [], degraded: false, truncatedTail: false, total: 0, offset: 0, limit: 200 };
    },
  };
  const runtime = new AdminRuntime({ logger, configProvider: () => ({ version: 'test', port: 3007 }) });
  runtime.replay.jobs = [{
    id: jobId,
    status: 'succeeded',
    repository: { owner: 'alice', name: 'repo', fullName: 'alice/repo' },
    queuedAt: '2026-07-10T06:00:00.000Z',
    startedAt: '2026-07-10T06:01:00.000Z',
    finishedAt: '2026-07-10T06:02:00.000Z',
    updatedAt: '2026-07-10T06:02:00.000Z',
    result: { outcome: 'succeeded' },
  }];

  const detail = await runtime.jobDetail(jobId);
  assert.equal(logReads, 1);
  assert.equal(detail.diagnostics.some((item) => item.id === 'logs.unavailable'), true);
  const failed = await runtime.dashboard();
  assert.equal(failed.serviceStatus.health, 'degraded');
  assert.equal(failed.serviceStatus.storage.writable, true);
  assert.equal(failed.diagnostics.some((item) => item.id === `persistence.jobLog.${jobId}`), true);

  failLogRead = false;
  await runtime.jobDetail(jobId);
  assert.equal(logReads, 2);
  const recovered = await runtime.dashboard();
  assert.equal(recovered.serviceStatus.health, 'healthy');
  assert.equal(recovered.diagnostics.some((item) => item.id === `persistence.jobLog.${jobId}`), false);
});

test('job detail paginates one log read without truncating the phase timeline', async () => {
  const jobId = '33333333-3333-4333-8333-333333333333';
  const entries = [
    { timestamp: '2026-07-10T06:01:10.000Z', level: 'info', message: 'Authenticating', fields: { phase: 'github_auth' } },
    { timestamp: '2026-07-10T06:01:40.000Z', level: 'info', message: 'Publishing', fields: { phase: 'publishing' } },
  ];
  let logReads = 0;
  const logger = {
    read: async (_jobId, options = {}) => {
      logReads += 1;
      const offset = options.offset ?? 0;
      const limit = options.limit ?? entries.length;
      return { entries: entries.slice(offset, offset + limit), total: entries.length, degraded: false, truncatedTail: false };
    },
  };
  const runtime = new AdminRuntime({ logger, configProvider: () => ({ version: 'test', port: 3007 }) });
  runtime.replay.jobs = [{
    id: jobId,
    status: 'succeeded',
    repository: { owner: 'alice', name: 'repo', fullName: 'alice/repo' },
    queuedAt: '2026-07-10T06:00:00.000Z',
    startedAt: '2026-07-10T06:01:00.000Z',
    finishedAt: '2026-07-10T06:02:00.000Z',
    updatedAt: '2026-07-10T06:02:00.000Z',
    result: { outcome: 'succeeded' },
  }];

  const detail = await runtime.jobDetail(jobId, { logLimit: 1, logOffset: 1 });
  assert.equal(logReads, 1);
  assert.deepEqual(detail.logs.entries.map((entry) => entry.fields.phase), ['publishing']);
  assert.deepEqual(detail.phaseTimeline.filter((item) => item.source === 'log').map((item) => item.label), ['github_auth', 'publishing']);
});

test('dashboard health tile maps runtime health and is never optimistic Healthy', () => {
  const missing = renderDashboardPage({ csrfToken: 'csrf', summary: {}, diagnostics: [], serviceStatus: null });
  assert.match(missing, /data-i18n="health_unavailable"/);
  assert.doesNotMatch(missing, />Healthy</);

  const degraded = renderDashboardPage({
    csrfToken: 'csrf',
    summary: {},
    diagnostics: [],
    serviceStatus: {
      health: 'degraded',
      storage: { writable: true, degraded: true, dirSizeBytes: 1, budgetBytes: 10 },
      diagnostics: { degraded: true, corruptEvents: 1, invalidEvents: 0, truncatedTail: false },
      uptimeMs: 1000,
      startedAt: '2026-07-10T06:08:42.731Z',
    },
  });
  assert.match(degraded, /data-i18n="health_degraded"/);
  assert.doesNotMatch(degraded, />Healthy</);
  assert.match(degraded, /data-i18n="storage_writable"[\s\S]*data-i18n="storage_degraded"/);
});

test('succeeded_with_warnings keeps warning pill on last completed card', () => {
  const html = renderDashboardPage({
    csrfToken: 'csrf',
    summary: {},
    diagnostics: [],
    serviceStatus: {
      health: 'healthy',
      storage: { writable: true, degraded: false, dirSizeBytes: 1, budgetBytes: 10 },
      diagnostics: { degraded: false, corruptEvents: 0, invalidEvents: 0, truncatedTail: false },
      lastSuccess: {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'succeeded_with_warnings',
        repository: { fullName: 'alice/demo' },
        pullNumber: 3,
        actor: 'alice',
        diagnosticId: 'WARN1',
      },
    },
  });
  assert.match(html, /data-i18n="ss_last_completed"/);
  assert.match(html, /dpill warn/);
  assert.match(html, /data-i18n="pill_warnings"/);
  assert.match(html, /href="\/admin\/jobs\/11111111-1111-4111-8111-111111111111"/);
});

test('status activity cards link to job detail pages', () => {
  const html = renderDashboardPage({
    csrfToken: 'csrf',
    summary: { queued: 1, running: 1 },
    diagnostics: [],
    serviceStatus: {
      health: 'healthy',
      storage: { writable: true, degraded: false },
      diagnostics: { degraded: false, corruptEvents: 0, invalidEvents: 0, truncatedTail: false },
      running: {
        jobId: '22222222-2222-4222-8222-222222222222',
        status: 'running',
        repository: 'alice/web',
        pullNumber: 9,
        actor: 'bob',
      },
      queued: {
        count: 1,
        items: [{ jobId: '33333333-3333-4333-8333-333333333333', repository: 'alice/api' }],
      },
      lastFailure: {
        id: '44444444-4444-4444-8444-444444444444',
        status: 'failed',
        repository: { fullName: 'alice/api' },
        pullNumber: 1,
        actor: 'carol',
        diagnosticId: 'FL1',
      },
    },
  });
  assert.match(html, /href="\/admin\/jobs\/22222222-2222-4222-8222-222222222222"/);
  assert.match(html, /href="\/admin\/jobs\/33333333-3333-4333-8333-333333333333"/);
  assert.match(html, /href="\/admin\/jobs\/44444444-4444-4444-8444-444444444444"/);
});

test('jobs advanced filters expose all eight states', () => {
  const html = renderJobsPage({
    csrfToken: 'csrf',
    jobs: [],
    filters: {},
    pagination: { page: 1, totalPages: 1, total: 0, pageSize: 50, hasPrev: false, hasNext: false },
  });
  assert.match(html, /name="state"/);
  for (const state of ['succeeded', 'succeeded_with_warnings', 'failed', 'running', 'queued', 'interrupted', 'stale', 'skipped']) {
    assert.match(html, new RegExp(`option value="${state}"`));
  }
});

test('jobs advanced filters keep From/To as one field group before actions', () => {
  const html = renderJobsPage({
    csrfToken: 'csrf',
    jobs: [],
    filters: {},
    pagination: { page: 1, totalPages: 1, total: 0, pageSize: 50, hasPrev: false, hasNext: false },
  });
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.match(
    markup,
    /class="adv-field-group"[^>]*data-i18n-aria-label="aria_date_range"[^>]*>[\s\S]*name="from"[\s\S]*name="to"[\s\S]*<\/div>\s*<div class="adv-actions"/,
  );
  assert.match(html, /\.adv-grid \.adv-field-group \{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;/);
  assert.match(html, /\.adv-grid \.adv-actions \{[^}]*flex:\s*1\s+1\s+100%;/);
  const dictionaries = extractI18nDictionaries(html);
  assert.equal(dictionaries.en.aria_date_range, 'Date range');
  assert.equal(dictionaries.zh.aria_date_range, '日期范围');
  assert.doesNotMatch(
    markup,
    /class="adv-grid">[\s\S]*name="from"[\s\S]*name="to"[\s\S]*<\/label>\s*<div class="adv-actions"/,
  );
});

test('jobs table compacts long job and diagnostic ids without wrapping strategy', () => {
  const jobId = 'b7877599-af77-4489-86dd-c0cbc869e75c';
  const diagnosticId = 'makoMakoGo/code-dispatcher-toolkit#64@4943807673';
  const html = renderJobsPage({
    csrfToken: 'csrf',
    jobs: [{
      id: jobId,
      status: 'succeeded',
      repository: 'makoMakoGo/code-dispatcher-toolkit',
      pullNumber: 64,
      actor: 'makoMakoGo',
      diagnosticId,
      queuedAt: '2026-07-11T08:15:45.000Z',
    }],
    filters: {},
    pagination: { page: 1, totalPages: 1, total: 1, pageSize: 50, hasPrev: false, hasNext: false },
  });
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.match(markup, new RegExp(`href="/admin/jobs/${jobId}"`));
  assert.match(markup, new RegExp(`title="${jobId}"`));
  assert.match(markup, /b7877599…e75c/);
  assert.doesNotMatch(markup, new RegExp(`<code>${jobId}</code>`));
  assert.match(markup, new RegExp(`title="${diagnosticId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(markup, /#64@4943807673/);
  assert.doesNotMatch(markup, /code-dispatcher-toolkit#64@4943807673<\/code>/);
  assert.match(html, /\.gh-table \{[^}]*table-layout:\s*auto;/);
  assert.match(html, /class="gh-table jobs-table"/);
  assert.match(html, /\.jobs-table td\.repo \{[^}]*text-overflow:\s*ellipsis;/);
  assert.match(html, /\.jobs-table \.col-repo \{[^}]*width:\s*100%;/);
  assert.match(html, /\.gh-table-wrap \{[^}]*overflow-x:\s*auto;/);
  assert.doesNotMatch(html, /\.gh-table \{[^}]*table-layout:\s*fixed;/);
  assert.doesNotMatch(html, /11\.75rem|7\.5rem|9\.5rem|6\.5rem/);
  assert.match(markup, /placeholder="repo#12@commentId"/);
});


test('metrics repository table keeps numeric columns content-sized and right-aligned', () => {
  const html = renderMetricsPage({
    csrfToken: 'csrf',
    stats: {
      total: {
        repositories: {
          'makoMakoGo/oh-my-pi-coding-agent-with-a-very-long-name': { jobs: 1, successRate: 1 },
          'alice/monorepo': { jobs: 3, successRate: 0.5 },
        },
        failureKinds: {},
      },
      windows: {},
      dailyTrend: [],
    },
  });
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.match(markup, /class="gh-table metrics-table"/);
  assert.match(markup, /data-i18n="th_repository">Repository</);
  assert.match(html, /\.metrics-table thead th:not\(:first-child\),\s*\.metrics-table td\s*\{[\s\S]*?text-align:\s*right;/);
  assert.match(html, /\.metrics-table th\[scope="row"\]\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.doesNotMatch(html, /\.gh-table th:nth-child\(3\)/);
});
test('Status last-completed cards compact diagnostic and job ids', () => {
  const jobId = '101b9f19-89e9-468f-b16e-19ed0800213a';
  const diagnosticId = 'makoMakoGo/oh-my-pi-coding-agent-with-a-very-long-name#350@4999999999';
  const html = renderDashboardPage({
    csrfToken: 'csrf',
    summary: {},
    diagnostics: [],
    serviceStatus: {
      health: 'healthy',
      storage: { writable: true, degraded: false },
      diagnostics: {},
      lastSuccess: {
        id: jobId,
        status: 'succeeded',
        repository: 'makoMakoGo/oh-my-pi-coding-agent-with-a-very-long-name',
        pullNumber: 350,
        actor: 'makoMakoGo',
        diagnosticId,
      },
    },
  });
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.match(markup, /data-i18n="ss_last_completed"/);
  assert.match(markup, /#350@4999999999/);
  assert.match(markup, new RegExp(`title="${diagnosticId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.doesNotMatch(markup, /oh-my-pi-coding-agent-with-a-very-long-name#350@4999999999<\/code>/);
  assert.match(markup, /101b9f19…213a/);
  assert.match(markup, new RegExp(`title="${jobId}"`));
});

test('settings subnav keeps count after i18n init', () => {
  const html = renderConfigPage({
    csrfToken: 'csrf',
    adminRoot: '/tmp/admin',
    section: 'ocr',
    config: {
      revision: 1,
      fields: [
        { envKey: 'OCR_LLM_URL', name: 'ocrLlmUrl', label: 'OCR LLM URL', group: 'ocr', editable: true, value: 'http://x', effectiveValue: 'http://x' },
        { envKey: 'PORT', name: 'port', label: 'Port', group: 'service', editable: true, value: 3007, effectiveValue: 3007 },
      ],
    },
  });
  assert.match(html, /data-i18n="config_group_ocr"/);
  assert.match(html, /<span class="settings-count">1<\/span>/);
  assert.doesNotMatch(html, /<a class="settings-subnav-link[^"]*" href="\/admin\/config\?section=ocr" data-i18n="config_group_ocr">/);
  runApplyLangOnSettingsNav(html);
});

test('alerts use closed semantic tones with localized labels', () => {
  const login = renderLoginPage({ error: 'Invalid password.' });
  assert.match(login, /class="alert error"/);
  assert.match(login, /class="alert-label"[^>]*data-i18n="alert_error"[^>]*>Error</);
  assert.doesNotMatch(login, /alert::before|content: "!"/);

  const jobs = renderJobsPage({
    csrfToken: 'csrf',
    jobs: [],
    filters: {},
    validationMessages: ['from must be a date'],
    pagination: { page: 1, totalPages: 1, total: 0, pageSize: 50, hasPrev: false, hasNext: false },
  });
  assert.match(jobs, /class="alert error"/);
  assert.match(jobs, /data-i18n="alert_error"/);
  assert.match(jobs, /<ul><li>from must be a date<\/li><\/ul>/);
  assert.match(jobs, /\.alert-body, \.alert ul \{[^}]*flex:\s*1\s+1\s+auto;/);

  const config = renderConfigPage({
    csrfToken: 'csrf',
    adminRoot: '/tmp/admin',
    flash: { type: 'success', message: 'Saved' },
    config: {
      revision: 1,
      fields: [],
      pendingRestart: { required: true, keys: ['PORT'] },
    },
  });
  assert.match(config, /class="alert success"/);
  assert.match(config, /data-i18n="alert_success"[^>]*>Success</);
  assert.match(config, /class="alert warning"/);
  assert.match(config, /data-i18n="alert_warning"[^>]*>Warning</);
  assert.doesNotMatch(config, /class="alert warning"[\s\S]*data-i18n="alert_error"/);

  const dictionaries = extractI18nDictionaries(config);
  assert.equal(dictionaries.en.alert_error, 'Error');
  assert.equal(dictionaries.zh.alert_error, '错误');
  assert.equal(dictionaries.en.alert_success, 'Success');
  assert.equal(dictionaries.zh.alert_success, '成功');
  assert.equal(dictionaries.en.alert_warning, 'Warning');
  assert.equal(dictionaries.zh.alert_warning, '警告');
  assert.equal(dictionaries.en.aria_date_range, 'Date range');
  assert.equal(dictionaries.zh.aria_date_range, '日期范围');
});

test('degraded logs alert uses warning tone not error', () => {
  const html = renderJobDetailPage({
    csrfToken: 'csrf',
    job: {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'succeeded',
      repository: 'alice/repo',
      pullNumber: 1,
      diagnosticId: 'alice/repo#1@1',
      logs: {
        entries: [{ timestamp: '2026-07-11T00:00:00.000Z', level: 'info', message: 'ok', fields: {} }],
        degraded: true,
      },
    },
  });
  assert.match(html, /class="alert warning"/);
  assert.match(html, /data-i18n="alert_warning"/);
  assert.match(html, /data-i18n="logs_degraded"/);
  assert.doesNotMatch(html, /class="alert warning"[\s\S]*data-i18n="alert_error"/);
});

test('config POST redirects back to submitted section on success and error', async () => {
  let calls = 0;
  const router = createAdminRouter({
    adminPassword: 'a-secure-admin-password',
    allowedHosts: 'juya.011070.xyz',
    secureCookies: false,
    loadSecurityConfig: () => ({
      adminPassword: 'a-secure-admin-password',
      allowedHosts: 'juya.011070.xyz',
      trustProxy: false,
      cookieSecure: false,
      sessionTtlMs: 60 * 60 * 1000,
    }),
    loadDashboard: () => ({ summary: {}, diagnostics: [] }),
    loadConfig: () => ({ revision: 0, fields: [] }),
    saveConfig: () => {
      calls += 1;
      if (calls === 1) return { changedKeys: ['OCR_LLM_URL'] };
      throw new Error('save failed');
    },
  });
  const login = await router.route({
    method: 'POST',
    url: '/admin/login',
    headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz' },
    body: new URLSearchParams({ password: 'a-secure-admin-password' }).toString(),
  });
  const cookie = login.headers['set-cookie'].join('; ');
  const ok = await router.route({
    method: 'POST',
    url: '/admin/config',
    headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz', 'x-forwarded-proto': 'https', cookie },
    body: new URLSearchParams({
      _csrf: extractCsrfFromCookie(cookie),
      revision: '0',
      section: 'ocr',
    }).toString(),
  });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/admin/config?section=ocr');

  const failed = await router.route({
    method: 'POST',
    url: '/admin/config',
    headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz', 'x-forwarded-proto': 'https', cookie },
    body: new URLSearchParams({
      _csrf: extractCsrfFromCookie(cookie),
      revision: '0',
      section: 'admin',
    }).toString(),
  });
  assert.equal(failed.status, 303);
  assert.equal(failed.headers.location, '/admin/config?section=admin');

  const invalid = await router.route({
    method: 'POST',
    url: '/admin/config',
    headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz', 'x-forwarded-proto': 'https', cookie },
    body: new URLSearchParams({
      _csrf: extractCsrfFromCookie(cookie),
      revision: '0',
      section: '../evil',
    }).toString(),
  });
  assert.equal(invalid.status, 303);
  assert.equal(invalid.headers.location, '/admin/config');
});

test('formatDate keeps seconds and UTC marker in job detail', () => {
  const html = renderJobDetailPage({
    csrfToken: 'csrf',
    job: {
      id: 'abc',
      repository: { fullName: 'alice/repo' },
      queuedAt: '2026-07-10T06:08:42.731Z',
      startedAt: '2026-07-10T06:09:01.000Z',
      finishedAt: '2026-07-10T06:10:15.500Z',
      phaseTimeline: [
        { timestamp: '2026-07-10T06:08:42.731Z', phase: 'queued', message: 'queued' },
        { timestamp: '2026-07-10T06:09:01.000Z', phase: 'ocr', message: 'running' },
      ],
      result: { outcome: 'succeeded' },
    },
  });
  assert.match(html, /2026-07-10 06:08:42 UTC/);
  assert.match(html, /2026-07-10 06:09:01 UTC/);
});

test('dark theme defines semantic status fills', () => {
  const html = renderDashboardPage({
    csrfToken: 'csrf',
    summary: {},
    diagnostics: [],
    serviceStatus: {
      health: 'healthy',
      storage: { writable: true, degraded: false },
      diagnostics: { degraded: false },
    },
  });
  assert.match(html, /:root\[data-theme="dark"\][\s\S]*--success-subtle:\s*[^;]+;/);
  assert.match(html, /:root\[data-theme="dark"\][\s\S]*--attention-subtle:\s*[^;]+;/);
  assert.match(html, /:root\[data-theme="dark"\][\s\S]*--danger-subtle:\s*[^;]+;/);
  assert.match(html, /:root\[data-theme="dark"\][\s\S]*--done-subtle:\s*[^;]+;/);
  assert.match(html, /:root\[data-theme="dark"\][\s\S]*--neutral-subtle:\s*[^;]+;/);
});

test('service health uses deduplicated current stats, retention, and queue diagnostics', async () => {
  const runtime = new AdminRuntime({ configProvider: () => ({ version: 'test', port: 3007 }) });
  runtime.replay = { jobs: [], degraded: false, corruptions: [], invalidEvents: [], truncatedTail: null };
  const queue = { running: null, queuedCount: 0, queued: [], diagnostics: [] };
  const healthyStats = { daily: { degraded: false } };
  const healthyRetention = { config: {}, lastRun: null, diagnostics: [] };

  const statsDegraded = await runtime.serviceStatus(queue, {
    stats: { daily: { degraded: true } },
    retention: healthyRetention,
  });
  assert.equal(statsDegraded.health, 'degraded');
  assert.equal(statsDegraded.diagnostics.runtimeWarnings, 1);

  const retentionDiagnostic = { id: 'retention.persist', level: 'warn', message: 'retention persistence failed' };
  const retentionDegraded = await runtime.serviceStatus(queue, {
    stats: healthyStats,
    retention: {
      config: {},
      lastRun: { ok: false, diagnostics: [retentionDiagnostic] },
      diagnostics: [retentionDiagnostic],
    },
  });
  assert.equal(retentionDegraded.health, 'degraded');
  assert.equal(retentionDegraded.diagnostics.runtimeWarnings, 1);

  const retentionWriteDiagnostic = { ...retentionDiagnostic, affectsWritability: true };
  const retentionWriteFailure = await runtime.serviceStatus(queue, {
    stats: healthyStats,
    retention: {
      config: {},
      lastRun: { ok: false, diagnostics: [retentionWriteDiagnostic] },
      diagnostics: [retentionWriteDiagnostic],
    },
  });
  assert.equal(retentionWriteFailure.storage.writable, false);

  const distinctRetentionFailures = await runtime.serviceStatus(queue, {
    stats: healthyStats,
    retention: {
      config: {},
      lastRun: { ok: false, diagnostics: [] },
      diagnostics: [{ id: 'retention.config', level: 'warn', message: 'retention config unavailable' }],
    },
  });
  assert.equal(distinctRetentionFailures.diagnostics.runtimeWarnings, 2);

  const queueDegraded = await runtime.serviceStatus({ ...queue, diagnostics: [{ id: 'queue', level: 'warn' }] }, {
    stats: healthyStats,
    retention: healthyRetention,
  });
  assert.equal(queueDegraded.health, 'degraded');
  assert.equal(queueDegraded.diagnostics.degraded, true);
  assert.equal(queueDegraded.storage.degraded, false);
});

test('dashboard health recovers after a failed stats read succeeds', async (t) => {
  t.mock.method(console, 'error', () => {});
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-stats-recovery-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  const statsPath = path.join(adminDir, 'stats', 'daily-stats.jsonl');
  await fs.mkdir(statsPath, { recursive: true });
  const runtime = new AdminRuntime({ adminDir, configProvider: () => ({ version: 'test', port: 3007 }) });

  const failed = await runtime.dashboard();
  assert.equal(failed.serviceStatus.health, 'degraded');
  assert.equal(failed.serviceStatus.diagnostics.runtimeWarnings, 1);

  await fs.rm(statsPath, { recursive: true });
  await fs.writeFile(statsPath, '');
  const recovered = await runtime.dashboard();
  assert.equal(recovered.stats.daily.degraded, false);
  assert.equal(recovered.serviceStatus.health, 'healthy');
  assert.equal(recovered.serviceStatus.diagnostics.runtimeWarnings, 0);
});

test('dashboard health degrades for corrupt daily stats that do not throw', async (t) => {
  const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-stats-degraded-'));
  t.after(() => fs.rm(adminDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(adminDir, 'stats'), { recursive: true });
  await fs.writeFile(path.join(adminDir, 'stats', 'daily-stats.jsonl'), '{not-json}\n');
  const runtime = new AdminRuntime({ adminDir, configProvider: () => ({ version: 'test', port: 3007 }) });

  const dashboard = await runtime.dashboard();
  assert.equal(dashboard.stats.daily.degraded, true);
  assert.equal(dashboard.serviceStatus.health, 'degraded');
  assert.equal(dashboard.serviceStatus.diagnostics.runtimeWarnings, 1);
  assert.equal(dashboard.diagnostics.filter((item) => item.id === 'stats.daily').length, 1);
});

test('dashboard health clears a recovered retention config failure', async (t) => {
  t.mock.method(console, 'error', () => {});
  let failing = true;
  const runtime = new AdminRuntime({
    configProvider: () => {
      if (failing) throw new Error('retention config unavailable');
      return { version: 'test', port: 3007 };
    },
  });
  const failedRetention = await runtime.retentionStatus();
  assert.deepEqual(failedRetention.diagnostics.map((item) => item.id), ['retention.config']);

  failing = false;
  const recovered = await runtime.dashboard();
  assert.equal(recovered.serviceStatus.health, 'healthy');
  assert.equal(recovered.serviceStatus.diagnostics.runtimeWarnings, 0);
  assert.equal(recovered.diagnostics.some((item) => item.id.startsWith('retention.')), false);
});

test('invalid health values map to unavailable and never introduce a fourth state', () => {
  const html = renderDashboardPage({
    csrfToken: 'csrf',
    summary: {},
    diagnostics: [],
    serviceStatus: { health: 'unknown', storage: {}, diagnostics: {} },
  });
  assert.match(html, /data-i18n="health_unavailable"/);
  assert.doesNotMatch(html, /health_unknown|>Unknown</);
});

test('Status i18n keys are complete in English and Chinese', () => {
  const html = renderDashboardPage({
    csrfToken: 'csrf',
    summary: { queued: 1, running: 1, succeeded: 1, failed: 1, succeeded_with_warnings: 1 },
    diagnostics: [],
    serviceStatus: {
      health: 'degraded',
      configuredPort: 3007,
      actualListeningPort: 43123,
      storage: { writable: true, degraded: true, dirSizeBytes: 1, budgetBytes: 10 },
      diagnostics: { degraded: true, corruptEvents: 1, invalidEvents: 2, truncatedTail: true },
      running: { jobId: '22222222-2222-4222-8222-222222222222', phase: 'ocr', repository: 'alice/web' },
    },
  });
  const dictionaries = extractI18nDictionaries(html);
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const keys = new Set([...markup.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]));
  for (const key of keys) {
    assert.equal(typeof dictionaries.en[key], 'string', `missing en.${key}`);
    assert.equal(typeof dictionaries.zh[key], 'string', `missing zh.${key}`);
  }
  assert.match(html, /data-i18n="word_configured"/);
  assert.match(html, /data-i18n="diag_corrupt"[\s\S]*data-i18n="diag_invalid"[\s\S]*data-i18n="diag_truncated"/);
});

test('Status details split diagnostics and keep short storage labels', () => {
  const html = renderDashboardPage({
    csrfToken: 'csrf',
    summary: {},
    diagnostics: [],
    serviceStatus: {
      health: 'healthy',
      actualListeningPort: 3008,
      configuredPort: 3008,
      storage: { writable: true, degraded: false, dirSizeBytes: 16384, budgetBytes: 512 * 1024 * 1024 },
      diagnostics: { corruptEvents: 0, invalidEvents: 0, truncatedTail: false, runtimeWarnings: 0 },
    },
  });
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.match(markup, /data-i18n="ssg_runtime"[\s\S]*data-i18n="ss_port"/);
  assert.doesNotMatch(markup, /data-i18n="ssg_network"/);
  assert.match(markup, /data-i18n="diag_corrupt"[^>]*>[\s\S]*?<\/span>\s*<span class="v">0<\/span>/);
  assert.match(markup, /data-i18n="diag_invalid"[^>]*>[\s\S]*?<\/span>\s*<span class="v">0<\/span>/);
  assert.match(markup, /data-i18n="diag_truncated"[^>]*>[\s\S]*?<\/span>\s*<span class="v">[\s\S]*data-i18n="word_no"/);
  assert.match(markup, /data-i18n="diag_runtime_warnings"[^>]*>[\s\S]*?<\/span>\s*<span class="v">0<\/span>/);
  assert.doesNotMatch(markup, /data-i18n="ss_diag_counts"/);
  assert.doesNotMatch(html, /corrupt 0, invalid 0/);

  const dictionaries = extractI18nDictionaries(html);
  assert.equal(dictionaries.en.ss_storage_health, 'State');
  assert.equal(dictionaries.en.ss_storage_size, 'Usage');
  assert.equal(dictionaries.zh.ss_storage_health, '状态');
  assert.equal(dictionaries.zh.ss_storage_size, '用量');
  assert.match(html, /\.dashboard \.status-details \{[^}]*minmax\(260px, 1fr\)/);
  assert.match(html, /\.dashboard \.kv \.v \{[^}]*min-width:\s*0;/);
});

test('runtime running job and dashboard pill remain running across inner phases', async () => {
  const runtime = new AdminRuntime({ configProvider: () => ({ version: 'test', port: 3007 }) });
  runtime.replay = { jobs: [], degraded: false, corruptions: [], invalidEvents: [], truncatedTail: null };
  const status = await runtime.serviceStatus({
    running: { jobId: '22222222-2222-4222-8222-222222222222', phase: 'ocr', startedAt: '2026-07-10T06:00:00.000Z' },
    queuedCount: 0,
    queued: [],
    diagnostics: [],
  });
  assert.equal(status.running.status, 'running');
  const html = renderDashboardPage({ csrfToken: 'csrf', summary: { running: 1 }, diagnostics: [], serviceStatus: status });
  assert.match(html, /dpill run[\s\S]*data-i18n="pill_running"/);
  assert.doesNotMatch(html, /dpill queued[\s\S]*>ocr</);
});

test('advanced and login focus rules use the solid accent ring', () => {
  const html = renderJobsPage({
    csrfToken: 'csrf',
    jobs: [],
    filters: {},
    pagination: { page: 1, totalPages: 1, total: 0, pageSize: 50, hasPrev: false, hasNext: false },
  });
  assert.match(html, /\.adv-grid input:focus, \.adv-grid select:focus \{[^}]*outline: 2px solid var\(--accent\);[^}]*outline-offset: 2px;/);
  assert.match(html, /\.login-form input:focus \{[^}]*outline: 2px solid var\(--accent\);[^}]*outline-offset: 2px;/);
});

test('theme language toggles keep one neutral Primer style cascade', () => {
  const html = renderDashboardPage({ csrfToken: 'csrf', summary: {}, diagnostics: [], serviceStatus: null });
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  assert.ok(style, 'expected embedded admin stylesheet');

  assert.match(
    style,
    /\.toggle-btn,\s*\.signout button\s*\{[\s\S]*?font-weight:\s*500;[\s\S]*?padding:\s*5px 12px;/,
    'toggle base style should use the Primer control chrome',
  );
  assert.match(
    style,
    /\.toggle-btn:hover,\s*\.signout button:hover\s*\{[\s\S]*?background:\s*var\(--surface-2\);[\s\S]*?border-color:\s*var\(--border-bright\);[\s\S]*?color:\s*var\(--text\);/,
    'toggle hover should stay neutral surface chrome',
  );
  assert.match(style, /\.toggles\s*\{\s*display:\s*inline-flex;\s*align-items:\s*center;\s*gap:\s*8px;\s*\}/);

  // Later same-specificity rules would override the Primer-light intent above.
  assert.doesNotMatch(style, /\.toggle-btn:hover\s*\{\s*color:\s*var\(--accent\);/);
  assert.doesNotMatch(style, /\.toggles\s*\{\s*display:\s*flex;\s*gap:\s*0\.4rem;/);
  assert.doesNotMatch(style, /\.toggle-btn\s*\{\s*font-size:\s*13px;\s*font-weight:\s*600;/);
});

test('dark status pill text meets WCAG AA on page and hover surfaces', () => {
  const html = renderDashboardPage({ csrfToken: 'csrf', summary: {}, diagnostics: [], serviceStatus: null });
  const rootBlock = html.match(/:root \{([\s\S]*?)\n\}/)?.[1];
  const darkBlock = html.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(rootBlock, 'expected root theme block');
  assert.ok(darkBlock, 'expected dark theme block');
  const variables = new Map([...cssVariables(rootBlock), ...cssVariables(darkBlock)]);
  for (const backgroundName of ['--bg', '--surface']) {
    const background = resolveCssColor(backgroundName, variables);
    for (const [foregroundName, fillName] of [
      ['--accent', '--accent-subtle'],
      ['--success', '--success-subtle'],
      ['--attention', '--attention-subtle'],
      ['--danger', '--danger-subtle'],
      ['--done', '--done-subtle'],
    ]) {
      const foreground = resolveCssColor(foregroundName, variables);
      const fill = compositeColor(resolveCssColor(fillName, variables), background);
      assert.ok(contrastRatio(foreground, fill) >= 4.5, `${foregroundName} on ${backgroundName} must reach 4.5:1`);
    }
  }
  assert.match(html, /\.dpill\.run \{[^}]*border-color: var\(--accent-border\);/);
  assert.match(html, /\.chip\.on \{[^}]*border-color: var\(--accent-border\);/);
});
