'use strict';

/**
 * Property 9: Trim recording and exclusion.
 *
 * Validates: Requirements 2.4, 4.2, 4.3, 4.4, 4.5
 *
 * For any trim selection that is valid (0 <= start < end <= sourceDuration) the
 * recipe records it exactly; for any invalid selection the previously recorded
 * trim is retained; and the render plan derived from a recipe seeks to `start`
 * and bounds the output to `end`, so the planned content duration equals
 * end - start. When no trim is present, the planned duration equals the source
 * duration with no seek.
 *
 * Two units are exercised:
 *  - `planRender(recipe, meta)` (src/server/renderEngine.js) — the server-side
 *    plan derivation (Req 4.4, 4.5).
 *  - The browser editor's trim recording via `EditorInstance.setTrim/getTrim`
 *    (public/js/editor.js, CommonJS export) — trim capture and invalid-trim
 *    retention (Req 2.4, 4.2, 4.3).
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { planRender } = require('../src/server/renderEngine');
const arb = require('./helpers/arbitraries');
const Editor = require('../public/js/editor');

const NUM_RUNS = 200;

/**
 * Mirror of the private `fmt` helper in renderEngine.js: integers stringify
 * plainly, other finite numbers round-trip through Number(). The trim seek args
 * are emitted with this exact formatting.
 */
function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n));
}

/** Build a minimal, otherwise-empty recipe carrying the given (optional) trim. */
function recipeWith(trim) {
  const recipe = {
    version: 1,
    textOverlays: [],
    stickers: [],
    audio: { originalMuted: false, originalVolume: 100 },
  };
  if (trim) recipe.trim = trim;
  return recipe;
}

/** Find the video input (always inputs[0]) for a plan. */
function videoArgs(plan) {
  return plan.inputs[0].args || [];
}

// ---------------------------------------------------------------------------
// planRender: a recipe with a valid trim seeks to start and bounds to end.
// ---------------------------------------------------------------------------
test('Property 9 — planRender records the trim and bounds output to [start, end]', () => {
  fc.assert(
    fc.property(
      arb.videoMetaArb().chain((meta) =>
        fc.record({ meta: fc.constant(meta), trim: arb.trimArb(meta.duration) })
      ),
      ({ meta, trim }) => {
        const plan = planRender(recipeWith(trim), meta);

        // The plan records the trim exactly.
        assert.deepStrictEqual(plan.trim, { start: trim.start, end: trim.end });

        // The video input seeks to start and bounds to end: ['-ss', start, '-to', end].
        assert.deepStrictEqual(videoArgs(plan), [
          '-ss',
          fmt(trim.start),
          '-to',
          fmt(trim.end),
        ]);

        // Planned content duration equals end - start.
        assert.strictEqual(plan.plannedDuration, trim.end - trim.start);
      }
    ),
    { numRuns: NUM_RUNS }
  );
});

// ---------------------------------------------------------------------------
// planRender: no trim => full source duration, no seek.
// ---------------------------------------------------------------------------
test('Property 9 — planRender with no trim spans the full source with no seek', () => {
  fc.assert(
    fc.property(arb.videoMetaArb(), (meta) => {
      const plan = planRender(recipeWith(undefined), meta);

      // No trim recorded.
      assert.strictEqual(plan.trim, undefined);

      // Planned duration equals the source duration.
      assert.strictEqual(plan.plannedDuration, meta.duration);

      // No seek arg on the video input.
      assert.ok(!videoArgs(plan).includes('-ss'));
      assert.deepStrictEqual(videoArgs(plan), []);
    }),
    { numRuns: NUM_RUNS }
  );
});

// ---------------------------------------------------------------------------
// planRender: the skip path (null recipe) also spans the full source, no seek.
// ---------------------------------------------------------------------------
test('Property 9 — planRender skip path spans the full source with no seek', () => {
  fc.assert(
    fc.property(arb.videoMetaArb(), (meta) => {
      const plan = planRender(null, meta);
      assert.strictEqual(plan.trim, undefined);
      assert.strictEqual(plan.plannedDuration, meta.duration);
      assert.ok(!videoArgs(plan).includes('-ss'));
    }),
    { numRuns: NUM_RUNS }
  );
});

// ---------------------------------------------------------------------------
// Editor: a valid trim selection is recorded exactly.
// ---------------------------------------------------------------------------
test('Property 9 — editor records a valid trim selection exactly', () => {
  fc.assert(
    fc.property(
      arb.videoMetaArb().chain((meta) =>
        fc.record({ meta: fc.constant(meta), trim: arb.trimArb(meta.duration) })
      ),
      ({ meta, trim }) => {
        const ed = new Editor.EditorInstance(0, { sourceDuration: meta.duration });
        const accepted = ed.setTrim(trim.start, trim.end);

        assert.strictEqual(accepted, true);
        assert.deepStrictEqual(ed.getTrim(), { start: trim.start, end: trim.end });
      }
    ),
    { numRuns: NUM_RUNS }
  );
});

/**
 * Generate an invalid trim for a given source duration. Covers all three
 * invalidity modes from Req 4.3: start < 0, end > duration, and start >= end.
 */
function invalidTrimArb(duration) {
  return fc.oneof(
    // start < 0 (end is otherwise in-range)
    fc.record({
      start: fc.double({ min: -1000, max: -0.001, noNaN: true }),
      end: fc.double({ min: 0.001, max: duration, noNaN: true }),
    }),
    // end > duration (start is otherwise in-range)
    fc.record({
      start: fc.double({ min: 0, max: duration, noNaN: true }),
      end: fc.double({ min: duration + 0.001, max: duration + 1000, noNaN: true }),
    }),
    // start >= end (both >= 0)
    fc
      .record({
        end: fc.double({ min: 0, max: duration, noNaN: true }),
        delta: fc.double({ min: 0, max: duration, noNaN: true }),
      })
      .map(({ end, delta }) => ({ start: end + delta, end }))
  );
}

// ---------------------------------------------------------------------------
// Editor: an invalid trim selection is rejected, prior trim retained.
// ---------------------------------------------------------------------------
test('Property 9 — editor rejects an invalid trim and retains the prior recorded trim', () => {
  fc.assert(
    fc.property(
      arb.videoMetaArb().chain((meta) =>
        fc.record({
          meta: fc.constant(meta),
          prior: arb.trimArb(meta.duration),
          invalid: invalidTrimArb(meta.duration),
        })
      ),
      ({ meta, prior, invalid }) => {
        const ed = new Editor.EditorInstance(0, { sourceDuration: meta.duration });

        // Establish a valid prior trim.
        assert.strictEqual(ed.setTrim(prior.start, prior.end), true);

        // Attempt the invalid trim: rejected, prior retained unchanged.
        const accepted = ed.setTrim(invalid.start, invalid.end);
        assert.strictEqual(accepted, false);
        assert.deepStrictEqual(ed.getTrim(), { start: prior.start, end: prior.end });
      }
    ),
    { numRuns: NUM_RUNS }
  );
});
