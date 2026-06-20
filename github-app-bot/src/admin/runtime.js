import fs from 'node:fs/promises';
import path from 'node:path';
import { isActiveStatus } from '../jobs/index.js';

export class AdminRuntime {
  constructor({ configManager, eventStore, queue, startedAt = new Date() } = {}) {
    this.configManager = configManager;
    this.eventStore = eventStore;
    this.queue = queue;
    this.startedAt = startedAt;
    this.replay = { jobs: [], degraded: false, corruptions: [], invalidEvents: [], truncatedTail: null };
    this.persistenceWarning = null;
    this.lastRetention = null;
  }

  async initialize() {
    if (this.configManager) await this.configManager.ensureStorageDir();
    if (this.eventStore) {
      try {
        this.replay = await this.eventStore.replay();
        await this.markInterruptedJobs();
      } catch (error) {
        this.persistenceWarning = error.message;
        console.error('admin event replay failed', error.stack || error.message);
      }
    }
  }

  async markInterruptedJobs() {
    const active = this.replay.jobs.filter(isActiveStatus);
    for (const job of active) {
      await this.eventStore.append({
        type: 'job.interrupted',
        jobId: job.id,
        data: { reason: 'process restarted before job completed' },
      });
    }
    if (active.length > 0) this.replay = await this.eventStore.replay();
  }

  queueSnapshot() {
    return this.queue ? this.queue.snapshot() : { running: null, queuedCount: 0, queued: [] };
  }

  jobs({ limit = 50 } = {}) {
    return this.replay.jobs.slice(0, limit).map(job => ({
      jobId: job.id,
      diagnosticId: job.diagnosticId,
      status: job.status,
      repo: job.repository,
      repository: job.repository,
      pullNumber: job.pullNumber,
      trigger: job.trigger,
      actor: job.actor,
      createdAt: job.queuedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      errorKind: job.errorKind,
    }));
  }

  dashboard() {
    const queue = this.queueSnapshot();
    const summary = summarizeJobs(this.replay.jobs, queue);
    return {
      summary,
      recentJobs: this.jobs({ limit: 20 }),
      diagnostics: this.diagnostics(),
    };
  }

  diagnostics() {
    const items = [];
    if (this.persistenceWarning) items.push({ level: 'warn', id: 'persistence', message: this.persistenceWarning });
    if (this.replay.degraded) items.push({ level: 'warn', id: 'events', message: 'Job event history is degraded.' });
    if (this.replay.truncatedTail) items.push({ level: 'info', id: 'events.tail', message: 'Ignored truncated final event line.' });
    return items;
  }

  async configSummary() {
    if (!this.configManager) return {};
    const state = await this.configManager.load();
    return { ...state.summary.values, ...state.summary.secrets, revision: state.revision, pendingRestart: state.pendingRestart };
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

function summarizeJobs(jobs, queue) {
  const summary = {
    queued: queue.queuedCount,
    running: queue.running ? 1 : 0,
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
