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

export function renderDashboardPage({ csrfToken, summary = {}, recentJobs = [], diagnostics = [] } = {}) {
  const cards = [
    ['Queued', summary.queued],
    ['Running', summary.running],
    ['Succeeded', summary.succeeded],
    ['Failed', summary.failed],
  ].map(([label, value]) => `<section class="metric"><strong>${escapeHtml(numberOrDash(value))}</strong><span>${escapeHtml(label)}</span></section>`).join('');

  const body = `<section class="grid">${cards}</section>
<section class="card"><h2>Recent jobs</h2>${renderJobsTable(recentJobs)}</section>
<section class="card"><h2>Diagnostics</h2>${renderDiagnosticsList(diagnostics)}</section>`;
  return renderLayout({ title: 'Dashboard', active: 'dashboard', csrfToken, body });
}

export function renderJobsPage({ csrfToken, jobs = [], filter = '' } = {}) {
  const body = `<section class="card"><h2>Jobs</h2>
<form method="get" action="/admin/jobs" class="inline"><label for="filter">Filter</label><input id="filter" name="filter" value="${escapeAttribute(filter)}"><button type="submit">Apply</button></form>
${renderJobsTable(jobs)}</section>`;
  return renderLayout({ title: 'Jobs', active: 'jobs', csrfToken, body });
}

export function renderConfigPage({ csrfToken, config = {}, adminRoot = '/data/admin' } = {}) {
  const rows = Object.entries(config)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `<tr><th scope="row">${escapeHtml(key)}</th><td>${escapeHtml(formatConfigValue(key, value))}</td></tr>`)
    .join('');
  const body = `<section class="card"><h2>Configuration</h2><p>Admin storage root: <code>${escapeHtml(adminRoot)}</code></p><table><tbody>${rows}</tbody></table></section>
<section class="card"><h2>Set override</h2><form method="post" action="/admin/config" class="inline"><input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}"><label for="key">Env key</label><input id="key" name="key" required><label for="value">Value</label><input id="value" name="value"><button type="submit">Save</button></form></section>`;
  return renderLayout({ title: 'Config', active: 'config', csrfToken, body });
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
    const repo = job?.repo ?? job?.repository;
    const trigger = job?.trigger ?? job?.triggeredBy;
    const createdAt = job?.createdAt ?? job?.startedAt;
    return `<tr><td><code>${escapeHtml(redactInlineSecrets(id ?? ''))}</code></td><td>${escapeHtml(redactInlineSecrets(status ?? ''))}</td><td>${escapeHtml(redactInlineSecrets(repo ?? ''))}</td><td>${escapeHtml(redactInlineSecrets(trigger ?? ''))}</td><td>${escapeHtml(formatDate(createdAt))}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Job ID</th><th>Status</th><th>Repository</th><th>Triggered by</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table>`;
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
  return `:root{color-scheme:light dark;font-family:Inter,system-ui,sans-serif;background:#0f172a;color:#e2e8f0}body{margin:0}header{display:flex;gap:1rem;align-items:center;padding:1rem 1.5rem;background:#111827;border-bottom:1px solid #334155}h1{font-size:1.2rem;margin:0}nav{display:flex;gap:.75rem;flex:1}a{color:#93c5fd;text-decoration:none}a.active{color:#fff;font-weight:700}main{max-width:1100px;margin:0 auto;padding:1.5rem}.login{max-width:420px}.card,.metric{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1rem;margin-bottom:1rem}.narrow{display:grid;gap:.75rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem}.metric strong{display:block;font-size:2rem}.metric span{color:#cbd5e1}table{width:100%;border-collapse:collapse}th,td{padding:.6rem;border-bottom:1px solid #334155;text-align:left;vertical-align:top}button,input{font:inherit;border-radius:8px;border:1px solid #475569;padding:.55rem}.alert{background:#7f1d1d;border:1px solid #ef4444;padding:.75rem;border-radius:8px}.empty{color:#94a3b8}.inline{display:flex;gap:.5rem;align-items:end;margin-bottom:1rem}.pill{background:#334155;border-radius:999px;padding:.1rem .45rem;font-size:.8rem}code{word-break:break-all}`;
}
