'use strict';

/**
 * Property 5: Any single invalid field is rejected and identified, state unchanged.
 *
 * For any otherwise-valid recipe with EXACTLY ONE fault injected, the
 * Recipe_Validator must:
 *   - reject the recipe (ok: false),
 *   - return the offending field together with its permitted bound/limit,
 *   - leave the passed-in recipe object unchanged (the validator is pure), and
 *   - by rejecting, ensure no Compression_Pass is started.
 *
 * Faults covered: coordinate < 0 / > 1 / non-numeric / missing; an out-of-range
 * or wrong-type value (fontSize, scale, rotation, volume, enums, booleans, text);
 * a trim violating its bounds; an asset reference not present/validated; a
 * serialized size > 65,536 bytes; a sticker+music op count > 50; and malformed
 * JSON.
 *
 * **Validates: Requirements 2.7, 3.2, 3.4, 3.5, 3.6, 3.7, 3.8**
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { validateRecipe } = require('../src/server/recipeValidator');
const { RECIPE_LIMITS } = require('../src/shared/constants');
const arb = require('./helpers/arbitraries');

/** Portable deep clone for JSON-safe recipe data. */
const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * A guaranteed-"rich", fully valid base recipe: it always contains a trim, at
 * least one text overlay, at least one sticker, and an audio block with a music
 * track. This ensures every fault type below has a concrete field to target.
 *
 * Emits { duration, recipe } so trim faults can be expressed relative to the
 * source duration.
 */
const baseArb = fc
  .double({ min: 5, max: 600, noNaN: true })
  .chain((duration) =>
    fc.record({
      duration: fc.constant(duration),
      recipe: fc.record({
        version: fc.constant(1),
        trim: arb.trimArb(duration),
        textOverlays: fc.array(arb.textOverlayArb(), { minLength: 1, maxLength: 5 }),
        stickers: fc.array(arb.stickerArb(), { minLength: 1, maxLength: 5 }),
        audio: arb.audioArb(true),
      }),
    })
  );

/**
 * Each fault injector receives a fresh clone of a valid recipe, the full set of
 * valid asset references, and the source duration. It mutates the clone (or
 * produces a string) and returns what to validate, the context to use, and the
 * exact field the validator is expected to report.
 *
 * @typedef {Object} Injected
 * @property {(object|string)} input - The (faulted) recipe to validate.
 * @property {{ sourceDuration: number, availableAssets: Set<string> }} ctx
 * @property {string} expectedField - The field the validator must identify.
 */

/** Default ctx with every asset reference marked available/validated. */
function ctxFor(refs, duration) {
  return { sourceDuration: duration, availableAssets: new Set(refs) };
}

