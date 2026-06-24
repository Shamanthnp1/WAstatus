'use strict';

/**
 * Property 14: Only one music track is retained.
 *
 * Validates: Requirements 7.10
 *
 * For any editor state that already contains a music track, an attempt to add
 * another is rejected and the existing track is retained unchanged.
 *
 * Units under test:
 *   - `addMusicTrack(instance, props)` and `getMusic(instance)` from
 *     public/js/editorAudio.js, operating on an EditorInstance from
 *     public/js/editor.js.
 *
 * The first add succeeds; a second add returns
 * `{ ok:false, error:'music_exists', music:<existing> }` and leaves
 * `instance.audio.music` deep-equal to the snapshot taken after the first add.
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const editor = require('../public/js/editor');
const audio = require('../public/js/editorAudio');

const EditorInstance = editor.EditorInstance;

/**
 * A valid Music_Track prop set accepted by addMusicTrack: non-empty assetRef,
 * source upload/library, integer volume 0..100, non-negative audioStart, and a
 * loopMode of loop/once.
 */
function musicPropsArb() {
  return fc.record({
    assetRef: fc
      .string({ minLength: 1, maxLength: 24 })
      .map((s) => `asset_${s.replace(/[^a-zA-Z0-9]/g, '') || 'x'}`),
    source: fc.constantFrom('upload', 'library'),
    volume: fc.integer({ min: 0, max: 100 }),
    audioStart: fc.double({ min: 0, max: 600, noNaN: true }),
    loopMode: fc.constantFrom('loop', 'once'),
  });
}

test('Property 14: only one music track is retained (≥100 cases)', () => {
  fc.assert(
    fc.property(musicPropsArb(), musicPropsArb(), (firstProps, secondProps) => {
      // Fresh editor state: a single uploaded video with no music yet.
      const instance = new EditorInstance(0, { uploadKey: 'upload/k0' });
      assert.equal(audio.hasMusic(instance), false);

      // First add succeeds and records the track.
      const firstResult = audio.addMusicTrack(instance, firstProps);
      assert.equal(firstResult.ok, true, 'first add should succeed');
      assert.equal(audio.hasMusic(instance), true);

      // Snapshot the recorded music after the first (successful) add.
      const snapshot = JSON.parse(JSON.stringify(instance.audio.music));

      // Second add is rejected: only one Music_Track is allowed (Req 7.10).
      const secondResult = audio.addMusicTrack(instance, secondProps);
      assert.equal(secondResult.ok, false, 'second add should be rejected');
      assert.equal(
        secondResult.error,
        'music_exists',
        'rejection error should name the single-track limit'
      );

      // The rejection returns the retained existing track unchanged.
      assert.deepStrictEqual(
        secondResult.music,
        snapshot,
        'rejection should return the retained existing track'
      );

      // The existing track on the instance is retained byte-for-byte.
      assert.deepStrictEqual(
        instance.audio.music,
        snapshot,
        'existing music track must be retained unchanged after a rejected add'
      );

      // getMusic reflects the first (retained) track, not the second.
      assert.deepStrictEqual(
        audio.getMusic(instance),
        snapshot,
        'getMusic should reflect the first, retained track'
      );
    }),
    { numRuns: 200 }
  );
});
