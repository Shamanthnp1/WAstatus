'use strict';

/**
 * Property-based tests for the input-limit gate (`enforceInputLimits`).
 *
 * Property 3: Input limits are enforced before any encode.
 * Validates: Requirements 1.6, 13.6.
 *
 * For any submitted input set that exceeds a limit (more than 3 videos,
 * total video size > 300MB, or any single added audio > 20MB), the request is
 * rejected before any encode, the error names the violated limit, and when
 * more than 3 videos are supplied the first 3 in upload order are the retained
 * set. Inputs within all limits are accepted with the full set retained.
 *
 * The gate is a pure, synchronous decision: it never starts an encode and
 * never mutates the inputs. These tests assert that by snapshotting the input
 * before each call and confirming the return value is not a Promise.
 *
 * Framework: fast-check + node:test (CommonJS). >= 100 generated cases per
 * property.
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { enforceInputLimits } = require('../src/server/inputLimits');
const { INPUT_LIMITS } = require('../src/shared/constants');

const MB = 1024 * 1024;
const { MAX_VIDEOS, MAX_TOTAL_VIDEO_BYTES, MAX_AUDIO_BYTES } = INPUT_LIMITS;

const RUNS = { numRuns: 200 };

/** A single video input file with a bounded size. */
function fileArb(maxSize) {
  return fc.record({
    key: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `upload/${s.replace(/\s/g, '_') || 'k'}`),
    originalName: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `${s.replace(/\s/g, '_') || 'v'}.mp4`),
    size: fc.integer({ min: 1, max: maxSize }),
  });
}

/** Deep clone helper for snapshotting inputs to detect mutation. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Assert the gate made a pure, synchronous decision (no encode, no mutation). */
function assertPureDecision(files, before, result) {
  // Synchronous return: not a Promise (no async encode work kicked off).
  assert.ok(!(result instanceof Promise), 'result must be a synchronous decision');
  assert.equal(typeof result.ok, 'boolean');
  // Inputs are never mutated by the gate.
  assert.deepStrictEqual(clone(files), before, 'inputs must not be mutated');
}

test('Property 3: more than 3 videos => rejected, limit MAX_VIDEOS, first 3 retained in order', () => {
  fc.assert(
    fc.property(
      // 4..6 videos with small sizes (count limit is checked first regardless of size).
      fc.array(fileArb(50 * MB), { minLength: MAX_VIDEOS + 1, maxLength: 6 }),
      (files) => {
        const before = clone(files);
        const result = enforceInputLimits(files);
        assertPureDecision(files, before, result);

        assert.equal(result.ok, false);
        assert.equal(result.limit, 'MAX_VIDEOS');
        assert.ok(typeof result.error === 'string' && /3/.test(result.error), 'error names the max of 3');

        // Retained set is exactly the first 3 in upload order.
        assert.equal(result.retained.length, MAX_VIDEOS);
        for (let i = 0; i < MAX_VIDEOS; i++) {
          assert.strictEqual(result.retained[i], files[i], `retained[${i}] is the i-th uploaded video`);
        }
      }
    ),
    RUNS
  );
});

test('Property 3: total video size > 300MB (within count) => rejected, limit MAX_TOTAL_VIDEO_BYTES', () => {
  // Build 1..3 files whose total is guaranteed to exceed the 300MB limit.
  const exceedingTotalArb = fc.integer({ min: 1, max: MAX_VIDEOS }).chain((n) =>
    fc.array(fc.integer({ min: 1, max: 100 * MB }), { minLength: n, maxLength: n }).map((sizes) => {
      const total = sizes.reduce((a, b) => a + b, 0);
      const needed = MAX_TOTAL_VIDEO_BYTES + 1 - total;
      if (needed > 0) sizes[0] += needed; // force the total just past the limit
      return sizes.map((size, i) => ({ key: `upload/k${i}`, originalName: `v${i}.mp4`, size }));
    })
  );

  fc.assert(
    fc.property(exceedingTotalArb, (files) => {
      const total = files.reduce((a, f) => a + f.size, 0);
      assert.ok(total > MAX_TOTAL_VIDEO_BYTES, 'precondition: total exceeds limit');
      assert.ok(files.length <= MAX_VIDEOS, 'precondition: within count limit');

      const before = clone(files);
      const result = enforceInputLimits(files);
      assertPureDecision(files, before, result);

      assert.equal(result.ok, false);
      assert.equal(result.limit, 'MAX_TOTAL_VIDEO_BYTES');
      assert.ok(typeof result.error === 'string' && result.error.length > 0, 'error names the violated limit');
    }),
    RUNS
  );
});

