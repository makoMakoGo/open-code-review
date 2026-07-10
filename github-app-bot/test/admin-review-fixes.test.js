import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
  AdminRuntime,
  createAdminRouter,
  deriveServiceHealth,
  renderConfigPage,
  renderDashboardPage,
  renderJobsPage,
  renderJobDetailPage,
} from '../src/admin/index.js';

function extractCsrfFromCookie(cookieHeader) {
  const match = String(cookieHeader).match(/(?:^|;\s*)ocr_admin_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function runApplyLangOnSettingsNav(html) {
  const match = html.match(/var I18N=(\{[\s\S]*?\});function dict\(\)/);
  assert.ok(match, 'expected I18N dict in body script');
  const i18n = JSON.parse(match[1]);
  const dict = i18n.en;
  assert.ok(dict, 'expected English dictionary');

  const anchors = [...html.matchAll(/<a class="settings-subnav-link[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => {
    const inner = m[1];
    const label = inner.match(/data-i18n="([^"]+)"[^>]*>([^<]*)</);
    const count = inner.match(/class="settings-count"[^>]*>([^<]*)</);
    assert.ok(label, 'expected leaf data-i18n label');
    assert.ok(count, 'expected settings-count span');
    return {
      key: label[1],
      labelText: label[2],
      countText: count[1],
    };
  });
  assert.ok(anchors.length > 0, 'expected settings subnav anchors');

  for (const anchor of anchors) {
    // Simulate applyLang leaf replacement: only the data-i18n node changes.
    const translated = dict[anchor.key];
    assert.equal(typeof translated, 'string');
    assert.notEqual(translated, '');
    // Count sibling must remain a pure number after init.
    assert.match(anchor.countText, /^\d+$/);
  }
}

test('deriveServiceHealth never reports healthy for missing or degraded signals', () => {
  assert.equal(deriveServiceHealth(null), 'unavailable');
  assert.equal(deriveServiceHealth(undefined), 'unavailable');
  assert.equal(deriveServiceHealth({}), 'unavailable');
  assert.equal(deriveServiceHealth({ storage: {}, diagnostics: {} }), 'unavailable');
  assert.equal(deriveServiceHealth({
    storage: { writable: false, degraded: false },
    diagnostics: { degraded: false, corruptEvents: 0, invalidEvents: 0, truncatedTail: false },
  }), 'unavailable');
  assert.equal(deriveServiceHealth({
    storage: { writable: true, degraded: true },
    diagnostics: { degraded: false, corruptEvents: 0, invalidEvents: 0, truncatedTail: false },
  }), 'degraded');
  assert.equal(deriveServiceHealth({
    storage: { writable: true, degraded: false },
    diagnostics: { degraded: true, corruptEvents: 0, invalidEvents: 0, truncatedTail: false },
  }), 'degraded');
  assert.equal(deriveServiceHealth({
    storage: { writable: true, degraded: false },
    diagnostics: { degraded: false, corruptEvents: 2, invalidEvents: 0, truncatedTail: false },
  }), 'degraded');
  assert.equal(deriveServiceHealth({
    storage: { writable: true, degraded: false },
    diagnostics: { degraded: false, corruptEvents: 0, invalidEvents: 0, truncatedTail: false },
  }), 'healthy');
});

test('AdminRuntime.serviceStatus emits degraded/unavailable from persistence and replay signals', async () => {
  const runtime = new AdminRuntime({
    configProvider: () => ({ version: 'test', port: 3007 }),
    listener: { address: () => ({ port: 3007 }) },
  });
  runtime.persistenceWarning = 'disk full';
  runtime.replay = { jobs: [], degraded: false, corruptions: [], invalidEvents: [], truncatedTail: null };
  const unavailable = await runtime.serviceStatus({ running: null, queuedCount: 0, queued: [], diagnostics: [] });
  assert.equal(unavailable.health, 'unavailable');
  assert.equal(unavailable.storage.writable, false);

  runtime.persistenceWarning = null;
  runtime.replay = { jobs: [], degraded: true, corruptions: [{ lineNumber: 1, message: 'bad' }], invalidEvents: [], truncatedTail: null };
  const degraded = await runtime.serviceStatus({ running: null, queuedCount: 0, queued: [], diagnostics: [] });
  assert.equal(degraded.health, 'degraded');
  assert.equal(degraded.storage.degraded, true);
});

test('dashboard health tile maps runtime health and is never optimistic Healthy', () => {
  const missing = renderDashboardPage({ csrfToken: 'csrf', summary: {}, diagnostics: [], serviceStatus: null });
  assert.match(missing, /data-i18n="health_unavailable"/);
  assert.doesNotMatch(missing, />Healthy</);

  const degraded = renderDashboardPage({
    csrfToken: 'csrf',
    summary: {},
    diagnostics: [],
    serviceStatus: {
      health: 'degraded',
      storage: { writable: true, degraded: true, dirSizeBytes: 1, budgetBytes: 10 },
      diagnostics: { degraded: true, corruptEvents: 1, invalidEvents: 0, truncatedTail: false },
      uptimeMs: 1000,
      startedAt: '2026-07-10T06:08:42.731Z',
    },
  });
  assert.match(degraded, /data-i18n="health_degraded"/);
  assert.doesNotMatch(degraded, />Healthy</);
  assert.match(degraded, /data-i18n="storage_writable"[\s\S]*data-i18n="storage_degraded"/);
});

test('succeeded_with_warnings keeps warning pill on last completed card', () => {
  const html = renderDashboardPage({
    csrfToken: 'csrf',
    summary: {},
    diagnostics: [],
    serviceStatus: {
      health: 'healthy',
      storage: { writable: true, degraded: false, dirSizeBytes: 1, budgetBytes: 10 },
      diagnostics: { degraded: false, corruptEvents: 0, invalidEvents: 0, truncatedTail: false },
      lastSuccess: {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'succeeded_with_warnings',
        repository: { fullName: 'alice/demo' },
        pullNumber: 3,
        actor: 'alice',
        diagnosticId: 'WARN1',
      },
    },
  });
  assert.match(html, /data-i18n="ss_last_completed"/);
  assert.match(html, /dpill warn/);
  assert.match(html, /data-i18n="pill_warnings"/);
  assert.match(html, /href="\/admin\/jobs\/11111111-1111-4111-8111-111111111111"/);
});

test('status activity cards link to job detail pages', () => {
  const html = renderDashboardPage({
    csrfToken: 'csrf',
    summary: { queued: 1, running: 1 },
    diagnostics: [],
    serviceStatus: {
      health: 'healthy',
      storage: { writable: true, degraded: false },
      diagnostics: { degraded: false, corruptEvents: 0, invalidEvents: 0, truncatedTail: false },
      running: {
        jobId: '22222222-2222-4222-8222-222222222222',
        status: 'running',
        repository: 'alice/web',
        pullNumber: 9,
        actor: 'bob',
      },
      queued: {
        count: 1,
        items: [{ jobId: '33333333-3333-4333-8333-333333333333', repository: 'alice/api' }],
      },
      lastFailure: {
        id: '44444444-4444-4444-8444-444444444444',
        status: 'failed',
        repository: { fullName: 'alice/api' },
        pullNumber: 1,
        actor: 'carol',
        diagnosticId: 'FL1',
      },
    },
  });
  assert.match(html, /href="\/admin\/jobs\/22222222-2222-4222-8222-222222222222"/);
  assert.match(html, /href="\/admin\/jobs\/33333333-3333-4333-8333-333333333333"/);
  assert.match(html, /href="\/admin\/jobs\/44444444-4444-4444-8444-444444444444"/);
});

test('jobs advanced filters expose all eight states', () => {
  const html = renderJobsPage({
    csrfToken: 'csrf',
    jobs: [],
    filters: {},
    pagination: { page: 1, totalPages: 1, total: 0, pageSize: 50, hasPrev: false, hasNext: false },
  });
  assert.match(html, /name="state"/);
  for (const state of ['succeeded', 'succeeded_with_warnings', 'failed', 'running', 'queued', 'interrupted', 'stale', 'skipped']) {
    assert.match(html, new RegExp(`option value="${state}"`));
  }
});

test('settings subnav keeps count after i18n init', () => {
  const html = renderConfigPage({
    csrfToken: 'csrf',
    adminRoot: '/tmp/admin',
    section: 'ocr',
    config: {
      revision: 1,
      fields: [
        { envKey: 'OCR_LLM_URL', name: 'ocrLlmUrl', label: 'OCR LLM URL', group: 'ocr', editable: true, value: 'http://x', effectiveValue: 'http://x' },
        { envKey: 'PORT', name: 'port', label: 'Port', group: 'service', editable: true, value: 3007, effectiveValue: 3007 },
      ],
    },
  });
  assert.match(html, /data-i18n="config_group_ocr"/);
  assert.match(html, /<span class="settings-count">1<\/span>/);
  assert.doesNotMatch(html, /<a class="settings-subnav-link[^"]*" href="\/admin\/config\?section=ocr" data-i18n="config_group_ocr">/);
  runApplyLangOnSettingsNav(html);
});

test('config POST redirects back to submitted section on success and error', async () => {
  let calls = 0;
  const router = createAdminRouter({
    adminPassword: 'a-secure-admin-password',
    allowedHosts: 'juya.011070.xyz',
    secureCookies: false,
    loadSecurityConfig: () => ({
      adminPassword: 'a-secure-admin-password',
      allowedHosts: 'juya.011070.xyz',
      trustProxy: false,
      cookieSecure: false,
      sessionTtlMs: 60 * 60 * 1000,
    }),
    loadDashboard: () => ({ summary: {}, diagnostics: [] }),
    loadConfig: () => ({ revision: 0, fields: [] }),
    saveConfig: () => {
      calls += 1;
      if (calls === 1) return { changedKeys: ['OCR_LLM_URL'] };
      throw new Error('save failed');
    },
  });
  const login = await router.route({
    method: 'POST',
    url: '/admin/login',
    headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz' },
    body: new URLSearchParams({ password: 'a-secure-admin-password' }).toString(),
  });
  const cookie = login.headers['set-cookie'].join('; ');
  const ok = await router.route({
    method: 'POST',
    url: '/admin/config',
    headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz', 'x-forwarded-proto': 'https', cookie },
    body: new URLSearchParams({
      _csrf: extractCsrfFromCookie(cookie),
      revision: '0',
      section: 'ocr',
    }).toString(),
  });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/admin/config?section=ocr');

  const failed = await router.route({
    method: 'POST',
    url: '/admin/config',
    headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz', 'x-forwarded-proto': 'https', cookie },
    body: new URLSearchParams({
      _csrf: extractCsrfFromCookie(cookie),
      revision: '0',
      section: 'admin',
    }).toString(),
  });
  assert.equal(failed.status, 303);
  assert.equal(failed.headers.location, '/admin/config?section=admin');

  const invalid = await router.route({
    method: 'POST',
    url: '/admin/config',
    headers: { host: 'juya.011070.xyz', origin: 'https://juya.011070.xyz', 'x-forwarded-proto': 'https', cookie },
    body: new URLSearchParams({
      _csrf: extractCsrfFromCookie(cookie),
      revision: '0',
      section: '../evil',
    }).toString(),
  });
  assert.equal(invalid.status, 303);
  assert.equal(invalid.headers.location, '/admin/config');
});

test('formatDate keeps seconds and UTC marker in job detail', () => {
  const html = renderJobDetailPage({
    csrfToken: 'csrf',
    job: {
      id: 'abc',
      repository: { fullName: 'alice/repo' },
      queuedAt: '2026-07-10T06:08:42.731Z',
      startedAt: '2026-07-10T06:09:01.000Z',
      finishedAt: '2026-07-10T06:10:15.500Z',
      phaseTimeline: [
        { timestamp: '2026-07-10T06:08:42.731Z', phase: 'queued', message: 'queued' },
        { timestamp: '2026-07-10T06:09:01.000Z', phase: 'ocr', message: 'running' },
      ],
      result: { outcome: 'succeeded' },
    },
  });
  assert.match(html, /2026-07-10 06:08:42 UTC/);
  assert.match(html, /2026-07-10 06:09:01 UTC/);
});

test('dark theme defines semantic status fills', () => {
  const html = renderDashboardPage({
    csrfToken: 'csrf',
    summary: {},
    diagnostics: [],
    serviceStatus: {
      health: 'healthy',
      storage: { writable: true, degraded: false },
      diagnostics: { degraded: false },
    },
  });
  assert.match(html, /:root\[data-theme="dark"\][\s\S]*--success-subtle:\s*[^;]+;/);
  assert.match(html, /:root\[data-theme="dark"\][\s\S]*--attention-subtle:\s*[^;]+;/);
  assert.match(html, /:root\[data-theme="dark"\][\s\S]*--danger-subtle:\s*[^;]+;/);
  assert.match(html, /:root\[data-theme="dark"\][\s\S]*--done-subtle:\s*[^;]+;/);
  assert.match(html, /:root\[data-theme="dark"\][\s\S]*--neutral-subtle:\s*[^;]+;/);
});
