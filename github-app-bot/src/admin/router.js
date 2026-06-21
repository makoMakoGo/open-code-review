import { verifyAdminPassword, LoginRateLimiter, isAdminEnabled } from './auth.js';
import { createHostGuard, normalizeHostHeader } from './hostguard.js';
import {
  createSessionStore,
  extractCsrfToken,
  getSessionIdFromCookie,
  verifyCsrfToken,
  buildSessionResponseHeaders,
  clearSessionCookie,
  clearCsrfCookie,
} from './session.js';
import { forbidden, htmlResponse, methodNotAllowed, notFound, redirect, textResponse } from './security.js';
import { renderConfigPage, renderDashboardPage, renderJobDetailPage, renderJobsPage, renderLoginPage } from './templates.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AdminRouter {
  constructor({
    adminPassword,
    allowedHosts = null,
    allowPrivateHosts = false,
    secureCookies = true,
    sessionTtlMs = 8 * 60 * 60 * 1000,
    sessions = createSessionStore({ ttlMs: sessionTtlMs }),
    rateLimiter = new LoginRateLimiter(),
    loadDashboard = () => ({}),
    loadJobs = () => [],
    loadJob = () => null,
    loadConfig = () => ({}),
    saveConfig = null,
    loadSecurityConfig = () => ({ adminPassword, allowedHosts, allowPrivateHosts, trustProxy: false, cookieSecure: secureCookies, sessionTtlMs }),
    adminRoot = '/data/admin',
  } = {}) {
    this.staticAdminPassword = adminPassword;
    this.staticEnabled = isAdminEnabled(adminPassword);
    this.staticAllowedHosts = allowedHosts;
    this.allowPrivateHosts = allowPrivateHosts;
    this.loadSecurityConfig = loadSecurityConfig;
    this.secureCookies = secureCookies;
    this.sessionTtlMs = sessionTtlMs;
    this.sessions = sessions;
    this.rateLimiter = rateLimiter;
    this.loadDashboard = loadDashboard;
    this.loadJobs = loadJobs;
    this.loadJob = loadJob;
    this.loadConfig = loadConfig;
    this.saveConfig = saveConfig;
    this.adminRoot = adminRoot;
  }

  async route(request) {
    const normalized = normalizeAdminRequest(request);
    const securityConfig = await this.#securityConfig();
    const hostGuard = createHostGuard({ allowedHosts: securityConfig.allowedHosts, allowPrivateNetworks: securityConfig.allowPrivateHosts });
    const host = hostGuard(normalized.headers);
    if (!host.allowed) return forbidden('Forbidden host');
    normalized.trustProxy = securityConfig.trustProxy;
    normalized.cookieSecure = securityConfig.cookieSecure;

    if (!securityConfig.enabled) return notFound();

    if (normalized.method === 'POST' && !hasSameOrigin(normalized, requestOriginHost(normalized.headers))) return forbidden('Invalid request origin');

    if (normalized.pathname !== '/admin' && !normalized.pathname.startsWith('/admin/')) return notFound();

    if (normalized.pathname === '/admin/login') {
      if (normalized.method === 'GET') return this.#loginPage(normalized, '');
      if (normalized.method === 'POST') return this.#login(normalized);
      return methodNotAllowed(['GET', 'POST']);
    }

    if (normalized.pathname === '/admin/logout') {
      if (normalized.method !== 'POST') return methodNotAllowed(['POST']);
      return this.#logout(normalized);
    }

    const session = this.#requireSession(normalized);
    if (!session) return redirect('/admin/login');

    if (normalized.pathname === '/admin/' || normalized.pathname === '/admin') {
      if (normalized.method !== 'GET') return methodNotAllowed(['GET']);
      const dashboard = await this.loadDashboard({ request: normalized, session });
      return htmlResponse(renderDashboardPage({ csrfToken: session.csrfToken, ...dashboard }));
    }

    if (normalized.pathname === '/admin/jobs') {
      if (normalized.method !== 'GET') return methodNotAllowed(['GET']);
      const jobsPage = await this.loadJobs({ request: normalized, session });
      return htmlResponse(renderJobsPage({ csrfToken: session.csrfToken, ...normalizeJobsPage(jobsPage, normalized) }));
    }

    const jobMatch = normalized.pathname.match(/^\/admin\/jobs\/([^/]+)$/);
    if (jobMatch) {
      if (normalized.method !== 'GET') return methodNotAllowed(['GET']);
      const jobId = jobMatch[1];
      if (!UUID_PATTERN.test(jobId)) return notFound();
      const job = await this.loadJob({ jobId, request: normalized, session });
      if (!job) return notFound();
      return htmlResponse(renderJobDetailPage({ csrfToken: session.csrfToken, job }));
    }

    if (normalized.pathname === '/admin/config') {
      if (normalized.method === 'GET') {
        const config = await this.loadConfig({ request: normalized, session });
        const flash = this.#consumeFlash(session);
        return htmlResponse(renderConfigPage({ csrfToken: session.csrfToken, config, adminRoot: this.adminRoot, flash }));
      }
      if (normalized.method === 'POST') return this.#saveConfig(normalized, session);
      return methodNotAllowed(['GET', 'POST']);
    }

    return notFound();
  }

  #loginPage(request, error) {
    const existingSession = this.#requireSession(request);
    const csrfToken = existingSession?.csrfToken ?? '';
    return htmlResponse(renderLoginPage({ csrfToken, error }));
  }

  async #login(request) {
    const key = clientRateLimitKey(request);
    const status = this.rateLimiter.status(key);
    if (!status.allowed) return this.#loginPage(request, 'Too many failed attempts. Try again later.');

    const form = await readForm(request);
    const password = getFormString(form, 'password');
    const securityConfig = await this.#securityConfig();
    if (!verifyAdminPassword(password, securityConfig.adminPassword)) {
      this.rateLimiter.consumeFailure(key);
      return this.#loginPage(request, 'Invalid password.');
    }

    this.rateLimiter.reset(key);
    const session = this.sessions.create({ ip: key }, { ttlMs: securityConfig.sessionTtlMs });
    return redirect('/admin/', {
      headers: buildSessionResponseHeaders(session, {
        secure: securityConfig.cookieSecure,
        maxAgeSeconds: Math.floor(securityConfig.sessionTtlMs / 1000),
      }),
    });
  }

  async #logout(request) {
    const session = this.#requireSession(request);
    if (session) {
      const submittedToken = extractCsrfToken({ headers: request.headers, body: await readForm(request), query: request.query });
      if (!verifyCsrfToken(session, submittedToken)) return forbidden('Invalid CSRF token');
      this.sessions.destroy(session.id);
    }
    const securityConfig = await this.#securityConfig();
    return redirect('/admin/login', {
      headers: {
        'set-cookie': [
          clearSessionCookie({ secure: securityConfig.cookieSecure }),
          clearCsrfCookie({ secure: securityConfig.cookieSecure }),
        ],
      },
    });
  }

  async #saveConfig(request, session) {
    if (typeof this.saveConfig !== 'function') return methodNotAllowed(['GET']);
    const form = await readForm(request);
    const submittedToken = extractCsrfToken({ headers: request.headers, body: form, query: request.query });
    if (!verifyCsrfToken(session, submittedToken)) return forbidden('Invalid CSRF token');
    try {
      const result = await this.saveConfig({
        request,
        session,
        form,
        expectedRevision: getFormString(form, 'revision'),
        clientAddress: clientRateLimitKey(request),
        currentHost: requestOriginHost(request.headers),
      });
      const changed = Array.isArray(result?.changedKeys) ? result.changedKeys : [];
      this.#setFlash(session, { type: 'success', message: changed.length === 0 ? 'Configuration unchanged.' : `Configuration saved (${changed.join(', ')}).` });
    } catch (error) {
      this.#setFlash(session, { type: 'error', message: error?.message ?? String(error) });
    }
    return redirect('/admin/config');
  }

  async #securityConfig() {
    const loaded = await this.loadSecurityConfig();
    const adminPassword = loaded?.adminPassword ?? this.staticAdminPassword;
    const sessionTtlMs = positiveInteger(loaded?.sessionTtlMs ?? loaded?.adminSessionTtlMs ?? this.sessionTtlMs, 'ADMIN_SESSION_TTL_HOURS');
    return {
      adminPassword,
      enabled: isAdminEnabled(adminPassword),
      allowedHosts: loaded?.allowedHosts ?? this.staticAllowedHosts,
      allowPrivateHosts: Boolean(loaded?.allowPrivateHosts ?? this.allowPrivateHosts),
      trustProxy: Boolean(loaded?.trustProxy),
      cookieSecure: Boolean(loaded?.cookieSecure ?? loaded?.adminCookieSecure ?? this.secureCookies),
      sessionTtlMs,
    };
  }

  #setFlash(session, flash) {
    if (this.sessions && typeof this.sessions.setFlash === 'function') this.sessions.setFlash(session.id, flash);
  }

  #consumeFlash(session) {
    if (this.sessions && typeof this.sessions.consumeFlash === 'function') return this.sessions.consumeFlash(session.id);
    return null;
  }

  #requireSession(request) {
    const sessionId = getSessionIdFromCookie(getHeader(request.headers, 'cookie'));
    if (!sessionId) return null;
    return this.sessions.get(sessionId);
  }
}

