import fs from 'node:fs/promises';
import path from 'node:path';
import {
  appendDailyStats,
  atomicWriteFile,
  BoundedJobLogger,
  compactDailyStats,
  computeJobStats,
  computeRetentionPlan,
  isActiveStatus,
  isTerminalStatus,
  isUuid,
  parseJsonlText,
  readDailyStats,
  resolveJobLogsDir,
  retentionDefaults,
  toPublicJobSnapshot,
} from '../jobs/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_STATE_FILE = 'retention-state.json';
const AUDIT_DIR_NAMES = ['audit', 'config-audit'];
const EXPENDABLE_ADMIN_FILES = [RETENTION_STATE_FILE];

export class AdminRuntime {
  constructor({ configManager, eventStore, queue, logger = null, configProvider = null, adminDir = null, listener = null, startedAt = new Date() } = {}) {
    this.configManager = configManager;
    this.eventStore = eventStore;
    this.queue = queue;
    this.logger = logger;
    this.configProvider = configProvider ?? queue?.configProvider ?? null;
    this.adminDir = adminDir ?? inferAdminDir(eventStore) ?? null;
    this.listener = listener;
    this.startedAt = startedAt;
    this.replay = { jobs: [], degraded: false, corruptions: [], invalidEvents: [], truncatedTail: null };
    this.persistenceWarning = null;
    this.statsWarning = null;
    this.retentionWarning = null;
    this.lastRetention = null;
  }

  async initialize() {
    try {
      if (this.configManager) await this.configManager.ensureStorageDir();
    } catch (error) {
      this.persistenceWarning = `Admin config storage unavailable: ${error.message}`;
      console.error('admin config storage unavailable', error.stack || error.message);
    }
    await this.refresh();
    await this.markInterruptedJobs();
    await this.loadRetentionState();
  }

  async refresh() {
    if (!this.eventStore) return;
    try {
      this.replay = await this.eventStore.replay();
    } catch (error) {
      this.persistenceWarning = error.message;
      console.error('admin event replay failed', error.stack || error.message);
    }
  }

  async markInterruptedJobs() {
    const active = this.replay.jobs.filter(job => isActiveStatus(job.status));
    for (const job of active) {
      try {
        await this.eventStore.append({
          type: 'job.interrupted',
          jobId: job.id,
          data: { reason: 'process restarted before job completed' },
        });
      } catch (error) {
        this.persistenceWarning = `Could not mark interrupted jobs: ${error.message}`;
        console.error('admin interrupted recovery failed', error.stack || error.message);
        return;
      }
    }
    if (active.length > 0) await this.refresh();
  }

  queueSnapshot() {
    return this.queue ? this.queue.snapshot() : { running: null, queuedCount: 0, queued: [], diagnostics: [] };
  }

  setListener(listener) {
    this.listener = listener;
  }

  async jobs(context = {}) {
    await this.refresh();
    const request = context.request ?? null;
    const filters = normalizeJobFilters(context);
    const validationMessages = validateJobFilters(filters);
    const pageSize = normalizePageSize(filters.pageSize ?? context.pageSize ?? context.limit ?? 50);
    const page = normalizePage(filters.page ?? context.page ?? 1);
    const filtered = sortJobsByQueuedAt(this.replay.jobs).filter(job => matchesJobFilters(job, filters));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    const pageJobs = filtered.slice(start, start + pageSize).map(jobListItem);
    if (!request && !expectsJobsPage(context)) return pageJobs;
    return {
      jobs: pageJobs,
      filters,
      pagination: {
        page: currentPage,
        pageSize,
        total,
        totalPages,
        hasPrev: currentPage > 1,
        hasNext: currentPage < totalPages,
        prevPage: currentPage > 1 ? currentPage - 1 : null,
        nextPage: currentPage < totalPages ? currentPage + 1 : null,
      },
      validationMessages,
    };
  }

  async job(jobId, options = {}) {
    return this.jobDetail(jobId, options);
  }

  async jobDetail(jobId, { logLimit = 200, logOffset = 0 } = {}) {
    await this.refresh();
    if (!isUuid(jobId)) return null;
    const job = this.replay.jobs.find(item => item.id === jobId);
    if (!job) return null;
    const config = startTimeConfigSummary(job) ?? await this.safeRuntimeConfigSummary();
    const detail = {
      ...toPublicJobSnapshot(job),
      jobId: job.id,
      repo: job.repository.fullName,
      queueWaitMs: computeQueueWaitMs(job),
      phase: job.progress?.phase || job.status,
      config,
      configRevision: config.revision,
      runtimeSettings: config.settings,
      phaseTimeline: await this.phaseTimeline(job),
      ocr: extractOcrStatus(job),
      ocrStatus: extractOcrStatus(job).status,
      counts: extractJobCounts(job),
      warnings: extractJobWarnings(job),
      failure: extractJobFailure(job),
      reportingError: extractResultField(job, 'reportingError'),
      cleanupWarning: extractResultField(job, 'cleanupWarning'),
      logs: null,
      diagnostics: [],
    };
    const logger = await this.getLogger();
    if (!logger) return detail;
    try {
      detail.logs = await logger.read(job.id, { limit: normalizeLimit(logLimit), offset: normalizeOffset(logOffset) });
      if (detail.logs.degraded) detail.diagnostics.push({ level: 'warn', id: 'logs', message: 'Job log history is degraded.' });
      if (detail.logs.truncatedTail) detail.diagnostics.push({ level: 'info', id: 'logs.tail', message: 'Ignored truncated final log line.' });
    } catch (error) {
      const message = `Could not read job log: ${error.message}`;
      this.persistenceWarning = message;
      detail.diagnostics.push({ level: 'warn', id: 'logs.unavailable', message });
      console.error('admin job log read failed', error.stack || error.message);
    }
    return detail;
  }

