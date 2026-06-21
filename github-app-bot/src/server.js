import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { App } from 'octokit';
import { createAdminRouter, AdminRuntime } from './admin/index.js';
import { ConfigManager, loadConfig as loadManagedConfig, csvSet as managedCsvSet } from './config.js';
import { AdminJobQueue, BoundedJobLogger, JobEventStore, redactSensitiveString, sanitizeForAdminStorage } from './jobs/index.js';


const GIT_TIMEOUT_MS = 180_000;
const STDERR_CAPTURE_LIMIT_BYTES = 64 * 1024;
const STDERR_CHUNK_CALLBACK_LIMIT_BYTES = 4 * 1024;
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
  return managedCsvSet(value);
}



function loadConfig(env = process.env) {
  return loadManagedConfig(env);
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
  constructor({ phase, command, args, timedOut, timeoutMs, exitCode, stdout, stdoutBytes, stdoutSha256, stderr, stderrBytes, stderrTruncatedBytes, cause }) {
    const reason = timedOut ? `timed out after ${timeoutMs}ms` : exitCode == null ? 'failed to start' : `exited ${exitCode}`;
    super(`${command} ${args.join(' ')} ${reason}: ${stderr || cause?.message || ''}`);
    this.name = 'ProcessError';
    this.phase = phase;
    this.command = command;
    this.args = args;
    this.timedOut = timedOut;
    this.timeoutMs = timeoutMs;
    this.exitCode = exitCode;
    this.stdout = stdout || '';
    this.stdoutBytes = stdoutBytes ?? Buffer.byteLength(this.stdout, 'utf8');
    this.stdoutSha256 = stdoutSha256 ?? crypto.createHash('sha256').update(this.stdout).digest('hex');
    this.stderr = stderr || '';
    this.stderrBytes = stderrBytes ?? Buffer.byteLength(this.stderr, 'utf8');
    this.stderrTruncatedBytes = stderrTruncatedBytes ?? 0;
    this.cause = cause;
  }
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutHash = crypto.createHash('sha256');
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrCapturedBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const signal = options.signal;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const terminate = ({ timeout = false, abort = false } = {}) => {
      timedOut = timedOut || timeout;
      aborted = aborted || abort;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };
    const abort = () => terminate({ abort: true });
    const timer = setTimeout(() => terminate({ timeout: true }), options.timeoutMs);
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    child.stdout.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      stdoutHash.update(buffer);
      stdoutChunks.push(buffer);
    });
    child.stderr.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.length;
      if (stderrCapturedBytes < STDERR_CAPTURE_LIMIT_BYTES) {
        const remaining = STDERR_CAPTURE_LIMIT_BYTES - stderrCapturedBytes;
        stderrChunks.push(buffer.subarray(0, remaining));
        stderrCapturedBytes += Math.min(buffer.length, remaining);
      }
      if (typeof options.onStderrChunk === 'function') {
        options.onStderrChunk(buffer.subarray(0, STDERR_CHUNK_CALLBACK_LIMIT_BYTES).toString('utf8'));
      }
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      reject(buildProcessError({ options, command, args, timedOut: false, exitCode: null, stdoutChunks, stdoutBytes, stdoutHash, stderrChunks, stderrBytes, cause: error }));
    });
    child.on('close', (code, signalName) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const result = { stdout, stderr, stdoutBytes, stdoutSha256: stdoutHash.digest('hex'), stderrBytes, stderrTruncatedBytes: Math.max(0, stderrBytes - stderrCapturedBytes) };
      if (code === 0 && !timedOut && !aborted) {
        resolve(result);
      } else {
        reject(new ProcessError({ phase: options.phase, command, args, timedOut, timeoutMs: options.timeoutMs, exitCode: code, ...result, cause: signalName ? new Error(aborted ? 'aborted' : `terminated by ${signalName}`) : undefined }));
      }
    });
  });
}

