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

export function renderLayout({ title, active = 'dashboard', csrfToken = '', body }) {
  if (typeof title !== 'string' || title.trim() === '') throw new Error('title is required');
  if (typeof body !== 'string') throw new Error('body must be a string');
  const nav = [
    ['dashboard', '/admin/', 'Dashboard'],
    ['jobs', '/admin/jobs', 'Jobs'],
    ['config', '/admin/config', 'Config'],
  ].map(([key, href, label]) => `<a class="${key === active ? 'active' : ''}" href="${href}">${label}</a>`).join('');

  const logoutForm = csrfToken
    ? `<form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}"><button type="submit">Sign out</button></form>`
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
<header><h1>Open Code Review Admin</h1><nav>${nav}</nav>${logoutForm}</header>
<main>${body}</main>
</body>
</html>`;
}

export function renderLoginPage({ csrfToken = '', error = '', disabledReason = '' } = {}) {
  const disabled = disabledReason !== '';
  const message = disabled
    ? `<p class="alert">${escapeHtml(disabledReason)}</p>`
    : error ? `<p class="alert">${escapeHtml(error)}</p>` : '';
  const form = disabled ? '' : `<form method="post" action="/admin/login" class="card narrow">
<label for="password">Admin password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}">
<button type="submit">Sign in</button>
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
<main class="login"><h1>Open Code Review Admin</h1>${message}${form}</main>
</body>
</html>`;
}

export function renderDashboardPage({ csrfToken, summary = {}, recentJobs = [], diagnostics = [], serviceStatus = null, metrics = null, stats = null, retention = null } = {}) {
  const cards = [
    ['Queued', summary.queued],
    ['Running', summary.running],
    ['Succeeded', summary.succeeded],
    ['Warnings', summary.succeeded_with_warnings],
    ['Failed', summary.failed],
  ].map(([label, value]) => `<section class="metric"><strong>${escapeHtml(numberOrDash(value))}</strong><span>${escapeHtml(label)}</span></section>`).join('');
  const body = `<section class="grid">${cards}</section>
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
  const body = `<p><a href="/admin/jobs">← Jobs</a></p>
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
    ['Phase / status', safeDisplay(`${job?.phase ?? progress.phase ?? job?.status ?? ''}${job?.status ? ` / ${job.status}` : ''}`)],
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
<section class="card"><h2>Edit configuration</h2><form method="post" action="/admin/config"><input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}"><input type="hidden" name="revision" value="${escapeAttribute(revision)}"><table class="config-table"><thead><tr><th>Field</th><th>Effective value</th><th>Edit</th><th>State</th></tr></thead><tbody>${rows}</tbody></table><p><button type="submit">Save configuration</button></p></form></section>`;
  return renderLayout({ title: 'Config', active: 'config', csrfToken, body });
}

function renderConfigEditorRow(field) {
  const envKey = field.envKey ?? field.name ?? '';
  const label = field.label ?? envKey;
  const description = field.description ?? '';
  return `<tr><th scope="row"><strong>${escapeHtml(label)}</strong><br><code>${escapeHtml(envKey)}</code>${description ? `<p class="muted">${escapeHtml(description)}</p>` : ''}</th><td>${renderConfigFieldValue(field)}</td><td>${renderConfigEditorControl(field)}</td><td>${renderConfigBadges(field)}${renderConfigReset(field)}${renderHighRiskConfirm(field)}</td></tr>`;
}

