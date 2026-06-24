'use strict';

/**
 * Cleanup_Process — per-request artifact ledger and bulletproof teardown.
 *
 * Every temporary item created for a request (original uploads, compressed
 * outputs, chunks, uploaded Music_Track files, and sticker assets) is registered
 * in a {@link RequestContext} ledger as either a local disk path or an R2 object
 * key. On success OR on any failure, {@link cleanupRequest} deletes every ledger
 * item from both stores, logs each per-item failure WITHOUT aborting, then lists
 * the request's R2 prefix and re-attempts deletion of any survivor.
 *
 * All side effects (disk I/O, R2 calls, logging) are injected through a `deps`
 * parameter so the routine is fully unit/property testable against mock stores
 * with no real R2 or filesystem. A {@link makeR2Deps} factory builds a `deps`
 * object from the real S3 client and `fs` for production use in server.js.
 *
 * On boot, {@link startupSweep} reclaims disk by deleting orphan temp files in
 * `uploads/`, `compressed/`, and `assets/` that are NOT owned by any active
 * in-progress request. Its directory listing, deletion, and logging side
 * effects are injected through a `deps` parameter (mirroring {@link makeR2Deps}),
 * and {@link makeSweepDeps} builds a production `deps` object from `fs`.
 *
 * CommonJS module to match the existing codebase (server.js).
 *
 * @see Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 15.6
 */

const path = require('path');

/**
 * Per-request artifact ledger.
 *
 * Holds the request id plus the set of every local path and every R2 key
 * created while processing the request. Registration is idempotent (backed by
 * Set) so the same artifact registered twice is cleaned up once.
 */
class RequestContext {
  /**
   * @param {string} requestId - Stable identifier for the request. Also used as
   *   the default R2 prefix when listing for survivors during verification.
   * @param {Object} [options]
   * @param {string} [options.prefix] - Explicit R2 prefix to list for survivors.
   *   Defaults to `requestId` when omitted.
   */
  constructor(requestId, options = {}) {
    if (requestId === undefined || requestId === null || `${requestId}` === '') {
      throw new Error('RequestContext requires a non-empty requestId');
    }
    /** @type {string} */
    this.requestId = `${requestId}`;
    /** @type {string} R2 prefix used to verify the request is empty after cleanup. */
    this.prefix = options.prefix !== undefined && options.prefix !== null
      ? `${options.prefix}`
      : this.requestId;
    /** @type {Set<string>} Every temporary local file/dir path created. */
    this.localPaths = new Set();
    /** @type {Set<string>} Every R2 object key created. */
    this.r2Keys = new Set();
  }

  /**
   * Register a local disk path (upload, output, chunk, music file, or sticker
   * asset) for cleanup. No-op for empty values.
   * @param {string} localPath
   * @returns {this}
   */
  addLocalPath(localPath) {
    if (localPath !== undefined && localPath !== null && `${localPath}` !== '') {
      this.localPaths.add(`${localPath}`);
    }
    return this;
  }

  /**
   * Register an R2 object key (output, chunk, music file, or sticker asset) for
   * cleanup. No-op for empty values.
   * @param {string} r2Key
   * @returns {this}
   */
  addR2Key(r2Key) {
    if (r2Key !== undefined && r2Key !== null && `${r2Key}` !== '') {
      this.r2Keys.add(`${r2Key}`);
    }
    return this;
  }

  /**
   * Register many local paths at once.
   * @param {Iterable<string>} paths
   * @returns {this}
   */
  addLocalPaths(paths) {
    if (paths) {
      for (const p of paths) {
        this.addLocalPath(p);
      }
    }
    return this;
  }

  /**
   * Register many R2 keys at once.
   * @param {Iterable<string>} keys
   * @returns {this}
   */
  addR2Keys(keys) {
    if (keys) {
      for (const k of keys) {
        this.addR2Key(k);
      }
    }
    return this;
  }
}

/**
 * @typedef {Object} CleanupDeps
 * @property {(localPath: string) => (Promise<void>|void)} deleteLocalPath
 *   Delete one local file/dir. SHOULD treat an already-absent path as success.
 * @property {(key: string) => (Promise<void>|void)} deleteR2Key
 *   Delete one R2 object by key.
 * @property {(prefix: string) => (Promise<string[]>|string[])} listR2Keys
 *   List the keys currently present under the given R2 prefix.
 * @property {Object} [logger] - Logger with `error`/`warn`/`info` (defaults to console).
 */

