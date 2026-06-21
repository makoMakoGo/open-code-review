import fs from 'node:fs/promises';

import { computeDurationMs, isTerminalStatus } from './model.js';
import { appendJsonLines, atomicWriteFile, jsonlFromRecords, parseJsonlText, readUtf8IfExists, resolveDailyStatsFile, timestampMs } from './utils.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS = [
  ['24h', DAY_MS],
  ['7d', 7 * DAY_MS],
  ['30d', 30 * DAY_MS],
];
const EXPENDABLE_ADMIN_FILES = new Set(['retention-state.json']);

export function computeJobStats(jobs, options = {}) {
  if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array');
  const nowMs = options.now == null ? Date.now() : timestampMs(options.now, 'now');
  const base = createEmptyStatsBucket();
  const windows = Object.fromEntries(WINDOWS.map(([name]) => [name, createEmptyStatsBucket()]));
  const daily = new Map();

  for (const job of jobs) {
    addJobToBucket(base, job);
    const day = dayKey(job.finishedAt ?? job.startedAt ?? job.queuedAt ?? job.updatedAt);
    if (!daily.has(day)) daily.set(day, createEmptyStatsBucket());
    addJobToBucket(daily.get(day), job);
    for (const [name, widthMs] of WINDOWS) {
      if (jobBelongsToWindow(job, nowMs, widthMs)) addJobToBucket(windows[name], job);
    }
  }

  finalizeBucket(base);
  for (const bucket of Object.values(windows)) finalizeBucket(bucket);
  const dailyTrend = Array.from(daily.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, bucket]) => ({ day, ...finalizeBucket(bucket) }));
  return { total: base, windows, dailyTrend };
}

export async function appendDailyStats(jobs, options = {}) {
  if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array');
  const filePath = options.filePath ?? resolveDailyStatsFile(options.adminDir);
  const records = dailyStatsRecords(jobs, options);
  if (records.length === 0) return { filePath, appended: 0 };
  await appendJsonLines(filePath, records);
  return { filePath, appended: records.length };
}

export async function readDailyStats(options = {}) {
  const filePath = options.filePath ?? resolveDailyStatsFile(options.adminDir);
  const parsed = parseJsonlText(await readUtf8IfExists(filePath), { source: filePath });
  const records = [];
  const invalidRecords = [];
  for (const record of parsed.records) {
    const validation = validateDailyStatsRecord(record.value);
    if (!validation.ok) {
      invalidRecords.push({ lineNumber: record.lineNumber, reason: validation.reason });
      continue;
    }
    records.push(record.value);
  }
  return {
    records,
    degraded: parsed.degraded || invalidRecords.length > 0,
    corruptions: parsed.corruptions,
    invalidRecords,
    truncatedTail: parsed.truncatedTail,
  };
}

export async function compactDailyStats(options = {}) {
  const filePath = options.filePath ?? resolveDailyStatsFile(options.adminDir);
  const retentionDays = positiveInteger(options.retentionDays ?? 365, 'retentionDays');
  const nowMs = options.now == null ? Date.now() : timestampMs(options.now, 'now');
  const cutoffDay = dayKey(nowMs - retentionDays * DAY_MS);
  const before = await fileSize(filePath);
  const loaded = await readDailyStats({ filePath });
  const byDay = new Map();
  for (const record of loaded.records) {
    if (record.day < cutoffDay) continue;
    byDay.set(record.day, record);
  }
  const retained = Array.from(byDay.values()).sort((left, right) => left.day.localeCompare(right.day));
  await atomicWriteFile(filePath, jsonlFromRecords(retained));
  const after = await fileSize(filePath);
  return { retained: retained.length, removed: loaded.records.length - retained.length, bytesReclaimed: Math.max(0, before - after), degraded: loaded.degraded };
}

export function dailyStatsRecords(jobs, options = {}) {
  if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array');
  const generatedAt = new Date(options.now == null ? Date.now() : timestampMs(options.now, 'now')).toISOString();
  const buckets = new Map();
  for (const job of jobs) {
    if (!isTerminalStatus(job.status)) continue;
    const day = dayKey(job.finishedAt ?? job.updatedAt ?? job.queuedAt);
    if (!buckets.has(day)) buckets.set(day, createEmptyStatsBucket());
    addJobToBucket(buckets.get(day), job);
  }
  return Array.from(buckets.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, bucket]) => ({ day, generatedAt, ...finalizeBucket(bucket) }));
}

