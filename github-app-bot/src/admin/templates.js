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

const NAV_ITEMS = [
  ['dashboard', '/admin/', 'Dashboard'],
  ['jobs', '/admin/jobs', 'Jobs'],
  ['config', '/admin/config', 'Config'],
];

export function renderLayout({ title, active = 'dashboard', csrfToken = '', body, titleKey = '', cspNonce = '' }) {
  if (typeof title !== 'string' || title.trim() === '') throw new Error('title is required');
  if (typeof body !== 'string') throw new Error('body must be a string');
  const tabs = NAV_ITEMS
    .map(([key, href, label]) => `<a class="${key === active ? 'active' : ''}" href="${href}" data-i18n="nav_${key}">${escapeHtml(label)}</a>`)
    .join('');
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
<header class="topbar">
  <span class="brand"><span class="mark">ocr</span>-admin<span class="cursor" aria-hidden="true">▍</span></span>
  <nav class="tabs" aria-label="Sections" data-i18n-aria-label="aria_sections">${tabs}</nav>
  ${togglesHtml()}
  ${logoutForm}
</header>
<main><h1 class="page-title"${titleAttr}>${escapeHtml(title)}</h1>${body}</main>
${bodyScript(cspNonce)}
</body>
</html>`;
}

export function renderLoginPage({ csrfToken = '', error = '', disabledReason = '', cspNonce = '' } = {}) {
  const disabled = disabledReason !== '';
  const message = disabled
    ? `<p class="alert">${escapeHtml(disabledReason)}</p>`
    : error ? `<p class="alert">${escapeHtml(error)}</p>` : '';
  const form = disabled ? '' : `<form method="post" action="/admin/login" class="login-box">
<p class="login-prompt" data-i18n="login_prompt">// admin auth — enter password</p>
<label for="password" data-i18n="label_password">password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}">
<button type="submit" class="primary" data-i18n="sign_in">[ sign in ]</button>
</form>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Open Code Review Admin</title>
${fontLinks()}${themeInitScript(cspNonce)}<style>${baseStyles()}</style>
</head>
<body>
<main class="login">
${togglesHtml()}
<h1 class="login-head"><span class="mark">ocr</span>-admin<span class="cursor" aria-hidden="true">▍</span></h1>
<p class="login-sub" data-i18n="login_sub">open code review · github app bot</p>
${message}${form}
</main>
${bodyScript(cspNonce)}
</body>
</html>`;
}

export function renderDashboardPage({ csrfToken, summary = {}, recentJobs = [], diagnostics = [], serviceStatus = null, metrics = null, stats = null, retention = null, cspNonce = '' } = {}) {
  const cells = [
    ['Queued', summary.queued, 'queued', 'strip_queued'],
    ['Running', summary.running, 'run', 'strip_running'],
    ['Succeeded', summary.succeeded, 'ok', 'strip_succeeded'],
    ['Warnings', summary.succeeded_with_warnings, 'warn', 'strip_warnings'],
    ['Failed', summary.failed, 'fail', 'strip_failed'],
  ].map(([label, value, tone, key]) => `<div class="cell${tone ? ' cell--' + tone : ''}"><div class="num ${tone}">${escapeHtml(numberOrDash(value))}</div><div class="lab" data-i18n="${key}">${escapeHtml(label)}</div></div>`).join('');
  const body = `<div class="strip" aria-label="Job summary" data-i18n-aria-label="aria_job_summary">${cells}</div>
${renderServiceStatus(serviceStatus, retention)}
${renderMetricsTrends(stats ?? metrics)}
<section class="card"><h2 data-i18n="h2_recent_jobs">Recent jobs</h2>${renderJobsTable(recentJobs)}</section>
<section class="card"><h2 data-i18n="h2_diagnostics">Diagnostics</h2>${renderDiagnosticsList(diagnostics)}</section>`;
  return renderLayout({ title: 'Dashboard', active: 'dashboard', csrfToken, body, titleKey: 'page_dashboard', cspNonce });
}

export function renderJobsPage({ csrfToken, jobs = [], filters = {}, pagination = null, validationMessages = [], filter = '', cspNonce = '' } = {}) {
  const normalizedFilters = { ...filters };
  if (filter && !normalizedFilters.diagnosticId) normalizedFilters.diagnosticId = filter;
  const alerts = validationMessages.length > 0
    ? `<section class="alert"><ul>${validationMessages.map(message => `<li>${safeDisplay(message)}</li>`).join('')}</ul></section>`
    : '';
  const body = `<section class="card"><h2 data-i18n="h2_jobs">Jobs</h2>
${alerts}
${renderJobsFilterForm(normalizedFilters, pagination)}
${renderJobsTable(jobs)}
${renderPagination(normalizedFilters, pagination)}</section>`;
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
  const body = `<p class="back"><a href="/admin/jobs" data-i18n="back_jobs">← jobs</a></p>
<section class="card"><h2 data-i18n="h2_job_detail">Job detail</h2>
${renderDefinitionList([
    ['Repository / PR', renderRepoPullLink(job, repository), 'jd_repo_pr'],
    ['Actor', safeDisplay(job?.actor), 'jd_actor'],
    ['Job ID', `<code>${safeDisplay(id)}</code>`, 'jd_job_id'],
    ['Diagnostic ID', `<code>${safeDisplay(job?.diagnosticId)}</code>`, 'jd_diag_id'],
    ['Queued', safeDisplay(formatDate(job?.queuedAt ?? job?.createdAt)), 'jd_queued'],
    ['Started', safeDisplay(formatDate(job?.startedAt)), 'jd_started'],
    ['Finished', safeDisplay(formatDate(job?.finishedAt)), 'jd_finished'],
    ['Queue wait', safeDisplay(formatDuration(job?.queueWaitMs ?? durationBetween(job?.queuedAt ?? job?.createdAt, job?.startedAt))), 'jd_queue_wait'],
    ['Duration', safeDisplay(formatDuration(job?.durationMs ?? durationBetween(job?.startedAt, job?.finishedAt))), 'jd_duration'],
    ['Phase / status', `<span class="status">${statusDot(job?.status ?? progress.phase ?? job?.phase)}${safeDisplay(`${job?.phase ?? progress.phase ?? job?.status ?? ''}${job?.status ? ` / ${job.status}` : ''}`)}</span>`, 'jd_phase_status'],
    ['Head SHA', `<code>${safeDisplay(job?.headSha ?? result.headSha)}</code>`, 'jd_head_sha'],
    ['Base SHA', `<code>${safeDisplay(job?.baseSha ?? result.baseSha)}</code>`, 'jd_base_sha'],
    ['Config revision', safeDisplay(configRevision), 'jd_config_revision'],
    ['OCR status', safeDisplay(job?.ocrStatus ?? result.ocrStatus), 'jd_ocr_status'],
  ])}</section>