/** @type {Array<{ name: string, inject: (r: object, refs: Set<string>, d: number) => Injected }>} */
const FAULTS = [
  // --- Coordinates: < 0, > 1, non-numeric, missing (Req 3.2) ----------------
  {
    name: 'coord-negative',
    inject: (r, refs, d) => {
      r.textOverlays[0].pos.x = -0.0001;
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'textOverlays[0].pos.x' };
    },
  },
  {
    name: 'coord-above-one',
    inject: (r, refs, d) => {
      r.textOverlays[0].pos.y = 1.5;
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'textOverlays[0].pos.y' };
    },
  },
  {
    name: 'coord-non-numeric',
    inject: (r, refs, d) => {
      r.stickers[0].pos.x = 'not-a-number';
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'stickers[0].pos.x' };
    },
  },
  {
    name: 'coord-missing',
    inject: (r, refs, d) => {
      delete r.textOverlays[0].pos.y;
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'textOverlays[0].pos.y' };
    },
  },

  // --- Out-of-range / wrong-type scalar values (Req 3.5) --------------------
  {
    name: 'fontSize-out-of-range',
    inject: (r, refs, d) => {
      r.textOverlays[0].fontSize = RECIPE_LIMITS.FONT_SIZE_MIN - 1;
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'textOverlays[0].fontSize' };
    },
  },
  {
    name: 'fontSize-wrong-type',
    inject: (r, refs, d) => {
      r.textOverlays[0].fontSize = '40';
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'textOverlays[0].fontSize' };
    },
  },
  {
    name: 'scale-out-of-range',
    inject: (r, refs, d) => {
      r.stickers[0].scale = RECIPE_LIMITS.SCALE_MAX + 1;
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'stickers[0].scale' };
    },
  },
  {
    name: 'scale-wrong-type',
    inject: (r, refs, d) => {
      r.stickers[0].scale = 'big';
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'stickers[0].scale' };
    },
  },
  {
    name: 'rotation-out-of-range-overlay',
    inject: (r, refs, d) => {
      r.textOverlays[0].rotation = RECIPE_LIMITS.ROTATION_MAX + 10;
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'textOverlays[0].rotation' };
    },
  },
  {
    name: 'rotation-wrong-type-sticker',
    inject: (r, refs, d) => {
      r.stickers[0].rotation = 'spin';
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'stickers[0].rotation' };
    },
  },
  {
    name: 'original-volume-out-of-range',
    inject: (r, refs, d) => {
      r.audio.originalVolume = RECIPE_LIMITS.VOLUME_MAX + 50;
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'audio.originalVolume' };
    },
  },
  {
    name: 'music-volume-non-integer',
    inject: (r, refs, d) => {
      r.audio.music.volume = 50.5;
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'audio.music.volume' };
    },
  },
  {
    name: 'original-muted-wrong-type',
    inject: (r, refs, d) => {
      r.audio.originalMuted = 'yes';
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'audio.originalMuted' };
    },
  },
  {
    name: 'music-source-invalid-enum',
    inject: (r, refs, d) => {
      r.audio.music.source = 'spotify';
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'audio.music.source' };
    },
  },
  {
    name: 'music-loopmode-invalid-enum',
    inject: (r, refs, d) => {
      r.audio.music.loopMode = 'repeat';
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'audio.music.loopMode' };
    },
  },
  {
    name: 'music-audiostart-non-numeric',
    inject: (r, refs, d) => {
      r.audio.music.audioStart = 'start';
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'audio.music.audioStart' };
    },
  },

  // --- Text content length / type (Req 2.7 / 3.5) ---------------------------
  {
    name: 'text-empty',
    inject: (r, refs, d) => {
      r.textOverlays[0].text = '';
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'textOverlays[0].text' };
    },
  },
  {
    name: 'text-too-long',
    inject: (r, refs, d) => {
      r.textOverlays[0].text = 'x'.repeat(RECIPE_LIMITS.TEXT_LENGTH_MAX + 1);
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'textOverlays[0].text' };
    },
  },
  {
    name: 'text-wrong-type',
    inject: (r, refs, d) => {
      r.textOverlays[0].text = 123;
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'textOverlays[0].text' };
    },
  },

  // --- Trim bounds (Req 3.4) ------------------------------------------------
  {
    name: 'trim-start-negative',
    inject: (r, refs, d) => {
      r.trim.start = -1;
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'trim.start' };
    },
  },
  {
    name: 'trim-start-not-less-than-end',
    inject: (r, refs, d) => {
      r.trim.start = r.trim.end; // start === end violates start < end
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'trim.start' };
    },
  },
  {
    name: 'trim-end-beyond-duration',
    inject: (r, refs, d) => {
      r.trim.end = d + 5;
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'trim.end' };
    },
  },
  {
    name: 'trim-start-non-numeric',
    inject: (r, refs, d) => {
      r.trim.start = 'zero';
      return { input: r, ctx: ctxFor(refs, d), expectedField: 'trim.start' };
    },
  },

  // --- Asset references not present / not validated (Req 3.6) ---------------
  {
    name: 'sticker-asset-missing',
    inject: (r, refs, d) => {
      const missing = new Set(refs);
      missing.delete(r.stickers[0].assetRef);
      return {
        input: r,
        ctx: { sourceDuration: d, availableAssets: missing },
        expectedField: 'stickers[0].assetRef',
      };
    },
  },
  {
    name: 'music-asset-missing',
    inject: (r, refs, d) => {
      const missing = new Set(refs);
      missing.delete(r.audio.music.assetRef);
      return {
        input: r,
        ctx: { sourceDuration: d, availableAssets: missing },
        expectedField: 'audio.music.assetRef',
      };
    },
  },

  // --- Op-count overflow > 50 (Req 3.7) -------------------------------------
  {
    name: 'op-count-overflow',
    inject: (r, refs, d) => {
      const extendedRefs = new Set(refs);
      const stickers = [];
      const count = RECIPE_LIMITS.MAX_STICKER_MUSIC_OPS + 1; // 51 stickers + 1 music = 52
      for (let i = 0; i < count; i += 1) {
        const ref = `asset_op_${i}`;
        extendedRefs.add(ref);
        stickers.push({ id: `s${i}`, assetRef: ref, pos: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 });
      }
      r.stickers = stickers;
      return {
        input: r,
        ctx: { sourceDuration: d, availableAssets: extendedRefs },
        expectedField: 'stickers',
      };
    },
  },

  // --- Serialized size cap > 65,536 bytes (Req 3.7) -------------------------
  {
    name: 'serialized-size-cap',
    inject: (r, refs, d) => {
      // Pad to exceed the byte cap, then validate as a raw JSON string so the
      // serialized-size check fires on the real byte length.
      r._pad = 'x'.repeat(RECIPE_LIMITS.MAX_SERIALIZED_BYTES + 1024);
      return { input: JSON.stringify(r), ctx: ctxFor(refs, d), expectedField: 'recipe' };
    },
  },

  // --- Malformed JSON (Req 2.7 / 3.7) ---------------------------------------
  {
    name: 'malformed-json',
    inject: (r, refs, d) => {
      const broken = JSON.stringify(r).slice(0, -5) + ' , broken';
      return { input: broken, ctx: ctxFor(refs, d), expectedField: 'recipe' };
    },
  },
];

