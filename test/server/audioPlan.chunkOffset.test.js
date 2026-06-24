'use strict';

/**
 * Property 19: Chunk audio offset is continuous.
 *
 * **Validates: Requirements 11.3, 11.4**
 *
 * For any `audioStart`, chunk index `i`, and `Clip_Duration_Limit`, the audio
 * offset for chunk `i` equals `audioStart + i * Clip_Duration_Limit`; and under
 * `Loop_Mode = loop` the offset advances continuously across chunk boundaries
 * without resetting to `audioStart`, so chunk `i+1` begins where chunk `i`
 * ended.
 *
 * Unit under test: `chunkAudioOffset(audioStart, chunkIndex, clipLimit, loopMode)`
 * from `src/server/audioPlan.js`. The function normalizes its inputs:
 *   - audioStart: non-finite/negative -> 0
 *   - chunkIndex: floored & clamped to >= 0 (non-finite -> 0)
 *   - clipLimit:  falls back to CLIP_DURATION_LIMIT when non-finite or <= 0
 *
 * fast-check + node:test runner. >= 100 generated cases per property.
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { chunkAudioOffset } = require('../../src/server/audioPlan');
const { CLIP_DURATION_LIMIT } = require('../../src/shared/constants');

const RUNS = 200;

/**
 * Mirror the function's documented audioStart normalization:
 * non-finite or negative -> 0, otherwise pass through.
 * @param {*} audioStart
 * @returns {number}
 */
function normalizeStart(audioStart) {
  if (!Number.isFinite(audioStart) || audioStart < 0) {
    return 0;
  }
  return audioStart;
}

// A finite, non-negative audioStart in a realistic range (seconds, ms precision).
const audioStartArb = () => fc.double({ min: 0, max: 600, noNaN: true });

// A non-negative integer chunk index.
const chunkIndexArb = () => fc.integer({ min: 0, max: 100 });

// A positive clip limit (the splitting limit is configurable; WhatsApp now
// supports up to ~90s, so cover a generous range).
const clipLimitArb = () => fc.double({ min: 0.5, max: 120, noNaN: true });

const loopModeArb = () => fc.constantFrom('loop', 'once');

test('Property 19: offset(i) equals normalize(audioStart) + i * clipLimit', () => {
  fc.assert(
    fc.property(
      audioStartArb(),
      chunkIndexArb(),
      clipLimitArb(),
      loopModeArb(),
      (audioStart, chunkIndex, clipLimit, loopMode) => {
        const offset = chunkAudioOffset(audioStart, chunkIndex, clipLimit, loopMode);
        const expected = normalizeStart(audioStart) + chunkIndex * clipLimit;
        assert.ok(
          Math.abs(offset - expected) < 1e-9,
          `offset(${chunkIndex}) = ${offset}, expected ${expected}`
        );
      }
    ),
    { numRuns: RUNS }
  );
});

test('Property 19: continuity - offset(i) + clipLimit equals offset(i+1)', () => {
  fc.assert(
    fc.property(
      audioStartArb(),
      chunkIndexArb(),
      clipLimitArb(),
      loopModeArb(),
      (audioStart, chunkIndex, clipLimit, loopMode) => {
        const cur = chunkAudioOffset(audioStart, chunkIndex, clipLimit, loopMode);
        const next = chunkAudioOffset(audioStart, chunkIndex + 1, clipLimit, loopMode);
        // Chunk i+1 begins exactly where chunk i ended: no reset to audioStart.
        assert.ok(
          Math.abs(cur + clipLimit - next) < 1e-9,
          `offset(${chunkIndex}) + clipLimit = ${cur + clipLimit}, but offset(${
            chunkIndex + 1
          }) = ${next}`
        );
      }
    ),
    { numRuns: RUNS }
  );
});

test('Property 19: under loop mode the offset is strictly monotonic increasing by clipLimit (no reset)', () => {
  fc.assert(
    fc.property(
      audioStartArb(),
      clipLimitArb(),
      fc.integer({ min: 2, max: 50 }),
      (audioStart, clipLimit, chunkCount) => {
        let prev = chunkAudioOffset(audioStart, 0, clipLimit, 'loop');
        // Chunk 0 must begin at the recorded start, never beyond it.
        assert.ok(
          Math.abs(prev - normalizeStart(audioStart)) < 1e-9,
          `chunk 0 offset ${prev} should equal audioStart ${normalizeStart(audioStart)}`
        );
        for (let i = 1; i < chunkCount; i += 1) {
          const cur = chunkAudioOffset(audioStart, i, clipLimit, 'loop');
          // Each chunk advances by exactly clipLimit: continuous, never resets.
          assert.ok(cur > prev, `offset must increase: offset(${i}) = ${cur}, prev = ${prev}`);
          assert.ok(
            Math.abs(cur - prev - clipLimit) < 1e-9,
            `offset(${i}) - offset(${i - 1}) = ${cur - prev}, expected ${clipLimit}`
          );
          assert.notStrictEqual(
            cur,
            normalizeStart(audioStart),
            `offset(${i}) must not reset to audioStart`
          );
          prev = cur;
        }
      }
    ),
    { numRuns: RUNS }
  );
});

