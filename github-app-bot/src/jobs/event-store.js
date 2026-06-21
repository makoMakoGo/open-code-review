import fs from 'node:fs/promises';
import { appendJsonLines, assertUuid, atomicWriteFile, createUuid, jsonlFromRecords, normalizeIsoTimestamp, parseJsonlText, readUtf8IfExists, resolveEventsFile, sanitizeForAdminStorage, timestampMs } from './utils.js';
import { applyJobEvent, createJobSnapshotStore, isActiveStatus, isTerminalStatus } from './model.js';

const EVENT_TYPES = new Set([
  'job.queued',
  'job.started',
  'job.progress',
  'job.completed',
  'job.failed',
  'job.interrupted',
  'job.log',
]);

export class JobEventStore {
  constructor(options = {}) {
    this.filePath = options.filePath ?? resolveEventsFile(options.adminDir);
    this.writeChain = Promise.resolve();
    this.index = createJobSnapshotStore();
    this.loaded = false;
    this.fileSignature = null;
    this.replayDiagnostics = emptyReplayDiagnostics();
  }

  async append(event) {
    const [normalized] = await this.appendMany([event]);
    return normalized;
  }

  async appendMany(events) {
    if (!Array.isArray(events)) throw new TypeError('events must be an array');
    const normalized = events.map(event => createJobEvent(event));
    if (normalized.length === 0) return [];
    return this.#serializeWrite(async () => {
      if (!this.loaded || !(await signaturesMatch(this.filePath, this.fileSignature))) await this.#loadFromDisk();
      if (this.replayDiagnostics.truncatedTail) await this.#rewriteIndex();
      const preview = createJobSnapshotStore(this.index.snapshot());
      for (const event of normalized) applyJobEvent(preview, event);
      await appendJsonLines(this.filePath, normalized);
      this.index = preview;
      this.replayDiagnostics = { ...this.replayDiagnostics, degraded: this.replayDiagnostics.corruptions.length > 0 || this.replayDiagnostics.invalidEvents.length > 0 };
      this.fileSignature = await statSignature(this.filePath);
      return normalized;
    });
  }

  async replay(options = {}) {
    await this.writeChain;
    if (options.force || !this.loaded || !(await signaturesMatch(this.filePath, this.fileSignature))) {
      await this.#loadFromDisk();
    }

    let jobs = this.index.snapshot();
    if (options.pruneTerminalBefore) {
      const pruned = createJobSnapshotStore(jobs);
      pruned.pruneTerminalBefore(options.pruneTerminalBefore);
      jobs = pruned.snapshot();
    }

    return {
      jobs,
      degraded: this.replayDiagnostics.degraded,
      corruptions: [...this.replayDiagnostics.corruptions],
      invalidEvents: [...this.replayDiagnostics.invalidEvents],
      truncatedTail: this.replayDiagnostics.truncatedTail,
    };
  }

  async compact(options = {}) {
    const now = normalizeIsoTimestamp(options.now ?? new Date(), 'now');
    const terminalDetailsBefore = options.terminalDetailsBefore == null ? null : timestampMs(options.terminalDetailsBefore, 'terminalDetailsBefore');
    const terminalJobsBefore = options.terminalJobsBefore == null ? null : timestampMs(options.terminalJobsBefore, 'terminalJobsBefore');
    return this.#serializeWrite(async () => {
      await this.#loadFromDisk();
      const before = await statSignature(this.filePath);
      const jobs = this.index.snapshot();
      const { events, terminalDetailsCompacted, terminalJobsDropped } = compactJobsToEvents(jobs, { now, terminalDetailsBefore, terminalJobsBefore });
      await atomicWriteFile(this.filePath, jsonlFromRecords(events));
      await this.#loadFromDisk();
      const after = await statSignature(this.filePath);
      return {
        jobs: jobs.length,
        events: events.length,
        terminalDetailsCompacted,
        terminalJobsDropped,
        beforeBytes: before.size,
        afterBytes: after.size,
        bytesReclaimed: Math.max(0, before.size - after.size),
      };
    });
  }

  async snapshot(options = {}) {
    return this.replay(options);
  }

  diagnostics() {
    return {
      degraded: this.replayDiagnostics.degraded,
      corruptions: [...this.replayDiagnostics.corruptions],
      invalidEvents: [...this.replayDiagnostics.invalidEvents],
      truncatedTail: this.replayDiagnostics.truncatedTail,
    };
  }

  #serializeWrite(operation) {
    const run = this.writeChain.then(operation, operation);
    this.writeChain = run.catch(() => {});
    return run;
  }

  async #loadFromDisk() {
    const parsed = parseJsonlText(await readUtf8IfExists(this.filePath), { source: this.filePath });
    const store = createJobSnapshotStore();
    const invalidEvents = [];

    for (const record of parsed.records) {
      const validation = validateJobEvent(record.value);
      if (!validation.ok) {
        invalidEvents.push({ lineNumber: record.lineNumber, reason: validation.reason });
        continue;
      }
      try {
        applyJobEvent(store, record.value);
      } catch (error) {
        invalidEvents.push({ lineNumber: record.lineNumber, reason: error.message });
      }
    }

    this.index = store;
    this.loaded = true;
    this.fileSignature = await statSignature(this.filePath);
    this.replayDiagnostics = {
      degraded: parsed.degraded || invalidEvents.length > 0,
      corruptions: parsed.corruptions,
      invalidEvents,
      truncatedTail: parsed.truncatedTail,
    };
  }

  async #rewriteIndex() {
    const jobs = this.index.snapshot();
    const { events } = compactJobsToEvents(jobs, { now: new Date().toISOString(), terminalDetailsBefore: null, terminalJobsBefore: null });
    await atomicWriteFile(this.filePath, jsonlFromRecords(events));
    await this.#loadFromDisk();
  }
}