<details class="card"><summary><h2 data-i18n="jd_runtime">Runtime settings</h2></summary>${renderKeyValueTable(job?.runtimeSettings ?? result.runtimeSettings ?? {})}</details>
<section class="card"><h2 data-i18n="jd_phase_timeline">Phase timeline</h2>${renderPhaseTimeline(job?.phaseTimeline ?? [])}</section>
<section class="card"><h2 data-i18n="jd_review_counts">Review counts</h2>${renderDefinitionList([
    ['Generated', safeDisplay(numberOrDash(counts.generated)), 'jd_generated'],
    ['Selected', safeDisplay(numberOrDash(counts.selected)), 'jd_selected'],
    ['Posted', safeDisplay(numberOrDash(counts.posted)), 'jd_posted'],
    ['Omitted', safeDisplay(numberOrDash(counts.omitted)), 'jd_omitted'],
    ['Warnings', safeDisplay(numberOrDash(counts.warnings)), 'jd_warnings_count'],
  ])}</section>
<section class="card"><h2 data-i18n="jd_warnings_section">Warnings</h2>${renderObjectList(collectJobWarnings(job, result))}</section>
<section class="card"><h2 data-i18n="jd_failure">Failure</h2>${renderObjectBlock(failure)}</section>
<details class="card"${reportingError ? ' open' : ''}><summary><h2 data-i18n="jd_reporting_error">Reporting error</h2></summary>${renderObjectBlock(reportingError)}</details>
<details class="card"${cleanupWarning ? ' open' : ''}><summary><h2 data-i18n="jd_cleanup_warning">Cleanup warning</h2></summary>${cleanupWarning ? `<p>${safeDisplay(cleanupWarning)}</p>` : '<p class="empty" data-i18n="empty_none">None.</p>'}</details>
<section class="card"><h2 data-i18n="jd_retained_logs">Retained logs</h2>${renderLogs(logs)}</section>
${job?.diagnostics ? `<section class="card"><h2 data-i18n="jd_job_diagnostics">Job diagnostics</h2>${renderDiagnosticsList(job.diagnostics)}</section>` : ''}`;
  return renderLayout({ title: `Job ${id}`, active: 'jobs', csrfToken, body, cspNonce });
}

export function renderConfigPage({ csrfToken, config = {}, adminRoot = '/data/admin', flash = null, cspNonce = '' } = {}) {
  const fields = Array.isArray(config.fields) ? config.fields : legacyConfigFields(config);
  const revision = config.revision ?? '';
  const flashHtml = flash ? `<p class="alert ${flash.type === 'success' ? 'success' : ''}">${escapeHtml(flash.message)}</p>` : '';
  const pending = config.pendingRestart;
  const pendingHtml = pending?.required
    ? `<p class="alert">Restart required for: ${escapeHtml((pending.keys ?? []).join(', '))}</p>`
    : '';
  const rows = fields.map(renderConfigEditorRow).join('');
  const body = `<section class="card"><h2 data-i18n="h2_configuration">Configuration</h2><p><span data-i18n="admin_storage_root">Admin storage root:</span> <code>${escapeHtml(adminRoot)}</code></p>${flashHtml}${pendingHtml}<p class="muted"><span data-i18n="revision">Revision:</span> <code>${escapeHtml(revision)}</code></p></section>
<section class="card"><h2 data-i18n="h2_edit_config">Edit configuration</h2><form method="post" action="/admin/config"><input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}"><input type="hidden" name="revision" value="${escapeAttribute(revision)}"><div class="table-scroll"><table class="config-table"><thead><tr><th data-i18n="th_field">Field</th><th data-i18n="th_effective">Effective value</th><th data-i18n="th_edit">Edit</th><th data-i18n="th_state">State</th></tr></thead><tbody>${rows}</tbody></table></div><p><button type="submit" class="primary" data-i18n="btn_save_config">save configuration</button></p></form></section>`;
  return renderLayout({ title: 'Config', active: 'config', csrfToken, body, titleKey: 'page_config', cspNonce });
}

function renderConfigEditorRow(field) {
  const envKey = field.envKey ?? field.name ?? '';
  const label = field.label ?? envKey;
  const description = field.description ?? '';
  return `<tr><th scope="row"><strong>${escapeHtml(label)}</strong><br><code>${escapeHtml(envKey)}</code>${description ? `<p class="muted">${escapeHtml(description)}</p>` : ''}</th><td>${renderConfigFieldValue(field)}</td><td>${renderConfigEditorControl(field)}</td><td>${renderConfigBadges(field)}${renderConfigReset(field)}${renderHighRiskConfirm(field)}</td></tr>`;
}

function renderConfigFieldValue(field) {
  if (field.secret) return field.set ? '<span class="pill pill--ok" data-i18n="secret_set">secret set</span>' : '<span class="empty" data-i18n="not_set">not set</span>';
  return `<code>${escapeHtml(formatConfigValue(field.envKey ?? field.name, field.effectiveValue ?? field.value))}</code>`;
}

