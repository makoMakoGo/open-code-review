import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { App } from 'octokit';

const DEFAULT_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_LLM_PROXY_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

const GIT_TIMEOUT_MS = 180_000;
const VALID_OCR_STATUSES = new Set(['success', 'completed_with_warnings', 'completed_with_errors', 'skipped']);

function requiredEnv(name, env = process.env) {
  const value = env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name, defaultValue, env = process.env) {
  const value = env[name];
  if (value == null || value.trim() === '') return defaultValue;
  return value.trim();
}

function optionalSecret(name, env = process.env) {
  const value = env[name];
  if (value == null || value.trim() === '') return '';
  return value.trim();
}

function csvSet(value) {
  const out = new Set();
  for (const item of value.split(',')) {
    const trimmed = item.trim().toLowerCase();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

function parseBool(value, name) {
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean-like value`);
}

function parseIntegerEnv(name, defaultValue, { min = 0, env = process.env } = {}) {
  const raw = optionalEnv(name, String(defaultValue), env);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be >= ${min}`);
  return value;
}

function loadConfig(env = process.env) {
  const triggerPhrases = csvSet(optionalEnv('BOT_TRIGGER_PHRASES', requiredEnv('BOT_TRIGGER_PHRASE', env), env));
  const allowedUsers = csvSet(requiredEnv('ALLOWED_USERS', env));
  const allowedUserIDs = csvSet(optionalEnv('ALLOWED_USER_IDS', '', env));
  const allowedRepoOwners = csvSet(requiredEnv('ALLOWED_REPO_OWNERS', env));
  if (triggerPhrases.size === 0) throw new Error('BOT_TRIGGER_PHRASES must contain at least one command');
  if (allowedUsers.size === 0 && allowedUserIDs.size === 0) {
    throw new Error('ALLOWED_USERS or ALLOWED_USER_IDS must contain at least one GitHub account');
  }
  if (allowedRepoOwners.size === 0) throw new Error('ALLOWED_REPO_OWNERS must contain at least one owner');
  const llmProxyTargetURL = optionalEnv('LLM_PROXY_TARGET_URL', '', env);
  const llmProxyInternalToken = optionalSecret('LLM_PROXY_INTERNAL_TOKEN', env);
  const llmProxyUpstreamAuthHeader = optionalEnv('LLM_PROXY_UPSTREAM_AUTH_HEADER', '', env);
  const llmProxyUpstreamToken = optionalSecret('LLM_PROXY_UPSTREAM_TOKEN', env);
  if (llmProxyTargetURL && !llmProxyInternalToken) {
    throw new Error('LLM_PROXY_INTERNAL_TOKEN is required when LLM_PROXY_TARGET_URL is set');
  }
  if ((llmProxyUpstreamAuthHeader === '') !== (llmProxyUpstreamToken === '')) {
    throw new Error('LLM_PROXY_UPSTREAM_AUTH_HEADER and LLM_PROXY_UPSTREAM_TOKEN must be set together');
  }


  return {
    port: parseIntegerEnv('PORT', 3007, { min: 1, env }),
    appId: requiredEnv('GITHUB_APP_ID', env),
    privateKeyPath: optionalEnv('GITHUB_APP_PRIVATE_KEY_PATH', '/config/github-app-private-key.pem', env),
    webhookSecret: requiredEnv('GITHUB_WEBHOOK_SECRET', env),
    triggerPhrases,
    allowedUsers,
    allowedUserIDs,
    allowedRepoOwners,
    repoRoot: requiredEnv('BOT_REPO_ROOT', env),
    maxComments: parseIntegerEnv('MAX_REVIEW_COMMENTS', 30, { min: 1, env }),
    jobTimeoutMs: parseIntegerEnv('JOB_TIMEOUT_MS', 20 * 60 * 1000, { min: 1000, env }),
    cleanupWorkdir: parseBool(optionalEnv('CLEANUP_WORKDIR', 'true', env), 'CLEANUP_WORKDIR'),
    webhookBodyLimitBytes: parseIntegerEnv('WEBHOOK_BODY_LIMIT_BYTES', DEFAULT_WEBHOOK_BODY_LIMIT_BYTES, { min: 1024, env }),
    llmProxyBodyLimitBytes: parseIntegerEnv('LLM_PROXY_BODY_LIMIT_BYTES', DEFAULT_LLM_PROXY_BODY_LIMIT_BYTES, { min: 1024, env }),
    ocrConcurrency: parseIntegerEnv('OCR_CONCURRENCY', 1, { min: 1, env }),
    ocrMaxGitProcs: parseIntegerEnv('OCR_MAX_GIT_PROCS', 2, { min: 1, env }),
    ocrPerFileTimeoutMinutes: parseIntegerEnv('OCR_PER_FILE_TIMEOUT_MINUTES', 10, { min: 1, env }),
    llmProxyTargetURL,
    llmProxyUserAgent: optionalEnv('LLM_PROXY_USER_AGENT', 'open-code-review-github-app-bot/0.1.0', env),
    llmProxyXApp: optionalEnv('LLM_PROXY_X_APP', '', env),
    llmProxyInternalToken,
    llmProxyUpstreamAuthHeader,
    llmProxyUpstreamToken,
    ocrEnv: buildOcrEnv(env),
  };
}

function requiredEnvFromFile(filePath, envName) {
  try {
    const value = fsSync.readFileSync(filePath, 'utf8');
    if (value.trim() === '') throw new Error(`${envName} points to an empty file`);
    return value;
  } catch (error) {
    throw new Error(`Cannot read ${envName}: ${error.message}`);
  }
}

function buildOcrEnv(env = process.env) {
  return {
    OCR_LLM_URL: requiredEnv('OCR_LLM_URL', env),
    OCR_LLM_TOKEN: requiredEnv('OCR_LLM_TOKEN', env),
    OCR_LLM_MODEL: requiredEnv('OCR_LLM_MODEL', env),
    OCR_USE_ANTHROPIC: optionalEnv('OCR_USE_ANTHROPIC', 'false', env),
    OCR_LLM_AUTH_HEADER: optionalEnv('OCR_LLM_AUTH_HEADER', '', env),
  };
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyGitHubSignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqualString(expected, signatureHeader);
}

function readRequestBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error(`request body exceeds ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function copyProxyHeaders(req, config) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (['host', 'connection', 'content-length', 'accept-encoding', 'x-internal-token', 'authorization', 'x-api-key', 'cookie', 'proxy-authorization'].includes(lower)) continue;
    if (Array.isArray(value)) headers[key] = value.join(', ');
    else if (value != null) headers[key] = value;
  }
  headers['user-agent'] = config.llmProxyUserAgent;
  if (config.llmProxyXApp) headers['x-app'] = config.llmProxyXApp;
  if (config.llmProxyUpstreamAuthHeader && config.llmProxyUpstreamToken) headers[config.llmProxyUpstreamAuthHeader] = config.llmProxyUpstreamToken;
  return headers;
}
function extractInternalTokenFromHeaders(headers) {
  const apiKey = headers['x-api-key'];
  if (apiKey != null) return String(apiKey);

  const authorization = headers.authorization;
  if (authorization == null) return '';
  const value = String(authorization).trim();
  const bearerPrefix = 'bearer ';
  if (value.toLowerCase().startsWith(bearerPrefix)) return value.slice(bearerPrefix.length).trim();
  return value;
}


function verifyInternalToken(expected, actual) {
  return expected !== '' && actual != null && timingSafeEqualString(expected, String(actual));
}

async function proxyLLMRequest(req, res, config, rawBody) {
  if (!config.llmProxyTargetURL) {
    json(res, 500, { error: 'LLM proxy target is not configured' });
    return;
  }
  const upstream = await fetch(config.llmProxyTargetURL, {
    method: 'POST',
    headers: copyProxyHeaders(req, config),
    body: rawBody,
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'content-length': body.length,
  });
  res.end(body);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isTrigger(body, triggerPhrases) {
  return triggerPhrases.has(body.trim().toLowerCase());
}

function authorizePayload(payload, config) {
  if (payload.action !== 'created') return { ok: false, reason: 'ignored action' };
  if (!payload.issue?.pull_request) return { ok: false, reason: 'not a pull request comment' };
  if (!isTrigger(payload.comment?.body || '', config.triggerPhrases)) return { ok: false, reason: 'trigger phrase not matched' };

  const sender = String(payload.sender?.login || '').toLowerCase();
  const senderID = String(payload.sender?.id || '').toLowerCase();
  if (!config.allowedUsers.has(sender) && !config.allowedUserIDs.has(senderID)) return { ok: false, reason: 'sender not allowed' };

  const owner = String(payload.repository?.owner?.login || '').toLowerCase();
  if (!config.allowedRepoOwners.has(owner)) return { ok: false, reason: 'repo owner not allowed' };

  if (payload.repository?.private) return { ok: false, reason: 'private repo ignored' };
  if (!payload.installation?.id) return { ok: false, reason: 'missing installation id' };

  return { ok: true };
}

class ProcessError extends Error {
  constructor({ phase, command, args, timedOut, timeoutMs, exitCode, stdout, stderr, cause }) {
    const reason = timedOut ? `timed out after ${timeoutMs}ms` : exitCode == null ? 'failed to start' : `exited ${exitCode}`;
    super(`${command} ${args.join(' ')} ${reason}: ${stderr || stdout || cause?.message || ''}`);
    this.name = 'ProcessError';
    this.phase = phase;
    this.command = command;
    this.args = args;
    this.timedOut = timedOut;
    this.timeoutMs = timeoutMs;
    this.exitCode = exitCode;
    this.stdout = stdout || '';
    this.stderr = stderr || '';
    this.cause = cause;
  }
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, options.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ProcessError({ phase: options.phase, command, args, timedOut: false, timeoutMs: options.timeoutMs, exitCode: null, stdout, stderr, cause: error }));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolve({ stdout, stderr });
      } else {
        reject(new ProcessError({ phase: options.phase, command, args, timedOut, timeoutMs: options.timeoutMs, exitCode: code, stdout, stderr, cause: signal ? new Error(`terminated by ${signal}`) : undefined }));
      }
    });
  });
}

async function ensureCleanDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true, mode: 0o755 });
}

function safeSlug(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '-');
}

function safeFence(content) {
  const matches = String(content || '').match(/`+/g) || [];
  const maxTicks = matches.reduce((max, ticks) => Math.max(max, ticks.length), 0);
  return '`'.repeat(Math.max(3, maxTicks + 1));
}

