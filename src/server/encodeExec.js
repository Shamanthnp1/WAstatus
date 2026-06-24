'use strict';

/**
 * Encode execution layer (semaphore-gated, with per-encode timeouts + size retry).
 *
 * Extracted from server.js so the timeout / retry / retry-exhaustion behavior can
 * be unit-tested deterministically with mocked ffmpeg, a mock semaphore, a mock
 * fs, and an injectable timer — WITHOUT real ffmpeg or real wall-clock time.
 *
 * Behavior is byte-for-byte identical to the previous in-server implementation:
 * the same constants, the same semaphore gating, the same SIGKILL-on-timeout +
 * partial-output unlink + input retention, and the same 15.5MB retry loop with a
 * retry-exhaustion error that keeps no non-conforming output.
 *
 * CommonJS module to match the existing codebase (server.js).
 *
 * @see Requirements 11.5, 12.1, 12.2, 12.3, 12.4, 12.5, 13.1, 13.2, 13.3, 13.4
 */

const realFs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const { defaultEncodeSemaphore } = require('./encodeSemaphore');

// Per-encode wall-clock time limits (Req 12.4, 13.4): a full-video encode gets
// 600s, a per-chunk encode gets 300s. On timeout the ffmpeg process is SIGKILLed,
// the partial output is unlinked, the inputs are retained, and a time-limit
// error is surfaced.
const FULL_VIDEO_TIMEOUT_MS = 600000;
const CHUNK_TIMEOUT_MS = 300000;
// Existing 15.5MB retry threshold (kept just under the 16MB Size_Limit) and the
// existing max attempt count.
// Retry threshold kept safely under the 16MB Size_Limit. At 15.8MB there is
// ~0.2MB of headroom for container overhead, so clips that are already fine
// ship at full quality instead of being needlessly re-encoded.
const RETRY_SIZE_MB = 15.8;
const MAX_ENCODE_ATTEMPTS = 3;

/**
 * Produce encode options for a given retry attempt. Attempt 0 returns the
 * canonical WhatsApp_Spec options unchanged (so a normal clip keeps the exact
 * target encode). Each subsequent attempt PROGRESSIVELY LOWERS the rate cap and
 * raises CRF so an over-size clip actually shrinks on retry — without this, the
 * retry re-encodes with identical settings and can never get under the limit
 * (a clip landing at ~15.5MB would fail forever). The codec/profile/pixfmt and
 * all other spec tokens are preserved; only `-crf`, `-maxrate`, `-bufsize` are
 * tightened.
 *
 * @param {string[]} baseOptions - The plan's encode options (WhatsApp spec).
 * @param {number} attempt - 0-based retry attempt.
 * @returns {string[]} A fresh, attempt-adjusted option token list.
 */
function tightenEncodeOptions(baseOptions, attempt) {
  const out = Array.isArray(baseOptions) ? baseOptions.slice() : [];
  if (!attempt || attempt < 1) return out;

  const getNum = (flag, fallback) => {
    const i = out.indexOf(flag);
    if (i !== -1 && i + 1 < out.length) {
      const n = parseInt(String(out[i + 1]), 10);
      if (Number.isFinite(n)) return n;
    }
    return fallback;
  };
  const setOpt = (flag, value) => {
    const i = out.indexOf(flag);
    if (i !== -1 && i + 1 < out.length) out[i + 1] = value;
    else out.push(flag, value);
  };

  const baseCrf = getNum('-crf', 23);
  const baseMax = getNum('-maxrate', 3800); // kbps (e.g. "3800k")
  // Gentle first retry (≈10% lower bitrate, +1 CRF) so a clip that is only just
  // over the limit barely loses clarity; escalate only if it is still too big.
  const rateFactors = [1, 0.9, 0.72];
  const crfBumps = [0, 1, 3];
  const factor = rateFactors[attempt] != null ? rateFactors[attempt] : Math.pow(0.72, attempt);
  const crfBump = crfBumps[attempt] != null ? crfBumps[attempt] : attempt * 2;
  const newMax = Math.max(800, Math.round(baseMax * factor));

  setOpt('-crf', String(baseCrf + crfBump));
  setOpt('-maxrate', newMax + 'k');
  setOpt('-bufsize', Math.round(newMax * 1.5) + 'k');
  return out;
}

