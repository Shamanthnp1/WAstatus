'use strict';

/**
 * Property 20: Exactly one video encode per output clip.
 *
 * For any valid recipe, the render plan produced by `planRender(recipe, meta)`
 * contains exactly one video encode operation: `countVideoEncodes(plan) === 1`
 * AND `plan.encodeCount === 1`. The skip path (`recipe === null`) likewise
 * yields exactly one encode, since editing only adds filter-graph nodes and
 * extra inputs to the single existing Compression_Pass — never a second encode.
 *
 * Validates: Requirements 2.6, 12.3
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { planRender, countVideoEncodes } = require('../src/server/renderEngine');
const {
  editRecipeArb,
  videoMetaArb,
  recipeAssetRefs,
} = require('./helpers/arbitraries');

const NUM_RUNS = 200;

/**
 * Generate a { meta, recipe } pair where the recipe's trim (if any) is bounded
 * by the same source duration as the meta, so the recipe is always valid for
 * its meta. availableAssets is derived from the recipe's own references,
 * mirroring a validated request where every referenced asset exists.
 */
const metaAndRecipeArb = videoMetaArb().chain((meta) =>
  editRecipeArb({ sourceDuration: meta.duration }).map((recipe) => ({ meta, recipe }))
);

test('Property 20: a valid recipe plans exactly one video encode', () => {
  fc.assert(
    fc.property(metaAndRecipeArb, ({ meta, recipe }) => {
      // The planner works with or without resolved asset paths; this set models
      // the validated request context (all referenced assets exist).
      const availableAssets = recipeAssetRefs(recipe);
      assert.ok(availableAssets instanceof Set);

      const plan = planRender(recipe, meta);

      assert.equal(
        countVideoEncodes(plan),
        1,
        'countVideoEncodes(plan) must be exactly 1 for a valid recipe'
      );
      assert.equal(
        plan.encodeCount,
        1,
        'plan.encodeCount must be exactly 1 for a valid recipe'
      );
    }),
    { numRuns: NUM_RUNS }
  );
});

test('Property 20: the skip path (null recipe) plans exactly one video encode', () => {
  fc.assert(
    fc.property(videoMetaArb(), (meta) => {
      const plan = planRender(null, meta);

      assert.equal(
        countVideoEncodes(plan),
        1,
        'countVideoEncodes(plan) must be exactly 1 for the skip path'
      );
      assert.equal(
        plan.encodeCount,
        1,
        'plan.encodeCount must be exactly 1 for the skip path'
      );
    }),
    { numRuns: NUM_RUNS }
  );
});
