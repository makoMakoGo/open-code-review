import { createUuid } from './utils.js';

export class AdminJobQueue {
  constructor({ handler, store = null, logger = null, configProvider = null } = {}) {
    if (typeof handler !== 'function') throw new Error('job handler is required');
    this.handler = handler;
    this.store = store;
    this.logger = logger;
    this.configProvider = configProvider;
    this.runningJob = null;
    this.queuedJobs = [];
    this.known = new Set();
    this.draining = false;
    this.drainPromise = null;
  }

  async enqueue({ key, payload, metadata = {} }) {
    if (this.known.has(key)) return { queued: false, job: this.#publicJob(null) };
    const job = {
      jobId: createUuid(),
      key,
      payload,
      diagnosticId: metadata.diagnosticId ?? key,
      owner: metadata.owner ?? '',
      repo: metadata.repo ?? '',
      pullNumber: metadata.pullNumber ?? null,
      actor: metadata.actor ?? '',
      trigger: metadata.trigger ?? '',
      queuedAt: new Date().toISOString(),
      phase: 'queued',
    };
    this.known.add(key);
    await this.#record('job.queued', job, {
      diagnosticId: job.diagnosticId,
      repository: job.owner && job.repo ? `${job.owner}/${job.repo}` : '',
      pullNumber: job.pullNumber,
      actor: job.actor,
      trigger: job.trigger,
      queuedAt: job.queuedAt,
    });
    this.queuedJobs.push(job);
    this.drainPromise = this.drain();
    return { queued: true, job: this.#publicJob(job) };
  }

  snapshot() {
    return {
      running: this.#publicJob(this.runningJob),
      queuedCount: this.queuedJobs.length,
      queued: this.queuedJobs.map(job => this.#publicJob(job)),
    };
  }

  async drain() {
    if (this.draining) return this.drainPromise;
    this.draining = true;
    try {
      while (this.queuedJobs.length > 0) {
        const job = this.queuedJobs.shift();
        this.runningJob = { ...job, phase: 'running', startedAt: new Date().toISOString() };
        await this.#record('job.started', this.runningJob, { startedAt: this.runningJob.startedAt });
        try {
          const config = this.configProvider ? await this.configProvider() : undefined;
          const result = await this.handler(job.payload, { job: this.runningJob, config });
          const status = result?.outcome ?? 'succeeded';
          const eventType = status === 'failed' ? 'job.failed' : 'job.completed';
          await this.#record(eventType, this.runningJob, {
            ...queueMetadata(this.runningJob),
            status,
            finishedAt: new Date().toISOString(),
            result: result ?? null,
            errorKind: result?.failure?.kind,
            errorMessage: result?.failure?.reason,
          });
        } catch (error) {
          await this.#record('job.failed', this.runningJob, {
            finishedAt: new Date().toISOString(),
            errorKind: error?.kind ?? error?.name ?? 'Error',
            errorMessage: error?.message ?? String(error),
          });
          console.error('job failed', { key: job.key, error: error?.stack || error?.message || String(error) });
        } finally {
          this.known.delete(job.key);
          this.runningJob = null;
        }
      }
    } finally {
      this.draining = false;
      this.drainPromise = null;
    }
  }

  async #record(type, job, data) {
    if (!this.store) return;
    try {
      await this.store.append({ type, jobId: job.jobId, data });
    } catch (error) {
      console.error('admin job event persistence failed', error.stack || error.message);
    }
  }

  #publicJob(job) {
    if (!job) return null;
    return {
      jobId: job.jobId,
      diagnosticId: job.diagnosticId,
      owner: job.owner,
      repo: job.repo,
      pullNumber: job.pullNumber,
      actor: job.actor,
      trigger: job.trigger,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt ?? null,
      phase: job.phase,
    };
  }
}

function queueMetadata(job) {
  return {
    diagnosticId: job.diagnosticId,
    repository: job.owner && job.repo ? `${job.owner}/${job.repo}` : '',
    pullNumber: job.pullNumber,
    actor: job.actor,
    trigger: job.trigger,
  };
}
