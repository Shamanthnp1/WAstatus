'use strict';

/**
 * Property 1: Skip produces the legacy command.
 *
 * For any VideoMeta and for any upload set where no video has an associated
 * Edit_Recipe, the render plan produced for each video is identical to the plan
 * produced by the current no-editor builder (same inputs, same filter string,
 * same encode options) — guaranteeing byte-for-byte identical output.
 *
 * **Validates: Requirements 1.2, 1.4, 1.5**
 *
 * Unit under test (pure planning core, src/server/renderEngine.js):
 *   - planRender(recipe, meta)   with recipe === null (the skip path)
 *   - getOutputOptions()         the legacy no-editor encode command
 *
 * When a video is skipped (no recipe), planRender(null, meta) must return the
 * legacy plan: an empty filterComplex (no `-filter_complex` graph) and encode
 * options that deep-equal getOutputOptions() — the exact token list the current
 * no-editor flow passes to ffmpeg. Exactly one video encode is represented
 * (encodeCount === 1). The mapping must also be deterministic: planning the
 * same skipped video twice yields equal plans.
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { planRender, getOutputOptions } = require('../src/server/renderEngine');
const { videoMetaArb } = require('./helpers/arbitraries');

const NUM_RUNS = 200; // >= 100 generated cases per task requirement.

test('Property 1: skip path produces an empty filterComplex and the legacy encode command', () => {
  fc.assert(
    fc.property(videoMetaArb(), (meta) => {
      const plan = planRender(null, meta);

      // No filter graph: the legacy command uses a `-vf` chain carried inside
      // encodeOptions, never a `-filter_complex` graph.
      assert.strictEqual(
        plan.filterComplex,
        '',
        `skip path filterComplex should be '' but was ${JSON.stringify(plan.filterComplex)}`
      );

      // Encode options must be byte-for-byte the legacy no-editor command.
      assert.deepStrictEqual(
        plan.encodeOptions,
        getOutputOptions(),
        'skip path encodeOptions must deep-equal the legacy getOutputOptions()'
      );

      // Exactly one video encode operation (single Compression_Pass).
      assert.strictEqual(
        plan.encodeCount,
        1,
        `skip path encodeCount should be 1 but was ${plan.encodeCount}`
      );
    }),
    { numRuns: NUM_RUNS }
  );
});

test('Property 1: skip path is deterministic (two plans for the same video are equal)', () => {
  fc.assert(
    fc.property(videoMetaArb(), (meta) => {
      const planA = planRender(null, meta);
      const planB = planRender(null, meta);

      assert.deepStrictEqual(
        planA,
        planB,
        'two plans for the same skipped video must be identical'
      );

      // And in particular the legacy invariants hold on both calls.
      assert.strictEqual(planA.filterComplex, '');
      assert.deepStrictEqual(planA.encodeOptions, getOutputOptions());
      assert.strictEqual(planA.encodeCount, 1);
    }),
    { numRuns: NUM_RUNS }
  );
});
