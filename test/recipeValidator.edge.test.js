'use strict';

/**
 * Unit tests for Recipe_Validator edge cases (task 2.4).
 *
 * These are concrete example-based tests (node:test) that complement the
 * property-based tests. They cover the boundaries and limit violations that
 * are easiest to verify with exact inputs:
 *   - Malformed JSON string input is rejected as not well-formed JSON.
 *   - Exactly-at-boundary field values are accepted.
 *   - Op-count overflow (51 combined sticker+music ops) is rejected.
 *   - Oversize serialized recipe (> 65,536 bytes) is rejected.
 *
 * _Requirements: 3.7_
 */

const test = require('node:test');
const assert = require('node:assert');

const { validateRecipe } = require('../src/server/recipeValidator');
const { RECIPE_LIMITS } = require('../src/shared/constants');

const SOURCE_DURATION = 30;

/**
 * Build a minimal, otherwise-valid base recipe so a single field can be set to
 * a boundary value without any unrelated fault triggering rejection.
 * @param {object} [overrides]
 * @returns {object}
 */
function baseRecipe(overrides = {}) {
  return {
    version: 1,
    textOverlays: [],
    stickers: [],
    audio: { originalMuted: false, originalVolume: 100 },
    ...overrides,
  };
}

/** A valid text overlay with the given field overrides. */
function textOverlay(overrides = {}) {
  return {
    id: 't1',
    text: 'Hello',
    textColor: '#FFFFFF',
    bgColor: '#00000080',
    font: 'Roboto',
    fontSize: 48,
    pos: { x: 0.5, y: 0.5 },
    rotation: 0,
    ...overrides,
  };
}

/** A valid sticker with the given field overrides. */
function sticker(overrides = {}) {
  return {
    id: 's1',
    assetRef: 'asset_sticker',
    pos: { x: 0.5, y: 0.5 },
    scale: 1.0,
    rotation: 0,
    ...overrides,
  };
}

/** Context whose availableAssets contains exactly the supplied refs. */
function ctx(refs = []) {
  return { sourceDuration: SOURCE_DURATION, availableAssets: new Set(refs) };
}

/** Assert a result is an accepted (ok) result. */
function assertAccepted(result, label) {
  assert.strictEqual(
    result.ok,
    true,
    `${label} should be accepted but was rejected: ${JSON.stringify(result.error)}`
  );
}

/** Assert a result is a rejection mentioning the expected field/bound. */
function assertRejected(result, label) {
  assert.strictEqual(result.ok, false, `${label} should be rejected but was accepted`);
  assert.ok(result.error, `${label} rejection should carry an error object`);
  assert.strictEqual(typeof result.error.field, 'string');
}

// --- Malformed JSON --------------------------------------------------------

test('malformed JSON string is rejected as not well-formed JSON', () => {
  const result = validateRecipe('{ "version": 1, ', ctx());
  assertRejected(result, 'malformed JSON');
  assert.match(result.error.reason, /well-formed JSON/i);
  assert.strictEqual(result.error.bound, 'well-formed JSON');
});

// --- Boundary acceptance: coordinates --------------------------------------

test('coords exactly 0.0 are accepted', () => {
  const recipe = baseRecipe({ textOverlays: [textOverlay({ pos: { x: 0.0, y: 0.0 } })] });
  assertAccepted(validateRecipe(recipe, ctx()), 'coords 0.0');
});

test('coords exactly 1.0 are accepted', () => {
  const recipe = baseRecipe({ textOverlays: [textOverlay({ pos: { x: 1.0, y: 1.0 } })] });
  assertAccepted(validateRecipe(recipe, ctx()), 'coords 1.0');
});

// --- Boundary acceptance: rotation -----------------------------------------

test('rotation exactly 0 is accepted', () => {
  const recipe = baseRecipe({ textOverlays: [textOverlay({ rotation: 0 })] });
  assertAccepted(validateRecipe(recipe, ctx()), 'rotation 0');
});

test('rotation exactly 360 is accepted', () => {
  const recipe = baseRecipe({ textOverlays: [textOverlay({ rotation: 360 })] });
  assertAccepted(validateRecipe(recipe, ctx()), 'rotation 360');
});

// --- Boundary acceptance: volume -------------------------------------------

test('volume exactly 0 is accepted', () => {
  const recipe = baseRecipe({ audio: { originalMuted: false, originalVolume: 0 } });
  assertAccepted(validateRecipe(recipe, ctx()), 'volume 0');
});

test('volume exactly 100 is accepted', () => {
  const recipe = baseRecipe({ audio: { originalMuted: false, originalVolume: 100 } });
  assertAccepted(validateRecipe(recipe, ctx()), 'volume 100');
});