  async phaseTimeline(job) {
    const eventTimeline = await readJobEventTimeline(this.eventStore, job.id);
    const logTimeline = await readJobLogTimeline(await this.getLogger(), job.id);
    return mergePhaseTimeline(job, eventTimeline, logTimeline);
  }

  async stats(options = {}) {
    await this.refresh();
    const computed = computeJobStats(this.replay.jobs, options);
    if (!this.adminDir) return { ...computed, daily: { records: [], degraded: false, corruptions: [], invalidRecords: [], truncatedTail: null } };
    try {
      return { ...computed, daily: await readDailyStats({ adminDir: this.adminDir }) };
    } catch (error) {
      this.statsWarning = `Could not read aggregate stats: ${error.message}`;
      console.error('admin stats read failed', error.stack || error.message);
      return { ...computed, daily: { records: [], degraded: true, corruptions: [], invalidRecords: [{ reason: error.message }], truncatedTail: null } };
    }
  }

  async retentionStatus() {
    await this.loadRetentionState();
    return {
      config: await this.retentionConfig(),
      lastRun: this.lastRetention,
    };
  }

  async runRetention(options = {}) {
    await this.refresh();
    const nowMs = options.now == null ? Date.now() : timestampMs(options.now, 'now');
    const now = new Date(nowMs).toISOString();
    const config = retentionDefaults({ ...(await this.retentionConfig()), ...sanitizeRetentionOverrides(options) });
    const result = {
      ok: true,
      startedAt: now,
      finishedAt: null,
      config,
      bytesBefore: 0,
      bytesAfter: 0,
      bytesReclaimed: 0,
      logs: { examined: 0, deleted: 0, expiredDeleted: 0, orphanDeleted: 0, skippedActive: 0, bytesReclaimed: 0 },
      events: null,
      stats: null,
      audit: null,
      softCap: { applied: false, targetBytes: null, bytesBefore: 0, bytesAfter: 0, overageBytes: 0, targetMet: true, stillOverCap: false, earlyDeletion: [], bytesReclaimed: 0 },
      diagnostics: [],
    };

    if (!this.adminDir) {
      result.ok = false;
      result.diagnostics.push({ level: 'warn', id: 'retention.adminDir', message: 'Admin data directory is not configured; retention skipped.' });
      return this.finishRetentionResult(result);
    }

    result.bytesBefore = await safeDirectorySize(this.adminDir, result.diagnostics);
    const activeJobIds = activeJobIdsFrom(this.replay.jobs, this.queueSnapshot());
    const terminalJobIds = new Set(this.replay.jobs.filter(job => isTerminalStatus(job.status)).map(job => job.id));

    await this.captureRetentionStep(result, 'logs', async () => pruneRuntimeLogs({
      adminDir: this.adminDir,
      jobs: this.replay.jobs,
      activeJobIds,
      retentionDays: config.jobLogRetentionDays,
      nowMs,
    }));

    await this.captureRetentionStep(result, 'stats', async () => {
      const append = await appendDailyStats(this.replay.jobs, { adminDir: this.adminDir, now: nowMs });
      const compact = await compactDailyStats({ adminDir: this.adminDir, now: nowMs, retentionDays: config.statsRetentionDays });
      return { ...compact, appended: append.appended, bytesReclaimed: compact.bytesReclaimed };
    });

    const historyCutoff = new Date(nowMs - config.jobHistoryRetentionDays * DAY_MS).toISOString();
    const statsReadyForTerminalDrop = result.stats && result.stats.degraded !== true;
    if (this.eventStore?.compact) {
      await this.captureRetentionStep(result, 'events', () => this.eventStore.compact({
        now,
        terminalDetailsBefore: historyCutoff,
        terminalJobsBefore: statsReadyForTerminalDrop ? historyCutoff : null,
      }));
      await this.refresh();
    }

    await this.captureRetentionStep(result, 'audit', () => {
      if (this.configManager?.compactConfigAudit) {
        return this.configManager.compactConfigAudit({
          retentionDays: config.configAuditRetentionDays,
          now: new Date(nowMs),
        });
      }
      return pruneAuditFiles({
        adminDir: this.adminDir,
        retentionDays: config.configAuditRetentionDays,
        nowMs,
      });
    });

    if (config.adminDataMaxBytes != null) {
      await this.captureRetentionStep(result, 'softCap', () => enforceSoftCap({
        adminDir: this.adminDir,
        maxBytes: config.adminDataMaxBytes,
        activeJobIds,
        terminalJobIds,
        eventStore: this.eventStore,
        now,
      }));
      if (result.softCap?.stillOverCap) {
        result.diagnostics.push({ level: 'warn', id: 'retention.softCap.stillOverCap', message: `Admin data remains ${result.softCap.overageBytes} bytes over the ${result.softCap.targetBytes} byte soft cap after deleting all eligible artifacts.` });
      }
    }

    result.bytesAfter = await safeDirectorySize(this.adminDir, result.diagnostics);
    result.bytesReclaimed = Math.max(0, result.bytesBefore - result.bytesAfter);
    const finished = await this.finishRetentionResult(result);
    if (config.adminDataMaxBytes != null) {
      await refreshSoftCapFinalStatus(finished, this.adminDir, config.adminDataMaxBytes);
      await this.persistRetentionResult(finished);
    }
    return finished;
  }

