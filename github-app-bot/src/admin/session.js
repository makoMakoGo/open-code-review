import crypto from 'node:crypto';

const DEFAULT_SESSION_COOKIE_NAME = 'ocr_admin_session';
const DEFAULT_CSRF_COOKIE_NAME = 'ocr_admin_csrf';
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_ID_BYTES = 32;
const CSRF_BYTES = 32;

export function createSessionStore({ ttlMs = DEFAULT_SESSION_TTL_MS, now = () => Date.now() } = {}) {
  return new MemorySessionStore({ ttlMs, now });
}

export class MemorySessionStore {
  constructor({ ttlMs = DEFAULT_SESSION_TTL_MS, now = () => Date.now(), pruneLimit = 100 } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('ttlMs must be a positive integer');
    if (typeof now !== 'function') throw new Error('now must be a function');
    if (!Number.isSafeInteger(pruneLimit) || pruneLimit < 1) throw new Error('pruneLimit must be a positive integer');
    this.ttlMs = ttlMs;
    this.now = now;
    this.pruneLimit = pruneLimit;
    this.sessions = new Map();
  }

  create(metadata = {}, { ttlMs = this.ttlMs } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('ttlMs must be a positive integer');
    this.prune();
    const id = randomToken(SESSION_ID_BYTES);
    const now = this.now();
    const session = {
      id,
      csrfToken: randomToken(CSRF_BYTES),
      createdAt: now,
      expiresAt: now + ttlMs,
      metadata: sanitizeSessionMetadata(metadata),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    if (!isSafeToken(id)) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  rotateCsrf(id) {
    const session = this.get(id);
    if (!session) return null;
    const next = { ...session, csrfToken: randomToken(CSRF_BYTES) };
    this.sessions.set(id, next);
    return next;
  }

  destroy(id) {
    if (!isSafeToken(id)) return false;
    return this.sessions.delete(id);
  }

  prune({ maxDeletes = this.pruneLimit } = {}) {
    if (!Number.isSafeInteger(maxDeletes) || maxDeletes < 1) throw new Error('maxDeletes must be a positive integer');
    const now = this.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (removed >= maxDeletes) break;
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  setTtlMs(ttlMs) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('ttlMs must be a positive integer');
    this.ttlMs = ttlMs;
  }

  setFlash(id, flash) {
    const session = this.get(id);
    if (!session) return false;
    const next = { ...session, flash: sanitizeFlash(flash) };
    this.sessions.set(id, next);
    return true;
  }

  consumeFlash(id) {
    const session = this.get(id);
    if (!session || !session.flash) return null;
    const { flash } = session;
    const next = { ...session };
    delete next.flash;
    this.sessions.set(id, next);
    return flash;
  }
}

export function randomToken(bytes = 32) {
  if (!Number.isSafeInteger(bytes) || bytes < 16) throw new Error('bytes must be an integer >= 16');
  return crypto.randomBytes(bytes).toString('base64url');
}

export function isSafeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22,256}$/.test(value);
}

export function parseCookies(cookieHeader) {
  const cookies = new Map();
  if (typeof cookieHeader !== 'string' || cookieHeader.trim() === '') return cookies;

  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!isValidCookieName(name)) continue;
    cookies.set(name, decodeCookieValue(value));
  }
  return cookies;
}

export function readCookie(cookieHeader, name) {
  if (!isValidCookieName(name)) throw new Error('Invalid cookie name');
  return parseCookies(cookieHeader).get(name) ?? null;
}

export function getSessionIdFromCookie(cookieHeader, { cookieName = DEFAULT_SESSION_COOKIE_NAME } = {}) {
  const value = readCookie(cookieHeader, cookieName);
  return isSafeToken(value) ? value : null;
}

export function createSessionCookie(sessionId, {
  cookieName = DEFAULT_SESSION_COOKIE_NAME,
  maxAgeSeconds = Math.floor(DEFAULT_SESSION_TTL_MS / 1000),
  secure = true,
  path = '/admin/',
  sameSite = 'Strict',
} = {}) {
  if (!isSafeToken(sessionId)) throw new Error('Invalid session id');
  return serializeCookie(cookieName, sessionId, { httpOnly: true, secure, sameSite, path, maxAgeSeconds });
}