function buildProcessError({ options, command, args, timedOut, exitCode, stdoutChunks, stdoutBytes, stdoutHash, stderrChunks, stderrBytes, cause }) {
  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  return new ProcessError({
    phase: options.phase,
    command,
    args,
    timedOut,
    timeoutMs: options.timeoutMs,
    exitCode,
    stdout,
    stdoutBytes,
    stdoutSha256: stdoutHash.digest('hex'),
    stderr,
    stderrBytes,
    stderrTruncatedBytes: Math.max(0, stderrBytes - Buffer.byteLength(stderr, 'utf8')),
    cause,
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
    title: 'OpenCodeReview completed but returned invalid output.',
    reason: 'OCR output did not match the expected JSON schema',
    retryable: false,
    next: 'A bot operator should inspect the logs with the diagnostic id below.',
    details: [
      `OCR stdout bytes: ${Buffer.byteLength(stdout, 'utf8')}`,
      `OCR stdout sha256: ${crypto.createHash('sha256').update(stdout).digest('hex')}`,
    ],
  };
}

function validateOcrResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (!VALID_OCR_STATUSES.has(result.status)) return false;
  if (!Object.hasOwn(result, 'comments')) return false;
  if (!(result.comments === null || Array.isArray(result.comments))) return false;
  if (result.warnings != null && !Array.isArray(result.warnings)) return false;
  if ((result.status === 'completed_with_warnings' || result.status === 'completed_with_errors') && (!Array.isArray(result.warnings) || result.warnings.length === 0)) return false;
  return true;
}

function buildOcrStatusSummary(result, diagnosticId) {
  const isError = result.status === 'completed_with_errors';
  const isWarning = result.status === 'completed_with_warnings';
  if (!isError && !isWarning) return '';
  const warnings = Array.isArray(result.warnings) ? result.warnings.length : 0;
  return [
    isError ? 'OpenCodeReview completed with errors; some files may not have been reviewed.' : 'OpenCodeReview completed with warnings.',
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


async function postFailureComment(octokit, owner, repo, pullNumber, failure, diagnosticId) {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: buildFailureComment(failure, diagnosticId),
  });
}

function createReviewLogger(logger, config) {
  const redact = createConfiguredSecretRedactor(config);
  const noop = async () => {};
  const write = async (level, message, fields) => {
    if (!logger || typeof logger[level] !== 'function') return;
    await logger[level](redactSensitiveString(String(message)), redact(fields ?? {}));
  };
  return {
    debug: logger?.debug ? (message, fields) => write('debug', message, fields) : noop,
    info: logger?.info ? (message, fields) => write('info', message, fields) : noop,
    warn: logger?.warn ? (message, fields) => write('warn', message, fields) : noop,
    error: logger?.error ? (message, fields) => write('error', message, fields) : noop,
    phase: logger?.phase ? async (phase, message, fields) => logger.phase(phase, redactSensitiveString(String(message ?? '')), redact(fields ?? {})) : noop,
  };
}

function stderrChunkLogger(logger, command, step) {
  return chunk => {
    const message = redactSensitiveString(String(chunk).trim());
    if (message === '') return;
    void logger.warn(`${command} ${step} stderr`, { command, step, stderr: message }).catch(() => {});
  };
}

function createConfiguredSecretRedactor(config) {
  const secrets = configuredSecretValues(config);
  return value => redactConfiguredSecrets(sanitizeForAdminStorage(value), secrets);
}

function configuredSecretValues(config) {
  return [
    config?.webhookSecret,
    config?.adminPassword,
    config?.llmProxyInternalToken,
    config?.llmProxyUpstreamToken,
    config?.ocrEnv?.OCR_LLM_TOKEN,
  ].filter(value => typeof value === 'string' && value.length > 0);
}

function redactConfiguredSecrets(value, secrets) {
  if (typeof value === 'string') {
    let redacted = redactSensitiveString(value);
    for (const secret of secrets) redacted = redacted.split(secret).join('[REDACTED]');
    return redacted;
  }
  if (Array.isArray(value)) return value.map(item => redactConfiguredSecrets(item, secrets));
  if (!value || typeof value !== 'object') return value;
  const redacted = {};
  for (const [key, item] of Object.entries(value)) redacted[key] = redactConfiguredSecrets(item, secrets);
  return redacted;
}