test('Property 5: a single injected fault is rejected, identified, and leaves input unchanged', () => {
  fc.assert(
    fc.property(baseArb, fc.integer({ min: 0, max: FAULTS.length - 1 }), ({ duration, recipe }, faultIdx) => {
      const fault = FAULTS[faultIdx];
      const refs = arb.recipeAssetRefs(recipe);

      // Sanity: the un-faulted base recipe must be valid, so the only reason the
      // faulted recipe is rejected is the injected fault itself.
      const baseResult = validateRecipe(clone(recipe), ctxFor(refs, duration));
      assert.strictEqual(
        baseResult.ok,
        true,
        `base recipe should be valid before fault "${fault.name}", got ${JSON.stringify(baseResult.error)}`
      );

      // Inject exactly one fault onto a fresh clone.
      const { input, ctx, expectedField } = fault.inject(clone(recipe), refs, duration);

      // Snapshot the input so we can prove the validator does not mutate it.
      const isObjectInput = typeof input === 'object' && input !== null;
      const snapshot = isObjectInput ? clone(input) : input;

      const result = validateRecipe(input, ctx);

      // 1) Rejected (ok: false) -> no Compression_Pass is started (Req 3.8).
      assert.strictEqual(result.ok, false, `fault "${fault.name}" should be rejected`);
      assert.ok(result.error, `fault "${fault.name}" must return an error object`);

      // 2) The offending field is identified.
      assert.strictEqual(
        result.error.field,
        expectedField,
        `fault "${fault.name}" should identify field "${expectedField}", got "${result.error.field}"`
      );

      // 3) The error carries the permitted bound/limit.
      assert.notStrictEqual(
        result.error.bound,
        undefined,
        `fault "${fault.name}" should report the permitted bound/limit`
      );
      assert.strictEqual(typeof result.error.reason, 'string');

      // 4) The validator is pure: the passed-in recipe object is unchanged.
      if (isObjectInput) {
        assert.deepStrictEqual(input, snapshot, `fault "${fault.name}" must not mutate the input recipe`);
      }
    }),
    { numRuns: 200 }
  );
});