  async dashboard() {
    await this.refresh();
    const queue = this.queueSnapshot();
    const summary = summarizeJobs(this.replay.jobs);
    applyQueueCounts(summary, queue);
    const jobsPage = await this.jobs({ limit: 20, pageSize: 20, page: 1, asPage: true });
    const nowMs = Date.now();
    const stats = mergePersistedDailyTrend(enrichDashboardStats(await this.stats({ now: nowMs }), this.replay.jobs, nowMs));
    const diagnostics = [...this.diagnostics(), ...queueDiagnostics(queue)];
    return {
      summary,
      recentJobs: jobsPage.jobs,
      metrics: stats,
      stats,
      queue,
      serviceStatus: await this.serviceStatus(queue),
      retention: await this.retentionStatus(),
      diagnostics,
    };
  }

  async serviceStatus(queue = this.queueSnapshot()) {
    const nowMs = Date.now();
    const config = await this.safeRuntimeConfigSummary();
    const retention = await this.retentionStatus();
    const storageDiagnostics = [];
    const dirSizeBytes = this.adminDir ? await safeDirectorySize(this.adminDir, storageDiagnostics) : 0;
    const retentionConfig = retention.config;
    const running = queue.running ? {
      ...queue.running,
      elapsedMs: queue.running.startedAt ? Math.max(0, nowMs - timestampMs(queue.running.startedAt, 'running.startedAt')) : null,
    } : null;
    const actualListeningPort = actualPortFromListener(this.listener);
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeMs: Math.max(0, nowMs - this.startedAt.getTime()),
      version: config.version,
      configRevision: config.revision,
      configuredPort: config.port,
      port: config.port,
      actualListeningPort,
      listeningPort: actualListeningPort,
      pendingPort: config.pendingPort,
      desiredPendingPort: config.pendingPort,
      running,
      queuedCount: queue.queuedCount,
      queued: summarizeQueued(queue),
      lastSuccess: newestJob(this.replay.jobs, job => job.status === 'succeeded' || job.status === 'succeeded_with_warnings'),
      lastFailure: newestJob(this.replay.jobs, job => job.status === 'failed'),
      storage: {
        adminDir: this.adminDir,
        writable: this.persistenceWarning == null,
        degraded: this.replay.degraded || storageDiagnostics.length > 0,
        dirSizeBytes,
        budgetBytes: retentionConfig.adminDataMaxBytes,
      },
      diagnostics: {
        degraded: this.replay.degraded || storageDiagnostics.length > 0,
        corruptEvents: this.replay.corruptions.length,
        invalidEvents: this.replay.invalidEvents.length,
        truncatedTail: Boolean(this.replay.truncatedTail),
      },
      lastRetention: retention.lastRun,
    };
  }

  diagnostics() {
    const items = [];
    if (this.persistenceWarning) items.push({ level: 'warn', id: 'persistence', message: this.persistenceWarning });
    if (this.statsWarning) items.push({ level: 'warn', id: 'stats', message: this.statsWarning });
    if (this.retentionWarning) items.push({ level: 'warn', id: 'retention', message: this.retentionWarning });
    if (this.replay.degraded) items.push({ level: 'warn', id: 'events', message: 'Job event history is degraded.' });
    if (this.replay.truncatedTail) items.push({ level: 'info', id: 'events.tail', message: 'Ignored truncated final event line.' });
    for (const corruption of this.replay.corruptions.slice(0, 5)) {
      items.push({ level: 'warn', id: `events.corrupt.${corruption.lineNumber}`, message: `Corrupt event line ${corruption.lineNumber}: ${corruption.message}` });
    }
    for (const invalid of this.replay.invalidEvents.slice(0, 5)) {
      items.push({ level: 'warn', id: `events.invalid.${invalid.lineNumber}`, message: `Invalid event line ${invalid.lineNumber}: ${invalid.reason}` });
    }
    if (this.lastRetention && this.lastRetention.ok === false) {
      items.push({ level: 'warn', id: 'retention.lastRun', message: 'Last retention run completed with diagnostics.' });
    }
    return items;
  }

  async configSummary() {
    if (!this.configManager) return {};
    const state = await this.configManager.load();
    return { ...state.summary, revision: state.revision, pendingRestart: state.pendingRestart };
  }

  async safeRuntimeConfigSummary() {
    try {
      if (this.configManager) {
        const state = await this.configManager.load();
        const values = state.summary?.values ?? {};
        return {
          revision: state.revision,
          version: values.version?.value,
          port: values.port?.value,
          pendingPort: state.pendingRestart?.keys?.includes('PORT') ? values.port?.value : null,
          settings: redactRuntimeSettings(values),
        };
      }
      if (this.configProvider) {
        const config = await this.configProvider();
        return { revision: null, version: config.version, port: config.port, pendingPort: null, settings: redactRuntimeSettings(config) };
      }
    } catch (error) {
      this.persistenceWarning = `Could not load runtime config summary: ${error.message}`;
      console.error('admin runtime config summary failed', error.stack || error.message);
    }
    return { revision: null, version: null, port: null, pendingPort: null, settings: {} };
  }

  async retentionConfig() {
    try {
      if (this.configProvider) return retentionDefaults(await this.configProvider());
      if (this.configManager) {
        const state = await this.configManager.load();
        return retentionDefaults(state.config ?? {});
      }
    } catch (error) {
      this.retentionWarning = `Could not load retention config; using defaults: ${error.message}`;
      console.error('admin retention config load failed', error.stack || error.message);
    }
    return retentionDefaults();
  }

  async loadRetentionState() {
    if (!this.adminDir || this.lastRetention) return;
    try {
      const raw = await fs.readFile(path.join(this.adminDir, RETENTION_STATE_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      this.lastRetention = parsed.lastRun ?? null;
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      this.retentionWarning = `Could not read retention state: ${error.message}`;
      console.error('admin retention state read failed', error.stack || error.message);
    }
  }

  async finishRetentionResult(result) {
    result.finishedAt = new Date().toISOString();
    result.ok = result.ok && result.diagnostics.length === 0;
    this.lastRetention = result;
    await this.persistRetentionResult(result);
    return result;
  }

  async persistRetentionResult(result) {
    if (!this.adminDir) return;
    try {
      await atomicWriteFile(path.join(this.adminDir, RETENTION_STATE_FILE), `${JSON.stringify({ lastRun: result }, null, 2)}\n`);
    } catch (error) {
      this.retentionWarning = `Could not persist retention state: ${error.message}`;
      result.ok = false;
      result.diagnostics.push({ level: 'warn', id: 'retention.persist', message: this.retentionWarning });
      console.error('admin retention state write failed', error.stack || error.message);
    }
  }

  async captureRetentionStep(result, key, operation) {
    try {
      result[key] = await operation();
    } catch (error) {
      result.ok = false;
      const diagnostic = { level: 'warn', id: `retention.${key}`, message: error.message };
      result.diagnostics.push(diagnostic);
      this.retentionWarning = `Retention ${key} step failed: ${error.message}`;
      console.error('admin retention step failed', { step: key, error: error.stack || error.message });
    }
  }

  async getLogger() {
    if (this.logger) return this.logger;
    if (!this.adminDir) return null;
    const config = await this.retentionConfig();
    this.logger = new BoundedJobLogger({ adminDir: this.adminDir, maxBytes: config.jobLogMaxBytes });
    return this.logger;
  }
}

export async function directorySize(root) {
  let total = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile()) total += (await fs.stat(fullPath)).size;
    }
  }
  await walk(root);
  return total;
}

