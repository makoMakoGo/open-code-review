import { appendJsonLines, assertUuid, createUuid, normalizeIsoTimestamp, parseJsonlText, readUtf8IfExists, resolveEventsFile, sanitizeForAdminStorage } from './utils.js';
import { applyJobEvent, createJobSnapshotStore } from './model.js';

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
  }

  async append(event) {
    await this.appendMany([event]);
  }

  async appendMany(events) {
    if (!Array.isArray(events)) throw new TypeError('events must be an array');
    const normalized = events.map(event => createJobEvent(event));
    await appendJsonLines(this.filePath, normalized);
  }

  async replay(options = {}) {
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

    if (options.pruneTerminalBefore) {
      store.pruneTerminalBefore(options.pruneTerminalBefore);
    }

    return {
      jobs: store.snapshot(),
      degraded: parsed.degraded || invalidEvents.length > 0,
      corruptions: parsed.corruptions,
      invalidEvents,
      truncatedTail: parsed.truncatedTail,
    };
  }
}

export function createJobEvent(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('event must be an object');
  const type = assertKnownEventType(input.type);
  const jobId = assertUuid(input.jobId, 'event.jobId');
  return {
    id: input.id ?? createUuid(),
    type,
    jobId,
    timestamp: normalizeIsoTimestamp(input.timestamp ?? new Date(), 'event.timestamp'),
    data: sanitizeForAdminStorage(input.data ?? {}),
  };
}

export function validateJobEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { ok: false, reason: 'event must be an object' };
  if (typeof event.id !== 'string' || event.id.length === 0) return { ok: false, reason: 'event.id must be a non-empty string' };
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
