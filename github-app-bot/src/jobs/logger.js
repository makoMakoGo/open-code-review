import fs from 'node:fs/promises';
import path from 'node:path';
import { appendJsonLines, assertPositiveInteger, assertUuid, atomicWriteFile, jsonlFromRecords, normalizeIsoTimestamp, parseJsonlText, readUtf8IfExists, redactSensitiveString, resolveJobLogsDir, sanitizeForAdminStorage, timestampMs } from './utils.js';

const DEFAULT_MAX_LOG_ENTRIES = 500;
const DEFAULT_MAX_MESSAGE_LENGTH = 8_192;
export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_TRUNCATED_MESSAGE = 'LOG_TRUNCATED';
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export class BoundedJobLogger {
  constructor(options = {}) {
    this.logsDir = options.logsDir ?? resolveJobLogsDir(options.adminDir);
    this.maxEntries = assertPositiveInteger(options.maxEntries ?? DEFAULT_MAX_LOG_ENTRIES, 'maxEntries');
    this.maxMessageLength = assertPositiveInteger(options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH, 'maxMessageLength');
    this.maxBytes = assertPositiveInteger(options.maxBytes ?? DEFAULT_MAX_LOG_BYTES, 'maxBytes');
    this.writeChains = new Map();
  }

  logPath(jobId) {
    const uuid = assertUuid(jobId, 'jobId');
    return path.join(this.logsDir, `${uuid}.jsonl`);
  }

  async append(jobId, entry) {
    const normalized = normalizeLogEntry(entry, { maxMessageLength: this.maxMessageLength });
    return this.#serialize(jobId, async () => {
      const filePath = this.logPath(jobId);
      await appendJsonLines(filePath, [normalized]);
      const compaction = await this.compact(jobId, { alreadySerialized: true });
      return compaction.truncated ? compaction.truncationEntry : normalized;
    });
  }

  async read(jobId, options = {}) {
    const filePath = this.logPath(jobId);
    const parsed = parseJsonlText(await readUtf8IfExists(filePath), { source: filePath });
    const entries = [];
    const invalidEntries = [];
    for (const record of parsed.records) {
      const validation = validateLogEntry(record.value);
      if (!validation.ok) {
        invalidEntries.push({ lineNumber: record.lineNumber, reason: validation.reason });
        continue;
      }
      entries.push(record.value);
    }
    const limit = options.limit == null ? entries.length : assertPositiveInteger(options.limit, 'limit');
    const offset = options.offset == null ? 0 : assertOffset(options.offset);
    return {
      entries: entries.slice(offset, offset + limit),
      total: entries.length,
      degraded: parsed.degraded || invalidEntries.length > 0,
      corruptions: parsed.corruptions,
      invalidEntries,
      truncatedTail: parsed.truncatedTail,
    };
  }

  async compact(jobId, options = {}) {
    const operation = async () => {
      const filePath = this.logPath(jobId);
      const parsed = parseJsonlText(await readUtf8IfExists(filePath), { source: filePath });
      const entries = [];
      for (const record of parsed.records) {
        if (validateLogEntry(record.value).ok) entries.push(record.value);
      }
      const cappedByCount = entries.slice(-this.maxEntries);
      const capped = capEntriesByBytes(cappedByCount, this.maxBytes);
      if (entries.length !== capped.entries.length || capped.truncated || parsed.degraded || parsed.truncatedTail) {
        await atomicWriteFile(filePath, jsonlFromRecords(capped.entries));
      }
      return {
        retained: capped.entries.length,
        dropped: entries.length - capped.entries.length,
        droppedForBytes: capped.droppedForBytes,
        truncated: capped.truncated,
        truncationEntry: capped.truncationEntry,
        degraded: parsed.degraded,
        truncatedTail: parsed.truncatedTail,
      };
    };
    return options.alreadySerialized ? operation() : this.#serialize(jobId, operation);
  }

  async delete(jobId) {
    await fs.rm(this.logPath(jobId), { force: true });
  }

  #serialize(jobId, operation) {
    const uuid = assertUuid(jobId, 'jobId');
    const previous = this.writeChains.get(uuid) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    this.writeChains.set(uuid, run.catch(() => {}));
    return run.finally(() => {
      if (this.writeChains.get(uuid) === run) this.writeChains.delete(uuid);
    });
  }
}

export function normalizeLogEntry(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('log entry must be an object');
  const level = input.level ?? 'info';
  if (!LOG_LEVELS.has(level)) throw new TypeError(`unsupported log level: ${level}`);
  const message = input.message == null ? '' : redactSensitiveString(String(input.message));
  const maxMessageLength = assertPositiveInteger(options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH, 'maxMessageLength');
  return {
    timestamp: normalizeIsoTimestamp(input.timestamp ?? new Date(), 'log.timestamp'),
    level,
    message: truncateMessage(message, maxMessageLength),
    fields: sanitizeForAdminStorage(input.fields ?? {}),
  };
}

