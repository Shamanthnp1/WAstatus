'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { RequestContext, startupSweep } = require('../src/server/cleanup');

/**
 * Property 24: Startup sweep deletes exactly the orphans
 *
 * For any set of temporary files on disk and any set of active in-progress
 * requests, startupSweep deletes exactly the files NOT associated with an active
 * request and retains those that are.
 *
 * Validates: Requirements 14.5
 *
 * Strategy: build an IN-MEMORY MOCK of the swept directories — a Map of
 * directory -> listed file paths (what `listDir` returns) plus a Set tracking
 * which files remain on "disk" (mutated by `deleteLocalPath`). We randomly
 * generate files spread across the three swept directories, then randomly
 * designate a subset as "active" by registering them with the sweep through a
 * mix of RequestContext-like ledgers and plain string paths. After running
 * startupSweep we assert:
 *   - every active file is RETAINED (still present on disk + in result.retained),
 *   - every orphan is DELETED (absent from disk + in result.deleted), and
 *   - the deleted set is EXACTLY the non-active files (no more, no less).
 */

const SWEEP_DIRS = ['uploads', 'compressed', 'assets'];

/** A non-empty, path-safe file name token. */
const nameArb = () =>
  fc
    .string({ minLength: 1, maxLength: 24 })
    .map((s) => s.replace(/[^a-zA-Z0-9._-]/g, '') || 'x');

/**
 * One generated temp file: which directory it lives in, its name, whether it
 * belongs to an active request, and (if active) whether it is protected via a
 * RequestContext ledger or as a plain string path.
 */
const fileEntryArb = () =>
  fc.record({
    dir: fc.constantFrom(...SWEEP_DIRS),
    name: nameArb(),
    active: fc.boolean(),
    viaContext: fc.boolean(),
  });

/**
 * Build the in-memory mock environment: a `disk` Set holding every file path
 * currently present, a `listDir` that returns the files for a directory, and a
 * `deleteLocalPath` that removes a path from the disk Set (idempotent).
 *
 * @param {string[]} allFiles - every file path present on "disk".
 * @param {string[]} directories - directories to sweep.
 */
function makeSweepEnv(allFiles, directories) {
  const disk = new Set(allFiles);
  const dirToFiles = new Map(directories.map((d) => [d, []]));
  for (const filePath of allFiles) {
    const dir = filePath.slice(0, filePath.indexOf('/'));
    if (dirToFiles.has(dir)) {
      dirToFiles.get(dir).push(filePath);
    }
  }

  const deps = {
    directories,
    listDir(directory) {
      return dirToFiles.get(directory) || [];
    },
    deleteLocalPath(p) {
      disk.delete(p); // idempotent: deleting an absent path is success
    },
    logger: { error: () => {}, warn: () => {}, info: () => {} },
  };

  return { disk, deps };
}

test('Property 24: startup sweep deletes exactly the orphans and retains active files', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fileEntryArb(), { minLength: 0, maxLength: 80 }),
      async (entries) => {
        // De-duplicate by full path; first occurrence wins so each path has a
        // single, well-defined active/orphan designation.
        const byPath = new Map();
        for (const e of entries) {
          const filePath = `${e.dir}/${e.name}`;
          if (!byPath.has(filePath)) {
            byPath.set(filePath, e);
          }
        }

        const allFiles = [...byPath.keys()];
        const activeFiles = [];
        const orphanFiles = [];
        const contextPaths = [];
        const stringPaths = [];

        for (const [filePath, e] of byPath) {
          if (e.active) {
            activeFiles.push(filePath);
            if (e.viaContext) {
              contextPaths.push(filePath);
            } else {
              stringPaths.push(filePath);
            }
          } else {
            orphanFiles.push(filePath);
          }
        }

        // Designate the active subset through a MIX of an in-progress request's
        // ledger (RequestContext-like) and bare string paths.
        const ctx = new RequestContext('active-req');
        ctx.addLocalPaths(contextPaths);
        const activeRequests = [ctx, ...stringPaths];

        const { disk, deps } = makeSweepEnv(allFiles, SWEEP_DIRS);

        const result = await startupSweep(activeRequests, deps);

        // Every active file is retained: still on disk and reported retained.
        const retainedSet = new Set(result.retained);
        for (const f of activeFiles) {
          assert.ok(disk.has(f), `active file should be retained on disk: ${f}`);
          assert.ok(retainedSet.has(f), `active file should be in result.retained: ${f}`);
        }

        // Every orphan is deleted: gone from disk and reported deleted.
        const deletedSet = new Set(result.deleted);
        for (const f of orphanFiles) {
          assert.ok(!disk.has(f), `orphan should be deleted from disk: ${f}`);
          assert.ok(deletedSet.has(f), `orphan should be in result.deleted: ${f}`);
        }

        // The deleted set is EXACTLY the non-active files — no more, no less.
        assert.strictEqual(result.deleted.length, orphanFiles.length, 'deleted count == orphan count');
        assert.strictEqual(deletedSet.size, orphanFiles.length, 'no duplicate deletions');
        assert.deepStrictEqual(deletedSet, new Set(orphanFiles), 'deleted set equals orphan set');

        // Retained set is exactly the active files; nothing failed.
        assert.strictEqual(retainedSet.size, activeFiles.length, 'retained set equals active set');
        assert.deepStrictEqual(retainedSet, new Set(activeFiles), 'retained set equals active set');
        assert.strictEqual(result.failures.length, 0, 'no deletion failures expected');

        // Everything on disk was scanned, and disk now holds exactly the active set.
        assert.strictEqual(new Set(result.scanned).size, allFiles.length, 'all files scanned');
        assert.strictEqual(disk.size, activeFiles.length, 'disk retains exactly the active files');
      }
    ),
    { numRuns: 200 }
  );
});
