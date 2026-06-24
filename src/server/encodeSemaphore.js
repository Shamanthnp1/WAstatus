'use strict';

/**
 * EncodeSemaphore
 *
 * A CPU-aware concurrency gate for ffmpeg encode operations. Every encode
 * (per-video and per-chunk) acquires a permit before running and releases it
 * when done. The number of simultaneously in-progress operations never exceeds
 * `permits`; additional work waits in FIFO order and starts only when an
 * in-progress operation releases its permit.
 *
 * Replaces the hardcoded `BATCH_SIZE` ladder and the unbounded `Promise.all`
 * fan-out in the existing pipeline.
 *
 * CommonJS module to match the existing codebase (server.js).
 *
 * @see Requirements 13.1, 13.2
 */

const os = require('os');

/**
 * Compute the default permit count from the host CPU core count, with a
 * floor of 1 and no hardcoded batch size.
 *
 * @returns {number} max(1, os.cpus().length)
 */
function defaultPermits() {
  let cpuCount = 0;
  try {
    const cpus = os.cpus();
    cpuCount = Array.isArray(cpus) ? cpus.length : 0;
  } catch (_err) {
    cpuCount = 0;
  }
  return Math.max(1, cpuCount);
}

class EncodeSemaphore {
  /**
   * @param {number} [permits] - Maximum simultaneous encodes. Defaults to
   *   `max(1, os.cpus().length)` when not provided. Any provided value is
   *   coerced to an integer of at least 1.
   */
  constructor(permits) {
    let resolved;
    if (permits === undefined || permits === null) {
      resolved = defaultPermits();
    } else {
      const n = Math.floor(Number(permits));
      resolved = Number.isFinite(n) ? Math.max(1, n) : defaultPermits();
    }

    /** @type {number} Total number of permits. */
    this.permits = resolved;
    /** @type {number} Permits currently held by in-progress operations. */
    this._inProgress = 0;
    /** @type {Array<(release: () => void) => void>} FIFO queue of waiters. */
    this._queue = [];
  }

  /**
   * Number of operations currently in progress (holding a permit).
   * @returns {number}
   */
  get inProgress() {
    return this._inProgress;
  }

  /**
   * Number of operations currently waiting for a permit.
   * @returns {number}
   */
  get queued() {
    return this._queue.length;
  }

  /**
   * Acquire a permit. Resolves with a release function once a permit is
   * available. When all permits are in use, the request is queued and resolved
   * in FIFO order as in-progress operations release their permits.
   *
   * The returned release function is idempotent: calling it more than once has
   * no additional effect and never over-releases a permit.
   *
   * @returns {Promise<() => void>} resolves with the release function
   */
  acquire() {
    return new Promise((resolve) => {
      const grant = () => {
        this._inProgress += 1;
        resolve(this._makeRelease());
      };

      if (this._inProgress < this.permits) {
        grant();
      } else {
        this._queue.push(grant);
      }
    });
  }

  /**
   * Build an idempotent release function bound to a single granted permit.
   * @returns {() => void}
   * @private
   */
  _makeRelease() {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this._inProgress -= 1;
      this._drain();
    };
  }

  /**
   * Start the next queued waiter, if any, while a permit is free.
   * @private
   */
  _drain() {
    if (this._queue.length > 0 && this._inProgress < this.permits) {
      const next = this._queue.shift();
      next();
    }
  }
}

/**
 * A process-wide default semaphore sized to the host CPU count. Import this to
 * gate every ffmpeg invocation through a single shared limit.
 * @type {EncodeSemaphore}
 */
const defaultEncodeSemaphore = new EncodeSemaphore();

module.exports = {
  EncodeSemaphore,
  defaultEncodeSemaphore,
  defaultPermits,
};