function fencedBlock(content, language = '') {
  const text = String(content || '');
  const fence = safeFence(text);
  let block = `${fence}${language}\n${text}`;
  if (!text.endsWith('\n')) block += '\n';
  return `${block}${fence}`;
}

function formatComment(comment) {
  let body = String(comment.content || '');
  if (comment.suggestion_code && comment.existing_code) {
    body += '\n\n**Suggestion:**\n' + fencedBlock(comment.suggestion_code, 'suggestion');
  }
  return body;
}

function formatSummaryComment(comment, error) {
  let md = `### ${comment.path}`;
  if (comment.start_line && comment.end_line) md += ` L${comment.start_line}-L${comment.end_line}`;
  md += '\n\n';
  if (error) md += `GitHub could not post this as an inline comment: ${error}\n\n`;
  md += String(comment.content || '');
  if (comment.suggestion_code && comment.existing_code) {
    md += '\n\n<details><summary>Suggested change</summary>\n\n';
    md += '**Before:**\n' + fencedBlock(comment.existing_code) + '\n\n';
    md += '**After:**\n' + fencedBlock(comment.suggestion_code) + '\n\n';
    md += '</details>';
  }
  return md;
}

function buildReviewComment(comment) {
  if (!comment.path) return null;
  const start = Number(comment.start_line || 0);
  const end = Number(comment.end_line || 0);
  if (start < 1 && end < 1) return null;

  const reviewComment = {
    path: comment.path,
    body: formatComment(comment),
  };
  if (start >= 1 && end >= 1 && start !== end) {
    reviewComment.start_line = start;
    reviewComment.line = end;
    reviewComment.start_side = 'RIGHT';
    reviewComment.side = 'RIGHT';
  } else {
    reviewComment.line = end >= 1 ? end : start;
    reviewComment.side = 'RIGHT';
  }
  return reviewComment;
}
function formatDurationMs(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) return 'unknown duration';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0 && remainingSeconds === 0) return `${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${seconds}s`;
}

