'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { validateRecipe } = require('../src/server/recipeValidator');
const {
  videoMetaArb,
  editRecipeArb,
  recipeAssetRefs,
} = require('./helpers/arbitraries');

/**
 * Property 4: All-valid recipes are accepted.
 *
 * For any recipe whose every field is within range (coords in [0,1], rotations
 * in [0,360], volumes integer in [0,100], fontSize 8-200, scale 0.1-5.0, text
 * length 1-200, trim.start < trim.end <= sourceDuration), whose serialized size
 * <= 65,536 bytes, whose sticker+music op count <= 50, and whose asset
 * references all exist and are validated, the Recipe_Validator accepts it
 * (returns { ok: true }).
 *
 * **Validates: Requirements 3.1, 3.3**
 */
test('Property 4: all-valid recipes are accepted', () => {
  fc.assert(
    fc.property(
      // Generate a source duration first, then a recipe whose trim is bounded
      // by that duration, so the validation context matches the recipe.
      videoMetaArb().chain((meta) =>
        editRecipeArb({ sourceDuration: meta.duration }).map((recipe) => ({ meta, recipe }))
      ),
      ({ meta, recipe }) => {
        // ctx.availableAssets must contain every asset the recipe references
        // (stickers + optional music), all treated as validated.
        const ctx = {
          sourceDuration: meta.duration,
          availableAssets: recipeAssetRefs(recipe),
        };

        const result = validateRecipe(recipe, ctx);

        assert.strictEqual(
          result.ok,
          true,
          `Expected valid recipe to be accepted, but got: ${JSON.stringify(result.error)}\n` +
            `recipe: ${JSON.stringify(recipe)}`
        );
      }
    ),
    { numRuns: 200 }
  );
});
