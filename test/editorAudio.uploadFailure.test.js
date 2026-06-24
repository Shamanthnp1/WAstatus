'use strict';

/**
 * Property 25: Music upload failure preserves recipe state.
 *
 * Validates: Requirements 15.3, 15.5, 15.6
 *
 * For any recipe state, when a music upload fails:
 *   - the remainder of the Edit_Recipe is retained UNCHANGED and an error
 *     describing the cause is surfaced (Req 15.3);
 *   - the user is offered retries up to 3 attempts plus a proceed-without-music
 *     option (Req 15.4 — exercised here via start()/retry()/proceedWithoutMusic());
 *   - after the 3rd failed attempt the flow proceeds WITHOUT a Music_Track while
 *     retaining every other recipe field (Req 15.5);
 *   - the non-music recipe fields (text overlays, stickers, trim, mute, volume)
 *     remain unchanged across every failed attempt (Req 15.6).
 *
 * Units under test:
 *   - `uploadMusic(instance, file, deps, opts)` — the upload controller state
 *     machine (start/retry/proceedWithoutMusic, canRetry, attempts, error) from
 *     public/js/editorAudio.js, with `deps` injected so the upload ALWAYS fails
 *     (at the presign, upload, or validate step).
 *   - An `EditorInstance` from public/js/editor.js, populated with other recipe
 *     fields so their preservation can be asserted.
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const editor = require('../public/js/editor');
const audio = require('../public/js/editorAudio');
const { textOverlayArb, stickerArb, volume } = require('./helpers/arbitraries');

const EditorInstance = editor.EditorInstance;

/**
 * A description of the non-music recipe state to populate an EditorInstance
 * with. Trim is derived from `sourceDuration` in the body so it always lands in
 * a valid range. Counts are kept small so each generated case runs quickly.
 */
function recipeStateArb() {
  return fc.record({
    sourceDuration: fc.double({ min: 5, max: 600, noNaN: true }),
    overlays: fc.array(textOverlayArb(), { minLength: 0, maxLength: 4 }),
    stickers: fc.array(stickerArb(), { minLength: 0, maxLength: 4 }),
    muted: fc.boolean(),
    originalVolume: volume(),
    // Two fractions used to derive a valid trim (start < end <= duration).
    trimFractions: fc.option(
      fc.tuple(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true })
      ),
      { nil: undefined }
    ),
  });
}

/** Which upload step fails, and (for validate) whether it rejects or returns ok:false. */
function failModeArb() {
  return fc.record({
    step: fc.constantFrom('presign', 'upload', 'validate'),
    validateOkFalse: fc.boolean(),
  });
}

/**
 * Build injectable deps whose upload ALWAYS fails at `mode.step`. Steps before
 * the failing one resolve normally so the failure is produced at the intended
 * stage (giving a distinct, describable cause).
 */
function makeFailingDeps(mode) {
  return {
    requestUploadUrl() {
      if (mode.step === 'presign') {
        return Promise.reject(new Error('could not reach the music upload service'));
      }
      return Promise.resolve({
        uploadUrl: 'https://worker.example/put',
        assetId: 'asset_fail',
        key: 'music/asset_fail',
      });
    },
    putFile() {
      if (mode.step === 'upload') {
        return Promise.reject(new Error('the audio bytes could not be transferred'));
      }
      return Promise.resolve(true);
    },
    validateAsset() {
      if (mode.step === 'validate') {
        if (mode.validateOkFalse) {
          return Promise.resolve({ ok: false, reason: 'file exceeds the 20 MB size limit' });
        }
        return Promise.reject(new Error('audio validation could not be completed'));
      }
      return Promise.resolve({ ok: true, duration: 30 });
    },
  };
}

/** A fake user-selected audio file (the failing deps ignore its contents). */
const FAKE_FILE = { name: 'song.mp3', type: 'audio/mpeg', size: 1234 };

/** Populate an EditorInstance with the generated non-music recipe state. */
function buildInstance(stateSpec) {
  const instance = new EditorInstance(0, {
    uploadKey: 'upload/k0',
    sourceDuration: stateSpec.sourceDuration,
  });

  audio.setMuted(instance, stateSpec.muted);
  audio.setOriginalVolume(instance, stateSpec.originalVolume);

  for (const overlay of stateSpec.overlays) {
    instance.addTextOverlay(overlay);
  }
  for (const sticker of stateSpec.stickers) {
    instance.addSticker(sticker);
  }

  if (stateSpec.trimFractions) {
    const [f1, f2] = stateSpec.trimFractions;
    const a = Math.min(f1, f2) * stateSpec.sourceDuration;
    const b = Math.max(f1, f2) * stateSpec.sourceDuration;
    if (a < b && b <= stateSpec.sourceDuration) {
      instance.setTrim(a, b);
    }
  }

  return instance;
}

