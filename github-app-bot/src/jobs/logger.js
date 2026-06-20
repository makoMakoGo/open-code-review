import fs from 'node:fs/promises';
import path from 'node:path';
import { appendJsonLines, assertPositiveInteger, assertUuid, atomicWriteFile, normalizeIsoTimestamp, parseJsonlText, readUtf8IfExists, redactSensitiveString, resolveJobLogsDir, sanitizeForAdminStorage, timestampMs } from './utils.js';

const DEFAULT_MAX_LOG_ENTRIES = 500;
const DEFAULT_MAX_MESSAGE_LENGTH = 8_192;
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export class BoundedJobLogger {
  constructor(options = {}) {
    this.logsDir = options.logsDir ?? resolveJobLogsDir(options.adminDir);
    this.maxEntries = assertPositiveInteger(options.maxEntries ?? DEFAULT_MAX_LOG_ENTRIES, 'maxEntries');
    this.maxMessageLength = assertPositiveInteger(options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH, 'maxMessageLength');
  }

  logPath(jobId) {
    const uuid = assertUuid(jobId, 'jobId');
    return path.join(this.logsDir, `${uuid}.jsonl`);
  }

  async append(jobId, entry) {
    const normalized = normalizeLogEntry(entry, { maxMessageLength: this.maxMessageLength });
    const filePath = this.logPath(jobId);
    await appendJsonLines(filePath, [normalized]);
    await this.compact(jobId);
    return normalized;
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

  async compact(jobId) {
    const filePath = this.logPath(jobId);
    const parsed = parseJsonlText(await readUtf8IfExists(filePath), { source: filePath });
    const entries = [];
    for (const record of parsed.records) {
      if (validateLogEntry(record.value).ok) entries.push(record.value);
    }
    const capped = entries.slice(-this.maxEntries);
    if (entries.length !== capped.length || parsed.degraded || parsed.truncatedTail) {
      await atomicWriteFile(filePath, capped.map(entry => `${JSON.stringify(entry)}\n`).join(''));
    }
    return { retained: capped.length, dropped: entries.length - capped.length, degraded: parsed.degraded, truncatedTail: parsed.truncatedTail };
  }

  async delete(jobId) {
    await fs.rm(this.logPath(jobId), { force: true });
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

export function logLevels() {
  return Array.from(LOG_LEVELS);
}

function truncateMessage(message, maxLength) {
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength)}...[truncated ${message.length - maxLength} chars]`;
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
