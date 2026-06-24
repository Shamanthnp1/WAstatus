'use strict';

/**
 * Property 23: Cleanup is resilient to individual deletion failures.
 *
 * For any ledger in which an arbitrary subset of items fails to delete, the
 * Cleanup_Process logs each failure with its item identifier and reason,
 * continues attempting deletion of the remaining items, and does not abort, so
 * every non-failing item is still removed.
 *
 * **Validates: Requirements 14.6**
 *
 * Strategy: build in-memory mock stores (Sets) for local paths and R2 keys,
 * plus a randomly-chosen "failing subset" of items whose delete throws. A mock
 * logger captures every error call. Random ledgers and random failing subsets
 * are generated, then cleanupRequest is run against them. After the run we
 * assert the resilience contract: no throw, non-failing items removed, each
 * failing item logged, and the result failure lists reflect exactly the failing
 * items.
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { RequestContext, cleanupRequest } = require('../src/server/cleanup');

const NUM_RUNS = 150;

/**
 * Arbitrary for a ledger item: a unique name (within its store) plus a flag
 * indicating whether its deletion should throw. The `prefix` keeps local and
 * R2 names in separate namespaces, and keeps them distinct from the requestId
 * so the verification re-list focuses the test purely on the resilience pass.
 * @param {string} prefix
 */
function itemArb(prefix) {
  return fc.record({
    name: fc.string({ minLength: 1, maxLength: 16 }).map((s) => `${prefix}/${s}`),
    fail: fc.boolean(),
  });
}

/**
 * Arbitrary for a whole ledger: unique local items + unique R2 items + a
 * requestId. uniqueArray dedupes by the generated name so the in-memory Sets
 * mirror the ledger exactly.
 */
function ledgerArb() {
  return fc.record({
    requestId: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `req-${s}`),
    localItems: fc.uniqueArray(itemArb('local'), {
      selector: (x) => x.name,
      maxLength: 12,
    }),
    r2Items: fc.uniqueArray(itemArb('r2'), {
      selector: (x) => x.name,
      maxLength: 12,
    }),
  });
}

/**
 * Build mock deps backed by in-memory stores. Deleting an item in the failing
 * subset throws; otherwise it is removed from its store. The logger records
 * every error message so we can assert each failure was reported.
 */
function makeMockDeps({ localStore, r2Store, failingLocal, failingR2, errors }) {
  return {
    deleteLocalPath(p) {
      if (failingLocal.has(p)) {
        throw new Error(`disk EACCES for ${p}`);
      }
      localStore.delete(p);
    },
    deleteR2Key(k) {
      if (failingR2.has(k)) {
        throw new Error(`r2 503 for ${k}`);
      }
      r2Store.delete(k);
    },
    listR2Keys(prefix) {
      return [...r2Store].filter((k) => k.startsWith(prefix));
    },
    logger: {
      error: (msg) => errors.push(String(msg)),
      warn: () => {},
      info: () => {},
    },
  };
}

test('Property 23: cleanup is resilient to individual deletion failures', async () => {
  await fc.assert(
    fc.asyncProperty(ledgerArb(), async ({ requestId, localItems, r2Items }) => {
      // --- Arrange: in-memory stores + failing subsets ----------------------
      const localStore = new Set(localItems.map((i) => i.name));
      const r2Store = new Set(r2Items.map((i) => i.name));
      const failingLocal = new Set(localItems.filter((i) => i.fail).map((i) => i.name));
      const failingR2 = new Set(r2Items.filter((i) => i.fail).map((i) => i.name));
      const errors = [];

      const ctx = new RequestContext(requestId);
      ctx.addLocalPaths(localStore);
      ctx.addR2Keys(r2Store);

      const deps = makeMockDeps({ localStore, r2Store, failingLocal, failingR2, errors });

      // --- Act: must not abort on individual failures -----------------------
      let result;
      try {
        result = await cleanupRequest(ctx, deps);
      } catch (err) {
        assert.fail(`cleanupRequest aborted on individual failures: ${err && err.message}`);
      }

      // --- Assert: every NON-failing item was removed from its store --------
      for (const item of localItems) {
        if (!item.fail) {
          assert.ok(
            !localStore.has(item.name),
            `non-failing local path should be removed: ${item.name}`
          );
        }
      }
      for (const item of r2Items) {
        if (!item.fail) {
          assert.ok(
            !r2Store.has(item.name),
            `non-failing R2 key should be removed: ${item.name}`
          );
        }
      }

      // --- Assert: each failing item produced a logged error mentioning it ---
      for (const name of failingLocal) {
        assert.ok(
          errors.some((e) => e.includes(name)),
          `expected a logged error mentioning failing local path: ${name}`
        );
      }
      for (const name of failingR2) {
        assert.ok(
          errors.some((e) => e.includes(name)),
          `expected a logged error mentioning failing R2 key: ${name}`
        );
      }

      // --- Assert: result failure lists reflect exactly the failing items ----
      const localFailureItems = new Set(result.localFailures.map((f) => f.item));
      const r2FailureItems = new Set(result.r2Failures.map((f) => f.item));
      assert.deepStrictEqual(localFailureItems, failingLocal);
      assert.deepStrictEqual(r2FailureItems, failingR2);

      // Every recorded failure carries a non-empty reason.
      for (const f of [...result.localFailures, ...result.r2Failures]) {
        assert.equal(typeof f.reason, 'string');
        assert.ok(f.reason.length > 0, `failure for ${f.item} should carry a reason`);
      }

      // --- Assert: successful deletions are accounted for, no item lost ------
      assert.equal(
        result.localDeleted.length + result.localFailures.length,
        localItems.length,
        'every local ledger item is either deleted or recorded as a failure'
      );
      assert.equal(
        result.r2Deleted.length + result.r2Failures.length,
        r2Items.length,
        'every R2 ledger item is either deleted or recorded as a failure'
      );
    }),
    { numRuns: NUM_RUNS }
  );
});
