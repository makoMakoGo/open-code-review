import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AdminRuntime, renderDashboardPage, renderJobDetailPage, renderMetricsPage } from '../src/admin/index.js';
import { loadConfig } from '../src/config.js';
import { AdminJobQueue, BoundedJobLogger, createJobEvent, JobEventStore } from '../src/jobs/index.js';

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

function emptyReplay(jobs = []) {
  return { jobs, degraded: false, corruptions: [], invalidEvents: [], truncatedTail: null };
}

test('metrics page renders latency percentiles comments failure repository and daily metrics', () => {
  const stats = {
    total: {
      jobs: 2,
      succeeded: 1,
      failed: 1,
      successRate: 0.5,
      durationP50Ms: 10 * 60 * 1000,
      durationP95Ms: 30 * 60 * 1000,
      queueWaitP50Ms: 5 * 60 * 1000,
      queueWaitP95Ms: 10 * 60 * 1000,
      averageCommentsGenerated: 4.5,
      averageCommentsPosted: 2,
      stale: 1,
      skipped: 1,
      interrupted: 1,
      failureKinds: { provider_unavailable: 1 },
      repositories: {
        'alice/repo': { jobs: 2, succeeded: 1, failed: 1, successRate: 0.5 },
      },
    },
    windows: {
      '24h': { jobs: 2, succeeded: 1, failed: 1, stale: 1, skipped: 1, interrupted: 1, successRate: 0.5, durationP50Ms: 10 * 60 * 1000, durationP95Ms: 30 * 60 * 1000, queueWaitP50Ms: 5 * 60 * 1000, queueWaitP95Ms: 10 * 60 * 1000, averageCommentsGenerated: 4.5, averageCommentsPosted: 2, failureKinds: { provider_unavailable: 1 }, repositories: { 'alice/repo': { jobs: 2, succeeded: 1, failed: 1, stale: 1, skipped: 1, interrupted: 1, successRate: 0.5 } } },
      '7d': { jobs: 2, succeeded: 1, failed: 1, successRate: 0.5, durationP50Ms: 10 * 60 * 1000, durationP95Ms: 30 * 60 * 1000, queueWaitP50Ms: 5 * 60 * 1000, queueWaitP95Ms: 10 * 60 * 1000, averageCommentsGenerated: 4.5, averageCommentsPosted: 2 },
      '30d': { jobs: 2, succeeded: 1, failed: 1, successRate: 0.5, durationP50Ms: 10 * 60 * 1000, durationP95Ms: 30 * 60 * 1000, queueWaitP50Ms: 5 * 60 * 1000, queueWaitP95Ms: 10 * 60 * 1000, averageCommentsGenerated: 4.5, averageCommentsPosted: 2 },
    },
    dailyTrend: [
      { day: '2026-06-01', jobs: 2, succeeded: 1, failed: 1, stale: 1, skipped: 1, interrupted: 1, successRate: 0.5, averageCommentsGenerated: 4.5, averageCommentsPosted: 2 },
    ],
  };

  const html = renderMetricsPage({
    csrfToken: 'csrf',
    stats,
  });

  assert.match(html, /Duration p50/);
  assert.match(html, /10m 0s/);
  assert.match(html, /Duration p95/);
  assert.match(html, /30m 0s/);
  assert.match(html, /Queue wait p50/);
  assert.match(html, /5m 0s/);
  assert.match(html, /Queue wait p95/);
  assert.match(html, /Avg comments generated/);
  assert.match(html, /<td>4.5<\/td>/);
  assert.match(html, /Avg comments posted/);
  assert.match(html, /<td>2<\/td>/);
  assert.match(html, /Stale/);
  assert.match(html, /Skipped/);
  assert.match(html, /Interrupted/);
  assert.match(html, /Failure classification/);
  assert.match(html, /provider_unavailable/);
  assert.match(html, /Repository success rate/);
  assert.match(html, /alice\/repo/);
  assert.match(html, /50%/);
  assert.match(html, /Daily trend/);
  assert.match(html, /2026-06-01/);
});

test('service status renders actual listener port separately from configured port', async () => {
  const runtime = new AdminRuntime({
    configProvider: () => ({ version: 'test-version', port: 3007 }),
    listener: { address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 43123 }) },
  });

  const status = await runtime.serviceStatus({ running: null, queuedCount: 0, queued: [], diagnostics: [] });
  assert.equal(status.actualListeningPort, 43123);
  assert.equal(status.configuredPort, 3007);

  const html = renderDashboardPage({ csrfToken: 'csrf', summary: {}, recentJobs: [], diagnostics: [], serviceStatus: status });
  assert.match(html, /Port[\s\S]*43123/);
  assert.match(html, /data-i18n="word_configured">configured<\/span> 3007/);
});

