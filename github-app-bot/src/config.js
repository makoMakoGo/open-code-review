import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const DEFAULT_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_LLM_PROXY_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_ADMIN_DATA_DIR = '/data/admin';
const DEFAULT_ADMIN_STORAGE_DIR = DEFAULT_ADMIN_DATA_DIR;
const OVERRIDES_FILE_NAME = 'config-overrides.json';
const PENDING_RESTART_FILE_NAME = 'pending-restart.json';

const SOURCE_DEFAULT = 'default';
const SOURCE_ENV = 'env';
const SOURCE_OVERRIDE = 'override';
const SOURCE_MISSING = 'missing';

const DEFAULT_ENV = Object.freeze({
  PORT: '3007',
  ALLOWED_USER_IDS: '',
  GITHUB_APP_PRIVATE_KEY_PATH: '/config/github-app-private-key.pem',
  MAX_REVIEW_COMMENTS: '30',
  JOB_TIMEOUT_MS: String(20 * 60 * 1000),
  CLEANUP_WORKDIR: 'true',
  WEBHOOK_BODY_LIMIT_BYTES: String(DEFAULT_WEBHOOK_BODY_LIMIT_BYTES),
  LLM_PROXY_BODY_LIMIT_BYTES: String(DEFAULT_LLM_PROXY_BODY_LIMIT_BYTES),
  OCR_CONCURRENCY: '1',
  OCR_MAX_GIT_PROCS: '2',
  OCR_PER_FILE_TIMEOUT_MINUTES: '10',
  LLM_PROXY_TARGET_URL: '',
  LLM_PROXY_USER_AGENT: 'open-code-review-github-app-bot/0.1.0',
  LLM_PROXY_X_APP: '',
  LLM_PROXY_INTERNAL_TOKEN: '',
  LLM_PROXY_UPSTREAM_AUTH_HEADER: '',
  LLM_PROXY_UPSTREAM_TOKEN: '',
  OCR_USE_ANTHROPIC: 'false',
  OCR_LLM_AUTH_HEADER: '',
  ADMIN_PASSWORD: '',
  ADMIN_STORAGE_DIR: DEFAULT_ADMIN_STORAGE_DIR,
  ADMIN_ALLOWED_HOSTS: '',
  ADMIN_TRUST_PROXY: 'false',
});

const REQUIRED_ENV_KEYS = Object.freeze([
  'BOT_TRIGGER_PHRASE',
  'ALLOWED_USERS',
  'ALLOWED_REPO_OWNERS',
  'BOT_REPO_ROOT',
  'GITHUB_APP_ID',
  'GITHUB_WEBHOOK_SECRET',
  'OCR_LLM_URL',
  'OCR_LLM_TOKEN',
  'OCR_LLM_MODEL',
]);

const OPTIONAL_ENV_KEYS = Object.freeze([
  'PORT',
  'BOT_TRIGGER_PHRASES',
  'ALLOWED_USER_IDS',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'MAX_REVIEW_COMMENTS',
  'JOB_TIMEOUT_MS',
  'CLEANUP_WORKDIR',
  'WEBHOOK_BODY_LIMIT_BYTES',
  'LLM_PROXY_BODY_LIMIT_BYTES',
  'OCR_CONCURRENCY',
  'OCR_MAX_GIT_PROCS',
  'OCR_PER_FILE_TIMEOUT_MINUTES',
  'LLM_PROXY_TARGET_URL',
  'LLM_PROXY_USER_AGENT',
  'LLM_PROXY_X_APP',
  'LLM_PROXY_INTERNAL_TOKEN',
  'LLM_PROXY_UPSTREAM_AUTH_HEADER',
  'LLM_PROXY_UPSTREAM_TOKEN',
  'OCR_USE_ANTHROPIC',
  'OCR_LLM_AUTH_HEADER',
  'ADMIN_PASSWORD',
  'ADMIN_DATA_DIR',
  'ADMIN_STORAGE_DIR',
  'ADMIN_ALLOWED_HOSTS',
  'ADMIN_TRUST_PROXY',
]);

const CONFIG_ENV_KEYS = Object.freeze([...REQUIRED_ENV_KEYS, ...OPTIONAL_ENV_KEYS]);
const CONFIG_ENV_KEY_SET = new Set(CONFIG_ENV_KEYS);
const NON_EDITABLE_ENV_KEYS = new Set(['ADMIN_PASSWORD', 'ADMIN_DATA_DIR', 'ADMIN_STORAGE_DIR']);