export function computeRetentionPlan(jobs, options = {}) {
  if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array');
  const retentionDays = positiveInteger(options.retentionDays ?? options.jobHistoryRetentionDays ?? 90, 'retentionDays');
  const logRetentionDays = positiveInteger(options.logRetentionDays ?? options.jobLogRetentionDays ?? 14, 'logRetentionDays');
  const statsRetentionDays = positiveInteger(options.statsRetentionDays ?? 365, 'statsRetentionDays');
  const auditRetentionDays = positiveInteger(options.auditRetentionDays ?? options.configAuditRetentionDays ?? 365, 'auditRetentionDays');
  const nowMs = options.now == null ? Date.now() : timestampMs(options.now, 'now');
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  const logCutoffMs = nowMs - logRetentionDays * DAY_MS;
  const terminalDetailsCutoffMs = cutoffMs;
  const removableJobIds = [];
  const compactTerminalJobIds = [];
  const activeJobIds = [];
  let retainedTerminal = 0;

  for (const job of jobs) {
    if (!isTerminalStatus(job.status)) {
      activeJobIds.push(job.id);
      continue;
    }
    const finishedAt = job.finishedAt ? timestampMs(job.finishedAt, 'finishedAt') : null;
    if (finishedAt != null && finishedAt < cutoffMs) {
      compactTerminalJobIds.push(job.id);
      removableJobIds.push(job.id);
    } else {
      retainedTerminal += 1;
    }
  }

  return {
    retentionDays,
    logRetentionDays,
    statsRetentionDays,
    auditRetentionDays,
    cutoff: new Date(cutoffMs).toISOString(),
    logCutoff: new Date(logCutoffMs).toISOString(),
    terminalDetailsCutoff: new Date(terminalDetailsCutoffMs).toISOString(),
    removableJobIds,
    compactTerminalJobIds,
    activeJobIds,
    counts: {
      active: activeJobIds.length,
      retainedTerminal,
      removableTerminal: removableJobIds.length,
      compactTerminal: compactTerminalJobIds.length,
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

export function retentionDefaults(config = {}) {
  return {
    jobLogRetentionDays: positiveInteger(config.jobLogRetentionDays ?? 14, 'jobLogRetentionDays'),
    jobHistoryRetentionDays: positiveInteger(config.jobHistoryRetentionDays ?? 90, 'jobHistoryRetentionDays'),
    statsRetentionDays: positiveInteger(config.statsRetentionDays ?? 365, 'statsRetentionDays'),
    configAuditRetentionDays: positiveInteger(config.configAuditRetentionDays ?? 365, 'configAuditRetentionDays'),
    jobLogMaxBytes: positiveInteger(config.jobLogMaxBytes ?? 5 * 1024 * 1024, 'jobLogMaxBytes'),
    adminDataMaxBytes: config.adminDataMaxBytes == null ? null : positiveInteger(config.adminDataMaxBytes, 'adminDataMaxBytes'),
    retentionIntervalHours: positiveInteger(config.retentionIntervalHours ?? 24, 'retentionIntervalHours'),
  };
}

export function classifySoftCapCandidates(files, options = {}) {
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  const activeJobIds = new Set(options.activeJobIds ?? []);
  const terminalJobIds = new Set(options.terminalJobIds ?? []);
  return files
    .map(file => ({ ...file, priority: softCapPriority(file, { activeJobIds, terminalJobIds }) }))
    .filter(file => file.priority != null)
    .sort((left, right) => left.priority - right.priority || left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
}

function createEmptyStatsBucket() {
  return {
    jobs: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    succeeded_with_warnings: 0,
    failed: 0,
    stale: 0,
    skipped: 0,
    interrupted: 0,
    terminal: 0,
    successRate: null,
    failureRate: null,
    totalDurationMs: 0,
    averageDurationMs: null,
    durationP50Ms: null,
    durationP95Ms: null,
    queueWaitP50Ms: null,
    queueWaitP95Ms: null,
    averageQueueWaitMs: null,
    averageCommentsGenerated: null,
    averageCommentsPosted: null,
    durationSamples: 0,
    queueWaitSamples: 0,
    commentSamples: 0,
    failureKinds: {},
    repos: {},
    _durations: [],
    _queueWaits: [],
    _commentsGenerated: 0,
    _commentsPosted: 0,
  };
}

function addJobToBucket(bucket, job) {
  bucket.jobs += 1;
  if (Object.hasOwn(bucket, job.status)) bucket[job.status] += 1;
  const repo = job.repository?.fullName || 'unknown';
  bucket.repos[repo] = (bucket.repos[repo] ?? 0) + 1;
  const queueWait = computeQueueWaitMs(job);
  if (queueWait != null) {
    bucket._queueWaits.push(queueWait);
    bucket.queueWaitSamples += 1;
  }
  const comments = extractCommentStats(job);
  if (comments) {
    bucket._commentsGenerated += comments.generated;
    bucket._commentsPosted += comments.posted;
    bucket.commentSamples += 1;
  }
  if (isTerminalStatus(job.status)) {
    bucket.terminal += 1;
    const duration = computeDurationMs(job);
    if (duration != null) {
      bucket.totalDurationMs += duration;
      bucket.durationSamples += 1;
      bucket._durations.push(duration);
    }
    if (job.status === 'failed') {
      const kind = job.errorKind || 'unknown';
      bucket.failureKinds[kind] = (bucket.failureKinds[kind] ?? 0) + 1;
    }
  }
}

function finalizeBucket(bucket) {
  const successDenominator = bucket.succeeded + bucket.succeeded_with_warnings + bucket.failed;
  if (successDenominator > 0) {
    const successes = bucket.succeeded + bucket.succeeded_with_warnings;
    bucket.successRate = successes / successDenominator;
    bucket.failureRate = bucket.failed / successDenominator;
  }
  if (bucket.durationSamples > 0) {
    bucket.averageDurationMs = Math.round(bucket.totalDurationMs / bucket.durationSamples);
    bucket.durationP50Ms = percentile(bucket._durations, 0.5);
    bucket.durationP95Ms = percentile(bucket._durations, 0.95);
  }
  if (bucket.queueWaitSamples > 0) {
    bucket.averageQueueWaitMs = Math.round(sum(bucket._queueWaits) / bucket.queueWaitSamples);
    bucket.queueWaitP50Ms = percentile(bucket._queueWaits, 0.5);
    bucket.queueWaitP95Ms = percentile(bucket._queueWaits, 0.95);
  }
  if (bucket.commentSamples > 0) {
    bucket.averageCommentsGenerated = bucket._commentsGenerated / bucket.commentSamples;
    bucket.averageCommentsPosted = bucket._commentsPosted / bucket.commentSamples;
  }
  delete bucket._durations;
  delete bucket._queueWaits;
  delete bucket._commentsGenerated;
  delete bucket._commentsPosted;
  return bucket;
}

function jobBelongsToWindow(job, nowMs, widthMs) {
  const anchor = job.finishedAt ?? job.startedAt ?? job.queuedAt ?? job.updatedAt;
  return timestampMs(anchor, 'job window timestamp') >= nowMs - widthMs;
}

function computeQueueWaitMs(job) {
  if (!job.startedAt || !job.queuedAt) return null;
  return Math.max(0, timestampMs(job.startedAt, 'startedAt') - timestampMs(job.queuedAt, 'queuedAt'));
}

function extractCommentStats(job) {
  const result = job.result && typeof job.result === 'object' && !Array.isArray(job.result) ? job.result : null;
  if (!result) return null;
  const generated = Number.isFinite(result.commentsGenerated) ? result.commentsGenerated : 0;
  const posted = Number.isFinite(result.commentsPosted) ? result.commentsPosted : 0;
  if (!Number.isFinite(result.commentsGenerated) && !Number.isFinite(result.commentsPosted)) return null;
  return { generated, posted };
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function dayKey(value) {
  return new Date(timestampMs(value, 'day timestamp')).toISOString().slice(0, 10);
}

function validateDailyStatsRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, reason: 'record must be an object' };
  if (typeof record.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.day)) return { ok: false, reason: 'record.day must be YYYY-MM-DD' };
  if (!Number.isSafeInteger(record.jobs) || record.jobs < 0) return { ok: false, reason: 'record.jobs must be a non-negative integer' };
  return { ok: true };
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

async function fileSize(filePath) {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }
}

function softCapPriority(file, { activeJobIds, terminalJobIds }) {
  if (file.kind === 'job-log') {
    if (activeJobIds.has(file.jobId)) return null;
    return 10;
  }
  if (file.kind === 'terminal-job-detail') {
    if (!terminalJobIds.has(file.jobId)) return null;
    return 20;
  }
  if (file.kind === 'admin-data' && EXPENDABLE_ADMIN_FILES.has(file.name)) return 30;
  return null;
}
