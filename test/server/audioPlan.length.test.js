'use strict';

/**
 * Property 18: Rendered audio length always equals output duration.
 *
 * **Validates: Requirements 10.1, 10.2, 10.3, 10.5, 10.6, 10.7, 10.8, 11.6, 11.7**
 *
 * For any music configuration and output duration, the rendered audio length
 * (`audioRenderedLength`) equals the output video duration (clamped to 0 for a
 * non-positive or non-finite output duration). The audible music portion
 * (`audioAudiblePortion`) follows the loop/once case table:
 *
 * | case                                   | audible portion  | requirement     |
 * | -------------------------------------- | ---------------- | --------------- |
 * | no resolved music                      | 0                | —               |
 * | `|m - D| <= tolerance` (equal)         | `m`  (play once) | 10.8            |
 * | `m > D` (longer)                       | `D`  (truncate)  | 10.1, 10.7      |
 * | `m < D`, loopMode `once`               | `m`  then silence| 10.6, 11.6, 11.7|
 * | `m < D`, loopMode `loop` (default)     | `D`  (fill)      | 10.2, 10.3, 10.5|
 *
 * When the music is shorter than the output and no loop preference is set, the
 * mode defaults to `loop` (Req 10.3), so the audible portion fills the output.
 *
 * Units under test: `audioRenderedLength(audio, outDuration)` and
 * `audioAudiblePortion(audio, outDuration)` from `src/server/audioPlan.js`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const {
  audioRenderedLength,
  audioAudiblePortion,
} = require('../../src/server/audioPlan');
const { AUDIO_EQUAL_TOLERANCE_SECONDS } = require('../../src/shared/constants');

const TOL = AUDIO_EQUAL_TOLERANCE_SECONDS;
const NUM_RUNS = 300;

/* ------------------------------------------------------------------------- *
 * Oracles derived from the requirement case table (not the implementation). *
 * ------------------------------------------------------------------------- */

/**
 * Expected rendered audio length: the output duration, clamped to 0 when the
 * output duration is non-finite or non-positive.
 * @param {*} outDuration
 * @returns {number}
 */
function expectedRenderedLength(outDuration) {
  if (!Number.isFinite(outDuration) || outDuration <= 0) {
    return 0;
  }
  return outDuration;
}

/**
 * Expected audible music portion per the loop/once case table.
 * @param {number|null} segment - resolved music segment length, or null/<=0 when none.
 * @param {boolean} hasMusic - whether music is present/resolved.
 * @param {('loop'|'once'|undefined)} loopMode - recorded loop mode.
 * @param {*} outDuration - output video duration.
 * @returns {number}
 */
function expectedAudiblePortion(segment, hasMusic, loopMode, outDuration) {
  const D = expectedRenderedLength(outDuration);
  if (D === 0) return 0;
  if (!hasMusic || !(Number.isFinite(segment) && segment > 0)) return 0;
  if (Math.abs(segment - D) <= TOL) return segment; // equal-within-tolerance (10.8)
  if (segment > D) return D; // longer => truncate (10.1, 10.7)
  // shorter than output:
  return loopMode === 'once' ? segment : D; // once (10.6) vs loop/default (10.3, 10.5)
}

/* ------------------------------------------------------------------------- *
 * Generators                                                                *
 * ------------------------------------------------------------------------- */

/** Field name under which the music segment length is recorded on the audio info. */
const segmentFieldArb = fc.constantFrom(
  'musicDuration',
  'musicSegmentDuration',
  'segmentDuration',
  'trackDuration'
);

/** loopMode: explicit loop/once, or unset (to exercise the default-loop path). */
const loopModeArb = fc.constantFrom('loop', 'once', undefined);

/**
 * Build an audio info object placing `segment` under a randomly chosen field
 * name, with the given hasMusic flag and (optional) loop mode.
 */
function buildAudio(field, segment, hasMusic, loopMode) {
  const audio = { hasMusic };
  if (segment !== undefined) {
    audio[field] = segment;
  }
  if (loopMode !== undefined) {
    audio.loopMode = loopMode;
  }
  return audio;
}

/* ------------------------------------------------------------------------- *
 * Properties                                                                *
 * ------------------------------------------------------------------------- */

test('Property 18: rendered length equals output duration; audible portion matches the case table (music present)', () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0.1, max: 600, noNaN: true }), // outDuration
      fc.double({ min: 0.1, max: 900, noNaN: true }), // music segment (shorter/longer span)
      segmentFieldArb,
      loopModeArb,
      (outDuration, segment, field, loopMode) => {
        const audio = buildAudio(field, segment, true, loopMode);

        // Rendered length always equals the output duration.
        assert.strictEqual(
          audioRenderedLength(audio, outDuration),
          outDuration,
          `rendered length should equal outDuration=${outDuration}`
        );

        // Audible portion follows the loop/once case table.
        const audible = audioAudiblePortion(audio, outDuration);
        assert.strictEqual(
          audible,
          expectedAudiblePortion(segment, true, loopMode, outDuration),
          `audible mismatch segment=${segment} field=${field} loopMode=${loopMode} out=${outDuration}`
        );

        // The audible portion never exceeds the rendered length by more than
        // the equal-tolerance window (Req 10.8 plays a near-equal segment once
        // without truncation, so it may run up to TOL beyond the output).
        assert.ok(audible <= audioRenderedLength(audio, outDuration) + TOL + 1e-9);
      }
    ),
    { numRuns: NUM_RUNS }
  );
});

