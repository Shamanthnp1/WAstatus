'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { audioStartOffset } = require('../../src/server/audioPlan');

/**
 * Property 17: Audio start offset mapping with safe fallback.
 *
 * For any recorded `audioStart`, the planned music seek equals `audioStart`
 * (within 100 ms); and for any absent or out-of-range `audioStart`, the planned
 * seek is 0 and planning completes without failure.
 *
 * Unit under test: `audioStartOffset(audioStart, trackDuration)` from
 * `src/server/audioPlan.js`.
 *
 * **Validates: Requirements 9.5, 9.6**
 */

// fast-check tolerance: the seconds value is passed through unchanged, so the
// exact match is far inside the 100 ms (0.1 s) accuracy bound of Req 9.5.
const SEEK_TOLERANCE_SECONDS = 0.1;

// Run well above the spec's >=100 generated cases minimum.
const RUNS = 300;

test('Property 17: in-range audioStart maps to the recorded offset within 100 ms', () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0.5, max: 600, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      (trackDuration, fraction) => {
        // audioStart in [0, trackDuration] is in range and must pass through.
        const audioStart = fraction * trackDuration;
        const seek = audioStartOffset(audioStart, trackDuration);
        assert.ok(
          Math.abs(seek - audioStart) <= SEEK_TOLERANCE_SECONDS,
          `expected seek ${seek} within ${SEEK_TOLERANCE_SECONDS}s of ${audioStart}`
        );
        // The pass-through is exact (well inside the 100 ms tolerance).
        assert.strictEqual(seek, audioStart);
      }
    ),
    { numRuns: RUNS }
  );
});

test('Property 17: out-of-range audioStart (negative or > trackDuration) falls back to 0', () => {
  const overshoot = fc.double({ min: Math.fround(0.001), max: 1000, noNaN: true });
  const negative = fc.double({ min: Math.fround(0.001), max: 1000, noNaN: true });

  fc.assert(
    fc.property(
      fc.double({ min: 0.5, max: 600, noNaN: true }),
      overshoot,
      negative,
      (trackDuration, over, neg) => {
        // Beyond the track end -> 0.
        assert.strictEqual(audioStartOffset(trackDuration + over, trackDuration), 0);
        // Negative -> 0 (regardless of track duration).
        assert.strictEqual(audioStartOffset(-neg, trackDuration), 0);
      }
    ),
    { numRuns: RUNS }
  );
});

test('Property 17: absent or non-numeric audioStart falls back to 0', () => {
  const absentOrNonNumeric = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constant(Number.NaN),
    fc.constant(Number.POSITIVE_INFINITY),
    fc.constant(Number.NEGATIVE_INFINITY),
    fc.string(),
    fc.boolean(),
    fc.record({}),
    fc.array(fc.anything())
  );

  fc.assert(
    fc.property(
      absentOrNonNumeric,
      fc.double({ min: 0.5, max: 600, noNaN: true }),
      (badStart, trackDuration) => {
        assert.strictEqual(audioStartOffset(badStart, trackDuration), 0);
        // Also with an unknown track duration.
        assert.strictEqual(audioStartOffset(badStart, undefined), 0);
      }
    ),
    { numRuns: RUNS }
  );
});

test('Property 17: unknown trackDuration passes through any finite non-negative audioStart', () => {
  const unknownDuration = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constant(Number.NaN),
    fc.constant(Number.POSITIVE_INFINITY),
    fc.double({ min: Math.fround(0.001), max: 1000, noNaN: true }).map((n) => -n), // negative -> unknown bound
    fc.string()
  );

  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 100000, noNaN: true }),
      unknownDuration,
      (audioStart, trackDuration) => {
        // Upper bound cannot be enforced, so a finite non-negative value passes through.
        assert.strictEqual(audioStartOffset(audioStart, trackDuration), audioStart);
      }
    ),
    { numRuns: RUNS }
  );
});

test('Property 17: unknown trackDuration still rejects negative/absent audioStart', () => {
  fc.assert(
    fc.property(
      fc.double({ min: Math.fround(0.001), max: 1000, noNaN: true }),
      (positive) => {
        assert.strictEqual(audioStartOffset(-positive, undefined), 0);
        assert.strictEqual(audioStartOffset(-positive, null), 0);
      }
    ),
    { numRuns: RUNS }
  );
});

test('Property 17: audioStartOffset never throws for arbitrary inputs', () => {
  fc.assert(
    fc.property(fc.anything(), fc.anything(), (audioStart, trackDuration) => {
      let result;
      assert.doesNotThrow(() => {
        result = audioStartOffset(audioStart, trackDuration);
      });
      // Result is always a finite, non-negative number (a valid seek offset).
      assert.ok(Number.isFinite(result), `expected finite result, got ${result}`);
      assert.ok(result >= 0, `expected non-negative result, got ${result}`);
    }),
    { numRuns: RUNS }
  );
});