test('job detail renders start-time config snapshot and auditable phase timeline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-dashboard-status-'));
  const eventsFile = path.join(dir, 'jobs', 'events.jsonl');
  const jobId = crypto.randomUUID();
  const events = [
    createJobEvent({ type: 'job.queued', jobId, timestamp: '2026-06-01T00:00:00.000Z', data: { repository: 'alice/repo', pullNumber: 7, queuedAt: '2026-06-01T00:00:00.000Z', progress: { phase: 'queued', message: 'Review job queued' } } }),
    createJobEvent({ type: 'job.started', jobId, timestamp: '2026-06-01T00:01:00.000Z', data: { startedAt: '2026-06-01T00:01:00.000Z', progress: { phase: 'github_auth', message: 'Authenticating GitHub App installation' } } }),
    createJobEvent({ type: 'job.progress', jobId, timestamp: '2026-06-01T00:02:00.000Z', data: { progress: { phase: 'ocr', message: 'Running OCR token=phase-secret-value' } } }),
    createJobEvent({ type: 'job.completed', jobId, timestamp: '2026-06-01T00:04:00.000Z', data: { status: 'succeeded', finishedAt: '2026-06-01T00:04:00.000Z', result: { outcome: 'succeeded', commentsGenerated: 3, commentsPosted: 2 } } }),
  ];
  await fs.mkdir(path.dirname(eventsFile), { recursive: true });
  await fs.writeFile(eventsFile, events.map(event => `${JSON.stringify(event)}\n`).join(''));

  const logger = new BoundedJobLogger({ adminDir: dir, maxBytes: 4096 });
  await logger.append(jobId, {
    timestamp: '2026-06-01T00:03:00.000Z',
    level: 'info',
    message: 'Publishing token=log-secret-value',
    fields: { phase: 'publishing', api_key: 'hidden-value' },
  });

  const startedJob = {
    id: jobId,
    diagnosticId: 'alice/repo#7@42',
    status: 'succeeded',
    queuedAt: '2026-06-01T00:00:00.000Z',
    startedAt: '2026-06-01T00:01:00.000Z',
    finishedAt: '2026-06-01T00:04:00.000Z',
    updatedAt: '2026-06-01T00:04:00.000Z',
    repository: { owner: 'alice', name: 'repo', fullName: 'alice/repo' },
    pullNumber: 7,
    actor: 'alice',
    progress: { phase: 'finished', message: 'Review job finished' },
    result: { outcome: 'succeeded', commentsGenerated: 3, commentsPosted: 2 },
    startSnapshot: {
      revision: 7,
      version: 'snapshot-version',
      port: 3008,
      settings: { ocrLlmModel: 'snapshot-model', ocrConcurrency: 3, OCR_LLM_TOKEN: 'snapshot-secret-token' },
    },
  };
  const eventStore = { filePath: eventsFile, replay: async () => emptyReplay([startedJob]) };
  const runtime = new AdminRuntime({
    eventStore,
    logger,
    configProvider: () => ({ version: 'current-version', port: 9999, ocrLlmModel: 'current-model' }),
  });

  const detail = await runtime.jobDetail(jobId);
  const html = renderJobDetailPage({ csrfToken: 'csrf', job: detail });

  assert.match(html, /Config revision[\s\S]*7/);
  assert.match(html, /snapshot-model/);
  assert.match(html, /ocrConcurrency[\s\S]*3/);
  assert.doesNotMatch(html, /current-model/);
  assert.doesNotMatch(html, /snapshot-secret-token/);
  assert.match(html, /Phase timeline/);
  assert.match(html, /Queued/);
  assert.match(html, /Started/);
  assert.match(html, /ocr/);
  assert.match(html, /publishing/);
  assert.match(html, /Completed/);
  assert.doesNotMatch(html, /phase-secret-value/);
  assert.doesNotMatch(html, /log-secret-value/);
  assert.doesNotMatch(html, /hidden-value/);
});

test('queue persists sanitized config snapshot captured at job start', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-admin-start-snapshot-'));
  const store = new JobEventStore({ adminDir: dir });
  let currentModel = 'queued-model';
  let releaseStart;
  const allowStart = new Promise(resolve => { releaseStart = resolve; });
  const queue = new AdminJobQueue({
    store,
    configProvider: async () => {
      await allowStart;
      return loadConfig({ ...env, ADMIN_DATA_DIR: dir, OCR_LLM_MODEL: currentModel });
    },
    startSnapshotProvider: ({ config }) => ({ revision: 12, settings: { ocrLlmModel: config.ocrEnv.OCR_LLM_MODEL, OCR_LLM_TOKEN: config.ocrEnv.OCR_LLM_TOKEN } }),
    handler: async (payload, { job }) => {
      job.headSha = 'abc123head';
      job.baseSha = 'def456base';
      job.baseRef = 'main';
      job.startSnapshot = { ...job.startSnapshot, headSha: job.headSha, baseSha: job.baseSha, baseRef: job.baseRef };
      return { outcome: 'succeeded' };
    },
  });

  await queue.enqueue({ key: 'alice/repo#9@10', payload: {}, metadata: { owner: 'alice', repo: 'repo', pullNumber: 9 } });
  currentModel = 'started-model';
  releaseStart();
  await queue.drain();
  const replayed = await store.replay({ force: true });
  assert.equal(replayed.jobs[0].startSnapshot.revision, 12);
  assert.equal(replayed.jobs[0].startSnapshot.settings.ocrLlmModel, 'started-model');
  assert.equal(replayed.jobs[0].startSnapshot.settings.OCR_LLM_TOKEN, '[REDACTED]');
  assert.equal(replayed.jobs[0].headSha, 'abc123head');
  assert.equal(replayed.jobs[0].baseSha, 'def456base');
  assert.equal(replayed.jobs[0].baseRef, 'main');
  assert.equal(replayed.jobs[0].startSnapshot.headSha, 'abc123head');
});

test('job detail expands reporting error and cleanup warning only when non-empty', () => {
  const filled = renderJobDetailPage({ csrfToken: 'csrf', job: { id: 'abc', repository: { fullName: 'alice/repo' }, result: { reportingError: { kind: 'github_api_error', reason: 'boom' }, cleanupWarning: 'workdir removal failed' } } });
  assert.match(filled, /<details class="card" open><summary><h2 data-i18n="jd_reporting_error"/);
  assert.match(filled, /<details class="card" open><summary><h2 data-i18n="jd_cleanup_warning"/);

  const empty = renderJobDetailPage({ csrfToken: 'csrf', job: { id: 'abc', repository: { fullName: 'alice/repo' }, result: {} } });
  assert.doesNotMatch(empty, /<details class="card" open>/);
});
