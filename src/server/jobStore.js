'use strict';

/**
 * In-memory store for background processing jobs.
 *
 * Why this exists: /api/process used to hold ONE HTTP request open for the whole
 * encode. That broke in three separate ways:
 *
 *   1. Azure App Service kills any request at ~240s (Linux), so long videos
 *      failed even though the server finished the work.
 *   2. Mobile browsers suspend backgrounded tabs — switching apps mid-compress
 *      killed the in-flight fetch and surfaced "Failed to fetch".
 *   3. Any flaky network dropped the activation code the user was waiting for.
 *
 * In every case the server completed the job and uploaded to R2, but the client
 * never learned the activation code. Returning a job id immediately and letting
 * the client poll decouples "work finished" from "client currently connected".
 *
 * In-memory is deliberate and matches the existing `sessions` map: the process is
 * single-instance (Baileys requires that), and a restart loses in-flight jobs the
 * same way it already loses sessions. The R2 orphan sweep reclaims their files.
 */

/** How long a finished job stays readable before being swept. */
const JOB_TTL_MS = 30 * 60 * 1000;

class JobStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs=1800000] retention after completion
   * @param {() => number} [opts.now=Date.now] injectable clock for tests
   * @param {() => string} [opts.genId] injectable id generator for tests
   */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs != null ? opts.ttlMs : JOB_TTL_MS;
    this.now = opts.now || Date.now;
    this.genId = opts.genId || (() => require('crypto').randomUUID());
    /** @type {Map<string, {status: string, result: any, error: any, httpStatus: number|null, createdAt: number, finishedAt: number|null}>} */
    this.jobs = new Map();
  }

  /**
   * Register a new job in the `processing` state.
   * @returns {string} job id
   */
  create() {
    const id = this.genId();
    this.jobs.set(id, {
      status: 'processing',
      result: null,
      error: null,
      httpStatus: null,
      createdAt: this.now(),
      finishedAt: null,
    });
    return id;
  }

  /**
   * Mark a job successful. Ignored if the job is unknown or already finished, so
   * a late duplicate completion can't overwrite a result.
   * @param {string} id
   * @param {any} result body the client would have received
   */
  resolve(id, result) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'processing') return;
    job.status = 'done';
    job.result = result;
    job.finishedAt = this.now();
  }

  /**
   * Mark a job failed, preserving the HTTP status the sync path would have used
   * (400 for validation, 422 for render failure, 500 otherwise).
   * @param {string} id
   * @param {number} httpStatus
   * @param {any} error body describing the failure
   */
  reject(id, httpStatus, error) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'processing') return;
    job.status = 'error';
    job.error = error;
    job.httpStatus = httpStatus;
    job.finishedAt = this.now();
  }

  /**
   * Read a job's public state. Sweeps expired jobs first so a stale id reads as
   * missing rather than returning long-dead data.
   * @param {string} id
   * @returns {{status: string, result?: any, error?: any, httpStatus?: number|null}|null}
   */
  get(id) {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'processing') return { status: 'processing' };
    if (job.status === 'done') return { status: 'done', result: job.result };
    return { status: 'error', error: job.error, httpStatus: job.httpStatus };
  }

  /**
   * Drop finished jobs past their TTL. Jobs still `processing` are never swept —
   * a slow encode must not be discarded out from under the client.
   * @returns {number} how many were removed
   */
  sweep() {
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (job.finishedAt !== null && job.finishedAt < cutoff) {
        this.jobs.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get size() {
    return this.jobs.size;
  }
}

module.exports = { JobStore, JOB_TTL_MS };
