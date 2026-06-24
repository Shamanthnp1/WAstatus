'use strict';

/**
 * Property 7: Out-of-range placement clamps to the nearest valid value.
 *
 * For any requested drag target or waveform offset that falls outside its valid
 * range, the recorded value equals the nearest in-range value:
 *   - overlay centers clamp to [0, 1] per axis;
 *   - the waveform window offset clamps to [0, trackDuration - selectedLength];
 * and the element / selection is retained.
 *
 * Unit under test: public/js/editor.js (CommonJS UMD export).
 *   - EditorInstance.applyDragToRelative records overlay/sticker centers via the
 *     clampRelative/clampRelativePosition helpers (overlay-center clamping).
 *   - The waveform window clamp ([0, trackDuration - selectedLength]) is not yet
 *     a dedicated helper in editor.js, so it is exercised against the generic
 *     exported `clamp` helper using the same math the waveform tool (task 13.3)
 *     will use: clamp(offset, 0, trackDuration - selectedLength).
 *
 * Validates: Requirements 5.3, 6.5, 9.3
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const Editor = require('../public/js/editor');

const { EditorInstance, LIMITS, clamp } = Editor;

// At least 100 generated cases per property (design.md note); use 200.
const NUM_RUNS = 200;

/* ------------------------------------------------------------------------- *
 * Generators
 * ------------------------------------------------------------------------- */

/** A finite coordinate strictly below the valid [0,1] range. */
const belowUnit = fc.double({ min: -5, max: -1e-6, noNaN: true });
/** A finite coordinate strictly above the valid [0,1] range. */
const aboveUnit = fc.double({ min: 1 + 1e-6, max: 6, noNaN: true });
/** A finite coordinate inside [0,1]. */
const inUnit = fc.double({ min: 0, max: 1, noNaN: true });
/** A coordinate that is guaranteed to be out of [0,1]. */
const outOfUnit = fc.oneof(belowUnit, aboveUnit);
/** A coordinate that may be in or out of range. */
const anyUnit = fc.oneof(inUnit, outOfUnit);

/** A drag target with AT LEAST one axis out of the valid range. */
const outOfRangeTarget = fc.oneof(
  fc.record({ x: outOfUnit, y: anyUnit }),
  fc.record({ x: anyUnit, y: outOfUnit }),
  fc.record({ x: outOfUnit, y: outOfUnit })
);

/** Which kind of element receives the drag. */
const elementType = fc.constantFrom('text', 'sticker');

/**
 * A waveform configuration with a possibly out-of-range requested offset.
 * trackDuration in (0, 600], selectedLength in [0, trackDuration], and a
 * requested offset that may fall below 0 or beyond (trackDuration - length).
 */
const waveformConfig = fc
  .double({ min: 0.1, max: 600, noNaN: true })
  .chain((trackDuration) =>
    fc.record({
      trackDuration: fc.constant(trackDuration),
      selectedLength: fc.double({ min: 0, max: trackDuration, noNaN: true }),
      requestedOffset: fc.double({ min: -120, max: 720, noNaN: true }),
    })
  );

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

/** The nearest in-range value for a unit-interval [0,1] coordinate. */
function nearestUnit(v) {
  if (v < LIMITS.COORD_MIN) return LIMITS.COORD_MIN;
  if (v > LIMITS.COORD_MAX) return LIMITS.COORD_MAX;
  return v;
}

/** The nearest in-range value for the waveform window [0, max]. */
function nearestBound(v, max) {
  if (v < 0) return 0;
  if (v > max) return max;
  return v;
}

/** Add an element of the given kind and return its id. */
function addElement(instance, type) {
  if (type === 'text') {
    const res = instance.addTextOverlay({ text: 'caption' });
    assert.ok(res.ok, 'text overlay should be added');
    return res.overlay.id;
  }
  const res = instance.addSticker({ assetRef: 'asset_x' });
  assert.ok(res.ok, 'sticker should be added');
  return res.sticker.id;
}

/** Read the recorded entry (text overlay or sticker) for an id from the recipe. */
function recordedEntry(instance, type) {
  const recipe = instance.getRecipe();
  assert.ok(recipe, 'recipe should be recorded after adding an element');
  const list = type === 'text' ? recipe.textOverlays : recipe.stickers;
  assert.equal(list.length, 1, 'the element must be retained (exactly one present)');
  return list[0];
}

/* ------------------------------------------------------------------------- *
 * Property 7a — overlay/sticker center clamps to nearest value in [0, 1]
 * ------------------------------------------------------------------------- */

