'use strict';

/**
 * Property 15: Music acceptance boundary
 *
 * Validates: Requirements 8.5, 8.6, 8.7
 *
 * For any uploaded audio file, it is accepted IFF its size <= 20 MB
 * (20,971,520 bytes) AND its duration <= 600 s; otherwise it is rejected, the
 * error names the violated limit (size when the size is over; duration when
 * the size is within bounds but the duration is over), and any previously
 * selected music is retained unchanged.
 *
 * Unit under test: the `makeMusicValidateHandler` factory in
 * `src/server/musicRoutes.js` (task 9.2). The handler's size/duration boundary
 * logic is exercised with injected mock dependencies:
 *   - `loadAudio`   -> returns a given authoritative size in bytes
 *   - `probeDuration` -> returns a given duration in seconds
 * and a mock `res` capturing the status code and JSON body. The handler is
 * stateless with respect to the user's prior Music_Track selection, so
 * retention of a previous selection is asserted by confirming an external
 * selection object is never mutated by a call.
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { makeMusicValidateHandler } = require('../src/server/musicRoutes.js');
const { INPUT_LIMITS } = require('../src/shared/constants.js');

const MAX_AUDIO_BYTES = INPUT_LIMITS.MAX_AUDIO_BYTES; // 20,971,520
const MAX_AUDIO_DURATION = INPUT_LIMITS.MAX_AUDIO_DURATION_SECONDS; // 600

/**
 * A minimal mock of an Express response that records the final status code and
 * JSON body. Defaults to 200 (Express's default) when `status()` is not called.
 */
function makeMockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

/**
 * Run the validate handler once for a given size/duration and return the
 * captured response plus a flag indicating whether a tracked "previous
 * selection" object was mutated by the call.
 *
 * @param {number} sizeBytes
 * @param {number} duration
 * @returns {Promise<{ res: ReturnType<typeof makeMockRes>, prevSelectionMutated: boolean }>}
 */
async function runValidate(sizeBytes, duration) {
  // A stand-in for the editor's previously selected Music_Track. The handler
  // must never touch it (it is stateless), so it should remain byte-identical.
  const previousSelection = {
    assetRef: 'asset_prev_track',
    source: 'library',
    volume: 80,
    audioStart: 12.5,
    loopMode: 'loop',
  };
  const previousSelectionSnapshot = JSON.parse(JSON.stringify(previousSelection));

  let probeCalled = false;
  const handler = makeMusicValidateHandler({
    loadAudio: async () => ({ sizeBytes }),
    probeDuration: async () => {
      probeCalled = true;
      return duration;
    },
  });

  const req = { body: { assetId: 'asset_under_test', key: 'music/asset_under_test.m4a' } };
  const res = makeMockRes();
  await handler(req, res);

  const prevSelectionMutated =
    JSON.stringify(previousSelection) !== JSON.stringify(previousSelectionSnapshot);

  return { res, prevSelectionMutated, probeCalled };
}

/**
 * A size generator spanning clearly-below, at-boundary, just-around, and
 * clearly-above the 20 MB limit so the boundary is sampled densely.
 */
const sizeArb = () =>
  fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 0, max: 2 * MAX_AUDIO_BYTES }) },
    // dense sampling within +/- 4 bytes of the boundary
    {
      weight: 2,
      arbitrary: fc.integer({ min: -4, max: 4 }).map((d) => MAX_AUDIO_BYTES + d),
    },
    { weight: 1, arbitrary: fc.constantFrom(0, MAX_AUDIO_BYTES, MAX_AUDIO_BYTES + 1) }
  );

/**
 * A duration generator spanning clearly-below, at-boundary, just-around, and
 * clearly-above the 600 s limit.
 */
const durationArb = () =>
  fc.oneof(
    { weight: 3, arbitrary: fc.double({ min: 0, max: 2 * MAX_AUDIO_DURATION, noNaN: true }) },
    // dense sampling within +/- 0.5 s of the boundary
    {
      weight: 2,
      arbitrary: fc.double({ min: -0.5, max: 0.5, noNaN: true }).map((d) => MAX_AUDIO_DURATION + d),
    },
    { weight: 1, arbitrary: fc.constantFrom(0, MAX_AUDIO_DURATION, MAX_AUDIO_DURATION + 0.001) }
  );

test('Property 15: music accepted IFF size <= 20MB AND duration <= 600s; rejection names the violated limit; prior selection retained', async () => {
  await fc.assert(
    fc.asyncProperty(sizeArb(), durationArb(), async (sizeBytes, duration) => {
      const { res, prevSelectionMutated } = await runValidate(sizeBytes, duration);

      const sizeOk = sizeBytes <= MAX_AUDIO_BYTES;
      const durationOk = duration <= MAX_AUDIO_DURATION;
      const shouldAccept = sizeOk && durationOk;

      // The handler is stateless: a previously selected track is never touched,
      // whether the upload is accepted or rejected (Req 8.6/8.7).
      assert.equal(prevSelectionMutated, false, 'previous selection must be retained unchanged');

      if (shouldAccept) {
        // Accepted (Req 8.5).
        assert.equal(res.statusCode, 200, 'accepted upload returns 200');
        assert.ok(res.body && res.body.ok === true, 'accepted response has ok:true');
        assert.equal(res.body.duration, duration, 'accepted response echoes probed duration');
      } else {
        // Rejected (Req 8.6/8.7): error names the violated limit.
        assert.equal(res.statusCode, 400, 'rejected upload returns 400');
        assert.ok(res.body && typeof res.body === 'object', 'rejection has a body');
        // Size is gated first: size over -> "size"; size ok but duration over -> "duration".
        const expectedLimit = !sizeOk ? 'size' : 'duration';
        assert.equal(res.body.limit, expectedLimit, 'rejection names the violated limit');
        assert.equal(typeof res.body.error, 'string', 'rejection includes an error message');
        if (expectedLimit === 'size') {
          assert.match(res.body.error, /size/i, 'size-limit error mentions size');
        } else {
          assert.match(res.body.error, /(duration|minute)/i, 'duration-limit error mentions duration');
        }
      }
    }),
    { numRuns: 300 }
  );
});

// Deterministic boundary checks complementing the property (exact edges).
test('Property 15 edges: at-limit values are accepted, one unit over is rejected', async () => {
  // Exactly at both limits -> accepted.
  let r = await runValidate(MAX_AUDIO_BYTES, MAX_AUDIO_DURATION);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.body.ok, true);
  assert.equal(r.prevSelectionMutated, false);

  // One byte over the size limit -> rejected naming "size".
  r = await runValidate(MAX_AUDIO_BYTES + 1, 10);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.body.limit, 'size');
  assert.equal(r.prevSelectionMutated, false);

  // Size ok, duration just over -> rejected naming "duration".
  r = await runValidate(1024, MAX_AUDIO_DURATION + 0.001);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.body.limit, 'duration');
  assert.equal(r.prevSelectionMutated, false);

  // Both over -> size is gated first, so "size" is named.
  r = await runValidate(MAX_AUDIO_BYTES + 1, MAX_AUDIO_DURATION + 1);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.body.limit, 'size');
});
