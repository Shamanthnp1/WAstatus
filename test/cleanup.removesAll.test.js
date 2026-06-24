'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { RequestContext, cleanupRequest } = require('../src/server/cleanup');

/**
 * Property 22: Cleanup removes every ledger item from both stores
 *
 * For any request artifact ledger (local paths and R2 keys, including uploads,
 * outputs, chunks, music files, and sticker assets), running cleanupRequest on
 * success OR on any failure removes every item from BOTH local disk and R2,
 * verifies the request prefix is empty in R2 afterward, and re-attempts deletion
 * of any survivor.
 *
 * Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.7, 14.8, 15.6
 *
 * Strategy: build IN-MEMORY MOCK stores — a Set of local paths and a Set of R2
 * keys — and inject deps that mutate them. The R2 prefix used for verification
 * is the request id; every generated R2 key is prefixed with the request id so
 * listR2Keys returns exactly the request's surviving keys. We generate ledgers
 * of various sizes covering all artifact categories, run cleanupRequest, then
 * assert both stores are empty for all ledger items and result.verified === true.
 */

/** A non-empty path-ish token (no whitespace), e.g. "uploads/abc.mp4". */
const fileName = () =>
  fc
    .string({ minLength: 1, maxLength: 24 })
    .map((s) => s.replace(/[^a-zA-Z0-9._-]/g, '') || 'x');

/** A local artifact path under one of the temp dirs the system uses. */
const localPathArb = () =>
  fc
    .tuple(fc.constantFrom('uploads', 'compressed', 'assets'), fileName(), fileName())
    .map(([dir, a, b]) => `${dir}/${a}-${b}`);

/**
 * An R2 key suffix categorized by artifact type. The request-id prefix is added
 * when the ledger is materialized so verification by prefix works.
 */
const r2SuffixArb = () =>
  fc
    .tuple(
      fc.constantFrom('output', 'chunk', 'music', 'sticker', 'upload'),
      fileName()
    )
    .map(([kind, name]) => `${kind}/${name}`);

/**
 * Build an in-memory mock environment: a local Set and an R2 Set, plus the deps
 * object cleanupRequest consumes. listR2Keys returns the R2 keys under a prefix.
 *
 * @param {Iterable<string>} initialLocal
 * @param {Iterable<string>} initialR2
 */
function makeMockEnv(initialLocal, initialR2) {
  const localStore = new Set(initialLocal);
  const r2Store = new Set(initialR2);
  const errors = [];
  const warns = [];

  const deps = {
    deleteLocalPath(p) {
      // idempotent: deleting an absent path is success
      localStore.delete(p);
    },
    deleteR2Key(key) {
      r2Store.delete(key);
    },
    listR2Keys(prefix) {
      const out = [];
      for (const k of r2Store) {
        if (k.startsWith(prefix)) out.push(k);
      }
      return out;
    },
    logger: {
      error: (m) => errors.push(m),
      warn: (m) => warns.push(m),
      info: () => {},
    },
  };

  return { localStore, r2Store, deps, errors, warns };
}

test('Property 22: cleanup removes every ledger item from both stores and verifies empty prefix', async () => {
  await fc.assert(
    fc.asyncProperty(
      // request id (used as the R2 prefix)
      fc.string({ minLength: 1, maxLength: 16 }).map((s) => `req_${s.replace(/[^a-zA-Z0-9]/g, '') || 'r'}`),
      // ledger of local paths (uploads/outputs/chunks/music/sticker assets)
      fc.array(localPathArb(), { minLength: 0, maxLength: 40 }),
      // ledger of R2 key suffixes across all artifact categories
      fc.array(r2SuffixArb(), { minLength: 0, maxLength: 40 }),
      async (requestId, localPaths, r2Suffixes) => {
        // Materialize R2 keys under the request prefix so prefix-listing is correct.
        const r2Keys = r2Suffixes.map((suffix) => `${requestId}/${suffix}`);

        const ctx = new RequestContext(requestId);
        ctx.addLocalPaths(localPaths);
        ctx.addR2Keys(r2Keys);

        // Stores start out holding exactly the ledgered artifacts (plus the
        // ledger may have deduped, which is fine — both share the same Sets).
        const { localStore, r2Store, deps } = makeMockEnv(ctx.localPaths, ctx.r2Keys);

        const result = await cleanupRequest(ctx, deps);

        // Every ledgered local path is gone from local disk.
        for (const p of ctx.localPaths) {
          assert.ok(!localStore.has(p), `local survivor: ${p}`);
        }
        // Every ledgered R2 key is gone from R2.
        for (const k of ctx.r2Keys) {
          assert.ok(!r2Store.has(k), `r2 survivor: ${k}`);
        }
        // The request prefix is empty in R2 (no key starts with the prefix).
        for (const k of r2Store) {
          assert.ok(!k.startsWith(requestId), `prefix not empty: ${k}`);
        }
        // The routine confirms verification.
        assert.strictEqual(result.verified, true);
      }
    ),
    { numRuns: 200 }
  );
});

test('Property 22: cleanup re-attempts and clears a late-appearing survivor under the prefix', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 12 }).map((s) => `req_${s.replace(/[^a-zA-Z0-9]/g, '') || 'r'}`),
      fc.array(r2SuffixArb(), { minLength: 1, maxLength: 20 }),
      r2SuffixArb(),
      async (requestId, ledgerSuffixes, survivorSuffix) => {
        const ledgerKeys = ledgerSuffixes.map((s) => `${requestId}/${s}`);
        const survivorKey = `${requestId}/orphan-${survivorSuffix}`;

        const ctx = new RequestContext(requestId);
        ctx.addR2Keys(ledgerKeys);

        // Survivor is present in R2 but NOT in the ledger — it must still be
        // discovered by the prefix listing and deleted on re-attempt (Req 14.8).
        const { r2Store, deps } = makeMockEnv([], [...ctx.r2Keys, survivorKey]);

        const result = await cleanupRequest(ctx, deps);

        assert.ok(result.reattempted.includes(survivorKey), 'survivor should be re-attempted');
        assert.ok(!r2Store.has(survivorKey), 'survivor should be deleted on re-attempt');
        for (const k of r2Store) {
          assert.ok(!k.startsWith(requestId), `prefix not empty: ${k}`);
        }
        assert.strictEqual(result.verified, true);
      }
    ),
    { numRuns: 100 }
  );
});