/**
 * @typedef {Object} CleanupItemFailure
 * @property {string} item - The local path or R2 key that failed to delete.
 * @property {string} reason - The failure reason message.
 */

/**
 * @typedef {Object} CleanupResult
 * @property {string} requestId
 * @property {string[]} localDeleted - Local paths successfully deleted.
 * @property {CleanupItemFailure[]} localFailures - Local deletions that failed.
 * @property {string[]} r2Deleted - R2 keys successfully deleted (first pass).
 * @property {CleanupItemFailure[]} r2Failures - R2 deletions that failed (first pass).
 * @property {string[]} survivors - Keys still present in R2 after the first pass.
 * @property {string[]} reattempted - Survivor keys re-attempted in the second pass.
 * @property {string[]} remaining - Keys STILL present after the re-attempt (logged orphans).
 * @property {boolean} verified - True when the request prefix is confirmed empty in R2.
 */

/**
 * Build a safe logger that never throws even if the provided logger is partial.
 * @param {Object} [logger]
 * @returns {{ error: Function, warn: Function, info: Function }}
 * @private
 */
function safeLogger(logger) {
  const base = logger || console;
  const pick = (name) =>
    (typeof base[name] === 'function'
      ? base[name].bind(base)
      : (typeof base.log === 'function' ? base.log.bind(base) : () => {}));
  return { error: pick('error'), warn: pick('warn'), info: pick('info') };
}

/**
 * Attempt a single deletion, capturing success/failure without throwing.
 * @param {(item: string) => (Promise<void>|void)} fn
 * @param {string} item
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 * @private
 */
async function tryDelete(fn, item) {
  try {
    await fn(item);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err && err.message) ? err.message : String(err) };
  }
}

/**
 * Delete every artifact registered in `ctx` from both local disk and R2, then
 * verify the request's R2 prefix is empty and re-attempt any survivor.
 *
 * Resilience contract (Req 14.6): a failure deleting one item NEVER prevents the
 * deletion of others. Each failure is logged with the item identifier and reason,
 * and cleanup continues. The function does not throw for individual item
 * failures; it resolves with a structured {@link CleanupResult} summary.
 *
 * Verification contract (Req 14.7/14.8): after the per-item pass, the request's
 * R2 prefix is listed; any survivor is logged as an orphan and its deletion is
 * re-attempted. A final list confirms whether the prefix is empty.
 *
 * @param {RequestContext} ctx - The request artifact ledger.
 * @param {CleanupDeps} deps - Injected disk/R2/logger dependencies.
 * @returns {Promise<CleanupResult>}
 */
