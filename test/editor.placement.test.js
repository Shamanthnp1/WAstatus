'use strict';

/**
 * Property 6: Recorded overlay placement is complete and within range.
 *
 * For any sequence of editor placement and transform gestures on a text overlay
 * or sticker, the recorded recipe entry contains all required fields and every
 * recorded value is within its range:
 *   - position in [0, 1] per axis
 *   - rotation in [0, 360]
 *   - sticker scale in [0.1, 5.0]
 *   - text fontSize in [8, 200]
 *
 * Unit under test: public/js/editor.js (CommonJS UMD export). Random gesture
 * sequences (drag targets and transform/pinch values that may be far out of
 * range) are applied to text overlays and stickers via the EditorInstance
 * methods addTextOverlay/addSticker/applyDragToRelative/applyTransform/
 * applyPinch, then getRecipe() is inspected for completeness and range.
 *
 * Validates: Requirements 2.2, 2.3, 5.3, 5.4, 5.5, 6.2, 6.3, 6.4
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const Editor = require('../public/js/editor');

const { EditorInstance, LIMITS } = Editor;

// At least this many generated gesture sequences per property (design.md note).
const NUM_RUNS = 200;

/* ------------------------------------------------------------------------- *
 * Generators
 *
 * Gestures intentionally include values far outside their valid ranges
 * (negative coordinates, scales > 5, fontSizes > 200, rotations beyond 360,
 * and even non-finite values) so the property exercises the clamp/normalize
 * paths and proves the RECORDED value always lands in range.
 * ------------------------------------------------------------------------- */

/** A possibly-out-of-range scalar, occasionally non-finite. */
function wildNumber(min, max) {
  return fc.oneof(
    { weight: 9, arbitrary: fc.double({ min, max, noNaN: true }) },
    { weight: 1, arbitrary: fc.constantFrom(NaN, Infinity, -Infinity) }
  );
}

/** A relative drag target that may fall well outside [0, 1]. */
const dragTarget = () =>
  fc.record({
    x: wildNumber(-5, 5),
    y: wildNumber(-5, 5),
  });

/** A transform with absolute scale/fontSize/rotation that may be out of range. */
const transformGesture = () =>
  fc.record(
    {
      scale: wildNumber(-10, 20),
      fontSize: wildNumber(-50, 500),
      rotation: wildNumber(-720, 1080),
    },
    { requiredKeys: [] } // any subset of fields may be present
  );

/** A multiplicative pinch (factor) plus a rotation delta in degrees. */
const pinchGesture = () =>
  fc.record({
    factor: wildNumber(-3, 25),
    rotationDelta: wildNumber(-720, 720),
  });

/** A single gesture applied to an existing entry. */
const gesture = () =>
  fc.oneof(
    fc.record({ kind: fc.constant('drag'), drag: dragTarget() }),
    fc.record({ kind: fc.constant('transform'), transform: transformGesture() }),
    fc.record({ kind: fc.constant('pinch'), pinch: pinchGesture() })
  );

/** Valid text content (1..200 chars) so the overlay is actually added. */
const validText = () =>
  fc.string({ minLength: LIMITS.TEXT_LENGTH_MIN, maxLength: LIMITS.TEXT_LENGTH_MAX });

/** A non-empty asset reference for a sticker. */
const assetRef = () =>
  fc.string({ minLength: 1, maxLength: 16 }).map((s) => `asset_${s.replace(/\s/g, '_') || 'x'}`);

/** A single element to create (text overlay or sticker) plus its gestures. */
const element = () =>
  fc.oneof(
    fc.record({
      type: fc.constant('text'),
      text: validText(),
      gestures: fc.array(gesture(), { minLength: 0, maxLength: 8 }),
    }),
    fc.record({
      type: fc.constant('sticker'),
      assetRef: assetRef(),
      gestures: fc.array(gesture(), { minLength: 0, maxLength: 8 }),
    })
  );

/** A whole editor session: one or more elements, each with a gesture sequence. */
const session = () => fc.array(element(), { minLength: 1, maxLength: 6 });

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

function applyGesture(instance, id, g) {
  if (g.kind === 'drag') {
    instance.applyDragToRelative(id, g.drag);
  } else if (g.kind === 'transform') {
    instance.applyTransform(id, g.transform);
  } else if (g.kind === 'pinch') {
    instance.applyPinch(id, g.pinch.factor, g.pinch.rotationDelta);
  }
}

/** Build an EditorInstance from a generated session and return its recipe. */
function runSession(elements) {
  const instance = new EditorInstance(0, { uploadKey: 'upload/k' });
  for (const el of elements) {
    let id = null;
    if (el.type === 'text') {
      const res = instance.addTextOverlay({ text: el.text });
      assert.ok(res.ok, 'valid text overlay should be added');
      id = res.overlay.id;
    } else {
      const res = instance.addSticker({ assetRef: el.assetRef });
      assert.ok(res.ok, 'sticker with assetRef should be added');
      id = res.sticker.id;
    }
    for (const g of el.gestures) {
      applyGesture(instance, id, g);
    }
  }
  return instance.getRecipe();
}

function assertInRange(value, min, max, label) {
  assert.equal(typeof value, 'number', `${label} must be a number`);
  assert.ok(Number.isFinite(value), `${label} must be finite, got ${value}`);
  assert.ok(value >= min && value <= max, `${label} ${value} out of [${min}, ${max}]`);
}

