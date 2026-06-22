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

const NAV_ITEMS = [
  ['dashboard', '/admin/', 'Dashboard'],
  ['jobs', '/admin/jobs', 'Jobs'],
  ['config', '/admin/config', 'Config'],
];

export function renderLayout({ title, active = 'dashboard', csrfToken = '', body }) {
  if (typeof title !== 'string' || title.trim() === '') throw new Error('title is required');
  if (typeof body !== 'string') throw new Error('body must be a string');
  const tabs = NAV_ITEMS
    .map(([key, href, label]) => `<a class="${key === active ? 'active' : ''}" href="${href}">${escapeHtml(label)}</a>`)
    .join('');
  const activeEntry = NAV_ITEMS.find(([key]) => key === active);
  const crumb = activeEntry ? `<span class="crumb">${escapeHtml(activeEntry[2].toLowerCase())}</span>` : '';
  const logoutForm = csrfToken
    ? `<form class="signout" method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}"><button type="submit">sign out</button></form>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Open Code Review Admin</title>
<style>${baseStyles()}</style>
</head>
<body>
<header class="topbar">
  <span class="brand"><span class="mark">ocr</span>-admin<span class="cursor" aria-hidden="true">▍</span>${crumb}</span>
  <nav class="tabs" aria-label="Sections">${tabs}</nav>
  ${logoutForm}
</header>
<main>${body}</main>
</body>
</html>`;
}

export function renderLoginPage({ csrfToken = '', error = '', disabledReason = '' } = {}) {
  const disabled = disabledReason !== '';
  const message = disabled
    ? `<p class="alert">${escapeHtml(disabledReason)}</p>`
    : error ? `<p class="alert">${escapeHtml(error)}</p>` : '';
  const form = disabled ? '' : `<form method="post" action="/admin/login" class="login-box">
<p class="login-prompt">// admin auth — enter password</p>
<label for="password">password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}">
<button type="submit" class="primary">[ sign in ]</button>
</form>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Open Code Review Admin</title>
<style>${baseStyles()}</style>
</head>
<body>
<main class="login">
<div class="login-head"><span class="mark">ocr</span>-admin<span class="cursor" aria-hidden="true">▍</span></div>
<p class="login-sub">open code review · github app bot</p>
${message}${form}
</main>
</body>
</html>`;
}

export function renderDashboardPage({ csrfToken, summary = {}, recentJobs = [], diagnostics = [], serviceStatus = null, metrics = null, stats = null, retention = null } = {}) {
  const cells = [
    ['Queued', summary.queued, ''],
    ['Running', summary.running, 'warn'],
    ['Succeeded', summary.succeeded, 'ok'],
    ['Warnings', summary.succeeded_with_warnings, 'warn'],
    ['Failed', summary.failed, 'fail'],
  ].map(([label, value, tone]) => `<div class="cell"><div class="num ${tone}">${escapeHtml(numberOrDash(value))}</div><div class="lab">${escapeHtml(label)}</div></div>`).join('');
  const body = `<div class="strip" aria-label="Job summary">${cells}</div>
${renderServiceStatus(serviceStatus, retention)}
${renderMetricsTrends(stats ?? metrics)}
<section class="card"><h2>Recent jobs</h2>${renderJobsTable(recentJobs)}</section>
<section class="card"><h2>Diagnostics</h2>${renderDiagnosticsList(diagnostics)}</section>`;
  return renderLayout({ title: 'Dashboard', active: 'dashboard', csrfToken, body });
}

export function renderJobsPage({ csrfToken, jobs = [], filters = {}, pagination = null, validationMessages = [], filter = '' } = {}) {
  const normalizedFilters = { ...filters };
  if (filter && !normalizedFilters.diagnosticId) normalizedFilters.diagnosticId = filter;
  const alerts = validationMessages.length > 0
    ? `<section class="alert"><ul>${validationMessages.map(message => `<li>${safeDisplay(message)}</li>`).join('')}</ul></section>`
    : '';
  const body = `<section class="card"><h2>Jobs</h2>
${alerts}
${renderJobsFilterForm(normalizedFilters, pagination)}
${renderJobsTable(jobs)}
${renderPagination(normalizedFilters, pagination)}</section>`;
  return renderLayout({ title: 'Jobs', active: 'jobs', csrfToken, body });
}

