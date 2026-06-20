import { verifyAdminPassword, LoginRateLimiter, isAdminEnabled } from './auth.js';
import { createHostGuard } from './hostguard.js';
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
import { renderConfigPage, renderDashboardPage, renderJobsPage, renderLoginPage } from './templates.js';

export class AdminRouter {
  constructor({
    adminPassword,
    allowedHosts = null,
    allowPrivateHosts = true,
    secureCookies = true,
    sessions = createSessionStore(),
    rateLimiter = new LoginRateLimiter(),
    loadDashboard = () => ({}),
    loadJobs = () => [],
    loadConfig = () => ({}),
    saveConfig = null,
    adminRoot = '/data/admin',
  } = {}) {
    this.adminPassword = adminPassword;
    this.enabled = isAdminEnabled(adminPassword);
    this.hostGuard = createHostGuard({ allowedHosts, allowPrivateNetworks: allowPrivateHosts });
    this.secureCookies = secureCookies;
    this.sessions = sessions;
    this.rateLimiter = rateLimiter;
    this.loadDashboard = loadDashboard;
    this.loadJobs = loadJobs;
    this.loadConfig = loadConfig;
    this.saveConfig = saveConfig;
    this.adminRoot = adminRoot;
  }

  async route(request) {
    const normalized = normalizeAdminRequest(request);
    const host = this.hostGuard(normalized.headers);
    if (!host.allowed) return forbidden('Forbidden host');

    if (!this.enabled) return notFound();

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
      const jobs = await this.loadJobs({ request: normalized, session });
      return htmlResponse(renderJobsPage({ csrfToken: session.csrfToken, jobs, filter: normalized.query.get('filter') ?? '' }));
    }

    if (normalized.pathname === '/admin/config') {
      if (normalized.method === 'GET') {
        const config = await this.loadConfig({ request: normalized, session });
        return htmlResponse(renderConfigPage({ csrfToken: session.csrfToken, config, adminRoot: this.adminRoot }));
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
    if (!verifyAdminPassword(password, this.adminPassword)) {
      this.rateLimiter.consumeFailure(key);
      return this.#loginPage(request, 'Invalid password.');
    }

    this.rateLimiter.reset(key);
    const session = this.sessions.create({ ip: key });
    return redirect('/admin/', {
      headers: buildSessionResponseHeaders(session, { secure: this.secureCookies }),
    });
  }

  async #logout(request) {
    const session = this.#requireSession(request);
    if (session) {
      const submittedToken = extractCsrfToken({ headers: request.headers, body: await readForm(request), query: request.query });
      if (!verifyCsrfToken(session, submittedToken)) return forbidden('Invalid CSRF token');
      this.sessions.destroy(session.id);
    }
    return redirect('/admin/login', {
      headers: {
        'set-cookie': [
          clearSessionCookie({ secure: this.secureCookies }),
          clearCsrfCookie({ secure: this.secureCookies }),
        ],
      },
    });
  }

  async #saveConfig(request, session) {
    if (typeof this.saveConfig !== 'function') return methodNotAllowed(['GET']);
    const form = await readForm(request);
    const submittedToken = extractCsrfToken({ headers: request.headers, body: form, query: request.query });
    if (!verifyCsrfToken(session, submittedToken)) return forbidden('Invalid CSRF token');
    await this.saveConfig({ request, session, form });
    return redirect('/admin/config');
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
  const forwardedFor = getHeader(request.headers, 'x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();
  return getHeader(request.headers, 'x-real-ip') ?? request.remoteAddress ?? 'unknown';
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
  const value = form instanceof Map ? form.get(name) : form.get(name);
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

export { htmlResponse, redirect, textResponse } from './security.js';