async function pruneRuntimeLogs({ adminDir, jobs, activeJobIds, retentionDays, nowMs }) {
  const logsDir = resolveJobLogsDir(adminDir);
  const jobById = new Map(jobs.map(job => [job.id, job]));
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  const result = { examined: 0, deleted: 0, expiredDeleted: 0, orphanDeleted: 0, skippedActive: 0, bytesReclaimed: 0 };
  let entries;
  try {
    entries = await fs.readdir(logsDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return result;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const jobId = entry.name.slice(0, -'.jsonl'.length);
    if (!isUuid(jobId)) continue;
    result.examined += 1;
    const filePath = path.join(logsDir, entry.name);
    const stat = await fs.stat(filePath);
    if (activeJobIds.has(jobId)) {
      result.skippedActive += 1;
      continue;
    }
    const job = jobById.get(jobId);
    const orphan = !job;
    const expired = stat.mtimeMs < cutoffMs;
    if (!expired) continue;
    await fs.rm(filePath, { force: true });
    result.deleted += 1;
    result.bytesReclaimed += stat.size;
    if (orphan) result.orphanDeleted += 1;
    else result.expiredDeleted += 1;
  }
  return result;
}

async function pruneAuditFiles({ adminDir, retentionDays, nowMs }) {
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  const result = { examined: 0, deleted: 0, compacted: 0, recordsRetained: 0, recordsRemoved: 0, bytesReclaimed: 0 };
  for (const dirName of AUDIT_DIR_NAMES) {
    const dir = path.join(adminDir, dirName);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      result.examined += 1;
      const filePath = path.join(dir, entry.name);
      const before = await fs.stat(filePath);
      if (entry.name.endsWith('.jsonl')) {
        const compacted = await compactAuditJsonlFile(filePath, cutoffMs);
        result.recordsRetained += compacted.retained;
        result.recordsRemoved += compacted.removed;
        if (compacted.removed > 0) result.compacted += 1;
        result.bytesReclaimed += compacted.bytesReclaimed;
        continue;
      }
      if (before.mtimeMs >= cutoffMs) continue;
      await fs.rm(filePath, { force: true });
      result.deleted += 1;
      result.bytesReclaimed += before.size;
    }
  }
  return result;
}

async function compactAuditJsonlFile(filePath, cutoffMs) {
  const before = await fs.stat(filePath);
  const text = await fs.readFile(filePath, 'utf8');
  const retained = [];
  let removed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line);
      const timestamp = typeof record.timestamp === 'string' ? new Date(record.timestamp).getTime() : Number.NaN;
      if (!Number.isNaN(timestamp) && timestamp >= cutoffMs) retained.push(record);
      else removed += 1;
    } catch {
      removed += 1;
    }
  }
  if (removed === 0) return { retained: retained.length, removed: 0, bytesReclaimed: 0 };
  const payload = retained.map(record => `${JSON.stringify(record)}\n`).join('');
  await atomicWriteFile(filePath, payload);
  const after = await fs.stat(filePath);
  return { retained: retained.length, removed, bytesReclaimed: Math.max(0, before.size - after.size) };
}

