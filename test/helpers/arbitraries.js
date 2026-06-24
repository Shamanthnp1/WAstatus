'use strict';

/**
 * Shared fast-check arbitraries for the video-editor spec.
 *
 * These generators produce EditRecipe and VideoMeta values used by the
 * property-based tests for the Recipe_Validator, Render_Engine planning layer,
 * and audio planning. They intentionally constrain output to the valid input
 * space described in design.md (relative coords in [0,1], rotation 0-360, etc.)
 * so individual tests can inject faults on top of an otherwise-valid base.
 *
 * NOTE: `src/shared/constants.js` may be created concurrently (task 1.1). This
 * module loads it defensively so the scaffold stays importable even if the
 * constants file is mid-creation. Once constants.js lands, its values take
 * precedence over the local fallbacks below.
 */

const fc = require('fast-check');

/**
 * Defensive load of shared constants. Falls back to the limits documented in
 * design.md / requirements.md when the module is not yet present.
 * @returns {Record<string, any>}
 */
function loadConstants() {
  try {
    // eslint-disable-next-line global-require
    return require('../../src/shared/constants');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      return {};
    }
    throw err;
  }
}

const C = loadConstants();

// Fallback limits (mirror design.md). Prefer constants.js values when defined.
const LIMITS = {
  CANVAS_WIDTH: C.CANVAS_WIDTH ?? 1080,
  CANVAS_HEIGHT: C.CANVAS_HEIGHT ?? 1920,
  CLIP_DURATION_LIMIT: C.CLIP_DURATION_LIMIT ?? 29,
  SIZE_LIMIT_BYTES: C.SIZE_LIMIT_BYTES ?? 16 * 1024 * 1024,
  RECIPE_MAX_BYTES: C.RECIPE_MAX_BYTES ?? 65536,
  MAX_STICKER_MUSIC_OPS: C.MAX_STICKER_MUSIC_OPS ?? 50,
  MAX_OVERLAYS: C.MAX_OVERLAYS ?? 20,
  MAX_STICKERS: C.MAX_STICKERS ?? 20,
  FONT_SIZE_MIN: C.FONT_SIZE_MIN ?? 8,
  FONT_SIZE_MAX: C.FONT_SIZE_MAX ?? 200,
  SCALE_MIN: C.SCALE_MIN ?? 0.1,
  SCALE_MAX: C.SCALE_MAX ?? 5.0,
  VOLUME_MIN: C.VOLUME_MIN ?? 0,
  VOLUME_MAX: C.VOLUME_MAX ?? 100,
  TEXT_MIN_LEN: C.TEXT_MIN_LEN ?? 1,
  TEXT_MAX_LEN: C.TEXT_MAX_LEN ?? 200,
  ROTATION_MIN: C.ROTATION_MIN ?? 0,
  ROTATION_MAX: C.ROTATION_MAX ?? 360,
  MAX_VIDEOS: C.MAX_VIDEOS ?? 3,
  MAX_TOTAL_VIDEO_BYTES: C.MAX_TOTAL_VIDEO_BYTES ?? 300 * 1024 * 1024,
  MAX_AUDIO_BYTES: C.MAX_AUDIO_BYTES ?? 20 * 1024 * 1024,
};

/** A relative coordinate in [0, 1]. */
const relCoord = () => fc.double({ min: 0, max: 1, noNaN: true });

/** A rotation in degrees within [0, 360]. */
const rotation = () =>
  fc.double({ min: LIMITS.ROTATION_MIN, max: LIMITS.ROTATION_MAX, noNaN: true });

/** A relative position { x, y } with both axes in [0, 1]. */
const position = () => fc.record({ x: relCoord(), y: relCoord() });

/** An integer volume in [0, 100]. */
const volume = () => fc.integer({ min: LIMITS.VOLUME_MIN, max: LIMITS.VOLUME_MAX });

/** An asset reference id (non-empty token). */
const assetRef = () =>
  fc.string({ minLength: 4, maxLength: 16 }).map((s) => `asset_${s.replace(/[^a-zA-Z0-9]/g, '') || 'x'}`);

/**
 * A valid VideoMeta. Duration is bounded to a realistic range so trims and
 * chunk planning stay meaningful.
 * @returns {fc.Arbitrary<{ width: number, height: number, duration: number, key: string }>}
 */
function videoMetaArb() {
  return fc.record({
    width: fc.integer({ min: 16, max: 4096 }),
    height: fc.integer({ min: 16, max: 4096 }),
    duration: fc.double({ min: 0.5, max: 600, noNaN: true }),
    key: fc.string({ minLength: 1, maxLength: 32 }).map((s) => `upload/${s.replace(/\s/g, '_') || 'k'}`),
  });
}

/**
 * A valid TextOverlay entry.
 * @returns {fc.Arbitrary<object>}
 */