test('Property 7: out-of-range drag target clamps overlay center to nearest [0,1] and retains the element', () => {
  fc.assert(
    fc.property(elementType, outOfRangeTarget, (type, target) => {
      const instance = new EditorInstance(0, { uploadKey: 'upload/k' });
      const id = addElement(instance, type);

      const result = instance.applyDragToRelative(id, target);

      // Element/selection retained: the drag resolves the entry (not null).
      assert.ok(result, 'applyDragToRelative should resolve the existing element');

      const expectedX = nearestUnit(target.x);
      const expectedY = nearestUnit(target.y);

      // Returned (recorded) value equals the nearest in-range value.
      assert.equal(result.x, expectedX, `x clamps to nearest of [0,1]`);
      assert.equal(result.y, expectedY, `y clamps to nearest of [0,1]`);

      // The recipe entry is retained and holds exactly the clamped value.
      const entry = recordedEntry(instance, type);
      assert.equal(entry.pos.x, expectedX, 'recorded pos.x equals nearest in-range value');
      assert.equal(entry.pos.y, expectedY, 'recorded pos.y equals nearest in-range value');

      // And it is genuinely within range.
      assert.ok(entry.pos.x >= LIMITS.COORD_MIN && entry.pos.x <= LIMITS.COORD_MAX);
      assert.ok(entry.pos.y >= LIMITS.COORD_MIN && entry.pos.y <= LIMITS.COORD_MAX);
    }),
    { numRuns: NUM_RUNS }
  );
});

/* ------------------------------------------------------------------------- *
 * Property 7b — waveform offset clamps to nearest value in
 * [0, trackDuration - selectedLength]
 * ------------------------------------------------------------------------- */

test('Property 7: out-of-range waveform offset clamps to nearest [0, trackDuration - selectedLength]', () => {
  fc.assert(
    fc.property(waveformConfig, ({ trackDuration, selectedLength, requestedOffset }) => {
      const maxOffset = trackDuration - selectedLength; // valid upper bound, >= 0

      const recorded = clamp(requestedOffset, 0, maxOffset);
      const expected = nearestBound(requestedOffset, maxOffset);

      // The recorded offset equals the nearest in-range value.
      assert.equal(recorded, expected, 'waveform offset clamps to the nearest valid bound');

      // It always lands inside the valid window.
      assert.ok(recorded >= 0, 'recorded offset is >= 0');
      assert.ok(recorded <= maxOffset + 1e-9, 'recorded offset is <= trackDuration - selectedLength');

      // Out-of-range requests resolve exactly to the nearest bound.
      if (requestedOffset < 0) {
        assert.equal(recorded, 0, 'below-range offset clamps to 0');
      } else if (requestedOffset > maxOffset) {
        assert.equal(recorded, maxOffset, 'above-range offset clamps to the max bound');
      }
    }),
    { numRuns: NUM_RUNS }
  );
});

/* ------------------------------------------------------------------------- *
 * Focused unit checks — explicit out-of-range values clamp to the boundary.
 * ------------------------------------------------------------------------- */

test('drag center far outside the frame clamps to the nearest corner and keeps the sticker', () => {
  const instance = new EditorInstance(0);
  const { sticker } = instance.addSticker({ assetRef: 'asset_x' });

  let result = instance.applyDragToRelative(sticker.id, { x: 7, y: -3 });
  assert.deepEqual(result, { x: 1, y: 0 });
  let entry = instance.getRecipe().stickers[0];
  assert.equal(entry.pos.x, 1);
  assert.equal(entry.pos.y, 0);

  result = instance.applyDragToRelative(sticker.id, { x: -50, y: 99 });
  assert.deepEqual(result, { x: 0, y: 1 });
  entry = instance.getRecipe().stickers[0];
  assert.equal(entry.pos.x, 0);
  assert.equal(entry.pos.y, 1);

  // The sticker is retained throughout (never dropped on an out-of-range drag).
  assert.equal(instance.getRecipe().stickers.length, 1);
});

test('waveform offset clamp covers the [0, trackDuration - selectedLength] math', () => {
  const trackDuration = 30;
  const selectedLength = 12;
  const maxOffset = trackDuration - selectedLength; // 18

  assert.equal(clamp(-5, 0, maxOffset), 0); // below range -> 0
  assert.equal(clamp(25, 0, maxOffset), maxOffset); // above range -> 18
  assert.equal(clamp(7.5, 0, maxOffset), 7.5); // in range -> unchanged

  // Degenerate window (selection fills the track): only offset 0 is valid.
  assert.equal(clamp(10, 0, 0), 0);
  assert.equal(clamp(-1, 0, 0), 0);
});