/** Assert a surfaced upload error describes the failing cause (Req 15.3). */
function assertErrorDescribesCause(error, expectedStep) {
  assert.ok(error, 'a failure should surface an error');
  assert.equal(error.cause, expectedStep, 'the surfaced error names the failing step (cause)');
  assert.equal(typeof error.message, 'string', 'the error carries a human message');
  assert.ok(error.message.length > 0, 'the error message describes the cause');
}

test('Property 25: failed music upload retains recipe and proceeds w/o music after 3 attempts (≥100 cases)', async () => {
  await fc.assert(
    fc.asyncProperty(recipeStateArb(), failModeArb(), async (stateSpec, mode) => {
      const instance = buildInstance(stateSpec);

      // Snapshot of the full recipe BEFORE any upload attempt. Because the
      // upload always fails, no music is ever recorded, so the entire recipe
      // (including audio with music === null) must be invariant across attempts.
      const before = JSON.parse(JSON.stringify(instance.getRecipe()));
      assert.equal(before.audio.music, null, 'no music track is present before upload');

      const deps = makeFailingDeps(mode);
      const controller = audio.uploadMusic(instance, FAKE_FILE, deps);

      assert.equal(controller.maxAttempts, 3, 'up to 3 attempts are offered (Req 15.4)');

      // ---- Attempt 1 (start) — fails, retains recipe, offers retry ----------
      const r1 = await controller.start();
      assert.equal(r1.ok, false, 'attempt 1 fails');
      assert.equal(controller.attempts, 1);
      assertErrorDescribesCause(controller.error, mode.step); // Req 15.3
      assert.equal(audio.hasMusic(instance), false, 'no music recorded on failure');
      assert.deepStrictEqual(instance.getRecipe(), before, 'recipe retained after attempt 1 (Req 15.6)');
      assert.equal(controller.canRetry, true, 'a retry is offered after a non-final failure');
      assert.equal(r1.canRetry, true);

      // ---- Attempt 2 (retry) — fails, still retains recipe, offers retry ----
      const r2 = await controller.retry();
      assert.equal(r2.ok, false, 'attempt 2 fails');
      assert.equal(controller.attempts, 2);
      assertErrorDescribesCause(controller.error, mode.step);
      assert.equal(audio.hasMusic(instance), false);
      assert.deepStrictEqual(instance.getRecipe(), before, 'recipe retained after attempt 2 (Req 15.6)');
      assert.equal(controller.canRetry, true);

      // ---- Attempt 3 (retry) — fails, then proceeds WITHOUT music (Req 15.5) -
      const r3 = await controller.retry();
      assert.equal(r3.ok, false, 'attempt 3 fails');
      assert.equal(r3.proceededWithoutMusic, true, 'after the 3rd failure the flow proceeds w/o music');
      assert.equal(controller.attempts, 3);
      assert.equal(
        controller.state,
        audio.MUSIC_UPLOAD_STATES.PROCEEDED_WITHOUT_MUSIC,
        'controller is in the proceeded-without-music terminal state'
      );
      assert.equal(controller.canRetry, false, 'no further retries after the final attempt');
      assertErrorDescribesCause(controller.error, mode.step); // cause still surfaced
      assert.equal(audio.hasMusic(instance), false, 'recipe proceeds with NO music track (Req 15.5)');
      assert.deepStrictEqual(
        instance.getRecipe(),
        before,
        'all other recipe fields retained after proceeding w/o music (Req 15.5/15.6)'
      );
    }),
    { numRuns: 200 }
  );
});

test('Property 25: explicit proceed-without-music retains all other recipe fields (≥100 cases)', async () => {
  await fc.assert(
    fc.asyncProperty(recipeStateArb(), failModeArb(), async (stateSpec, mode) => {
      const instance = buildInstance(stateSpec);
      const before = JSON.parse(JSON.stringify(instance.getRecipe()));
      assert.equal(before.audio.music, null);

      const controller = audio.uploadMusic(instance, FAKE_FILE, makeFailingDeps(mode));

      // One failed attempt, then the user opts to proceed without music.
      const r1 = await controller.start();
      assert.equal(r1.ok, false, 'the attempt fails');
      assertErrorDescribesCause(controller.error, mode.step); // Req 15.3
      assert.deepStrictEqual(instance.getRecipe(), before, 'recipe retained on failure (Req 15.6)');
      assert.equal(controller.canRetry, true, 'proceed-without-music is offered alongside retry (Req 15.4)');

      const pr = controller.proceedWithoutMusic();
      assert.equal(pr.proceededWithoutMusic, true);
      assert.equal(
        controller.state,
        audio.MUSIC_UPLOAD_STATES.PROCEEDED_WITHOUT_MUSIC,
        'controller proceeds without music on request'
      );
      assert.equal(audio.hasMusic(instance), false, 'no music track after proceeding (Req 15.5)');
      assert.deepStrictEqual(
        instance.getRecipe(),
        before,
        'every other recipe field retained after proceeding w/o music (Req 15.6)'
      );
    }),
    { numRuns: 100 }
  );
});
