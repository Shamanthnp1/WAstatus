'use strict';

/**
 * Recipe_Validator (server, pure, pre-encode).
 *
 * Validates an Edit_Recipe before any Compression_Pass is started. The
 * function is pure and synchronous: it never mutates stored state and never
 * triggers an encode. On the first fault it returns the offending field
 * together with its permitted bound/limit.
 *
 * @see Requirements 2.7, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
 *
 * CommonJS to match the existing codebase (server.js).
 */

const { RECIPE_LIMITS } = require('../shared/constants');

/**
 * @typedef {Object} ValidationError
 * @property {string} field - Dotted path to the offending field.
 * @property {string} reason - Human-readable reason the field failed.
 * @property {(string|number)} [bound] - The permitted range/limit for the field.
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} ok - True when the recipe is valid.
 * @property {ValidationError} [error] - Present only when ok is false.
 */

/**
 * @typedef {Object} ValidationContext
 * @property {number} sourceDuration - Source video duration in seconds.
 * @property {Set<string>} availableAssets - Set of validated asset ids.
 * @property {number} [rawSize] - Optional raw serialized byte size of the recipe,
 *   supplied by the caller when the recipe is passed as an already-parsed object.
 */

/** Build an ok result. */
function ok() {
  return { ok: true };
}

/** Build a failure result with the offending field and permitted bound. */
function fail(field, reason, bound) {
  const error = { field, reason };
  if (bound !== undefined) error.bound = bound;
  return { ok: false, error };
}

/** True for a real, finite JavaScript number (rejects NaN/Infinity/non-number). */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** True for a plain (non-array, non-null) object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a single relative coordinate is numeric and within [0, 1].
 * @returns {ValidationError|null} an error, or null when valid.
 */
function checkCoord(value, field) {
  if (value === undefined || value === null) {
    return { field, reason: 'coordinate is missing', bound: '[0.0, 1.0]' };
  }
  if (!isFiniteNumber(value)) {
    return { field, reason: 'coordinate is non-numeric', bound: '[0.0, 1.0]' };
  }
  if (value < RECIPE_LIMITS.COORD_MIN || value > RECIPE_LIMITS.COORD_MAX) {
    return { field, reason: 'coordinate out of range', bound: '[0.0, 1.0]' };
  }
  return null;
}

/**
 * Validate a relative position object ({ x, y }) at the given field prefix.
 * @returns {ValidationError|null}
 */
function checkPosition(pos, prefix) {
  if (!isPlainObject(pos)) {
    return { field: `${prefix}.pos`, reason: 'position must be an object', bound: '{ x, y }' };
  }
  return checkCoord(pos.x, `${prefix}.pos.x`) || checkCoord(pos.y, `${prefix}.pos.y`);
}

/**
 * Validate a rotation value is numeric and within [0, 360].
 * @returns {ValidationError|null}
 */
function checkRotation(value, field) {
  if (!isFiniteNumber(value)) {
    return { field, reason: 'rotation is non-numeric', bound: '[0, 360]' };
  }
  if (value < RECIPE_LIMITS.ROTATION_MIN || value > RECIPE_LIMITS.ROTATION_MAX) {
    return { field, reason: 'rotation out of range', bound: '[0, 360]' };
  }
  return null;
}

/**
 * Validate an integer volume percentage within [0, 100].
 * @returns {ValidationError|null}
 */
function checkVolume(value, field) {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) {
    return { field, reason: 'volume must be an integer', bound: '[0, 100]' };
  }
  if (value < RECIPE_LIMITS.VOLUME_MIN || value > RECIPE_LIMITS.VOLUME_MAX) {
    return { field, reason: 'volume out of range', bound: '[0, 100]' };
  }
  return null;
}

/**
 * Validate an Edit_Recipe.
 *
 * Accepts the recipe either as a raw JSON string (so JSON well-formedness and
 * serialized size can be checked directly) or as an already-parsed object. When
 * an object is supplied, the caller may pass `ctx.rawSize` with the original
 * serialized byte length; otherwise the size is computed by re-serializing.
 *
 * @param {(string|unknown)} recipe - Raw JSON string or parsed recipe object.
 * @param {ValidationContext} ctx - Validation context.
 * @returns {ValidationResult}
 */
