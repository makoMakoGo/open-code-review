import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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

export class PendingEventWriteError extends Error {
  constructor(cause) {
    super(cause.message, { cause });
    this.name = 'PendingEventWriteError';
    this.eventRetained = true;
  }
}

export class JobEventStore {
  constructor(options = {}) {
    this.filePath = options.filePath ?? resolveEventsFile(options.adminDir);
    this.appendRecords = options.appendRecords ?? appendJsonLines;
    this.writeChain = Promise.resolve();
    this.index = createJobSnapshotStore();
    this.loaded = false;
    this.fileSignature = null;
    this.replayDiagnostics = emptyReplayDiagnostics();
    this.persistedEvents = new Map();
    this.pendingEvents = [];
    this.writeFailure = null;
    this.integrityFailures = new Map();
    this.maintenanceFailure = null;
  }

  async append(event) {
    const [normalized] = await this.appendMany([event]);
    return normalized;
  }

  async appendMany(events) {
    if (!Array.isArray(events)) throw new TypeError('events must be an array');
    const normalized = events.map(event => createJobEvent(event));
    if (normalized.length === 0) return [];
    return this.#serializeWrite(() => this.#appendNormalized(normalized));
  }

  async appendInterruptedJobs(jobs, { reason = 'process restarted before job completed' } = {}) {
    if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array');
    return this.#serializeWrite(async () => {
      const candidateIds = new Set(jobs.map(job => assertUuid(job.id, 'job.id')));
      const preview = this.#projectPendingForRecovery();
      const events = preview.snapshot()
        .filter(job => candidateIds.has(job.id) && isActiveStatus(job.status))
        .map(job => {
          const id = interruptedRecoveryEventId(job.id);
          const existing = this.pendingEvents.find(event => event.id === id) ?? this.persistedEvents.get(id);
          if (existing) return existing;
          return createJobEvent({ id, type: 'job.interrupted', jobId: job.id, timestamp: new Date(), data: { reason } });
        });
      if (events.length === 0) return [];
      return this.#appendNormalized(events);
    });
  }

  async flushPending() {
    return this.#serializeWrite(async () => {
      try {
        await this.#prepareForWrite();
      } catch (error) {
        if (this.pendingEvents.length > 0) this.writeFailure = error;
        throw error;
      }
      const preview = this.#createPendingPreview();
      try {
        await this.#flushPrepared(preview);
      } catch (error) {
        this.writeFailure = error;
        throw error;
      }
      return { pendingEventCount: this.pendingEvents.length };
    });
  }

  async replay(options = {}) {
    await this.writeChain;
    if (options.force || !this.loaded || !(await signaturesMatch(this.filePath, this.fileSignature))) {
      await this.#loadFromDisk();
      if (this.pendingEvents.length > 0) {
        try {
          this.#reconcilePendingEvents();
        } catch (error) {
          this.writeFailure = error;
          throw error;
        }
      }
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
      try {
        await this.#prepareForWrite();
        await this.#flushPrepared(this.#createPendingPreview());
        await this.#loadFromDisk();
        const before = await statSignature(this.filePath);
        const jobs = this.index.snapshot();
        const { events, terminalDetailsCompacted, terminalJobsDropped } = compactJobsToEvents(jobs, { now, terminalDetailsBefore, terminalJobsBefore });
        await atomicWriteFile(this.filePath, jsonlFromRecords(events));
        await this.#loadFromDisk();
        const after = await statSignature(this.filePath);
        this.maintenanceFailure = null;
        return {
          jobs: jobs.length,
          events: events.length,
          terminalDetailsCompacted,
          terminalJobsDropped,
          beforeBytes: before.size,
          afterBytes: after.size,
          bytesReclaimed: Math.max(0, before.size - after.size),
        };
      } catch (error) {
        if (!(error instanceof EventSemanticError)) this.maintenanceFailure = error;
        throw error;
      }
    });
  }

  async snapshot(options = {}) {
    return this.replay(options);
  }

  diagnostics() {
    const pendingEventCount = this.pendingEvents.length;
    const integrityFailureCount = this.integrityFailures.size;
    const integrityFailure = this.integrityFailures.values().next().value ?? null;
    const warnings = pendingEventCount === 0 && integrityFailureCount === 0 && !this.writeFailure && !this.maintenanceFailure ? [] : [{
      id: 'job-event-store',
      level: 'warn',
      message: pendingEventCount > 0
        ? `${pendingEventCount} admin job event${pendingEventCount === 1 ? '' : 's'} pending durable persistence.`
        : integrityFailureCount > 0
          ? `${integrityFailureCount} admin job event${integrityFailureCount === 1 ? '' : 's'} rejected during durable recovery.`
          : 'Admin job event store maintenance failed.',
      detail: this.writeFailure?.message ?? this.maintenanceFailure?.message ?? integrityFailure?.message ?? null,
      pendingEventCount,
      integrityFailureCount,
      affectsWritability: true,
    }];
    return {
      degraded: this.replayDiagnostics.degraded,
      corruptions: [...this.replayDiagnostics.corruptions],
      invalidEvents: [...this.replayDiagnostics.invalidEvents],
      truncatedTail: this.replayDiagnostics.truncatedTail,
      pendingEventCount,
      integrityFailureCount,
      writeFailure: this.writeFailure?.message ?? this.maintenanceFailure?.message ?? null,
      warnings,
    };
  }

  #serializeWrite(operation) {
    const run = this.writeChain.then(operation, operation);
    this.writeChain = run.catch(() => {});
    return run;
  }

  async #appendNormalized(normalized) {
    const additions = this.#stageEvents(normalized);
    this.#validateNewAdditions(additions);
    try {
      await this.#prepareForWrite();
    } catch (error) {
      if (error instanceof EventIdentityConflictError) {
        this.#removePendingEvents(additions);
        throw error;
      }
      this.writeFailure = error;
      throw retainedWriteError(error, additions, this.pendingEvents);
    }
    const additionIds = new Set(additions.map(event => eventIdentityKey(event.id)));
    try {
      const preview = this.#createPendingPreview(additionIds);
      await this.#flushPrepared(preview);
    } catch (error) {
      if (error instanceof EventSemanticError) {
        if (additionIds.has(eventIdentityKey(error.event.id))) {
          this.#removePendingEvents(additions);
          throw error;
        }
        throw retainedWriteError(error, additions, this.pendingEvents);
      }
      this.writeFailure = error;
      throw retainedWriteError(error, additions, this.pendingEvents);
    }
    return normalized;
  }

  async #prepareForWrite() {
    if (!this.loaded || this.pendingEvents.length > 0 || !(await signaturesMatch(this.filePath, this.fileSignature))) {
      await this.#loadFromDisk();
      this.#reconcilePendingEvents();
    }
    if (this.replayDiagnostics.truncatedTail) await this.#rewriteIndex();
  }

  #reconcilePendingEvents() {
    let persistedPrefix = 0;
    let missingSeen = false;
    for (const pending of this.pendingEvents) {
      const persisted = this.persistedEvents.get(eventIdentityKey(pending.id));
      if (!persisted) {
        missingSeen = true;
        continue;
      }
      assertSameEventIdContent(persisted, pending);
      if (missingSeen) throw new EventIdentityConflictError(`Persisted event ${pending.id} appears after an unpersisted outbox event`);
      persistedPrefix += 1;
    }
    if (persistedPrefix > 0) this.pendingEvents.splice(0, persistedPrefix);
    if (this.pendingEvents.length === 0) this.writeFailure = null;
  }

  #stageEvents(events) {
    const known = new Map(this.pendingEvents.map(event => [eventIdentityKey(event.id), event]));
    const additions = [];
    for (const event of events) {
      const key = eventIdentityKey(event.id);
      const pending = known.get(key);
      if (pending) {
        assertSameEventIdContent(pending, event);
        continue;
      }
      additions.push(event);
      known.set(key, event);
    }
    this.pendingEvents.push(...additions);
    return additions;
  }

  #validateNewAdditions(additions) {
    if (additions.length === 0) return;
    const additionIds = new Set(additions.map(event => eventIdentityKey(event.id)));
    const preview = createJobSnapshotStore(this.index.snapshot());
    for (const event of this.pendingEvents) {
      try {
        applyJobEvent(preview, event);
      } catch (error) {
        if (!additionIds.has(eventIdentityKey(event.id))) return;
        this.#removePendingEvents(additions);
        throw new EventSemanticError(event, error);
      }
    }
  }

  #createPendingPreview(additionIds = new Set()) {
    const preview = createJobSnapshotStore(this.index.snapshot());
    for (let index = 0; index < this.pendingEvents.length;) {
      const event = this.pendingEvents[index];
      const current = preview.get(event.jobId);
      if (isInterruptedRecoveryEvent(event) && current && !isActiveStatus(current.status)) {
        this.pendingEvents.splice(index, 1);
        continue;
      }
      try {
        applyJobEvent(preview, event);
      } catch (error) {
        this.pendingEvents.splice(index, 1);
        const semanticError = new EventSemanticError(event, error);
        if (!additionIds.has(eventIdentityKey(event.id))) {
          this.integrityFailures.set(eventIdentityKey(event.id), semanticError);
        }
        this.writeFailure = null;
        throw semanticError;
      }
      index += 1;
    }
    return preview;
  }

  #projectPendingForRecovery() {
    const preview = createJobSnapshotStore(this.index.snapshot());
    for (const event of this.pendingEvents) {
      const current = preview.get(event.jobId);
      if (isInterruptedRecoveryEvent(event) && current && !isActiveStatus(current.status)) continue;
      applyJobEvent(preview, event);
    }
    return preview;
  }

  #removePendingEvents(events) {
    if (events.length === 0) return;
    const ids = new Set(events.map(event => eventIdentityKey(event.id)));
    this.pendingEvents = this.pendingEvents.filter(event => !ids.has(eventIdentityKey(event.id)));
  }

  async #flushPrepared(preview) {
    if (this.pendingEvents.length === 0) return;
    const flushing = [...this.pendingEvents];
    await this.appendRecords(this.filePath, flushing);
    const signature = await statSignature(this.filePath);
    for (const event of flushing) this.persistedEvents.set(eventIdentityKey(event.id), event);
    for (const event of flushing) this.integrityFailures.delete(eventIdentityKey(event.id));
    this.pendingEvents.splice(0, flushing.length);
    this.index = preview;
    this.loaded = true;
    this.fileSignature = signature;
    this.writeFailure = null;
    this.replayDiagnostics = {
      ...this.replayDiagnostics,
      degraded: this.replayDiagnostics.corruptions.length > 0 || this.replayDiagnostics.invalidEvents.length > 0,
    };
  }

  async #loadFromDisk() {
    const parsed = parseJsonlText(await readUtf8IfExists(this.filePath), { source: this.filePath });
    const store = createJobSnapshotStore();
    const persistedEvents = new Map();
    const invalidEvents = [];

    for (const record of parsed.records) {
      const validation = validateJobEvent(record.value);
      if (!validation.ok) {
        invalidEvents.push({ lineNumber: record.lineNumber, reason: validation.reason });
        continue;
      }
      const event = createJobEvent(record.value);
      const key = eventIdentityKey(event.id);
      const persisted = persistedEvents.get(key);
      if (persisted) {
        if (!isDeepStrictEqual(persisted, event)) {
          invalidEvents.push({ lineNumber: record.lineNumber, reason: `event id ${event.id} conflicts with an earlier event` });
        }
        continue;
      }
      persistedEvents.set(key, event);
      try {
        applyJobEvent(store, event);
      } catch (error) {
        invalidEvents.push({ lineNumber: record.lineNumber, reason: error.message });
      }
    }

    this.index = store;
    this.persistedEvents = persistedEvents;
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
    try {
      await atomicWriteFile(this.filePath, jsonlFromRecords(events));
      await this.#loadFromDisk();
      this.maintenanceFailure = null;
    } catch (error) {
      this.maintenanceFailure = error;
      throw error;
    }
  }
}