export function renderJobDetailPage({ csrfToken, job }) {
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
  const body = `<p class="back"><a href="/admin/jobs">← jobs</a></p>
<section class="card"><h2>Job detail</h2>
${renderDefinitionList([
    ['Repository / PR', renderRepoPullLink(job, repository)],
    ['Actor', safeDisplay(job?.actor)],
    ['Job ID', `<code>${safeDisplay(id)}</code>`],
    ['Diagnostic ID', `<code>${safeDisplay(job?.diagnosticId)}</code>`],
    ['Queued', safeDisplay(formatDate(job?.queuedAt ?? job?.createdAt))],
    ['Started', safeDisplay(formatDate(job?.startedAt))],
    ['Finished', safeDisplay(formatDate(job?.finishedAt))],
    ['Queue wait', safeDisplay(formatDuration(job?.queueWaitMs ?? durationBetween(job?.queuedAt ?? job?.createdAt, job?.startedAt)))],
    ['Duration', safeDisplay(formatDuration(job?.durationMs ?? durationBetween(job?.startedAt, job?.finishedAt)))],
    ['Phase / status', `<span class="status">${statusDot(job?.phase ?? progress.phase ?? job?.status)}${safeDisplay(`${job?.phase ?? progress.phase ?? job?.status ?? ''}${job?.status ? ` / ${job.status}` : ''}`)}</span>`],
    ['Head SHA', `<code>${safeDisplay(job?.headSha ?? result.headSha)}</code>`],
    ['Base SHA', `<code>${safeDisplay(job?.baseSha ?? result.baseSha)}</code>`],
    ['Config revision', safeDisplay(configRevision)],
    ['OCR status', safeDisplay(job?.ocrStatus ?? result.ocrStatus)],
  ])}</section>
<section class="card"><h2>Runtime settings</h2>${renderKeyValueTable(job?.runtimeSettings ?? result.runtimeSettings ?? {})}</section>
<section class="card"><h2>Phase timeline</h2>${renderPhaseTimeline(job?.phaseTimeline ?? [])}</section>
<section class="card"><h2>Review counts</h2>${renderDefinitionList([
    ['Generated', safeDisplay(numberOrDash(counts.generated))],
    ['Selected', safeDisplay(numberOrDash(counts.selected))],
    ['Posted', safeDisplay(numberOrDash(counts.posted))],
    ['Omitted', safeDisplay(numberOrDash(counts.omitted))],
    ['Warnings', safeDisplay(numberOrDash(counts.warnings))],
  ])}</section>
<section class="card"><h2>Warnings</h2>${renderObjectList(collectJobWarnings(job, result))}</section>
<section class="card"><h2>Failure</h2>${renderObjectBlock(failure)}</section>
<section class="card"><h2>Reporting error</h2>${renderObjectBlock(reportingError)}</section>
<section class="card"><h2>Cleanup warning</h2>${cleanupWarning ? `<p>${safeDisplay(cleanupWarning)}</p>` : '<p class="empty">None.</p>'}</section>
<section class="card"><h2>Retained logs</h2>${renderLogs(logs)}</section>
${job?.diagnostics ? `<section class="card"><h2>Job diagnostics</h2>${renderDiagnosticsList(job.diagnostics)}</section>` : ''}`;
  return renderLayout({ title: `Job ${id}`, active: 'jobs', csrfToken, body });
}

export function renderConfigPage({ csrfToken, config = {}, adminRoot = '/data/admin', flash = null } = {}) {
  const fields = Array.isArray(config.fields) ? config.fields : legacyConfigFields(config);
  const revision = config.revision ?? '';
  const flashHtml = flash ? `<p class="alert ${flash.type === 'success' ? 'success' : ''}">${escapeHtml(flash.message)}</p>` : '';
  const pending = config.pendingRestart;
  const pendingHtml = pending?.required
    ? `<p class="alert">Restart required for: ${escapeHtml((pending.keys ?? []).join(', '))}</p>`
    : '';
  const rows = fields.map(renderConfigEditorRow).join('');
  const body = `<section class="card"><h2>Configuration</h2><p>Admin storage root: <code>${escapeHtml(adminRoot)}</code></p>${flashHtml}${pendingHtml}<p class="muted">Revision: <code>${escapeHtml(revision)}</code></p></section>
<section class="card"><h2>Edit configuration</h2><form method="post" action="/admin/config"><input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}"><input type="hidden" name="revision" value="${escapeAttribute(revision)}"><table class="config-table"><thead><tr><th>Field</th><th>Effective value</th><th>Edit</th><th>State</th></tr></thead><tbody>${rows}</tbody></table><p><button type="submit" class="primary">save configuration</button></p></form></section>`;
  return renderLayout({ title: 'Config', active: 'config', csrfToken, body });
}

function renderConfigEditorRow(field) {
  const envKey = field.envKey ?? field.name ?? '';
  const label = field.label ?? envKey;
  const description = field.description ?? '';
  return `<tr><th scope="row"><strong>${escapeHtml(label)}</strong><br><code>${escapeHtml(envKey)}</code>${description ? `<p class="muted">${escapeHtml(description)}</p>` : ''}</th><td>${renderConfigFieldValue(field)}</td><td>${renderConfigEditorControl(field)}</td><td>${renderConfigBadges(field)}${renderConfigReset(field)}${renderHighRiskConfirm(field)}</td></tr>`;
}