test('Property 18: equal-within-tolerance music plays once (no looping, no truncation) (Req 10.8)', () => {
  fc.assert(
    fc.property(
      fc.double({ min: 1, max: 600, noNaN: true }), // outDuration (>= 1 so segment stays positive)
      fc.double({ min: -(TOL * 0.9), max: TOL * 0.9, noNaN: true }), // delta safely within tolerance
      segmentFieldArb,
      loopModeArb,
      (outDuration, delta, field, loopMode) => {
        const segment = outDuration + delta; // |segment - outDuration| < TOL (with float margin)
        const audio = buildAudio(field, segment, true, loopMode);

        assert.strictEqual(audioRenderedLength(audio, outDuration), outDuration);
        // Plays exactly once: audible portion equals the segment itself.
        assert.strictEqual(
          audioAudiblePortion(audio, outDuration),
          segment,
          `equal-within-tolerance should play once: segment=${segment} out=${outDuration}`
        );
      }
    ),
    { numRuns: NUM_RUNS }
  );
});

test('Property 18: music shorter than output loops to fill, plays once under "once" (Req 10.3, 10.5, 10.6)', () => {
  fc.assert(
    fc.property(
      fc.double({ min: 1, max: 600, noNaN: true }), // outDuration
      fc.double({ min: 0.001, max: 0.99, noNaN: true }), // fraction of (outDuration - margin)
      segmentFieldArb,
      (outDuration, frac, field) => {
        // A segment strictly shorter than the output by more than the tolerance.
        const usable = outDuration - (TOL + 0.01);
        if (usable <= 0.001) {
          return true; // skip degenerate window
        }
        const segment = Math.max(0.001, usable * frac);

        // loop / default => fill the full output duration.
        for (const loopMode of ['loop', undefined]) {
          const audio = buildAudio(field, segment, true, loopMode);
          assert.strictEqual(audioRenderedLength(audio, outDuration), outDuration);
          assert.strictEqual(
            audioAudiblePortion(audio, outDuration),
            outDuration,
            `loop/default should fill: segment=${segment} out=${outDuration} loopMode=${loopMode}`
          );
        }

        // once => play the segment once, then silence (audible portion = segment).
        const onceAudio = buildAudio(field, segment, true, 'once');
        assert.strictEqual(audioRenderedLength(onceAudio, outDuration), outDuration);
        assert.strictEqual(
          audioAudiblePortion(onceAudio, outDuration),
          segment,
          `once should play segment then silence: segment=${segment} out=${outDuration}`
        );
        return true;
      }
    ),
    { numRuns: NUM_RUNS }
  );
});

test('Property 18: music longer than output is truncated to the output duration (Req 10.1, 10.7)', () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0.1, max: 600, noNaN: true }), // outDuration
      fc.double({ min: 0.06, max: 600, noNaN: true }), // extra length beyond output (> tolerance)
      segmentFieldArb,
      loopModeArb,
      (outDuration, extra, field, loopMode) => {
        const segment = outDuration + extra; // strictly longer than output by > TOL
        const audio = buildAudio(field, segment, true, loopMode);

        assert.strictEqual(audioRenderedLength(audio, outDuration), outDuration);
        assert.strictEqual(
          audioAudiblePortion(audio, outDuration),
          outDuration,
          `longer music should truncate to outDuration: segment=${segment} out=${outDuration}`
        );
        return true;
      }
    ),
    { numRuns: NUM_RUNS }
  );
});

test('Property 18: no music yields zero audible portion but full rendered length', () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0.1, max: 600, noNaN: true }),
      fc.option(fc.double({ min: 0.1, max: 600, noNaN: true }), { nil: undefined }),
      segmentFieldArb,
      loopModeArb,
      (outDuration, segment, field, loopMode) => {
        // hasMusic === false is authoritative: no audible music even if a
        // segment length happens to be present on the object.
        const audio = buildAudio(field, segment, false, loopMode);

        assert.strictEqual(audioRenderedLength(audio, outDuration), outDuration);
        assert.strictEqual(
          audioAudiblePortion(audio, outDuration),
          0,
          `no music => zero audible portion (out=${outDuration})`
        );
        return true;
      }
    ),
    { numRuns: NUM_RUNS }
  );
});

test('Property 18: non-positive or non-finite output duration clamps rendered length and audible portion to 0', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(0, -0.5, -100, NaN, Infinity, -Infinity),
      fc.double({ min: 0.1, max: 600, noNaN: true }), // music segment
      segmentFieldArb,
      loopModeArb,
      fc.boolean(),
      (outDuration, segment, field, loopMode, hasMusic) => {
        const audio = buildAudio(field, segment, hasMusic, loopMode);

        assert.strictEqual(
          audioRenderedLength(audio, outDuration),
          0,
          `non-positive/non-finite outDuration should render length 0 (out=${outDuration})`
        );
        assert.strictEqual(
          audioAudiblePortion(audio, outDuration),
          0,
          `non-positive/non-finite outDuration should have 0 audible (out=${outDuration})`
        );
        return true;
      }
    ),
    { numRuns: NUM_RUNS }
  );
});