const SECRET_ENV_KEYS = Object.freeze([
  'GITHUB_WEBHOOK_SECRET',
  'OCR_LLM_TOKEN',
  'LLM_PROXY_INTERNAL_TOKEN',
  'LLM_PROXY_UPSTREAM_TOKEN',
  'ADMIN_PASSWORD',
]);
const SECRET_ENV_KEY_SET = new Set(SECRET_ENV_KEYS);

const RESTART_REQUIRED_ENV_KEYS = Object.freeze(['PORT']);
const RESTART_REQUIRED_ENV_KEY_SET = new Set(RESTART_REQUIRED_ENV_KEYS);

const NON_SECRET_SUMMARY_FIELDS = Object.freeze([
  { name: 'port', envKey: 'PORT', read: config => config.port },
  { name: 'appId', envKey: 'GITHUB_APP_ID', read: config => config.appId },
  { name: 'privateKeyPath', envKey: 'GITHUB_APP_PRIVATE_KEY_PATH', read: config => config.privateKeyPath },
  { name: 'triggerPhrases', envKey: 'BOT_TRIGGER_PHRASES', fallbackEnvKey: 'BOT_TRIGGER_PHRASE', read: config => config.triggerPhrases },
  { name: 'allowedUsers', envKey: 'ALLOWED_USERS', read: config => config.allowedUsers },
  { name: 'allowedUserIDs', envKey: 'ALLOWED_USER_IDS', read: config => config.allowedUserIDs },
  { name: 'allowedRepoOwners', envKey: 'ALLOWED_REPO_OWNERS', read: config => config.allowedRepoOwners },
  { name: 'repoRoot', envKey: 'BOT_REPO_ROOT', read: config => config.repoRoot },
  { name: 'maxComments', envKey: 'MAX_REVIEW_COMMENTS', read: config => config.maxComments },
  { name: 'jobTimeoutMs', envKey: 'JOB_TIMEOUT_MS', read: config => config.jobTimeoutMs },
  { name: 'cleanupWorkdir', envKey: 'CLEANUP_WORKDIR', read: config => config.cleanupWorkdir },
  { name: 'webhookBodyLimitBytes', envKey: 'WEBHOOK_BODY_LIMIT_BYTES', read: config => config.webhookBodyLimitBytes },
  { name: 'llmProxyBodyLimitBytes', envKey: 'LLM_PROXY_BODY_LIMIT_BYTES', read: config => config.llmProxyBodyLimitBytes },
  { name: 'ocrConcurrency', envKey: 'OCR_CONCURRENCY', read: config => config.ocrConcurrency },
  { name: 'ocrMaxGitProcs', envKey: 'OCR_MAX_GIT_PROCS', read: config => config.ocrMaxGitProcs },
  { name: 'ocrPerFileTimeoutMinutes', envKey: 'OCR_PER_FILE_TIMEOUT_MINUTES', read: config => config.ocrPerFileTimeoutMinutes },
  { name: 'llmProxyTargetURL', envKey: 'LLM_PROXY_TARGET_URL', read: config => config.llmProxyTargetURL },
  { name: 'llmProxyUserAgent', envKey: 'LLM_PROXY_USER_AGENT', read: config => config.llmProxyUserAgent },
  { name: 'llmProxyXApp', envKey: 'LLM_PROXY_X_APP', read: config => config.llmProxyXApp },
  { name: 'llmProxyUpstreamAuthHeader', envKey: 'LLM_PROXY_UPSTREAM_AUTH_HEADER', read: config => config.llmProxyUpstreamAuthHeader },
  { name: 'ocrLlmUrl', envKey: 'OCR_LLM_URL', read: config => config.ocrEnv.OCR_LLM_URL },
  { name: 'ocrLlmModel', envKey: 'OCR_LLM_MODEL', read: config => config.ocrEnv.OCR_LLM_MODEL },
  { name: 'ocrUseAnthropic', envKey: 'OCR_USE_ANTHROPIC', read: config => config.ocrEnv.OCR_USE_ANTHROPIC },
  { name: 'ocrLlmAuthHeader', envKey: 'OCR_LLM_AUTH_HEADER', read: config => config.ocrEnv.OCR_LLM_AUTH_HEADER },
  { name: 'adminEnabled', envKey: 'ADMIN_PASSWORD', read: config => config.adminEnabled },
  { name: 'adminDisabledReason', envKey: 'ADMIN_PASSWORD', read: config => config.adminDisabledReason },
  { name: 'adminDataDir', envKey: 'ADMIN_DATA_DIR', fallbackEnvKey: 'ADMIN_STORAGE_DIR', read: config => config.adminDataDir },
  { name: 'adminStorageDir', envKey: 'ADMIN_STORAGE_DIR', fallbackEnvKey: 'ADMIN_DATA_DIR', read: config => config.adminStorageDir },
  { name: 'adminTrustProxy', envKey: 'ADMIN_TRUST_PROXY', read: config => config.adminTrustProxy },
  { name: 'adminAllowedHosts', envKey: 'ADMIN_ALLOWED_HOSTS', read: config => config.adminAllowedHosts },
]);

