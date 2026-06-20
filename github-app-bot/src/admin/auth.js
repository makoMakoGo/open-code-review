import crypto from 'node:crypto';

const MIN_ADMIN_PASSWORD_LENGTH = 16;
const DEFAULT_ATTEMPT_LIMIT = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_LOCKOUT_MS = 15 * 60 * 1000;

export function isAdminEnabled(password) {
  return typeof password === 'string' && password.length >= MIN_ADMIN_PASSWORD_LENGTH;
}

export function assertAdminEnabled(password) {
  if (!isAdminEnabled(password)) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters to enable admin`);
  }
}

export function normalizeAdminPassword(password) {
  if (!isAdminEnabled(password)) return null;
  return password;
}

export function timingSafeEqualString(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualDigest = crypto.createHash('sha256').update(actual, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest) && Buffer.byteLength(actual, 'utf8') === Buffer.byteLength(expected, 'utf8');
}

export function verifyAdminPassword(candidate, adminPassword) {
  assertAdminEnabled(adminPassword);
  return timingSafeEqualString(candidate, adminPassword);
}

export class LoginRateLimiter {
  constructor({
    limit = DEFAULT_ATTEMPT_LIMIT,
    windowMs = DEFAULT_WINDOW_MS,
    lockoutMs = DEFAULT_LOCKOUT_MS,
    now = () => Date.now(),
  } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error('windowMs must be a positive integer');
    if (!Number.isSafeInteger(lockoutMs) || lockoutMs < 1) throw new Error('lockoutMs must be a positive integer');
    if (typeof now !== 'function') throw new Error('now must be a function');

    this.limit = limit;
    this.windowMs = windowMs;
    this.lockoutMs = lockoutMs;
    this.now = now;
    this.records = new Map();
  }

  status(key) {
    const id = normalizeRateLimitKey(key);
    const now = this.now();
    const record = this.#currentRecord(id, now);
    const locked = record.lockedUntil > now;
    return {
      allowed: !locked,
      attempts: record.attempts,
      remaining: locked ? 0 : Math.max(0, this.limit - record.attempts),
      retryAfterMs: locked ? record.lockedUntil - now : 0,
      lockedUntil: record.lockedUntil,
    };
  }

  consumeFailure(key) {
    const id = normalizeRateLimitKey(key);
    const now = this.now();
    const record = this.#currentRecord(id, now);

    if (record.lockedUntil > now) {
      this.records.set(id, record);
      return {
        allowed: false,
        attempts: record.attempts,
        remaining: 0,
        retryAfterMs: record.lockedUntil - now,
        lockedUntil: record.lockedUntil,
      };
    }

    record.attempts += 1;
    if (record.attempts >= this.limit) {
      record.lockedUntil = now + this.lockoutMs;
    }
    this.records.set(id, record);

    return {
      allowed: record.lockedUntil <= now,
      attempts: record.attempts,
      remaining: Math.max(0, this.limit - record.attempts),
      retryAfterMs: record.lockedUntil > now ? record.lockedUntil - now : 0,
      lockedUntil: record.lockedUntil,
    };
  }

  reset(key) {
    this.records.delete(normalizeRateLimitKey(key));
  }

  prune() {
    const now = this.now();
    for (const [id, record] of this.records) {
      if (record.windowStartedAt + this.windowMs <= now && record.lockedUntil <= now) {
        this.records.delete(id);
      }
    }
  }

  #currentRecord(id, now) {
    const existing = this.records.get(id);
    if (!existing || existing.windowStartedAt + this.windowMs <= now) {
      return { attempts: 0, windowStartedAt: now, lockedUntil: 0 };
    }
    return existing;
  }
}

export function normalizeRateLimitKey(key) {
  if (typeof key !== 'string' || key.trim() === '') return 'unknown';
  return key.trim().slice(0, 200);
}