export function createCsrfCookie(csrfToken, {
  cookieName = DEFAULT_CSRF_COOKIE_NAME,
  maxAgeSeconds = Math.floor(DEFAULT_SESSION_TTL_MS / 1000),
  secure = true,
  path = '/admin/',
  sameSite = 'Strict',
} = {}) {
  if (!isSafeToken(csrfToken)) throw new Error('Invalid CSRF token');
  return serializeCookie(cookieName, csrfToken, { httpOnly: false, secure, sameSite, path, maxAgeSeconds });
}

export function clearSessionCookie({ cookieName = DEFAULT_SESSION_COOKIE_NAME, secure = true, path = '/admin/' } = {}) {
  return serializeCookie(cookieName, '', { httpOnly: true, secure, sameSite: 'Strict', path, maxAgeSeconds: 0 });
}

export function clearCsrfCookie({ cookieName = DEFAULT_CSRF_COOKIE_NAME, secure = true, path = '/admin/' } = {}) {
  return serializeCookie(cookieName, '', { httpOnly: false, secure, sameSite: 'Strict', path, maxAgeSeconds: 0 });
}

export function verifyCsrfToken(session, submittedToken) {
  if (!session || !isSafeToken(session.csrfToken) || !isSafeToken(submittedToken)) return false;
  const expected = Buffer.from(session.csrfToken, 'utf8');
  const actual = Buffer.from(submittedToken, 'utf8');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function extractCsrfToken({ headers = {}, body = null, query = null } = {}) {
  const headerToken = getHeader(headers, 'x-csrf-token');
  if (isSafeToken(headerToken)) return headerToken;
  const bodyToken = readField(body, '_csrf');
  if (isSafeToken(bodyToken)) return bodyToken;
  const queryToken = readField(query, '_csrf');
  if (isSafeToken(queryToken)) return queryToken;
  return null;
}

export function serializeCookie(name, value, {
  httpOnly = true,
  secure = true,
  sameSite = 'Lax',
  path = '/admin/',
  maxAgeSeconds = null,
} = {}) {
  if (!isValidCookieName(name)) throw new Error('Invalid cookie name');
  if (typeof value !== 'string') throw new Error('Cookie value must be a string');
  if (!['Strict', 'Lax', 'None'].includes(sameSite)) throw new Error('sameSite must be Strict, Lax, or None');
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Cookie path must start with /');

  const parts = [`${name}=${encodeCookieValue(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (maxAgeSeconds != null) {
    if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) throw new Error('maxAgeSeconds must be a non-negative integer');
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildSessionResponseHeaders(session, { secure = true, maxAgeSeconds = null } = {}) {
  if (!session || !isSafeToken(session.id) || !isSafeToken(session.csrfToken)) throw new Error('Invalid session');
  const ttlSeconds = maxAgeSeconds ?? Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  return {
    'set-cookie': [createSessionCookie(session.id, { secure, maxAgeSeconds: ttlSeconds }), createCsrfCookie(session.csrfToken, { secure, maxAgeSeconds: ttlSeconds })],
  };
}

function sanitizeSessionMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
    if (typeof value === 'string') clean[key] = value.slice(0, 256);
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean') clean[key] = value;
  }
  return clean;
}

function sanitizeFlash(flash) {
  if (!flash || typeof flash !== 'object' || Array.isArray(flash)) return null;
  const type = flash.type === 'success' ? 'success' : 'error';
  const message = typeof flash.message === 'string' ? flash.message.slice(0, 500) : '';
  if (message === '') return null;
  return { type, message };
}

function isValidCookieName(name) {
  return typeof name === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}

function encodeCookieValue(value) {
  return encodeURIComponent(value);
}

function decodeCookieValue(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function getHeader(headers, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    if (typeof value === 'string') return value;
  }
  return null;
}

function readField(source, name) {
  if (!source || typeof source !== 'object') return null;
  const value = source instanceof URLSearchParams || source instanceof Map ? source.get(name) : source[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}

export const sessionDefaults = Object.freeze({
  sessionCookieName: DEFAULT_SESSION_COOKIE_NAME,
  csrfCookieName: DEFAULT_CSRF_COOKIE_NAME,
  ttlMs: DEFAULT_SESSION_TTL_MS,
});