async function cleanupRequest(ctx, deps) {
  if (!ctx || !(ctx.localPaths instanceof Set) || !(ctx.r2Keys instanceof Set)) {
    throw new Error('cleanupRequest requires a RequestContext with localPaths and r2Keys sets');
  }
  if (!deps || typeof deps.deleteLocalPath !== 'function'
    || typeof deps.deleteR2Key !== 'function'
    || typeof deps.listR2Keys !== 'function') {
    throw new Error('cleanupRequest requires deps.deleteLocalPath, deps.deleteR2Key, and deps.listR2Keys');
  }

  const log = safeLogger(deps.logger);

  /** @type {CleanupResult} */
  const result = {
    requestId: ctx.requestId,
    localDeleted: [],
    localFailures: [],
    r2Deleted: [],
    r2Failures: [],
    survivors: [],
    reattempted: [],
    remaining: [],
    verified: false,
  };

  // --- Pass 1: delete every local path; log + continue on failure. ----------
  for (const localPath of ctx.localPaths) {
    const outcome = await tryDelete(deps.deleteLocalPath, localPath);
    if (outcome.ok) {
      result.localDeleted.push(localPath);
    } else {
      result.localFailures.push({ item: localPath, reason: outcome.reason });
      log.error(
        `[cleanup ${ctx.requestId}] failed to delete local path "${localPath}": ${outcome.reason}`
      );
    }
  }

  // --- Pass 1: delete every R2 key; log + continue on failure. --------------
  for (const key of ctx.r2Keys) {
    const outcome = await tryDelete(deps.deleteR2Key, key);
    if (outcome.ok) {
      result.r2Deleted.push(key);
    } else {
      result.r2Failures.push({ item: key, reason: outcome.reason });
      log.error(
        `[cleanup ${ctx.requestId}] failed to delete R2 object "${key}": ${outcome.reason}`
      );
    }
  }

  // --- Verify the request prefix is empty in R2 (Req 14.7). -----------------
  let survivors = [];
  try {
    const listed = await deps.listR2Keys(ctx.prefix);
    survivors = Array.isArray(listed) ? listed.filter((k) => k !== undefined && k !== null) : [];
  } catch (err) {
    const reason = (err && err.message) ? err.message : String(err);
    log.error(`[cleanup ${ctx.requestId}] failed to list R2 prefix "${ctx.prefix}": ${reason}`);
    // Cannot verify; report what we know and exit without claiming verification.
    result.verified = false;
    return result;
  }
  result.survivors = survivors.slice();

  // --- Pass 2: re-attempt deletion of any survivor (Req 14.8). --------------
  for (const key of survivors) {
    log.warn(`[cleanup ${ctx.requestId}] orphaned R2 object detected after cleanup: "${key}"`);
    result.reattempted.push(key);
    const outcome = await tryDelete(deps.deleteR2Key, key);
    if (!outcome.ok) {
      log.error(
        `[cleanup ${ctx.requestId}] re-attempt failed for orphaned R2 object "${key}": ${outcome.reason}`
      );
    }
  }

  // --- Final verification list. ---------------------------------------------
  if (survivors.length === 0) {
    result.verified = true;
    return result;
  }

  try {
    const listedAfter = await deps.listR2Keys(ctx.prefix);
    const remaining = Array.isArray(listedAfter)
      ? listedAfter.filter((k) => k !== undefined && k !== null)
      : [];
    result.remaining = remaining.slice();
    result.verified = remaining.length === 0;
    for (const key of remaining) {
      log.error(
        `[cleanup ${ctx.requestId}] R2 object still present after re-attempt: "${key}"`
      );
    }
  } catch (err) {
    const reason = (err && err.message) ? err.message : String(err);
    log.error(`[cleanup ${ctx.requestId}] failed to re-verify R2 prefix "${ctx.prefix}": ${reason}`);
    result.verified = false;
  }

  return result;
}

/**
 * Build a production {@link CleanupDeps} from the real R2/S3 client and `fs`.
 *
 * - Local deletions use `fs.promises.rm` with `force` (so an already-absent
 *   path resolves successfully — idempotent) and `recursive` (so registered
 *   directories are removed too).
 * - R2 deletions/listing use the injected S3 client and command constructors,
 *   keeping this module free of a hard `@aws-sdk` dependency for testing.
 *
 * @param {Object} args
 * @param {Object} args.r2Client - An S3 client exposing `.send(command)`.
 * @param {string} args.bucket - The R2 bucket name.
 * @param {Function} args.DeleteObjectCommand - `@aws-sdk/client-s3` DeleteObjectCommand.
 * @param {Function} args.ListObjectsV2Command - `@aws-sdk/client-s3` ListObjectsV2Command.
 * @param {Object} args.fs - The `fs` module (uses `fs.promises.rm`).
 * @param {Object} [args.logger] - Logger (defaults to console).
 * @returns {CleanupDeps}
 */
function makeR2Deps({ r2Client, bucket, DeleteObjectCommand, ListObjectsV2Command, fs, logger }) {
  if (!r2Client || typeof r2Client.send !== 'function') {
    throw new Error('makeR2Deps requires an r2Client with a send() method');
  }
  if (!bucket) {
    throw new Error('makeR2Deps requires a bucket name');
  }
  if (typeof DeleteObjectCommand !== 'function' || typeof ListObjectsV2Command !== 'function') {
    throw new Error('makeR2Deps requires DeleteObjectCommand and ListObjectsV2Command');
  }
  if (!fs || !fs.promises || typeof fs.promises.rm !== 'function') {
    throw new Error('makeR2Deps requires the fs module with promises.rm');
  }

  return {
    async deleteLocalPath(localPath) {
      // force: treat missing as success; recursive: remove dirs too.
      await fs.promises.rm(localPath, { force: true, recursive: true });
    },
    async deleteR2Key(key) {
      await r2Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async listR2Keys(prefix) {
      const keys = [];
      let continuationToken;
      do {
        const resp = await r2Client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }));
        const contents = (resp && resp.Contents) || [];
        for (const obj of contents) {
          if (obj && obj.Key) {
            keys.push(obj.Key);
          }
        }
        continuationToken = resp && resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },
    logger: logger || console,
  };
}