function classifyOcrFailure(error, config) {
  const message = String(error?.message || error || '');
  const lower = message.toLowerCase();
  const timeoutMs = error?.timedOut && Number.isSafeInteger(error.timeoutMs) ? error.timeoutMs : null;

  if (timeoutMs != null) {
    const timeout = formatDurationMs(timeoutMs);
    return {
      kind: 'job_timeout',
      title: 'OpenCodeReview did not finish before the bot timeout.',
      reason: `review exceeded the ${timeout} job timeout`,
      retryable: true,
      next: 'Retry after reducing PR size, raising JOB_TIMEOUT_MS, or increasing OCR_CONCURRENCY.',
      details: [`Timeout: ${timeout}`],
    };
  }

  if (lower.includes('unsupported auth_header') || lower.includes('missing required environment variable') || lower.includes('ocr environment') || lower.includes('resolve llm endpoint')) {
    return {
      kind: 'ocr_config_error',
      title: 'OpenCodeReview could not start because the LLM configuration is invalid.',
      reason: 'bot service configuration is invalid',
      retryable: false,
      next: 'A bot operator needs to fix the service configuration before retrying.',
      details: [],
    };
  }

  if (/\b429\b/.test(lower) || lower.includes('rate limit') || lower.includes('rate-limit') || lower.includes('too many requests') || lower.includes('concurrency limit')) {
    return {
      kind: 'provider_rate_limited',
      title: 'OpenCodeReview was rate-limited by the LLM provider.',
      reason: 'provider rate or concurrency limit was reached',
      retryable: true,
      next: 'Retry later, or ask a bot operator to lower OCR_CONCURRENCY or raise the provider quota.',
      details: [],
    };
  }

  if (/\b(401|403)\b/.test(lower) || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('invalid api key') || lower.includes('invalid_api_key')) {
    return {
      kind: 'provider_auth_failed',
      title: 'OpenCodeReview could not authenticate with the LLM provider.',
      reason: 'provider authentication failed',
      retryable: false,
      next: 'A bot operator needs to refresh or correct the provider token before retrying.',
      details: [],
    };
  }

  if (/\b5\d\d\b/.test(lower) || lower.includes('econnreset') || lower.includes('etimedout') || lower.includes('enotfound') || lower.includes('fetch failed') || lower.includes('socket hang up')) {
    return {
      kind: 'provider_unavailable',
      title: 'OpenCodeReview failed because the LLM provider was unavailable.',
      reason: 'provider service or network request failed',
      retryable: true,
      next: 'Retry later. If this keeps happening, a bot operator should inspect provider connectivity.',
      details: [],
    };
  }

  return {
    kind: 'ocr_runtime_error',
    title: 'OpenCodeReview failed while running OCR.',
    reason: 'unclassified OCR runtime error',
    retryable: false,
    next: 'A bot operator should inspect the logs with the diagnostic id below.',
    details: [],
  };
}

