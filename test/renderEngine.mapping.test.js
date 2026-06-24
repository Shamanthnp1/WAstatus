'use strict';

/**
 * Property 12: Relative-to-pixel mapping is accurate within tolerance.
 *
 * For any relative coordinate, scale, and rotation, the planned pixel position
 * is within 1% of `rel × dimension` per axis on the 1080×1920 canvas, the
 * planned scale is within 1% of the recipe scale, and the planned rotation is
 * within 1 degree of the recipe rotation.
 *
 * **Validates: Requirements 5.8, 6.7**
 *
 * Units under test (pure planning core, src/server/renderEngine.js):
 *   - mapRelToPixels(relX, relY, w, h)
 *   - mapOverlayTransform(overlay, canvasW, canvasH)
 *   - degToRad(degrees)
 *
 * The canvas is the fixed WhatsApp_Spec output: CANVAS_WIDTH=1080,
 * CANVAS_HEIGHT=1920. Because mapRelToPixels rounds to integer pixels, the
 * per-axis position can differ from the ideal `rel × dimension` by up to 0.5px
 * even when 1% of that ideal is smaller. The tolerance therefore accounts for
 * rounding: |actual - ideal| <= max(1% of ideal, 0.5).
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  mapRelToPixels,
  mapOverlayTransform,
  degToRad,
} = require('../src/server/renderEngine');

// Generators constrained to the documented input space.
const relCoord = () => fc.double({ min: 0, max: 1, noNaN: true });
const scaleArb = () => fc.double({ min: 0.1, max: 5.0, noNaN: true });
const rotationArb = () => fc.double({ min: 0, max: 360, noNaN: true });

const NUM_RUNS = 200; // >= 100 generated cases per task requirement.

/**
 * Per-axis position tolerance: 1% of the ideal value, but never less than the
 * 0.5px maximum error introduced by Math.round in mapRelToPixels.
 * @param {number} ideal - rel * dimension
 * @returns {number}
 */
function positionTolerance(ideal) {
  return Math.max(0.01 * ideal, 0.5);
}

test('Property 12: mapRelToPixels lands within 1% (accounting for rounding) per axis', () => {
  fc.assert(
    fc.property(relCoord(), relCoord(), (relX, relY) => {
      const { x, y } = mapRelToPixels(relX, relY, CANVAS_WIDTH, CANVAS_HEIGHT);

      const idealX = relX * CANVAS_WIDTH;
      const idealY = relY * CANVAS_HEIGHT;

      assert.ok(Number.isInteger(x), `x should be an integer pixel, got ${x}`);
      assert.ok(Number.isInteger(y), `y should be an integer pixel, got ${y}`);

      assert.ok(
        Math.abs(x - idealX) <= positionTolerance(idealX),
        `x=${x} not within tolerance of ideal ${idealX} (relX=${relX})`
      );
      assert.ok(
        Math.abs(y - idealY) <= positionTolerance(idealY),
        `y=${y} not within tolerance of ideal ${idealY} (relY=${relY})`
      );
    }),
    { numRuns: NUM_RUNS }
  );
});

test('Property 12: mapOverlayTransform center is within tolerance, scale within 1%, rotation within 1 degree', () => {
  fc.assert(
    fc.property(relCoord(), relCoord(), scaleArb(), rotationArb(), (relX, relY, scale, rotation) => {
      const overlay = { pos: { x: relX, y: relY }, scale, rotation };
      const transform = mapOverlayTransform(overlay, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Center position within 1% (accounting for rounding) per axis.
      const idealX = relX * CANVAS_WIDTH;
      const idealY = relY * CANVAS_HEIGHT;
      assert.ok(
        Math.abs(transform.center.x - idealX) <= positionTolerance(idealX),
        `center.x=${transform.center.x} not within tolerance of ideal ${idealX}`
      );
      assert.ok(
        Math.abs(transform.center.y - idealY) <= positionTolerance(idealY),
        `center.y=${transform.center.y} not within tolerance of ideal ${idealY}`
      );

      // Scale passed through within 1% of the recipe scale.
      assert.ok(
        Math.abs(transform.scale - scale) <= 0.01 * scale,
        `scale=${transform.scale} not within 1% of recipe scale ${scale}`
      );

      // Rotation (degrees) within 1 degree of the recipe rotation.
      assert.ok(
        Math.abs(transform.rotationDeg - rotation) <= 1,
        `rotationDeg=${transform.rotationDeg} not within 1 degree of recipe rotation ${rotation}`
      );

      // Radians must match degToRad of the recipe rotation exactly.
      assert.strictEqual(
        transform.rotationRad,
        degToRad(rotation),
        `rotationRad=${transform.rotationRad} != degToRad(${rotation})=${degToRad(rotation)}`
      );
    }),
    { numRuns: NUM_RUNS }
  );
});

test('Property 12: degToRad converts degrees to radians (degrees * PI / 180)', () => {
  fc.assert(
    fc.property(rotationArb(), (rotation) => {
      assert.strictEqual(degToRad(rotation), (rotation * Math.PI) / 180);
    }),
    { numRuns: NUM_RUNS }
  );
});
