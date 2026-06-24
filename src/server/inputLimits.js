'use strict';

/**
 * Input-limit gate for the StatusDrop /api/process pipeline.
 *
 * This is a PURE, side-effect-free function that runs BEFORE any download or
 * encode operation. It enforces the supported-input limits from
 * `src/shared/constants.js` (INPUT_LIMITS) so the server never starts an
 * expensive encode for inputs that exceed the limits.
 *
 * Limits enforced (Requirements 1.6, 13.5, 13.6):
 *   - MAX_VIDEOS (3): when more than 3 videos are supplied, the FIRST 3 in
 *     upload order are the retained set and the surplus is rejected. The gate
 *     returns an error indication that the maximum of 3 was exceeded.
 *   - MAX_TOTAL_VIDEO_BYTES (300 MB): the combined size of the retained videos
 *     must not exceed 300 MB.
 *   - MAX_AUDIO_BYTES (20 MB): any single video's added audio must not exceed
 *     20 MB. Added-audio size is supplied by the caller via an accessor (the
 *     recipe/music asset size), since that information is not always present in
 *     the request body yet.
 *
 * CommonJS module to match the existing codebase (server.js).
 */

const { INPUT_LIMITS } = require('../shared/constants');

/**
 * @typedef {Object} InputFile
 * @property {string} [key] - Upload key identifying the video.
 * @property {string} [originalName] - Original file name (for messages).
 * @property {number} [size] - Video size in bytes.
 */

/**
 * @typedef {Object} EnforceInputLimitsOptions
 * @property {typeof INPUT_LIMITS} [limits] - Override the default limits (testing).
 * @property {(file: InputFile, index: number) => (number|undefined|null)} [getAudioBytes]
 *   - Accessor returning the added-audio byte size for a given video, or a
 *     non-finite value / undefined when the video has no added audio. This is
 *     the contract by which per-video audio size (e.g. the recipe's Music_Track
 *     asset size) is supplied to the gate without coupling it to the request
 *     shape.
 */

/**
 * @typedef {Object} EnforceInputLimitsResult
 * @property {boolean} ok - True when all limits are satisfied.
 * @property {InputFile[]} retained - The videos that would be processed: the
 *   first MAX_VIDEOS in upload order (surplus dropped) when within the count
 *   limit. Always present so callers can proceed with / inspect the retained set.
 * @property {string} [limit] - Machine-readable name of the violated limit when
 *   `ok` is false: 'NO_FILES' | 'MAX_VIDEOS' | 'MAX_TOTAL_VIDEO_BYTES' | 'MAX_AUDIO_BYTES'.
 * @property {string} [error] - Human-readable error naming the violated limit.
 */

/**
 * Coerce a size value to a finite, non-negative byte count.
 * @param {*} value
 * @returns {number}
 */
function toBytes(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Enforce the supported-input limits before any download/encode.
 *
 * @param {InputFile[]} files - The submitted videos, in upload order.
 * @param {EnforceInputLimitsOptions} [opts]
 * @returns {EnforceInputLimitsResult}
 */
function enforceInputLimits(files, opts = {}) {
  const limits = opts.limits || INPUT_LIMITS;
  const getAudioBytes = typeof opts.getAudioBytes === 'function' ? opts.getAudioBytes : null;

  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      limit: 'NO_FILES',
      error: 'No files provided!',
      retained: [],
    };
  }

  // The retained set is always the first MAX_VIDEOS in upload order. When the
  // count limit is exceeded, the surplus videos are dropped from this set
  // (Requirement 1.6 / Property 3).
  const retained =
    files.length > limits.MAX_VIDEOS ? files.slice(0, limits.MAX_VIDEOS) : files.slice();

  // Limit 1: more than MAX_VIDEOS videos. Reject the surplus, retain the first 3,
  // and surface an error naming the limit (Requirement 1.6).
  if (files.length > limits.MAX_VIDEOS) {
    return {
      ok: false,
      limit: 'MAX_VIDEOS',
      error: `Maximum of ${limits.MAX_VIDEOS} videos per upload exceeded (received ${files.length}). The first ${limits.MAX_VIDEOS} were retained.`,
      retained,
    };
  }

  // Limit 2: total video size across the retained set exceeds MAX_TOTAL_VIDEO_BYTES.
  const totalVideoBytes = retained.reduce((sum, f) => sum + toBytes(f && f.size), 0);
  if (totalVideoBytes > limits.MAX_TOTAL_VIDEO_BYTES) {
    const totalMB = (totalVideoBytes / (1024 * 1024)).toFixed(0);
    const limitMB = (limits.MAX_TOTAL_VIDEO_BYTES / (1024 * 1024)).toFixed(0);
    return {
      ok: false,
      limit: 'MAX_TOTAL_VIDEO_BYTES',
      error: `Total video size ${totalMB}MB exceeds the ${limitMB}MB limit.`,
      retained,
    };
  }

  // Limit 3: any single video's added audio exceeds MAX_AUDIO_BYTES.
  if (getAudioBytes) {
    for (let i = 0; i < retained.length; i++) {
      const audioBytes = Number(getAudioBytes(retained[i], i));
      if (Number.isFinite(audioBytes) && audioBytes > limits.MAX_AUDIO_BYTES) {
        const audioMB = (audioBytes / (1024 * 1024)).toFixed(0);
        const limitMB = (limits.MAX_AUDIO_BYTES / (1024 * 1024)).toFixed(0);
        const name = (retained[i] && retained[i].originalName) || `video ${i + 1}`;
        return {
          ok: false,
          limit: 'MAX_AUDIO_BYTES',
          error: `Added audio for "${name}" is ${audioMB}MB, exceeding the ${limitMB}MB per-video limit.`,
          retained,
        };
      }
    }
  }

  return { ok: true, retained };
}

module.exports = { enforceInputLimits };