function renderConfigFieldValue(field) {
  if (field.secret) return field.set ? '<span class="pill">secret set</span>' : '<span class="empty">not set</span>';
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
  const badges = [field.source ? `source: ${field.source}` : '', field.secret ? 'secret' : 'non-secret', field.restartRequired ? 'restart required' : 'hot reload', field.overridden ? 'override active' : 'no override', field.pendingRestart ? 'pending restart' : '']
    .filter(Boolean)
    .map(value => `<span class="pill">${escapeHtml(value)}</span>`)
    .join(' ');
  return `<div class="field-meta">${badges}</div>`;
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
  const body = `<section class="card"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><p>Status ${escapeHtml(status)}</p></section>`;
  return csrfToken
    ? renderLayout({ title, active: '', csrfToken, body })
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${baseStyles()}</style></head><body><main>${body}</main></body></html>`;
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
    return `<tr><td>${idCell}</td><td>${safeDisplay(status)}</td><td>${safeDisplay(repo)}</td><td>${safeDisplay(job?.pullNumber)}</td><td>${safeDisplay(actor)}</td><td><code>${safeDisplay(diagnosticId)}</code></td><td>${safeDisplay(formatDate(queuedAt))}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Job ID</th><th>Status</th><th>Repository</th><th>PR</th><th>Actor</th><th>Diagnostic ID</th><th>Queued</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderDiagnosticsList(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return '<p class="empty">No diagnostics.</p>';
  const items = diagnostics.map((item) => {
    const id = item?.displayId ?? item?.id ?? '';
    const level = item?.level ?? 'info';
    const message = item?.message ?? '';
    return `<li><strong>${escapeHtml(redactInlineSecrets(id))}</strong> <span class="pill">${escapeHtml(redactInlineSecrets(level))}</span> ${escapeHtml(redactInlineSecrets(message))}</li>`;
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
<button type="submit">Apply</button></form>`;
}

function renderPagination(filters, pagination) {
  if (!pagination) return '';
  const total = Number.isFinite(pagination.total) ? pagination.total : 0;
  const page = pagination.page ?? 1;
  const totalPages = pagination.totalPages ?? 1;
  const prev = pagination.hasPrev ? `<a href="${escapeAttribute(jobsPageUrl(filters, pagination.prevPage, pagination.pageSize))}">Previous</a>` : '<span class="empty">Previous</span>';
  const next = pagination.hasNext ? `<a href="${escapeAttribute(jobsPageUrl(filters, pagination.nextPage, pagination.pageSize))}">Next</a>` : '<span class="empty">Next</span>';
  return `<nav class="pagination" aria-label="Jobs pages">${prev}<span>Page ${safeDisplay(page)} of ${safeDisplay(totalPages)} · ${safeDisplay(total)} job(s)</span>${next}</nav>`;
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
  return `<svg width="120" height="14" viewBox="0 0 120 14" role="img" aria-label="${escapeAttribute(`${successWidth}% success ${failureWidth}% failed`)}"><rect width="120" height="14" fill="#334155"></rect><rect width="${successWidth * 1.2}" height="14" fill="#22c55e"></rect><rect x="${successWidth * 1.2}" width="${failureWidth * 1.2}" height="14" fill="#ef4444"></rect></svg>`;
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

function baseStyles() {
  return `:root{color-scheme:light dark;font-family:Inter,system-ui,sans-serif;background:#0f172a;color:#e2e8f0}body{margin:0}header{display:flex;gap:1rem;align-items:center;padding:1rem 1.5rem;background:#111827;border-bottom:1px solid #334155}h1{font-size:1.2rem;margin:0}nav{display:flex;gap:.75rem;flex:1}a{color:#93c5fd;text-decoration:none}a.active{color:#fff;font-weight:700}main{max-width:1100px;margin:0 auto;padding:1.5rem}.login{max-width:420px}.card,.metric{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1rem;margin-bottom:1rem}.narrow{display:grid;gap:.75rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem}.metric strong{display:block;font-size:2rem}.metric span{color:#cbd5e1}table{width:100%;border-collapse:collapse}th,td{padding:.6rem;border-bottom:1px solid #334155;text-align:left;vertical-align:top}button,input{font:inherit;border-radius:8px;border:1px solid #475569;padding:.55rem}.alert{background:#7f1d1d;border:1px solid #ef4444;padding:.75rem;border-radius:8px}.alert.success{background:#14532d;border-color:#22c55e}.empty,.muted{color:#94a3b8}.inline{display:flex;gap:.5rem;align-items:end;margin-bottom:1rem}.pill{display:inline-block;background:#334155;border-radius:999px;padding:.1rem .45rem;font-size:.8rem;margin:.1rem .1rem .1rem 0}code{word-break:break-all}.config-table th{width:24%}.config-control{box-sizing:border-box;width:100%;min-width:16rem}.stack{display:grid;gap:.4rem}.field-meta{margin-bottom:.5rem}.danger{color:#fecaca}.nowrap{display:block;white-space:nowrap;margin-top:.35rem}`;
}
