'use strict';

/**
 * Property test for task 13.4 — Property 16: Waveform default length and
 * recorded start.
 *
 * **Property 16: Waveform default length and recorded start**
 * **Validates: Requirements 9.1, 9.2, 9.4**
 *
 * For any selected music track:
 *   - the default Waveform_Window has offset 0 and length equal to the lesser
 *     of the configured clip length and the track duration (Req 9.1); and
 *   - for any valid window release, the recorded `audioStart` equals the
 *     selected offset (seconds, millisecond precision) within
 *     [0, trackDuration - selectedLength], snapped to a ≤100 ms grid (Req 9.2,
 *     9.4).
 *
 * The units under test are the pure, DOM-free helpers exported by
 * public/js/editorAudio.js, operating on an EditorInstance from
 * public/js/editor.js. A music track is added via addMusicTrack first so
 * setAudioStart has a track to write.
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const editor = require('../public/js/editor');
const audio = require('../public/js/editorAudio');

const {
  defaultWaveformWindow,
  clampWaveformOffset,
  quantizeToMs,
  roundToMsPrecision,
  setAudioStart,
  getAudioStart,
  addMusicTrack,
} = audio;
const { EditorInstance } = editor;

/** The Waveform_Window drag grid: 100 ms = 0.1 s (Req 9.2). */
const STEP_SECONDS = 0.1;
/** Float tolerance for comparisons against quantized/clamped reals. */
const EPS = 1e-6;

/** Build a fresh EditorInstance with exactly one music track recorded. */
function instanceWithMusic() {
  const instance = new EditorInstance(0);
  const result = addMusicTrack(instance, { assetRef: 'asset_test', source: 'upload' });
  assert.equal(result.ok, true, 'precondition: a music track must be added');
  return instance;
}

/** A positive, finite clip length in seconds (varied around the track range). */
const clipLengthArb = () => fc.double({ min: 0.5, max: 120, noNaN: true });

/** A positive, finite track duration in seconds. */
const trackDurationArb = () => fc.double({ min: 0.5, max: 600, noNaN: true });

/**
 * A requested drag offset that deliberately ranges below 0 and well past the
 * end of any generated track, so both in-range and out-of-range releases occur.
 */
const requestedOffsetArb = () => fc.double({ min: -120, max: 720, noNaN: true });

test('Property 16: default waveform window is offset 0, length = min(clip, trackDuration)', () => {
  fc.assert(
    fc.property(clipLengthArb(), trackDurationArb(), (clipLength, trackDuration) => {
      const win = defaultWaveformWindow(clipLength, trackDuration);

      // Req 9.1: the default window always starts at offset 0.
      assert.strictEqual(win.offset, 0, 'default window offset must be 0');

      // Req 9.1: default length is the lesser of clip length and track duration.
      const expectedLength = Math.min(clipLength, trackDuration);
      assert.ok(
        Math.abs(win.length - expectedLength) < EPS,
        `default length ${win.length} must equal min(clip=${clipLength}, dur=${trackDuration})=${expectedLength}`
      );

      // The selected length never exceeds the track and is non-negative.
      assert.ok(win.length >= 0, 'length must be non-negative');
      assert.ok(win.length <= trackDuration + EPS, 'length must not exceed the track duration');
    }),
    { numRuns: 250 }
  );
});

test('Property 16: recorded audioStart is the nearest valid quantized offset with ms precision', () => {
  fc.assert(
    fc.property(
      clipLengthArb(),
      trackDurationArb(),
      requestedOffsetArb(),
      (clipLength, trackDuration, requestedOffset) => {
        const instance = instanceWithMusic();

        // The selected length is the default window length for this track.
        const win = defaultWaveformWindow(clipLength, trackDuration);
        const selectedLength = win.length;

        const release = setAudioStart(instance, requestedOffset, trackDuration, selectedLength);
        assert.equal(release.ok, true, 'a track is present, so the release must record');

        const recorded = release.audioStart;
        // getAudioStart reflects the same recorded value (Req 9.4).
        assert.ok(
          Math.abs(getAudioStart(instance) - recorded) < EPS,
          'getAudioStart must reflect the recorded audioStart'
        );

        // Req 9.3/9.2: recorded offset lies in [0, trackDuration - selectedLength].
        const maxOffset = roundToMsPrecision(Math.max(0, trackDuration - selectedLength));
        assert.ok(recorded >= 0, `recorded ${recorded} must be >= 0`);
        assert.ok(
          recorded <= maxOffset + EPS,
          `recorded ${recorded} must be <= maxOffset ${maxOffset}`
        );

        // Req 9.4: millisecond precision — value has at most 3 decimal places.
        const ms = recorded * 1000;
        assert.ok(
          Math.abs(ms - Math.round(ms)) < 1e-3,
          `recorded ${recorded} must have millisecond precision`
        );

        // Req 9.2: snapped to the ≤100 ms grid, or pinned to the clamp boundary
        // (a quantize step can round just past the valid maximum, which is then
        // re-clamped to the in-range maximum).
        const onGrid = Math.abs(recorded / STEP_SECONDS - Math.round(recorded / STEP_SECONDS)) < 1e-6;
        const atBoundary = Math.abs(recorded - maxOffset) < EPS;
        assert.ok(
          onGrid || atBoundary,
          `recorded ${recorded} must sit on the 100ms grid or at the clamp boundary ${maxOffset}`
        );

        // Req 9.2/9.3: the recorded value is the NEAREST valid offset to the
        // in-range requested target — within half a grid step (50 ms).
        const clampedTarget = clampWaveformOffset(requestedOffset, trackDuration, selectedLength);
        assert.ok(
          Math.abs(recorded - clampedTarget) <= STEP_SECONDS / 2 + EPS,
          `recorded ${recorded} must be within 50ms of the clamped target ${clampedTarget}`
        );

        // Cross-check the recorded value against the documented composition of
        // the exported helpers (clamp -> quantize -> re-clamp -> ms precision).
        const expected = roundToMsPrecision(
          clampWaveformOffset(
            quantizeToMs(clampWaveformOffset(requestedOffset, trackDuration, selectedLength), 100),
            trackDuration,
            selectedLength
          )
        );
        assert.ok(
          Math.abs(recorded - expected) < EPS,
          `recorded ${recorded} must equal the quantized/clamped expectation ${expected}`
        );
      }
    ),
    { numRuns: 250 }
  );
});