/**
 * @typedef {Object} SweepDeps
 * @property {(directory: string) => (Promise<string[]>|string[])} listDir
 *   List the temp files in one directory, returned as paths. Each returned
 *   value is compared (after {@link SweepDeps.normalize}) against the active
 *   path set to decide retain-vs-delete. SHOULD treat a missing directory as
 *   an empty listing (production factory does).
 * @property {(localPath: string) => (Promise<void>|void)} deleteLocalPath
 *   Delete one orphan file/dir. SHOULD treat an already-absent path as success.
 * @property {(value: string) => string} [normalize] - Canonicalize a path so a
 *   listed file and a registered active path compare equal regardless of
 *   separator/relative form (defaults to identity; production uses `path.resolve`).
 * @property {string[]} [directories] - Directories to sweep
 *   (defaults to `['uploads', 'compressed', 'assets']`).
 * @property {Object} [logger] - Logger with `error`/`warn`/`info` (defaults to console).
 */

/**
 * @typedef {Object} SweepResult
 * @property {string[]} scanned - Every file path discovered across all directories.
 * @property {string[]} deleted - Orphan paths successfully deleted.
 * @property {string[]} retained - Paths kept because they belong to an active request.
 * @property {CleanupItemFailure[]} failures - Deletions that failed (logged, non-fatal).
 */

/**
 * The directories the {@link startupSweep} scans for orphan temp files by default.
 * @type {string[]}
 */
const DEFAULT_SWEEP_DIRECTORIES = ['uploads', 'compressed', 'assets'];

/**
 * Build the set of local paths that belong to active in-progress requests.
 *
 * `activeRequests` is an iterable whose entries are EITHER:
 *  - a {@link RequestContext}-like object exposing an iterable `localPaths`
 *    (every registered temp path is protected), OR
 *  - a plain string path that is protected directly.
 *
 * Each protected path is canonicalized with `normalize` so it compares equal to
 * the (possibly differently-formatted) paths produced by `listDir`.
 *
 * @param {Iterable<RequestContext|string>} [activeRequests]
 * @param {(value: string) => string} normalize
 * @returns {Set<string>}
 * @private
 */
function collectActivePaths(activeRequests, normalize) {
  const active = new Set();
  if (!activeRequests) {
    return active;
  }
  for (const entry of activeRequests) {
    if (entry === undefined || entry === null) {
      continue;
    }
    if (typeof entry === 'string') {
      if (entry !== '') {
        active.add(normalize(entry));
      }
      continue;
    }
    // RequestContext-like: protect every registered local path.
    const localPaths = entry.localPaths;
    if (localPaths && typeof localPaths[Symbol.iterator] === 'function') {
      for (const p of localPaths) {
        if (p !== undefined && p !== null && `${p}` !== '') {
          active.add(normalize(`${p}`));
        }
      }
    }
  }
  return active;
}

/**
 * Reclaim disk on boot by deleting orphan temp files that are NOT owned by any
 * active in-progress request (Req 14.5).
 *
 * Association contract: a listed file is RETAINED when its normalized path is
 * registered by an active request (via {@link collectActivePaths}); otherwise
 * it is an orphan and is DELETED. This is exact, normalized path matching, so
 * the sweep deletes exactly the orphans and never a file tied to live work
 * (Property 24).
 *
 * Resilience: a failure listing one directory or deleting one file is logged
 * and never aborts the sweep; the routine resolves with a {@link SweepResult}.
 *
 * @param {Iterable<RequestContext|string>} activeRequests - Paths/contexts owned
 *   by in-progress requests. May be empty/`null` (then every temp file is an orphan).
 * @param {SweepDeps} deps - Injected listing/deletion/logger dependencies.
 * @returns {Promise<SweepResult>}
 */