export function createAdminRouter(options) {
  return new AdminRouter(options);
}

export function normalizeAdminRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('request is required');
  const method = String(request.method ?? 'GET').toUpperCase();
  const headers = normalizeHeaders(request.headers ?? {});
  const url = new URL(request.url ?? '/admin/', 'http://admin.local');
  return {
    method,
    headers,
    url,
    pathname: url.pathname,
    query: url.searchParams,
    body: request.body ?? null,
    remoteAddress: typeof request.remoteAddress === 'string' ? request.remoteAddress : '',
  };
}

export async function readForm(request) {
  const body = request.body;
  if (body == null) return new Map();
  if (body instanceof URLSearchParams) return body;
  if (body instanceof Map) return body;
  if (typeof body === 'string') return new URLSearchParams(body);
  if (Buffer.isBuffer(body)) return new URLSearchParams(body.toString('utf8'));
  if (typeof body === 'object') return new Map(Object.entries(body));
  throw new Error('Unsupported form body');
}

export function clientRateLimitKey(request) {
  if (request.trustProxy) return getHeader(request.headers, 'x-real-ip') ?? request.remoteAddress ?? 'unknown';
  return request.remoteAddress ?? 'unknown';
}

function normalizeJobsPage(jobsPage, request) {
  if (Array.isArray(jobsPage)) {
    return { jobs: jobsPage, filters: queryFilters(request.query), pagination: null, validationMessages: [] };
  }
  if (!jobsPage || typeof jobsPage !== 'object') {
    return { jobs: [], filters: queryFilters(request.query), pagination: null, validationMessages: [] };
  }
  return {
    jobs: Array.isArray(jobsPage.jobs) ? jobsPage.jobs : [],
    filters: jobsPage.filters ?? queryFilters(request.query),
    pagination: jobsPage.pagination ?? null,
    validationMessages: Array.isArray(jobsPage.validationMessages) ? jobsPage.validationMessages : [],
  };
}

