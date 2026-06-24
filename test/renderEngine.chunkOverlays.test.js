'use strict';

/**
 * Property 11: Overlays are identical and full-duration across chunks.
 *
 * Validates: Requirements 5.7, 6.6, 11.1
 *
 * For any recipe split into N chunks, every chunk's plan renders each text
 * overlay and sticker at the same relative position, scale, and rotation as the
 * recipe, with no time gating, so each overlay is visible from the first to the
 * last frame of every chunk.
 *
 * Units under test (src/server/renderEngine.js):
 *  - `planRender(recipe, meta)`   — builds the base plan + overlay sub-graph.
 *  - `planChunk(plan, i, limit)`  — per-chunk plan; reuses buildVideoFilterComplex
 *                                   over the base plan's overlays.
 *  - `chunkCount(duration, limit)`— number of chunks the timeline tiles into.
 *
 * The filterComplex string carries the overlay sub-graph. Because overlays are
 * full-duration and untimed, that string must be byte-identical in every chunk
 * and must equal `buildVideoFilterComplex` of the recipe's overlays, with no
 * time-gating tokens (`enable=`, `between(t,`).
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  planRender,
  planChunk,
  chunkCount,
  buildVideoFilterComplex,
} = require('../src/server/renderEngine');
const arb = require('./helpers/arbitraries');

const NUM_RUNS = 150;

/**
 * A recipe guaranteed to carry at least one overlay (text or sticker) and no
 * trim, so the planned duration equals `meta.duration` and the overlay
 * sub-graph is non-trivial. Trim is removed so we control the chunk count
 * purely through meta.duration and clipLimit.
 */
function recipeWithOverlaysArb() {
  return fc
    .tuple(arb.editRecipeArb({ sourceDuration: 1e9 }), arb.stickerArb())
    .map(([recipe, sticker]) => {
      delete recipe.trim;
      if (recipe.textOverlays.length + recipe.stickers.length === 0) {
        recipe.stickers = [sticker];
      }
      return recipe;
    });
}

/**
 * A scenario: a recipe with overlays, a clip limit, and a duration deliberately
 * sized so the timeline splits into exactly `nChunks` (>= 2) chunks.
 *
 * duration = (nChunks - 1) * clipLimit + frac * clipLimit, with frac in
 * (0, 1), gives ceil(duration / clipLimit) === nChunks.
 */
function scenarioArb() {
  return fc
    .record({
      recipe: recipeWithOverlaysArb(),
      clipLimit: fc.integer({ min: 5, max: 30 }),
      nChunks: fc.integer({ min: 2, max: 12 }),
      frac: fc.double({ min: 0.05, max: 0.99, noNaN: true }),
      width: fc.integer({ min: 16, max: 4096 }),
      height: fc.integer({ min: 16, max: 4096 }),
    })
    .map(({ recipe, clipLimit, nChunks, frac, width, height }) => {
      const duration = (nChunks - 1) * clipLimit + frac * clipLimit;
      const meta = { width, height, duration, key: 'upload/chunk-overlay-test' };
      return { recipe, clipLimit, nChunks, meta };
    });
}

/** Flatten a recipe's overlays in the same order collectOverlays uses: stickers then text. */
function recipeOverlaysInOrder(recipe) {
  return [...(recipe.stickers || []), ...(recipe.textOverlays || [])];
}

// ---------------------------------------------------------------------------
// Property 11 — every chunk renders an identical, untimed overlay sub-graph.
// ---------------------------------------------------------------------------
test('Property 11 — overlay filter graph is byte-identical and untimed across all chunks', () => {
  fc.assert(
    fc.property(scenarioArb(), ({ recipe, clipLimit, nChunks, meta }) => {
      const basePlan = planRender(recipe, meta);

      // Sanity: the timeline really splits into the intended number of chunks.
      const count = chunkCount(meta.duration, clipLimit);
      assert.strictEqual(count, nChunks);
      assert.ok(count >= 2, 'scenario must produce multiple chunks');

      // The overlay sub-graph the recipe should yield.
      const expectedGraph = buildVideoFilterComplex(basePlan.overlays);

      const chunk0 = planChunk(basePlan, 0, clipLimit);

      for (let i = 0; i < count; i += 1) {
        const ck = planChunk(basePlan, i, clipLimit);

        // (a) Each chunk's overlay filter graph equals what buildVideoFilterComplex
        //     produces for the recipe's overlays.
        assert.strictEqual(ck.filterComplex, expectedGraph);

        // (b) The filter graph is byte-identical to chunk 0's (full-duration,
        //     untimed => no per-chunk variation).
        assert.strictEqual(ck.filterComplex, chunk0.filterComplex);

        // (c) No time-gating tokens anywhere in the graph: overlays are visible
        //     from the first to the last frame of every chunk.
        assert.ok(!ck.filterComplex.includes('enable='), 'no enable= gating');
        assert.ok(!ck.filterComplex.includes('between(t,'), 'no between(t,..) gating');
        assert.ok(!/\benable\b/.test(ck.filterComplex), 'no enable expression');

        // (d) Overlay count matches the recipe in every chunk.
        assert.strictEqual(ck.overlays.length, basePlan.overlays.length);
      }
    }),
    { numRuns: NUM_RUNS }
  );
});