function renderConfigEditorControl(field) {
  const envKey = field.envKey ?? '';
  if (!field.editable) return '<span class="empty" data-i18n="not_editable">Not editable from dashboard.</span>';
  if (field.secret) {
    return `<div class="stack"><label><input type="radio" name="secret_${escapeAttribute(envKey)}" value="keep" checked> <span data-i18n="keep_secret">Keep current secret</span></label><label><input type="radio" name="secret_${escapeAttribute(envKey)}" value="clear"> <span data-i18n="clear_secret">Clear secret</span></label><label><input type="radio" name="secret_${escapeAttribute(envKey)}" value="replace"> <span data-i18n="replace_with">Replace with</span></label><input class="config-control" type="password" name="value_${escapeAttribute(envKey)}" autocomplete="off" value=""></div>`;
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
  return `<label class="nowrap"><input type="checkbox" name="reset_${escapeAttribute(envKey)}" value="1"> <span data-i18n="reset_override">Reset override</span></label>`;
}

function renderHighRiskConfirm(field) {
  if (!field.highRisk || !field.editable) return '';
  const envKey = field.envKey ?? '';
  return `<label class="danger nowrap"><input type="checkbox" name="confirm_${escapeAttribute(envKey)}" value="1"> <span data-i18n="confirm_high_risk">Confirm high-risk change</span></label>`;
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

export function renderErrorPage({ csrfToken = '', status = 500, title = 'Error', message = 'Something went wrong', cspNonce = '' } = {}) {
  const body = `<section class="card"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><p class="muted">status ${escapeHtml(status)}</p></section>`;
  return csrfToken
    ? renderLayout({ title, active: '', csrfToken, body, cspNonce })
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${fontLinks()}${themeInitScript(cspNonce)}<style>${baseStyles()}</style></head><body><main class="centered"><h1 class="page-title">${escapeHtml(title)}</h1>${body}</main>${bodyScript(cspNonce)}</body></html>`;
}

export function renderJobsTable(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return '<p class="empty" data-i18n="empty_jobs">No jobs found.</p>';
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
  return `<div class="table-scroll"><table><thead><tr><th data-i18n="th_job_id">Job ID</th><th data-i18n="th_status">Status</th><th data-i18n="th_repository">Repository</th><th data-i18n="th_pr">PR</th><th data-i18n="th_actor">Actor</th><th data-i18n="th_diag_id">Diagnostic ID</th><th data-i18n="th_queued">Queued</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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

const STATE_OPTIONS = [
  ['succeeded', 'st_succeeded'],
  ['succeeded_with_warnings', 'st_succeeded_with_warnings'],
  ['failed', 'st_failed'],
  ['running', 'st_running'],
  ['queued', 'st_queued'],
  ['interrupted', 'st_interrupted'],
  ['stale', 'st_stale'],
  ['skipped', 'st_skipped'],
];
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

function renderJobsFilterForm(filters, pagination) {
  const size = pagination?.pageSize ?? filters.pageSize ?? 50;
  return `<form method="get" action="/admin/jobs" class="inline">
<label><span data-i18n="f_owner">Owner</span> <input name="owner" value="${escapeAttribute(filters.owner ?? '')}"></label>
<label><span data-i18n="f_repository">Repository</span> <input name="repository" value="${escapeAttribute(filters.repository ?? filters.repo ?? '')}"></label>
<label><span data-i18n="f_state">State/outcome</span> ${renderFilterSelect('state', filters.state ?? filters.status ?? filters.outcome, STATE_OPTIONS, 'f_all')}</label>
<label><span data-i18n="f_failure_kind">Failure kind</span> ${renderFilterSelect('failureKind', filters.failureKind, FAILURE_KIND_OPTIONS, 'f_all')}</label>
<label><span data-i18n="f_diag_id">Diagnostic ID</span> <input name="diagnosticId" value="${escapeAttribute(filters.diagnosticId ?? '')}"></label>
<div class="field-group"><label><span data-i18n="f_from">From</span> <input name="from" type="date" value="${escapeAttribute(filters.from ?? '')}"></label><label><span data-i18n="f_to">To</span> <input name="to" type="date" value="${escapeAttribute(filters.to ?? '')}"></label></div>
<input type="hidden" name="size" value="${escapeAttribute(size)}">
<button type="submit" class="primary" data-i18n="btn_apply">apply</button><a class="filter-reset" href="/admin/jobs" data-i18n="btn_reset">reset</a></form>`;
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

function renderServiceStatus(status, retention) {
  if (!status) return '';
  const storage = status.storage ?? {};
  const running = status.runningJob ?? status.running ?? null;
  const queued = status.queued ?? { count: status.queuedCount, items: [] };
  return `<section class="card"><h2 data-i18n="h2_service_status">Local service status</h2>
${renderDefinitionList([
    ['Uptime', safeDisplay(formatDuration(status.uptimeMs)), 'ss_uptime'],
    ['Started', safeDisplay(formatDate(status.startedAt)), 'ss_started'],
    ['Version', safeDisplay(status.version), 'ss_version'],
    ['Config revision', safeDisplay(status.configRevision), 'ss_config_revision'],
    ['Actual listening port', safeDisplay(status.actualListeningPort ?? status.listeningPort), 'ss_actual_port'],
    ['Configured port', safeDisplay(status.configuredPort ?? status.port), 'ss_configured_port'],
    ['Desired pending port', safeDisplay(status.desiredPendingPort ?? status.pendingPort), 'ss_pending_port'],
    ['Storage writable/degraded', safeDisplay(`${storage.writable ? 'writable' : 'not writable'} / ${storage.degraded ? 'degraded' : 'healthy'}`), 'ss_storage_health'],
    ['Storage size / budget', safeDisplay(`${formatBytes(storage.sizeBytes ?? storage.dirSizeBytes)} / ${formatBytes(storage.budgetBytes)}`), 'ss_storage_size'],
    ['Last retention', safeDisplay(formatDate(status.lastRetention?.finishedAt ?? status.lastRetention?.startedAt ?? retention?.lastRun?.finishedAt)), 'ss_last_retention'],
    ['Corrupt/truncated diagnostics', safeDisplay(formatDiagnosticCounts(status.diagnostics)), 'ss_diag_counts'],
  ])}
<h3 data-i18n="ss_running_job">Current running job</h3>${running ? renderJobsTable([runningJobAsListItem(running)]) : '<p class="empty" data-i18n="empty_running">No running job.</p>'}
<h3 data-i18n="ss_queued">Queued summaries</h3>${renderQueuedSummary(queued)}
<h3 data-i18n="ss_last_sf">Last success/failure</h3>${renderJobsTable([status.lastSuccess, status.lastFailure].filter(Boolean))}</section>`;
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
  return `<section class="card"><h2 data-i18n="h2_metrics">Metrics and trends</h2>${renderMetricsSummary(stats.total)}<div class="table-scroll"><table><thead><tr><th data-i18n="th_window">Window</th><th data-i18n="th_jobs">Jobs</th><th data-i18n="th_success_rate">Success rate</th><th data-i18n="m_dur_p50">Duration p50</th><th data-i18n="m_dur_p95">Duration p95</th><th data-i18n="m_qw_p50">Queue wait p50</th><th data-i18n="m_qw_p95">Queue wait p95</th><th data-i18n="m_avg_gen">Avg comments generated</th><th data-i18n="m_avg_post">Avg comments posted</th><th data-i18n="m_stale">Stale</th><th data-i18n="m_skipped">Skipped</th><th data-i18n="m_interrupted">Interrupted</th><th data-i18n="m_fail_class">Failure classification</th><th data-i18n="m_repo_rate">Repository success rate</th><th data-i18n="th_trend">Trend</th></tr></thead><tbody>${rows}</tbody></table></div>${renderDailyTrend(stats.dailyTrend ?? [])}</section>`;
}

function renderMetricsWindowRow(name, bucket) {
  return `<tr><th scope="row">${safeDisplay(name)}</th><td>${safeDisplay(numberOrDash(bucket.jobs))}</td><td>${safeDisplay(formatPercent(bucket.successRate))}</td><td>${safeDisplay(formatDuration(bucket.durationP50Ms))}</td><td>${safeDisplay(formatDuration(bucket.durationP95Ms))}</td><td>${safeDisplay(formatDuration(bucket.queueWaitP50Ms))}</td><td>${safeDisplay(formatDuration(bucket.queueWaitP95Ms))}</td><td>${safeDisplay(numberOrDash(averageComment(bucket, 'generated')))}</td><td>${safeDisplay(numberOrDash(averageComment(bucket, 'posted')))}</td><td>${safeDisplay(numberOrDash(bucket.stale))}</td><td>${safeDisplay(numberOrDash(bucket.skipped))}</td><td>${safeDisplay(numberOrDash(bucket.interrupted))}</td><td>${renderFailureKinds(bucket.failureKinds)}</td><td>${renderRepositoryRates(bucket.repositories ?? bucket.repoSuccessRates ?? bucket.repos)}</td><td>${renderTrendBar(bucket)}</td></tr>`;
}

function renderMetricsSummary(bucket) {
  if (!bucket) return '';
  return renderDefinitionList([
    ['Duration p50', safeDisplay(formatDuration(bucket.durationP50Ms)), 'm_dur_p50'],
    ['Duration p95', safeDisplay(formatDuration(bucket.durationP95Ms)), 'm_dur_p95'],
    ['Queue wait p50', safeDisplay(formatDuration(bucket.queueWaitP50Ms)), 'm_qw_p50'],
    ['Queue wait p95', safeDisplay(formatDuration(bucket.queueWaitP95Ms)), 'm_qw_p95'],
    ['Avg comments generated', safeDisplay(numberOrDash(averageComment(bucket, 'generated'))), 'm_avg_gen'],
    ['Avg comments posted', safeDisplay(numberOrDash(averageComment(bucket, 'posted'))), 'm_avg_post'],
    ['Stale', safeDisplay(numberOrDash(bucket.stale)), 'm_stale'],
    ['Skipped', safeDisplay(numberOrDash(bucket.skipped)), 'm_skipped'],
    ['Interrupted', safeDisplay(numberOrDash(bucket.interrupted)), 'm_interrupted'],
    ['Failure classification', renderFailureKinds(bucket.failureKinds), 'm_fail_class'],
    ['Repository success rate', renderRepositoryRates(bucket.repositories ?? bucket.repoSuccessRates ?? bucket.repos), 'm_repo_rate'],
  ]);
}

function renderDailyTrend(dailyTrend) {
  if (!Array.isArray(dailyTrend) || dailyTrend.length === 0) return '<h3 data-i18n="m_daily_trend">Daily trend</h3><p class="empty" data-i18n="empty_daily">No daily trend data.</p>';
  const rows = dailyTrend.map(day => `<tr><th scope="row">${safeDisplay(day.day)}</th><td>${safeDisplay(numberOrDash(day.jobs))}</td><td>${safeDisplay(formatPercent(day.successRate))}</td><td>${safeDisplay(numberOrDash(averageComment(day, 'generated')))}</td><td>${safeDisplay(numberOrDash(averageComment(day, 'posted')))}</td><td>${safeDisplay(numberOrDash(day.stale))}</td><td>${safeDisplay(numberOrDash(day.skipped))}</td><td>${safeDisplay(numberOrDash(day.interrupted))}</td></tr>`).join('');
  return `<h3 data-i18n="m_daily_trend">Daily trend</h3><div class="table-scroll"><table><thead><tr><th data-i18n="th_day">Day</th><th data-i18n="th_jobs">Jobs</th><th data-i18n="th_success_rate">Success rate</th><th data-i18n="m_avg_gen">Avg comments generated</th><th data-i18n="m_avg_post">Avg comments posted</th><th data-i18n="m_stale">Stale</th><th data-i18n="m_skipped">Skipped</th><th data-i18n="m_interrupted">Interrupted</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
  if (!Array.isArray(timeline) || timeline.length === 0) return '<p class="empty" data-i18n="empty_phase_timeline">No phase timeline.</p>';
  const rows = timeline.map(item => `<tr><td>${safeDisplay(formatDate(item.timestamp))}</td><td>${safeDisplay(item.label ?? item.phase ?? '')}</td><td>${safeDisplay(item.phase ?? '')}</td><td>${safeDisplay(item.message ?? '')}</td><td>${safeDisplay(item.source ?? '')}</td></tr>`).join('');
  return `<div class="table-scroll"><table><thead><tr><th data-i18n="th_time">Time</th><th data-i18n="th_event">Event</th><th data-i18n="th_phase">Phase</th><th data-i18n="th_message">Message</th><th data-i18n="th_source">Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
  return `<dl>${rows.map(([label, value, key]) => `<dt${key ? ` data-i18n="${escapeAttribute(key)}"` : ''}>${safeDisplay(label)}</dt><dd>${value == null || value === '' ? '<span class="empty">—</span>' : value}</dd>`).join('')}</dl>`;
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

const I18N = {
  en: {
    nav_dashboard: 'Dashboard', nav_jobs: 'Jobs', nav_config: 'Config', signout: 'sign out',
    toggle_theme: 'Toggle theme', toggle_lang: 'Switch language',
    page_dashboard: 'Dashboard', page_jobs: 'Jobs', page_config: 'Config',
    login_sub: 'open code review · github app bot', login_prompt: '// admin auth — enter password',
    label_password: 'password', sign_in: '[ sign in ]',
    strip_queued: 'Queued', strip_running: 'Running', strip_succeeded: 'Succeeded', strip_warnings: 'Warnings', strip_failed: 'Failed',
    h2_recent_jobs: 'Recent jobs', h2_diagnostics: 'Diagnostics', empty_jobs: 'No jobs found.', empty_diagnostics: 'No diagnostics.',
    h2_service_status: 'Local service status', ss_uptime: 'Uptime', ss_started: 'Started', ss_version: 'Version', ss_config_revision: 'Config revision',
    ss_actual_port: 'Actual listening port', ss_configured_port: 'Configured port', ss_pending_port: 'Desired pending port',
    ss_storage_health: 'Storage writable/degraded', ss_storage_size: 'Storage size / budget', ss_last_retention: 'Last retention', ss_diag_counts: 'Corrupt/truncated diagnostics',
    ss_running_job: 'Current running job', empty_running: 'No running job.', ss_queued: 'Queued summaries', ss_last_sf: 'Last success/failure',
    h2_metrics: 'Metrics and trends', m_dur_p50: 'Duration p50', m_dur_p95: 'Duration p95', m_qw_p50: 'Queue wait p50', m_qw_p95: 'Queue wait p95',
    m_avg_gen: 'Avg comments generated', m_avg_post: 'Avg comments posted', m_stale: 'Stale', m_skipped: 'Skipped', m_interrupted: 'Interrupted',
    m_fail_class: 'Failure classification', m_repo_rate: 'Repository success rate', m_daily_trend: 'Daily trend', empty_daily: 'No daily trend data.',
    th_window: 'Window', th_jobs: 'Jobs', th_success_rate: 'Success rate', th_trend: 'Trend', th_day: 'Day',
    h2_jobs: 'Jobs', f_owner: 'Owner', f_repository: 'Repository', f_state: 'State/outcome', f_failure_kind: 'Failure kind', f_diag_id: 'Diagnostic ID', f_from: 'From', f_to: 'To', btn_apply: 'apply', f_all: 'all', btn_reset: 'reset', st_succeeded: 'Succeeded', st_succeeded_with_warnings: 'Succeeded with warnings', st_failed: 'Failed', st_running: 'Running', st_queued: 'Queued', st_interrupted: 'Interrupted', st_stale: 'Stale', st_skipped: 'Skipped', fk_job_timeout: 'Job timeout', fk_ocr_config_error: 'OCR config error', fk_provider_rate_limited: 'Provider rate limited', fk_provider_auth_failed: 'Provider auth failed', fk_provider_unavailable: 'Provider unavailable', fk_ocr_runtime_error: 'OCR runtime error', fk_git_error: 'Git error', fk_github_rate_limited: 'GitHub rate limited', fk_github_api_error: 'GitHub API error', fk_bot_runtime_error: 'Bot runtime error', fk_invalid_ocr_output: 'Invalid OCR output',
    th_job_id: 'Job ID', th_status: 'Status', th_repository: 'Repository', th_pr: 'PR', th_actor: 'Actor', th_diag_id: 'Diagnostic ID', th_queued: 'Queued', btn_prev: 'prev', btn_next: 'next',
    back_jobs: '← jobs', h2_job_detail: 'Job detail', jd_repo_pr: 'Repository / PR', jd_actor: 'Actor', jd_job_id: 'Job ID', jd_diag_id: 'Diagnostic ID',
    jd_queued: 'Queued', jd_started: 'Started', jd_finished: 'Finished', jd_queue_wait: 'Queue wait', jd_duration: 'Duration', jd_phase_status: 'Phase / status',
    jd_head_sha: 'Head SHA', jd_base_sha: 'Base SHA', jd_config_revision: 'Config revision', jd_ocr_status: 'OCR status',
    jd_runtime: 'Runtime settings', jd_phase_timeline: 'Phase timeline', jd_review_counts: 'Review counts', jd_warnings_section: 'Warnings',
    jd_failure: 'Failure', jd_reporting_error: 'Reporting error', jd_cleanup_warning: 'Cleanup warning', jd_retained_logs: 'Retained logs', jd_job_diagnostics: 'Job diagnostics',
    jd_generated: 'Generated', jd_selected: 'Selected', jd_posted: 'Posted', jd_omitted: 'Omitted', jd_warnings_count: 'Warnings',
    empty_none: 'None.', empty_runtime: 'No runtime settings.', empty_phase_timeline: 'No phase timeline.', empty_logs: 'No retained logs.',
    th_time: 'Time', th_event: 'Event', th_phase: 'Phase', th_message: 'Message', th_source: 'Source', th_level: 'Level', th_fields: 'Fields',
    h2_configuration: 'Configuration', admin_storage_root: 'Admin storage root:', revision: 'Revision:', h2_edit_config: 'Edit configuration',
    th_field: 'Field', th_effective: 'Effective value', th_edit: 'Edit', th_state: 'State', btn_save_config: 'save configuration',
    keep_secret: 'Keep current secret', clear_secret: 'Clear secret', replace_with: 'Replace with', reset_override: 'Reset override', confirm_high_risk: 'Confirm high-risk change',
    not_editable: 'Not editable from dashboard.', secret_set: 'secret set', not_set: 'not set',
    aria_sections: 'Sections', aria_job_summary: 'Job summary', aria_jobs_pages: 'Jobs pages',
    logs_degraded: 'Log history is degraded.', pagination_summary: 'page {page} / {total-pages} · {total} jobs',
  },
  zh: {
    nav_dashboard: '仪表盘', nav_jobs: '任务', nav_config: '配置', signout: '退出',
    toggle_theme: '切换主题', toggle_lang: '切换语言',
    page_dashboard: '仪表盘', page_jobs: '任务', page_config: '配置',
    login_sub: 'open code review · github app 机器人', login_prompt: '// 管理员认证 — 输入密码',
    label_password: '密码', sign_in: '[ 登录 ]',
    strip_queued: '排队', strip_running: '运行中', strip_succeeded: '成功', strip_warnings: '带警告', strip_failed: '失败',
    h2_recent_jobs: '最近任务', h2_diagnostics: '诊断', empty_jobs: '暂无任务。', empty_diagnostics: '暂无诊断。',
    h2_service_status: '本地服务状态', ss_uptime: '运行时长', ss_started: '启动时间', ss_version: '版本', ss_config_revision: '配置版本',
    ss_actual_port: '实际监听端口', ss_configured_port: '配置端口', ss_pending_port: '待生效端口',
    ss_storage_health: '存储可写/降级', ss_storage_size: '存储用量 / 配额', ss_last_retention: '上次清理', ss_diag_counts: '损坏/截断的诊断',
    ss_running_job: '当前运行中任务', empty_running: '无运行中任务。', ss_queued: '排队摘要', ss_last_sf: '上次成功/失败',
    h2_metrics: '指标与趋势', m_dur_p50: '耗时 p50', m_dur_p95: '耗时 p95', m_qw_p50: '排队等待 p50', m_qw_p95: '排队等待 p95',
    m_avg_gen: '平均生成评论', m_avg_post: '平均发表评论', m_stale: '过期', m_skipped: '跳过', m_interrupted: '中断',
    m_fail_class: '失败分类', m_repo_rate: '仓库成功率', m_daily_trend: '每日趋势', empty_daily: '暂无每日趋势数据。',
    th_window: '时间窗', th_jobs: '任务数', th_success_rate: '成功率', th_trend: '趋势', th_day: '日期',
    h2_jobs: '任务', f_owner: '所有者', f_repository: '仓库', f_state: '状态/结果', f_failure_kind: '失败类型', f_diag_id: '诊断 ID', f_from: '起', f_to: '止', btn_apply: '应用', f_all: '全部', btn_reset: '重置', st_succeeded: '成功', st_succeeded_with_warnings: '带警告成功', st_failed: '失败', st_running: '运行中', st_queued: '排队', st_interrupted: '中断', st_stale: '过期', st_skipped: '跳过', fk_job_timeout: '任务超时', fk_ocr_config_error: 'OCR 配置错误', fk_provider_rate_limited: '服务商限流', fk_provider_auth_failed: '服务商鉴权失败', fk_provider_unavailable: '服务商不可用', fk_ocr_runtime_error: 'OCR 运行错误', fk_git_error: 'Git 错误', fk_github_rate_limited: 'GitHub 限流', fk_github_api_error: 'GitHub API 错误', fk_bot_runtime_error: 'Bot 运行错误', fk_invalid_ocr_output: 'OCR 输出无效',
    th_job_id: '任务 ID', th_status: '状态', th_repository: '仓库', th_pr: 'PR', th_actor: '触发者', th_diag_id: '诊断 ID', th_queued: '入队时间', btn_prev: '上一页', btn_next: '下一页',
    back_jobs: '← 任务', h2_job_detail: '任务详情', jd_repo_pr: '仓库 / PR', jd_actor: '触发者', jd_job_id: '任务 ID', jd_diag_id: '诊断 ID',
    jd_queued: '入队时间', jd_started: '开始时间', jd_finished: '结束时间', jd_queue_wait: '排队等待', jd_duration: '耗时', jd_phase_status: '阶段 / 状态',
    jd_head_sha: 'Head SHA', jd_base_sha: 'Base SHA', jd_config_revision: '配置版本', jd_ocr_status: 'OCR 状态',
    jd_runtime: '运行时设置', jd_phase_timeline: '阶段时间线', jd_review_counts: '评论统计', jd_warnings_section: '警告',
    jd_failure: '失败', jd_reporting_error: '上报错误', jd_cleanup_warning: '清理警告', jd_retained_logs: '保留日志', jd_job_diagnostics: '任务诊断',
    jd_generated: '已生成', jd_selected: '已选中', jd_posted: '已发表', jd_omitted: '已省略', jd_warnings_count: '警告',
    empty_none: '无。', empty_runtime: '无运行时设置。', empty_phase_timeline: '无阶段时间线。', empty_logs: '无保留日志。',
    th_time: '时间', th_event: '事件', th_phase: '阶段', th_message: '消息', th_source: '来源', th_level: '级别', th_fields: '字段',
    h2_configuration: '配置', admin_storage_root: '管理存储根目录：', revision: '版本：', h2_edit_config: '编辑配置',
    th_field: '字段', th_effective: '生效值', th_edit: '编辑', th_state: '状态', btn_save_config: '保存配置',
    keep_secret: '保留当前密钥', clear_secret: '清除密钥', replace_with: '替换为', reset_override: '重置覆盖', confirm_high_risk: '确认高风险变更',
    not_editable: '控制台不可编辑。', secret_set: '密钥已设', not_set: '未设置',
    aria_sections: '区块导航', aria_job_summary: '任务概览', aria_jobs_pages: '任务分页',
    logs_degraded: '日志历史已降级。', pagination_summary: '第 {page} / {total-pages} 页 · {total} 个任务',
  },
};

function themeInitScript(nonce) {
  return scriptTag(`(function(){try{var t=localStorage.getItem('ocr-theme');if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';}document.documentElement.dataset.theme=t;var l=localStorage.getItem('ocr-lang');if(l!=='en'&&l!=='zh'){l=((navigator.language||'en').toLowerCase().indexOf('zh')===0)?'zh':'en';}document.documentElement.lang=l;}catch(e){document.documentElement.dataset.theme='dark';document.documentElement.lang='en';}})();`, nonce);
}

function togglesHtml() {
  return `<div class="toggles"><button type="button" class="toggle-btn" data-act="toggle-theme" data-theme-target aria-label="Toggle theme"></button><button type="button" class="toggle-btn" data-act="toggle-lang" data-lang-target>中文</button></div>`;
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
  return scriptTag(`(function(){var I18N=${safeScriptJson(I18N)};function dict(){return I18N[document.documentElement.lang]||I18N.en;}function applyLang(){var d=dict();document.querySelectorAll('[data-i18n]').forEach(function(el){var k=el.getAttribute('data-i18n');if(d[k]!==undefined)el.textContent=d[k];});document.querySelectorAll('[data-i18n-aria-label]').forEach(function(el){var k=el.getAttribute('data-i18n-aria-label');if(d[k]!==undefined)el.setAttribute('aria-label',d[k]);});document.querySelectorAll('[data-i18n-template]').forEach(function(el){var t=d[el.getAttribute('data-i18n-template')];if(t!==undefined){el.textContent=t.split('{page}').join(el.getAttribute('data-page')||'').split('{total-pages}').join(el.getAttribute('data-total-pages')||'').split('{total}').join(el.getAttribute('data-total')||'');}});document.querySelectorAll('[data-theme-target]').forEach(function(b){b.textContent=document.documentElement.dataset.theme==='light'?'☾':'☀';b.setAttribute('aria-label',d.toggle_theme||'Toggle theme');});document.querySelectorAll('[data-lang-target]').forEach(function(b){b.textContent=document.documentElement.lang==='zh'?'EN':'中文';b.setAttribute('aria-label',d.toggle_lang||'Switch language');});}function setLang(l){document.documentElement.lang=l;try{localStorage.setItem('ocr-lang',l);}catch(e){}applyLang();}function setTheme(t){document.documentElement.dataset.theme=t;try{localStorage.setItem('ocr-theme',t);}catch(e){}applyLang();}document.addEventListener('click',function(e){var n=e.target.closest&&e.target.closest('[data-act]');if(!n)return;var a=n.getAttribute('data-act');if(a==='toggle-lang')setLang(document.documentElement.lang==='zh'?'en':'zh');else if(a==='toggle-theme')setTheme(document.documentElement.dataset.theme==='light'?'dark':'light');});applyLang();})();`, nonce);
}

function fontLinks() {
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap">`;
}

function baseStyles() {
  return `:root {
  color-scheme: dark;
  --bg: #09090b;
  --surface: rgba(255, 255, 255, 0.03);
  --surface-2: rgba(255, 255, 255, 0.05);
  --surface-3: rgba(255, 255, 255, 0.08);
  --border: rgba(255, 255, 255, 0.1);
  --border-bright: rgba(255, 255, 255, 0.2);
  --text: #f8fafc;
  --muted: #94a3b8;
  --faint: #475569;
  --amber: #fbbf24;
  --green: #34d399;
  --red: #f87171;
  --cyan: #38bdf8;
  --brand-gradient: linear-gradient(135deg, #38bdf8, #818cf8, #e879f9);
  --radius: 12px;
  --font-sans: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'Fira Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
}
* { box-sizing: border-box; }
::selection { background: rgba(56, 189, 248, 0.25); color: var(--text); }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--border-bright); }

body {
  margin: 0;
  background-color: var(--bg);
  background-image: 
    radial-gradient(circle at 15% 50%, rgba(56, 189, 248, 0.06), transparent 25%),
    radial-gradient(circle at 85% 30%, rgba(232, 121, 249, 0.06), transparent 25%);
  background-attachment: fixed;
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
p { margin: 0.75rem 0; }
a { color: var(--cyan); text-decoration: none; transition: all 0.2s ease; }
a:hover { color: #7dd3fc; text-shadow: 0 0 12px rgba(56,189,248,0.4); }
code { font-family: var(--font-mono); background: var(--surface-2); padding: 0.15em 0.4em; border-radius: 6px; color: #e2e8f0; font-size: 0.9em; border: 1px solid var(--border); }
pre { margin: 0.8rem 0; padding: 1rem; white-space: pre-wrap; word-break: break-word; color: #e2e8f0; background: rgba(0,0,0,0.4); border: 1px solid var(--border); border-radius: var(--radius); font-family: var(--font-mono); font-size: 13px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.2); }
h1, h2, h3, h4 { font-weight: 600; letter-spacing: -0.02em; }
:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }

header.topbar {
  position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 1rem; padding: 0.75rem 1.5rem;
  background: rgba(9, 9, 11, 0.7); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--border); box-shadow: 0 4px 20px rgba(0,0,0,0.3);
}
.brand {
  display: inline-flex; align-items: center; gap: 0.2rem; font-weight: 700; font-size: 18px; color: var(--text); letter-spacing: -0.02em;
}
.brand .mark {
  background: var(--brand-gradient); -webkit-background-clip: text; color: transparent; font-size: 20px; text-shadow: 0 0 24px rgba(129, 140, 248, 0.4);
}
.brand .cursor { color: var(--cyan); animation: blink 1.2s steps(2, start) infinite; margin-left: 2px; }
@keyframes blink { to { visibility: hidden; } }

nav.tabs { display: flex; gap: 0.5rem; margin-left: auto; }
nav.tabs a {
  font-size: 13px; font-weight: 500; color: var(--muted); padding: 0.5rem 1rem; border-radius: 8px; text-transform: uppercase; letter-spacing: 0.05em;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
nav.tabs a:hover { color: var(--text); background: var(--surface-2); transform: translateY(-1px); }
nav.tabs a.active { color: #fff; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.2); box-shadow: 0 0 16px rgba(56, 189, 248, 0.1); }

.signout { margin: 0; }
.signout button {
  font: inherit; font-size: 12px; font-weight: 500; color: var(--muted); background: transparent; text-transform: uppercase; letter-spacing: 0.05em;
  border: 1px solid var(--border); padding: 0.4rem 0.8rem; border-radius: 8px; cursor: pointer;
  transition: all 0.2s ease;
}
.signout button:hover { color: var(--red); border-color: rgba(248, 113, 113, 0.5); background: rgba(248, 113, 113, 0.05); }

main { max-width: 1240px; margin: 0 auto; padding: 2rem 1.5rem 5rem; }
main.centered { max-width: 500px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; }
.back { margin: 0 0 1.5rem; }
.back a { color: var(--muted); font-weight: 500; padding: 0.4rem 0.8rem; background: var(--surface); border-radius: 8px; border: 1px solid var(--border); transition: all 0.2s ease; }
.back a:hover { color: var(--text); background: var(--surface-2); transform: translateX(-2px); display: inline-block; }

.card {
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); margin-bottom: 1.5rem; padding: 1.5rem;
  box-shadow: 0 8px 32px rgba(0,0,0,0.2); backdrop-filter: blur(10px); transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(0,0,0,0.3); border-color: var(--border-bright); }
.card > h2, .card > h3, .card > summary > h2 {
  font-size: 14px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text); margin: -1.5rem -1.5rem 1.5rem;
  padding: 1rem 1.5rem; background: rgba(0,0,0,0.2); border-bottom: 1px solid var(--border); border-radius: var(--radius) var(--radius) 0 0;
  display: flex; align-items: center; gap: 0.5rem;
}
.card > h2::before, .card > summary > h2::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--brand-gradient); box-shadow: 0 0 10px rgba(129,140,248,0.5); }
.card > h3 { margin: 1.5rem -1.5rem 1rem; border-top: 1px solid var(--border); border-radius: 0; background: transparent; padding-top: 1.5rem; }
.card > *:last-child { margin-bottom: 0; }

dl { display: grid; grid-template-columns: minmax(140px, max-content) 1fr; gap: 0.8rem 1.5rem; align-items: center; }
dt { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
dd { margin: 0; color: var(--text); font-size: 14px; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }

h1.page-title { font-size: 28px; color: var(--text); margin: 0 0 2rem; font-weight: 700; background: var(--brand-gradient); -webkit-background-clip: text; color: transparent; display: inline-block; }

.strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
.strip .cell { padding: 1.5rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; transition: all 0.3s ease; position: relative; overflow: hidden; }
.strip .cell::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: transparent; transition: all 0.3s ease; }
.strip .cell:hover { transform: translateY(-3px); box-shadow: 0 8px 24px rgba(0,0,0,0.2); }
.strip .num { font-size: 2.5rem; font-weight: 700; line-height: 1; font-family: var(--font-sans); transition: color 0.2s ease; }
.strip .num.ok { color: var(--green); text-shadow: 0 0 20px rgba(52, 211, 153, 0.4); }
.strip .cell--ok::before { background: var(--green); }
.strip .num.warn { color: var(--amber); text-shadow: 0 0 20px rgba(251, 191, 36, 0.4); }
.strip .cell--warn::before { background: var(--amber); }
.strip .num.fail { color: var(--red); text-shadow: 0 0 20px rgba(248, 113, 113, 0.4); }
.strip .cell--fail::before { background: var(--red); }
.strip .num.run { color: var(--cyan); text-shadow: 0 0 20px rgba(56, 189, 248, 0.4); }
.strip .cell--run::before { background: var(--cyan); }
.strip .num.queued { color: var(--muted); }
.strip .cell--queued::before { background: var(--muted); }
.strip .lab { text-transform: uppercase; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; color: var(--muted); margin-top: 0.75rem; }

.table-scroll { overflow-x: auto; margin: 0.5rem 0; }
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13.5px; }
th, td { padding: 0.8rem 1rem; border-bottom: 1px solid var(--border); text-align: left; }
thead th { text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; background: rgba(0,0,0,0.2); border-top: 1px solid var(--border); }
thead th:first-child { border-top-left-radius: 8px; border-left: 1px solid var(--border); }
thead th:last-child { border-top-right-radius: 8px; border-right: 1px solid var(--border); }
tbody tr { transition: background 0.2s ease; }
tbody tr:hover { background: var(--surface-2); }
tbody td:first-child { border-left: 1px solid transparent; }
tbody td:last-child { border-right: 1px solid transparent; }
tbody tr:last-child td:first-child { border-bottom-left-radius: 8px; }
tbody tr:last-child td:last-child { border-bottom-right-radius: 8px; }

.status { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.75rem; border-radius: 20px; background: var(--surface-2); border: 1px solid var(--border); font-size: 12px; font-weight: 500; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); }
.dot--ok { background: var(--green); box-shadow: 0 0 10px rgba(52, 211, 153, 0.6); }
.dot--warn { background: var(--amber); box-shadow: 0 0 10px rgba(251, 191, 36, 0.6); }
.dot--run { background: var(--cyan); box-shadow: 0 0 10px rgba(56, 189, 248, 0.8); animation: pulse 1.5s infinite; }
.dot--fail { background: var(--red); box-shadow: 0 0 10px rgba(248, 113, 113, 0.6); }

@keyframes pulse { 0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.7); } 70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(56, 189, 248, 0); } 100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(56, 189, 248, 0); } }

button, input, select { font-family: var(--font-sans); color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 0.75rem; font-size: 13.5px; transition: all 0.2s ease; }
button { cursor: pointer; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; text-transform: uppercase; font-size: 11px; letter-spacing: 0.08em; }
button:hover { border-color: var(--cyan); background: rgba(56, 189, 248, 0.1); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
button.primary { background: var(--brand-gradient); color: #fff; border: none; font-weight: 600; padding: 0.6rem 1.2rem; box-shadow: 0 4px 15px rgba(129, 140, 248, 0.3); }
button.primary:hover { opacity: 0.9; box-shadow: 0 6px 20px rgba(129, 140, 248, 0.5); transform: translateY(-2px); }
button.primary:active { transform: translateY(0); box-shadow: 0 2px 8px rgba(129, 140, 248, 0.3); }
.filter-reset { font-family: var(--font-sans); font-size: 11px; font-weight: 600; line-height: normal; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; padding: 0.6rem 1.2rem; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); display: inline-flex; align-items: center; justify-content: center; text-decoration: none; align-self: flex-end; transition: all 0.2s ease; }
.filter-reset:hover { color: var(--text); border-color: var(--cyan); background: rgba(56, 189, 248, 0.1); transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.15); }
.filter-reset:active { transform: translateY(0); box-shadow: 0 2px 8px rgba(0,0,0,0.1); }

input:focus { border-color: var(--cyan); outline: none; box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2); }
input[type=radio], input[type=checkbox] { accent-color: var(--cyan); width: 1.2em; height: 1.2em; cursor: pointer; }

.inline { display: flex; gap: 1rem; align-items: flex-end; flex-wrap: wrap; background: rgba(0,0,0,0.2); padding: 1.5rem; border-radius: var(--radius); border: 1px solid var(--border); margin-bottom: 1.5rem; }
.inline label { display: grid; gap: 0.4rem; font-size: 11px; text-transform: uppercase; font-weight: 600; color: var(--muted); }
.inline input { min-width: 140px; }
.inline .field-group { display: flex; gap: 1rem; }

.alert { display: flex; gap: 0.75rem; background: rgba(248, 113, 113, 0.1); border: 1px solid rgba(248, 113, 113, 0.2); border-left: 4px solid var(--red); color: var(--text); padding: 1rem; border-radius: var(--radius); margin-bottom: 1rem; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
.alert::before { content: "!"; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; background: var(--red); color: #000; font-weight: bold; border-radius: 50%; font-size: 12px; }
.alert.success { background: rgba(52, 211, 153, 0.1); border-color: rgba(52, 211, 153, 0.2); border-left-color: var(--green); }
.alert.success::before { content: "✓"; background: var(--green); }
.alert ul { margin: 0; padding-left: 1.5rem; width: 100%; }

.pill { display: inline-flex; align-items: center; background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px; padding: 0.2rem 0.6rem; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text); margin: 0.2rem; transition: all 0.2s ease; }
.pill:hover { background: var(--surface-3); transform: translateY(-1px); }
.pill--ok { color: var(--green); border-color: rgba(52, 211, 153, 0.3); background: rgba(52, 211, 153, 0.1); }
.pill--warn { color: var(--amber); border-color: rgba(251, 191, 36, 0.3); background: rgba(251, 191, 36, 0.1); }
.pill--err { color: var(--red); border-color: rgba(248, 113, 113, 0.3); background: rgba(248, 113, 113, 0.1); }

.config-table th[scope=row] { width: 25%; }
.config-control { width: 100%; font-family: var(--font-mono); }
.stack { display: grid; gap: 0.6rem; }
.stack label { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 13.5px; text-transform: none; font-weight: normal; letter-spacing: 0; }

ul.diagnostics { list-style: none; margin: 0; padding: 0; }
ul.diagnostics li { padding: 0.75rem 0; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 0.8rem; align-items: center; }
ul.diagnostics li:last-child { border-bottom: 0; }
ul.diagnostics .diag-msg { flex: 1; min-width: 200px; color: var(--muted); }

nav.pagination { display: flex; gap: 1rem; align-items: center; justify-content: center; padding: 1.5rem 0 0; border-top: 1px solid var(--border); margin-top: 1.5rem; }
nav.pagination a { padding: 0.4rem 1rem; border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-weight: 500; font-size: 13px; background: var(--surface-2); transition: all 0.2s; }
nav.pagination a:hover { border-color: var(--cyan); color: var(--cyan); background: rgba(56, 189, 248, 0.1); transform: translateY(-1px); text-decoration: none; }
nav.pagination span { font-size: 13px; color: var(--muted); }
nav.pagination span[aria-disabled=true] { opacity: 0.5; }

main.login { max-width: 440px; margin: 10vh auto; padding: 0 1.5rem; perspective: 1000px; }
.login-head { font-size: 2.5rem; font-weight: 800; text-align: center; margin-bottom: 0.5rem; background: var(--brand-gradient); -webkit-background-clip: text; color: transparent; text-shadow: 0 10px 30px rgba(129, 140, 248, 0.3); }
.login-head .cursor { color: var(--cyan); animation: blink 1.2s steps(2, start) infinite; display: inline-block; }
.login-sub { text-align: center; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.15em; margin-bottom: 2.5rem; font-weight: 600; }
.login-box { display: grid; gap: 1.2rem; background: rgba(20, 20, 25, 0.6); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 2.5rem; box-shadow: 0 20px 40px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1); transform-style: preserve-3d; animation: floatUp 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.login-box .login-prompt { margin: 0; color: var(--muted); font-size: 12px; font-weight: 500; text-align: center; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.08em; }
.login-box label { color: var(--text); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
.login-box input { width: 100%; padding: 0.75rem 1rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); font-size: 15px; border-radius: 8px; transition: all 0.3s; }
.login-box input:focus { background: rgba(0,0,0,0.5); border-color: var(--cyan); box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.15); }
.login-box button { width: 100%; padding: 0.8rem; font-size: 14px; margin-top: 0.5rem; border-radius: 8px; justify-self: start; }

@keyframes floatUp { from { opacity: 0; transform: translateY(20px) rotateX(10deg); } to { opacity: 1; transform: translateY(0) rotateX(0); } }
main > * { animation: floatUp 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
main > .card:nth-child(2) { animation-delay: 0.1s; }
main > .card:nth-child(3) { animation-delay: 0.2s; }
main > .card:nth-child(4) { animation-delay: 0.3s; }

details.card > summary { cursor: pointer; list-style: none; display: block; }
details.card > summary::-webkit-details-marker { display: none; }
details.card > summary > h2 { transition: background 0.2s; }
details.card > summary:hover > h2 { background: rgba(255,255,255,0.05); }
details.card > summary > h2::after { content: "\\2192"; margin-left: auto; font-family: sans-serif; transition: transform 0.3s ease; font-size: 14px; }
details.card[open] > summary > h2::after { transform: rotate(90deg); }

.empty { color: var(--faint); font-style: italic; }
.danger { color: var(--red); }
.nowrap { display: block; white-space: nowrap; margin-top: 0.35rem; }

@media (max-width: 768px) {
  header.topbar { flex-direction: column; align-items: stretch; padding: 1rem; gap: 1rem; }
  nav.tabs { margin-left: 0; overflow-x: auto; padding-bottom: 0.5rem; }
  .strip { grid-template-columns: 1fr 1fr; }
  dl { grid-template-columns: 1fr; gap: 0.2rem; }
  dl dt { margin-top: 0.8rem; border-bottom: none; padding-bottom: 0; }
  dl dd { padding-top: 0; }
  .inline { flex-direction: column; align-items: stretch; }
  .inline input { width: 100%; }
}

.toggles { display: flex; gap: 0.4rem; margin-left: 0.5rem; }
.toggle-btn { font-size: 13px; font-weight: 600; min-width: 36px; padding: 0.4rem 0.55rem; line-height: 1; }
.toggle-btn:hover { color: var(--cyan); border-color: var(--cyan); transform: translateY(-1px); }
.login .toggles { justify-content: center; margin: 0 auto 1.5rem; }

:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f6f7f9;
  --surface: rgba(0,0,0,0.02);
  --surface-2: rgba(0,0,0,0.04);
  --surface-3: rgba(0,0,0,0.06);
  --border: rgba(0,0,0,0.08);
  --border-bright: rgba(0,0,0,0.15);
  --text: #0f172a;
  --muted: #475569;
  --faint: #94a3b8;
  --amber: #d97706;
  --green: #059669;
  --red: #dc2626;
  --cyan: #0284c7;
}
:root[data-theme="light"] body {
  background-image: radial-gradient(circle at 15% 50%, rgba(2,132,199,0.05), transparent 25%), radial-gradient(circle at 85% 30%, rgba(232,121,249,0.05), transparent 25%);
}
:root[data-theme="light"] header.topbar { background: rgba(255,255,255,0.7); }
:root[data-theme="light"] .card { box-shadow: 0 8px 32px rgba(0,0,0,0.06); }
:root[data-theme="light"] .card:hover { box-shadow: 0 12px 40px rgba(0,0,0,0.1); }
:root[data-theme="light"] .card > h2, :root[data-theme="light"] .card > summary > h2 { background: rgba(0,0,0,0.04); }
:root[data-theme="light"] thead th { background: rgba(0,0,0,0.03); }
:root[data-theme="light"] .inline { background: rgba(0,0,0,0.03); }
:root[data-theme="light"] code { color: #0f172a; }
:root[data-theme="light"] pre { color: #0f172a; background: rgba(0,0,0,0.04); }
:root[data-theme="light"] nav.tabs a.active { color: #0f172a; }
:root[data-theme="light"] a { color: #0369a1; }
:root[data-theme="light"] a:hover { color: #075985; text-shadow: none; }
:root[data-theme="light"] .login-box { background: rgba(255,255,255,0.7); border-color: rgba(0,0,0,0.1); box-shadow: 0 20px 40px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.5); }
:root[data-theme="light"] .login-box input { background: rgba(0,0,0,0.03); border-color: rgba(0,0,0,0.1); }
:root[data-theme="light"] .login-box input:focus { background: rgba(0,0,0,0.05); }

.dot--queued { background: var(--muted); }
.muted { color: var(--muted); }
.field-meta { margin-bottom: 0.5rem; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; scroll-behavior: auto !important; }
}`;
}
