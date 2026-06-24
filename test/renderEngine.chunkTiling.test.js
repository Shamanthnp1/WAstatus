'use strict';

/**
 * Property 10: Chunk plans tile the timeline contiguously.
 *
 * Validates: Requirements 4.6, 11.2
 *
 * For any (possibly trimmed) output duration D greater than the
 * Clip_Duration_Limit, the chunk plan produces chunks that each have duration
 * <= the limit, whose boundaries are contiguous (chunk i end == chunk i+1
 * start) with no gap, overlap, or repeated frame, and whose union covers
 * exactly [0, D].
 *
 * Units under test (src/server/renderEngine.js):
 *  - `chunkCount(duration, clipLimit)` — the number of chunks tiling [0, D].
 *  - `planChunk(plan, chunkIndex, clipLimit)` — the per-chunk render plan
 *    carrying chunkStart / chunkEnd / chunkDuration on the output timeline.
 *  - `planRender(recipe, meta)` — used to build the base plan whose
 *    plannedDuration is D (full-source or trimmed).
 *
 * CLIP_DURATION_LIMIT comes from src/shared/constants.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { planRender, planChunk, chunkCount } = require('../src/server/renderEngine');
const { CLIP_DURATION_LIMIT } = require('../src/shared/constants');

const NUM_RUNS = 200;

// Floating-point tolerance for boundary comparisons. Chunk boundaries are
// products/sums of the (possibly fractional) clip limit, so we compare within
// a small epsilon rather than requiring exact bit equality.
const EPS = 1e-6;

/** Build a minimal recipe carrying an optional trim. */
function recipeWith(trim) {
  const recipe = {
    version: 1,
    textOverlays: [],
    stickers: [],
    audio: { originalMuted: false, originalVolume: 100 },
  };
  if (trim) recipe.trim = trim;
  return recipe;
}

/**
 * Generate a (clipLimit, D) pair where D is strictly greater than clipLimit so
 * the timeline is genuinely split into 2+ chunks. clipLimit ranges over both
 * integer-ish and fractional values to exercise float boundary handling.
 */
function limitAndDurationArb() {
  return fc
    .record({
      clipLimit: fc.double({ min: 1, max: 60, noNaN: true }),
      // multiplier strictly > 1 guarantees D > clipLimit; up to ~12x the limit
      // keeps the chunk count bounded while still covering many chunks.
      mult: fc.double({ min: 1.0001, max: 12, noNaN: true }),
    })
    .map(({ clipLimit, mult }) => ({ clipLimit, D: clipLimit * mult }));
}

/**
 * Assert that the full set of chunks produced for duration D with the given
 * clip limit tiles [0, D] contiguously. `buildChunk(i)` returns an object with
 * chunkStart/chunkEnd/chunkDuration for chunk i.
 */
function assertTiling(D, clipLimit, count, buildChunk) {
  // At least two chunks because D > clipLimit.
  assert.ok(count >= 2, `expected >= 2 chunks for D=${D}, limit=${clipLimit}, got ${count}`);

  const chunks = [];
  for (let i = 0; i < count; i += 1) {
    chunks.push(buildChunk(i));
  }

  // First chunk starts at the timeline origin.
  assert.ok(
    Math.abs(chunks[0].chunkStart - 0) <= EPS,
    `first chunk must start at 0, got ${chunks[0].chunkStart}`
  );

  // Last chunk ends exactly at D (union covers [0, D]).
  const last = chunks[count - 1];
  assert.ok(
    Math.abs(last.chunkEnd - D) <= EPS,
    `last chunk must end at D=${D}, got ${last.chunkEnd}`
  );

  let covered = 0;
  for (let i = 0; i < count; i += 1) {
    const c = chunks[i];

    // Each chunk has positive duration equal to chunkEnd - chunkStart.
    assert.ok(c.chunkEnd > c.chunkStart, `chunk ${i} must have positive duration`);
    assert.ok(
      Math.abs(c.chunkDuration - (c.chunkEnd - c.chunkStart)) <= EPS,
      `chunk ${i} duration must equal end-start`
    );

    // Each chunk duration is <= the clip limit (Req 4.6).
    assert.ok(
      c.chunkDuration <= clipLimit + EPS,
      `chunk ${i} duration ${c.chunkDuration} must be <= limit ${clipLimit}`
    );

    // Contiguity: chunk i end == chunk i+1 start (no gap/overlap/repeat).
    if (i + 1 < count) {
      const next = chunks[i + 1];
      assert.ok(
        Math.abs(c.chunkEnd - next.chunkStart) <= EPS,
        `chunk ${i} end ${c.chunkEnd} must equal chunk ${i + 1} start ${next.chunkStart}`
      );
    }

    covered += c.chunkDuration;
  }

  // Summed chunk durations cover exactly D (no gap, no overlap).
  assert.ok(
    Math.abs(covered - D) <= EPS * count,
    `summed chunk durations ${covered} must equal D=${D}`
  );
}