async function enforceSoftCap({ adminDir, maxBytes, activeJobIds, terminalJobIds, eventStore, now }) {
  const result = {
    applied: true,
    targetBytes: maxBytes,
    bytesBefore: 0,
    bytesAfter: 0,
    overageBytes: 0,
    targetMet: true,
    stillOverCap: false,
    earlyDeletion: [],
    bytesReclaimed: 0,
  };
  let currentBytes = await directorySize(adminDir);
  result.bytesBefore = currentBytes;
  if (currentBytes <= maxBytes) {
    result.applied = false;
    result.bytesAfter = currentBytes;
    return result;
  }

  const logs = await logFileInfos(adminDir, activeJobIds, terminalJobIds);
  for (const log of logs.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (currentBytes <= maxBytes) break;
    await fs.rm(log.path, { force: true });
    currentBytes = Math.max(0, currentBytes - log.size);
    result.bytesReclaimed = Math.max(0, result.bytesBefore - currentBytes);
    result.earlyDeletion.push({ kind: 'job-log', jobId: log.jobId, bytes: log.size, reason: 'soft_cap' });
  }

  if (currentBytes > maxBytes && eventStore?.compact && terminalJobIds.size > 0) {
    const before = currentBytes;
    const compaction = await eventStore.compact({ now, terminalDetailsBefore: new Date(timestampMs(now, 'now') + DAY_MS).toISOString() });
    currentBytes = await directorySize(adminDir);
    result.bytesReclaimed = Math.max(0, result.bytesBefore - currentBytes);
    result.earlyDeletion.push({ kind: 'terminal-job-detail', count: compaction.terminalDetailsCompacted, bytes: Math.max(0, before - currentBytes), reason: 'soft_cap' });
  }

  for (const relative of EXPENDABLE_ADMIN_FILES) {
    if (currentBytes <= maxBytes) break;
    const filePath = path.join(adminDir, relative);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    await fs.rm(filePath, { force: true });
    currentBytes = Math.max(0, currentBytes - stat.size);
    result.bytesReclaimed = Math.max(0, result.bytesBefore - currentBytes);
    result.earlyDeletion.push({ kind: 'admin-data', path: relative, bytes: stat.size, reason: 'soft_cap' });
  }

  currentBytes = await directorySize(adminDir);
  result.bytesReclaimed = Math.max(0, result.bytesBefore - currentBytes);
  result.bytesAfter = currentBytes;
  result.overageBytes = Math.max(0, currentBytes - maxBytes);
  result.targetMet = result.overageBytes === 0;
  result.stillOverCap = !result.targetMet;
  return result;
}

async function refreshSoftCapFinalStatus(result, adminDir, maxBytes) {
  const finalBytes = await safeDirectorySize(adminDir, result.diagnostics);
  result.bytesAfter = finalBytes;
  result.bytesReclaimed = Math.max(0, result.bytesBefore - finalBytes);
  result.softCap.bytesAfter = finalBytes;
  result.softCap.overageBytes = Math.max(0, finalBytes - maxBytes);
  result.softCap.targetMet = result.softCap.overageBytes === 0;
  result.softCap.stillOverCap = !result.softCap.targetMet;
  if (result.softCap.stillOverCap && !result.diagnostics.some(item => item.id === 'retention.softCap.stillOverCap')) {
    result.diagnostics.push({ level: 'warn', id: 'retention.softCap.stillOverCap', message: `Admin data remains ${result.softCap.overageBytes} bytes over the ${result.softCap.targetBytes} byte soft cap after retention state persistence.` });
  }
  result.ok = result.diagnostics.length === 0;
}