async function handleReviewJob(payload, config, context = {}) {
  let workdir = '';
  let octokit = null;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.issue.number;
  const installationId = payload.installation.id;
  const diagnosticId = `${owner}/${repo}#${pullNumber}@${payload.comment.id}`;
  const logger = createReviewLogger(context.logger, config);
  const signal = context.signal;
  const redact = createConfiguredSecretRedactor(config);
  const commonFields = { owner, repo, pullNumber, diagnosticId };
  const ocrMetrics = {
    ocrStdoutBytes: 0,
    ocrStdoutSha256: '',
    ocrParseSuccess: false,
    ocrStatus: '',
    commentsGenerated: 0,
    warningsCount: 0,
  };

  let finalResult = null;
  try {
    await logger.phase('github_auth', 'Authenticating GitHub App installation', commonFields);
    const privateKey = requiredEnvFromFile(config.privateKeyPath, 'GITHUB_APP_PRIVATE_KEY_PATH');
    const app = new App({ appId: config.appId, privateKey });
    octokit = await app.getInstallationOctokit(installationId);

    await logger.phase('fetching_pr', 'Fetching pull request metadata', commonFields);
    const { data: pull } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    console.log('job started', redact({ ...commonFields, head: pull.head.sha }));
    await logger.info('Review job started', { ...commonFields, head: pull.head.sha });
    if (pull.base.repo.private) {
      console.log('skipping private repo', redact(commonFields));
      await logger.info('Skipping private repository', commonFields);
      finalResult = { outcome: 'skipped', diagnosticId, ...ocrMetrics, failure: null };
      return finalResult;
    }

    const headSha = pull.head.sha;
    const baseSha = pull.base.sha;
    const baseRef = pull.base.ref;
    const baseSnapshot = { headSha, baseSha, baseRef };
    workdir = path.join(config.repoRoot, `${safeSlug(owner)}-${safeSlug(repo)}-${pullNumber}-${headSha.slice(0, 12)}`);

    await logger.phase('checkout', 'Preparing temporary checkout', { ...commonFields, base: baseSha, head: headSha });
    await ensureCleanDir(workdir);
    const commonEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const runGit = (args, timeoutMs) => runProcess('git', args, {
      phase: 'git',
      cwd: workdir,
      env: commonEnv,
      timeoutMs,
      signal,
      onStderrChunk: stderrChunkLogger(logger, 'git', args[0]),
    });
    await runGit(['init'], 60_000);
    await runGit(['remote', 'add', 'origin', `https://github.com/${owner}/${repo}.git`], 60_000);
    await runGit(['fetch', '--no-tags', '--prune', 'origin', baseSha, `pull/${pullNumber}/head:refs/remotes/origin/pr-${pullNumber}`], GIT_TIMEOUT_MS);
    await runGit(['checkout', '--detach', headSha], 60_000);

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
    await logger.phase('ocr', 'Running OCR review', { ...commonFields, base: baseSha, head: headSha, concurrency: config.ocrConcurrency, maxGitProcs: config.ocrMaxGitProcs, perFileTimeoutMinutes: config.ocrPerFileTimeoutMinutes });
    console.log('ocr started', redact({ ...commonFields, base: baseSha, head: headSha, concurrency: config.ocrConcurrency, maxGitProcs: config.ocrMaxGitProcs, perFileTimeoutMinutes: config.ocrPerFileTimeoutMinutes }));
    const review = await runProcess('ocr', ocrArgs, {
      phase: 'ocr',
      cwd: workdir,
      env: ocrEnv,
      timeoutMs: config.jobTimeoutMs,
      signal,
      onStderrChunk: stderrChunkLogger(logger, 'ocr', 'review'),
    });
    ocrMetrics.ocrStdoutBytes = review.stdoutBytes;
    ocrMetrics.ocrStdoutSha256 = review.stdoutSha256;
    console.log('ocr completed', redact(commonFields));
    await logger.info('OCR completed', { ...commonFields, ocrStdoutBytes: review.stdoutBytes, ocrStdoutSha256: review.stdoutSha256, stderrBytes: review.stderrBytes, stderrTruncatedBytes: review.stderrTruncatedBytes });

    const { data: currentPull } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    if (shouldDiscardStaleReview(baseSnapshot, currentPull)) {
      console.log('discarding stale review result', redact({ ...commonFields, reviewedHead: headSha, currentHead: currentPull.head.sha, reviewedBase: baseSha, currentBase: currentPull.base.sha, reviewedBaseRef: baseRef, currentBaseRef: currentPull.base.ref }));
      await logger.phase('publishing', 'Publishing stale review notice', commonFields);
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: buildStaleReviewComment(baseSnapshot, currentPull, diagnosticId),
      });
      finalResult = { outcome: 'stale', diagnosticId, ...ocrMetrics, commentsPosted: 1, failure: null };
      return finalResult;
    }

    let result;
    try {
      result = JSON.parse(review.stdout);
      ocrMetrics.ocrParseSuccess = true;
    } catch (error) {
      result = null;
      console.error('invalid OCR JSON', redact({ ...commonFields, stdoutBytes: review.stdoutBytes, stdoutSha256: review.stdoutSha256, error: error.message }));
      await logger.warn('Invalid OCR JSON', { ...commonFields, ocrStdoutBytes: review.stdoutBytes, ocrStdoutSha256: review.stdoutSha256, error: error.message });
    }
    if (!validateOcrResult(result)) {
      const failure = buildInvalidOcrOutputFailure(review.stdout);
      finalResult = { outcome: 'failed', diagnosticId, ...ocrMetrics, failure, commentsPosted: 0, reportingError: null };
      try {
        await logger.phase('publishing', 'Publishing invalid OCR output notice', { ...commonFields, failure: failure.kind });
        await postFailureComment(octokit, owner, repo, pullNumber, failure, diagnosticId);
        finalResult.commentsPosted = 1;
      } catch (reportingError) {
        finalResult.reportingError = classifyReviewFailure(reportingError, config);
        console.error('failed to post invalid output failure comment', redact({ ...commonFields, originalFailure: failure.kind, reportingFailure: finalResult.reportingError.kind, error: reportingError.stack || reportingError.message }));
      }
      return finalResult;
    }

    ocrMetrics.ocrStatus = result.status;
    ocrMetrics.commentsGenerated = Array.isArray(result.comments) ? result.comments.length : 0;
    ocrMetrics.warningsCount = Array.isArray(result.warnings) ? result.warnings.length : 0;
    const statusSummary = buildOcrStatusSummary(result, diagnosticId);
    const comments = Array.isArray(result.comments) ? result.comments.slice(0, config.maxComments) : [];
    const overflow = ocrMetrics.commentsGenerated > config.maxComments ? ocrMetrics.commentsGenerated - config.maxComments : 0;

    await logger.phase('publishing', 'Publishing review result', { ...commonFields, commentsSelected: comments.length, commentsGenerated: ocrMetrics.commentsGenerated, warningsCount: ocrMetrics.warningsCount });
    if (comments.length === 0) {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: statusSummary || `OpenCodeReview: ${result.message || 'No comments generated. Looks good to me.'}`,
      });
      finalResult = {
        outcome: statusSummary ? 'succeeded_with_warnings' : 'succeeded',
        diagnosticId,
        ...ocrMetrics,
        commentsPosted: 1,
        failure: null,
      };
      return finalResult;
    }

    const inline = [];
    const summary = [];
    for (const comment of comments) {
      const reviewComment = buildReviewComment(comment);
      if (reviewComment) inline.push({ comment, reviewComment });
      else summary.push({ comment });
    }

    const summaryLines = [];
    if (statusSummary) summaryLines.push(statusSummary);
    summaryLines.push(`OpenCodeReview found ${comments.length} issue(s).`);
    if (overflow > 0) summaryLines.push(`${overflow} additional issue(s) omitted by MAX_REVIEW_COMMENTS.`);
    if (summary.length > 0) summaryLines.push(`${summary.length} issue(s) could not be attached inline and are summarized below.`);
    let summaryBody = summaryLines.join('\n');
    if (summary.length > 0) {
      summaryBody += '\n\n' + summary.map(({ comment }) => formatSummaryComment(comment)).join('\n\n---\n\n');
    }

    let commentsPosted = inline.length;
    let publishWarningCount = 0;
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
      commentsPosted = 0;
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
          commentsPosted += 1;
        } catch (error) {
          failed.push({ comment, error: error.message });
        }
      }
      if (statusSummary || summary.length > 0 || failed.length > 0) {
        const fallback = [summaryBody];
        for (const item of failed) fallback.push(formatSummaryComment(item.comment, item.error));
        await octokit.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body: fallback.join('\n\n---\n\n') });
        commentsPosted += 1;
      }
      publishWarningCount = failed.length;
    }

    finalResult = {
      outcome: statusSummary || publishWarningCount > 0 ? 'succeeded_with_warnings' : 'succeeded',
      diagnosticId,
      ...ocrMetrics,
      commentsSelected: comments.length,
      commentsPosted,
      commentsOmitted: overflow,
      publishWarningCount,
      failure: null,
    };
    return finalResult;
  } catch (error) {
    if (signal?.aborted) throw error;
    const failure = classifyReviewFailure(error, config);
    console.error('review job failed', redact({ ...commonFields, failure: failure.kind, error: error.stack || error.message }));
    await logger.error('Review job failed', { ...commonFields, failure: failure.kind, error: error.stack || error.message });
    finalResult = { outcome: 'failed', diagnosticId, ...ocrMetrics, failure, reportingError: null };
    if (octokit) {
      try {
        await logger.phase('publishing', 'Publishing failure notice', { ...commonFields, failure: failure.kind });
        await postFailureComment(octokit, owner, repo, pullNumber, failure, diagnosticId);
        finalResult.commentsPosted = 1;
      } catch (reportingError) {
        finalResult.reportingError = classifyReviewFailure(reportingError, config);
        console.error('failed to post failure comment', redact({ ...commonFields, originalFailure: failure.kind, reportingFailure: finalResult.reportingError.kind, error: reportingError.stack || reportingError.message }));
      }
    }
    return finalResult;
  } finally {
    if (config.cleanupWorkdir && workdir) {
      try {
        await logger.phase('cleanup', 'Cleaning temporary checkout', commonFields);
        await fs.rm(workdir, { recursive: true, force: true });
        console.log('workdir cleaned', redact(commonFields));
      } catch (cleanupError) {
        if (finalResult) finalResult.cleanupWarning = cleanupError.message;
        console.error('workdir cleanup failed', redact({ ...commonFields, error: cleanupError.stack || cleanupError.message }));
      }
    }
    await logger.phase('finished', 'Review job finished', { ...commonFields, outcome: finalResult?.outcome ?? (signal?.aborted ? 'interrupted' : 'failed') });
  }
}