function classifyReviewFailure(error, config) {
  if (error?.phase === 'ocr') return classifyOcrFailure(error, config);
  if (error?.phase === 'git') {
    const timeout = error.timedOut && Number.isSafeInteger(error.timeoutMs) ? formatDurationMs(error.timeoutMs) : null;
    return {
      kind: 'git_error',
      title: 'OpenCodeReview could not prepare the pull request checkout.',
      reason: timeout ? `git ${error.command || 'command'} exceeded the ${timeout} timeout` : 'git command failed',
      retryable: true,
      next: 'Retry later. If this keeps happening, a bot operator should inspect repository access and network connectivity.',
      details: timeout ? [`Timeout: ${timeout}`] : [],
    };
  }

  if (Number.isInteger(error?.status) || Number.isInteger(error?.response?.status)) {
    const status = error.status || error.response.status;
    const headers = error.response?.headers ?? {};
    const message = String(error.message || '').toLowerCase();
    const rateLimited = status === 429 || (status === 403 && (String(headers['x-ratelimit-remaining']) === '0' || headers['retry-after'] != null || message.includes('rate limit')));
    return {
      kind: rateLimited ? 'github_rate_limited' : 'github_api_error',
      title: rateLimited ? 'OpenCodeReview was rate-limited by GitHub.' : 'OpenCodeReview could not complete a GitHub API request.',
      reason: rateLimited ? `GitHub API rate limit returned ${status}` : `GitHub API returned ${status}`,
      retryable: rateLimited || status >= 500,
      next: rateLimited ? 'Retry after GitHub rate limits reset.' : 'Retry later. If this keeps happening, a bot operator should inspect the GitHub App installation and permissions.',
      details: [],
    };
  }

  return {
    kind: 'bot_runtime_error',
    title: 'OpenCodeReview failed before posting review comments.',
    reason: 'unclassified bot runtime error',
    retryable: false,
    next: 'A bot operator should inspect the logs with the diagnostic id below.',
    details: [],
  };
}