function validateRecipe(recipe, ctx) {
  const context = ctx || {};
  const sourceDuration = isFiniteNumber(context.sourceDuration) ? context.sourceDuration : 0;
  const availableAssets =
    context.availableAssets instanceof Set ? context.availableAssets : new Set();
  const maxBytes = RECIPE_LIMITS.MAX_SERIALIZED_BYTES;

  // --- 1. JSON well-formedness + serialized size cap (Req 3.7) ---------------
  let parsed;
  if (typeof recipe === 'string') {
    const size = Buffer.byteLength(recipe, 'utf8');
    if (size > maxBytes) {
      return fail('recipe', 'serialized recipe exceeds size cap', `${maxBytes} bytes`);
    }
    try {
      parsed = JSON.parse(recipe);
    } catch (_err) {
      return fail('recipe', 'recipe is not well-formed JSON', 'well-formed JSON');
    }
  } else {
    parsed = recipe;
    let size;
    if (isFiniteNumber(context.rawSize)) {
      size = context.rawSize;
    } else {
      try {
        size = Buffer.byteLength(JSON.stringify(parsed) || '', 'utf8');
      } catch (_err) {
        // Circular or otherwise non-serializable input is not a valid recipe.
        return fail('recipe', 'recipe is not serializable JSON', 'well-formed JSON');
      }
    }
    if (size > maxBytes) {
      return fail('recipe', 'serialized recipe exceeds size cap', `${maxBytes} bytes`);
    }
  }

  if (!isPlainObject(parsed)) {
    return fail('recipe', 'recipe must be a JSON object', 'object');
  }

  // --- 2. Structural shape of overlay/sticker collections --------------------
  const textOverlays = parsed.textOverlays === undefined ? [] : parsed.textOverlays;
  if (!Array.isArray(textOverlays)) {
    return fail('textOverlays', 'textOverlays must be an array', 'array');
  }
  const stickers = parsed.stickers === undefined ? [] : parsed.stickers;
  if (!Array.isArray(stickers)) {
    return fail('stickers', 'stickers must be an array', 'array');
  }

  const audio = parsed.audio;
  if (audio !== undefined && !isPlainObject(audio)) {
    return fail('audio', 'audio must be an object', 'object');
  }
  const music = audio && audio.music !== undefined ? audio.music : undefined;
  if (music !== undefined && !isPlainObject(music)) {
    return fail('audio.music', 'music must be an object', 'object');
  }
  const hasMusic = music !== undefined;

  // --- 3. Combined sticker + music operation count (Req 3.7) -----------------
  const opCount = stickers.length + (hasMusic ? 1 : 0);
  if (opCount > RECIPE_LIMITS.MAX_STICKER_MUSIC_OPS) {
    return fail(
      'stickers',
      'combined sticker and music operation count exceeds limit',
      RECIPE_LIMITS.MAX_STICKER_MUSIC_OPS
    );
  }

  // --- 4. Trim: start < end, both within [0, sourceDuration] (Req 3.3/3.4) ---
  if (parsed.trim !== undefined) {
    const trim = parsed.trim;
    if (!isPlainObject(trim)) {
      return fail('trim', 'trim must be an object', '{ start, end }');
    }
    if (!isFiniteNumber(trim.start)) {
      return fail('trim.start', 'trim start is non-numeric', `[0, ${sourceDuration}]`);
    }
    if (!isFiniteNumber(trim.end)) {
      return fail('trim.end', 'trim end is non-numeric', `[0, ${sourceDuration}]`);
    }
    if (trim.start < 0 || trim.start > sourceDuration) {
      return fail('trim.start', 'trim start out of range', `[0, ${sourceDuration}]`);
    }
    if (trim.end < 0 || trim.end > sourceDuration) {
      return fail('trim.end', 'trim end out of range', `[0, ${sourceDuration}]`);
    }
    if (!(trim.start < trim.end)) {
      return fail('trim.start', 'trim start must be strictly less than trim end', 'start < end');
    }
  }

  // --- 5. Text overlays: coords, rotation, fontSize, text length -------------
  for (let i = 0; i < textOverlays.length; i += 1) {
    const overlay = textOverlays[i];
    const prefix = `textOverlays[${i}]`;
    if (!isPlainObject(overlay)) {
      return fail(prefix, 'text overlay must be an object', 'object');
    }

    if (typeof overlay.text !== 'string') {
      return fail(`${prefix}.text`, 'text must be a string', `[${RECIPE_LIMITS.TEXT_LENGTH_MIN}, ${RECIPE_LIMITS.TEXT_LENGTH_MAX}] chars`);
    }
    if (
      overlay.text.length < RECIPE_LIMITS.TEXT_LENGTH_MIN ||
      overlay.text.length > RECIPE_LIMITS.TEXT_LENGTH_MAX
    ) {
      return fail(
        `${prefix}.text`,
        'text length out of range',
        `[${RECIPE_LIMITS.TEXT_LENGTH_MIN}, ${RECIPE_LIMITS.TEXT_LENGTH_MAX}] chars`
      );
    }

    if (!isFiniteNumber(overlay.fontSize)) {
      return fail(`${prefix}.fontSize`, 'fontSize is non-numeric', `[${RECIPE_LIMITS.FONT_SIZE_MIN}, ${RECIPE_LIMITS.FONT_SIZE_MAX}]`);
    }
    if (
      overlay.fontSize < RECIPE_LIMITS.FONT_SIZE_MIN ||
      overlay.fontSize > RECIPE_LIMITS.FONT_SIZE_MAX
    ) {
      return fail(
        `${prefix}.fontSize`,
        'fontSize out of range',
        `[${RECIPE_LIMITS.FONT_SIZE_MIN}, ${RECIPE_LIMITS.FONT_SIZE_MAX}]`
      );
    }

    const posErr = checkPosition(overlay.pos, prefix);
    if (posErr) return { ok: false, error: posErr };

    const rotErr = checkRotation(overlay.rotation, `${prefix}.rotation`);
    if (rotErr) return { ok: false, error: rotErr };
  }

  // --- 6. Stickers: asset ref, coords, scale, rotation -----------------------
  for (let i = 0; i < stickers.length; i += 1) {
    const sticker = stickers[i];
    const prefix = `stickers[${i}]`;
    if (!isPlainObject(sticker)) {
      return fail(prefix, 'sticker must be an object', 'object');
    }

    if (typeof sticker.assetRef !== 'string' || sticker.assetRef.length === 0) {
      return fail(`${prefix}.assetRef`, 'sticker assetRef must be a non-empty string', 'non-empty string');
    }

    const posErr = checkPosition(sticker.pos, prefix);
    if (posErr) return { ok: false, error: posErr };

    if (!isFiniteNumber(sticker.scale)) {
      return fail(`${prefix}.scale`, 'scale is non-numeric', `[${RECIPE_LIMITS.SCALE_MIN}, ${RECIPE_LIMITS.SCALE_MAX}]`);
    }
    if (sticker.scale < RECIPE_LIMITS.SCALE_MIN || sticker.scale > RECIPE_LIMITS.SCALE_MAX) {
      return fail(
        `${prefix}.scale`,
        'scale out of range',
        `[${RECIPE_LIMITS.SCALE_MIN}, ${RECIPE_LIMITS.SCALE_MAX}]`
      );
    }

    const rotErr = checkRotation(sticker.rotation, `${prefix}.rotation`);
    if (rotErr) return { ok: false, error: rotErr };

    // Asset reference must exist and be validated (Req 3.6).
    if (!availableAssets.has(sticker.assetRef)) {
      return fail(`${prefix}.assetRef`, 'referenced sticker asset is missing or not validated', 'validated asset');
    }
  }

  // --- 7. Audio: volumes, and music ref/range checks -------------------------
  if (audio !== undefined) {
    if (audio.originalMuted !== undefined && typeof audio.originalMuted !== 'boolean') {
      return fail('audio.originalMuted', 'originalMuted must be a boolean', 'boolean');
    }
    if (audio.originalVolume !== undefined) {
      const volErr = checkVolume(audio.originalVolume, 'audio.originalVolume');
      if (volErr) return { ok: false, error: volErr };
    }
  }

  if (hasMusic) {
    if (typeof music.assetRef !== 'string' || music.assetRef.length === 0) {
      return fail('audio.music.assetRef', 'music assetRef must be a non-empty string', 'non-empty string');
    }
    if (music.source !== undefined && music.source !== 'upload' && music.source !== 'library') {
      return fail('audio.music.source', 'music source must be "upload" or "library"', 'upload | library');
    }
    if (music.volume !== undefined) {
      const volErr = checkVolume(music.volume, 'audio.music.volume');
      if (volErr) return { ok: false, error: volErr };
    }
    if (music.audioStart !== undefined && !isFiniteNumber(music.audioStart)) {
      return fail('audio.music.audioStart', 'audioStart must be numeric', 'seconds >= 0');
    }
    if (music.loopMode !== undefined && music.loopMode !== 'loop' && music.loopMode !== 'once') {
      return fail('audio.music.loopMode', 'loopMode must be "loop" or "once"', 'loop | once');
    }

    // Asset reference must exist and be validated (Req 3.6).
    if (!availableAssets.has(music.assetRef)) {
      return fail('audio.music.assetRef', 'referenced music asset is missing or not validated', 'validated asset');
    }
  }

  return ok();
}

module.exports = { validateRecipe };
