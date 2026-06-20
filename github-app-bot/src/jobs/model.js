import { assertUuid, createUuid, normalizeIsoTimestamp, sanitizeForAdminStorage, timestampMs, toFiniteDurationMs } from './utils.js';

const ACTIVE_STATUSES = new Set(['queued', 'running']);
const TERMINAL_STATUSES = new Set(['succeeded', 'succeeded_with_warnings', 'failed', 'stale', 'skipped', 'interrupted']);
const STATUSES = new Set([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);

export function createJobSnapshot(input = {}) {
  const now = normalizeIsoTimestamp(input.createdAt ?? new Date(), 'createdAt');
  const id = assertUuid(input.id ?? input.jobId ?? createUuid(), 'job.id');
  const status = normalizeStatus(input.status ?? 'queued');
  return {
    id,
    diagnosticId: input.diagnosticId ? String(input.diagnosticId) : '',
    status,
    queuedAt: normalizeIsoTimestamp(input.queuedAt ?? now, 'queuedAt'),
    startedAt: input.startedAt ? normalizeIsoTimestamp(input.startedAt, 'startedAt') : null,
    finishedAt: input.finishedAt ? normalizeIsoTimestamp(input.finishedAt, 'finishedAt') : null,
    updatedAt: normalizeIsoTimestamp(input.updatedAt ?? now, 'updatedAt'),
    repository: normalizeRepository(input.repository),
    pullNumber: normalizeOptionalInteger(input.pullNumber, 'pullNumber'),
    title: sanitizeTextField(input.title, 'title'),
    headSha: sanitizeTextField(input.headSha, 'headSha'),
    baseSha: sanitizeTextField(input.baseSha, 'baseSha'),
    actor: sanitizeTextField(input.actor, 'actor'),
    trigger: sanitizeTextField(input.trigger, 'trigger'),
    progress: normalizeProgress(input.progress),
    conclusion: sanitizeTextField(input.conclusion, 'conclusion') || statusToConclusion(status),
    errorKind: sanitizeTextField(input.errorKind, 'errorKind'),
    errorMessage: sanitizeTextField(input.errorMessage, 'errorMessage'),
    result: sanitizeForAdminStorage(input.result ?? null),
    logCount: normalizeCount(input.logCount ?? 0, 'logCount'),
  };
}

export function createJobSnapshotStore(initialJobs = []) {
  return new JobSnapshotStore(initialJobs);
}

export class JobSnapshotStore {
  constructor(initialJobs = []) {
    this.jobs = new Map();
    for (const job of initialJobs) {
      const snapshot = createJobSnapshot(job);
      this.jobs.set(snapshot.id, snapshot);
    }
  }

  apply(event) {
    return applyJobEvent(this, event);
  }

  get(jobId) {
    return this.jobs.get(jobId) ?? null;
  }

  upsert(job) {
    const snapshot = createJobSnapshot(job);
    this.jobs.set(snapshot.id, snapshot);
    return snapshot;
  }

  update(jobId, updater) {
    const existing = this.jobs.get(jobId);
    if (!existing) throw new Error(`Cannot update unknown job ${jobId}`);
    const next = createJobSnapshot(updater({ ...existing }));
    if (next.id !== jobId) throw new Error('job id cannot change during update');
    this.jobs.set(jobId, next);
    return next;
  }

  delete(jobId) {
    return this.jobs.delete(jobId);
  }

  pruneTerminalBefore(cutoff) {
    const cutoffMs = timestampMs(cutoff, 'cutoff');
    let removed = 0;
    for (const [jobId, job] of this.jobs) {
      if (!isTerminalStatus(job.status) || !job.finishedAt) continue;
      if (timestampMs(job.finishedAt, 'finishedAt') < cutoffMs) {
        this.jobs.delete(jobId);
        removed += 1;
      }
    }
    return removed;
  }

  snapshot(options = {}) {
    const jobs = Array.from(this.jobs.values()).map(job => ({ ...job }));
    jobs.sort((left, right) => timestampMs(right.updatedAt, 'updatedAt') - timestampMs(left.updatedAt, 'updatedAt'));
    if (options.limit == null) return jobs;
    return jobs.slice(0, normalizeCount(options.limit, 'limit'));
  }

  queueSnapshot() {
    let queuedPosition = 0;
    return this.snapshot()
      .filter(job => ACTIVE_STATUSES.has(job.status))
      .sort(compareQueueOrder)
      .map(job => ({ ...job, queuePosition: job.status === 'queued' ? ++queuedPosition : 0 }));
  }
}

export function applyJobEvent(store, event) {
  if (!store || !(store.jobs instanceof Map)) throw new TypeError('store must be a JobSnapshotStore-like object');
  if (!event || typeof event !== 'object') throw new TypeError('event must be an object');
  const data = event.data ?? {};
  const timestamp = normalizeIsoTimestamp(event.timestamp, 'event.timestamp');

  if (event.type === 'job.queued') {
    const existing = store.jobs.get(event.jobId);
    store.jobs.set(event.jobId, createJobSnapshot({
      ...existing,
      ...data,
      id: event.jobId,
      status: 'queued',
      queuedAt: data.queuedAt ?? existing?.queuedAt ?? timestamp,
      updatedAt: timestamp,
    }));
    return store.jobs.get(event.jobId);
  }

  if (!store.jobs.has(event.jobId)) {
    store.jobs.set(event.jobId, createJobSnapshot({ id: event.jobId, status: 'queued', queuedAt: timestamp, updatedAt: timestamp }));
  }

  const current = store.jobs.get(event.jobId);
  if (event.type === 'job.started') {
    store.jobs.set(event.jobId, createJobSnapshot({
      ...current,
      ...data,
      status: 'running',
      startedAt: data.startedAt ?? current.startedAt ?? timestamp,
      updatedAt: timestamp,
    }));
    return store.jobs.get(event.jobId);
  }
  if (event.type === 'job.progress') {
    store.jobs.set(event.jobId, createJobSnapshot({
      ...current,
      progress: { ...current.progress, ...normalizeProgress(data.progress ?? data) },
      updatedAt: timestamp,
    }));
    return store.jobs.get(event.jobId);
  }
  if (event.type === 'job.completed') {
    const status = data.status ? normalizeStatus(data.status) : 'succeeded';
    const finishedAt = data.finishedAt ?? timestamp;
    store.jobs.set(event.jobId, createJobSnapshot({
      ...current,
      ...data,
      status,
      finishedAt,
      updatedAt: timestamp,
      conclusion: data.conclusion ?? statusToConclusion(status),
      result: data.result ?? current.result,
    }));
    return store.jobs.get(event.jobId);
  }
  if (event.type === 'job.failed') {
    store.jobs.set(event.jobId, createJobSnapshot({
      ...current,
      status: 'failed',
      finishedAt: data.finishedAt ?? timestamp,
      updatedAt: timestamp,
      conclusion: 'failure',
      errorKind: data.errorKind ?? data.kind ?? current.errorKind,
      errorMessage: data.errorMessage ?? data.message ?? current.errorMessage,
      result: data.result ?? current.result,
    }));
    return store.jobs.get(event.jobId);
  }
  if (event.type === 'job.interrupted') {
    store.jobs.set(event.jobId, createJobSnapshot({
      ...current,
      status: 'interrupted',
      finishedAt: data.finishedAt ?? timestamp,
      updatedAt: timestamp,
      conclusion: 'interrupted',
      errorMessage: data.reason ?? current.errorMessage,
    }));
    return store.jobs.get(event.jobId);
  }
  if (event.type === 'job.log') {
    store.jobs.set(event.jobId, createJobSnapshot({
      ...current,
      logCount: current.logCount + 1,
      updatedAt: timestamp,
    }));
    return store.jobs.get(event.jobId);
  }

  throw new TypeError(`unsupported job event type: ${event.type}`);
}

export function normalizeJobForQueue(input) {
  const job = createJobSnapshot(input);
  return {
    id: job.id,
    diagnosticId: job.diagnosticId,
    status: job.status,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    repository: job.repository,
    pullNumber: job.pullNumber,
    title: job.title,
    actor: job.actor,
    progress: job.progress,
  };
}

export function toPublicJobSnapshot(input) {
  const job = createJobSnapshot(input);
  return {
    id: job.id,
    diagnosticId: job.diagnosticId,
    status: job.status,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    updatedAt: job.updatedAt,
    repository: job.repository,
    pullNumber: job.pullNumber,
    title: job.title,
    headSha: job.headSha,
    baseSha: job.baseSha,
    actor: job.actor,
    trigger: job.trigger,
    progress: job.progress,
    conclusion: job.conclusion,
    errorKind: job.errorKind,
    errorMessage: job.errorMessage,
    result: job.result,
    logCount: job.logCount,
    durationMs: computeDurationMs(job),
  };
}

export function computeDurationMs(job) {
  const snapshot = createJobSnapshot(job);
  if (!snapshot.startedAt) return null;
  const end = snapshot.finishedAt ?? snapshot.updatedAt;
  return toFiniteDurationMs(timestampMs(end, 'durationEnd') - timestampMs(snapshot.startedAt, 'startedAt'));
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

export function normalizeStatus(status) {
  if (!STATUSES.has(status)) throw new TypeError(`unsupported job status: ${status}`);
  return status;
}

export function jobStatuses() {
  return Array.from(STATUSES);
}

function statusToConclusion(status) {
  if (status === 'succeeded' || status === 'succeeded_with_warnings') return 'success';
  if (status === 'skipped' || status === 'stale' || status === 'interrupted') return status;
  if (status === 'failed') return 'failure';
  return '';
}

function sanitizeTextField(value, name) {
  if (value == null || value === '') return '';
  const sanitized = sanitizeForAdminStorage(String(value));
  if (typeof sanitized !== 'string') throw new TypeError(`${name} must sanitize to a string`);
  return sanitized;
}

function normalizeRepository(repository) {
  if (repository == null || repository === '') return { owner: '', name: '', fullName: '' };
  if (typeof repository === 'string') {
    const sanitizedFullName = sanitizeTextField(repository, 'repository.fullName');
    const [owner = '', name = ''] = sanitizedFullName.split('/');
    return { owner, name, fullName: sanitizedFullName };
  }
  if (typeof repository !== 'object' || Array.isArray(repository)) throw new TypeError('repository must be a string or object');
  const owner = sanitizeTextField(repository.owner, 'repository.owner');
  const name = sanitizeTextField(repository.name, 'repository.name');
  const suppliedFullName = repository.fullName ?? repository.full_name;
  const fullName = suppliedFullName ? sanitizeTextField(suppliedFullName, 'repository.fullName') : (owner && name ? `${owner}/${name}` : '');
  return { owner, name, fullName };
}

function normalizeOptionalInteger(value, name) {
  if (value == null || value === '') return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function normalizeCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function normalizeProgress(progress) {
  if (progress == null || progress === '') return { phase: '', message: '', percent: null };
  if (typeof progress !== 'object' || Array.isArray(progress)) throw new TypeError('progress must be an object');
  const percent = progress.percent == null ? null : Number(progress.percent);
  if (percent != null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) throw new TypeError('progress.percent must be between 0 and 100');
  return {
    phase: sanitizeTextField(progress.phase, 'progress.phase'),
    message: sanitizeTextField(progress.message, 'progress.message'),
    percent,
  };
}

function compareQueueOrder(left, right) {
  if (left.status !== right.status) {
    if (left.status === 'running') return -1;
    if (right.status === 'running') return 1;
  }
  return timestampMs(left.queuedAt, 'queuedAt') - timestampMs(right.queuedAt, 'queuedAt');
}