function assertTextOverlayComplete(o) {
  // All required fields present.
  assert.equal(typeof o.id, 'string');
  assert.ok(o.id.length > 0, 'text overlay id must be non-empty');
  assert.equal(typeof o.text, 'string');
  assert.ok(
    o.text.length >= LIMITS.TEXT_LENGTH_MIN && o.text.length <= LIMITS.TEXT_LENGTH_MAX,
    `text length ${o.text.length} out of [1, 200]`
  );
  assert.equal(typeof o.textColor, 'string');
  assert.ok(o.textColor.length > 0, 'textColor must be present');
  assert.equal(typeof o.bgColor, 'string');
  assert.ok(o.bgColor.length > 0, 'bgColor must be present');
  assert.equal(typeof o.font, 'string');
  assert.ok(o.font.length > 0, 'font must be present');
  assert.ok(o.pos && typeof o.pos === 'object', 'pos must be present');

  // Every recorded value within its range.
  assertInRange(o.pos.x, LIMITS.COORD_MIN, LIMITS.COORD_MAX, 'text pos.x');
  assertInRange(o.pos.y, LIMITS.COORD_MIN, LIMITS.COORD_MAX, 'text pos.y');
  assertInRange(o.rotation, LIMITS.ROTATION_MIN, LIMITS.ROTATION_MAX, 'text rotation');
  assertInRange(o.fontSize, LIMITS.FONT_SIZE_MIN, LIMITS.FONT_SIZE_MAX, 'text fontSize');
}

function assertStickerComplete(s) {
  assert.equal(typeof s.id, 'string');
  assert.ok(s.id.length > 0, 'sticker id must be non-empty');
  assert.equal(typeof s.assetRef, 'string');
  assert.ok(s.assetRef.length > 0, 'sticker assetRef must be non-empty');
  assert.ok(s.pos && typeof s.pos === 'object', 'pos must be present');

  assertInRange(s.pos.x, LIMITS.COORD_MIN, LIMITS.COORD_MAX, 'sticker pos.x');
  assertInRange(s.pos.y, LIMITS.COORD_MIN, LIMITS.COORD_MAX, 'sticker pos.y');
  assertInRange(s.rotation, LIMITS.ROTATION_MIN, LIMITS.ROTATION_MAX, 'sticker rotation');
  assertInRange(s.scale, LIMITS.SCALE_MIN, LIMITS.SCALE_MAX, 'sticker scale');
}

/* ------------------------------------------------------------------------- *
 * Property 6
 * ------------------------------------------------------------------------- */

test('Property 6: recorded overlay placement is complete and within range', () => {
  fc.assert(
    fc.property(session(), (elements) => {
      const recipe = runSession(elements);

      // Any added element makes the recipe dirty, so it is never null here.
      assert.ok(recipe, 'recipe should be recorded after adding elements');
      assert.ok(Array.isArray(recipe.textOverlays));
      assert.ok(Array.isArray(recipe.stickers));

      for (const o of recipe.textOverlays) assertTextOverlayComplete(o);
      for (const s of recipe.stickers) assertStickerComplete(s);
    }),
    { numRuns: NUM_RUNS }
  );
});

/* ------------------------------------------------------------------------- *
 * Focused unit checks — explicit out-of-range gestures clamp into range.
 * ------------------------------------------------------------------------- */

test('extreme drag targets clamp position into [0, 1]', () => {
  const instance = new EditorInstance(0);
  const { sticker } = instance.addSticker({ assetRef: 'asset_x' });

  instance.applyDragToRelative(sticker.id, { x: 9, y: -4 });
  let recorded = instance.getRecipe().stickers[0];
  assert.equal(recorded.pos.x, 1);
  assert.equal(recorded.pos.y, 0);

  instance.applyDragToRelative(sticker.id, { x: -100, y: 50 });
  recorded = instance.getRecipe().stickers[0];
  assert.equal(recorded.pos.x, 0);
  assert.equal(recorded.pos.y, 1);
});

test('extreme transforms clamp sticker scale and rotation into range', () => {
  const instance = new EditorInstance(0);
  const { sticker } = instance.addSticker({ assetRef: 'asset_x' });

  instance.applyTransform(sticker.id, { scale: 999, rotation: 725 });
  let recorded = instance.getRecipe().stickers[0];
  assert.equal(recorded.scale, LIMITS.SCALE_MAX); // clamped to 5.0
  assert.ok(recorded.rotation >= 0 && recorded.rotation <= 360); // 725 -> wrapped to 5

  instance.applyTransform(sticker.id, { scale: -10 });
  recorded = instance.getRecipe().stickers[0];
  assert.equal(recorded.scale, LIMITS.SCALE_MIN); // clamped to 0.1
});

test('extreme transforms clamp text fontSize into [8, 200]', () => {
  const instance = new EditorInstance(0);
  const { overlay } = instance.addTextOverlay({ text: 'hello' });

  instance.applyTransform(overlay.id, { fontSize: 5000 });
  assert.equal(instance.getRecipe().textOverlays[0].fontSize, LIMITS.FONT_SIZE_MAX);

  instance.applyTransform(overlay.id, { fontSize: -3 });
  assert.equal(instance.getRecipe().textOverlays[0].fontSize, LIMITS.FONT_SIZE_MIN);
});

test('pinch factors keep scale/fontSize within range', () => {
  const instance = new EditorInstance(0);
  const { sticker } = instance.addSticker({ assetRef: 'asset_x' });
  const { overlay } = instance.addTextOverlay({ text: 'hi' });

  instance.applyPinch(sticker.id, 1000, 90);
  assert.equal(instance.getRecipe().stickers[0].scale, LIMITS.SCALE_MAX);

  instance.applyPinch(overlay.id, 1000, 90);
  assert.equal(instance.getRecipe().textOverlays[0].fontSize, LIMITS.FONT_SIZE_MAX);
});