function buildInvalidOcrOutputFailure(stdout) {
  return {
    kind: 'invalid_ocr_output',
    title: 'OpenCodeReview completed but returned invalid JSON.',
    reason: 'OCR output could not be parsed as JSON',
    retryable: false,
    next: 'A bot operator should inspect the logs with the diagnostic id below.',
    details: [
      `OCR stdout bytes: ${Buffer.byteLength(stdout, 'utf8')}`,
      `OCR stdout sha256: ${crypto.createHash('sha256').update(stdout).digest('hex')}`,
    ],
  };
}

function validateOcrResult(result) {
  return Boolean(result && typeof result === 'object' && VALID_OCR_STATUSES.has(result.status) && (result.comments == null || Array.isArray(result.comments)));
}

function buildPartialOcrSummary(result, diagnosticId) {
  if (result.status !== 'completed_with_errors') return '';
  const warnings = Array.isArray(result.warnings) ? result.warnings.length : 0;
  return [
    'OpenCodeReview completed with errors; some files may not have been reviewed.',
    '',
    `- Warnings: ${warnings}`,
    `- Diagnostic id: \`${diagnosticId}\``,
  ].join('\n');
}

function buildFailureComment(failure, diagnosticId) {
  const lines = [
    failure.title,
    '',
    `- Reason: ${failure.reason}`,
    `- Retry: ${failure.retryable ? 'yes' : 'no'}`,
  ];
  for (const detail of failure.details) lines.push(`- ${detail}`);
  lines.push(`- Next: ${failure.next}`);
  lines.push(`- Diagnostic id: \`${diagnosticId}\``);
  return lines.join('\n');
}

function shouldDiscardStaleReview(reviewed, currentPull) {
  return reviewed.headSha !== currentPull.head.sha || reviewed.baseSha !== currentPull.base.sha || reviewed.baseRef !== currentPull.base.ref;
}

function buildStaleReviewComment(reviewed, currentPull, diagnosticId) {
  return [
    'PR changed while OpenCodeReview was running; stale review results were discarded.',
    '',
    `- Reviewed head: \`${reviewed.headSha}\``,
    `- Current head: \`${currentPull.head.sha}\``,
    `- Reviewed base: \`${reviewed.baseRef}@${reviewed.baseSha}\``,
    `- Current base: \`${currentPull.base.ref}@${currentPull.base.sha}\``,
    '- Result: no review comments were posted for the stale diff',
    '- Next: re-run the trigger if a review is still needed for the current diff',
    `- Diagnostic id: \`${diagnosticId}\``,
  ].join('\n');
}

class JobQueue {
  constructor(handler) {
    this.handler = handler;
    this.running = false;
    this.queue = [];
    this.known = new Set();
  }

  enqueue(key, payload) {
    if (this.known.has(key)) return false;
    this.known.add(key);
    this.queue.push({ key, payload });
    this.drain();
    return true;
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      try {
        await this.handler(job.payload);
      } catch (error) {
        console.error('job failed', { key: job.key, error: error.stack || error.message });
      } finally {
        this.known.delete(job.key);
      }
    }
    this.running = false;
  }
}

async function postFailureComment(octokit, owner, repo, pullNumber, failure, diagnosticId) {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: buildFailureComment(failure, diagnosticId),
  });
}