function retainedWriteError(error, additions, pendingEvents) {
  const pendingIds = new Set(pendingEvents.map(event => eventIdentityKey(event.id)));
  return additions.some(event => pendingIds.has(eventIdentityKey(event.id))) ? new PendingEventWriteError(error) : error;
}

class EventIdentityConflictError extends Error {}

class EventSemanticError extends Error {
  constructor(event, cause) {
    super(cause.message, { cause });
    this.name = 'EventSemanticError';
    this.event = event;
  }
}

function eventIdentityKey(id) {
  return assertUuid(id, 'event.id');
}

function assertSameEventIdContent(existing, candidate) {
  if (!isDeepStrictEqual(existing, candidate)) {
    throw new EventIdentityConflictError(`Event id ${candidate.id} conflicts with different persisted content`);
  }
}

function isInterruptedRecoveryEvent(event) {
  return event.type === 'job.interrupted' && event.id === interruptedRecoveryEventId(event.jobId);
}

function interruptedRecoveryEventId(jobId) {
  const normalizedJobId = assertUuid(jobId, 'job.id');
  const bytes = createHash('sha256').update(`job.interrupted\0${normalizedJobId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
    for (const progress of compactedProgressEvents(job)) {
      events.push(compactedEvent('job.progress', job.id, progress.timestamp, { progress: progress.progress }));
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

function compactedProgressEvents(job) {
  const timeline = Array.isArray(job.phaseTimeline) ? job.phaseTimeline : [];
  return timeline
    .filter(item => item && item.type === 'job.progress' && item.timestamp && item.progress)
    .map(item => ({ timestamp: item.timestamp, progress: item.progress }));
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
    progress: { phase: 'queued', message: 'Review job queued', percent: null },
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
    progress: job.progress,
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
