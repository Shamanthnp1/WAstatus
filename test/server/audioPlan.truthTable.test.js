'use strict';

/**
 * Property 13: Audio plan matches the mute/music truth table.
 *
 * **Validates: Requirements 7.5, 7.6, 7.7, 7.8**
 *
 * For any audio configuration, the audio plan selected by `planAudio` follows
 * the mute x music truth table, where `hasMusic` (not the recipe's `music`
 * sub-object) is authoritative:
 *
 * | originalMuted | hasMusic | mode      | output audio                          |
 * | ------------- | -------- | --------- | ------------------------------------- |
 * | true          | true     | music     | music only at its volume (7.5)        |
 * | false         | true     | mix       | amix(original, music) each vol (7.6)  |
 * | true          | false    | silence   | zero-amplitude full duration (7.7)    |
 * | false         | false    | original  | original only at its volume (7.8)     |
 *
 * Volumes are carried through: `originalVolume` always; `musicVolume` whenever
 * `hasMusic` is true.
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { planAudio, AUDIO_MODE } = require('../../src/server/audioPlan');

/**
 * Mirror of audioPlan's internal volume normalization: clamp to integer
 * [0, 100], defaulting a missing/non-numeric value to 100. Used to compute the
 * expected volume carried into the plan.
 * @param {*} volume
 * @returns {number}
 */
function expectedVolume(volume) {
  if (!Number.isFinite(volume)) {
    return 100;
  }
  const rounded = Math.round(volume);
  if (rounded < 0) return 0;
  if (rounded > 100) return 100;
  return rounded;
}

/** The expected truth-table mode for a (muted, hasMusic) combination. */
function expectedMode(originalMuted, hasMusic) {
  if (hasMusic) {
    return originalMuted ? AUDIO_MODE.MUSIC : AUDIO_MODE.MIX;
  }
  return originalMuted ? AUDIO_MODE.SILENCE : AUDIO_MODE.ORIGINAL;
}

/**
 * A random audioConfig: `{ originalMuted, originalVolume, music? }`. The music
 * sub-object is independent of the authoritative `hasMusic` flag so we exercise
 * stale/unresolved-reference cases (music present but hasMusic false, and vice
 * versa).
 */
function audioConfigArb() {
  const music = fc.record({
    volume: fc.integer({ min: 0, max: 100 }),
    audioStart: fc.double({ min: 0, max: 600, noNaN: true }),
    loopMode: fc.constantFrom('loop', 'once'),
  });
  const base = {
    originalMuted: fc.boolean(),
    originalVolume: fc.integer({ min: 0, max: 100 }),
  };
  return fc.oneof(
    fc.record(base),
    fc.record({ ...base, music })
  );
}

test('Property 13: plan.mode follows the mute x music truth table for all 4 combinations', () => {
  fc.assert(
    fc.property(audioConfigArb(), fc.boolean(), (audioConfig, hasMusic) => {
      const plan = planAudio(audioConfig, hasMusic);
      assert.strictEqual(
        plan.mode,
        expectedMode(audioConfig.originalMuted === true, hasMusic === true),
        `mode mismatch for originalMuted=${audioConfig.originalMuted}, hasMusic=${hasMusic}`
      );
      // hasMusic is reflected (and authoritative) in the plan.
      assert.strictEqual(plan.hasMusic, hasMusic === true);
      assert.strictEqual(plan.originalMuted, audioConfig.originalMuted === true);
    }),
    { numRuns: 200 }
  );
});

test('Property 13: originalVolume is always carried through; musicVolume only when hasMusic', () => {
  fc.assert(
    fc.property(audioConfigArb(), fc.boolean(), (audioConfig, hasMusic) => {
      const plan = planAudio(audioConfig, hasMusic);

      // originalVolume is always present and equals the normalized config value.
      assert.strictEqual(plan.originalVolume, expectedVolume(audioConfig.originalVolume));

      if (hasMusic) {
        const music = audioConfig.music || {};
        assert.strictEqual(plan.musicVolume, expectedVolume(music.volume));
      } else {
        // No music: musicVolume must not be carried into the plan.
        assert.strictEqual(plan.musicVolume, undefined);
      }
    }),
    { numRuns: 200 }
  );
});

test('Property 13: each of the 4 truth-table cells is covered explicitly', () => {
  const cases = [
    { originalMuted: true, hasMusic: true, mode: AUDIO_MODE.MUSIC },
    { originalMuted: false, hasMusic: true, mode: AUDIO_MODE.MIX },
    { originalMuted: true, hasMusic: false, mode: AUDIO_MODE.SILENCE },
    { originalMuted: false, hasMusic: false, mode: AUDIO_MODE.ORIGINAL },
  ];
  for (const c of cases) {
    const plan = planAudio(
      { originalMuted: c.originalMuted, originalVolume: 50, music: { volume: 70 } },
      c.hasMusic
    );
    assert.strictEqual(plan.mode, c.mode);
    assert.strictEqual(plan.originalVolume, 50);
    if (c.hasMusic) {
      assert.strictEqual(plan.musicVolume, 70);
    } else {
      assert.strictEqual(plan.musicVolume, undefined);
    }
  }
});