function createServer(config, options = {}) {
  let currentConfig = config;
  const configProvider = options.configProvider || (() => currentConfig);
  const eventStore = options.eventStore || new JobEventStore({ adminDir: currentConfig.adminDataDir });
  const jobLogger = options.jobLogger || new BoundedJobLogger({ adminDir: currentConfig.adminDataDir, maxBytes: currentConfig.jobLogMaxBytes });
  const queue = options.queue || new AdminJobQueue({
    handler: (payload, context) => handleReviewJob(payload, context?.config || configProvider(), context),
    store: eventStore,
    logger: jobLogger,
    configProvider,
  });
  const adminRuntime = options.adminRuntime || new AdminRuntime({ configManager: options.configManager, eventStore, queue, logger: jobLogger, configProvider, adminDir: currentConfig.adminDataDir });
  const adminRouter = options.adminRouter || createAdminRouter({
    adminPassword: currentConfig.adminPassword,
    allowedHosts: currentConfig.adminAllowedHosts,
    secureCookies: currentConfig.adminCookieSecure,
    sessionTtlMs: currentConfig.adminSessionTtlMs,
    loadDashboard: context => adminRuntime.dashboard(context),
    loadJobs: context => adminRuntime.jobs(context),
    loadJob: context => adminRuntime.job(context.jobId, context),
    loadConfig: () => adminRuntime.configSummary(),
    saveConfig: options.saveConfig,
    loadSecurityConfig: async () => {
      const next = await configProvider();
      return { adminPassword: next.adminPassword, allowedHosts: next.adminAllowedHosts, trustProxy: next.adminTrustProxy, cookieSecure: next.adminCookieSecure, sessionTtlMs: next.adminSessionTtlMs, allowPrivateHosts: false };
    },
    adminRoot: currentConfig.adminDataDir,
  });
  let acceptingRequests = true;

  const server = http.createServer(async (req, res) => {
    try {
      if (!acceptingRequests) {
        json(res, 503, { error: 'server shutting down' });
        return;
      }
      if (req.url === '/admin') {
        res.writeHead(308, { location: '/admin/' });
        res.end();
        return;
      }
      if (req.url === '/admin/' || req.url.startsWith('/admin/')) {
        const body = req.method === 'POST' ? await readRequestBody(req, currentConfig.webhookBodyLimitBytes) : null;
        const response = await adminRouter.route({ method: req.method, url: req.url, headers: req.headers, body, remoteAddress: req.socket.remoteAddress });
        writeAdminResponse(res, response);
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, { ok: true, service: 'open-code-review-github-app-bot' });
        return;
      }
      if (req.method === 'POST' && req.url === '/llm/anthropic/v1/messages') {
        currentConfig = await configProvider();
        if (!verifyInternalToken(currentConfig.llmProxyInternalToken, extractInternalTokenFromHeaders(req.headers))) {
          json(res, 401, { error: 'invalid internal token' });
          return;
        }
        const rawBody = await readRequestBody(req, currentConfig.llmProxyBodyLimitBytes);
        await proxyLLMRequest(req, res, currentConfig, rawBody);
        return;
      }

      if (req.method !== 'POST' || req.url !== '/github/webhook') {
        json(res, 404, { error: 'not found' });
        return;
      }

      currentConfig = await configProvider();
      const rawBody = await readRequestBody(req, currentConfig.webhookBodyLimitBytes);
      const signature = req.headers['x-hub-signature-256'];
      if (!verifyGitHubSignature(currentConfig.webhookSecret, rawBody, signature)) {
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
      const auth = authorizePayload(payload, currentConfig);
      if (!auth.ok) {
        json(res, 202, { ok: true, ignored: auth.reason });
        return;
      }

      const key = `${payload.repository.full_name}#${payload.issue.number}@${payload.comment.id}`;
      const result = await queue.enqueue({
        key,
        payload: minimalReviewPayload(payload),
        metadata: {
          diagnosticId: key,
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          pullNumber: payload.issue.number,
          actor: payload.sender.login,
          trigger: payload.comment.body,
        },
      });
      json(res, result.queued ? 202 : 200, { ok: true, queued: result.queued, jobId: result.job?.jobId, stopped: Boolean(result.stopped) });
    } catch (error) {
      console.error('request failed', redactSensitiveString(error.stack || error.message));
      json(res, 500, { error: 'internal error' });
    }
  });
  server.adminRuntime = adminRuntime;
  server.reviewQueue = queue;
  server.shutdown = async ({ timeoutMs = 30_000 } = {}) => {
    acceptingRequests = false;
    queue.stop();
    await closeServer(server);
    await queue.shutdown({ timeoutMs });
  };
  return server;
}