const SECRET_SUMMARY_FIELDS = Object.freeze([
  { name: 'webhookSecret', envKey: 'GITHUB_WEBHOOK_SECRET', read: config => config.webhookSecret },
  { name: 'ocrLlmToken', envKey: 'OCR_LLM_TOKEN', read: config => config.ocrEnv.OCR_LLM_TOKEN },
  { name: 'llmProxyInternalToken', envKey: 'LLM_PROXY_INTERNAL_TOKEN', read: config => config.llmProxyInternalToken },
  { name: 'llmProxyUpstreamToken', envKey: 'LLM_PROXY_UPSTREAM_TOKEN', read: config => config.llmProxyUpstreamToken },
  { name: 'adminPassword', envKey: 'ADMIN_PASSWORD', read: config => config.adminPassword },
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

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

function csvList(value) {
  const out = [];
  for (const item of String(value).split(',')) {
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
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

function mergeConfigLayers(env = process.env, rawOverrides = {}) {
  const overrides = normalizeRawOverrides(rawOverrides);
  const effectiveEnv = { ...DEFAULT_ENV };
  for (const [key, value] of Object.entries(env)) {
    if (value != null) effectiveEnv[key] = String(value);
  }
  for (const [key, value] of Object.entries(overrides)) {
    effectiveEnv[key] = value;
  }

  return {
    env: effectiveEnv,
    overrides,
    sources: buildSourceMetadata(env, overrides),
  };
}

function loadConfig(env = process.env, rawOverrides) {
  const effectiveEnv = rawOverrides == null ? env : mergeConfigLayers(env, rawOverrides).env;
  const triggerPhrases = csvSet(optionalEnv('BOT_TRIGGER_PHRASES', requiredEnv('BOT_TRIGGER_PHRASE', effectiveEnv), effectiveEnv));
  const allowedUsers = csvSet(requiredEnv('ALLOWED_USERS', effectiveEnv));
  const allowedUserIDs = csvSet(optionalEnv('ALLOWED_USER_IDS', '', effectiveEnv));
  const allowedRepoOwners = csvSet(requiredEnv('ALLOWED_REPO_OWNERS', effectiveEnv));
  if (triggerPhrases.size === 0) throw new Error('BOT_TRIGGER_PHRASES must contain at least one command');
  if (allowedUsers.size === 0 && allowedUserIDs.size === 0) {
    throw new Error('ALLOWED_USERS or ALLOWED_USER_IDS must contain at least one GitHub account');
  }
  if (allowedRepoOwners.size === 0) throw new Error('ALLOWED_REPO_OWNERS must contain at least one owner');

  const llmProxyTargetURL = optionalEnv('LLM_PROXY_TARGET_URL', '', effectiveEnv);
  const llmProxyInternalToken = optionalSecret('LLM_PROXY_INTERNAL_TOKEN', effectiveEnv);
  const llmProxyUpstreamAuthHeader = optionalEnv('LLM_PROXY_UPSTREAM_AUTH_HEADER', '', effectiveEnv);
  const llmProxyUpstreamToken = optionalSecret('LLM_PROXY_UPSTREAM_TOKEN', effectiveEnv);
  if (llmProxyTargetURL && !llmProxyInternalToken) {
    throw new Error('LLM_PROXY_INTERNAL_TOKEN is required when LLM_PROXY_TARGET_URL is set');
  }
  if ((llmProxyUpstreamAuthHeader === '') !== (llmProxyUpstreamToken === '')) {
    throw new Error('LLM_PROXY_UPSTREAM_AUTH_HEADER and LLM_PROXY_UPSTREAM_TOKEN must be set together');
  }

  const adminPassword = optionalSecret('ADMIN_PASSWORD', effectiveEnv);
  const adminPasswordStatus = getAdminPasswordStatus(adminPassword);
  const adminDataDir = resolveAdminDataDir(effectiveEnv);
  const adminAllowedHosts = parseHostAllowlist(optionalEnv('ADMIN_ALLOWED_HOSTS', '', effectiveEnv), 'ADMIN_ALLOWED_HOSTS');
  const adminTrustProxy = parseBool(optionalEnv('ADMIN_TRUST_PROXY', 'false', effectiveEnv), 'ADMIN_TRUST_PROXY');

  return {
    port: parseIntegerEnv('PORT', 3007, { min: 1, env: effectiveEnv }),
    appId: requiredEnv('GITHUB_APP_ID', effectiveEnv),
    privateKeyPath: optionalEnv('GITHUB_APP_PRIVATE_KEY_PATH', '/config/github-app-private-key.pem', effectiveEnv),
    webhookSecret: requiredEnv('GITHUB_WEBHOOK_SECRET', effectiveEnv),
    triggerPhrases,
    allowedUsers,
    allowedUserIDs,
    allowedRepoOwners,
    repoRoot: requiredEnv('BOT_REPO_ROOT', effectiveEnv),
    maxComments: parseIntegerEnv('MAX_REVIEW_COMMENTS', 30, { min: 1, env: effectiveEnv }),
    jobTimeoutMs: parseIntegerEnv('JOB_TIMEOUT_MS', 20 * 60 * 1000, { min: 1000, env: effectiveEnv }),
    cleanupWorkdir: parseBool(optionalEnv('CLEANUP_WORKDIR', 'true', effectiveEnv), 'CLEANUP_WORKDIR'),
    webhookBodyLimitBytes: parseIntegerEnv('WEBHOOK_BODY_LIMIT_BYTES', DEFAULT_WEBHOOK_BODY_LIMIT_BYTES, { min: 1024, env: effectiveEnv }),
    llmProxyBodyLimitBytes: parseIntegerEnv('LLM_PROXY_BODY_LIMIT_BYTES', DEFAULT_LLM_PROXY_BODY_LIMIT_BYTES, { min: 1024, env: effectiveEnv }),
    ocrConcurrency: parseIntegerEnv('OCR_CONCURRENCY', 1, { min: 1, env: effectiveEnv }),
    ocrMaxGitProcs: parseIntegerEnv('OCR_MAX_GIT_PROCS', 2, { min: 1, env: effectiveEnv }),
    ocrPerFileTimeoutMinutes: parseIntegerEnv('OCR_PER_FILE_TIMEOUT_MINUTES', 10, { min: 1, env: effectiveEnv }),
    llmProxyTargetURL,
    llmProxyUserAgent: optionalEnv('LLM_PROXY_USER_AGENT', 'open-code-review-github-app-bot/0.1.0', effectiveEnv),
    llmProxyXApp: optionalEnv('LLM_PROXY_X_APP', '', effectiveEnv),
    llmProxyInternalToken,
    llmProxyUpstreamAuthHeader,
    llmProxyUpstreamToken,
    ocrEnv: buildOcrEnv(effectiveEnv),
    adminEnabled: adminPasswordStatus.enabled,
    adminDisabledReason: adminPasswordStatus.disabledReason,
    adminPassword,
    adminDataDir,
    adminStorageDir: adminDataDir,
    adminAllowedHosts,
    adminTrustProxy,
    admin: {
      enabled: adminPasswordStatus.enabled,
      disabledReason: adminPasswordStatus.disabledReason,
      password: adminPassword,
      dataDir: adminDataDir,
      storageDir: adminDataDir,
      allowedHosts: adminAllowedHosts,
      trustProxy: adminTrustProxy,
    },
  };
}

function buildOcrEnv(env = process.env, rawOverrides) {
  const effectiveEnv = rawOverrides == null ? env : mergeConfigLayers(env, rawOverrides).env;
  return {
    OCR_LLM_URL: requiredEnv('OCR_LLM_URL', effectiveEnv),
    OCR_LLM_TOKEN: requiredEnv('OCR_LLM_TOKEN', effectiveEnv),
    OCR_LLM_MODEL: requiredEnv('OCR_LLM_MODEL', effectiveEnv),
    OCR_USE_ANTHROPIC: optionalEnv('OCR_USE_ANTHROPIC', 'false', effectiveEnv),
    OCR_LLM_AUTH_HEADER: optionalEnv('OCR_LLM_AUTH_HEADER', '', effectiveEnv),
  };
}

function resolveAdminDataDir(env = process.env) {
  return optionalEnv('ADMIN_DATA_DIR', optionalEnv('ADMIN_STORAGE_DIR', DEFAULT_ADMIN_DATA_DIR, env), env);
}

function getAdminPasswordStatus(adminPassword) {
  if (!adminPassword) {
    return { enabled: false, disabledReason: 'ADMIN_PASSWORD is not set' };
  }
  if (adminPassword.length < 16) {
    return { enabled: false, disabledReason: 'ADMIN_PASSWORD must be at least 16 characters' };
  }
  return { enabled: true, disabledReason: '' };
}

function parseHostAllowlist(value, name = 'ADMIN_ALLOWED_HOSTS') {
  return new Set(validateHighRiskHostAllowlist(value, { envKey: name }));
}

function validateHighRiskHostAllowlist(value, { envKey = 'ADMIN_ALLOWED_HOSTS' } = {}) {
  const entries = Array.isArray(value) || value instanceof Set ? [...value] : csvList(value);
  const normalized = [];
  const seen = new Set();
  for (const entry of entries) {
    const host = normalizeAllowedHost(entry, envKey);
    if (!seen.has(host)) {
      normalized.push(host);
      seen.add(host);
    }
  }
  return normalized;
}

function normalizeAllowedHost(entry, envKey = 'ADMIN_ALLOWED_HOSTS') {
  const value = String(entry).trim().toLowerCase();
  if (value === '') throw new Error(`${envKey} contains an empty host`);
  if (/\s|[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${envKey} host entries must not contain whitespace or control characters`);
  if (value.includes('*')) throw new Error(`${envKey} must not contain wildcard hosts`);
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) throw new Error(`${envKey} host entries must be hosts, not URLs`);
  if (/[/?#@]/.test(value)) throw new Error(`${envKey} host entries must not contain URL paths, credentials, queries, or fragments`);

  const { host, port, bracketedIpv6 } = splitHostPort(value, envKey);
  validateAllowedHostName(host, envKey);
  if (port !== '') validatePort(port, envKey);

  const normalizedHost = bracketedIpv6 || net.isIP(host) === 6 ? `[${host}]` : host;
  return port === '' ? normalizedHost : `${normalizedHost}:${port}`;
}

function splitHostPort(value, envKey) {
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) throw new Error(`${envKey} contains an invalid bracketed IPv6 host`);
    const host = value.slice(1, close);
    const rest = value.slice(close + 1);
    if (rest !== '' && !rest.startsWith(':')) throw new Error(`${envKey} contains an invalid bracketed IPv6 host`);
    return { host, port: rest === '' ? '' : rest.slice(1), bracketedIpv6: true };
  }

  const colonCount = (value.match(/:/g) || []).length;
  if (colonCount === 0) return { host: value, port: '', bracketedIpv6: false };
  if (colonCount === 1) {
    const [host, port] = value.split(':');
    return { host, port, bracketedIpv6: false };
  }
  if (net.isIP(value) === 6) return { host: value, port: '', bracketedIpv6: false };
  throw new Error(`${envKey} contains an invalid host or port`);
}

function validatePort(port, envKey) {
  if (!/^\d+$/.test(port)) throw new Error(`${envKey} host ports must be integers`);
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${envKey} host ports must be between 1 and 65535`);
}

function validateAllowedHostName(host, envKey) {
  if (host === '') throw new Error(`${envKey} contains an empty host`);
  if (host === '0.0.0.0' || host === '::' || host === '[::]' || host === '255.255.255.255') {
    throw new Error(`${envKey} must not allow bind-all or broadcast hosts`);
  }
  if (net.isIP(host)) return;
  if (host.length > 253) throw new Error(`${envKey} contains a host that is too long`);
  const labels = host.split('.');
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      throw new Error(`${envKey} contains an invalid host name`);
    }
  }
}

function buildSourceMetadata(env = process.env, rawOverrides = {}) {
  const overrides = normalizeRawOverrides(rawOverrides);
  const metadata = {};
  for (const key of CONFIG_ENV_KEYS) {
    let source = SOURCE_MISSING;
    if (hasOwn(DEFAULT_ENV, key)) source = SOURCE_DEFAULT;
    if (env[key] != null) source = SOURCE_ENV;
    if (hasOwn(overrides, key)) source = SOURCE_OVERRIDE;
    metadata[key] = {
      envKey: key,
      source,
      required: REQUIRED_ENV_KEYS.includes(key),
      secret: SECRET_ENV_KEY_SET.has(key),
      restartRequired: RESTART_REQUIRED_ENV_KEY_SET.has(key),
    };
  }
  return metadata;
}

function summarizeConfig(config, sourceMetadata = {}, { revision = null, pendingRestart = null } = {}) {
  const values = {};
  for (const field of NON_SECRET_SUMMARY_FIELDS) {
    const source = sourceForField(field, sourceMetadata);
    values[field.name] = {
      envKey: field.envKey,
      source,
      value: summaryValue(field.read(config)),
      restartRequired: RESTART_REQUIRED_ENV_KEY_SET.has(field.envKey),
      pendingRestart: isPendingRestartKey(field.envKey, pendingRestart),
    };
  }

  const secrets = {};
  for (const field of SECRET_SUMMARY_FIELDS) {
    const secretValue = field.read(config);
    secrets[field.name] = {
      envKey: field.envKey,
      source: sourceForField(field, sourceMetadata),
      set: typeof secretValue === 'string' && secretValue !== '',
      restartRequired: RESTART_REQUIRED_ENV_KEY_SET.has(field.envKey),
      pendingRestart: isPendingRestartKey(field.envKey, pendingRestart),
      redacted: true,
    };
  }

  return {
    revision,
    pendingRestart: normalizePendingRestartForSummary(pendingRestart),
    values,
    secrets,
  };
}

function sourceForField(field, sourceMetadata) {
  const direct = sourceMetadata[field.envKey]?.source;
  if (direct && direct !== SOURCE_MISSING) return direct;
  if (field.fallbackEnvKey) return sourceMetadata[field.fallbackEnvKey]?.source || SOURCE_MISSING;
  return direct || SOURCE_MISSING;
}

function summaryValue(value) {
  if (value instanceof Set) return [...value].sort();
  if (Array.isArray(value)) return value.map(item => summaryValue(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, nestedValue] of Object.entries(value)) out[key] = summaryValue(nestedValue);
    return out;
  }
  return value;
}

function normalizePendingRestartForSummary(pendingRestart) {
  if (!pendingRestart) return null;
  return {
    required: true,
    keys: Array.isArray(pendingRestart.keys) ? [...pendingRestart.keys] : [],
    sinceRevision: Number.isSafeInteger(pendingRestart.sinceRevision) ? pendingRestart.sinceRevision : null,
    createdAt: typeof pendingRestart.createdAt === 'string' ? pendingRestart.createdAt : null,
    message: typeof pendingRestart.message === 'string' ? pendingRestart.message : 'Restart required for pending configuration changes',
  };
}

function isPendingRestartKey(envKey, pendingRestart) {
  return Boolean(pendingRestart && Array.isArray(pendingRestart.keys) && pendingRestart.keys.includes(envKey));
}

function redactRawOverrides(rawOverrides = {}) {
  const overrides = normalizeRawOverrides(rawOverrides);
  const redacted = {};
  for (const [key, value] of Object.entries(overrides)) {
    redacted[key] = SECRET_ENV_KEY_SET.has(key) ? { redacted: true, set: value.trim() !== '' } : value;
  }
  return redacted;
}

function normalizeRawOverrides(rawOverrides = {}) {
  const source = rawOverrides && typeof rawOverrides === 'object' && hasOwn(rawOverrides, 'overrides') ? rawOverrides.overrides : rawOverrides;
  if (source == null) return {};
  if (Array.isArray(source) || typeof source !== 'object') throw new Error('Config overrides must be a JSON object keyed by environment variable name');

  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = normalizeOverrideKey(rawKey);
    if (rawValue == null) continue;
    if (!['string', 'number', 'boolean'].includes(typeof rawValue)) {
      throw new Error(`${key} override must be a string, number, or boolean`);
    }
    normalized[key] = String(rawValue);
  }
  return normalized;
}

function normalizeOverrideKey(rawKey) {
  const key = String(rawKey).trim();
  if (!/^[A-Z0-9_]+$/.test(key)) throw new Error(`Invalid config override key: ${rawKey}`);
  if (!CONFIG_ENV_KEY_SET.has(key)) throw new Error(`Unsupported config override key: ${key}`);
  if (NON_EDITABLE_ENV_KEYS.has(key)) throw new Error(`${key} cannot be edited from the admin dashboard`);
  return key;
}

function keepSecretOverride(overrides, envKey) {
  assertSecretEnvKey(envKey);
  return { ...normalizeRawOverrides(overrides) };
}

function clearSecretOverride(overrides, envKey) {
  const key = assertSecretEnvKey(envKey);
  if (NON_EDITABLE_ENV_KEYS.has(key)) throw new Error(`${key} cannot be edited from the admin dashboard`);
  return { ...normalizeRawOverrides(overrides), [key]: '' };
}

function replaceSecretOverride(overrides, envKey, secretValue) {
  const key = assertSecretEnvKey(envKey);
  if (NON_EDITABLE_ENV_KEYS.has(key)) throw new Error(`${key} cannot be edited from the admin dashboard`);
  const value = String(secretValue ?? '').trim();
  if (value === '') throw new Error(`${key} replacement must not be blank`);
  return { ...normalizeRawOverrides(overrides), [key]: value };
}

function applySecretOverride(overrides, envKey, { value = '', clear = false } = {}) {
  if (clear) return clearSecretOverride(overrides, envKey);
  const replacement = String(value ?? '').trim();
  if (replacement === '') return keepSecretOverride(overrides, envKey);
  return replaceSecretOverride(overrides, envKey, replacement);
}

function assertSecretEnvKey(envKey) {
  const key = normalizeOverrideKey(envKey);
  if (!SECRET_ENV_KEY_SET.has(key)) throw new Error(`${key} is not a secret config key`);
  return key;
}

function isConfigEnvKey(envKey) {
  return CONFIG_ENV_KEY_SET.has(String(envKey).trim());
}

function isSecretEnvKey(envKey) {
  return SECRET_ENV_KEY_SET.has(String(envKey).trim());
}

function isRestartRequiredEnvKey(envKey) {
  return RESTART_REQUIRED_ENV_KEY_SET.has(String(envKey).trim());
}

function loadConfigWithMetadata(env = process.env, rawOverrides = {}) {
  const merged = mergeConfigLayers(env, rawOverrides);
  const config = loadConfig(merged.env);
  return {
    config,
    overrides: merged.overrides,
    redactedOverrides: redactRawOverrides(merged.overrides),
    sources: merged.sources,
    summary: summarizeConfig(config, merged.sources),
  };
}

function buildConfigSummary(env = process.env, rawOverrides = {}, options = {}) {
  const loaded = loadConfigWithMetadata(env, rawOverrides);
  return summarizeConfig(loaded.config, loaded.sources, options);
}

function createConfigManager(options = {}) {
  return new ConfigManager(options);
}

function buildPendingRestartMarker(changedKeys, revision, now = new Date()) {
  const keys = [...new Set(changedKeys)].filter(key => RESTART_REQUIRED_ENV_KEY_SET.has(key)).sort();
  if (keys.length === 0) return null;
  return {
    required: true,
    keys,
    sinceRevision: revision,
    createdAt: now.toISOString(),
    message: 'Restart required for PORT changes to take effect',
  };
}

function diffOverrideKeys(previousOverrides, nextOverrides) {
  const previous = normalizeRawOverrides(previousOverrides);
  const next = normalizeRawOverrides(nextOverrides);
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const changed = [];
  for (const key of keys) {
    if (previous[key] !== next[key]) changed.push(key);
  }
  return changed.sort();
}

function emptyOverrideState() {
  return { revision: 0, updatedAt: null, overrides: {} };
}

function normalizeOverrideState(data, filePath = 'config override state') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${filePath} must contain a JSON object`);
  const hasStateShape = hasOwn(data, 'overrides');
  const overrides = normalizeRawOverrides(hasStateShape ? data.overrides : data);
  const revision = hasStateShape ? data.revision : 0;
  if (revision != null && (!Number.isSafeInteger(revision) || revision < 0)) {
    throw new Error(`${filePath} revision must be a non-negative integer`);
  }
  return {
    revision: revision ?? 0,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
    overrides,
  };
}

async function readOverrideState(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyOverrideState();
    throw error;
  }
  if (text.trim() === '') throw new Error(`${filePath} is empty`);
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${error.message}`);
  }
  return normalizeOverrideState(data, filePath);
}