// ---------------------------------------------------------------------------
// planChunk over a full-source plan (plannedDuration = D) tiles [0, D].
// ---------------------------------------------------------------------------
test('Property 10 — planChunk tiles [0, D] contiguously for a full-source plan', () => {
  fc.assert(
    fc.property(limitAndDurationArb(), ({ clipLimit, D }) => {
      const meta = { width: 1080, height: 1920, duration: D, key: 'upload/k' };
      const plan = planRender(recipeWith(undefined), meta);
      assert.strictEqual(plan.plannedDuration, D);

      const count = chunkCount(D, clipLimit);
      assertTiling(D, clipLimit, count, (i) => planChunk(plan, i, clipLimit));

      // Every planChunk reports the same total chunk count.
      for (let i = 0; i < count; i += 1) {
        assert.strictEqual(planChunk(plan, i, clipLimit).chunkCount, count);
      }
    }),
    { numRuns: NUM_RUNS }
  );
});

// ---------------------------------------------------------------------------
// planChunk over a trimmed plan: D = trim.end - trim.start drives the tiling.
// ---------------------------------------------------------------------------
test('Property 10 — planChunk tiles [0, D] contiguously for a trimmed plan', () => {
  fc.assert(
    fc.property(
      limitAndDurationArb().chain(({ clipLimit, D }) =>
        // Place the trim window [start, start+D] somewhere within a longer source.
        fc.record({
          clipLimit: fc.constant(clipLimit),
          D: fc.constant(D),
          start: fc.double({ min: 0, max: 30, noNaN: true }),
        })
      ),
      ({ clipLimit, D, start }) => {
        const trim = { start, end: start + D };
        const meta = { width: 1080, height: 1920, duration: trim.end + 5, key: 'upload/k' };
        const plan = planRender(recipeWith(trim), meta);

        // The trimmed planned duration is D (within float tolerance).
        assert.ok(Math.abs(plan.plannedDuration - D) <= EPS);
        const Dplanned = plan.plannedDuration;

        const count = chunkCount(Dplanned, clipLimit);
        assertTiling(Dplanned, clipLimit, count, (i) => planChunk(plan, i, clipLimit));
      }
    ),
    { numRuns: NUM_RUNS }
  );
});

// ---------------------------------------------------------------------------
// Default clip limit (CLIP_DURATION_LIMIT) over a constructed plan object.
// ---------------------------------------------------------------------------
test('Property 10 — planChunk tiles [0, D] using the default Clip_Duration_Limit', () => {
  fc.assert(
    fc.property(
      // D strictly greater than the default limit.
      fc.double({ min: CLIP_DURATION_LIMIT + 0.001, max: CLIP_DURATION_LIMIT * 12, noNaN: true }),
      (D) => {
        const plan = {
          inputs: [{ type: 'video', path: 'v.mp4', args: [] }],
          filterComplex: '',
          encodeOptions: [],
          overlays: [],
          plannedDuration: D,
        };

        const count = chunkCount(D);
        assertTiling(D, CLIP_DURATION_LIMIT, count, (i) => planChunk(plan, i));
      }
    ),
    { numRuns: NUM_RUNS }
  );
});

// ---------------------------------------------------------------------------
// chunkCount agreement: ceil(D / clipLimit) and each chunk <= limit.
// ---------------------------------------------------------------------------
test('Property 10 — chunkCount equals ceil(D / clipLimit) for D > clipLimit', () => {
  fc.assert(
    fc.property(limitAndDurationArb(), ({ clipLimit, D }) => {
      const count = chunkCount(D, clipLimit);
      const expected = Math.max(1, Math.ceil(D / clipLimit - 1e-9));
      assert.strictEqual(count, expected);
      // (count - 1) full limits do not yet cover D; count limits do.
      assert.ok((count - 1) * clipLimit < D + EPS);
      assert.ok(count * clipLimit >= D - EPS);
    }),
    { numRuns: NUM_RUNS }
  );
});
