import { createUuid, redactSensitiveString, sanitizeForAdminStorage } from './utils.js';

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
    this.stopping = false;
    this.abortController = null;
    this.diagnostics = [];
  }

  async enqueue({ key, payload, metadata = {} }) {
    if (this.stopping) return { queued: false, job: null, stopped: true };
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
      ...queueMetadata(job),
      queuedAt: job.queuedAt,
      progress: { phase: 'queued', message: 'Review job queued' },
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
      accepting: !this.stopping,
      diagnostics: this.diagnostics.slice(),
    };
  }

  stop({ abortActive = true } = {}) {
    if (this.stopping) return;
    this.stopping = true;
    for (const job of this.queuedJobs) this.known.delete(job.key);
    this.queuedJobs = [];
    if (abortActive && this.abortController) this.abortController.abort(new Error('server shutting down'));
  }

  async shutdown({ timeoutMs = 30_000 } = {}) {
    this.stop();
    const drain = this.drainPromise;
    if (drain) {
      const completed = await withTimeout(drain, timeoutMs);
      if (!completed) this.#noteDiagnostic('queue-shutdown', 'Timed out waiting for active review job to stop', new Error(`timeout after ${timeoutMs}ms`));
    }
    if (typeof this.logger?.flush === 'function') {
      try {
        await this.logger.flush();
      } catch (error) {
        this.#noteDiagnostic('job-log-flush', 'Admin job log flush failed', error);
      }
    }
  }

  async drain() {
    if (this.draining) return this.drainPromise;
    this.draining = true;
    try {
      while (!this.stopping && this.queuedJobs.length > 0) {
        const job = this.queuedJobs.shift();
        this.abortController = new AbortController();
        this.runningJob = { ...job, phase: 'github_auth', startedAt: new Date().toISOString() };
        const jobLogger = this.#createJobLogger(this.runningJob);
        await this.#record('job.started', this.runningJob, {
          ...queueMetadata(this.runningJob),
          startedAt: this.runningJob.startedAt,
          progress: { phase: this.runningJob.phase, message: 'Authenticating GitHub App installation' },
        });
        try {
          const config = this.configProvider ? await this.configProvider() : undefined;
          const result = await this.handler(job.payload, { job: this.runningJob, config, logger: jobLogger, signal: this.abortController.signal });
          if (this.stopping || this.abortController.signal.aborted) {
            await this.#recordInterrupted(this.runningJob, 'server shutting down');
            continue;
          }
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
          if (this.stopping || this.abortController.signal.aborted) {
            const reason = error?.message ?? String(error);
            await jobLogger.warn('Review job interrupted by shutdown', { error: reason });
            await this.#recordInterrupted(this.runningJob, reason);
            continue;
          }
          await this.#record('job.failed', this.runningJob, {
            ...queueMetadata(this.runningJob),
            finishedAt: new Date().toISOString(),
            errorKind: error?.kind ?? error?.name ?? 'Error',
            errorMessage: error?.message ?? String(error),
          });
          console.error('job failed', sanitizeForConsole({ key: job.key, error: error?.stack || error?.message || String(error) }));
        } finally {
          this.known.delete(job.key);
          this.abortController = null;
          this.runningJob = null;
        }
      }
    } finally {
      this.draining = false;
      this.drainPromise = null;
    }
  }

  async #recordInterrupted(job, reason) {
    await this.#record('job.interrupted', job, {
      ...queueMetadata(job),
      finishedAt: new Date().toISOString(),
      reason,
    });
  }

  async #record(type, job, data) {
    if (!this.store) return;
    try {
      await this.store.append({ type, jobId: job.jobId, data });
    } catch (error) {
      this.#noteDiagnostic('job-event-store', 'Admin job event persistence failed', error);
      console.error('admin job event persistence failed', safeErrorMessage(error));
    }
  }

  #createJobLogger(job) {
    const write = async (level, message, fields = {}) => {
      if (!this.logger) return;
      try {
        await this.logger.append(job.jobId, { level, message, fields });
        await this.#record('job.log', job, { level, message });
      } catch (error) {
        this.#noteDiagnostic('job-log-store', 'Admin job log persistence failed', error);
        console.error('admin job log persistence failed', safeErrorMessage(error));
      }
    };
    return {
      log: write,
      debug: (message, fields) => write('debug', message, fields),
      info: (message, fields) => write('info', message, fields),
      warn: (message, fields) => write('warn', message, fields),
      error: (message, fields) => write('error', message, fields),
      phase: async (phase, message = '', fields = {}) => {
        job.phase = phase;
        await this.#record('job.progress', job, {
          ...queueMetadata(job),
          progress: { phase, message, ...fields },
        });
        await write('info', message || `Phase changed to ${phase}`, { phase, ...fields });
      },
    };
  }

  #noteDiagnostic(id, message, error) {
    const diagnostic = {
      id,
      level: 'warn',
      message,
      detail: safeErrorMessage(error),
      timestamp: new Date().toISOString(),
    };
    this.diagnostics = [diagnostic, ...this.diagnostics.filter(item => item.id !== id)].slice(0, 10);
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

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function safeErrorMessage(error) {
  return redactSensitiveString(error?.stack || error?.message || String(error));
}

function sanitizeForConsole(value) {
  return sanitizeForAdminStorage(value, { maxStringLength: 2048, maxDepth: 4 });
}
