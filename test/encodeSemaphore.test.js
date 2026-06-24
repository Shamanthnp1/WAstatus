'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { EncodeSemaphore } = require('../src/server/encodeSemaphore');

/**
 * Property 21: Encode concurrency never exceeds the CPU-derived limit.
 *
 * For any schedule of encode task arrivals and completions, the number of
 * simultaneously in-progress encode operations never exceeds the
 * Concurrency_Limit (max(1, CPU count)), and a queued operation starts only
 * when an in-progress operation releases its permit (FIFO).
 *
 * The semaphore is constructed with explicit permit counts so the test is
 * deterministic regardless of the host CPU count. "Work durations" are
 * simulated as a number of microtask yields (await Promise.resolve()), which
 * lets fast-check explore many interleavings of arrivals and completions.
 *
 * Validates: Requirements 13.1, 13.2
 */

/**
 * Run a set of encode tasks through the semaphore.
 *
 * @param {number} permits - permit count to construct the semaphore with
 * @param {number[]} works - per-task work durations (microtask yields)
 * @returns {Promise<{maxLive:number, grantOrder:number[], sem:EncodeSemaphore}>}
 */
async function runSchedule(permits, works) {
  const sem = new EncodeSemaphore(permits);
  let live = 0;
  let maxLive = 0;
  const grantOrder = [];
  const violations = [];

  async function runTask(index, work) {
    const release = await sem.acquire();
    // Permit granted: this task is now in-progress.
    grantOrder.push(index);
    live += 1;
    if (live > maxLive) {
      maxLive = live;
    }
    if (live > sem.permits) {
      // Capture rather than throw so the property reports a clean counterexample.
      violations.push(live);
    }

    // Simulate the encode taking some amount of time via microtask yields.
    for (let t = 0; t < work; t += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    live -= 1;
    release();
  }

  await Promise.all(works.map((w, i) => runTask(i, w)));

  return { maxLive, grantOrder, violations, sem };
}

const permitsArb = fc.integer({ min: 1, max: 8 });
const worksArb = fc.array(fc.nat({ max: 5 }), { minLength: 0, maxLength: 30 });

test('Property 21: in-progress encodes never exceed the permit limit (Requirements 13.1, 13.2)', async () => {
  await fc.assert(
    fc.asyncProperty(permitsArb, worksArb, async (permits, works) => {
      const { maxLive, violations, sem } = await runSchedule(permits, works);

      // Invariant: live in-progress count never exceeded the configured limit.
      assert.equal(violations.length, 0, `live count exceeded permits: ${violations}`);
      assert.ok(maxLive <= permits, `maxLive ${maxLive} exceeded permits ${permits}`);

      // After all tasks complete the semaphore is fully drained.
      assert.equal(sem.inProgress, 0, 'inProgress should be 0 after completion');
      assert.equal(sem.queued, 0, 'queue should be empty after completion');
    }),
    { numRuns: 200 }
  );
});

test('Property 21: queued encodes are granted in FIFO order (Requirements 13.1, 13.2)', async () => {
  await fc.assert(
    fc.asyncProperty(permitsArb, worksArb, async (permits, works) => {
      const { grantOrder } = await runSchedule(permits, works);

      // Tasks are issued in index order 0..N-1. The first `permits` are granted
      // immediately in order, and every queued task is dequeued FIFO. So permits
      // are always granted strictly in request order.
      const expected = works.map((_w, i) => i);
      assert.deepStrictEqual(
        grantOrder,
        expected,
        `grant order ${grantOrder} was not FIFO ${expected}`
      );
    }),
    { numRuns: 200 }
  );
});

// --- Unit tests: concrete, deterministic scenarios ---

test('never grants more than `permits` simultaneously under heavy contention', async () => {
  const sem = new EncodeSemaphore(2);
  const releases = [];
  // Acquire 5 permits against a limit of 2.
  const acquisitions = [0, 1, 2, 3, 4].map(() => sem.acquire());

  // Let the microtask queue settle.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(sem.inProgress, 2, 'only 2 should be in progress');
  assert.equal(sem.queued, 3, '3 should be waiting');

  releases.push(await acquisitions[0]);
  releases.push(await acquisitions[1]);

  // Release one; exactly one queued waiter should start.
  releases[0]();
  releases.push(await acquisitions[2]);
  await Promise.resolve();
  assert.equal(sem.inProgress, 2, 'still capped at 2 after one release + one grant');
  assert.equal(sem.queued, 2, 'one fewer in the queue');

  // Drain the rest.
  releases[1]();
  releases.push(await acquisitions[3]);
  releases[2]();
  releases.push(await acquisitions[4]);
  releases[3]();
  releases[4]();
  await Promise.resolve();
  assert.equal(sem.inProgress, 0);
  assert.equal(sem.queued, 0);
});

test('single permit serializes all encodes (FIFO, one at a time)', async () => {
  const sem = new EncodeSemaphore(1);
  const order = [];
  let live = 0;
  let maxLive = 0;

  async function task(i) {
    const release = await sem.acquire();
    order.push(i);
    live += 1;
    maxLive = Math.max(maxLive, live);
    await Promise.resolve();
    live -= 1;
    release();
  }

  await Promise.all([task(0), task(1), task(2)]);
  assert.equal(maxLive, 1, 'only one encode ran at a time');
  assert.deepStrictEqual(order, [0, 1, 2], 'FIFO order preserved');
});

test('release is idempotent and does not over-release a permit', async () => {
  const sem = new EncodeSemaphore(1);
  const releaseA = await sem.acquire();
  const pendingB = sem.acquire();

  releaseA();
  releaseA(); // second call must be a no-op
  const releaseB = await pendingB;

  assert.equal(sem.inProgress, 1, 'idempotent release must not free an extra permit');
  assert.equal(sem.queued, 0);
  releaseB();
  assert.equal(sem.inProgress, 0);
});