function writeAdminResponse(res, response) {
  for (const [name, value] of Object.entries(response.headers || {})) {
    res.setHeader(name, value);
  }
  res.writeHead(response.status || 200);
  res.end(response.body || '');
}

async function saveAdminConfigOverride({ configManager, form, expectedRevision, clientAddress, currentHost }) {
  return configManager.applyEditorForm(form, { expectedRevision, clientAddress, currentHost });
}

function minimalReviewPayload(payload) {
  return {
    action: payload.action,
    installation: { id: payload.installation.id },
    repository: {
      name: payload.repository.name,
      full_name: payload.repository.full_name,
      private: Boolean(payload.repository.private),
      owner: { login: payload.repository.owner.login },
    },
    issue: { number: payload.issue.number, pull_request: payload.issue.pull_request ? {} : undefined },
    comment: { id: payload.comment.id, body: payload.comment.body },
    sender: { login: payload.sender.login, id: payload.sender.id },
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (!error || error.code === 'ERR_SERVER_NOT_RUNNING') resolve();
      else reject(error);
    });
  });
}

async function runRetentionFailOpen(adminRuntime) {
  if (!adminRuntime || typeof adminRuntime.runRetention !== 'function') return null;
  try {
    return await adminRuntime.runRetention();
  } catch (error) {
    console.error('admin retention run failed', redactSensitiveString(error.stack || error.message));
    return null;
  }
}