async function logFileInfos(adminDir, activeJobIds, terminalJobIds = new Set()) {
  const logsDir = resolveJobLogsDir(adminDir);
  let entries;
  try {
    entries = await fs.readdir(logsDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const jobId = entry.name.slice(0, -'.jsonl'.length);
    if (!isUuid(jobId) || activeJobIds.has(jobId) || !terminalJobIds.has(jobId)) continue;
    const filePath = path.join(logsDir, entry.name);
    const stat = await fs.stat(filePath);
    files.push({ path: filePath, jobId, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files;
}

async function safeDirectorySize(adminDir, diagnostics) {
  try {
    return await directorySize(adminDir);
  } catch (error) {
    diagnostics.push({ level: 'warn', id: 'retention.size', message: error.message });
    return 0;
  }
}

function activeJobIdsFrom(jobs, queue) {
  const active = new Set(jobs.filter(job => isActiveStatus(job.status)).map(job => job.id));
  if (queue.running?.jobId) active.add(queue.running.jobId);
  for (const job of queue.queued ?? []) {
    if (job?.jobId) active.add(job.jobId);
  }
  return active;
}

function summarizeJobs(jobs) {
  const summary = {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    succeeded_with_warnings: 0,
    stale: 0,
    skipped: 0,
    interrupted: 0,
  };
  for (const job of jobs) {
    if (Object.hasOwn(summary, job.status)) summary[job.status] += 1;
  }
  return summary;
}

function applyQueueCounts(summary, queue) {
  summary.queued = Math.max(summary.queued, queue.queuedCount);
  summary.running = Math.max(summary.running, queue.running ? 1 : 0);
  return summary;
}

function jobListItem(job) {
  return {
    jobId: job.id,
    id: job.id,
    diagnosticId: job.diagnosticId,
    status: job.status,
    repo: job.repository.fullName,
    repository: job.repository,
    pullNumber: job.pullNumber,
    trigger: job.trigger,
    actor: job.actor,
    createdAt: job.queuedAt,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    errorKind: failureKindForJob(job),
    durationMs: job.startedAt ? timestampMs(job.finishedAt ?? job.updatedAt, 'durationEnd') - timestampMs(job.startedAt, 'startedAt') : null,
  };
}

function searchableJobText(job) {
  return [job.id, job.diagnosticId, job.status, job.conclusion, job.repository.fullName, job.pullNumber, job.trigger, job.actor, failureKindForJob(job)]
    .filter(value => value != null && value !== '')
    .join(' ')
    .toLowerCase();
}

function normalizeJobFilters(context = {}) {
  const query = context.request?.query;
  const read = (name, ...aliases) => {
    for (const key of [name, ...aliases]) {
      const direct = context[key];
      if (direct != null && direct !== '') return String(direct).trim();
      const queried = query?.get?.(key);
      if (queried != null && queried !== '') return String(queried).trim();
    }
    return '';
  };
  return {
    owner: read('owner'),
    repository: read('repository', 'repo'),
    state: read('state', 'status', 'outcome'),
    failureKind: read('failureKind', 'failure_kind', 'errorKind'),
    diagnosticId: read('diagnosticId', 'diagnostic_id'),
    from: read('from', 'queuedFrom'),
    to: read('to', 'queuedTo'),
    filter: read('filter', 'q'),
    page: read('page'),
    pageSize: read('pageSize', 'limit', 'size'),
  };
}

function validateJobFilters(filters) {
  const messages = [];
  for (const [key, value] of [['from', filters.from], ['to', filters.to]]) {
    if (value && Number.isNaN(new Date(value).getTime())) messages.push(`${key} must be a valid date`);
  }
  return messages;
}

function matchesJobFilters(job, filters) {
  if (filters.owner && !job.repository.owner.toLowerCase().includes(filters.owner.toLowerCase())) return false;
  if (filters.repository && !job.repository.name.toLowerCase().includes(filters.repository.toLowerCase()) && !job.repository.fullName.toLowerCase().includes(filters.repository.toLowerCase())) return false;
  const result = extractResult(job);
  if (filters.state && job.status !== filters.state && job.conclusion !== filters.state && result.outcome !== filters.state) return false;
  if (filters.failureKind && failureKindForJob(job) !== filters.failureKind) return false;
  if (filters.diagnosticId && !job.diagnosticId.toLowerCase().includes(filters.diagnosticId.toLowerCase())) return false;
  if (filters.filter && !searchableJobText(job).includes(filters.filter.toLowerCase())) return false;
  const queuedAt = timestampMs(job.queuedAt, 'queuedAt');
  const fromMs = filterDateMs(filters.from, false);
  const toMs = filterDateMs(filters.to, true);
  if (fromMs != null && queuedAt < fromMs) return false;
  if (toMs != null && queuedAt > toMs) return false;
  return true;
}

function filterDateMs(value, endOfDay) {
  if (!value || Number.isNaN(new Date(value).getTime())) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return timestampMs(dateOnly && endOfDay ? `${value}T23:59:59.999Z` : value, endOfDay ? 'to' : 'from');
}

function failureKindForJob(job) {
  const result = extractResult(job);
  return job.errorKind || result.failure?.kind || result.reportingError?.kind || '';
}

function expectsJobsPage(context) {
  return context.asPage === true || context.page != null || context.pageSize != null || context.request != null;
}

function normalizePageSize(value) {
  if (value == null || value === '') return 50;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 50;
  return Math.min(parsed, 200);
}

function normalizePage(value) {
  if (value == null || value === '') return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 1;
  return parsed;
}

function computeQueueWaitMs(job) {
  if (!job.startedAt || !job.queuedAt) return null;
  return Math.max(0, timestampMs(job.startedAt, 'startedAt') - timestampMs(job.queuedAt, 'queuedAt'));
}

function extractResult(job) {
  return job.result && typeof job.result === 'object' && !Array.isArray(job.result) ? job.result : {};
}

function extractResultField(job, key) {
  const result = extractResult(job);
  return result[key] ?? null;
}

function extractOcrStatus(job) {
  const result = extractResult(job);
  return {
    status: result.ocrStatus ?? result.outcome ?? job.status,
    phase: job.progress?.phase ?? '',
    message: job.progress?.message ?? '',
  };
}

function extractJobCounts(job) {
  const result = extractResult(job);
  return {
    generated: numberOrNull(result.commentsGenerated),
    selected: numberOrNull(result.commentsSelected),
    posted: numberOrNull(result.commentsPosted),
    omitted: numberOrNull(result.commentsOmitted),
    warnings: numberOrNull(result.warningsCount),
  };
}

function extractJobWarnings(job) {
  const result = extractResult(job);
  const warnings = [];
  if (Array.isArray(result.warnings)) warnings.push(...result.warnings);
  if (Array.isArray(result.publishWarnings)) warnings.push(...result.publishWarnings);
  return warnings;
}

function extractJobFailure(job) {
  const result = extractResult(job);
  if (result.failure && typeof result.failure === 'object' && !Array.isArray(result.failure)) return result.failure;
  if (job.errorKind || job.errorMessage) return { kind: job.errorKind, reason: job.errorMessage };
  return null;
}

function sortJobsByQueuedAt(jobs) {
  return [...jobs].sort((left, right) => timestampMs(right.queuedAt, 'queuedAt') - timestampMs(left.queuedAt, 'queuedAt'));
}

function summarizeQueued(queue) {
  const items = Array.isArray(queue.queued) ? queue.queued : [];
  return {
    count: Number.isSafeInteger(queue.queuedCount) ? queue.queuedCount : items.length,
    items: items.slice(0, 10).map(job => ({
      jobId: job.jobId ?? job.id ?? '',
      id: job.jobId ?? job.id ?? '',
      diagnosticId: job.diagnosticId ?? '',
      repository: job.repository ?? job.repo ?? (job.owner && job.repo ? `${job.owner}/${job.repo}` : ''),
      repo: job.repository ?? job.repo ?? (job.owner && job.repo ? `${job.owner}/${job.repo}` : ''),
      pullNumber: job.pullNumber ?? null,
      actor: job.actor ?? '',
      queuedAt: job.queuedAt ?? null,
      status: job.status ?? job.phase ?? 'queued',
      phase: job.phase ?? job.status ?? 'queued',
    })),
  };
}


function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function queueDiagnostics(queue) {
  if (!Array.isArray(queue?.diagnostics)) return [];
  return queue.diagnostics.map((item, index) => ({ level: item.level ?? 'warn', id: item.id ?? `queue.${index}`, message: item.message ?? String(item) }));
}

function newestJob(jobs, predicate) {
  return jobs.filter(predicate).sort((left, right) => timestampMs(right.updatedAt, 'updatedAt') - timestampMs(left.updatedAt, 'updatedAt'))[0] ?? null;
}

function redactRuntimeSettings(values) {
  const out = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (/password|secret|token|private|key|auth/i.test(key)) continue;
    out[key] = value && typeof value === 'object' && 'value' in value ? value.value : value;
  }
  return out;
}

const DASHBOARD_STATS_WINDOWS = Object.freeze({ '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS });

function mergePersistedDailyTrend(stats) {
  const mergedByDay = new Map();
  for (const record of stats.daily?.records ?? []) {
    mergedByDay.set(record.day, { ...record });
  }
  for (const day of stats.dailyTrend ?? []) {
    mergedByDay.set(day.day, { ...day });
  }
  return {
    ...stats,
    dailyTrend: Array.from(mergedByDay.values()).sort((left, right) => left.day.localeCompare(right.day)),
  };
}

function enrichDashboardStats(stats, jobs, nowMs) {
  const allJobs = Array.isArray(jobs) ? jobs : [];
  enrichStatsBucket(stats.total, allJobs);
  for (const [name, widthMs] of Object.entries(DASHBOARD_STATS_WINDOWS)) {
    enrichStatsBucket(stats.windows?.[name], allJobs.filter(job => jobStatsAnchorMs(job) >= nowMs - widthMs));
  }
  if (Array.isArray(stats.dailyTrend)) {
    for (const day of stats.dailyTrend) {
      enrichStatsBucket(day, allJobs.filter(job => jobStatsDay(job) === day.day));
    }
  }
  return stats;
}

function enrichStatsBucket(bucket, jobs) {
  if (!bucket) return bucket;
  let commentsGeneratedTotal = 0;
  let commentsPostedTotal = 0;
  const repositories = {};
  for (const job of jobs) {
    const comments = extractCommentTotals(job);
    commentsGeneratedTotal += comments.generated;
    commentsPostedTotal += comments.posted;
    const name = job.repository?.fullName || 'unknown';
    const repo = repositories[name] ?? { jobs: 0, succeeded: 0, succeeded_with_warnings: 0, failed: 0, stale: 0, skipped: 0, interrupted: 0, successRate: null };
    repo.jobs += 1;
    if (job.status === 'succeeded') repo.succeeded += 1;
    if (job.status === 'succeeded_with_warnings') repo.succeeded_with_warnings += 1;
    if (job.status === 'failed') repo.failed += 1;
    if (job.status === 'stale') repo.stale += 1;
    if (job.status === 'skipped') repo.skipped += 1;
    if (job.status === 'interrupted') repo.interrupted += 1;
    repositories[name] = repo;
  }
  for (const repo of Object.values(repositories)) {
    const denominator = repo.succeeded + repo.succeeded_with_warnings + repo.failed;
    repo.successRate = denominator > 0 ? (repo.succeeded + repo.succeeded_with_warnings) / denominator : null;
  }
  bucket.commentsGeneratedTotal = commentsGeneratedTotal;
  bucket.commentsPostedTotal = commentsPostedTotal;
  bucket.averageCommentsGenerated = bucket.commentSamples > 0 ? commentsGeneratedTotal / bucket.commentSamples : bucket.averageCommentsGenerated ?? null;
  bucket.averageCommentsPosted = bucket.commentSamples > 0 ? commentsPostedTotal / bucket.commentSamples : bucket.averageCommentsPosted ?? null;
  bucket.repositories = repositories;
  return bucket;
}

function extractCommentTotals(job) {
  const result = extractResult(job);
  return {
    generated: Number.isFinite(result.commentsGenerated) ? result.commentsGenerated : 0,
    posted: Number.isFinite(result.commentsPosted) ? result.commentsPosted : 0,
  };
}

function jobStatsDay(job) {
  return new Date(jobStatsAnchorMs(job)).toISOString().slice(0, 10);
}

function jobStatsAnchorMs(job) {
  return timestampMs(job.finishedAt ?? job.startedAt ?? job.queuedAt ?? job.updatedAt, 'job stats timestamp');
}

function startTimeConfigSummary(job) {
  const snapshot = objectValue(job.startSnapshot) || objectValue(job.configSnapshot) || objectValue(job.taskConfigSnapshot) || objectValue(job.startedConfig);
  if (!snapshot) return null;
  return {
    revision: snapshot.revision ?? snapshot.configRevision ?? null,
    version: snapshot.version ?? null,
    port: snapshot.port ?? snapshot.configuredPort ?? null,
    pendingPort: snapshot.pendingPort ?? null,
    settings: redactRuntimeSettings(snapshot.settings ?? snapshot.runtimeSettings ?? snapshot.values ?? snapshot),
  };
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

async function readJobEventTimeline(eventStore, jobId) {
  if (!eventStore?.filePath) return [];
  let raw = '';
  try {
    raw = await fs.readFile(eventStore.filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const parsed = parseJsonlText(raw, { source: eventStore.filePath });
  const timeline = [];
  for (const record of parsed.records) {
    const event = record.value;
    if (!event || event.jobId !== jobId) continue;
    const item = timelineItemFromEvent(event);
    if (item) timeline.push(item);
  }
  return timeline;
}

async function readJobLogTimeline(logger, jobId) {
  if (!logger) return [];
  const logs = await logger.read(jobId);
  return logs.entries
    .filter(entry => typeof entry.fields?.phase === 'string' && entry.fields.phase !== '')
    .map(entry => ({
      timestamp: entry.timestamp,
      label: entry.fields.phase,
      message: entry.message,
      source: 'log',
    }));
}

function timelineItemFromEvent(event) {
  const data = objectValue(event.data) ?? {};
  if (event.type === 'job.queued') return { timestamp: event.timestamp, label: 'Queued', phase: data.progress?.phase ?? 'queued', message: data.progress?.message ?? 'Review job queued', source: 'event' };
  if (event.type === 'job.started') return { timestamp: event.timestamp, label: 'Started', phase: data.progress?.phase ?? 'started', message: data.progress?.message ?? 'Review job started', source: 'event' };
  if (event.type === 'job.progress') {
    const progress = objectValue(data.progress) ?? data;
    return { timestamp: event.timestamp, label: progress.phase ?? 'Progress', phase: progress.phase ?? '', message: progress.message ?? '', source: 'event' };
  }
  if (event.type === 'job.completed') return { timestamp: event.timestamp, label: terminalTimelineLabel(data.status ?? 'completed'), phase: data.status ?? 'completed', message: data.result?.outcome ?? '', source: 'event' };
  if (event.type === 'job.failed') return { timestamp: event.timestamp, label: 'Failed', phase: 'failed', message: data.errorKind ?? data.errorMessage ?? '', source: 'event' };
  if (event.type === 'job.interrupted') return { timestamp: event.timestamp, label: 'Interrupted', phase: 'interrupted', message: data.reason ?? '', source: 'event' };
  return null;
}

function mergePhaseTimeline(job, eventTimeline, logTimeline) {
  const byKey = new Map();
  for (const item of [...eventTimeline, ...logTimeline, ...fallbackJobTimeline(job)]) {
    if (!item?.timestamp) continue;
    const key = `${item.timestamp}:${item.label}:${item.phase ?? ''}:${item.source ?? ''}`;
    byKey.set(key, item);
  }
  return Array.from(byKey.values()).sort((left, right) => timestampMs(left.timestamp, 'timeline.left') - timestampMs(right.timestamp, 'timeline.right'));
}

function fallbackJobTimeline(job) {
  const timeline = [];
  if (job.queuedAt) timeline.push({ timestamp: job.queuedAt, label: 'Queued', phase: 'queued', message: '', source: 'snapshot' });
  if (job.startedAt) timeline.push({ timestamp: job.startedAt, label: 'Started', phase: 'started', message: '', source: 'snapshot' });
  if (job.finishedAt) timeline.push({ timestamp: job.finishedAt, label: terminalTimelineLabel(job.status), phase: job.status, message: job.errorKind || job.conclusion || '', source: 'snapshot' });
  return timeline;
}

function terminalTimelineLabel(status) {
  if (status === 'failed') return 'Failed';
  if (status === 'skipped') return 'Skipped';
  if (status === 'interrupted') return 'Interrupted';
  if (status === 'stale') return 'Skipped';
  return 'Completed';
}

function actualPortFromListener(listener) {
  const address = typeof listener?.address === 'function' ? listener.address() : null;
  return address && typeof address === 'object' && Number.isSafeInteger(address.port) ? address.port : null;
}

function normalizeLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer');
  return limit;
}

function normalizeOffset(offset) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset must be a non-negative safe integer');
  return offset;
}

function sanitizeRetentionOverrides(options) {
  const out = {};
  for (const key of ['jobLogRetentionDays', 'jobHistoryRetentionDays', 'statsRetentionDays', 'configAuditRetentionDays', 'jobLogMaxBytes', 'adminDataMaxBytes', 'retentionIntervalHours']) {
    if (options[key] == null) continue;
    out[key] = options[key];
  }
  return out;
}

function inferAdminDir(eventStore) {
  if (!eventStore?.filePath) return null;
  return path.dirname(path.dirname(eventStore.filePath));
}

function timestampMs(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new TypeError(`${name} must be a valid timestamp`);
  return ms;
}