// --- Boundary acceptance: fontSize -----------------------------------------

test('fontSize exactly 8 is accepted', () => {
  const recipe = baseRecipe({ textOverlays: [textOverlay({ fontSize: 8 })] });
  assertAccepted(validateRecipe(recipe, ctx()), 'fontSize 8');
});

test('fontSize exactly 200 is accepted', () => {
  const recipe = baseRecipe({ textOverlays: [textOverlay({ fontSize: 200 })] });
  assertAccepted(validateRecipe(recipe, ctx()), 'fontSize 200');
});

// --- Boundary acceptance: scale --------------------------------------------

test('scale exactly 0.1 is accepted', () => {
  const recipe = baseRecipe({ stickers: [sticker({ scale: 0.1 })] });
  assertAccepted(validateRecipe(recipe, ctx(['asset_sticker'])), 'scale 0.1');
});

test('scale exactly 5.0 is accepted', () => {
  const recipe = baseRecipe({ stickers: [sticker({ scale: 5.0 })] });
  assertAccepted(validateRecipe(recipe, ctx(['asset_sticker'])), 'scale 5.0');
});

// --- Boundary acceptance: text length --------------------------------------

test('text length exactly 1 is accepted', () => {
  const recipe = baseRecipe({ textOverlays: [textOverlay({ text: 'a' })] });
  assertAccepted(validateRecipe(recipe, ctx()), 'text length 1');
});

test('text length exactly 200 is accepted', () => {
  const recipe = baseRecipe({ textOverlays: [textOverlay({ text: 'a'.repeat(200) })] });
  assertAccepted(validateRecipe(recipe, ctx()), 'text length 200');
});

// --- Boundary acceptance: trim ---------------------------------------------

test('trim.start = 0 and trim.end = sourceDuration are accepted', () => {
  const recipe = baseRecipe({ trim: { start: 0, end: SOURCE_DURATION } });
  assertAccepted(validateRecipe(recipe, ctx()), 'trim full range');
});

// --- Op-count overflow ------------------------------------------------------

test('exactly 51 combined sticker+music ops is rejected naming the op-count limit', () => {
  // 50 stickers + 1 music = 51 ops, one over MAX_STICKER_MUSIC_OPS (50).
  const refs = [];
  const stickers = [];
  for (let i = 0; i < 50; i += 1) {
    const ref = `asset_s${i}`;
    refs.push(ref);
    stickers.push(sticker({ id: `s${i}`, assetRef: ref }));
  }
  refs.push('asset_music');
  const recipe = baseRecipe({
    stickers,
    audio: {
      originalMuted: false,
      originalVolume: 100,
      music: {
        assetRef: 'asset_music',
        source: 'upload',
        volume: 80,
        audioStart: 0,
        loopMode: 'loop',
      },
    },
  });

  const result = validateRecipe(recipe, ctx(refs));
  assertRejected(result, '51 combined ops');
  assert.strictEqual(result.error.bound, RECIPE_LIMITS.MAX_STICKER_MUSIC_OPS);
  assert.match(result.error.reason, /operation count/i);
});

test('exactly 50 combined sticker+music ops is accepted (boundary below the cap)', () => {
  // 49 stickers + 1 music = 50 ops, exactly at the cap.
  const refs = [];
  const stickers = [];
  for (let i = 0; i < 49; i += 1) {
    const ref = `asset_s${i}`;
    refs.push(ref);
    stickers.push(sticker({ id: `s${i}`, assetRef: ref }));
  }
  refs.push('asset_music');
  const recipe = baseRecipe({
    stickers,
    audio: {
      originalMuted: false,
      originalVolume: 100,
      music: {
        assetRef: 'asset_music',
        source: 'upload',
        volume: 80,
        audioStart: 0,
        loopMode: 'loop',
      },
    },
  });

  assertAccepted(validateRecipe(recipe, ctx(refs)), '50 combined ops');
});

// --- Oversize recipe --------------------------------------------------------

test('serialized recipe larger than 65536 bytes is rejected naming the size cap', () => {
  const maxBytes = RECIPE_LIMITS.MAX_SERIALIZED_BYTES;
  // A valid-JSON string whose byte length exceeds the cap. The size check runs
  // before JSON.parse, so well-formedness is irrelevant here.
  const padding = 'x'.repeat(maxBytes + 1);
  const oversize = JSON.stringify({ version: 1, pad: padding });
  assert.ok(Buffer.byteLength(oversize, 'utf8') > maxBytes, 'fixture must exceed the cap');

  const result = validateRecipe(oversize, ctx());
  assertRejected(result, 'oversize recipe');
  assert.strictEqual(result.error.bound, `${maxBytes} bytes`);
  assert.match(result.error.reason, /size cap/i);
});