async function readPendingRestartMarker(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (text.trim() === '') throw new Error(`${filePath} is empty`);
  let marker;
  try {
    marker = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${error.message}`);
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) throw new Error(`${filePath} must contain a JSON object`);
  return marker;
}

async function atomicWriteJson(filePath, data, { mode = 0o600 } = {}) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  let handle;
  try {
    handle = await fs.open(tempPath, 'wx', mode);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, mode);
  } catch (error) {
    if (handle) await closeHandleAfterFailedWrite(handle, error);
    await removeTempFileAfterFailedWrite(tempPath, error);
    throw error;
  }
}

async function closeHandleAfterFailedWrite(handle, cause) {
  try {
    await handle.close();
  } catch (error) {
    cause.closeError = error.message;
  }
}

async function removeTempFileAfterFailedWrite(tempPath, cause) {
  try {
    await fs.rm(tempPath, { force: true });
  } catch (error) {
    cause.cleanupError = error.message;
  }
}

class ConfigManager {
  constructor({ env = process.env, dataDir, storageDir, overrideFile, pendingRestartFile } = {}) {
    this.env = env;
    this.dataDir = dataDir || storageDir || resolveAdminDataDir(env);
    this.storageDir = this.dataDir;
    this.overrideFile = overrideFile || path.join(this.dataDir, OVERRIDES_FILE_NAME);
    this.pendingRestartFile = pendingRestartFile || path.join(this.dataDir, PENDING_RESTART_FILE_NAME);
  }

  async readOverrideState() {
    return readOverrideState(this.overrideFile);
  }

  async readOverrides() {
    return (await this.readOverrideState()).overrides;
  }

  buildConfig(rawOverrides = {}) {
    return loadConfig(mergeConfigLayers(this.env, rawOverrides).env);
  }

  async load() {
    const state = await this.readOverrideState();
    const merged = mergeConfigLayers(this.env, state.overrides);
    const config = this.buildConfig(state.overrides);
    const pendingRestart = await this.readPendingRestart();
    return {
      config,
      revision: state.revision,
      updatedAt: state.updatedAt,
      overrides: state.overrides,
      redactedOverrides: redactRawOverrides(state.overrides),
      sources: merged.sources,
      pendingRestart,
      summary: summarizeConfig(config, merged.sources, { revision: state.revision, pendingRestart }),
    };
  }

  async writeOverrides(rawOverrides, { expectedRevision } = {}) {
    const current = await this.readOverrideState();
    if (expectedRevision != null && current.revision !== expectedRevision) {
      throw new Error(`Config override revision ${current.revision} does not match expected revision ${expectedRevision}`);
    }

    const overrides = normalizeRawOverrides(rawOverrides);
    this.buildConfig(overrides);
    const changedKeys = diffOverrideKeys(current.overrides, overrides);
    if (changedKeys.length === 0) return current;

    const next = {
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      overrides,
    };
    await atomicWriteJson(this.overrideFile, next);

    const marker = buildPendingRestartMarker(changedKeys, next.revision);
    if (marker) await this.writePendingRestart(marker);
    return next;
  }

  async updateOverrides(mutator, { expectedRevision } = {}) {
    if (typeof mutator !== 'function') throw new Error('Config override mutator must be a function');
    const current = await this.readOverrideState();
    if (expectedRevision != null && current.revision !== expectedRevision) {
      throw new Error(`Config override revision ${current.revision} does not match expected revision ${expectedRevision}`);
    }
    const nextOverrides = await mutator({ ...current.overrides }, current);
    return this.writeOverrides(nextOverrides, { expectedRevision: current.revision });
  }

  async setRawOverride(envKey, value, options = {}) {
    const key = normalizeOverrideKey(envKey);
    return this.updateOverrides(overrides => {
      if (value == null) delete overrides[key];
      else overrides[key] = String(value);
      return overrides;
    }, options);
  }

  async deleteRawOverride(envKey, options = {}) {
    return this.setRawOverride(envKey, null, options);
  }

  async applySecretOverride(envKey, edit, options = {}) {
    const key = assertSecretEnvKey(envKey);
    return this.updateOverrides(overrides => applySecretOverride(overrides, key, edit), options);
  }

  async writePendingRestart(marker) {
    if (!marker || !Array.isArray(marker.keys) || marker.keys.length === 0) throw new Error('Pending restart marker must include keys');
    await atomicWriteJson(this.pendingRestartFile, marker);
    return marker;
  }

  async readPendingRestart() {
    return readPendingRestartMarker(this.pendingRestartFile);
  }

  async clearPendingRestart() {
    await fs.rm(this.pendingRestartFile, { force: true });
  }

  async ensureStorageDir() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    return this.dataDir;
  }
}

export {
  ConfigManager,
  CONFIG_ENV_KEYS,
  OPTIONAL_ENV_KEYS,
  DEFAULT_ADMIN_DATA_DIR,
  DEFAULT_ADMIN_STORAGE_DIR,
  DEFAULT_ENV,
  OVERRIDES_FILE_NAME,
  PENDING_RESTART_FILE_NAME,
  REQUIRED_ENV_KEYS,
  RESTART_REQUIRED_ENV_KEYS,
  SOURCE_DEFAULT,
  SOURCE_ENV,
  SOURCE_MISSING,
  SOURCE_OVERRIDE,
  SECRET_ENV_KEYS,
  NON_EDITABLE_ENV_KEYS,
  applySecretOverride,
  assertSecretEnvKey,
  atomicWriteJson,
  buildOcrEnv,
  buildPendingRestartMarker,
  buildSourceMetadata,
  buildConfigSummary,
  clearSecretOverride,
  csvList,
  csvSet,
  createConfigManager,
  diffOverrideKeys,
  getAdminPasswordStatus,
  keepSecretOverride,
  isConfigEnvKey,
  isRestartRequiredEnvKey,
  isSecretEnvKey,
  loadConfig,
  loadConfigWithMetadata,
  mergeConfigLayers,
  normalizeAllowedHost,
  normalizeOverrideKey,
  normalizeOverrideState,
  normalizeRawOverrides,
  optionalEnv,
  optionalSecret,
  parseBool,
  parseHostAllowlist,
  parseIntegerEnv,
  readOverrideState,
  readPendingRestartMarker,
  redactRawOverrides,
  replaceSecretOverride,
  requiredEnv,
  summarizeConfig,
  resolveAdminDataDir,
  validateHighRiskHostAllowlist,
};
