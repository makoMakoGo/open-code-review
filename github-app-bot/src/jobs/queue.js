import { createUuid, redactSensitiveString, sanitizeForAdminStorage, normalizeIsoTimestamp } from './utils.js';
import { PendingEventWriteError } from './event-store.js';

const COMPLETED_OUTCOMES = new Set(['succeeded', 'succeeded_with_warnings', 'skipped', 'stale']);

export class AdminJobQueue {
  constructor({ handler, store = null, logger = null, configProvider = null, startSnapshotProvider = null } = {}) {
    if (typeof handler !== 'function') throw new Error('job handler is required');
    if (startSnapshotProvider != null && typeof startSnapshotProvider !== 'function') throw new Error('startSnapshotProvider must be a function');
    this.handler = handler;
    this.store = store;
    this.logger = logger;
    this.configProvider = configProvider;
    this.startSnapshotProvider = startSnapshotProvider;
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
      startSnapshot: normalizeStartSnapshot(metadata.startSnapshot),
    };
    this.known.add(key);
    await this.#record('job.queued', job, {
      ...queueMetadata(job),
      queuedAt: job.queuedAt,
      progress: { phase: 'queued', message: 'Review job queued' },
      startSnapshot: job.startSnapshot,
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
        const flushed = await withTimeout(this.logger.flush(), timeoutMs);
        if (!flushed) this.#noteDiagnostic('job-log-flush', 'Timed out waiting for admin job log writes to flush', new Error(`timeout after ${timeoutMs}ms`));
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
        try {
          const startContext = await this.#startContext(job);
          this.runningJob.startSnapshot = startContext.startSnapshot;
          await this.#record('job.started', this.runningJob, {
            ...queueMetadata(this.runningJob),
            startedAt: this.runningJob.startedAt,
            progress: { phase: this.runningJob.phase, message: 'Authenticating GitHub App installation' },
            startSnapshot: this.runningJob.startSnapshot,
          });
          const result = await this.handler(job.payload, { job: this.runningJob, config: startContext.config, logger: jobLogger, signal: this.abortController.signal });
          if (this.stopping || this.abortController.signal.aborted) {
            await this.#recordInterrupted(this.runningJob, 'server shutting down');
            continue;
          }
          const status = result?.outcome ?? 'succeeded';
          if (status !== 'failed' && !COMPLETED_OUTCOMES.has(status)) {
            throw new TypeError(`job handler returned unsupported outcome: ${status}`);
          }
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
    } catch (error) {
      const job = this.runningJob;
      this.#noteDiagnostic('queue-drain', 'Queue drain cycle failed', error);
      if (job) {
        await this.#record('job.failed', job, {
          ...queueMetadata(job),
          finishedAt: new Date().toISOString(),
          errorKind: error?.kind ?? error?.name ?? 'Error',
          errorMessage: error?.message ?? String(error),
        });
        this.known.delete(job.key);
      }
      console.error('queue drain failed', safeErrorMessage(error));
    } finally {
      this.abortController = null;
      this.runningJob = null;
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
      console.error('admin job event persistence failed', safeErrorMessage(error));
      if (error instanceof PendingEventWriteError) return;
      throw error;
    }
  }

  #createJobLogger(job) {
    const write = async (level, message, fields = {}) => {
      if (!this.logger) {
        this.#clearDiagnostic('job-log-store');
        return;
      }
      try {
        await this.logger.append(job.jobId, { level, message, fields });
        this.#clearDiagnostic('job-log-store');
        await this.#record('job.log', job, { level, message });
      } catch (error) {
        this.#noteDiagnostic('job-log-store', 'Admin job log persistence failed', error, { affectsWritability: true });
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

  async #startContext(job) {
    const config = this.configProvider ? await this.configProvider() : undefined;
    const provided = this.startSnapshotProvider ? await this.startSnapshotProvider({ job: this.#publicJob(job), config }) : job.startSnapshot;
    return {
      config,
      startSnapshot: normalizeStartSnapshot(provided ?? job.startSnapshot),
    };
  }

  #noteDiagnostic(id, message, error, { affectsWritability = false } = {}) {
    const diagnostic = {
      id,
      level: 'warn',
      message,
      detail: safeErrorMessage(error),
      timestamp: new Date().toISOString(),
      affectsWritability,
    };
    this.diagnostics = [diagnostic, ...this.diagnostics.filter(item => item.id !== id)].slice(0, 10);
  }

  #clearDiagnostic(id) {
    this.diagnostics = this.diagnostics.filter(item => item.id !== id);
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
      startSnapshot: job.startSnapshot ?? null,
    };
  }
}

function normalizeStartSnapshot(value) {
  if (value == null) return null;
  const sanitized = sanitizeForAdminStorage(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return sanitized;
  if (sanitized.capturedAt == null) return { ...sanitized, capturedAt: new Date().toISOString() };
  return { ...sanitized, capturedAt: normalizeIsoTimestamp(sanitized.capturedAt, 'startSnapshot.capturedAt') };
}

function queueMetadata(job) {
  return {
    diagnosticId: job.diagnosticId,
    repository: job.owner && job.repo ? `${job.owner}/${job.repo}` : '',
    pullNumber: job.pullNumber,
    actor: job.actor,
    trigger: job.trigger,
    startSnapshot: job.startSnapshot ?? null,
    headSha: job.headSha ?? '',
    baseSha: job.baseSha ?? '',
    baseRef: job.baseRef ?? '',
  };
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  let timedOut = false;
  try {
    const result = await Promise.race([
      promise.then(
        () => true,
        error => {
          if (timedOut) {
            console.error('async operation failed after timeout', safeErrorMessage(error));
            return false;
          }
          throw error;
        },
      ),
      new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(false); }, timeoutMs); }),
    ]);
    return result;
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