export function createJobEvent(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('event must be an object');
  const type = assertKnownEventType(input.type);
  const jobId = assertUuid(input.jobId, 'event.jobId');
  const id = input.id == null ? createUuid() : assertUuid(input.id, 'event.id');
  return {
    id,
    type,
    jobId,
    timestamp: normalizeIsoTimestamp(input.timestamp ?? new Date(), 'event.timestamp'),
    data: sanitizeJobEventData(type, input.data ?? {}),
  };
}

export function validateJobEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { ok: false, reason: 'event must be an object' };
  try {
    assertUuid(event.id, 'event.id');
  } catch {
    return { ok: false, reason: 'event.id must be a UUID' };
  }
  if (!EVENT_TYPES.has(event.type)) return { ok: false, reason: 'event.type is not supported' };
  try {
    assertUuid(event.jobId, 'event.jobId');
  } catch {
    return { ok: false, reason: 'event.jobId must be a UUID' };
  }
  if (typeof event.timestamp !== 'string' || Number.isNaN(new Date(event.timestamp).getTime())) return { ok: false, reason: 'event.timestamp must be an ISO timestamp' };
  if (event.data != null && (typeof event.data !== 'object' || Array.isArray(event.data))) return { ok: false, reason: 'event.data must be an object when present' };
  return { ok: true };
}

export function assertKnownEventType(type) {
  if (!EVENT_TYPES.has(type)) throw new TypeError(`unsupported job event type: ${type}`);
  return type;
}

export function jobEventTypes() {
  return Array.from(EVENT_TYPES);
}

async function statSignature(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { size: 0, mtimeMs: 0 };
    throw error;
  }
}

async function signaturesMatch(filePath, previous) {
  if (!previous) return false;
  const current = await statSignature(filePath);
  return current.size === previous.size && current.mtimeMs === previous.mtimeMs;
}

function emptyReplayDiagnostics() {
  return { degraded: false, corruptions: [], invalidEvents: [], truncatedTail: null };
}