test('Property 3: any single added audio > 20MB => rejected, limit MAX_AUDIO_BYTES', () => {
  // 1..3 small videos (total well within 300MB) plus a per-video audio map in
  // which at least one video exceeds the 20MB audio limit.
  const caseArb = fc.integer({ min: 1, max: MAX_VIDEOS }).chain((n) =>
    fc.record({
      files: fc.array(fileArb(50 * MB), { minLength: n, maxLength: n }),
      // audio bytes per video; some over, some under the limit
      audioBytes: fc.array(
        fc.oneof(
          fc.integer({ min: 0, max: MAX_AUDIO_BYTES }), // within limit
          fc.integer({ min: MAX_AUDIO_BYTES + 1, max: 80 * MB }) // exceeds limit
        ),
        { minLength: n, maxLength: n }
      ),
      // index forced to exceed, guaranteeing at least one violation
      violatingIndex: fc.integer({ min: 0, max: n - 1 }),
    })
  );

  fc.assert(
    fc.property(caseArb, ({ files, audioBytes, violatingIndex }) => {
      // Guarantee at least one video's audio is over the limit.
      audioBytes[violatingIndex] = MAX_AUDIO_BYTES + 1 + (violatingIndex + 1);

      const totalVideo = files.reduce((a, f) => a + f.size, 0);
      assert.ok(totalVideo <= MAX_TOTAL_VIDEO_BYTES, 'precondition: video total within limit');

      const before = clone(files);
      const getAudioBytes = (_file, index) => audioBytes[index];
      const result = enforceInputLimits(files, { getAudioBytes });
      assertPureDecision(files, before, result);

      assert.equal(result.ok, false);
      assert.equal(result.limit, 'MAX_AUDIO_BYTES');
      assert.ok(typeof result.error === 'string' && result.error.length > 0, 'error names the violated limit');
    }),
    RUNS
  );
});

test('Property 3: inputs within all limits => accepted, full set retained', () => {
  // 1..3 videos, each <= 100MB so the total never exceeds 300MB, and all audio
  // sizes within the 20MB limit.
  const withinLimitsArb = fc.integer({ min: 1, max: MAX_VIDEOS }).chain((n) =>
    fc.record({
      files: fc.array(fileArb(100 * MB), { minLength: n, maxLength: n }),
      audioBytes: fc.array(fc.integer({ min: 0, max: MAX_AUDIO_BYTES }), { minLength: n, maxLength: n }),
    })
  );

  fc.assert(
    fc.property(withinLimitsArb, ({ files, audioBytes }) => {
      const total = files.reduce((a, f) => a + f.size, 0);
      assert.ok(total <= MAX_TOTAL_VIDEO_BYTES, 'precondition: within total limit');

      const before = clone(files);
      const getAudioBytes = (_file, index) => audioBytes[index];
      const result = enforceInputLimits(files, { getAudioBytes });
      assertPureDecision(files, before, result);

      assert.equal(result.ok, true, 'within-limits input is accepted');
      assert.equal(result.limit, undefined, 'no limit is reported on success');
      // The full input set is retained, in order.
      assert.equal(result.retained.length, files.length);
      for (let i = 0; i < files.length; i++) {
        assert.strictEqual(result.retained[i], files[i], `retained[${i}] equals the i-th input`);
      }
    }),
    RUNS
  );
});

test('Property 3: empty input is rejected before any encode (NO_FILES)', () => {
  // Boundary/unit complement: zero videos is a rejected case (no encode).
  const result = enforceInputLimits([]);
  assert.equal(result.ok, false);
  assert.equal(result.limit, 'NO_FILES');
  assert.deepStrictEqual(result.retained, []);
});