test('Property 19: loop and once modes produce the identical offset (mode does not change arithmetic)', () => {
  fc.assert(
    fc.property(audioStartArb(), chunkIndexArb(), clipLimitArb(), (audioStart, chunkIndex, clipLimit) => {
      const loopOffset = chunkAudioOffset(audioStart, chunkIndex, clipLimit, 'loop');
      const onceOffset = chunkAudioOffset(audioStart, chunkIndex, clipLimit, 'once');
      assert.strictEqual(loopOffset, onceOffset);
    }),
    { numRuns: RUNS }
  );
});

test('Property 19: negative or non-finite audioStart normalizes the base to 0', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.double({ min: -1000, max: -0.001, noNaN: true }),
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null)
      ),
      chunkIndexArb(),
      clipLimitArb(),
      (badStart, chunkIndex, clipLimit) => {
        const offset = chunkAudioOffset(badStart, chunkIndex, clipLimit, 'loop');
        // Base falls back to 0, so offset is purely i * clipLimit.
        assert.ok(
          Math.abs(offset - chunkIndex * clipLimit) < 1e-9,
          `bad audioStart should yield base 0: offset = ${offset}, expected ${chunkIndex * clipLimit}`
        );
      }
    ),
    { numRuns: RUNS }
  );
});

test('Property 19: negative or non-finite chunkIndex clamps to the first chunk (index 0)', () => {
  fc.assert(
    fc.property(
      audioStartArb(),
      fc.oneof(
        fc.integer({ min: -1000, max: -1 }),
        fc.constantFrom(Number.NaN, Number.NEGATIVE_INFINITY, undefined, null)
      ),
      clipLimitArb(),
      (audioStart, badIndex, clipLimit) => {
        const offset = chunkAudioOffset(audioStart, badIndex, clipLimit, 'loop');
        // Index clamps to 0, so the offset is just the normalized start.
        assert.ok(
          Math.abs(offset - normalizeStart(audioStart)) < 1e-9,
          `bad chunkIndex should clamp to 0: offset = ${offset}, expected ${normalizeStart(audioStart)}`
        );
      }
    ),
    { numRuns: RUNS }
  );
});

test('Property 19: fractional chunkIndex is floored before scaling', () => {
  fc.assert(
    fc.property(
      audioStartArb(),
      fc.double({ min: 0, max: 100, noNaN: true }),
      clipLimitArb(),
      (audioStart, fractionalIndex, clipLimit) => {
        const offset = chunkAudioOffset(audioStart, fractionalIndex, clipLimit, 'loop');
        const expected = normalizeStart(audioStart) + Math.floor(fractionalIndex) * clipLimit;
        assert.ok(
          Math.abs(offset - expected) < 1e-9,
          `fractional index ${fractionalIndex} should floor: offset = ${offset}, expected ${expected}`
        );
      }
    ),
    { numRuns: RUNS }
  );
});

test('Property 19: invalid clipLimit falls back to CLIP_DURATION_LIMIT', () => {
  fc.assert(
    fc.property(
      audioStartArb(),
      chunkIndexArb(),
      fc.oneof(
        fc.double({ min: -1000, max: 0, noNaN: true }),
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null)
      ),
      (audioStart, chunkIndex, badLimit) => {
        const offset = chunkAudioOffset(audioStart, chunkIndex, badLimit, 'loop');
        const expected = normalizeStart(audioStart) + chunkIndex * CLIP_DURATION_LIMIT;
        assert.ok(
          Math.abs(offset - expected) < 1e-9,
          `bad clipLimit should default to ${CLIP_DURATION_LIMIT}: offset = ${offset}, expected ${expected}`
        );
      }
    ),
    { numRuns: RUNS }
  );
});

test('Property 19: result is always finite and >= the normalized base', () => {
  fc.assert(
    fc.property(
      fc.oneof(audioStartArb(), fc.constantFrom(Number.NaN, -5, undefined, null)),
      fc.oneof(chunkIndexArb(), fc.constantFrom(-3, Number.NaN, undefined)),
      fc.oneof(clipLimitArb(), fc.constantFrom(0, -1, Number.NaN)),
      loopModeArb(),
      (audioStart, chunkIndex, clipLimit, loopMode) => {
        const offset = chunkAudioOffset(audioStart, chunkIndex, clipLimit, loopMode);
        assert.ok(Number.isFinite(offset), `offset must be finite, got ${offset}`);
        assert.ok(offset >= normalizeStart(audioStart), `offset ${offset} must be >= base`);
      }
    ),
    { numRuns: RUNS }
  );
});