function textOverlayArb() {
  return fc.record({
    id: fc.string({ minLength: 1, maxLength: 8 }).map((s) => `t_${s.replace(/[^a-zA-Z0-9]/g, '') || 'x'}`),
    text: fc.string({ minLength: LIMITS.TEXT_MIN_LEN, maxLength: LIMITS.TEXT_MAX_LEN }),
    textColor: fc.constantFrom('#FFFFFF', '#000000', '#FF0000', '#00FF00', '#0000FF'),
    bgColor: fc.constantFrom('#00000080', '#FFFFFFFF', '#00000000'),
    font: fc.constantFrom('Roboto', 'Arial', 'Open Sans'),
    fontSize: fc.integer({ min: LIMITS.FONT_SIZE_MIN, max: LIMITS.FONT_SIZE_MAX }),
    pos: position(),
    rotation: rotation(),
  });
}

/**
 * A valid Sticker entry.
 * @returns {fc.Arbitrary<object>}
 */
function stickerArb() {
  return fc.record({
    id: fc.string({ minLength: 1, maxLength: 8 }).map((s) => `s_${s.replace(/[^a-zA-Z0-9]/g, '') || 'x'}`),
    assetRef: assetRef(),
    pos: position(),
    scale: fc.double({ min: LIMITS.SCALE_MIN, max: LIMITS.SCALE_MAX, noNaN: true }),
    rotation: rotation(),
  });
}

/**
 * A valid Music sub-object (optional in the recipe).
 * @returns {fc.Arbitrary<object>}
 */
function musicArb() {
  return fc.record({
    assetRef: assetRef(),
    source: fc.constantFrom('upload', 'library'),
    volume: volume(),
    audioStart: fc.double({ min: 0, max: 600, noNaN: true }),
    loopMode: fc.constantFrom('loop', 'once'),
  });
}

/**
 * A valid Audio sub-object.
 * @param {boolean} [withMusic] - force-include or exclude a music track; random when omitted.
 * @returns {fc.Arbitrary<object>}
 */
function audioArb(withMusic) {
  const base = {
    originalMuted: fc.boolean(),
    originalVolume: volume(),
  };
  if (withMusic === true) {
    return fc.record({ ...base, music: musicArb() });
  }
  if (withMusic === false) {
    return fc.record(base);
  }
  return fc.oneof(fc.record(base), fc.record({ ...base, music: musicArb() }));
}

/**
 * A valid trim relative to a given source duration.
 * @param {number} sourceDuration
 * @returns {fc.Arbitrary<{ start: number, end: number }>}
 */
function trimArb(sourceDuration) {
  return fc
    .tuple(
      fc.double({ min: 0, max: sourceDuration, noNaN: true }),
      fc.double({ min: 0, max: sourceDuration, noNaN: true })
    )
    .filter(([a, b]) => a < b)
    .map(([a, b]) => ({ start: a, end: b }));
}

/**
 * A fully valid EditRecipe. Sticker + music op count is constrained to stay
 * within MAX_STICKER_MUSIC_OPS, and overlay/sticker counts within their caps.
 * @param {object} [opts]
 * @param {number} [opts.sourceDuration] - duration used to bound the trim.
 * @returns {fc.Arbitrary<object>}
 */
function editRecipeArb(opts = {}) {
  const sourceDuration = opts.sourceDuration ?? 60;
  // Leave headroom so stickers + (music?1:0) never exceeds the op cap.
  const maxStickers = Math.min(LIMITS.MAX_STICKERS, LIMITS.MAX_STICKER_MUSIC_OPS - 1);
  return fc
    .record(
      {
        version: fc.constant(1),
        trim: fc.option(trimArb(sourceDuration), { nil: undefined }),
        textOverlays: fc.array(textOverlayArb(), { minLength: 0, maxLength: LIMITS.MAX_OVERLAYS }),
        stickers: fc.array(stickerArb(), { minLength: 0, maxLength: maxStickers }),
        audio: audioArb(),
      },
      { requiredKeys: ['version', 'textOverlays', 'stickers', 'audio'] }
    )
    .map((recipe) => {
      if (recipe.trim === undefined) {
        delete recipe.trim;
      }
      return recipe;
    });
}

/**
 * The set of asset references used by a recipe, useful for building the
 * `availableAssets` validation context.
 * @param {object} recipe
 * @returns {Set<string>}
 */
function recipeAssetRefs(recipe) {
  const refs = new Set();
  for (const s of recipe.stickers || []) {
    if (s && s.assetRef) refs.add(s.assetRef);
  }
  if (recipe.audio && recipe.audio.music && recipe.audio.music.assetRef) {
    refs.add(recipe.audio.music.assetRef);
  }
  return refs;
}

module.exports = {
  LIMITS,
  relCoord,
  rotation,
  position,
  volume,
  assetRef,
  videoMetaArb,
  textOverlayArb,
  stickerArb,
  musicArb,
  audioArb,
  trimArb,
  editRecipeArb,
  recipeAssetRefs,
};