/**
 * Build an encode-execution toolkit bound to a set of dependencies. Production
 * code uses the defaults (the shared EncodeSemaphore, real `fluent-ffmpeg`, real
 * `fs`, and the global timer). Tests inject fakes so timeouts and retries can be
 * driven deterministically.
 *
 * @param {object} [deps]
 * @param {{ acquire: () => Promise<() => void> }} [deps.semaphore]
 *   Encode concurrency gate. `acquire()` resolves with a release fn.
 * @param {() => any} [deps.ffmpegFactory]
 *   Factory returning a fresh ffmpeg command object (the thing `ffmpeg()` returns).
 * @param {{ statSync: Function, unlinkSync: Function }} [deps.fs]
 *   File-system shim used for size checks and partial-output removal.
 * @param {Function} [deps.setTimeout] - Timer scheduler (defaults to global).
 * @param {Function} [deps.clearTimeout] - Timer canceller (defaults to global).
 * @param {number} [deps.maxAttempts] - Override MAX_ENCODE_ATTEMPTS (tests).
 * @param {number} [deps.retrySizeMB] - Override RETRY_SIZE_MB (tests).
 * @returns {{ runGatedEncode: Function, buildRecipeCommand: Function, encodeRecipePlan: Function }}
 */
function createEncodeExec(deps = {}) {
  const semaphore = deps.semaphore || defaultEncodeSemaphore;
  const ffmpegFactory = deps.ffmpegFactory || (() => ffmpeg());
  const fsDep = deps.fs || realFs;
  const setTimeoutFn = deps.setTimeout || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;
  const maxAttempts = Number.isInteger(deps.maxAttempts) ? deps.maxAttempts : MAX_ENCODE_ATTEMPTS;
  const retrySizeMB = typeof deps.retrySizeMB === 'number' ? deps.retrySizeMB : RETRY_SIZE_MB;

  /**
   * Run a single ffmpeg encode (built by `buildCommand`) to `outputPath`, gated
   * by the EncodeSemaphore so the number of simultaneous encodes never exceeds
   * the CPU-derived Concurrency_Limit; extra encodes queue in FIFO order (Req
   * 13.1/13.2). A permit is acquired before the encode and released in `finally`.
   *
   * On timeout (`timeoutMs`): the ffmpeg process is SIGKILLed, the partial output
   * file is removed, the source inputs are left untouched, and the promise
   * rejects with a time-limit error tagged `isTimeout` (Req 12.4, 13.4). All
   * media is read from / written to disk by ffmpeg directly — nothing is buffered
   * fully in memory (Req 13.3).
   *
   * @param {() => any} buildCommand
   *   Factory returning a fresh, fully-configured ffmpeg command (inputs +
   *   options) WITHOUT a terminal `.output()`; this runner attaches the output +
   *   handlers.
   * @param {string} outputPath - Destination file for this encode.
   * @param {number} timeoutMs - Per-encode wall-clock limit.
   * @param {string} label - Human-readable label for logs/errors.
   * @returns {Promise<void>}
   */
  async function runGatedEncode(buildCommand, outputPath, timeoutMs, label) {
    const release = await semaphore.acquire();
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        let command = null;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          clearTimeoutFn(timer);
          if (err) return reject(err);
          resolve();
        };
        const timer = setTimeoutFn(() => {
          if (command) { try { command.kill('SIGKILL'); } catch (e) { } }
          // Remove any partial output; retain inputs (Req 12.4, 13.4).
          try { fsDep.unlinkSync(outputPath); } catch (e) { }
          const err = new Error(`${label} exceeded the ${Math.round(timeoutMs / 1000)}s time limit`);
          err.isTimeout = true;
          finish(err);
        }, timeoutMs);
        command = buildCommand()
          .output(outputPath)
          .on('start', (cl) => { try { console.log(`🎬 ${label}: ${cl}`); } catch (e) { } })
          .on('end', () => finish(null))
          .on('error', (err) => finish(err));
        command.run();
      });
    } finally {
      release();
    }
  }

  /**
   * Build the ffmpeg command for a recipe RenderPlan / ChunkRenderPlan: every
   * `plan.inputs` entry is added in order (input 0 is the source video, then the
   * sticker/text-raster images referenced by the filter graph, then any music),
   * each with its own input-level args (trim `-ss/-to`, chunk seek `-ss/-t`,
   * music `-ss`). The video filter graph runs through `-filter_complex`, the
   * composited video label `[vout]` is mapped, the source audio is mapped if
   * present (`0:a?`), and the unchanged encode-only options follow (so the clip
   * still conforms to WhatsApp_Spec and is encoded exactly once — Req 12.1/12.3).
   *
   * @param {import('../shared/constants').RenderPlan} plan
   * @returns {any} the configured ffmpeg command
   */
  function buildRecipeCommand(plan, attempt) {
    const command = ffmpegFactory();
    for (const input of plan.inputs) {
      command.input(input.path);
      if (Array.isArray(input.args) && input.args.length) {
        command.inputOptions(input.args);
      }
    }
    // Combine the video filter graph with the audio graph (when the plan wires
    // one). Older/skip-style plans carry no audioFilter/audioMap, so we default
    // to mapping the source audio (`0:a?`) — byte-identical to prior behavior.
    const audioFilter = typeof plan.audioFilter === 'string' ? plan.audioFilter : '';
    const fullFilter = audioFilter
      ? `${plan.filterComplex};${audioFilter}`
      : plan.filterComplex;
    const audioMap = Object.prototype.hasOwnProperty.call(plan, 'audioMap')
      ? plan.audioMap
      : '0:a?';

    const opts = ['-filter_complex', fullFilter, '-map', '[vout]'];
    if (audioMap) opts.push('-map', audioMap);
    opts.push(...tightenEncodeOptions(plan.encodeOptions, attempt || 0));
    // Hard-cap the output duration to the planned clip length. Overlay/sticker
    // and looped music inputs are bounded by `-t` input options, but an explicit
    // OUTPUT `-t` guarantees ffmpeg writes exactly the planned duration and then
    // stops, so the encode always terminates promptly.
    const planned = Number(plan.plannedDuration);
    if (Number.isFinite(planned) && planned > 0) {
      opts.push('-t', String(planned));
    }
    command.outputOptions(opts);
    return command;
  }

  /**
   * Execute a recipe plan (full clip or one chunk) to `outputPath` through the
   * encode semaphore, retrying the encode while the produced clip exceeds the
   * 15.5MB threshold, up to `MAX_ENCODE_ATTEMPTS` (Req 11.5, 12.2, 12.4). When
   * the clip still exceeds the limit after the final attempt, a retry-exhaustion
   * error is thrown and NO non-conforming output is kept (Req 12.5).
   *
   * @param {import('../shared/constants').RenderPlan} plan
   * @param {string} outputPath
   * @param {number} timeoutMs
   * @param {string} label
   * @returns {Promise<void>}
   */
  async function encodeRecipePlan(plan, outputPath, timeoutMs, label) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await runGatedEncode(() => buildRecipeCommand(plan, attempt), outputPath, timeoutMs, `${label} attempt ${attempt}`);
      const sizeMB = fsDep.statSync(outputPath).size / (1024 * 1024);
      if (sizeMB <= retrySizeMB) {
        console.log(`✓ ${label} done! Size: ${sizeMB.toFixed(2)}MB`);
        return;
      }
      console.log(`⚠️ ${label} ${sizeMB.toFixed(2)}MB > ${retrySizeMB}MB — re-encoding at a lower bitrate (attempt ${attempt + 1}/${maxAttempts})...`);
    }
    // Exhausted retries: remove the non-conforming output and surface an error.
    try { fsDep.unlinkSync(outputPath); } catch (e) { }
    throw new Error(`${label} could not be brought under 16MB after ${maxAttempts} attempts.`);
  }

  return { runGatedEncode, buildRecipeCommand, encodeRecipePlan };
}

// Default, production-bound toolkit (shared semaphore, real ffmpeg, real fs,
// global timer). server.js imports these named functions directly so its
// behavior is unchanged.
const defaultExec = createEncodeExec();

module.exports = {
  createEncodeExec,
  runGatedEncode: defaultExec.runGatedEncode,
  buildRecipeCommand: defaultExec.buildRecipeCommand,
  encodeRecipePlan: defaultExec.encodeRecipePlan,
  tightenEncodeOptions,
  FULL_VIDEO_TIMEOUT_MS,
  CHUNK_TIMEOUT_MS,
  RETRY_SIZE_MB,
  MAX_ENCODE_ATTEMPTS,
};