export function validateLogEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'entry must be an object' };
  if (typeof entry.timestamp !== 'string' || Number.isNaN(new Date(entry.timestamp).getTime())) return { ok: false, reason: 'entry.timestamp must be an ISO timestamp' };
  if (!LOG_LEVELS.has(entry.level)) return { ok: false, reason: 'entry.level is not supported' };
  if (typeof entry.message !== 'string') return { ok: false, reason: 'entry.message must be a string' };
  if (entry.fields != null && (typeof entry.fields !== 'object' || Array.isArray(entry.fields))) return { ok: false, reason: 'entry.fields must be an object when present' };
  return { ok: true };
}

export async function pruneJobLogs(options = {}) {
  const logsDir = options.logsDir ?? resolveJobLogsDir(options.adminDir);
  const maxAgeMs = options.maxAgeMs == null ? null : assertPositiveInteger(options.maxAgeMs, 'maxAgeMs');
  const nowMs = options.now == null ? Date.now() : timestampMs(options.now, 'now');
  let removed = 0;
  let examined = 0;

  let entries;
  try {
    entries = await fs.readdir(logsDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { examined, removed };
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    examined += 1;
    const jobId = entry.name.slice(0, -'.jsonl'.length);
    if (!isUuidLikeForCleanup(jobId)) continue;
    const filePath = path.join(logsDir, entry.name);
    if (maxAgeMs != null) {
      const stat = await fs.stat(filePath);
      if (nowMs - stat.mtimeMs <= maxAgeMs) continue;
    }
    await fs.rm(filePath, { force: true });
    removed += 1;
  }
  return { examined, removed };
}

export function isLogTruncatedEntry(entry) {
  return Boolean(entry && entry.message === LOG_TRUNCATED_MESSAGE && entry.fields?.truncated === true);
}

export function logLevels() {
  return Array.from(LOG_LEVELS);
}

function truncateMessage(message, maxLength) {
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength)}...[truncated ${message.length - maxLength} chars]`;
}

function capEntriesByBytes(entries, maxBytes) {
  const existingTruncationIndex = entries.findIndex(isLogTruncatedEntry);
  if (existingTruncationIndex !== -1) {
    return capAlreadyTruncatedEntries(entries.slice(0, existingTruncationIndex + 1), maxBytes);
  }

  const output = [];
  let bytes = 0;
  let droppedForBytes = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const remainingAfterThis = entries.length - index - 1;
    const lineBytes = jsonLineBytes(entry);
    const marker = remainingAfterThis > 0 ? createTruncationEntry(remainingAfterThis, maxBytes) : null;
    const markerBytes = marker ? jsonLineBytes(marker) : 0;
    if (bytes + lineBytes + markerBytes > maxBytes) {
      droppedForBytes = entries.length - index;
      const truncationEntry = createTruncationEntry(droppedForBytes, maxBytes);
      while (output.length > 0 && bytes + jsonLineBytes(truncationEntry) > maxBytes) {
        bytes -= jsonLineBytes(output.pop());
        droppedForBytes += 1;
      }
      if (jsonLineBytes(truncationEntry) <= maxBytes) output.push(truncationEntry);
      return { entries: output, droppedForBytes, truncated: true, truncationEntry };
    }
    output.push(entry);
    bytes += lineBytes;
  }
  return { entries: output, droppedForBytes: 0, truncated: false, truncationEntry: null };
}

function capAlreadyTruncatedEntries(entries, maxBytes) {
  const truncationEntry = entries[entries.length - 1];
  let output = [...entries];
  let bytes = byteLengthOfEntries(output);
  let droppedForBytes = 0;
  while (output.length > 1 && bytes > maxBytes) {
    bytes -= jsonLineBytes(output.shift());
    droppedForBytes += 1;
  }
  if (bytes > maxBytes) output = [];
  return { entries: output, droppedForBytes, truncated: true, truncationEntry };
}

function createTruncationEntry(droppedEntries, maxBytes) {
  return normalizeLogEntry({
    level: 'warn',
    message: LOG_TRUNCATED_MESSAGE,
    fields: { truncated: true, droppedEntries, maxBytes },
  });
}

function byteLengthOfEntries(entries) {
  let total = 0;
  for (const entry of entries) total += jsonLineBytes(entry);
  return total;
}

function jsonLineBytes(entry) {
  return Buffer.byteLength(`${JSON.stringify(entry)}\n`, 'utf8');
}

function assertOffset(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('offset must be a non-negative safe integer');
  return value;
}

function isUuidLikeForCleanup(value) {
  try {
    assertUuid(value, 'jobId');
    return true;
  } catch {
    return false;
  }
}
