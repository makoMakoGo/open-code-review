import { computeDurationMs, isTerminalStatus } from './model.js';
import { timestampMs } from './utils.js';

const WINDOWS = [
  ['24h', 24 * 60 * 60 * 1000],
  ['7d', 7 * 24 * 60 * 60 * 1000],
  ['30d', 30 * 24 * 60 * 60 * 1000],
];

export function computeJobStats(jobs, options = {}) {
  if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array');
  const nowMs = options.now == null ? Date.now() : timestampMs(options.now, 'now');
  const base = createEmptyStatsBucket();
  const windows = Object.fromEntries(WINDOWS.map(([name]) => [name, createEmptyStatsBucket()]));

  for (const job of jobs) {
    addJobToBucket(base, job);
    for (const [name, widthMs] of WINDOWS) {
      if (jobBelongsToWindow(job, nowMs, widthMs)) addJobToBucket(windows[name], job);
    }
  }

  finalizeBucket(base);
  for (const bucket of Object.values(windows)) finalizeBucket(bucket);
  return { total: base, windows };
}

export function computeRetentionPlan(jobs, options = {}) {
  if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array');
  const retentionDays = options.retentionDays ?? 30;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new TypeError('retentionDays must be a positive safe integer');
  const nowMs = options.now == null ? Date.now() : timestampMs(options.now, 'now');
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const removableJobIds = [];
  let active = 0;
  let retainedTerminal = 0;

  for (const job of jobs) {
    if (!isTerminalStatus(job.status)) {
      active += 1;
      continue;
    }
    const finishedAt = job.finishedAt ? timestampMs(job.finishedAt, 'finishedAt') : null;
    if (finishedAt != null && finishedAt < cutoffMs) removableJobIds.push(job.id);
    else retainedTerminal += 1;
  }

  return {
    retentionDays,
    cutoff: new Date(cutoffMs).toISOString(),
    removableJobIds,
    counts: {
      active,
      retainedTerminal,
      removableTerminal: removableJobIds.length,
    },
  };
}

export function summarizeQueue(jobs) {
  if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array');
  let queued = 0;
  let running = 0;
  let oldestQueuedAt = null;
  for (const job of jobs) {
    if (job.status === 'queued') {
      queued += 1;
      if (!oldestQueuedAt || timestampMs(job.queuedAt, 'queuedAt') < timestampMs(oldestQueuedAt, 'oldestQueuedAt')) oldestQueuedAt = job.queuedAt;
    } else if (job.status === 'running') {
      running += 1;
    }
  }
  return { queued, running, oldestQueuedAt };
}

function createEmptyStatsBucket() {
  return {
    jobs: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    terminal: 0,
    successRate: null,
    failureRate: null,
    totalDurationMs: 0,
    averageDurationMs: null,
    durationSamples: 0,
  };
}

function addJobToBucket(bucket, job) {
  bucket.jobs += 1;
  if (Object.hasOwn(bucket, job.status)) bucket[job.status] += 1;
  if (isTerminalStatus(job.status)) {
    bucket.terminal += 1;
    const duration = computeDurationMs(job);
    if (duration != null) {
      bucket.totalDurationMs += duration;
      bucket.durationSamples += 1;
    }
  }
}

function finalizeBucket(bucket) {
  if (bucket.terminal > 0) {
    bucket.successRate = bucket.succeeded / bucket.terminal;
    bucket.failureRate = bucket.failed / bucket.terminal;
  }
  if (bucket.durationSamples > 0) bucket.averageDurationMs = Math.round(bucket.totalDurationMs / bucket.durationSamples);
}

function jobBelongsToWindow(job, nowMs, widthMs) {
  const anchor = job.finishedAt ?? job.startedAt ?? job.queuedAt ?? job.updatedAt;
  return timestampMs(anchor, 'job window timestamp') >= nowMs - widthMs;
}