function compactJobsToEvents(jobs, { now, terminalDetailsBefore, terminalJobsBefore = null }) {
  const events = [];
  let terminalDetailsCompacted = 0;
  let terminalJobsDropped = 0;
  const ordered = [...jobs].sort((left, right) => timestampMs(left.queuedAt, 'queuedAt') - timestampMs(right.queuedAt, 'queuedAt'));
  for (const job of ordered) {
    if (shouldDropTerminalJob(job, terminalJobsBefore)) {
      terminalJobsDropped += 1;
      continue;
    }
    const compactTerminalDetails = shouldCompactTerminalDetails(job, terminalDetailsBefore);
    if (compactTerminalDetails) terminalDetailsCompacted += 1;
    events.push(compactedEvent('job.queued', job.id, job.queuedAt, baseJobData(job)));
    if (job.startedAt || job.status === 'running' || isTerminalStatus(job.status)) {
      events.push(compactedEvent('job.started', job.id, job.startedAt ?? job.queuedAt, { startedAt: job.startedAt ?? job.queuedAt }));
    }
    if (isActiveStatus(job.status)) continue;
    events.push(compactedTerminalEvent(job, { now, compactTerminalDetails }));
  }
  return { events, terminalDetailsCompacted, terminalJobsDropped };
}

function shouldDropTerminalJob(job, terminalJobsBefore) {
  if (terminalJobsBefore == null || !isTerminalStatus(job.status) || !job.finishedAt) return false;
  return timestampMs(job.finishedAt, 'finishedAt') < terminalJobsBefore;
}

function shouldCompactTerminalDetails(job, terminalDetailsBefore) {
  if (terminalDetailsBefore == null || !isTerminalStatus(job.status) || !job.finishedAt) return false;
  return timestampMs(job.finishedAt, 'finishedAt') < terminalDetailsBefore;
}

function compactedTerminalEvent(job, { now, compactTerminalDetails }) {
  const timestamp = job.finishedAt ?? job.updatedAt ?? now;
  if (job.status === 'failed') {
    return compactedEvent('job.failed', job.id, timestamp, terminalJobData(job, { compactTerminalDetails }));
  }
  if (job.status === 'interrupted') {
    return compactedEvent('job.interrupted', job.id, timestamp, terminalJobData(job, { compactTerminalDetails, reason: job.errorMessage }));
  }
  return compactedEvent('job.completed', job.id, timestamp, terminalJobData(job, { compactTerminalDetails, status: job.status }));
}

function compactedEvent(type, jobId, timestamp, data) {
  return createJobEvent({ type, jobId, timestamp, data });
}

function baseJobData(job) {
  return {
    diagnosticId: job.diagnosticId,
    repository: job.repository,
    pullNumber: job.pullNumber,
    title: job.title,
    headSha: job.headSha,
    baseSha: job.baseSha,
    baseRef: job.baseRef,
    actor: job.actor,
    trigger: job.trigger,
    queuedAt: job.queuedAt,
    progress: job.progress,
    logCount: job.logCount,
    startSnapshot: job.startSnapshot,
  };
}

function terminalJobData(job, { compactTerminalDetails, status = job.status, reason = '' }) {
  const data = {
    ...baseJobData(job),
    status,
    finishedAt: job.finishedAt,
    conclusion: job.conclusion,
    errorKind: job.errorKind,
    errorMessage: compactTerminalDetails ? '' : job.errorMessage,
    result: compactTerminalDetails ? compactStructuredResult(job) : job.result,
    startSnapshot: job.startSnapshot,
  };
  if (reason && !compactTerminalDetails) data.reason = reason;
  return data;
}

function compactStructuredResult(job) {
  const result = job.result && typeof job.result === 'object' && !Array.isArray(job.result) ? job.result : null;
  const failure = result?.failure && typeof result.failure === 'object' && !Array.isArray(result.failure) ? result.failure : null;
  const compacted = { compacted: true, outcome: result?.outcome ?? job.status };
  if (job.errorKind || failure?.kind) compacted.failure = { kind: job.errorKind || failure.kind };
  if (Number.isFinite(result?.commentsGenerated)) compacted.commentsGenerated = result.commentsGenerated;
  if (Number.isFinite(result?.commentsPosted)) compacted.commentsPosted = result.commentsPosted;
  return compacted;
}

function sanitizeJobEventData(type, data) {
  if (type !== 'job.log') return sanitizeForAdminStorage(data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return typeof data.level === 'string' ? { level: sanitizeForAdminStorage(data.level, { maxStringLength: 32 }) } : {};
}