async function handleReviewJob(payload, config) {
  let workdir = '';
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.issue.number;
  const installationId = payload.installation.id;
  const privateKey = requiredEnvFromFile(config.privateKeyPath, 'GITHUB_APP_PRIVATE_KEY_PATH');
  const app = new App({ appId: config.appId, privateKey });
  const octokit = await app.getInstallationOctokit(installationId);
  const diagnosticId = `${owner}/${repo}#${pullNumber}@${payload.comment.id}`;

  try {
    const { data: pull } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    console.log('job started', { owner, repo, pullNumber, head: pull.head.sha, diagnosticId });
    if (pull.base.repo.private) {
      console.log('skipping private repo', { owner, repo, pullNumber });
      return;
    }

    const headSha = pull.head.sha;
    const baseSha = pull.base.sha;
    const baseRef = pull.base.ref;
    const baseSnapshot = { headSha, baseSha, baseRef };
    workdir = path.join(config.repoRoot, `${safeSlug(owner)}-${safeSlug(repo)}-${pullNumber}-${headSha.slice(0, 12)}`);
    await ensureCleanDir(workdir);

    const commonEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    await runProcess('git', ['init'], { phase: 'git', cwd: workdir, env: commonEnv, timeoutMs: 60_000 });
    await runProcess('git', ['remote', 'add', 'origin', `https://github.com/${owner}/${repo}.git`], { phase: 'git', cwd: workdir, env: commonEnv, timeoutMs: 60_000 });
    await runProcess('git', ['fetch', '--no-tags', '--prune', 'origin', baseSha, `pull/${pullNumber}/head:refs/remotes/origin/pr-${pullNumber}`], { phase: 'git', cwd: workdir, env: commonEnv, timeoutMs: GIT_TIMEOUT_MS });
    await runProcess('git', ['checkout', '--detach', headSha], { phase: 'git', cwd: workdir, env: commonEnv, timeoutMs: 60_000 });

    const ocrEnv = { ...process.env, ...config.ocrEnv, GIT_TERMINAL_PROMPT: '0' };
    const ocrArgs = [
      'review',
      '--from', baseSha,
      '--to', headSha,
      '--format', 'json',
      '--concurrency', String(config.ocrConcurrency),
      '--max-git-procs', String(config.ocrMaxGitProcs),
      '--timeout', String(config.ocrPerFileTimeoutMinutes),
    ];
    console.log('ocr started', { owner, repo, pullNumber, base: baseSha, head: headSha, concurrency: config.ocrConcurrency, maxGitProcs: config.ocrMaxGitProcs, perFileTimeoutMinutes: config.ocrPerFileTimeoutMinutes, diagnosticId });
    const review = await runProcess('ocr', ocrArgs, { phase: 'ocr', cwd: workdir, env: ocrEnv, timeoutMs: config.jobTimeoutMs });
    console.log('ocr completed', { owner, repo, pullNumber, diagnosticId });
    const { data: currentPull } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    if (shouldDiscardStaleReview(baseSnapshot, currentPull)) {
      console.log('discarding stale review result', { owner, repo, pullNumber, diagnosticId, reviewedHead: headSha, currentHead: currentPull.head.sha, reviewedBase: baseSha, currentBase: currentPull.base.sha, reviewedBaseRef: baseRef, currentBaseRef: currentPull.base.ref });
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: buildStaleReviewComment(baseSnapshot, currentPull, diagnosticId),
      });
      return;
    }

    let result;
    try {
      result = JSON.parse(review.stdout);
    } catch (error) {
      result = null;
      console.error('invalid OCR JSON', { owner, repo, pullNumber, diagnosticId, stdoutBytes: Buffer.byteLength(review.stdout, 'utf8'), stdoutSha256: crypto.createHash('sha256').update(review.stdout).digest('hex'), error: error.message });
    }
    if (!validateOcrResult(result)) {
      const failure = buildInvalidOcrOutputFailure(review.stdout);
      await postFailureComment(octokit, owner, repo, pullNumber, failure, diagnosticId);
      return;
    }

    const partialSummary = buildPartialOcrSummary(result, diagnosticId);
    const comments = Array.isArray(result.comments) ? result.comments.slice(0, config.maxComments) : [];
    const overflow = Array.isArray(result.comments) && result.comments.length > config.maxComments ? result.comments.length - config.maxComments : 0;

    if (comments.length === 0) {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: partialSummary || `OpenCodeReview: ${result.message || 'No comments generated. Looks good to me.'}`,
      });
      return;
    }

    const inline = [];
    const summary = [];
    for (const comment of comments) {
      const reviewComment = buildReviewComment(comment);
      if (reviewComment) inline.push({ comment, reviewComment });
      else summary.push({ comment });
    }

    const summaryLines = [];
    if (partialSummary) summaryLines.push(partialSummary);
    summaryLines.push(`OpenCodeReview found ${comments.length} issue(s).`);
    if (overflow > 0) summaryLines.push(`${overflow} additional issue(s) omitted by MAX_REVIEW_COMMENTS.`);
    if (summary.length > 0) summaryLines.push(`${summary.length} issue(s) could not be attached inline and are summarized below.`);
    let summaryBody = summaryLines.join('\n');
    if (summary.length > 0) {
      summaryBody += '\n\n' + summary.map(({ comment }) => formatSummaryComment(comment)).join('\n\n---\n\n');
    }

    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: headSha,
        event: 'COMMENT',
        body: summaryBody,
        comments: inline.map(({ reviewComment }) => reviewComment),
      });
    } catch {
      const failed = [];
      for (const { comment, reviewComment } of inline) {
        try {
          await octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number: pullNumber,
            commit_id: headSha,
            event: 'COMMENT',
            body: 'OpenCodeReview inline comment.',
            comments: [reviewComment],
          });
        } catch (error) {
          failed.push({ comment, error: error.message });
        }
      }
      if (summary.length > 0 || failed.length > 0) {
        const fallback = [summaryBody];
        for (const item of failed) fallback.push(formatSummaryComment(item.comment, item.error));
        await octokit.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body: fallback.join('\n\n---\n\n') });
      }
    }
  } catch (error) {
    const failure = classifyReviewFailure(error, config);
    console.error('review job failed', { owner, repo, pullNumber, diagnosticId, failure: failure.kind, error: error.stack || error.message });
    await postFailureComment(octokit, owner, repo, pullNumber, failure, diagnosticId);
  } finally {
    if (config.cleanupWorkdir && workdir) {
      await fs.rm(workdir, { recursive: true, force: true });
      console.log('workdir cleaned', { owner, repo, pullNumber });
    }
  }
}

