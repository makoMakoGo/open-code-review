import { scriptTag } from './security.js';

const SECRET_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|PRIVATE|AUTH|KEY|WEBHOOK|LLM_PROXY|OCR_LLM)/i;

export function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case "'": return '&#39;';
      case '"': return '&quot;';
      default: return char;
    }
  });
}

export function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

export function safeText(value) {
  if (value == null) return '';
  return escapeHtml(value);
}

export function redactSecretValue(key, value) {
  if (isSecretKey(key)) return '••••••••';
  return redactInlineSecrets(value);
}

export function redactInlineSecrets(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ••••••••')
    .replace(/\b([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY|AUTHORIZATION|API[_-]?KEY)[A-Za-z0-9_.-]*)\s*[:=]\s*([^,\s<]+)/gi, '$1=••••••••');
}

export function isSecretKey(key) {
  return typeof key === 'string' && SECRET_KEY_PATTERN.test(key);
}

const NAV_ICONS = {
  dashboard: '<svg class="ic" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6.906.664a1.749 1.749 0 0 1 2.187 0l5.25 4.2c.415.332.657.835.657 1.367v7.019A1.75 1.75 0 0 1 13.25 15h-3.5a.75.75 0 0 1-.75-.75V9H7v5.25a.75.75 0 0 1-.75.75h-3.5A1.75 1.75 0 0 1 1 13.25V6.23c0-.531.242-1.034.657-1.366l5.25-4.2Zm1.25 1.171a.25.25 0 0 0-.312 0l-5.25 4.2a.25.25 0 0 0-.094.196v7.019c0 .138.112.25.25.25H5.5V8.25a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 .75.75v5.25h2.75a.25.25 0 0 0 .25-.25V6.23a.25.25 0 0 0-.094-.195Z"/></svg>',
  jobs: '<svg class="ic" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 1.75C2 .784 2.784 0 3.75 0h8.5C13.216 0 14 .784 14 1.75v12.5A1.75 1.75 0 0 1 12.25 16h-8.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25Zm2.5 3.5a.75.75 0 0 1 0-1.5h3.5a.75.75 0 0 1 0 1.5Zm0 3a.75.75 0 0 1 0-1.5h3.5a.75.75 0 0 1 0 1.5Zm0 3a.75.75 0 0 1 0-1.5h3.5a.75.75 0 0 1 0 1.5Z"/></svg>',
  metrics: '<svg class="ic" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 1.75V13.5h13.75a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75V1.75a.75.75 0 0 1 1.5 0Zm14.28 2.53-5.25 5.25a.75.75 0 0 1-1.06 0L7 7.06 4.28 9.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.25-3.25a.75.75 0 0 1 1.06 0L10 7.94l4.72-4.72a.75.75 0 0 1 1.06 1.06Z"/></svg>',
  config: '<svg class="ic" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0a1.5 1.5 0 0 1 1.478 1.227l.115.433a5.47 5.47 0 0 1 1.018.55l.4-.23a1.5 1.5 0 0 1 2.05.547l.5.866a1.5 1.5 0 0 1-.547 2.05l-.4.23c.09.336.148.686.17 1.046l.433.115a1.5 1.5 0 0 1 1.227 1.478v1a1.5 1.5 0 0 1-1.227 1.478l-.433.115a5.52 5.52 0 0 1-.55 1.018l.23.4a1.5 1.5 0 0 1-.547 2.05l-.866.5a1.5 1.5 0 0 1-2.05-.547l-.23-.4a5.47 5.47 0 0 1-1.018.17l-.115.433A1.5 1.5 0 0 1 8 16h-1a1.5 1.5 0 0 1-1.478-1.227l-.115-.433a5.47 5.47 0 0 1-1.018-.55l-.4.23a1.5 1.5 0 0 1-2.05-.547l-.5-.866a1.5 1.5 0 0 1 .547-2.05l.4-.23a5.52 5.52 0 0 1-.17-1.018l-.433-.115A1.5 1.5 0 0 1 0 8.5v-1a1.5 1.5 0 0 1 1.227-1.478l.433-.115c.022-.36.08-.71.17-1.046l-.4-.23a1.5 1.5 0 0 1 .547-2.05l.866-.5a1.5 1.5 0 0 1 2.05.547l.23.4c.332-.09.682-.148 1.042-.17l.115-.433A1.5 1.5 0 0 1 7 0ZM6.5 8a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Z"/></svg>',
};
// Keep nav 1:1 with real routes only.
const NAV_ITEMS = [
  ['dashboard', '/admin/', 'Status', NAV_ICONS.dashboard],
  ['jobs', '/admin/jobs', 'Jobs', NAV_ICONS.jobs],
  ['metrics', '/admin/metrics', 'Metrics', NAV_ICONS.metrics],
  ['config', '/admin/config', 'Settings', NAV_ICONS.config],
];