function renderConfigFieldValue(field) {
  if (field.secret) return field.set ? '<span class="pill pill--ok">secret set</span>' : '<span class="empty">not set</span>';
  return `<code>${escapeHtml(formatConfigValue(field.envKey ?? field.name, field.effectiveValue ?? field.value))}</code>`;
}

function renderConfigEditorControl(field) {
  const envKey = field.envKey ?? '';
  if (!field.editable) return '<span class="empty">Not editable from dashboard.</span>';
  if (field.secret) {
    return `<div class="stack"><label><input type="radio" name="secret_${escapeAttribute(envKey)}" value="keep" checked> Keep current secret</label><label><input type="radio" name="secret_${escapeAttribute(envKey)}" value="clear"> Clear secret</label><label><input type="radio" name="secret_${escapeAttribute(envKey)}" value="replace"> Replace with</label><input class="config-control" type="password" name="value_${escapeAttribute(envKey)}" autocomplete="off" value=""></div>`;
  }
  return `<input class="config-control" name="value_${escapeAttribute(envKey)}" value="${escapeAttribute(formatEditorValue(field.effectiveValue ?? field.value))}">`;
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
  return `<label class="nowrap"><input type="checkbox" name="reset_${escapeAttribute(envKey)}" value="1"> Reset override</label>`;
}

function renderHighRiskConfirm(field) {
  if (!field.highRisk || !field.editable) return '';
  const envKey = field.envKey ?? '';
  return `<label class="danger nowrap"><input type="checkbox" name="confirm_${escapeAttribute(envKey)}" value="1"> Confirm high-risk change</label>`;
}

function legacyConfigFields(config) {
  return Object.entries(config)
    .filter(([key]) => key !== 'revision' && key !== 'pendingRestart')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ name: key, envKey: key, label: key, value, effectiveValue: value, source: '', secret: isSecretKey(key), editable: false, restartRequired: false, hotReloadable: true, overridden: false, canReset: false, highRisk: false }));
}

function formatEditorValue(value) {
  if (value instanceof Set) return [...value].sort().join(',');
  if (Array.isArray(value)) return value.map(item => formatEditorValue(item)).join(',');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value == null) return '';
  return String(value);
}