// ---------------------------------------------------------------------------
// Property 11 — each overlay keeps the recipe's relative position, scale, rotation.
// ---------------------------------------------------------------------------
test('Property 11 — each chunk preserves every overlay position, scale, and rotation', () => {
  fc.assert(
    fc.property(scenarioArb(), ({ recipe, clipLimit, meta }) => {
      const basePlan = planRender(recipe, meta);
      const count = chunkCount(meta.duration, clipLimit);
      const expected = recipeOverlaysInOrder(recipe);

      for (let i = 0; i < count; i += 1) {
        const ck = planChunk(basePlan, i, clipLimit);

        // Same overlays, in the same order, with identical transform fields.
        assert.strictEqual(ck.overlays.length, expected.length);
        ck.overlays.forEach(({ overlay }, idx) => {
          const src = expected[idx];
          assert.deepStrictEqual(overlay.pos, src.pos, 'relative position preserved');
          assert.strictEqual(
            typeof overlay.scale === 'number' ? overlay.scale : 1,
            typeof src.scale === 'number' ? src.scale : 1,
            'scale preserved'
          );
          assert.strictEqual(
            typeof overlay.rotation === 'number' ? overlay.rotation : 0,
            typeof src.rotation === 'number' ? src.rotation : 0,
            'rotation preserved'
          );
        });

        // The chunk's overlay list is exactly the base plan's overlay list.
        assert.deepStrictEqual(ck.overlays, basePlan.overlays);
      }
    }),
    { numRuns: NUM_RUNS }
  );
});

// ---------------------------------------------------------------------------
// Deterministic unit check: a concrete recipe (2 stickers + 1 text) split into
// 3 chunks renders an identical, untimed overlay graph in every chunk.
// ---------------------------------------------------------------------------
test('Property 11 — concrete recipe: identical overlay graph across 3 chunks', () => {
  const recipe = {
    version: 1,
    textOverlays: [
      {
        id: 't1',
        text: 'Hello',
        textColor: '#FFFFFF',
        bgColor: '#00000080',
        font: 'Roboto',
        fontSize: 48,
        pos: { x: 0.5, y: 0.12 },
        rotation: 30,
      },
    ],
    stickers: [
      { id: 's1', assetRef: 'asset_a', pos: { x: 0.25, y: 0.25 }, scale: 1.5, rotation: 0 },
      { id: 's2', assetRef: 'asset_b', pos: { x: 0.75, y: 0.8 }, scale: 0.5, rotation: 90 },
    ],
    audio: { originalMuted: false, originalVolume: 100 },
  };
  const clipLimit = 29;
  const meta = { width: 1080, height: 1920, duration: 75, key: 'upload/concrete' };

  const basePlan = planRender(recipe, meta);
  const count = chunkCount(meta.duration, clipLimit);
  assert.strictEqual(count, 3);

  const expectedGraph = buildVideoFilterComplex(basePlan.overlays);
  const graphs = [];
  for (let i = 0; i < count; i += 1) {
    const ck = planChunk(basePlan, i, clipLimit);
    graphs.push(ck.filterComplex);
    assert.strictEqual(ck.filterComplex, expectedGraph);
    assert.ok(!ck.filterComplex.includes('enable='));
    assert.strictEqual(ck.overlays.length, 3);
  }
  // All three chunk graphs are byte-identical.
  assert.strictEqual(graphs[0], graphs[1]);
  assert.strictEqual(graphs[1], graphs[2]);
});