export function renderLayout({ title, active = 'dashboard', csrfToken = '', body, titleKey = '', cspNonce = '' }) {
  if (typeof title !== 'string' || title.trim() === '') throw new Error('title is required');
  if (typeof body !== 'string') throw new Error('body must be a string');
  const navItems = NAV_ITEMS.map(([key, href, label, icon]) => {
    const current = key === active;
    return `<a class="${current ? 'active' : ''}"${current ? ' aria-current="page"' : ''} href="${href}">${icon}<span class="nav-text" data-i18n="nav_${key}">${escapeHtml(label)}</span></a>`;
  }).join('');
  const logoutForm = csrfToken
    ? `<form class="signout" method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}"><button type="submit" data-i18n="signout">sign out</button></form>`
    : '';
  const titleAttr = titleKey ? ` data-i18n="${escapeAttribute(titleKey)}"` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Open Code Review Admin</title>
${fontLinks()}${themeInitScript(cspNonce)}<style>${baseStyles()}</style>
</head>
<body>
<a class="skip-link" href="#main" data-i18n="skip_to_main">Skip to main</a>
<div class="app">
  <aside class="side">
    <a class="brand" href="/admin/"><span class="mark">ocr</span><span class="brand-name">ocr-admin</span><span class="brand-tag" data-i18n="nav_brand_tag">self-hosted</span></a>
    <nav class="nav" aria-label="Sections" data-i18n-aria-label="aria_sections">${navItems}</nav>
    <div class="side-foot" data-i18n="nav_side_foot">Open Code Review</div>
  </aside>
  <div class="main">
    <header class="topbar">
      <div class="crumb"><span class="muted">ocr-admin</span><span class="sep" aria-hidden="true">/</span><span class="crumb-current"${titleAttr}>${escapeHtml(title)}</span></div>
      <div class="topbar-actions">${togglesHtml()}${logoutForm}</div>
    </header>
    <main id="main" class="content" tabindex="-1"><h1 class="page-title"${titleAttr}>${escapeHtml(title)}</h1>${body}</main>
  </div>
</div>
${bodyScript(cspNonce)}
</body>
</html>`;
}

export function renderLoginPage({ csrfToken = '', error = '', disabledReason = '', cspNonce = '' } = {}) {
  const disabled = disabledReason !== '';
  const message = disabled
    ? `<p class="alert">${escapeHtml(disabledReason)}</p>`
    : error ? `<p class="alert">${escapeHtml(error)}</p>` : '';
  const form = disabled ? '' : `<form method="post" action="/admin/login" class="login-form">
<label for="password" data-i18n="label_password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}">
<button type="submit" class="primary" data-i18n="sign_in">Sign in</button>
</form>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Open Code Review Admin</title>
${fontLinks()}${themeInitScript(cspNonce)}<style>${baseStyles()}</style>
</head>
<body class="login-body">
<div class="login-shell">
  <div class="login-toolbar">${togglesHtml()}</div>
  <main class="login-card">
    <div class="login-brand"><span class="mark">ocr</span><span class="login-brand-name">ocr-admin</span></div>
    <h1 class="login-title" data-i18n="login_title">Sign in</h1>
    <p class="login-sub muted" data-i18n="login_sub">Open Code Review admin console</p>
    ${message}${form}
  </main>
</div>
${bodyScript(cspNonce)}
</body>
</html>`;
}

export function renderDashboardPage({ csrfToken, summary = {}, diagnostics = [], serviceStatus = null, retention = null, cspNonce = '' } = {}) {
  const dash = (n) => escapeHtml(numberOrDash(n));
  const svc = serviceStatus && typeof serviceStatus === 'object' ? serviceStatus : null;
  const storage = svc?.storage && typeof svc.storage === 'object' ? svc.storage : {};
  const health = mapServiceHealth(svc?.health);

  const word = (key, fallback) => `<span data-i18n="${key}">${escapeHtml(fallback)}</span>`;
  const tiles = [
    { dot: health.dot, k: 'Health', kKey: 'tile_health', vHtml: word(health.labelKey, health.label) },
    {
      dot: Number(summary.running) > 0 ? 'run' : 'idle',
      k: 'Queue depth',
      kKey: 'tile_queue',
      vHtml: `${dash(summary.queued)} ${word('pill_queued', 'queued')} · ${dash(summary.running)} ${word('pill_running', 'running')}`,
    },
    {
      dot: Number(summary.failed) > 0 ? 'err' : 'ok',
      k: 'Reviewed',
      kKey: 'tile_reviewed',
      vHtml: `${dash(summary.succeeded)} ${word('word_ok', 'ok')} · ${dash(summary.failed)} ${word('pill_failed', 'failed')}`,
    },
    { dot: Number(summary.succeeded_with_warnings) > 0 ? 'warn' : 'idle', k: 'Warnings', kKey: 'tile_warnings', vHtml: dash(summary.succeeded_with_warnings) },
  ].map((t) => `<div class="st"><span class="k"><i class="dot ${t.dot}" aria-hidden="true"></i><span data-i18n="${t.kKey}">${escapeHtml(t.k)}</span></span><span class="v">${t.vHtml}</span></div>`).join('');

  const actualPort = svc?.actualListeningPort ?? svc?.listeningPort;
  const configuredPort = svc?.configuredPort ?? svc?.port;
  const pendingPort = svc?.desiredPendingPort ?? svc?.pendingPort;
  const portValue = (() => {
    const p = actualPort == null || actualPort === '' ? null : String(actualPort);
    if (p == null) return { value: '—', raw: false };
    if (pendingPort != null && pendingPort !== '') {
      return { value: `${escapeHtml(p)} → ${safeDisplay(pendingPort)}`, raw: true };
    }
    if (configuredPort != null && String(configuredPort) !== p) {
      return { value: `${escapeHtml(p)} (${word('word_configured', 'configured')} ${safeDisplay(configuredPort)})`, raw: true };
    }
    return { value: p, raw: false };
  })();
  const writableHtml = storage.writable === false
    ? word('storage_not_writable', 'not writable')
    : storage.writable === true
      ? word('storage_writable', 'writable')
      : word('storage_unknown', 'unknown');
  const storageHealthHtml = storage.degraded === true
    ? word('storage_degraded', 'degraded')
    : storage.degraded === false
      ? word('storage_healthy', 'healthy')
      : word('storage_unknown', 'unknown');
  const statusDiagnostics = svc?.diagnostics && typeof svc.diagnostics === 'object' ? svc.diagnostics : {};
  const diagnosticCountsHtml = [
    `${word('diag_corrupt', 'corrupt')} ${safeDisplay(statusDiagnostics.corruptEvents ?? 0)}`,
    `${word('diag_invalid', 'invalid')} ${safeDisplay(statusDiagnostics.invalidEvents ?? 0)}`,
    `${word('diag_truncated', 'truncated')} ${word(statusDiagnostics.truncatedTail ? 'word_yes' : 'word_no', statusDiagnostics.truncatedTail ? 'yes' : 'no')}`,
    `${word('diag_runtime_warnings', 'runtime warnings')} ${safeDisplay(statusDiagnostics.runtimeWarnings ?? 0)}`,
  ].join(', ');
  const statusGroups = [
    { label: 'Runtime', key: 'ssg_runtime', rows: [
      ['Uptime', formatDuration(svc?.uptimeMs), 'ss_uptime'],
      ['Started', formatDate(svc?.startedAt), 'ss_started'],
      ['Version', svc?.version, 'ss_version'],
      ['Config revision', svc?.configRevision, 'ss_config_revision'],
    ] },
    { label: 'Network', key: 'ssg_network', rows: [
      ['Port', portValue.value, 'ss_port', portValue.raw],
    ] },
    { label: 'Storage', key: 'ssg_storage', rows: [
      ['State', `${writableHtml} / ${storageHealthHtml}`, 'ss_storage_health', true],
      ['Usage', `${formatBytes(storage.sizeBytes ?? storage.dirSizeBytes)} / ${formatBytes(storage.budgetBytes)}`, 'ss_storage_size'],
      ['Last retention', formatDate(svc?.lastRetention?.finishedAt ?? svc?.lastRetention?.startedAt ?? retention?.lastRun?.finishedAt), 'ss_last_retention'],
    ] },
    { label: 'Diagnostics', key: 'ssg_diagnostics', rows: [
      ['Events', diagnosticCountsHtml, 'ss_diag_counts', true],
    ] },
  ];
  const statusDetails = statusGroups.map((g) => {
    const rows = g.rows.map(([label, value, key, raw = false]) => `<div class="kv"><span class="k" data-i18n="${key}">${escapeHtml(label)}</span><span class="v">${raw ? value : safeDisplay(value)}</span></div>`).join('');
    return `<div class="status-group"><div class="status-group-label" data-i18n="${g.key}">${escapeHtml(g.label)}</div>${rows}</div>`;
  }).join('');

  const running = svc?.runningJob || svc?.running || null;
  const runningBody = running
    ? `<div class="kv-list">
<div class="kv"><span class="k" data-i18n="th_repository">Repository</span><span class="v">${escapeHtml(formatRepository(running.repo ?? running.repository))}</span></div>
<div class="kv"><span class="k" data-i18n="th_pr">Pull request</span><span class="v">#${escapeHtml(String(running.pullNumber ?? running.pullRequest ?? '—'))}</span></div>
<div class="kv"><span class="k" data-i18n="th_actor">Actor</span><span class="v">${escapeHtml(running.actor ?? '—')}</span></div>
<div class="kv"><span class="k" data-i18n="th_status">Status</span><span class="v">${jobStatusPill('running')}</span></div>
<div class="kv"><span class="k" data-i18n="th_phase">Phase</span><span class="v"><code>${safeDisplay(running.phase ?? '—')}</code></span></div>
${jobIdRow(running)}
</div>`
    : `<p class="empty" data-i18n="empty_running">No running job.</p>`;

  const qitems = svc?.queued?.items ?? [];
  const queuedBody = qitems.length
    ? `<div class="qlist">${qitems.map((it) => `<div class="qrow">${jobStatusPill('queued')}<span class="repo">${escapeHtml(formatRepository(it.repository ?? it.repo))}</span>${jobIdCodeLink(it)}</div>`).join('')}</div>`
    : `<p class="empty">${dash(svc?.queued?.count ?? summary.queued)} ${word('pill_queued', 'queued')}.</p>`;

  const activityBox = (titleKey, title, body) => `<div class="box">
  <div class="box-header"><strong data-i18n="${titleKey}">${escapeHtml(title)}</strong></div>
  <div class="box-body">${body}</div>
</div>`;

  const sfBox = (job, titleKey, title) => job
    ? `<div class="box">
  <div class="box-header">
    <strong data-i18n="${titleKey}">${escapeHtml(title)}</strong>
    ${jobStatusPill(job.status)}
  </div>
  <div class="box-body">
    <div class="kv-list">
      <div class="kv"><span class="k" data-i18n="th_repository">Repository</span><span class="v">${escapeHtml(formatRepository(job.repo ?? job.repository))}</span></div>
      <div class="kv"><span class="k" data-i18n="th_pr">Pull request</span><span class="v">#${escapeHtml(String(job.pullNumber ?? '—'))}</span></div>
      <div class="kv"><span class="k" data-i18n="th_actor">Actor</span><span class="v">${escapeHtml(job.actor ?? '—')}</span></div>
      <div class="kv"><span class="k" data-i18n="th_diag">Diagnostic</span><span class="v"><code>${escapeHtml(job.diagnosticId ?? '—')}</code></span></div>
      ${jobIdRow(job)}
    </div>
  </div>
</div>`
    : '';
  const lastSuccessHtml = sfBox(svc?.lastSuccess, 'ss_last_completed', 'Last completed');
  const lastFailureHtml = sfBox(svc?.lastFailure, 'ss_last_failure', 'Last failure');
  const sflHtml = `${lastSuccessHtml}${lastFailureHtml}`;

  const body = `<div class="dashboard">
<div class="page-header">
  <p class="page-desc muted" data-i18n="overview_page_desc">Service health, queue, and current activity.</p>
  <a class="page-header-link" href="/admin/metrics" data-i18n="btn_view_metrics">Open metrics →</a>
</div>
<div class="sect">
  <h2 class="vh" data-i18n="h2_overview">Service status</h2>
  <div class="status-grid">${tiles}</div>
  <div class="status-details">${statusDetails}</div>
</div>
<div class="sect">
  <div class="box-grid twocol">
    ${activityBox('ss_running_job', 'Current running job', runningBody)}
    ${activityBox('ss_queued', 'Queued', queuedBody)}
  </div>
</div>
${sflHtml ? `<div class="sect"><div class="box-grid sfl">${sflHtml}</div></div>` : ''}
${Array.isArray(diagnostics) && diagnostics.length ? `<div class="sect"><div class="box"><div class="box-header"><strong data-i18n="h2_diagnostics">Diagnostics</strong></div><div class="box-body">${renderDiagnosticsList(diagnostics)}</div></div></div>` : ''}
</div>`;
  return renderLayout({ title: 'Status', active: 'dashboard', csrfToken, body, titleKey: 'page_dashboard', cspNonce });
}

export function renderMetricsPage({ csrfToken, stats = null, metrics = null, cspNonce = '' } = {}) {
  const mstats = stats || metrics || {};
  const total = mstats.total || {};
  const windows = mstats.windows || {};

  const metricTiles = [
    { k: 'Duration p50', v: formatDuration(total.durationP50Ms), key: 'm_dur_p50' },
    { k: 'Duration p95', v: formatDuration(total.durationP95Ms), key: 'm_dur_p95' },
    { k: 'Queue wait p50', v: formatDuration(total.queueWaitP50Ms), key: 'm_qw_p50' },
    { k: 'Queue wait p95', v: formatDuration(total.queueWaitP95Ms), key: 'm_qw_p95' },
    { k: 'Avg comments generated', v: numberOrDash(total.averageCommentsGenerated ?? total.avgCommentsGenerated), key: 'm_avg_gen' },
    { k: 'Avg comments posted', v: numberOrDash(total.averageCommentsPosted ?? total.avgCommentsPosted), key: 'm_avg_post' },
    { k: 'Stale', v: numberOrDash(total.stale), key: 'm_stale' },
    { k: 'Skipped', v: numberOrDash(total.skipped), key: 'm_skipped' },
    { k: 'Interrupted', v: numberOrDash(total.interrupted), key: 'm_interrupted' },
  ].map((t) => `<div class="dmetric"><div class="k" data-i18n="${t.key}">${escapeHtml(t.k)}</div><div class="v">${safeDisplay(t.v)}</div></div>`).join('');

  const failureKinds = Object.entries(total.failureKinds || {});
  const failureHtml = failureKinds.length
    ? `<div class="table-scroll"><table class="gh-table"><thead><tr><th data-i18n="m_fail_class">Failure classification</th><th data-i18n="th_jobs">Jobs</th></tr></thead><tbody>${failureKinds.map(([kind, count]) => `<tr><th scope="row">${safeDisplay(kind)}</th><td>${safeDisplay(count)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty" data-i18n="empty_none">None.</p>';

  const repos = Object.entries(total.repositories || {});
  const repoHtml = repos.length
    ? `<div class="table-scroll"><table class="gh-table"><thead><tr><th data-i18n="m_repo_rate">Repository success rate</th><th data-i18n="th_jobs">Jobs</th><th data-i18n="th_success_rate">Success rate</th></tr></thead><tbody>${repos.map(([name, info]) => `<tr><th scope="row">${safeDisplay(name)}</th><td>${safeDisplay(info.jobs)}</td><td>${safeDisplay(formatPercent(info.successRate))}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty" data-i18n="empty_none">None.</p>';

  const daily = Array.isArray(mstats.dailyTrend) ? mstats.dailyTrend : [];
  const dailyHtml = daily.length
    ? `<div class="table-scroll"><table class="gh-table"><thead><tr><th data-i18n="th_day">Day</th><th data-i18n="th_jobs">Jobs</th><th data-i18n="th_success_rate">Success rate</th><th data-i18n="m_avg_gen">Avg comments generated</th><th data-i18n="m_avg_post">Avg comments posted</th><th data-i18n="m_stale">Stale</th><th data-i18n="m_skipped">Skipped</th><th data-i18n="m_interrupted">Interrupted</th></tr></thead><tbody>${daily.map((day) => `<tr><th scope="row">${safeDisplay(day.day)}</th><td>${safeDisplay(numberOrDash(day.jobs))}</td><td>${safeDisplay(formatPercent(day.successRate))}</td><td>${safeDisplay(numberOrDash(day.averageCommentsGenerated))}</td><td>${safeDisplay(numberOrDash(day.averageCommentsPosted))}</td><td>${safeDisplay(numberOrDash(day.stale))}</td><td>${safeDisplay(numberOrDash(day.skipped))}</td><td>${safeDisplay(numberOrDash(day.interrupted))}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty" data-i18n="empty_daily">No daily trend data.</p>';

  const windowRows = ['24h', '7d', '30d'].map((name) => {
    const bucket = windows[name] || {};
    return `<tr><th scope="row">${safeDisplay(name)}</th><td>${safeDisplay(numberOrDash(bucket.jobs))}</td><td>${safeDisplay(formatPercent(bucket.successRate))}</td><td>${safeDisplay(formatDuration(bucket.durationP50Ms))}</td><td>${safeDisplay(formatDuration(bucket.durationP95Ms))}</td><td>${safeDisplay(formatDuration(bucket.queueWaitP50Ms))}</td><td>${safeDisplay(formatDuration(bucket.queueWaitP95Ms))}</td><td>${safeDisplay(numberOrDash(bucket.averageCommentsGenerated))}</td><td>${safeDisplay(numberOrDash(bucket.averageCommentsPosted))}</td></tr>`;
  }).join('');

  const body = `<div class="metrics-page">
<p class="page-desc muted" data-i18n="metrics_page_desc">Latency, comment volume, failure classification, and repository success trends.</p>
<div class="metric-row">${metricTiles}</div>
<div class="box">
  <div class="table-scroll"><table class="gh-table"><thead><tr><th data-i18n="th_window">Window</th><th data-i18n="th_jobs">Jobs</th><th data-i18n="th_success_rate">Success rate</th><th data-i18n="m_dur_p50">Duration p50</th><th data-i18n="m_dur_p95">Duration p95</th><th data-i18n="m_qw_p50">Queue wait p50</th><th data-i18n="m_qw_p95">Queue wait p95</th><th data-i18n="m_avg_gen">Avg comments generated</th><th data-i18n="m_avg_post">Avg comments posted</th></tr></thead><tbody>${windowRows}</tbody></table></div>
</div>
<div class="box">
  ${failureHtml}
</div>
<div class="box">
  ${repoHtml}
</div>
<div class="box">
  ${dailyHtml}
</div>
</div>`;
  return renderLayout({ title: 'Metrics', active: 'metrics', csrfToken, body, titleKey: 'page_metrics', cspNonce });
}

export function renderJobsPage({ csrfToken, jobs = [], filters = {}, pagination = null, validationMessages = [], filter = '', cspNonce = '' } = {}) {
  const normalizedFilters = { ...filters };
  if (filter && !normalizedFilters.diagnosticId) normalizedFilters.diagnosticId = filter;
  const alerts = validationMessages.length > 0
    ? `<section class="alert"><ul>${validationMessages.map(message => `<li>${safeDisplay(message)}</li>`).join('')}</ul></section>`
    : '';
  const paginationBar = pagination ? `<div class="bar bar-foot">${renderPagination(normalizedFilters, pagination)}</div>` : '';
  const body = `<div class="jobs-page">
${alerts}
<p class="page-desc muted" data-i18n="jobs_page_desc">Review queue history, filter failures, and open job detail logs.</p>
<div class="tablewrap">
  ${renderJobsFilterBar(normalizedFilters, pagination)}
  ${renderJobsTable(jobs)}
  ${paginationBar}
</div>
</div>`;
  return renderLayout({ title: 'Jobs', active: 'jobs', csrfToken, body, titleKey: 'page_jobs', cspNonce });
}

export function renderJobDetailPage({ csrfToken, job, cspNonce = '' }) {
  const id = job?.id ?? job?.jobId ?? '';
  const repository = formatRepository(job?.repo ?? job?.repository);
  const result = objectValue(job?.result ?? job?.rawResult);
  const progress = objectValue(job?.progress);
  const counts = normalizeCounts(job, result);
  const failure = job?.failure ?? result.failure ?? (job?.errorKind || job?.errorMessage ? { kind: job.errorKind, reason: job.errorMessage } : null);
  const reportingError = job?.reportingError ?? result.reportingError ?? null;
  const cleanupWarning = job?.cleanupWarning ?? result.cleanupWarning ?? '';
  const logs = job?.retainedLogs ?? job?.logs ?? null;
  const configRevision = job?.configRevision ?? result.configRevision ?? result.config?.revision;
  const status = job?.status ?? progress.phase ?? job?.phase ?? '';
  const phaseLabel = `${job?.phase ?? progress.phase ?? job?.status ?? ''}${job?.status ? ` / ${job.status}` : ''}`;

  const summaryBox = `<div class="box">
  <div class="box-header"><strong data-i18n="h2_job_detail">Job detail</strong>${jobStatusPill(status)}</div>
  <div class="box-body">
    <div class="detail-grid">
      <div class="detail-item"><span class="k" data-i18n="jd_repo_pr">Repository / PR</span><span class="v">${renderRepoPullLink(job, repository)}</span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_actor">Actor</span><span class="v">${safeDisplay(job?.actor || '—')}</span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_job_id">Job ID</span><span class="v"><code>${safeDisplay(id)}</code></span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_diag_id">Diagnostic ID</span><span class="v"><code>${safeDisplay(job?.diagnosticId || '—')}</code></span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_queued">Queued</span><span class="v">${safeDisplay(formatDate(job?.queuedAt ?? job?.createdAt) || '—')}</span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_started">Started</span><span class="v">${safeDisplay(formatDate(job?.startedAt) || '—')}</span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_finished">Finished</span><span class="v">${safeDisplay(formatDate(job?.finishedAt) || '—')}</span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_queue_wait">Queue wait</span><span class="v">${safeDisplay(formatDuration(job?.queueWaitMs ?? durationBetween(job?.queuedAt ?? job?.createdAt, job?.startedAt)) || '—')}</span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_duration">Duration</span><span class="v">${safeDisplay(formatDuration(job?.durationMs ?? durationBetween(job?.startedAt, job?.finishedAt)) || '—')}</span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_phase_status">Phase / status</span><span class="v">${safeDisplay(phaseLabel || '—')}</span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_head_sha">Head SHA</span><span class="v"><code>${safeDisplay(job?.headSha ?? result.headSha ?? '—')}</code></span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_base_sha">Base SHA</span><span class="v"><code>${safeDisplay(job?.baseSha ?? result.baseSha ?? '—')}</code></span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_config_revision">Config revision</span><span class="v">${safeDisplay(configRevision ?? '—')}</span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_ocr_status">OCR status</span><span class="v">${safeDisplay(job?.ocrStatus ?? result.ocrStatus ?? '—')}</span></div>
    </div>
  </div>
</div>`;

  const countsBox = `<div class="box">
  <div class="box-header"><strong data-i18n="jd_review_counts">Review counts</strong></div>
  <div class="box-body">
    <div class="detail-grid compact">
      <div class="detail-item"><span class="k" data-i18n="jd_generated">Generated</span><span class="v">${safeDisplay(numberOrDash(counts.generated))}</span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_selected">Selected</span><span class="v">${safeDisplay(numberOrDash(counts.selected))}</span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_posted">Posted</span><span class="v">${safeDisplay(numberOrDash(counts.posted))}</span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_omitted">Omitted</span><span class="v">${safeDisplay(numberOrDash(counts.omitted))}</span></div>
      <div class="detail-item"><span class="k" data-i18n="jd_warnings_count">Warnings</span><span class="v">${safeDisplay(numberOrDash(counts.warnings))}</span></div>
    </div>
  </div>
</div>`;

  const body = `<div class="job-detail">
<p class="back"><a class="back-link" href="/admin/jobs" data-i18n="back_jobs">← jobs</a></p>
${summaryBox}
<div class="box">
  <div class="box-header"><strong data-i18n="jd_phase_timeline">Phase timeline</strong></div>
  <div class="box-body">${renderPhaseTimeline(job?.phaseTimeline ?? [])}</div>
</div>
${countsBox}
<div class="box">
  <div class="box-header"><strong data-i18n="jd_warnings_section">Warnings</strong></div>
  <div class="box-body">${renderObjectList(collectJobWarnings(job, result))}</div>
</div>
<div class="box">
  <div class="box-header"><strong data-i18n="jd_failure">Failure</strong></div>
  <div class="box-body">${renderObjectBlock(failure)}</div>
</div>
<details class="card"${reportingError ? ' open' : ''}><summary><h2 data-i18n="jd_reporting_error">Reporting error</h2></summary>${renderObjectBlock(reportingError)}</details>
<details class="card"${cleanupWarning ? ' open' : ''}><summary><h2 data-i18n="jd_cleanup_warning">Cleanup warning</h2></summary>${cleanupWarning ? `<p>${safeDisplay(cleanupWarning)}</p>` : '<p class="empty" data-i18n="empty_none">None.</p>'}</details>
<details class="card"><summary><h2 data-i18n="jd_runtime">Runtime settings</h2></summary>${renderKeyValueTable(job?.runtimeSettings ?? result.runtimeSettings ?? {})}</details>
<div class="box">
  <div class="box-header"><strong data-i18n="jd_retained_logs">Retained logs</strong></div>
  <div class="box-body">${renderLogs(logs)}</div>
</div>
${job?.diagnostics ? `<div class="box"><div class="box-header"><strong data-i18n="jd_job_diagnostics">Job diagnostics</strong></div><div class="box-body">${renderDiagnosticsList(job.diagnostics)}</div></div>` : ''}
</div>`;
  return renderLayout({ title: `Job ${id}`, active: 'jobs', csrfToken, body, cspNonce });
}

export function renderConfigPage({ csrfToken, config = {}, adminRoot = '/data/admin', flash = null, cspNonce = '', section = 'service' } = {}) {
  const fields = Array.isArray(config.fields) ? config.fields : legacyConfigFields(config);
  const revision = config.revision ?? '';
  const flashHtml = flash ? `<div class="alert ${flash.type === 'success' ? 'success' : ''}">${escapeHtml(flash.message)}</div>` : '';
  const pending = config.pendingRestart;
  const pendingHtml = pending?.required
    ? `<div class="alert">Restart required for: ${escapeHtml((pending.keys ?? []).join(', '))}</div>`
    : '';
  const groups = groupConfigFields(fields);
  const counts = summarizeConfigFieldCounts(fields);
  const activeId = groups.some((group) => group.id === section) ? section : (groups[0]?.id || 'service');
  const activeGroup = groups.find((group) => group.id === activeId) || groups[0] || { id: 'service', label: 'Service', labelKey: 'config_group_service', fields: [] };

  const subnav = groups.map((group) => {
    const active = group.id === activeId ? ' is-active' : '';
    const count = group.fields.length;
    return `<a class="settings-subnav-link${active}" href="/admin/config?section=${escapeAttribute(group.id)}"><span data-i18n="${escapeAttribute(group.labelKey)}">${escapeHtml(group.label)}</span><span class="settings-count">${count}</span></a>`;
  }).join('');

  const rows = activeGroup.fields.map(renderSettingsField).join('');
  const body = `<div class="settings" data-config-editor data-settings-section="${escapeAttribute(activeId)}">
  <p class="page-desc muted" data-i18n="config_page_desc">Runtime configuration with audit trail. High-risk fields require confirmation.</p>
  <div class="settings-meta muted">
    <span><span data-i18n="admin_storage_root">Storage</span> <code>${escapeHtml(adminRoot)}</code></span>
    <span><span data-i18n="revision">Revision</span> <code>${escapeHtml(revision)}</code></span>
    <span><span data-i18n="config_field_total">fields</span> <code>${fields.length}</code></span>
    <span><span data-i18n="config_override_count">overrides</span> <code>${counts.overrides}</code></span>
    <span><span data-i18n="config_secret_count">secrets</span> <code>${counts.secrets}</code></span>
    <span><span data-i18n="config_restart_count">restart required</span> <code>${counts.restartRequired}</code></span>
  </div>
  ${flashHtml}${pendingHtml}
  <div class="settings-layout">
    <nav class="settings-subnav" aria-label="Config groups" data-i18n-aria-label="aria_config_groups">${subnav}</nav>
    <section class="settings-panel">
      <form method="post" action="/admin/config" class="settings-form">
        <input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}">
        <input type="hidden" name="revision" value="${escapeAttribute(revision)}">
        <input type="hidden" name="section" value="${escapeAttribute(activeId)}">
        <header class="settings-panel-head">
          <div>
            <h2 class="settings-panel-title" data-i18n="${escapeAttribute(activeGroup.labelKey)}">${escapeHtml(activeGroup.label)}</h2>
            <p class="muted settings-panel-desc" data-i18n="${escapeAttribute(activeGroup.descriptionKey || '')}">${escapeHtml(activeGroup.description || '')}</p>
          </div>
          <button type="submit" class="primary" data-i18n="btn_save_config">Save changes</button>
        </header>
        <div class="settings-list" data-config-group="${escapeAttribute(activeId)}" id="config-group-${escapeAttribute(activeId)}">${rows || '<p class="empty" data-i18n="config_no_matches">No matching configuration fields.</p>'}</div>
        <footer class="settings-panel-foot">
          <span class="muted settings-panel-count"><span class="settings-count">${activeGroup.fields.length}</span> <span data-i18n="config_field_total">fields</span></span>
          <button type="submit" class="primary" data-i18n="btn_save_config">Save changes</button>
        </footer>
      </form>
    </section>
  </div>
</div>`;
  return renderLayout({ title: 'Settings', active: 'config', csrfToken, body, titleKey: 'page_config', cspNonce });
}

function renderSettingsField(field) {
  const envKey = field.envKey ?? field.name ?? '';
  const label = field.label ?? envKey;
  const description = field.description ?? '';
  const searchText = [label, envKey, description].join(' ').toLowerCase();
  const flags = [
    field.secret ? 'secret' : '',
    field.highRisk ? 'highRisk' : '',
    field.restartRequired || field.pendingRestart ? 'restart' : '',
    field.overridden ? 'override' : '',
  ].filter(Boolean).join(' ');
  return `<article class="settings-item" id="config-field-${escapeAttribute(envKey)}" data-config-row data-env-key="${escapeAttribute(envKey)}" data-group="${escapeAttribute(field.group || 'service')}" data-search="${escapeAttribute(searchText)}" data-flags="${escapeAttribute(flags)}">
  <div class="settings-item-main">
    <div class="settings-item-copy">
      <div class="field-label" id="config-label-${escapeAttribute(envKey)}">${escapeHtml(label)}</div>
      <code>${escapeHtml(envKey)}</code>
      ${description ? `<p class="muted">${escapeHtml(description)}</p>` : ''}
      <div class="settings-item-meta">${renderConfigBadges(field)}</div>
    </div>
    <div class="settings-item-value">
      <div class="settings-effective">${renderConfigFieldValue(field)}</div>
      <div class="settings-control">${renderConfigEditorControl(field)}</div>
      <div class="settings-actions">${renderConfigReset(field)}${renderHighRiskConfirm(field)}</div>
    </div>
  </div>
</article>`;
}

function groupConfigFields(fields) {
  const groups = new Map(CONFIG_GROUP_DEFS.map(group => [group.id, { ...group, fields: [] }]));
  for (const field of fields) {
    const groupId = field.group && groups.has(field.group) ? field.group : 'service';
    groups.get(groupId).fields.push(field);
  }
  return [...groups.values()].filter(group => group.fields.length > 0);
}

function summarizeConfigFieldCounts(fields) {
  return {
    overrides: fields.filter(field => field.overridden).length,
    secrets: fields.filter(field => field.secret).length,
    restartRequired: fields.filter(field => field.restartRequired || field.pendingRestart).length,
    highRisk: fields.filter(field => field.highRisk).length,
  };
}


function renderConfigFieldValue(field) {
  if (field.envKey === 'ADMIN_PASSWORD') return renderAdminPasswordFieldValue(field);
  if (field.secret) return renderSecretFieldValue(field);
  return `<code>${escapeHtml(formatConfigValue(field.envKey ?? field.name, field.effectiveValue ?? field.value))}</code>`;
}

function renderSecretFieldValue(field) {
  return field.set ? '<span class="pill pill--ok" data-i18n="secret_set">secret set</span>' : '<span class="empty" data-i18n="not_set">not set</span>';
}

function renderAdminPasswordFieldValue(field) {
  const secretStatus = renderSecretFieldValue(field);
  if (typeof field.adminDashboardEnabled !== 'boolean') return secretStatus;
  const enabled = field.adminDashboardEnabled;
  const status = enabled
    ? '<span class="pill pill--ok" data-i18n="admin_dashboard_enabled">dashboard enabled</span>'
    : '<span class="pill pill--warn" data-i18n="admin_dashboard_disabled">dashboard disabled</span>';
  const reason = !enabled && field.adminDashboardDisabledReason
    ? `<span class="empty">${escapeHtml(field.adminDashboardDisabledReason)}</span>`
    : '';
  return `<div class="stack">${secretStatus}${status}${reason}</div>`;
}

function renderConfigEditorControl(field) {
  const envKey = field.envKey ?? '';
  if (!field.editable) return '<span class="empty" data-i18n="not_editable">Not editable from dashboard.</span>';
  if (field.secret) {
    return `<div class="stack"><label><input type="radio" name="secret_${escapeAttribute(envKey)}" value="keep" checked> <span data-i18n="keep_secret">Keep current secret</span></label><label><input type="radio" name="secret_${escapeAttribute(envKey)}" value="clear"> <span data-i18n="clear_secret">Clear secret</span></label><label><input type="radio" name="secret_${escapeAttribute(envKey)}" value="replace"> <span data-i18n="replace_with">Replace with</span></label><input class="config-control" type="password" name="value_${escapeAttribute(envKey)}" autocomplete="off" value="" aria-labelledby="config-label-${escapeAttribute(envKey)}"></div>`;
  }
  return `<input class="config-control" name="value_${escapeAttribute(envKey)}" value="${escapeAttribute(formatEditorValue(field.effectiveValue ?? field.value))}" aria-labelledby="config-label-${escapeAttribute(envKey)}">`;
}

function renderConfigBadges(field) {
  const badges = [];
  if (field.source) badges.push({ text: `source: ${field.source}`, tone: '' });
  badges.push({ text: field.secret ? 'secret' : 'non-secret', tone: '' });
  badges.push({ text: field.restartRequired ? 'restart required' : 'hot reload', tone: field.restartRequired ? 'pill--warn' : 'pill--ok' });
  badges.push({ text: field.overridden ? 'override active' : 'no override', tone: field.overridden ? 'pill--warn' : '' });
  if (field.pendingRestart) badges.push({ text: 'pending restart', tone: 'pill--err' });
  return `<div class="field-meta">${badges.map(badge => `<span class="pill ${badge.tone}">${escapeHtml(badge.text)}</span>`).join(' ')}</div>`;
}

function renderConfigReset(field) {
  if (!field.canReset) return '';
  const envKey = field.envKey ?? '';
  return `<label class="nowrap"><input type="checkbox" name="reset_${escapeAttribute(envKey)}" value="1"> <span data-i18n="reset_override">Reset override</span></label>`;
}

function renderHighRiskConfirm(field) {
  if (!field.highRisk || !field.editable) return '';
  const envKey = field.envKey ?? '';
  return `<label class="danger nowrap"><input type="checkbox" name="confirm_${escapeAttribute(envKey)}" value="1"> <span data-i18n="confirm_high_risk">Confirm high-risk change</span></label>`;
}

export const CONFIG_GROUP_DEFS = Object.freeze([
  { id: 'service', label: 'Service', labelKey: 'config_group_service', descriptionKey: 'config_group_service_desc', description: 'Core runtime process, ports, and workdir behavior.' },
  { id: 'access', label: 'Triggers & Access', labelKey: 'config_group_access', descriptionKey: 'config_group_access_desc', description: 'Who can trigger reviews and which repositories are allowed.' },
  { id: 'github', label: 'GitHub App', labelKey: 'config_group_github', descriptionKey: 'config_group_github_desc', description: 'GitHub App identity, private key path, and webhook secret.' },
  { id: 'ocr', label: 'OCR Engine', labelKey: 'config_group_ocr', descriptionKey: 'config_group_ocr_desc', description: 'OpenCodeReview provider endpoint, model, and concurrency.' },
  { id: 'proxy', label: 'LLM Proxy', labelKey: 'config_group_proxy', descriptionKey: 'config_group_proxy_desc', description: 'Internal LLM proxy routing and upstream authentication.' },
  { id: 'admin', label: 'Admin Dashboard', labelKey: 'config_group_admin', descriptionKey: 'config_group_admin_desc', description: 'Dashboard access, host allowlist, cookies, and data root.' },
  { id: 'retention', label: 'Retention & Storage', labelKey: 'config_group_retention', descriptionKey: 'config_group_retention_desc', description: 'How long jobs, logs, stats, and audits are kept.' },
]);
export const CONFIG_GROUP_IDS = Object.freeze(CONFIG_GROUP_DEFS.map((group) => group.id));

function legacyConfigFields(config) {
  return Object.entries(config)
    .filter(([key]) => key !== 'revision' && key !== 'pendingRestart')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ name: key, envKey: key, label: key, value, effectiveValue: value, source: '', secret: isSecretKey(key), editable: false, restartRequired: false, hotReloadable: true, overridden: false, canReset: false, highRisk: false, group: 'service' }));
}

function formatEditorValue(value) {
  if (value instanceof Set) return [...value].sort().join(',');
  if (Array.isArray(value)) return value.map(item => formatEditorValue(item)).join(',');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value == null) return '';
  return String(value);
}

export function renderErrorPage({ csrfToken = '', status = 500, title = 'Error', message = 'Something went wrong', cspNonce = '' } = {}) {
  const body = `<section class="card"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><p class="muted">status ${escapeHtml(status)}</p></section>`;
  return csrfToken
    ? renderLayout({ title, active: '', csrfToken, body, cspNonce })
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${fontLinks()}${themeInitScript(cspNonce)}<style>${baseStyles()}</style></head><body><main class="centered"><h1 class="page-title">${escapeHtml(title)}</h1>${body}</main>${bodyScript(cspNonce)}</body></html>`;
}

export function renderJobsTable(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return '<div class="empty-state" data-i18n="empty_jobs">No jobs found.</div>';
  const rows = jobs.map((job) => {
    const id = job?.id ?? job?.jobId;
    const status = job?.status;
    const repo = formatRepository(job?.repo ?? job?.repository);
    const actor = job?.actor ?? '';
    const diagnosticId = job?.diagnosticId ?? '';
    const queuedAt = job?.queuedAt ?? job?.createdAt ?? job?.startedAt;
    const idCell = id ? `<a class="mono-link" href="/admin/jobs/${escapeAttribute(id)}"><code>${safeDisplay(id)}</code></a>` : '';
    const pr = job?.pullNumber != null && job?.pullNumber !== '' ? `#${safeDisplay(job.pullNumber)}` : '—';
    return `<tr>
      <td>${idCell}</td>
      <td>${jobStatusPill(status)}</td>
      <td class="repo">${safeDisplay(repo)}</td>
      <td>${pr}</td>
      <td>${safeDisplay(actor || '—')}</td>
      <td><code class="subtle">${safeDisplay(diagnosticId || '—')}</code></td>
      <td class="subtle nowrap-cell">${safeDisplay(formatDate(queuedAt) || '—')}</td>
    </tr>`;
  }).join('');
  return `<div class="table-scroll gh-table-wrap"><table class="gh-table"><thead><tr><th data-i18n="th_job_id">Job ID</th><th data-i18n="th_status">Status</th><th data-i18n="th_repository">Repository</th><th data-i18n="th_pr">PR</th><th data-i18n="th_actor">Actor</th><th data-i18n="th_diag_id">Diagnostic ID</th><th data-i18n="th_queued">Queued</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function renderDiagnosticsList(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return '<p class="empty" data-i18n="empty_diagnostics">No diagnostics.</p>';
  const items = diagnostics.map((item) => {
    const id = item?.displayId ?? item?.id ?? '';
    const level = String(item?.level ?? 'info').toLowerCase();
    const message = item?.message ?? '';
    let levelTone = '';
    if (level === 'error') levelTone = 'pill--err';
    else if (level === 'warn') levelTone = 'pill--warn';
    return `<li><strong>${escapeHtml(redactInlineSecrets(id))}</strong> <span class="pill ${levelTone}">${escapeHtml(redactInlineSecrets(level))}</span> <span class="diag-msg">${escapeHtml(redactInlineSecrets(message))}</span></li>`;
  }).join('');
  return `<ul class="diagnostics">${items}</ul>`;
}

export function formatRepository(repository) {
  if (repository == null || repository === '') return '';
  if (typeof repository === 'string') return repository;
  if (typeof repository !== 'object' || Array.isArray(repository)) return String(repository);
  if (typeof repository.fullName === 'string' && repository.fullName !== '') return repository.fullName;
  if (typeof repository.full_name === 'string' && repository.full_name !== '') return repository.full_name;
  const owner = typeof repository.owner === 'string' ? repository.owner : '';
  const name = typeof repository.name === 'string' ? repository.name : '';
  return owner && name ? `${owner}/${name}` : '';
}

export function formatConfigValue(key, value) {
  const redacted = redactConfigValue(key, value);
  if (Array.isArray(redacted)) return redacted.map(formatScalarValue).join(', ');
  if (typeof redacted === 'boolean') return redacted ? 'enabled' : 'disabled';
  if (redacted == null) return '';
  if (typeof redacted === 'object') return JSON.stringify(redacted);
  return String(redacted);
}

function redactConfigValue(key, value) {
  if (isSecretKey(key)) return '••••••••';
  if (value instanceof Set) return [...value].map((item) => redactConfigValue('', item));
  if (Array.isArray(value)) return value.map((item) => redactConfigValue('', item));
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      clean[nestedKey] = redactConfigValue(nestedKey, nestedValue);
    }
    return clean;
  }
  if (typeof value === 'string') return redactInlineSecrets(value);
  return value;
}

function formatScalarValue(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
// Canonical job states: chips + advanced select share this definition.
const JOB_STATES = Object.freeze([
  { value: 'running', key: 'st_running', quick: true },
  { value: 'queued', key: 'st_queued', quick: true },
  { value: 'succeeded', key: 'st_succeeded', quick: true },
  { value: 'succeeded_with_warnings', key: 'st_succeeded_with_warnings', quick: false },
  { value: 'failed', key: 'st_failed', quick: true },
  { value: 'interrupted', key: 'st_interrupted', quick: false },
  { value: 'stale', key: 'st_stale', quick: false },
  { value: 'skipped', key: 'st_skipped', quick: false },
]);
const STATE_CHIPS = Object.freeze([
  { value: '', key: 'f_all' },
  ...JOB_STATES.filter((s) => s.quick).map(({ value, key }) => ({ value, key })),
]);
const STATE_OPTIONS = Object.freeze(JOB_STATES.map(({ value, key }) => [value, key]));
const FAILURE_KIND_OPTIONS = [
  ['job_timeout', 'fk_job_timeout'],
  ['ocr_config_error', 'fk_ocr_config_error'],
  ['provider_rate_limited', 'fk_provider_rate_limited'],
  ['provider_auth_failed', 'fk_provider_auth_failed'],
  ['provider_unavailable', 'fk_provider_unavailable'],
  ['ocr_runtime_error', 'fk_ocr_runtime_error'],
  ['git_error', 'fk_git_error'],
  ['github_rate_limited', 'fk_github_rate_limited'],
  ['github_api_error', 'fk_github_api_error'],
  ['bot_runtime_error', 'fk_bot_runtime_error'],
  ['invalid_ocr_output', 'fk_invalid_ocr_output'],
];

function renderFilterSelect(name, value, options, allKey) {
  const current = String(value ?? '').trim().toLowerCase();
  const all = `<option value="" data-i18n="${allKey}">${escapeHtml(I18N.en[allKey] ?? 'all')}</option>`;
  const rest = options.map(([v, key]) => `<option value="${escapeAttribute(v)}" data-i18n="${key}"${v.toLowerCase() === current ? ' selected' : ''}>${escapeHtml(I18N.en[key] ?? v)}</option>`).join('');
  return `<select name="${name}">${all}${rest}</select>`;
}

function renderJobsFilterBar(filters, pagination) {
  const state = String(filters.state ?? filters.status ?? filters.outcome ?? '').toLowerCase();
  const size = pagination?.pageSize ?? filters.pageSize ?? 50;
  const total = pagination?.total ?? 0;
  const page = pagination?.page ?? 1;
  const totalPages = pagination?.totalPages ?? 1;
  const countAttrs = `data-i18n-template="pagination_summary" data-page="${safeDisplay(page)}" data-total-pages="${safeDisplay(totalPages)}" data-total="${safeDisplay(total)}"`;
  const countText = `page ${safeDisplay(page)} / ${safeDisplay(totalPages)} · ${safeDisplay(total)} ${total === 1 ? 'job' : 'jobs'}`;

  const chips = STATE_CHIPS.map((c) => {
    const on = c.value === state ? ' on' : '';
    return `<button type="submit" name="state" value="${escapeAttribute(c.value)}" class="chip${on}" data-i18n="${c.key}">${escapeHtml(I18N.en[c.key] ?? (c.value || 'all'))}</button>`;
  }).join('');

  const advanced = {
    owner: String(filters.owner ?? ''),
    repository: String(filters.repository ?? filters.repo ?? ''),
    failureKind: String(filters.failureKind ?? ''),
    diagnosticId: String(filters.diagnosticId ?? ''),
    from: String(filters.from ?? ''),
    to: String(filters.to ?? ''),
  };
  const advActive = Object.values(advanced).some((v) => v !== '') || Boolean(state);
  // Apply re-submits current state via the select; chips also submit state directly.
  const applyState = `<button type="submit" class="primary btn-sm" data-i18n="btn_apply">apply</button>`;
  const advFields = `<label><span data-i18n="f_owner">Owner</span><input name="owner" value="${escapeAttribute(advanced.owner)}" placeholder="owner"></label>`
    + `<label><span data-i18n="f_repository">Repository</span><input name="repository" value="${escapeAttribute(advanced.repository)}" placeholder="name or owner/name"></label>`
    + `<label><span data-i18n="f_state">State/outcome</span>${renderFilterSelect('state', state, STATE_OPTIONS, 'f_all')}</label>`
    + `<label><span data-i18n="f_failure_kind">Failure kind</span>${renderFilterSelect('failureKind', advanced.failureKind, FAILURE_KIND_OPTIONS, 'f_all')}</label>`
    + `<label><span data-i18n="f_diag_id">Diagnostic ID</span><input name="diagnosticId" value="${escapeAttribute(advanced.diagnosticId)}" placeholder="9c4ea7"></label>`
    + `<label><span data-i18n="f_from">From</span><input name="from" type="date" value="${escapeAttribute(advanced.from)}"></label>`
    + `<label><span data-i18n="f_to">To</span><input name="to" type="date" value="${escapeAttribute(advanced.to)}"></label>`;

  return `<form class="job-filters" method="get" action="/admin/jobs">
  <input type="hidden" name="size" value="${escapeAttribute(size)}">
  <div class="bar bar-filters">
    <div class="chips" role="group" aria-label="State">${chips}</div>
    <span class="count" ${countAttrs}>${escapeHtml(countText)}</span>
  </div>
  <details class="adv-filters"${advActive ? ' open' : ''}>
    <summary><span data-i18n="f_advanced">Advanced filters</span>${advActive ? '<span class="chip on adv-flag" aria-hidden="true">on</span>' : ''}</summary>
    <div class="adv-grid">${advFields}<div class="adv-actions">${applyState}<a class="chip" href="/admin/jobs" data-i18n="btn_reset">reset</a></div></div>
  </details>
</form>`;
}

function renderPagination(filters, pagination) {
  if (!pagination) return '';
  const total = Number.isFinite(pagination.total) ? pagination.total : 0;
  const page = pagination.page ?? 1;
  const totalPages = pagination.totalPages ?? 1;
  const prev = pagination.hasPrev ? `<a href="${escapeAttribute(jobsPageUrl(filters, pagination.prevPage, pagination.pageSize))}" data-i18n="btn_prev">prev</a>` : '<span class="empty" aria-disabled="true" data-i18n="btn_prev">prev</span>';
  const next = pagination.hasNext ? `<a href="${escapeAttribute(jobsPageUrl(filters, pagination.nextPage, pagination.pageSize))}" data-i18n="btn_next">next</a>` : '<span class="empty" aria-disabled="true" data-i18n="btn_next">next</span>';
  return `<nav class="pagination" aria-label="Jobs pages" data-i18n-aria-label="aria_jobs_pages">${prev}<span data-i18n-template="pagination_summary" data-page="${safeDisplay(page)}" data-total-pages="${safeDisplay(totalPages)}" data-total="${safeDisplay(total)}">page ${safeDisplay(page)} / ${safeDisplay(totalPages)} · ${safeDisplay(total)} jobs</span>${next}</nav>`;
}

function jobsPageUrl(filters, page, size) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({
    owner: filters.owner,
    repository: filters.repository ?? filters.repo,
    state: filters.state ?? filters.status ?? filters.outcome,
    failureKind: filters.failureKind,
    diagnosticId: filters.diagnosticId,
    from: filters.from,
    to: filters.to,
    size,
    page,
  })) {
    if (value != null && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `/admin/jobs?${query}` : '/admin/jobs';
}

function renderPhaseTimeline(timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) return '<p class="empty" data-i18n="empty_phase_timeline">No phase timeline.</p>';
  const rows = timeline.map(item => `<tr><td>${safeDisplay(formatDate(item.timestamp))}</td><td>${safeDisplay(item.label ?? item.phase ?? '')}</td><td>${safeDisplay(item.phase ?? '')}</td><td>${safeDisplay(item.message ?? '')}</td><td>${safeDisplay(item.source ?? '')}</td></tr>`).join('');
  return `<div class="table-scroll"><table><thead><tr><th data-i18n="th_time">Time</th><th data-i18n="th_event">Event</th><th data-i18n="th_phase">Phase</th><th data-i18n="th_message">Message</th><th data-i18n="th_source">Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderRepoPullLink(job, repository) {
  const pullNumber = job?.pullNumber;
  if (!repository) return safeDisplay(pullNumber ? `#${pullNumber}` : '');
  const label = pullNumber ? `${repository}#${pullNumber}` : repository;
  return pullNumber ? `<a href="https://github.com/${escapeAttribute(repository)}/pull/${escapeAttribute(pullNumber)}" rel="noreferrer">${safeDisplay(label)}</a>` : safeDisplay(label);
}

function renderKeyValueTable(values) {
  const entries = Object.entries(objectValue(values)).filter(([key]) => !isSecretKey(key));
  if (entries.length === 0) return '<p class="empty" data-i18n="empty_runtime">No runtime settings.</p>';
  const rows = entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `<tr><th scope="row">${safeDisplay(key)}</th><td>${safeDisplay(formatDisplayValue(redactConfigValue(key, value)))}</td></tr>`).join('');
  return `<div class="table-scroll"><table><tbody>${rows}</tbody></table></div>`;
}

function renderObjectList(items) {
  if (!Array.isArray(items) || items.length === 0) return '<p class="empty" data-i18n="empty_none">None.</p>';
  return `<ul>${items.map(item => `<li>${safeDisplay(formatDisplayValue(item))}</li>`).join('')}</ul>`;
}

function renderObjectBlock(value) {
  if (value == null || value === '') return '<p class="empty" data-i18n="empty_none">None.</p>';
  return `<pre>${safeDisplay(formatDisplayValue(value))}</pre>`;
}

function renderLogs(logs) {
  if (!logs || !Array.isArray(logs.entries) || logs.entries.length === 0) return '<p class="empty" data-i18n="empty_logs">No retained logs.</p>';
  const rows = logs.entries.map(entry => `<tr><td>${safeDisplay(formatDate(entry.timestamp))}</td><td>${safeDisplay(entry.level)}</td><td>${safeDisplay(entry.message)}</td><td>${safeDisplay(formatDisplayValue(entry.fields ?? {}))}</td></tr>`).join('');
  const note = logs.degraded ? '<p class="alert" data-i18n="logs_degraded">Log history is degraded.</p>' : '';
  return `${note}<div class="table-scroll"><table><thead><tr><th data-i18n="th_time">Time</th><th data-i18n="th_level">Level</th><th data-i18n="th_message">Message</th><th data-i18n="th_fields">Fields</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function collectJobWarnings(job, result) {
  const warnings = [];
  if (Array.isArray(job?.warnings)) warnings.push(...job.warnings);
  if (Array.isArray(result.warnings)) warnings.push(...result.warnings);
  if (Array.isArray(result.publishWarnings)) warnings.push(...result.publishWarnings);
  if (Number.isFinite(result.warningsCount) && warnings.length === 0) warnings.push(`${result.warningsCount} warning(s)`);
  return warnings;
}

function normalizeCounts(job, result) {
  const counts = objectValue(job?.counts);
  return {
    generated: counts.generated ?? result.commentsGenerated,
    selected: counts.selected ?? result.commentsSelected,
    posted: counts.posted ?? result.commentsPosted,
    omitted: counts.omitted ?? result.commentsOmitted,
    warnings: counts.warnings ?? result.warningsCount,
  };
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function formatDisplayValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return redactInlineSecrets(value);
  if (typeof value === 'object') return redactInlineSecrets(JSON.stringify(redactConfigValue('', value), null, 2));
  return String(value);
}

function safeDisplay(value) {
  return escapeHtml(redactInlineSecrets(value ?? ''));
}

function durationBetween(start, end) {
  if (!start || !end) return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '';
}

function formatDate(value) {
  if (value == null || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function numberOrDash(value) {
  return Number.isFinite(value) ? String(value) : '—';
}

function mapServiceHealth(level) {
  const normalized = String(level ?? '').toLowerCase();
  if (normalized === 'healthy') return { labelKey: 'health_healthy', label: 'Healthy', dot: 'ok' };
  if (normalized === 'degraded') return { labelKey: 'health_degraded', label: 'Degraded', dot: 'warn' };
  return { labelKey: 'health_unavailable', label: 'Unavailable', dot: 'err' };
}

function jobIdOf(job) {
  const id = job?.jobId ?? job?.id;
  return id == null || id === '' ? '' : String(id);
}

function jobIdCodeLink(job) {
  const id = jobIdOf(job);
  if (!id) return '<code>—</code>';
  return `<a href="/admin/jobs/${escapeAttribute(id)}"><code>${escapeHtml(id)}</code></a>`;
}

function jobIdRow(job) {
  const id = jobIdOf(job);
  if (!id) return '';
  return `<div class="kv"><span class="k" data-i18n="th_job">Job</span><span class="v">${jobIdCodeLink(job)}</span></div>`;
}

function jobStatusTone(status) {
  const s = String(status ?? '').toLowerCase();
  if (s === 'succeeded') return { tone: 'ok', dot: 'ok', labelKey: 'pill_success', label: 'success' };
  if (s === 'succeeded_with_warnings') return { tone: 'warn', dot: 'warn', labelKey: 'pill_warnings', label: 'warnings' };
  if (s === 'running') return { tone: 'run', dot: 'run', labelKey: 'pill_running', label: 'running' };
  if (s === 'failed') return { tone: 'fail', dot: 'err', labelKey: 'pill_failed', label: 'failed' };
  if (s === 'queued') return { tone: 'queued', dot: 'idle', labelKey: 'pill_queued', label: 'queued' };
  if (s === 'interrupted') return { tone: 'skip', dot: 'idle', labelKey: 'pill_interrupted', label: 'interrupted' };
  if (s === 'stale') return { tone: 'skip', dot: 'idle', labelKey: 'pill_stale', label: 'stale' };
  if (s === 'skipped') return { tone: 'skip', dot: 'idle', labelKey: 'pill_skipped', label: 'skipped' };
  return { tone: 'queued', dot: 'idle', labelKey: '', label: String(status ?? '—') };
}
function jobStatusPill(status) {
  const { tone, dot, label, labelKey } = jobStatusTone(status);
  const text = labelKey
    ? `<span data-i18n="${labelKey}">${escapeHtml(label)}</span>`
    : escapeHtml(label);
  return `<span class="dpill ${tone}"><i class="dot ${dot}" aria-hidden="true"></i>${text}</span>`;
}

const I18N = {
  en: {
    nav_dashboard: 'Status', nav_jobs: 'Jobs', nav_metrics: 'Metrics', nav_config: 'Settings', nav_brand_tag: 'self-hosted', nav_side_foot: 'Open Code Review', signout: 'Sign out',
    toggle_theme: 'Toggle theme', toggle_theme_dark: 'Switch to dark theme', toggle_theme_light: 'Switch to light theme',
    toggle_lang: 'Switch language', toggle_lang_en: 'Switch to English', toggle_lang_zh: 'Switch to Chinese',
    page_dashboard: 'Status', page_jobs: 'Jobs', page_metrics: 'Metrics', page_config: 'Settings', jobs_page_desc: 'Review queue history, filter failures, and open job detail logs.', overview_page_desc: 'Service health, queue, and current activity.', metrics_page_desc: 'Latency, comment volume, failure classification, and repository success trends.', config_page_desc: 'Runtime configuration with audit trail. High-risk fields require confirmation.', btn_view_metrics: 'Open metrics →',
    login_title: 'Sign in', login_sub: 'Open Code Review admin console', login_prompt: 'Enter the admin password',
    label_password: 'Password', sign_in: 'Sign in',
    strip_queued: 'Queued', strip_running: 'Running', strip_succeeded: 'Succeeded', strip_warnings: 'Warnings', strip_failed: 'Failed',
    h2_diagnostics: 'Diagnostics', empty_jobs: 'No jobs found.', empty_diagnostics: 'No diagnostics.',
    h2_service_status: 'Status', h2_overview: 'Service status', ss_uptime: 'Uptime', ss_started: 'Started', ss_version: 'Version', ss_config_revision: 'Config revision',
    ss_actual_port: 'Actual listening port', ss_configured_port: 'Configured port', ss_pending_port: 'Desired pending port',
    ss_storage_health: 'Storage writable/degraded', ss_storage_size: 'Storage size / budget', ss_last_retention: 'Last retention', ss_diag_counts: 'Corrupt/truncated diagnostics',
    ssg_runtime: 'Runtime', ssg_network: 'Network', ssg_storage: 'Storage', ssg_diagnostics: 'Diagnostics', ss_port: 'Port',
    h2_metrics: 'Metrics and trends', m_dur_p50: 'Duration p50', m_dur_p95: 'Duration p95', m_qw_p50: 'Queue wait p50', m_qw_p95: 'Queue wait p95',
    ss_running_job: 'Current running job', empty_running: 'No running job.', ss_queued: 'Queued', ss_last_sf: 'Last completed / failure', ss_last_success: 'Last completed', ss_last_completed: 'Last completed', ss_last_failure: 'Last failure', th_diag: 'Diagnostic', th_job: 'Job', tile_health: 'Health', tile_queue: 'Queue depth', tile_reviewed: 'Reviewed', tile_warnings: 'Warnings', health_healthy: 'Healthy', health_degraded: 'Degraded', health_unavailable: 'Unavailable', pill_success: 'success', pill_warnings: 'warnings', pill_running: 'running', pill_failed: 'failed', pill_queued: 'queued', pill_interrupted: 'interrupted', pill_stale: 'stale', pill_skipped: 'skipped', word_ok: 'ok', storage_writable: 'writable', storage_not_writable: 'not writable', storage_degraded: 'degraded', storage_healthy: 'healthy', storage_unknown: 'unknown',
    word_configured: 'configured', word_yes: 'yes', word_no: 'no', diag_corrupt: 'corrupt', diag_invalid: 'invalid', diag_truncated: 'truncated', diag_runtime_warnings: 'runtime warnings',
    m_fail_class: 'Failure classification', m_repo_rate: 'Repository success rate', m_daily_trend: 'Daily trend', empty_daily: 'No daily trend data.',
    th_window: 'Window', th_jobs: 'Jobs', th_success_rate: 'Success rate', th_trend: 'Trend', th_day: 'Day',
    h2_jobs: 'Jobs', f_owner: 'Owner', f_repository: 'Repository', f_state: 'State/outcome', f_failure_kind: 'Failure kind', f_diag_id: 'Diagnostic ID', f_from: 'From', f_to: 'To', f_advanced: 'Advanced filters', btn_apply: 'apply', f_all: 'all', btn_reset: 'reset', st_succeeded: 'Succeeded', st_succeeded_with_warnings: 'Succeeded with warnings', st_failed: 'Failed', st_running: 'Running', st_queued: 'Queued', st_interrupted: 'Interrupted', st_stale: 'Stale', st_skipped: 'Skipped', fk_job_timeout: 'Job timeout', fk_ocr_config_error: 'OCR config error', fk_provider_rate_limited: 'Provider rate limited', fk_provider_auth_failed: 'Provider auth failed', fk_provider_unavailable: 'Provider unavailable', fk_ocr_runtime_error: 'OCR runtime error', fk_git_error: 'Git error', fk_github_rate_limited: 'GitHub rate limited', fk_github_api_error: 'GitHub API error', fk_bot_runtime_error: 'Bot runtime error', fk_invalid_ocr_output: 'Invalid OCR output',
    th_job_id: 'Job ID', th_status: 'Status', th_repository: 'Repository', th_pr: 'PR', th_actor: 'Actor', th_diag_id: 'Diagnostic ID', th_queued: 'Queued', btn_prev: 'prev', btn_next: 'next',
    back_jobs: '← jobs', h2_job_detail: 'Job detail', jd_repo_pr: 'Repository / PR', jd_actor: 'Actor', jd_job_id: 'Job ID', jd_diag_id: 'Diagnostic ID',
    jd_queued: 'Queued', jd_started: 'Started', jd_finished: 'Finished', jd_queue_wait: 'Queue wait', jd_duration: 'Duration', jd_phase_status: 'Phase / status',
    jd_head_sha: 'Head SHA', jd_base_sha: 'Base SHA', jd_config_revision: 'Config revision', jd_ocr_status: 'OCR status',
    jd_runtime: 'Runtime settings', jd_phase_timeline: 'Phase timeline', jd_review_counts: 'Review counts', jd_warnings_section: 'Warnings',
    jd_failure: 'Failure', jd_reporting_error: 'Reporting error', jd_cleanup_warning: 'Cleanup warning', jd_retained_logs: 'Retained logs', jd_job_diagnostics: 'Job diagnostics',
    jd_generated: 'Generated', jd_selected: 'Selected', jd_posted: 'Posted', jd_omitted: 'Omitted', jd_warnings_count: 'Warnings',
    empty_none: 'None.', empty_runtime: 'No runtime settings.', empty_phase_timeline: 'No phase timeline.', empty_logs: 'No retained logs.',
    th_time: 'Time', th_event: 'Event', th_phase: 'Phase', th_message: 'Message', th_source: 'Source', th_level: 'Level', th_fields: 'Fields',
    h2_configuration: 'Configuration', admin_storage_root: 'Storage', revision: 'Revision', h2_edit_config: 'Edit configuration',
    th_field: 'Field', th_effective: 'Effective value', th_edit: 'Edit', th_state: 'State', btn_save_config: 'Save changes',
    keep_secret: 'Keep current secret', clear_secret: 'Clear secret', replace_with: 'Replace with', reset_override: 'Reset override', confirm_high_risk: 'Confirm high-risk change',
    not_editable: 'Not editable from dashboard.', secret_set: 'secret set', not_set: 'not set', admin_dashboard_enabled: 'dashboard enabled', admin_dashboard_disabled: 'dashboard disabled',
    config_group_service: 'Service', config_group_access: 'Triggers & Access', config_group_github: 'GitHub App', config_group_ocr: 'OCR Engine', config_group_proxy: 'LLM Proxy', config_group_admin: 'Admin Dashboard', config_group_retention: 'Retention & Storage', config_group_service_desc: 'Core runtime process, ports, and workdir behavior.', config_group_access_desc: 'Who can trigger reviews and which repositories are allowed.', config_group_github_desc: 'GitHub App identity, private key path, and webhook secret.', config_group_ocr_desc: 'OpenCodeReview provider endpoint, model, and concurrency.', config_group_proxy_desc: 'Internal LLM proxy routing and upstream authentication.', config_group_admin_desc: 'Dashboard access, host allowlist, cookies, and data root.', config_group_retention_desc: 'How long jobs, logs, stats, and audits are kept.',
    config_field_total: 'fields', config_override_count: 'overrides', config_secret_count: 'secrets', config_restart_count: 'restart required',
    config_no_matches: 'No matching configuration fields.',
    aria_config_filters: 'Field filters', aria_config_groups: 'Config groups',
    aria_sections: 'Sections', aria_job_summary: 'Job summary', aria_jobs_pages: 'Jobs pages', skip_to_main: 'Skip to main',
    logs_degraded: 'Log history is degraded.', pagination_summary: 'page {page} / {total-pages} · {total} jobs',
  },
  zh: {
    nav_dashboard: '状态', nav_jobs: '任务', nav_metrics: '指标', nav_config: '设置', nav_brand_tag: '自托管', nav_side_foot: 'Open Code Review', signout: '退出',
    toggle_theme: '切换主题', toggle_theme_dark: '切换到深色主题', toggle_theme_light: '切换到浅色主题',
    toggle_lang: '切换语言', toggle_lang_en: '切换到英文', toggle_lang_zh: '切换到中文',
    page_dashboard: '状态', page_jobs: '任务', page_metrics: '指标', page_config: '设置', metrics_page_desc: '耗时、评论量、失败分类与仓库成功率趋势。', btn_view_metrics: '打开指标 →', jobs_page_desc: '查看任务历史、筛选失败并打开任务日志。', overview_page_desc: '服务健康、队列与当前动态。', config_page_desc: '运行时配置带审计记录。高风险字段需确认。',
    login_title: '登录', login_sub: 'Open Code Review 管理控制台', login_prompt: '输入管理员密码',
    label_password: '密码', sign_in: '登录',
    strip_queued: '排队', strip_running: '运行中', strip_succeeded: '成功', strip_warnings: '带警告', strip_failed: '失败',
    h2_diagnostics: '诊断', empty_jobs: '暂无任务。', empty_diagnostics: '暂无诊断。',
    h2_service_status: '状态', h2_overview: '服务状态', ss_uptime: '运行时长', ss_started: '启动时间', ss_version: '版本', ss_config_revision: '配置版本',
    ss_actual_port: '实际监听端口', ss_configured_port: '配置端口', ss_pending_port: '待生效端口',
    ss_storage_health: '存储可写/降级', ss_storage_size: '存储用量 / 配额', ss_last_retention: '上次清理', ss_diag_counts: '损坏/截断的诊断',
    ssg_runtime: '运行时', ssg_network: '网络', ssg_storage: '存储', ssg_diagnostics: '诊断', ss_port: '端口',
    h2_metrics: '指标与趋势', m_dur_p50: '耗时 p50', m_dur_p95: '耗时 p95', m_qw_p50: '排队等待 p50', m_qw_p95: '排队等待 p95',
    ss_running_job: '当前运行中任务', empty_running: '无运行中任务。', ss_queued: '排队中', ss_last_sf: '上次完成/失败', ss_last_success: '上次完成', ss_last_completed: '上次完成', ss_last_failure: '上次失败', th_diag: '诊断 ID', th_job: '任务', tile_health: '健康', tile_queue: '队列深度', tile_reviewed: '审查结果', tile_warnings: '警告', health_healthy: '健康', health_degraded: '降级', health_unavailable: '不可用', pill_success: '成功', pill_warnings: '带警告', pill_running: '运行中', pill_failed: '失败', pill_queued: '排队', pill_interrupted: '中断', pill_stale: '过期', pill_skipped: '跳过', word_ok: '成功', storage_writable: '可写', storage_not_writable: '不可写', storage_degraded: '降级', storage_healthy: '健康', storage_unknown: '未知',
    word_configured: '配置', word_yes: '是', word_no: '否', diag_corrupt: '损坏', diag_invalid: '无效', diag_truncated: '截断', diag_runtime_warnings: '运行时警告',
    m_fail_class: '失败分类', m_repo_rate: '仓库成功率', m_daily_trend: '每日趋势', empty_daily: '暂无每日趋势数据。',
    th_window: '时间窗', th_jobs: '任务数', th_success_rate: '成功率', th_trend: '趋势', th_day: '日期',
    h2_jobs: '任务', f_owner: '所有者', f_repository: '仓库', f_state: '状态/结果', f_failure_kind: '失败类型', f_diag_id: '诊断 ID', f_from: '起', f_to: '止', f_advanced: '高级筛选', btn_apply: '应用', f_all: '全部', btn_reset: '重置', st_succeeded: '成功', st_succeeded_with_warnings: '带警告成功', st_failed: '失败', st_running: '运行中', st_queued: '排队', st_interrupted: '中断', st_stale: '过期', st_skipped: '跳过', fk_job_timeout: '任务超时', fk_ocr_config_error: 'OCR 配置错误', fk_provider_rate_limited: '服务商限流', fk_provider_auth_failed: '服务商鉴权失败', fk_provider_unavailable: '服务商不可用', fk_ocr_runtime_error: 'OCR 运行错误', fk_git_error: 'Git 错误', fk_github_rate_limited: 'GitHub 限流', fk_github_api_error: 'GitHub API 错误', fk_bot_runtime_error: 'Bot 运行错误', fk_invalid_ocr_output: 'OCR 输出无效',
    th_job_id: '任务 ID', th_status: '状态', th_repository: '仓库', th_pr: 'PR', th_actor: '触发者', th_diag_id: '诊断 ID', th_queued: '入队时间', btn_prev: '上一页', btn_next: '下一页',
    back_jobs: '← 任务', h2_job_detail: '任务详情', jd_repo_pr: '仓库 / PR', jd_actor: '触发者', jd_job_id: '任务 ID', jd_diag_id: '诊断 ID',
    jd_queued: '入队时间', jd_started: '开始时间', jd_finished: '结束时间', jd_queue_wait: '排队等待', jd_duration: '耗时', jd_phase_status: '阶段 / 状态',
    jd_head_sha: 'Head SHA', jd_base_sha: 'Base SHA', jd_config_revision: '配置版本', jd_ocr_status: 'OCR 状态',
    jd_runtime: '运行时设置', jd_phase_timeline: '阶段时间线', jd_review_counts: '评论统计', jd_warnings_section: '警告',
    jd_failure: '失败', jd_reporting_error: '上报错误', jd_cleanup_warning: '清理警告', jd_retained_logs: '保留日志', jd_job_diagnostics: '任务诊断',
    jd_generated: '已生成', jd_selected: '已选中', jd_posted: '已发表', jd_omitted: '已省略', jd_warnings_count: '警告',
    empty_none: '无。', empty_runtime: '无运行时设置。', empty_phase_timeline: '无阶段时间线。', empty_logs: '无保留日志。',
    th_time: '时间', th_event: '事件', th_phase: '阶段', th_message: '消息', th_source: '来源', th_level: '级别', th_fields: '字段',
    h2_configuration: '配置', admin_storage_root: '存储', revision: '版本', h2_edit_config: '编辑配置',
    th_field: '字段', th_effective: '生效值', th_edit: '编辑', th_state: '状态', btn_save_config: '保存更改',
    keep_secret: '保留当前密钥', clear_secret: '清除密钥', replace_with: '替换为', reset_override: '重置覆盖', confirm_high_risk: '确认高风险变更',
    not_editable: '控制台不可编辑。', secret_set: '密钥已设', not_set: '未设置', admin_dashboard_enabled: '控制台已启用', admin_dashboard_disabled: '控制台已禁用',
    config_group_service: '服务', config_group_access: '触发与权限', config_group_github: 'GitHub App', config_group_ocr: 'OCR 引擎', config_group_proxy: 'LLM 代理', config_group_admin: '管理控制台', config_group_retention: '保留与存储', config_group_service_desc: '核心运行时、端口与工作目录行为。', config_group_access_desc: '谁可以触发审查，以及允许哪些仓库。', config_group_github_desc: 'GitHub App 身份、私钥路径与 webhook 密钥。', config_group_ocr_desc: 'OpenCodeReview 供应商地址、模型与并发。', config_group_proxy_desc: '内部 LLM 代理路由与上游鉴权。', config_group_admin_desc: '控制台访问、Host 白名单、Cookie 与数据目录。', config_group_retention_desc: '任务、日志、统计与审计的保留时长。',
    config_field_total: '字段', config_override_count: '覆盖项', config_secret_count: '密钥', config_restart_count: '需重启',
    config_no_matches: '没有匹配的配置项。',
    aria_config_filters: '配置筛选', aria_config_groups: '配置分组',
    aria_sections: '区块导航', aria_job_summary: '任务概览', aria_jobs_pages: '任务分页', skip_to_main: '跳到主内容',
    logs_degraded: '日志历史已降级。', pagination_summary: '第 {page} / {total-pages} 页 · {total} 个任务',
  },
};

function themeInitScript(nonce) {
  return scriptTag(`(function(){try{var t=localStorage.getItem('ocr-theme');if(t!=='light'&&t!=='dark'){t='light';}document.documentElement.dataset.theme=t;var l=localStorage.getItem('ocr-lang');if(l!=='en'&&l!=='zh'){l=((navigator.language||'en').toLowerCase().indexOf('zh')===0)?'zh':'en';}document.documentElement.lang=l;}catch(e){document.documentElement.dataset.theme='light';document.documentElement.lang='en';}})();`, nonce);
}

function togglesHtml() {
  return `<div class="toggles"><button type="button" class="toggle-btn" data-act="toggle-theme" data-theme-target aria-label="Toggle theme"><svg class="ic theme-moon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Zm1.616 1.945a7 7 0 0 1-7.678 7.678 5.499 5.499 0 1 0 7.678-7.678Z"/></svg><svg class="ic theme-sun" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5.657-8.157a.75.75 0 0 1 0 1.061l-1.061 1.06a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0ZM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm13 0a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8Zm-8 5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13Zm3.536-1.464a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-1.06-1.06a.75.75 0 0 1 0-1.06Z"/></svg></button><button type="button" class="toggle-btn" data-act="toggle-lang" data-lang-target>中文</button></div>`;
}

export function safeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
function bodyScript(nonce) {
  return scriptTag(`(function(){var I18N=${safeScriptJson(I18N)};function dict(){return I18N[document.documentElement.lang]||I18N.en;}function applyLang(){var d=dict();document.querySelectorAll('[data-i18n]').forEach(function(el){var k=el.getAttribute('data-i18n');if(d[k]!==undefined)el.textContent=d[k];});document.querySelectorAll('[data-i18n-aria-label]').forEach(function(el){var k=el.getAttribute('data-i18n-aria-label');if(d[k]!==undefined)el.setAttribute('aria-label',d[k]);});document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el){var k=el.getAttribute('data-i18n-placeholder');if(d[k]!==undefined)el.setAttribute('placeholder',d[k]);});document.querySelectorAll('[data-i18n-template]').forEach(function(el){var t=d[el.getAttribute('data-i18n-template')];if(t!==undefined){el.textContent=t.split('{page}').join(el.getAttribute('data-page')||'').split('{total-pages}').join(el.getAttribute('data-total-pages')||'').split('{total}').join(el.getAttribute('data-total')||'').split('{visible}').join(el.getAttribute('data-visible')||'');}});document.querySelectorAll('[data-theme-target]').forEach(function(b){var light=document.documentElement.dataset.theme==='light';b.setAttribute('aria-label',light?d.toggle_theme_dark:d.toggle_theme_light);});document.querySelectorAll('[data-lang-target]').forEach(function(b){var zh=document.documentElement.lang==='zh';b.textContent=zh?'EN':'中文';b.setAttribute('aria-label',zh?d.toggle_lang_en:d.toggle_lang_zh);});}function setLang(l){document.documentElement.lang=l;try{localStorage.setItem('ocr-lang',l);}catch(e){}applyLang();}function setTheme(t){document.documentElement.dataset.theme=t;try{localStorage.setItem('ocr-theme',t);}catch(e){}applyLang();}document.addEventListener('click',function(e){var n=e.target.closest&&e.target.closest('[data-act]');if(!n)return;var a=n.getAttribute('data-act');if(a==='toggle-lang')setLang(document.documentElement.lang==='zh'?'en':'zh');else if(a==='toggle-theme')setTheme(document.documentElement.dataset.theme==='light'?'dark':'light');});applyLang();})();`, nonce);
}

function fontLinks() {
  // System font stacks only — no external webfont fetch (self-hosted, offline-friendly).
  return '';
}

function baseStyles() {
  return `:root {
  color-scheme: light;
  /* surface + text primitives — GitHub-light, solid (no glass) */
  --bg: #ffffff;
  --surface: #f6f8fa;
  --surface-2: #eef1f4;
  --surface-3: #e1e5ea;
  --surface-bar: #ffffff;
  --surface-panel: #ffffff;
  --border: #d0d7de;
  --border-bright: #afb8c1;
  --text: #1f2328;
  --muted: #57606a;
  --faint: #636c76;
  /* accent + status — calmer and accessible; soft = fills */
  --cyan: #0969da; --cyan-soft: rgba(9, 105, 218, 0.10);
  --indigo: #6f5ed6; --indigo-soft: rgba(111, 94, 214, 0.10);
  --magenta: #bf3989; --magenta-soft: rgba(191, 57, 137, 0.08);
  --green: #1a7f37; --green-soft: rgba(26, 127, 55, 0.10);
  --amber: #9a6700; --amber-soft: rgba(154, 103, 0, 0.12);
  --red: #cf222e; --red-soft: rgba(207, 34, 46, 0.08);
  /* semantic aliases — components reference these, not the raw palette */
  --ok: var(--green); --warn: var(--amber); --fail: var(--red); --run: var(--cyan); --queued: var(--faint);
  --accent: var(--cyan); --link: var(--cyan); --link-hover: #0550ae; --link-shadow: none;
  --primary-bg: #1f883d; --primary-bg-hover: #1a7f37;
  --brand-gradient: var(--cyan);
  /* radii, motion, elevation — Primer-ish */
  --radius: 6px; --radius-sm: 6px; --radius-pill: 999px;
  --lift-1: 1px; --lift-2: 2px;
  --t-fast: 120ms; --t-med: 160ms; --t-slow: 220ms;
  --ease: cubic-bezier(0.2, 0, 0, 1);
  --shadow-card: 0 1px 2px rgba(31, 35, 40, 0.06);
  --shadow-card-hover: 0 4px 12px rgba(31, 35, 40, 0.10);
  --shadow-pop: 0 4px 12px rgba(31, 35, 40, 0.12);
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  /* probe design-system aliases (GitHub Primer light) — dashboard + shared components */
  --bg-subtle: var(--surface);
  --bg-inset: #eef1f3;
  --bg-over: #e1e5ea;
  --fg: var(--text); --fg-muted: var(--muted); --fg-subtle: var(--faint);
  --accent-subtle: var(--cyan-soft); --accent-border: rgba(9, 105, 218, 0.35);
  --success: var(--green); --success-subtle: #dafbe1; --success-border: rgba(26, 127, 55, .35);
  --attention: var(--amber); --attention-subtle: #fff8c5; --attention-border: rgba(154, 103, 0, .35);
  --danger: var(--red); --danger-subtle: #ffebe9; --danger-border: rgba(207, 34, 46, .35);
  --done: #8250df; --done-subtle: #fbefff;
  --neutral-fg: var(--muted); --neutral-subtle: #eaeef2;
  --btn-border: rgba(31, 35, 40, .15);
  --r: var(--radius-sm); --r-lg: var(--radius);
  --shadow-flat: 0 1px 0 rgba(31, 35, 40, .04);
}
* { box-sizing: border-box; }
::selection { background: var(--cyan-soft); color: var(--text); }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: var(--radius-pill); border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: var(--border-bright); background-clip: padding-box; }

html { scrollbar-gutter: stable; }

body {
  margin: 0;
  background-color: var(--bg-subtle);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
p { margin: 0.75rem 0; }
a { color: var(--link); text-decoration: none; transition: color var(--t-fast) var(--ease), text-shadow var(--t-fast) var(--ease); }
a:hover { color: var(--link-hover); text-shadow: var(--link-shadow); }
code { font-family: var(--font-mono); background: var(--surface); padding: 0.15em 0.4em; border-radius: var(--radius-sm); color: var(--text); font-size: 0.9em; border: 1px solid var(--border); }
pre { margin: 0.8rem 0; padding: 1rem; white-space: pre-wrap; word-break: break-word; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); font-family: var(--font-mono); font-size: 13px; }
h1, h2, h3, h4 { font-weight: 600; letter-spacing: -0.02em; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

.skip-link { position: absolute; left: -9999px; top: 0; z-index: 100; background: var(--accent); color: #04121b; padding: 0.65rem 1.1rem; border-radius: var(--radius-sm); font-weight: 600; font-size: 13px; box-shadow: var(--shadow-pop); }
.skip-link:focus { left: 1rem; top: 1rem; }
.vh { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (pointer: coarse) { button, .toggle-btn, .signout button, .chip, nav.pagination a, .filter-reset, .login-form button { min-height: 44px; } }

.app { display: grid; grid-template-columns: 248px 1fr; min-height: 100vh; }
.side {
  position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto;
  background: var(--bg); border-right: 1px solid var(--border);
  padding: 20px 16px; display: flex; flex-direction: column; gap: 24px;
}
.side .brand {
  display: flex; align-items: center; gap: 9px; padding: 4px 6px;
  font-size: 15px; font-weight: 650; color: var(--text); text-decoration: none; letter-spacing: -0.01em;
}
.side .brand .mark {
  width: 28px; height: 28px; border-radius: 7px; background: var(--text); color: #fff;
  display: grid; place-items: center; font-weight: 700; font-size: 13px; letter-spacing: -0.02em; flex: none;
}
.side .brand-name { font-weight: 650; }
.side .brand-tag {
  margin-left: auto; font-size: 11px; font-weight: 500; color: var(--faint);
  border: 1px solid var(--border); padding: 1px 7px; border-radius: 20px; line-height: 1.4;
}
.side .brand:hover { text-decoration: none; }
.side .brand:hover .mark { opacity: 0.88; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav a {
  display: flex; align-items: center; gap: 8px; color: var(--text); text-decoration: none;
  padding: 7px 10px; border-radius: var(--radius-sm); font-size: 14px; font-weight: 500;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.nav a:hover { background: var(--surface); text-decoration: none; }
.nav a.active { background: var(--accent-subtle); color: var(--accent); font-weight: 600; }
.nav a .ic { width: 16px; height: 16px; opacity: 0.72; flex: none; }
.nav a.active .ic { opacity: 1; }
.toggle-btn .ic { width: 16px; height: 16px; flex: none; display: none; }
:root[data-theme="light"] .toggle-btn .theme-moon { display: block; }
:root[data-theme="dark"] .toggle-btn .theme-sun { display: block; }
.nav a .nav-text { min-width: 0; }
.side-foot { margin-top: auto; font-size: 11px; color: var(--faint); padding: 8px 10px; }
@keyframes blink { to { visibility: hidden; } }

.main { display: flex; flex-direction: column; min-width: 0; min-height: 100vh; }
header.topbar {
  position: sticky; top: 0; z-index: 40; display: flex; align-items: center; gap: 16px;
  padding: 12px 28px; background: var(--bg); border-bottom: 1px solid var(--border);
}
.topbar .crumb { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--muted); }
.topbar .crumb .muted { color: var(--muted); }
.topbar .crumb .sep { color: var(--faint); }
.topbar .crumb .crumb-current { color: var(--text); font-weight: 600; }
.topbar-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.toggles { display: inline-flex; align-items: center; gap: 8px; }
.toggle-btn, .signout button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: inherit; font-size: 13px; font-weight: 500; color: var(--text);
  background: var(--surface); border: 1px solid var(--btn-border);
  padding: 5px 12px; border-radius: var(--radius-sm); cursor: pointer;
  text-transform: none; letter-spacing: 0; min-height: 32px;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.toggle-btn:hover, .signout button:hover {
  background: var(--surface-2); border-color: var(--border-bright); color: var(--text);
  transform: none; box-shadow: none;
}
.signout { margin: 0; }
.signout button:hover { color: var(--danger); border-color: var(--danger-border); background: var(--danger-subtle); }
h1.page-title { font-size: 24px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 4px; color: var(--text); line-height: 1.25; }

.content { padding: 24px 32px 64px; max-width: 1216px; width: 100%; }
main.centered { max-width: 500px; margin: 0 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; }
.back { margin: 0 0 1.5rem; }
.back a { color: var(--muted); font-weight: 500; padding: 0.4rem 0.8rem; background: var(--surface); border-radius: var(--radius-sm); border: 1px solid var(--border); transition: color var(--t-fast) var(--ease), background var(--t-fast) var(--ease); }
.back a:hover { color: var(--text); background: var(--surface-2); text-decoration: none; }

@media (max-width: 860px) {
  .app { grid-template-columns: 1fr; }
  .side {
    position: static; height: auto; flex-direction: column; align-items: stretch;
    gap: 12px; padding: 12px 14px; border-right: 0; border-bottom: 1px solid var(--border); overflow: visible;
  }
  .side .brand { padding: 0; }
  .side .brand-tag { display: none; }
  .nav { flex-direction: row; flex-wrap: wrap; gap: 2px; }
  .side-foot { display: none; }
  header.topbar { padding: 10px 16px; }
  .content { padding: 18px 16px 48px; }
}

/* Static container by default — display-only cards must not look pressable. */
.card {
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); margin-bottom: 1.5rem; padding: 1.5rem;
  box-shadow: var(--shadow-card);
}
.card > h2, .card > h3, .card > summary > h2 {
  font-size: 14px; font-weight: 650; letter-spacing: -0.01em; color: var(--text); margin: 0 0 1rem;
  padding: 0; background: transparent; border: 0; border-radius: 0;
  display: flex; align-items: center; gap: 0.5rem;
}
.card > h2::before, .card > summary > h2::before { content: none; }
.card > h3 { margin: 1.5rem 0 0.75rem; font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); padding: 0; border: 0; }
.card > *:last-child { margin-bottom: 0; }

dl { display: grid; grid-template-columns: minmax(140px, max-content) 1fr; gap: 0.8rem 1.5rem; align-items: center; }
dt { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
dd { margin: 0; color: var(--text); font-size: 14px; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }

.strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
.strip .cell { padding: 1.5rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; position: relative; overflow: hidden; }
.strip .cell::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: transparent; }
.strip .num { font-size: 2.5rem; font-weight: 700; line-height: 1; font-family: var(--font-sans); font-variant-numeric: tabular-nums; }
.strip .num.ok { color: var(--ok); }
.strip .cell--ok::before { background: var(--ok); }
.strip .num.warn { color: var(--warn); }
.strip .cell--warn::before { background: var(--warn); }
.strip .num.fail { color: var(--fail); }
.strip .cell--fail::before { background: var(--fail); }
.strip .num.run { color: var(--run); }
.strip .cell--run::before { background: var(--run); }
.strip .num.queued { color: var(--queued); }
.strip .cell--queued::before { background: var(--queued); }
.strip .lab { text-transform: uppercase; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; color: var(--muted); margin-top: 0.75rem; }

.table-scroll { overflow-x: auto; margin: 0.5rem 0; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 0.55rem 0.9rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: middle; }
thead th { text-align: left; font-size: 12px; font-weight: 600; color: var(--muted); padding: 9px 14px; border-bottom: 1px solid var(--border); background: var(--bg); white-space: nowrap; }
tbody tr { transition: background var(--t-fast) var(--ease); }
tbody tr:hover { background: var(--surface); }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

button, input, select { font-family: var(--font-sans); color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.5rem 0.75rem; font-size: 13.5px; transition: color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease), transform var(--t-fast) var(--ease); }
button { cursor: pointer; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; text-transform: uppercase; font-size: 11px; letter-spacing: 0.08em; }
button:hover { border-color: var(--accent); background: var(--cyan-soft); transform: translateY(calc(-1 * var(--lift-1))); box-shadow: var(--shadow-pop); }
button.primary { background: var(--primary-bg); color: #fff; border: 1px solid rgba(31, 35, 40, 0.15); font-weight: 600; padding: 0.45rem 0.95rem; box-shadow: var(--shadow-flat); text-transform: none; letter-spacing: 0; min-height: 32px; }
button.primary:hover { background: var(--primary-bg-hover); opacity: 1; transform: none; box-shadow: var(--shadow-flat); }
button.primary:active { background: var(--primary-bg-hover); }
.filter-reset { font-family: var(--font-sans); font-size: 11px; font-weight: 600; line-height: normal; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; padding: 0.6rem 1.2rem; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); display: inline-flex; align-items: center; justify-content: center; text-decoration: none; transition: color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease), transform var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease); }
.filter-reset:hover { color: var(--text); border-color: var(--accent); background: var(--cyan-soft); transform: translateY(calc(-1 * var(--lift-2))); box-shadow: var(--shadow-pop); }
.filter-reset:active { transform: translateY(0); box-shadow: none; }

input:focus, select:focus, textarea:focus { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 2px; }
input[type=radio], input[type=checkbox] { accent-color: var(--accent); width: 1.2em; height: 1.2em; cursor: pointer; }

.inline { display: flex; gap: 1rem; align-items: flex-end; flex-wrap: wrap; background: var(--surface); padding: 1.25rem; border-radius: var(--radius); border: 1px solid var(--border); margin-bottom: 1.5rem; }
.inline label { display: grid; gap: 0.4rem; font-size: 11px; text-transform: uppercase; font-weight: 600; color: var(--muted); }
.inline input, .inline select { min-width: 140px; }
.inline .field-group { display: flex; gap: 1rem; }

.alert { display: flex; gap: 0.75rem; background: var(--red-soft); border: 1px solid var(--red); color: var(--text); padding: 0.85rem 1rem; border-radius: var(--radius); margin-bottom: 1rem; }
.alert::before { content: "!"; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; background: var(--fail); color: #0b0b0b; font-weight: bold; border-radius: 50%; font-size: 12px; flex-shrink: 0; }
.alert.success { background: var(--green-soft); border-color: var(--green); }
.alert.success::before { content: "\\2713"; background: var(--ok); }
.alert ul { margin: 0; padding-left: 1.5rem; width: 100%; }

.pill { display: inline-flex; align-items: center; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-pill); padding: 0.2rem 0.6rem; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text); margin: 0.2rem; transition: background var(--t-fast) var(--ease); }
.pill--ok { color: var(--ok); border-color: var(--green); background: var(--green-soft); }
.pill--warn { color: var(--warn); border-color: var(--amber); background: var(--amber-soft); }
.pill--err { color: var(--fail); border-color: var(--red); background: var(--red-soft); }

/* status dot + pill — GitHub Primer, global (shared by dashboard, jobs, job detail) */
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; background: var(--fg-subtle); box-shadow: none; }
.dot.ok { background: var(--success); } .dot.run { background: var(--accent); animation: pulse 1.6s var(--ease) infinite; }
.dot.warn { background: var(--attention); } .dot.err { background: var(--danger); } .dot.idle { background: var(--fg-subtle); }
.dpill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; line-height: 1; padding: 4px 10px; border-radius: 20px; border: 1px solid transparent; white-space: nowrap; }
.dpill .dot { width: 7px; height: 7px; }
.dpill.ok { background: var(--success-subtle); color: var(--success); border-color: var(--success-border); }
.dpill.run { background: var(--accent-subtle); color: var(--accent); border-color: var(--accent-border); }
.dpill.queued { background: var(--neutral-subtle); color: var(--neutral-fg); }
.dpill.warn { background: var(--attention-subtle); color: var(--attention); border-color: var(--attention-border); }
.dpill.fail { background: var(--danger-subtle); color: var(--danger); border-color: var(--danger-border); }
.dpill.skip { background: var(--done-subtle); color: var(--done); }

/* filter chips + list-card shell — GitHub Primer */
.chip { font-family: inherit; font-size: 12px; font-weight: 500; line-height: 1.4; padding: 4px 11px; border-radius: 20px; border: 1px solid var(--border); color: var(--fg-muted); background: var(--bg); cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; text-decoration: none; appearance: none; -webkit-appearance: none; transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease); }
.chip:hover { background: var(--bg-subtle); border-color: var(--border-bright); color: var(--fg); text-decoration: none; }
.chip.on { background: var(--accent-subtle); color: var(--accent); border-color: var(--accent-border); font-weight: 600; }
.btn-sm { min-height: 30px; padding: 4px 12px; font-size: 12px; }
.tablewrap { border: 1px solid var(--border); border-radius: var(--r-lg); overflow: hidden; background: var(--bg); }
.tablewrap .bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--bg); }
.tablewrap .bar .count { margin-left: auto; font-size: 12px; color: var(--fg-subtle); }
.tablewrap .bar.bar-foot { border-top: 1px solid var(--border); border-bottom: 0; }


/* GitHub-style settings */
.settings { display: grid; gap: 16px; }
.settings-meta {
  display: flex; flex-wrap: wrap; gap: 6px 14px; margin: -4px 0 4px; font-size: 12px; align-items: center;
}
.settings-meta code { font-size: 11px; padding: 0.1em 0.35em; }
.settings-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; align-items: start; }
.settings-subnav { position: sticky; top: 4.5rem; display: grid; gap: 2px; }
.settings-subnav-link {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 8px 12px; border-radius: var(--radius-sm); color: var(--text); text-decoration: none;
  font-size: 14px; font-weight: 500; border: 1px solid transparent;
}
.settings-subnav-link:hover { background: var(--surface); text-decoration: none; }
.settings-subnav-link.is-active { background: var(--accent-subtle); color: var(--accent); font-weight: 600; }
.settings-count {
  display: inline-flex; min-width: 1.4rem; justify-content: center; padding: 1px 7px;
  border-radius: 20px; border: 1px solid var(--border); background: var(--surface);
  color: var(--muted); font-size: 11px; font-family: var(--font-mono);
}
.settings-panel {
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg);
  box-shadow: var(--shadow-flat); overflow: hidden;
}
.settings-panel-head, .settings-panel-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 16px; background: var(--bg);
}
.settings-panel-head { border-bottom: 1px solid var(--border); align-items: flex-start; }
.settings-panel-foot { border-top: 1px solid var(--border); }
.settings-panel-title { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.settings-panel-count { margin: 0; font-size: 12px; }
.settings-list { display: grid; }
.settings-item { padding: 16px; border-bottom: 1px solid var(--border); }
.settings-item:last-child { border-bottom: 0; }
.settings-item-main { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(280px, 0.9fr); gap: 20px; align-items: start; }
.settings-item-copy .field-label { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
.settings-item-copy code { display: inline-block; margin: 0 0 8px; font-size: 12px; }
.settings-item-copy p { margin: 0 0 10px; font-size: 13px; line-height: 1.5; }
.settings-item-meta { display: flex; flex-wrap: wrap; gap: 4px; }
.settings-item-value { display: grid; gap: 10px; }
.settings-effective { min-height: 1.4em; }
.settings-control .config-control { width: 100%; }
.settings-actions { display: grid; gap: 6px; }
.settings-actions .nowrap { margin-top: 0; white-space: normal; }
.config-control { width: 100%; font-family: var(--font-mono); }
@media (max-width: 960px) {
  .settings-layout { grid-template-columns: 1fr; }
  .settings-subnav { position: static; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
  .settings-item-main { grid-template-columns: 1fr; }
}
.stack { display: grid; gap: 0.6rem; }
.stack label { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 13.5px; text-transform: none; font-weight: normal; letter-spacing: 0; }

ul.diagnostics { list-style: none; margin: 0; padding: 0; }
ul.diagnostics li { padding: 0.85rem 0; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 0.8rem; align-items: center; }
ul.diagnostics li:last-child { border-bottom: 0; }
ul.diagnostics .diag-msg { flex: 1; min-width: 200px; color: var(--muted); }

nav.pagination { display: flex; gap: 1rem; align-items: center; justify-content: center; padding: 1.5rem 0 0; border-top: 1px solid var(--border); margin-top: 1.5rem; }
nav.pagination a { padding: 0.4rem 1rem; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font-weight: 500; font-size: 13px; background: var(--surface-2); transition: color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease), transform var(--t-fast) var(--ease), text-decoration var(--t-fast) var(--ease); }
nav.pagination a:hover { border-color: var(--accent); color: var(--accent); background: var(--cyan-soft); transform: translateY(calc(-1 * var(--lift-1))); text-decoration: none; }
nav.pagination span { font-size: 13px; color: var(--muted); }
nav.pagination span[aria-disabled=true] { opacity: 0.5; }

.login-body { min-height: 100vh; background: var(--bg-subtle); }
.login-shell { min-height: 100vh; display: grid; place-items: center; padding: 32px 16px 48px; }
.login-toolbar { position: absolute; top: 16px; right: 16px; }
.login-card {
  width: min(100%, 360px); background: var(--bg); border: 1px solid var(--border);
  border-radius: 12px; padding: 28px 28px 24px; box-shadow: var(--shadow-flat);
}
.login-brand { display: flex; align-items: center; gap: 10px; margin: 0 0 18px; }
.login-brand .mark {
  width: 28px; height: 28px; border-radius: 7px; background: var(--text); color: #fff;
  display: grid; place-items: center; font-weight: 700; font-size: 13px;
}
.login-brand-name { font-size: 14px; font-weight: 600; color: var(--text); }
.login-title { margin: 0 0 4px; font-size: 24px; font-weight: 600; letter-spacing: -0.02em; }
.login-sub { margin: 0 0 20px; font-size: 14px; }
.login-form { display: grid; gap: 8px; }
.login-form label { font-size: 14px; font-weight: 600; color: var(--text); }
.login-form input {
  width: 100%; min-height: 32px; padding: 5px 12px; background: var(--bg);
  border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px;
}
.login-form input:focus { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 2px; }
.login-form button.primary { width: 100%; margin-top: 8px; justify-self: stretch; }

main > *:first-child { margin-top: 0; }

details.card > summary { cursor: pointer; list-style: none; display: block; }
details.card > summary::-webkit-details-marker { display: none; }
details.card > summary > h2 { transition: background var(--t-fast) var(--ease); }
details.card > summary:hover > h2 { background: var(--surface-3); }
details.card > summary > h2::after { content: "\\2192"; margin-left: auto; font-family: sans-serif; transition: transform var(--t-slow) var(--ease); font-size: 14px; }
details.card[open] > summary > h2::after { transform: rotate(90deg); }

.empty { color: var(--muted); font-style: italic; }
.danger { color: var(--fail); }
.nowrap { display: block; white-space: nowrap; margin-top: 0.35rem; }

.toggles { display: flex; gap: 0.4rem; margin-left: 0.5rem; }
.toggle-btn { font-size: 13px; font-weight: 600; min-width: 36px; padding: 0.4rem 0.55rem; line-height: 1; }
.toggle-btn:hover { color: var(--accent); border-color: var(--accent); transform: none; }

/* Tablet: tighten the topbar so brand + nav + actions stay on one row. */
@media (max-width: 1024px) {
  header.topbar { gap: 0.75rem; padding: 0.75rem 1rem; }
  main { padding: 1.5rem 1rem 4rem; }
}
@media (max-width: 768px) {
  header.topbar { flex-wrap: wrap; align-items: center; padding: 0.75rem 1rem; gap: 0.75rem; }
  .signout { order: 2; margin-left: auto; }
  .toggles { order: 2; }
  .strip { grid-template-columns: repeat(2, 1fr); }
  dl { grid-template-columns: 1fr; gap: 0.2rem; }
  dl dt { margin-top: 0.8rem; border-bottom: none; padding-bottom: 0; }
  dl dd { padding-top: 0; }
  .inline { flex-direction: column; align-items: stretch; }
  .inline input, .inline select { width: 100%; }
}

/* Phone: hit targets grow to 44px, density relaxes. */
@media (max-width: 480px) {
  header.topbar { padding: 0.6rem 0.75rem; }
  .brand { font-size: 16px; }
  main { padding: 1.25rem 0.75rem 4rem; }
  .strip { grid-template-columns: 1fr; }
  .strip .num { font-size: 2rem; }
  .card { padding: 1.25rem; }
  .card > h2, .card > summary > h2 { margin: -1.25rem -1.25rem 1.25rem; padding: 0.85rem 1.25rem; }
  .signout button, .toggle-btn, nav.pagination a, .filter-reset, button { min-height: 44px; }
  .toggle-btn { min-width: 44px; }
}


/* Primer polish */
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin: 0 0 16px; }
.page-header-link { flex: none; margin-top: 2px; font-size: 13px; font-weight: 500; color: var(--accent); text-decoration: none; white-space: nowrap; }
.page-header-link:hover { text-decoration: underline; }
.page-desc { margin: 0; font-size: 14px; max-width: 62ch; line-height: 1.5; color: var(--muted); }
.metrics-page, .jobs-page { display: grid; gap: 16px; }
.metrics-page > .page-desc, .jobs-page > .page-desc { margin: 0; }
.box { border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); box-shadow: var(--shadow-flat); overflow: hidden; margin: 0; }
.box-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg); }
.box-header strong { font-size: 14px; font-weight: 600; }
.box-header-meta { font-size: 12px; }
.box-body { padding: 12px 16px; }
.box-grid { display: grid; gap: 16px; }
.box-grid.twocol, .box-grid.sfl { grid-template-columns: 1fr 1fr; }
.kv-list { display: grid; gap: 0; }
.kv-list .kv { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.kv-list .kv:last-child { border-bottom: 0; padding-bottom: 0; }
.kv-list .kv:first-child { padding-top: 0; }
.kv-list .k { color: var(--muted); font-weight: 600; flex: none; }
.kv-list .v { color: var(--text); text-align: right; word-break: break-word; }
.box-footer { padding: 10px 16px; border-top: 1px solid var(--border); background: var(--surface); }
.filter-body { background: var(--surface); border-bottom: 1px solid var(--border); }
.gh-filter { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin: 0; padding: 0; background: transparent; border: 0; }
.gh-filter label { display: grid; gap: 4px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: none; letter-spacing: 0; }
.gh-filter input, .gh-filter select { min-width: 140px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 5px 10px; min-height: 32px; font-size: 14px; }
.gh-filter .primary, .gh-filter .filter-reset { min-height: 32px; }
.filter-reset {
  font-family: var(--font-sans); font-size: 13px; font-weight: 500; line-height: normal; color: var(--text);
  text-transform: none; letter-spacing: 0; padding: 5px 12px; border: 1px solid var(--btn-border);
  border-radius: var(--radius-sm); background: var(--surface); display: inline-flex; align-items: center; justify-content: center;
  text-decoration: none;
}
.filter-reset:hover { color: var(--text); border-color: var(--border-bright); background: var(--surface-2); transform: none; box-shadow: none; text-decoration: none; }
.gh-table-wrap { margin: 0; }
.gh-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
.gh-table th, .gh-table td { padding: 10px 14px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: middle; }
.gh-table thead th {
  text-transform: none; letter-spacing: 0; font-size: 12px; font-weight: 600; color: var(--fg-muted);
  background: var(--bg); border-top: 0; border-left: 0; border-right: 0; white-space: nowrap;
}
.gh-table tbody tr:hover { background: var(--bg-subtle); }
.gh-table tbody tr:last-child td { border-bottom: 0; }
.gh-table .repo { font-weight: 500; }
.gh-table .subtle, code.subtle { color: var(--muted); }
.gh-table .nowrap-cell { white-space: nowrap; }
.mono-link code { color: var(--accent); background: transparent; border: 0; padding: 0; }
.mono-link:hover code { text-decoration: underline; }
.empty-state { padding: 28px 16px; text-align: center; color: var(--muted); font-style: normal; }
.jobs-page .tablewrap { margin-bottom: 16px; }
.job-filters { margin: 0; }
.job-filters .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.adv-filters > summary { list-style: none; cursor: pointer; padding: 8px 14px; font-size: 12px; font-weight: 600; color: var(--fg-muted); display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--border); background: var(--bg); }
.adv-filters > summary::-webkit-details-marker { display: none; }
.adv-filters > summary::before { content: ''; width: 0; height: 0; border-left: 4px solid currentColor; border-top: 4px solid transparent; border-bottom: 4px solid transparent; transition: transform var(--t-fast) var(--ease); }
.adv-filters[open] > summary::before { transform: rotate(90deg); }
.adv-filters[open] > summary { background: var(--bg-subtle); }
.adv-grid { display: flex; flex-wrap: wrap; gap: 10px 12px; align-items: flex-end; padding: 12px 14px; background: var(--bg-subtle); border-bottom: 1px solid var(--border); }
.adv-grid > label { display: grid; gap: 4px; font-size: 11px; font-weight: 600; color: var(--fg-muted); }
.adv-grid input, .adv-grid select { min-width: 132px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 5px 9px; min-height: 30px; font-size: 13px; color: var(--text); font-family: inherit; }
.adv-grid input:focus, .adv-grid select:focus { outline: 2px solid var(--accent); outline-offset: 2px; border-color: var(--accent); }
.adv-grid .adv-actions { display: flex; gap: 8px; align-items: center; margin-left: auto; }
.adv-flag { pointer-events: none; padding: 1px 7px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
nav.pagination { margin: 0; padding: 0; border: 0; justify-content: flex-start; gap: 12px; }
nav.pagination a, nav.pagination span[aria-disabled=true] {
  min-height: 32px; padding: 5px 12px; border-radius: var(--radius-sm); background: var(--bg);
  border: 1px solid var(--border); font-size: 13px; text-transform: none; letter-spacing: 0;
}
nav.pagination a:hover { transform: none; background: var(--surface); }
button, .toggle-btn, .signout button { text-transform: none; letter-spacing: 0; }
button { background: var(--surface); border: 1px solid var(--btn-border); min-height: 32px; padding: 5px 12px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; }
button:hover { transform: none; box-shadow: none; background: var(--surface-2); border-color: var(--border-bright); }
.dashboard .status-grid { margin-bottom: 12px; }
.dashboard .sect { margin-top: 24px; }
.dashboard .sect:first-child { margin-top: 0; }
.dashboard .sect > h2 { font-size: 16px; font-weight: 600; margin: 0 0 12px; letter-spacing: -0.01em; text-transform: none; }
.dashboard .sect > h3 { font-size: 14px; font-weight: 600; text-transform: none; letter-spacing: -0.01em; color: var(--text); margin: 0 0 10px; }
.dashboard .metric-row { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.settings-panel-head .primary, .settings-panel-foot .primary { min-width: 132px; }
.settings-item:hover { background: var(--bg-subtle); }
.settings-panel-desc { margin: 4px 0 0; font-size: 13px; line-height: 1.45; max-width: 62ch; }
.pill { text-transform: none; letter-spacing: 0; font-size: 12px; font-weight: 500; padding: 2px 8px; margin: 0 4px 4px 0; }
.card { box-shadow: var(--shadow-flat); }
.inline { background: transparent; border: 0; padding: 0; margin: 0; }


/* Job detail */
.job-detail { display: grid; gap: 16px; }
.job-detail .back { margin: 0; }
.back-link {
  display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-weight: 500;
  padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg);
}
.back-link:hover { color: var(--text); background: var(--surface); text-decoration: none; }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0; }
.detail-grid.compact { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.detail-item { padding: 10px 0; border-bottom: 1px solid var(--border); display: grid; gap: 4px; }
.detail-item .k { font-size: 12px; color: var(--muted); font-weight: 600; }
.detail-item .v { font-size: 14px; color: var(--text); word-break: break-word; }
.detail-item:nth-last-child(-n+2) { border-bottom: 0; }
.detail-grid.compact .detail-item { border-bottom: 0; }
.settings-panel-desc { margin: 4px 0 6px; font-size: 13px; line-height: 1.45; max-width: 62ch; }
.box-header .bar-link { font-size: 13px; font-weight: 500; }
@media (max-width: 900px) {
  .detail-grid, .detail-grid.compact { grid-template-columns: 1fr; }
  .detail-item:nth-last-child(-n+2) { border-bottom: 1px solid var(--border); }
  .detail-item:last-child { border-bottom: 0; }
}


.dashboard .sect-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 12px; }
.dashboard .sect-head h2 { margin: 0; }
.metrics-page .metric-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0 0 4px; }
.metrics-page .dmetric { border: 1px solid var(--border); border-radius: var(--r); padding: 11px 13px; background: var(--bg); }
.metrics-page .dmetric .k { font-size: 11px; color: var(--fg-muted); }
.metrics-page .dmetric .v { font-size: 18px; font-weight: 650; margin-top: 3px; letter-spacing: -0.01em; }
.metrics-page .dmetric .sub { font-size: 11px; color: var(--fg-subtle); margin-top: 1px; }
@media (max-width: 860px) {
  .metrics-page .metric-row { grid-template-columns: repeat(2, 1fr); }
}

/* Calm dark theme (toggle opt-in) — low-chroma, no neon. Components inherit the shared rules. */
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #1f2328;
  --surface: #25272e;
  --surface-2: #2d3037;
  --surface-3: #3a3f47;
  --surface-bar: #1c2128;
  --surface-panel: #22272e;
  --border: #3a3f47;
  --border-bright: #4b5159;
  --text: #d6dbe1;
  --muted: #94a1ad;
  --faint: #7a8794;
  --cyan: #58a6ff; --cyan-soft: rgba(88, 166, 255, 0.14);
  --indigo: #8a7ff0; --indigo-soft: rgba(138, 127, 240, 0.14);
  --magenta: #c66fb0; --magenta-soft: rgba(198, 111, 176, 0.10);
  --green: #56d364; --green-soft: rgba(86, 211, 100, 0.12);
  --amber: #f2cc60; --amber-soft: rgba(242, 204, 96, 0.12);
  --red: #ff7b72; --red-soft: rgba(255, 123, 114, 0.12);
  --link: var(--cyan); --link-hover: #79c0ff;
  --primary-bg: #238636; --primary-bg-hover: #2ea043;
  --success: var(--green); --success-subtle: rgba(86, 211, 100, 0.12); --success-border: rgba(86, 211, 100, 0.40);
  --attention: var(--amber); --attention-subtle: rgba(242, 204, 96, 0.12); --attention-border: rgba(242, 204, 96, 0.40);
  --danger: var(--red); --danger-subtle: rgba(255, 123, 114, 0.12); --danger-border: rgba(255, 123, 114, 0.40);
  --done: #d2a8ff; --done-subtle: rgba(210, 168, 255, 0.12);
  --neutral-subtle: rgba(148, 161, 173, 0.16); --neutral-fg: #c9d1d9;
  --accent-subtle: var(--cyan-soft); --accent-border: rgba(88, 166, 255, 0.40);
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.30);
  --shadow-card-hover: 0 4px 12px rgba(0, 0, 0, 0.40);
  --shadow-pop: 0 6px 16px rgba(0, 0, 0, 0.45);
}

.muted { color: var(--muted); }
.field-meta { margin-bottom: 0.5rem; }
/* ===== Dashboard — probe design system, scoped under .dashboard ===== */
.dashboard .sect { margin-top: 28px; }
.dashboard .sect > h2 { font-size: 14px; font-weight: 650; margin: 0 0 12px; color: var(--fg); }
.dashboard .sect > h3 { font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-muted); margin: 18px 0 8px; }
.dashboard .status-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.dashboard .st { border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--bg); padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
.dashboard .st .k { font-size: 12px; color: var(--fg-muted); display: flex; align-items: center; gap: 6px; }
.dashboard .st .v { font-size: 14px; font-weight: 600; color: var(--fg); }
.dashboard .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
.dashboard .dot.ok { background: var(--success); } .dashboard .dot.run { background: var(--accent); }
.dashboard .dot.warn { background: var(--attention); } .dashboard .dot.err { background: var(--danger); } .dashboard .dot.idle { background: var(--fg-subtle); }
.dashboard .dpill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; line-height: 1; padding: 4px 9px; border-radius: 20px; border: 1px solid transparent; white-space: nowrap; }
.dashboard .dpill .dot { width: 7px; height: 7px; }
.dashboard .dpill.ok { background: var(--success-subtle); color: var(--success); border-color: var(--success-border); }
.dashboard .dpill.run { background: var(--accent-subtle); color: var(--accent); border-color: var(--accent-border); }
.dashboard .dpill.queued { background: var(--neutral-subtle); color: var(--neutral-fg); }
.dashboard .dpill.warn { background: var(--attention-subtle); color: var(--attention); border-color: var(--attention-border); }
.dashboard .dpill.fail { background: var(--danger-subtle); color: var(--danger); border-color: var(--danger-border); }
.dashboard .dpill.skip { background: var(--done-subtle); color: var(--done); }
.dashboard .twocol, .dashboard .box-grid.twocol, .dashboard .box-grid.sfl { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.dashboard .dcard { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow-flat); }
.dashboard .dcard .bd { padding: 14px 16px; }
.dashboard .status-details { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 12px; }
.dashboard .status-group { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow-flat); }
.dashboard .status-group-label { padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--surface); font-size: 12px; font-weight: 600; color: var(--fg-muted); }
.dashboard .status-group .kv { padding: 7px 14px; }
.dashboard .dcard .hd { padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg); font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.dashboard .subhead { font-size: 13px; font-weight: 600; margin: 0 0 8px; }
.dashboard .kv { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.dashboard .kv:last-child { border-bottom: 0; }
.dashboard .kv .k { color: var(--fg-muted); }
.dashboard .kv .v { font-weight: 500; text-align: right; }
.dashboard .phase { display: flex; gap: 4px; margin-top: 10px; }
.dashboard .phase span { flex: 1; height: 6px; border-radius: 3px; background: var(--bg-inset); }
.dashboard .phase span.done { background: var(--success); } .dashboard .phase span.cur { background: var(--accent); }
.dashboard .qlist { display: flex; flex-direction: column; }
.dashboard .qrow { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.dashboard .qrow:last-child { border-bottom: 0; }
.dashboard .qrow .repo { font-weight: 500; }
.dashboard .sfl { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.dashboard .big { font-weight: 650; font-size: 13px; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
.dashboard .meta { color: var(--fg-subtle); font-size: 12px; }
.dashboard .tablewrap { border: 1px solid var(--border); border-radius: var(--r-lg); overflow: hidden; background: var(--bg); }
.dashboard .bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--bg); }
.dashboard .bar-label { font-size: 13px; font-weight: 600; color: var(--fg); }
.dashboard .count { font-size: 12px; color: var(--fg-subtle); }
.dashboard .bar-link { margin-left: auto; font-size: 12px; color: var(--accent); text-decoration: none; }
.dashboard .bar-link:hover { text-decoration: underline; }
.dashboard table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dashboard thead th { text-align: left; font-size: 12px; font-weight: 600; color: var(--fg-muted); padding: 9px 14px; border-bottom: 1px solid var(--border); background: var(--bg); white-space: nowrap; }
.dashboard tbody td { padding: 9px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.dashboard tbody tr:last-child td { border-bottom: 0; }
.dashboard tbody tr:hover { background: var(--bg-subtle); }
.dashboard td.repo, .dashboard .repo { font-weight: 500; }
.dashboard td.subtle, .dashboard .subtle { color: var(--fg-subtle); }
.dashboard .trend { display: flex; align-items: flex-end; gap: 6px; height: 120px; padding: 6px 2px 0; }
.dashboard .tbar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 6px; height: 100%; }
.dashboard .tbar i { display: block; width: 100%; max-width: 26px; border-radius: 3px 3px 0 0; background: var(--accent); opacity: 0.85; }
.dashboard .tbar.fail i { background: var(--danger); }
.dashboard .tbar.idle i { background: var(--bg-over); }
.dashboard .tbar .d { font-size: 10px; color: var(--fg-subtle); }
.dashboard .metric-row, .metrics-page .metric-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.dashboard .dmetric, .metrics-page .dmetric { border: 1px solid var(--border); border-radius: var(--r); padding: 11px 13px; background: var(--bg); }
.dashboard .dmetric .k, .metrics-page .dmetric .k { font-size: 11px; color: var(--fg-muted); }
.dashboard .dmetric .v, .metrics-page .dmetric .v { font-size: 18px; font-weight: 650; margin-top: 3px; letter-spacing: -0.01em; }
.dashboard .dmetric .sub, .metrics-page .dmetric .sub { font-size: 11px; color: var(--fg-subtle); margin-top: 1px; }
.dashboard .empty { color: var(--fg-muted); font-style: italic; font-size: 13px; }
@media (max-width: 860px) {
  .dashboard .status-grid { grid-template-columns: repeat(2, 1fr); }
  .dashboard .twocol, .dashboard .sfl, .dashboard .box-grid.twocol, .dashboard .box-grid.sfl, .box-grid.twocol, .box-grid.sfl { grid-template-columns: 1fr; }
  .dashboard .metric-row, .metrics-page .metric-row { grid-template-columns: repeat(2, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; scroll-behavior: auto !important; }
}`;
}