export function renderErrorPage({ csrfToken = '', status = 500, title = 'Error', message = 'Something went wrong' } = {}) {
  const body = `<section class="card"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><p class="muted">status ${escapeHtml(status)}</p></section>`;
  return csrfToken
    ? renderLayout({ title, active: '', csrfToken, body })
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${baseStyles()}</style></head><body><main class="centered">${body}</main></body></html>`;
}

export function renderJobsTable(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return '<p class="empty">No jobs found.</p>';
  const rows = jobs.map((job) => {
    const id = job?.id ?? job?.jobId;
    const status = job?.status;
    const repo = formatRepository(job?.repo ?? job?.repository);
    const actor = job?.actor ?? '';
    const diagnosticId = job?.diagnosticId ?? '';
    const queuedAt = job?.queuedAt ?? job?.createdAt ?? job?.startedAt;
    const idCell = id ? `<a href="/admin/jobs/${escapeAttribute(id)}"><code>${safeDisplay(id)}</code></a>` : '';
    return `<tr><td>${idCell}</td><td><span class="status">${statusDot(status)}${safeDisplay(status)}</span></td><td>${safeDisplay(repo)}</td><td>${safeDisplay(job?.pullNumber)}</td><td>${safeDisplay(actor)}</td><td><code>${safeDisplay(diagnosticId)}</code></td><td>${safeDisplay(formatDate(queuedAt))}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Job ID</th><th>Status</th><th>Repository</th><th>PR</th><th>Actor</th><th>Diagnostic ID</th><th>Queued</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderDiagnosticsList(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return '<p class="empty">No diagnostics.</p>';
  const items = diagnostics.map((item) => {
    const id = item?.displayId ?? item?.id ?? '';
    const level = String(item?.level ?? 'info').toLowerCase();
    const message = item?.message ?? '';
    const levelTone = level === 'error' ? 'pill--err' : level === 'warn' ? 'pill--warn' : '';
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

function renderJobsFilterForm(filters, pagination) {
  const size = pagination?.pageSize ?? filters.pageSize ?? 50;
  return `<form method="get" action="/admin/jobs" class="inline">
<label>Owner <input name="owner" value="${escapeAttribute(filters.owner ?? '')}"></label>
<label>Repository <input name="repository" value="${escapeAttribute(filters.repository ?? filters.repo ?? '')}"></label>
<label>State/outcome <input name="state" value="${escapeAttribute(filters.state ?? filters.status ?? filters.outcome ?? '')}"></label>
<label>Failure kind <input name="failureKind" value="${escapeAttribute(filters.failureKind ?? '')}"></label>
<label>Diagnostic ID <input name="diagnosticId" value="${escapeAttribute(filters.diagnosticId ?? '')}"></label>
<label>From <input name="from" type="date" value="${escapeAttribute(filters.from ?? '')}"></label>
<label>To <input name="to" type="date" value="${escapeAttribute(filters.to ?? '')}"></label>
<input type="hidden" name="size" value="${escapeAttribute(size)}">
<button type="submit" class="primary">apply</button></form>`;
}

function renderPagination(filters, pagination) {
  if (!pagination) return '';
  const total = Number.isFinite(pagination.total) ? pagination.total : 0;
  const page = pagination.page ?? 1;
  const totalPages = pagination.totalPages ?? 1;
  const prev = pagination.hasPrev ? `<a href="${escapeAttribute(jobsPageUrl(filters, pagination.prevPage, pagination.pageSize))}">prev</a>` : '<span class="empty" aria-disabled="true">prev</span>';
  const next = pagination.hasNext ? `<a href="${escapeAttribute(jobsPageUrl(filters, pagination.nextPage, pagination.pageSize))}">next</a>` : '<span class="empty" aria-disabled="true">next</span>';
  return `<nav class="pagination" aria-label="Jobs pages">${prev}<span>page ${safeDisplay(page)} / ${safeDisplay(totalPages)} · ${safeDisplay(total)} jobs</span>${next}</nav>`;
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

function renderServiceStatus(status, retention) {
  if (!status) return '';
  const storage = status.storage ?? {};
  const running = status.runningJob ?? status.running ?? null;
  const queued = status.queued ?? { count: status.queuedCount, items: [] };
  return `<section class="card"><h2>Local service status</h2>
${renderDefinitionList([
    ['Uptime', safeDisplay(formatDuration(status.uptimeMs))],
    ['Started', safeDisplay(formatDate(status.startedAt))],
    ['Version', safeDisplay(status.version)],
    ['Config revision', safeDisplay(status.configRevision)],
    ['Actual listening port', safeDisplay(status.actualListeningPort ?? status.listeningPort)],
    ['Configured port', safeDisplay(status.configuredPort ?? status.port)],
    ['Desired pending port', safeDisplay(status.desiredPendingPort ?? status.pendingPort)],
    ['Storage writable/degraded', safeDisplay(`${storage.writable ? 'writable' : 'not writable'} / ${storage.degraded ? 'degraded' : 'healthy'}`)],
    ['Storage size / budget', safeDisplay(`${formatBytes(storage.sizeBytes ?? storage.dirSizeBytes)} / ${formatBytes(storage.budgetBytes)}`)],
    ['Last retention', safeDisplay(formatDate(status.lastRetention?.finishedAt ?? status.lastRetention?.startedAt ?? retention?.lastRun?.finishedAt))],
    ['Corrupt/truncated diagnostics', safeDisplay(formatDiagnosticCounts(status.diagnostics))],
  ])}
<h3>Current running job</h3>${running ? renderJobsTable([runningJobAsListItem(running)]) : '<p class="empty">No running job.</p>'}
<h3>Queued summaries</h3>${renderQueuedSummary(queued)}
<h3>Last success/failure</h3>${renderJobsTable([status.lastSuccess, status.lastFailure].filter(Boolean))}</section>`;
}

function renderQueuedSummary(queued) {
  const items = queued.items ?? [];
  if (items.length === 0) return `<p class="empty">${safeDisplay(queued.count ?? 0)} queued.</p>`;
  return renderJobsTable(items.map(item => ({ ...item, id: item.jobId, status: item.phase ?? 'queued', repo: item.repository })));
}

function runningJobAsListItem(job) {
  return { ...job, id: job.jobId ?? job.id, status: job.phase ?? 'running', repo: job.repository ?? job.repo };
}

function renderMetricsTrends(metrics) {
  const stats = metrics?.total || metrics?.windows ? metrics : { windows: metrics };
  const windows = stats.windows ?? {};
  if (!stats.total && Object.keys(windows).length === 0) return '';
  const rows = ['24h', '7d', '30d'].map((name) => renderMetricsWindowRow(name, windows[name] ?? {})).join('');
  return `<section class="card"><h2>Metrics and trends</h2>${renderMetricsSummary(stats.total)}<table><thead><tr><th>Window</th><th>Jobs</th><th>Success rate</th><th>Duration p50</th><th>Duration p95</th><th>Queue wait p50</th><th>Queue wait p95</th><th>Avg comments generated</th><th>Avg comments posted</th><th>Stale</th><th>Skipped</th><th>Interrupted</th><th>Failure classification</th><th>Repository success rate</th><th>Trend</th></tr></thead><tbody>${rows}</tbody></table>${renderDailyTrend(stats.dailyTrend ?? [])}</section>`;
}

function renderMetricsWindowRow(name, bucket) {
  return `<tr><th scope="row">${safeDisplay(name)}</th><td>${safeDisplay(numberOrDash(bucket.jobs))}</td><td>${safeDisplay(formatPercent(bucket.successRate))}</td><td>${safeDisplay(formatDuration(bucket.durationP50Ms))}</td><td>${safeDisplay(formatDuration(bucket.durationP95Ms))}</td><td>${safeDisplay(formatDuration(bucket.queueWaitP50Ms))}</td><td>${safeDisplay(formatDuration(bucket.queueWaitP95Ms))}</td><td>${safeDisplay(numberOrDash(averageComment(bucket, 'generated')))}</td><td>${safeDisplay(numberOrDash(averageComment(bucket, 'posted')))}</td><td>${safeDisplay(numberOrDash(bucket.stale))}</td><td>${safeDisplay(numberOrDash(bucket.skipped))}</td><td>${safeDisplay(numberOrDash(bucket.interrupted))}</td><td>${renderFailureKinds(bucket.failureKinds)}</td><td>${renderRepositoryRates(bucket.repositories ?? bucket.repoSuccessRates ?? bucket.repos)}</td><td>${renderTrendBar(bucket)}</td></tr>`;
}

function renderMetricsSummary(bucket) {
  if (!bucket) return '';
  return renderDefinitionList([
    ['Duration p50', safeDisplay(formatDuration(bucket.durationP50Ms))],
    ['Duration p95', safeDisplay(formatDuration(bucket.durationP95Ms))],
    ['Queue wait p50', safeDisplay(formatDuration(bucket.queueWaitP50Ms))],
    ['Queue wait p95', safeDisplay(formatDuration(bucket.queueWaitP95Ms))],
    ['Avg comments generated', safeDisplay(numberOrDash(averageComment(bucket, 'generated')))],
    ['Avg comments posted', safeDisplay(numberOrDash(averageComment(bucket, 'posted')))],
    ['Stale', safeDisplay(numberOrDash(bucket.stale))],
    ['Skipped', safeDisplay(numberOrDash(bucket.skipped))],
    ['Interrupted', safeDisplay(numberOrDash(bucket.interrupted))],
    ['Failure classification', renderFailureKinds(bucket.failureKinds)],
    ['Repository success rate', renderRepositoryRates(bucket.repositories ?? bucket.repoSuccessRates ?? bucket.repos)],
  ]);
}

function renderDailyTrend(dailyTrend) {
  if (!Array.isArray(dailyTrend) || dailyTrend.length === 0) return '<h3>Daily trend</h3><p class="empty">No daily trend data.</p>';
  const rows = dailyTrend.map(day => `<tr><th scope="row">${safeDisplay(day.day)}</th><td>${safeDisplay(numberOrDash(day.jobs))}</td><td>${safeDisplay(formatPercent(day.successRate))}</td><td>${safeDisplay(numberOrDash(averageComment(day, 'generated')))}</td><td>${safeDisplay(numberOrDash(averageComment(day, 'posted')))}</td><td>${safeDisplay(numberOrDash(day.stale))}</td><td>${safeDisplay(numberOrDash(day.skipped))}</td><td>${safeDisplay(numberOrDash(day.interrupted))}</td></tr>`).join('');
  return `<h3>Daily trend</h3><table><thead><tr><th>Day</th><th>Jobs</th><th>Success rate</th><th>Avg comments generated</th><th>Avg comments posted</th><th>Stale</th><th>Skipped</th><th>Interrupted</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function averageComment(bucket, kind) {
  const average = kind === 'generated' ? bucket.averageCommentsGenerated : bucket.averageCommentsPosted;
  if (Number.isFinite(average)) return average;
  const total = commentTotal(bucket, kind);
  return Number.isFinite(total) && Number.isFinite(bucket.commentSamples) && bucket.commentSamples > 0 ? total / bucket.commentSamples : null;
}

function commentTotal(bucket, kind) {
  const direct = kind === 'generated' ? bucket.commentsGeneratedTotal : bucket.commentsPostedTotal;
  if (Number.isFinite(direct)) return direct;
  const average = kind === 'generated' ? bucket.averageCommentsGenerated : bucket.averageCommentsPosted;
  if (Number.isFinite(average) && Number.isFinite(bucket.commentSamples)) return Math.round(average * bucket.commentSamples);
  return null;
}

function renderFailureKinds(failureKinds) {
  const entries = Object.entries(objectValue(failureKinds));
  if (entries.length === 0) return '<span class="empty">—</span>';
  return entries.sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${safeDisplay(kind)} (${safeDisplay(numberOrDash(count))})`).join(', ');
}

function renderRepositoryRates(repositories) {
  const entries = Object.entries(objectValue(repositories));
  if (entries.length === 0) return '<span class="empty">—</span>';
  return entries.sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
    const details = objectValue(value);
    const successRate = details.successRate ?? repositorySuccessRateFromCount(details, value);
    const count = Number.isFinite(details.jobs) ? ` (${details.jobs})` : Number.isFinite(value) ? ` (${value})` : '';
    const rate = Number.isFinite(successRate) ? ` ${formatPercent(successRate)}` : '';
    return `${safeDisplay(name)}${safeDisplay(count)}${safeDisplay(rate)}`;
  }).join(', ');
}

function repositorySuccessRateFromCount(details, value) {
  if (!details && !Number.isFinite(value)) return null;
  const succeeded = Number(details?.succeeded ?? 0) + Number(details?.succeeded_with_warnings ?? 0);
  const failed = Number(details?.failed ?? 0);
  const denominator = succeeded + failed;
  return denominator > 0 ? succeeded / denominator : null;
}

function renderPhaseTimeline(timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) return '<p class="empty">No phase timeline.</p>';
  const rows = timeline.map(item => `<tr><td>${safeDisplay(formatDate(item.timestamp))}</td><td>${safeDisplay(item.label ?? item.phase ?? '')}</td><td>${safeDisplay(item.phase ?? '')}</td><td>${safeDisplay(item.message ?? '')}</td><td>${safeDisplay(item.source ?? '')}</td></tr>`).join('');
  return `<table><thead><tr><th>Time</th><th>Event</th><th>Phase</th><th>Message</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderTrendBar(bucket) {
  const total = Math.max(0, Number(bucket.jobs) || 0);
  const succeeded = Math.max(0, Number(bucket.succeeded) || 0);
  const failed = Math.max(0, Number(bucket.failed) || 0);
  const successWidth = total > 0 ? Math.round((succeeded / total) * 100) : 0;
  const failureWidth = total > 0 ? Math.round((failed / total) * 100) : 0;
  return `<svg width="120" height="10" viewBox="0 0 120 10" role="img" aria-label="${escapeAttribute(`${successWidth}% success ${failureWidth}% failed`)}"><rect width="120" height="10" fill="#1c2820"></rect><rect width="${successWidth * 1.2}" height="10" fill="#5fae68"></rect><rect x="${successWidth * 1.2}" width="${failureWidth * 1.2}" height="10" fill="#d8553e"></rect></svg>`;
}

function renderRepoPullLink(job, repository) {
  const pullNumber = job?.pullNumber;
  if (!repository) return safeDisplay(pullNumber ? `#${pullNumber}` : '');
  const label = pullNumber ? `${repository}#${pullNumber}` : repository;
  return pullNumber ? `<a href="https://github.com/${escapeAttribute(repository)}/pull/${escapeAttribute(pullNumber)}" rel="noreferrer">${safeDisplay(label)}</a>` : safeDisplay(label);
}

function renderDefinitionList(rows) {
  return `<dl>${rows.map(([label, value]) => `<dt>${safeDisplay(label)}</dt><dd>${value == null || value === '' ? '<span class="empty">—</span>' : value}</dd>`).join('')}</dl>`;
}

function renderKeyValueTable(values) {
  const entries = Object.entries(objectValue(values)).filter(([key]) => !isSecretKey(key));
  if (entries.length === 0) return '<p class="empty">No runtime settings.</p>';
  const rows = entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `<tr><th scope="row">${safeDisplay(key)}</th><td>${safeDisplay(formatDisplayValue(redactConfigValue(key, value)))}</td></tr>`).join('');
  return `<table><tbody>${rows}</tbody></table>`;
}