async function startupSweep(activeRequests, deps) {
  if (!deps || typeof deps.listDir !== 'function' || typeof deps.deleteLocalPath !== 'function') {
    throw new Error('startupSweep requires deps.listDir and deps.deleteLocalPath');
  }

  const log = safeLogger(deps.logger);
  const normalize = typeof deps.normalize === 'function'
    ? deps.normalize
    : (value) => `${value}`;
  const directories = Array.isArray(deps.directories) && deps.directories.length > 0
    ? deps.directories
    : DEFAULT_SWEEP_DIRECTORIES;

  const active = collectActivePaths(activeRequests, normalize);

  /** @type {SweepResult} */
  const result = { scanned: [], deleted: [], retained: [], failures: [] };

  for (const directory of directories) {
    let entries;
    try {
      const listed = await deps.listDir(directory);
      entries = Array.isArray(listed) ? listed : [];
    } catch (err) {
      const reason = (err && err.message) ? err.message : String(err);
      log.error(`[startupSweep] failed to list directory "${directory}": ${reason}`);
      continue;
    }

    for (const entry of entries) {
      if (entry === undefined || entry === null || `${entry}` === '') {
        continue;
      }
      const filePath = `${entry}`;
      result.scanned.push(filePath);

      if (active.has(normalize(filePath))) {
        result.retained.push(filePath);
        continue;
      }

      const outcome = await tryDelete(deps.deleteLocalPath, filePath);
      if (outcome.ok) {
        result.deleted.push(filePath);
      } else {
        result.failures.push({ item: filePath, reason: outcome.reason });
        log.error(`[startupSweep] failed to delete orphan "${filePath}": ${outcome.reason}`);
      }
    }
  }

  return result;
}

/**
 * Build a production {@link SweepDeps} from `fs` for use on server boot.
 *
 * - `listDir` reads each directory with `fs.promises.readdir` and returns the
 *   absolute path of every entry; a missing directory (`ENOENT`) lists as empty.
 * - `deleteLocalPath` uses `fs.promises.rm` with `force` (already-absent ⇒ success)
 *   and `recursive` (removes a registered directory too), matching {@link makeR2Deps}.
 * - `normalize` uses `path.resolve` so registered paths and listed paths compare
 *   equal regardless of how they were originally written.
 *
 * @param {Object} args
 * @param {Object} args.fs - The `fs` module (uses `fs.promises.readdir`/`rm`).
 * @param {string} [args.baseDir] - Base directory the sweep dirs resolve against
 *   (defaults to `process.cwd()`).
 * @param {string[]} [args.directories] - Directories to sweep (defaults to
 *   `uploads`, `compressed`, `assets` under `baseDir`).
 * @param {Object} [args.logger] - Logger (defaults to console).
 * @returns {SweepDeps}
 */
function makeSweepDeps({ fs, baseDir, directories, logger } = {}) {
  if (!fs || !fs.promises || typeof fs.promises.readdir !== 'function' || typeof fs.promises.rm !== 'function') {
    throw new Error('makeSweepDeps requires the fs module with promises.readdir and promises.rm');
  }

  const root = baseDir !== undefined && baseDir !== null && `${baseDir}` !== ''
    ? `${baseDir}`
    : process.cwd();
  const dirList = Array.isArray(directories) && directories.length > 0
    ? directories
    : DEFAULT_SWEEP_DIRECTORIES;
  const resolvedDirectories = dirList.map((dir) => path.resolve(root, dir));

  return {
    directories: resolvedDirectories,
    normalize: (value) => path.resolve(`${value}`),
    async listDir(directory) {
      let names;
      try {
        names = await fs.promises.readdir(directory);
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          return [];
        }
        throw err;
      }
      return names.map((name) => path.join(directory, name));
    },
    async deleteLocalPath(localPath) {
      await fs.promises.rm(localPath, { force: true, recursive: true });
    },
    logger: logger || console,
  };
}

module.exports = {
  RequestContext,
  cleanupRequest,
  makeR2Deps,
  startupSweep,
  makeSweepDeps,
  DEFAULT_SWEEP_DIRECTORIES,
};