async function main() {
  const configManager = new ConfigManager();
  let loaded;
  let config;
  try {
    await configManager.ensureStorageDir();
    loaded = await configManager.load();
    config = loaded.config;
  } catch (error) {
    console.error('admin config storage unavailable', error.stack || error.message);
    config = loadConfig();
  }
  const eventStore = new JobEventStore({ adminDir: config.adminDataDir });
  const server = createServer(config, {
    configManager,
    eventStore,
    configProvider: async () => {
      try {
        const next = await configManager.load();
        config = next.config;
      } catch (error) {
        console.error('admin config reload failed; keeping previous config', error.stack || error.message);
      }
      return config;
    },
    saveConfig: async ({ form, expectedRevision, clientAddress, currentHost }) => {
      const result = await saveAdminConfigOverride({ configManager, form, expectedRevision, clientAddress, currentHost });
      const next = await configManager.load();
      config = next.config;
      return result;
    },
  });
  await server.adminRuntime.initialize();
  const retentionTimer = setInterval(() => { void runRetentionFailOpen(server.adminRuntime); }, config.retentionIntervalHours * 60 * 60 * 1000);
  retentionTimer.unref();
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}; shutting down`);
    try {
      clearInterval(retentionTimer);
      await server.shutdown({ timeoutMs: 30_000 });
      process.exitCode = 0;
    } catch (error) {
      console.error('graceful shutdown failed', redactSensitiveString(error.stack || error.message));
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  server.listen(config.port, '0.0.0.0', async () => {
    const address = server.address();
    const runningPort = typeof address === 'object' && address ? address.port : config.port;
    try {
      await configManager.clearPendingRestartAfterSuccessfulBind({ desiredPort: config.port, runningPort });
    } catch (error) {
      console.error('pending restart clear failed', redactSensitiveString(error.stack || error.message));
    }
    void runRetentionFailOpen(server.adminRuntime);
    console.log(`open-code-review-github-app-bot listening on ${runningPort}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  authorizePayload,
  buildFailureComment,
  buildInvalidOcrOutputFailure,
  buildOcrStatusSummary,
  buildStaleReviewComment,
  buildReviewComment,
  classifyReviewFailure,
  copyProxyHeaders,
  createServer,
  extractInternalTokenFromHeaders,
  minimalReviewPayload,
  runProcess,
  runRetentionFailOpen,
  proxyLLMRequest,
  readRequestBody,
  csvSet,
  isTrigger,
  loadConfig,
  timingSafeEqualString,
  shouldDiscardStaleReview,
  saveAdminConfigOverride,
  validateOcrResult,
  verifyGitHubSignature,
  verifyInternalToken,
};