function renderObjectList(items) {
  if (!Array.isArray(items) || items.length === 0) return '<p class="empty">None.</p>';
  return `<ul>${items.map(item => `<li>${safeDisplay(formatDisplayValue(item))}</li>`).join('')}</ul>`;
}

function renderObjectBlock(value) {
  if (value == null || value === '') return '<p class="empty">None.</p>';
  return `<pre>${safeDisplay(formatDisplayValue(value))}</pre>`;
}

function renderLogs(logs) {
  if (!logs || !Array.isArray(logs.entries) || logs.entries.length === 0) return '<p class="empty">No retained logs.</p>';
  const rows = logs.entries.map(entry => `<tr><td>${safeDisplay(formatDate(entry.timestamp))}</td><td>${safeDisplay(entry.level)}</td><td>${safeDisplay(entry.message)}</td><td>${safeDisplay(formatDisplayValue(entry.fields ?? {}))}</td></tr>`).join('');
  const note = logs.degraded ? '<p class="alert">Log history is degraded.</p>' : '';
  return `${note}<table><thead><tr><th>Time</th><th>Level</th><th>Message</th><th>Fields</th></tr></thead><tbody>${rows}</tbody></table>`;
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

function formatDiagnosticCounts(diagnostics = {}) {
  if (typeof diagnostics !== 'object' || diagnostics == null) return '';
  const corrupt = diagnostics.corruptEvents ?? 0;
  const invalid = diagnostics.invalidEvents ?? 0;
  const truncated = diagnostics.truncatedTail ? 'yes' : 'no';
  return `corrupt ${corrupt}, invalid ${invalid}, truncated ${truncated}`;
}

function formatDate(value) {
  if (value == null || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function numberOrDash(value) {
  return Number.isFinite(value) ? String(value) : '—';
}

function statusDot(status) {
  const normalized = String(status ?? '').toLowerCase();
  let kind = 'idle';
  if (normalized === 'succeeded') kind = 'ok';
  else if (normalized === 'succeeded_with_warnings') kind = 'warn';
  else if (normalized === 'running') kind = 'run';
  else if (normalized === 'failed') kind = 'fail';
  else if (normalized === 'queued') kind = 'queued';
  return `<span class="dot dot--${kind}" aria-hidden="true"></span>`;
}

function baseStyles() {
  return `:root{color-scheme:dark;--bg:#0a0e0a;--surface:#0f1510;--surface-2:#121a14;--border:#1c2820;--border-bright:#2a3a2e;--text:#cdd6cd;--muted:#7d8d7d;--faint:#4a574e;--amber:#e3a545;--green:#5fae68;--red:#d8553e;--cyan:#62b8c8;--radius:2px;background:var(--bg);color:var(--text);font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:13px;line-height:1.5;font-variant-numeric:tabular-nums}
*{box-sizing:border-box}
body{margin:0}
p{margin:.5rem 0}
a{color:var(--cyan);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:inherit;background:var(--surface-2);padding:.05em .3em;border-radius:var(--radius);color:var(--text);font-size:.95em}
pre{margin:.6rem .8rem;white-space:pre-wrap;word-break:break-word;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);font-family:inherit;font-size:12px}
h1,h2,h3,h4{font-weight:600}
:focus-visible{outline:2px solid var(--amber);outline-offset:1px}
header.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:.9rem;padding:.45rem .9rem;background:var(--bg);border-bottom:1px solid var(--border);box-shadow:inset 0 -1px 0 #000}
.brand{display:inline-flex;align-items:baseline;gap:.05rem;font-weight:600;font-size:14px;color:var(--text);letter-spacing:.01em}
.brand .mark{color:var(--amber)}
.brand .cursor{color:var(--amber);animation:blink 1.1s steps(1) infinite}
.brand .crumb{margin-left:.55rem;color:var(--muted);font-weight:400;text-transform:uppercase;font-size:11px;letter-spacing:.08em}
.brand .crumb::before{content:"\\25B8 ";color:var(--faint)}
@keyframes blink{50%{opacity:0}}
nav.tabs{display:flex;gap:.15rem;margin-left:auto}
nav.tabs a{text-transform:uppercase;font-size:11px;letter-spacing:.08em;color:var(--muted);padding:.35rem .55rem;border-bottom:2px solid transparent;cursor:pointer}
nav.tabs a:hover{color:var(--text);text-decoration:none;background:var(--surface)}
nav.tabs a.active{color:var(--amber);border-bottom-color:var(--amber)}
.signout{margin:0}
.signout button{font:inherit;text-transform:uppercase;font-size:11px;letter-spacing:.08em;color:var(--muted);background:transparent;border:1px solid var(--border-bright);padding:.3rem .55rem;border-radius:var(--radius);cursor:pointer}
.signout button:hover{color:var(--red);border-color:var(--red)}
main{max-width:1240px;margin:0 auto;padding:1rem .9rem 4rem}
main.centered{max-width:640px}
.back{margin:.2rem 0 .8rem}
.back a{color:var(--muted)}
.back a:hover{color:var(--cyan)}
.card{border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);margin-bottom:1rem}
.card>h2,.card>h3{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:0;padding:.55rem .8rem;background:var(--bg);font-weight:500}
.card>h2{border-bottom:1px solid var(--border)}
.card>h2::before{content:"// ";color:var(--faint)}
.card>h3{border-top:1px solid var(--border);background:var(--surface)}
.card>h3::before{content:"\\203A ";color:var(--faint)}
.card>*:last-child{margin-bottom:0}
.card>p{margin:.6rem .8rem}
.card>dl,.card>table,.card>ul,.card>ol,.card>form,.card>nav,.card>pre,.card>.inline,.card>.alert{margin:.6rem .8rem}
.strip{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);overflow:hidden;margin-bottom:1rem}
.strip .cell{padding:.7rem .8rem;border-right:1px solid var(--border)}
.strip .cell:last-child{border-right:0}
.strip .num{font-size:1.6rem;font-weight:600;line-height:1;color:var(--text)}
.strip .num.ok{color:var(--green)}
.strip .num.warn{color:var(--amber)}
.strip .num.fail{color:var(--red)}
.strip .lab{text-transform:uppercase;font-size:10px;letter-spacing:.09em;color:var(--muted);margin-top:.35rem}
@media(max-width:720px){.strip{grid-template-columns:repeat(2,1fr)}.strip .cell{border-bottom:1px solid var(--border)}}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{padding:.4rem .5rem;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
thead th{text-transform:uppercase;font-size:10px;letter-spacing:.07em;color:var(--muted);font-weight:500;border-bottom:1px solid var(--border-bright)}
tbody tr:hover{background:var(--surface-2)}
th[scope=row]{color:var(--muted);font-weight:400}
.status{display:inline-flex;align-items:center;gap:.4rem}
.dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:var(--faint);flex:none}
.dot--ok{background:var(--green);box-shadow:0 0 6px rgba(95,174,104,.7)}
.dot--warn{background:var(--amber);box-shadow:0 0 6px rgba(227,165,69,.7)}
.dot--run{background:var(--amber);box-shadow:0 0 8px rgba(227,165,69,.9);animation:pulse 1.1s ease-in-out infinite}
.dot--fail{background:var(--red);box-shadow:0 0 6px rgba(216,85,62,.7)}
.dot--queued{background:var(--muted)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
button,input{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border-bright);border-radius:var(--radius);padding:.4rem .55rem}
button{cursor:pointer;text-transform:uppercase;font-size:11px;letter-spacing:.08em;color:var(--muted)}
button:hover{border-color:var(--amber);color:var(--amber)}
button.primary{border-color:var(--amber);color:var(--amber)}
button.primary:hover{background:var(--amber);color:var(--bg)}
button.primary:active{background:var(--border-bright)}
input[type=password],input[type=text],input:not([type]){min-width:0}
input[type=radio],input[type=checkbox]{accent-color:var(--amber);width:auto;cursor:pointer}
input:focus-visible{outline:2px solid var(--amber);outline-offset:0}
.inline{display:flex;gap:.6rem .7rem;align-items:flex-end;flex-wrap:wrap}
.inline label{display:grid;gap:.2rem;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.inline input{min-width:8rem}
.alert{background:var(--surface);border:1px solid var(--red);border-left:3px solid var(--red);color:var(--text);padding:.55rem .7rem;border-radius:var(--radius)}
.alert::before{content:"\\25B6 ";color:var(--red)}
.alert.success{border-color:var(--green);border-left-color:var(--green)}
.alert.success::before{color:var(--green)}
.alert ul{margin:.3rem 0 0;padding-left:1rem}
.empty,.muted{color:var(--muted)}
.pill{display:inline-block;background:var(--surface-2);border:1px solid var(--border-bright);border-radius:var(--radius);padding:.05rem .4rem;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:.1rem .15rem .1rem 0}
.pill--ok{color:var(--green);border-color:var(--green)}
.pill--warn{color:var(--amber);border-color:var(--amber)}
.pill--err{color:var(--red);border-color:var(--red)}
.config-table{font-size:12.5px}
.config-table th[scope=row]{width:24%;vertical-align:top}
.config-control{box-sizing:border-box;width:100%;min-width:16rem}
.stack{display:grid;gap:.4rem}
.stack label{display:inline-flex;align-items:center;gap:.4rem;color:var(--text);text-transform:none;letter-spacing:0;font-size:12.5px}
.field-meta{margin-bottom:.5rem}
.danger{color:var(--red)}
.nowrap{display:block;white-space:nowrap;margin-top:.35rem}
ul.diagnostics{list-style:none;margin:.6rem .8rem;padding:0}
ul.diagnostics li{padding:.3rem 0;border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:.4rem;align-items:baseline}
ul.diagnostics li:last-child{border-bottom:0}
ul.diagnostics .diag-msg{flex:1;min-width:12rem}
nav.pagination{display:flex;gap:.6rem;align-items:center;justify-content:center;padding:.6rem .8rem;color:var(--muted);font-size:12px}
nav.pagination a{padding:.2rem .55rem;border:1px solid var(--border-bright);border-radius:var(--radius);color:var(--text);text-transform:uppercase;font-size:11px;letter-spacing:.08em}
nav.pagination a:hover{border-color:var(--amber);color:var(--amber);text-decoration:none}
nav.pagination span[aria-disabled=true]{opacity:.5}
main.login{max-width:420px;margin:8vh auto 0;padding:0 1rem}
.login-head{font-size:1.5rem;font-weight:600;color:var(--text)}
.login-head .mark{color:var(--amber)}
.login-head .cursor{color:var(--amber);animation:blink 1.1s steps(1) infinite}
.login-sub{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.1em;margin:.3rem 0 1.6rem}
.login-box{display:grid;gap:.6rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);padding:1rem}
.login-box .login-prompt{margin:0;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.login-box label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.login-box input{width:100%}
.login-box button{justify-self:start}
.login-box .alert{margin:0}
.login-box .alert::before{content:""}
@media(prefers-reduced-motion:reduce){.brand .cursor,.login-head .cursor,.dot--run{animation:none}}
@media(max-width:560px){header.topbar{flex-wrap:wrap}nav.tabs{order:3;width:100%}.inline{flex-direction:column;align-items:stretch}.inline input{min-width:0}dl{grid-template-columns:1fr!important}}`;
}
