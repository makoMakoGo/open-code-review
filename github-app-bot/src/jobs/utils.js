import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_ADMIN_DATA_DIR = '/data/admin';
export const JOBS_DIR_NAME = 'jobs';
export const JOB_LOGS_DIR_NAME = 'logs';
export const STATS_DIR_NAME = 'stats';
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|credential|password|private[-_]?key|secret|session|token|api[-_]?key)/i;

export function createUuid() {
  return crypto.randomUUID();
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function assertUuid(value, name = 'uuid') {
  if (!isUuid(value)) throw new TypeError(`${name} must be a UUID`);
  return value.toLowerCase();
}

export function resolveJobsDir(adminDir = DEFAULT_ADMIN_DATA_DIR) {
  assertNonEmptyString(adminDir, 'adminDir');
  return path.join(adminDir, JOBS_DIR_NAME);
}

export function resolveEventsFile(adminDir = DEFAULT_ADMIN_DATA_DIR) {
  return path.join(resolveJobsDir(adminDir), 'events.jsonl');
}

export function resolveJobLogsDir(adminDir = DEFAULT_ADMIN_DATA_DIR) {
  return path.join(resolveJobsDir(adminDir), JOB_LOGS_DIR_NAME);
}

export function resolveStatsDir(adminDir = DEFAULT_ADMIN_DATA_DIR) {
  assertNonEmptyString(adminDir, 'adminDir');
  return path.join(adminDir, STATS_DIR_NAME);
}

export function resolveDailyStatsFile(adminDir = DEFAULT_ADMIN_DATA_DIR) {
  return path.join(resolveStatsDir(adminDir), 'daily-stats.jsonl');
}

export function normalizeIsoTimestamp(value = new Date(), name = 'timestamp') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return date.toISOString();
}

export function timestampMs(value, name = 'timestamp') {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new TypeError(`${name} must be a valid timestamp`);
  return ms;
}

export function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

export function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

export async function readUtf8IfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return '';
    throw error;
  }
}

export function serializeJsonLine(record) {
  const json = JSON.stringify(record);
  if (json === undefined) throw new TypeError('JSONL records must be serializable objects');
  return `${json}\n`;
}

export async function appendJsonLines(filePath, records) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (records.length === 0) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, 'a', 0o600);
  try {
    await handle.writeFile(records.map(record => serializeJsonLine(record)).join(''), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWriteFile(filePath, contents, { mode = 0o600 } = {}) {
  assertNonEmptyString(filePath, 'filePath');
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tempPath, 'w', mode);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
    await fsyncDirectory(dir);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function fsyncDirectory(dir) {
  let handle;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch (error) {
    if (error && (error.code === 'EINVAL' || error.code === 'EISDIR' || error.code === 'ENOTSUP')) return;
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export function parseJsonlText(text, { source = 'jsonl' } = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const records = [];
  const corruptions = [];
  let truncatedTail = null;
  if (text === '') return { records, corruptions, degraded: false, truncatedTail };

  const hasTrailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (hasTrailingNewline) lines.pop();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (line.trim() === '') continue;
    try {
      records.push({ lineNumber, value: JSON.parse(line) });
    } catch (error) {
      const isUnterminatedFinalLine = index === lines.length - 1 && !hasTrailingNewline;
      if (isUnterminatedFinalLine) {
        truncatedTail = { lineNumber, bytes: Buffer.byteLength(line, 'utf8'), source };
        break;
      }
      corruptions.push({ lineNumber, message: error.message, source });
    }
  }

  return { records, corruptions, degraded: corruptions.length > 0, truncatedTail };
}

export function jsonlFromRecords(records) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  return records.map(record => serializeJsonLine(record)).join('');
}

export function sanitizeForAdminStorage(value, options = {}) {
  const config = {
    maxArrayLength: options.maxArrayLength ?? 50,
    maxDepth: options.maxDepth ?? 6,
    maxObjectKeys: options.maxObjectKeys ?? 80,
    maxStringLength: options.maxStringLength ?? 4096,
  };
  return sanitizeValue(value, config, 0, new Set());
}

function sanitizeValue(value, config, depth, seen) {
  if (value == null) return value;
  if (typeof value === 'string') return redactSensitiveString(truncateString(value, config.maxStringLength));
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return `[${typeof value}]`;
  if (value instanceof Date) return normalizeIsoTimestamp(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveString(truncateString(value.message, config.maxStringLength)),
      stack: value.stack ? redactSensitiveString(truncateString(value.stack, config.maxStringLength)) : undefined,
    };
  }
  if (depth >= config.maxDepth) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = value.slice(0, config.maxArrayLength).map(item => sanitizeValue(item, config, depth + 1, seen));
      if (value.length > config.maxArrayLength) out.push(`[${value.length - config.maxArrayLength} more items]`);
      return out;
    }

    const out = {};
    const entries = Object.entries(value);
    const limit = Math.min(entries.length, config.maxObjectKeys);
    for (let index = 0; index < limit; index += 1) {
      const [key, item] = entries[index];
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeValue(item, config, depth + 1, seen);
    }
    if (entries.length > config.maxObjectKeys) out.__truncatedKeys = entries.length - config.maxObjectKeys;
    return out;
  } finally {
    seen.delete(value);
  }
}

export function truncateString(value, maxLength) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  assertPositiveInteger(maxLength, 'maxLength');
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

export function redactSensitiveString(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return value
    .replace(/(https?:\/\/[^:\s/@]+:)[^\s/@]+(@)/gi, '$1[REDACTED]$2')
    .replace(/([?&](?:api[-_]?key|apikey|token|secret|password)=)([^&#\s]+)/gi, '$1[REDACTED]')
    .replace(/\b(bearer|token|password|secret|api[-_]?key|apikey)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/\b(authorization)\s*:\s*([^\r\n]+(?:\r?\n[ \t]+[^\r\n]+)*)/gi, '$1: [REDACTED]')
    .replace(/\b(basic)\s+[A-Za-z0-9+/=]+(?:\r?\n[ \t]*[A-Za-z0-9+/=]+)*/gi, '$1 [REDACTED]');
}


export function toFiniteDurationMs(value, name = 'durationMs') {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`);
  return Math.round(value);
}
