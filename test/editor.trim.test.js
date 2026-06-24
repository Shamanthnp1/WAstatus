'use strict';

/**
 * Unit + property tests for the trim UI recording layer (task 12.6).
 *
 * Exercises the testable EditorInstance trim recording wrapper (attemptTrim /
 * isTrimInvalid / getTrimOrDefault), the exported pure helpers (isValidTrim,
 * fractionToTime, timeToFraction, computeTrimFromDrag), and the graceful
 * degradation of the DOM trim tool — all WITHOUT a real DOM. Covers the
 * behavior in Requirements 2.4, 4.1, 4.2 and 4.3.
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const Editor = require('../public/js/editor');
const { EditorInstance } = Editor;

function newInstance(duration) {
  return new EditorInstance(0, {
    uploadKey: 'upload/k0',
    sourceDuration: typeof duration === 'number' ? duration : 30,
  });
}

/* ---- pure helpers --------------------------------------------------------- */

test('isValidTrim enforces 0 <= start < end <= duration (Req 2.4/4.1)', () => {
  assert.strictEqual(Editor.isValidTrim(0, 10, 30), true);
  assert.strictEqual(Editor.isValidTrim(5, 30, 30), true); // end == duration ok
  assert.strictEqual(Editor.isValidTrim(0, 30, 30), true);
  assert.strictEqual(Editor.isValidTrim(-1, 10, 30), false); // start < 0
  assert.strictEqual(Editor.isValidTrim(10, 5, 30), false); // start > end
  assert.strictEqual(Editor.isValidTrim(10, 10, 30), false); // start == end
  assert.strictEqual(Editor.isValidTrim(0, 31, 30), false); // end > duration
  assert.strictEqual(Editor.isValidTrim(NaN, 10, 30), false);
  assert.strictEqual(Editor.isValidTrim(0, Infinity, 30), false);
  // duration <= 0 means "unknown" -> upper bound not enforced.
  assert.strictEqual(Editor.isValidTrim(0, 999, 0), true);
});

test('fractionToTime / timeToFraction are inverse and clamped', () => {
  assert.strictEqual(Editor.fractionToTime(0.5, 30), 15);
  assert.strictEqual(Editor.fractionToTime(1.5, 30), 30); // clamped
  assert.strictEqual(Editor.fractionToTime(-0.5, 30), 0); // clamped
  assert.strictEqual(Editor.fractionToTime(0.5, 0), 0); // unknown duration
  assert.strictEqual(Editor.timeToFraction(15, 30), 0.5);
  assert.strictEqual(Editor.timeToFraction(45, 30), 1); // clamped
  assert.strictEqual(Editor.timeToFraction(-5, 30), 0); // clamped
  assert.strictEqual(Editor.timeToFraction(10, 0), 0); // unknown duration
});

test('computeTrimFromDrag moves only the dragged handle', () => {
  const cur = { start: 5, end: 20 };
  assert.deepStrictEqual(Editor.computeTrimFromDrag('start', 0.5, cur, 30), { start: 15, end: 20 });
  assert.deepStrictEqual(Editor.computeTrimFromDrag('end', 0.25, cur, 40), { start: 5, end: 10 });
});

/* ---- attemptTrim recording wrapper --------------------------------------- */

test('attemptTrim records a valid selection exactly and clears invalid (Req 4.2)', () => {
  const inst = newInstance(30);
  const res = inst.attemptTrim(2.5, 27.5);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.trim, { start: 2.5, end: 27.5 });
  assert.deepStrictEqual(inst.getTrim(), { start: 2.5, end: 27.5 });
  assert.strictEqual(inst.isTrimInvalid(), false);

  const recipe = inst.getRecipe();
  assert.ok(recipe);
  assert.deepStrictEqual(recipe.trim, { start: 2.5, end: 27.5 });
});