function createServer(config) {
  const queue = new JobQueue(payload => handleReviewJob(payload, config));

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, { ok: true, service: 'open-code-review-github-app-bot' });
        return;
      }
      if (req.method === 'POST' && req.url === '/llm/anthropic/v1/messages') {
        if (!verifyInternalToken(config.llmProxyInternalToken, extractInternalTokenFromHeaders(req.headers))) {
          json(res, 401, { error: 'invalid internal token' });
          return;
        }
        const rawBody = await readRequestBody(req, config.llmProxyBodyLimitBytes);
        await proxyLLMRequest(req, res, config, rawBody);
        return;
      }

      if (req.method !== 'POST' || req.url !== '/github/webhook') {
        json(res, 404, { error: 'not found' });
        return;
      }

      const rawBody = await readRequestBody(req, config.webhookBodyLimitBytes);
      const signature = req.headers['x-hub-signature-256'];
      if (!verifyGitHubSignature(config.webhookSecret, rawBody, signature)) {
        json(res, 401, { error: 'invalid signature' });
        return;
      }

      const event = req.headers['x-github-event'];
      if (event === 'ping') {
        json(res, 200, { ok: true, event: 'ping' });
        return;
      }
      if (event !== 'issue_comment') {
        json(res, 202, { ok: true, ignored: 'unsupported event' });
        return;
      }

      const payload = JSON.parse(rawBody.toString('utf8'));
      const auth = authorizePayload(payload, config);
      if (!auth.ok) {
        json(res, 202, { ok: true, ignored: auth.reason });
        return;
      }

      const key = `${payload.repository.full_name}#${payload.issue.number}@${payload.comment.id}`;
      const queued = queue.enqueue(key, payload);
      json(res, queued ? 202 : 200, { ok: true, queued });
    } catch (error) {
      console.error('request failed', error.stack || error.message);
      json(res, 500, { error: 'internal error' });
    }
  });
}

function main() {
  const config = loadConfig();
  const server = createServer(config);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`open-code-review-github-app-bot listening on ${config.port}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  authorizePayload,
  buildFailureComment,
  buildInvalidOcrOutputFailure,
  buildPartialOcrSummary,
  buildStaleReviewComment,
  buildReviewComment,
  classifyReviewFailure,
  copyProxyHeaders,
  createServer,
  extractInternalTokenFromHeaders,
  proxyLLMRequest,
  readRequestBody,
  csvSet,
  isTrigger,
  loadConfig,
  timingSafeEqualString,
  shouldDiscardStaleReview,
  validateOcrResult,
  verifyGitHubSignature,
  verifyInternalToken,
};
