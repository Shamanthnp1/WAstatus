'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const arb = require('./arbitraries');

// Smoke tests confirming the test tooling is wired correctly:
// node:test discovers this file, fast-check runs, and the shared arbitraries
// scaffold is importable and produces in-range values. (Requirement 12.3)

test('arbitraries module is importable with constants fallback', () => {
  assert.equal(typeof arb.editRecipeArb, 'function');
  assert.equal(typeof arb.videoMetaArb, 'function');
  assert.ok(arb.LIMITS.CANVAS_WIDTH > 0);
  assert.ok(arb.LIMITS.CANVAS_HEIGHT > 0);
});

test('videoMetaArb produces well-formed VideoMeta', () => {
  fc.assert(
    fc.property(arb.videoMetaArb(), (meta) => {
      assert.ok(meta.width >= 16);
      assert.ok(meta.height >= 16);
      assert.ok(meta.duration > 0);
      assert.equal(typeof meta.key, 'string');
      assert.ok(meta.key.length > 0);
    })
  );
});

test('editRecipeArb produces a recipe within documented ranges', () => {
  fc.assert(
    fc.property(arb.videoMetaArb(), (meta) => {
      const recipe = fc.sample(arb.editRecipeArb({ sourceDuration: meta.duration }), 1)[0];
      assert.equal(recipe.version, 1);
      assert.ok(Array.isArray(recipe.textOverlays));
      assert.ok(Array.isArray(recipe.stickers));
      // sticker + music op count stays within the cap
      const ops = recipe.stickers.length + (recipe.audio.music ? 1 : 0);
      assert.ok(ops <= arb.LIMITS.MAX_STICKER_MUSIC_OPS);
      // every coordinate in [0,1]
      for (const o of recipe.textOverlays) {
        assert.ok(o.pos.x >= 0 && o.pos.x <= 1);
        assert.ok(o.pos.y >= 0 && o.pos.y <= 1);
        assert.ok(o.rotation >= 0 && o.rotation <= 360);
      }
      for (const s of recipe.stickers) {
        assert.ok(s.scale >= arb.LIMITS.SCALE_MIN && s.scale <= arb.LIMITS.SCALE_MAX);
      }
      if (recipe.trim) {
        assert.ok(recipe.trim.start < recipe.trim.end);
        assert.ok(recipe.trim.end <= meta.duration);
      }
    })
  );
});