test('attemptTrim rejects invalid selection, retains prior, flags invalid (Req 4.3)', () => {
  const inst = newInstance(30);
  inst.attemptTrim(5, 25); // valid baseline

  // start >= end
  const bad1 = inst.attemptTrim(20, 10);
  assert.strictEqual(bad1.ok, false);
  assert.strictEqual(bad1.error, 'invalid_trim');
  assert.deepStrictEqual(inst.getTrim(), { start: 5, end: 25 }); // retained
  assert.strictEqual(inst.isTrimInvalid(), true);

  // end > duration
  const bad2 = inst.attemptTrim(0, 40);
  assert.strictEqual(bad2.ok, false);
  assert.deepStrictEqual(inst.getTrim(), { start: 5, end: 25 }); // still retained

  // start < 0
  const bad3 = inst.attemptTrim(-1, 10);
  assert.strictEqual(bad3.ok, false);
  assert.deepStrictEqual(inst.getTrim(), { start: 5, end: 25 });

  // A subsequent valid selection clears the invalid indication.
  const good = inst.attemptTrim(1, 29);
  assert.strictEqual(good.ok, true);
  assert.strictEqual(inst.isTrimInvalid(), false);
  assert.deepStrictEqual(inst.getTrim(), { start: 1, end: 29 });
});

test('attemptTrim with no prior trim retains null on invalid (Req 4.3)', () => {
  const inst = newInstance(30);
  const res = inst.attemptTrim(20, 10);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.trim, null);
  assert.strictEqual(inst.getTrim(), null);
  assert.strictEqual(inst.isTrimInvalid(), true);
  // An invalid-only interaction must not mark the recipe dirty/edited.
  assert.strictEqual(inst.isDirty(), false);
  assert.strictEqual(inst.getRecipe(), null);
});

test('getTrimOrDefault returns full-video default until a trim is recorded', () => {
  const inst = newInstance(42);
  assert.deepStrictEqual(inst.getTrimOrDefault(), { start: 0, end: 42 });
  inst.attemptTrim(3, 12);
  assert.deepStrictEqual(inst.getTrimOrDefault(), { start: 3, end: 12 });
});

test('reset clears the recorded trim and the invalid indication', () => {
  const inst = newInstance(30);
  inst.attemptTrim(20, 10); // invalid -> flag set
  assert.strictEqual(inst.isTrimInvalid(), true);
  inst.attemptTrim(2, 28); // valid
  inst.reset();
  assert.strictEqual(inst.getTrim(), null);
  assert.strictEqual(inst.isTrimInvalid(), false);
  assert.strictEqual(inst.getRecipe(), null);
});

/* ---- DOM tool graceful degradation --------------------------------------- */

test('trimToolInitializer degrades to model-only without a DOM surface', () => {
  const inst = newInstance(30);
  const init = Editor.trimToolInitializer();
  // No surface / no document -> must not throw and must not attach anything.
  assert.doesNotThrow(() => init(inst, null, { _document: null }));
  assert.doesNotThrow(() => init(inst, {}, { _document: null }));
  // Recording still works purely via the model API.
  assert.strictEqual(inst.attemptTrim(1, 5).ok, true);
});

test('registerTrimTool registers the initializer on a controller', () => {
  const controller = new Editor.VideoEditorController({ document: null });
  const before = controller._tools.length;
  const ret = Editor.registerTrimTool(controller);
  assert.strictEqual(ret, controller);
  assert.strictEqual(controller._tools.length, before + 1);
});

/* ---- property: valid recorded exactly, invalid retains prior ------------- */

test('property: valid trim is recorded exactly; invalid retains prior (Req 4.2/4.3)', () => {
  fc.assert(
    fc.property(
      fc.float({ min: 1, max: 600, noNaN: true }),
      fc.float({ min: 0, max: 1, noNaN: true }),
      fc.float({ min: 0, max: 1, noNaN: true }),
      (duration, fa, fb) => {
        const inst = newInstance(duration);
        const start = Editor.fractionToTime(Math.min(fa, fb), duration);
        const end = Editor.fractionToTime(Math.max(fa, fb), duration);

        const valid = Editor.isValidTrim(start, end, duration);
        const prior = inst.getTrim();
        const res = inst.attemptTrim(start, end);

        assert.strictEqual(res.ok, valid);
        if (valid) {
          assert.deepStrictEqual(inst.getTrim(), { start, end });
          assert.strictEqual(inst.isTrimInvalid(), false);
        } else {
          // Prior value retained unchanged, invalid indication set (Req 4.3).
          assert.deepStrictEqual(inst.getTrim(), prior);
          assert.strictEqual(inst.isTrimInvalid(), true);
        }
      }
    )
  );
});