function queryFilters(query) {
  return {
    owner: query.get('owner') ?? '',
    repository: query.get('repository') ?? '',
    state: query.get('state') ?? query.get('outcome') ?? '',
    failureKind: query.get('failureKind') ?? query.get('failure_kind') ?? '',
    diagnosticId: query.get('diagnosticId') ?? query.get('diagnostic_id') ?? '',
    from: query.get('from') ?? query.get('queuedFrom') ?? '',
    to: query.get('to') ?? query.get('queuedTo') ?? '',
  };
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function hasSameOrigin(request, expectedHost) {
  const source = getHeader(request.headers, 'origin') ?? getHeader(request.headers, 'referer');
  if (!source) return false;
  if (source === 'null' && request.method === 'POST' && request.pathname === '/admin/login') return true;
  try {
    const url = new URL(source);
    const expectedProtocol = expectedOriginProtocol(request);
    if (url.protocol !== expectedProtocol) return false;
    return stripDefaultOriginPort(normalizeOriginHost(url.host), expectedProtocol) === stripDefaultOriginPort(expectedHost, expectedProtocol);
  } catch {
    return false;
  }
}

function normalizeOriginHost(host) {
  if (typeof host !== 'string' || host.trim() === '') return null;
  const raw = host.trim().toLowerCase();
  if (raw.startsWith('[')) return normalizeHostHeader(raw) ? raw : null;
  const colonCount = (raw.match(/:/g) ?? []).length;
  if (colonCount > 1) return normalizeHostHeader(raw) ? raw : null;
  const [hostName, port = ''] = raw.split(':');
  const normalizedHost = hostName.replace(/\.$/, '');
  const normalized = port === '' ? normalizedHost : `${normalizedHost}:${port}`;
  return normalizeHostHeader(normalized) ? normalized : null;
}

function stripDefaultOriginPort(host, protocol) {
  if (typeof host !== 'string') return host;
  const suffix = protocol === 'https:' ? ':443' : protocol === 'http:' ? ':80' : '';
  if (!suffix || !host.endsWith(suffix)) return host;
  if (host.startsWith('[') || (host.match(/:/g) ?? []).length === 1) return host.slice(0, -suffix.length);
  return host;
}

function requestOriginHost(headers) {
  return normalizeOriginHost(getHeader(headers, 'host'));
}

function expectedOriginProtocol(request) {
  if (request.trustProxy) {
    const forwardedProto = getHeader(request.headers, 'x-forwarded-proto');
    const proto = typeof forwardedProto === 'string' ? forwardedProto.split(',')[0].trim().toLowerCase() : '';
    if (proto === 'https') return 'https:';
    if (proto === 'http' && request.cookieSecure === false) return 'http:';
    return 'https:';
  }
  if (request.cookieSecure === false && isLoopbackOriginHost(requestOriginHost(request.headers))) return 'http:';
  return 'https:';
}

function isLoopbackOriginHost(host) {
  const normalized = normalizeHostHeader(host);
  if (!normalized) return false;
  if (normalized === 'localhost' || normalized === '::1') return true;
  const parts = normalized.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === 'string') return value;
  return null;
}

function getFormString(form, name) {
  const value = form.get(name);
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

export { htmlResponse, redirect, textResponse } from './security.js';
