'use strict';

/**
 * Property 2: Recipes route only to their own video.
 *
 * For any set of uploaded videos and for any map of recipes keyed by upload
 * key, each video is planned with exactly its keyed recipe and no other, and
 * videos without a key are planned as skipped.
 *
 * **Validates: Requirements 1.3, 1.4**
 *
 * Unit under test (pure routing core, src/server/processRouting.js):
 *   - routeRecipes(files, recipesMap)
 *
 * routeRecipes returns an array of `{ key, recipe }` index-aligned with `files`.
 * For each file, `recipe === recipesMap[file.key]` (same reference) when the
 * file has a non-empty key present in the map; otherwise `recipe` is `null`
 * (the skipped / legacy path). The function must not mutate its inputs.
 */

const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { routeRecipes } = require('../src/server/processRouting');

const NUM_RUNS = 200; // >= 100 generated cases per task requirement.

/**
 * A distinct recipe object. The `tag` makes each generated recipe identifiable
 * so we can assert reference identity and detect cross-contamination.
 */
const recipeArb = () =>
  fc.record({
    version: fc.constant(1),
    tag: fc.string({ minLength: 1, maxLength: 12 }),
    volume: fc.integer({ min: 0, max: 100 }),
  });

/**
 * A file's key: sometimes a normal unique-ish key, sometimes empty, sometimes
 * missing entirely (undefined). Empty/missing keys must route to skipped.
 */
const fileKeyArb = () =>
  fc.oneof(
    { weight: 6, arbitrary: fc.string({ minLength: 1, maxLength: 20 }).map((s) => `upload/${s}`) },
    { weight: 1, arbitrary: fc.constant('') },
    { weight: 1, arbitrary: fc.constant(undefined) }
  );

/**
 * Build a scenario: a list of files (each possibly keyed) and a recipes map
 * keyed by a subset of those file keys PLUS some keys that are not present in
 * any file (orphan recipes that must never be routed).
 */
const scenarioArb = () =>
  fc
    .array(fileKeyArb(), { minLength: 0, maxLength: 8 })
    .chain((keys) => {
      const files = keys.map((key, i) =>
        key === undefined ? { originalName: `v${i}.mp4` } : { key, originalName: `v${i}.mp4` }
      );

      // Real, non-empty keys that exist on files; candidates for the map.
      const presentKeys = Array.from(
        new Set(keys.filter((k) => typeof k === 'string' && k !== ''))
      );

      // Orphan keys: guaranteed NOT to collide with any file key.
      const orphanKeyArb = fc
        .string({ minLength: 1, maxLength: 10 })
        .map((s) => `orphan/${s}`)
        .filter((k) => !presentKeys.includes(k));

      return fc
        .record({
          // A subset of present keys that will get a recipe in the map.
          mappedSubset: fc.subarray(presentKeys),
          orphanKeys: fc.array(orphanKeyArb, { minLength: 0, maxLength: 4 }),
          // One recipe per (subset + orphan) key, generated below.
          recipeSeeds: fc.array(recipeArb(), { minLength: 0, maxLength: 12 }),
        })
        .map(({ mappedSubset, orphanKeys, recipeSeeds }) => {
          const map = {};
          const allMapKeys = Array.from(new Set([...mappedSubset, ...orphanKeys]));
          allMapKeys.forEach((k, idx) => {
            const seed = recipeSeeds[idx % Math.max(1, recipeSeeds.length)] || { version: 1, tag: 'r', volume: 0 };
            // Fresh object per key so reference identity is meaningful.
            map[k] = { ...seed, _forKey: k };
          });
          return { files, recipesMap: map, presentKeys };
        });
    });

test('Property 2: each file routes to exactly its own keyed recipe (same reference) or null', () => {
  fc.assert(
    fc.property(scenarioArb(), ({ files, recipesMap }) => {
      const routed = routeRecipes(files, recipesMap);

      // Result is index-aligned 1:1 with files.
      assert.strictEqual(routed.length, files.length, 'routed length must equal files length');

      routed.forEach((entry, i) => {
        const file = files[i];
        const key = file.key;
        const hasKey = typeof key === 'string' && key !== '';
        const mapHasEntry =
          hasKey && Object.prototype.hasOwnProperty.call(recipesMap, key) && recipesMap[key] != null;

        if (mapHasEntry) {
          // Routed to its OWN recipe, by reference.
          assert.strictEqual(
            entry.recipe,
            recipesMap[key],
            `file[${i}] (key=${key}) must route to its own recipe by reference`
          );
          // The recipe must be the one stored under this exact key, not another.
          assert.strictEqual(
            entry.recipe._forKey,
            key,
            `file[${i}] routed to a recipe stored under a different key (${entry.recipe._forKey})`
          );
        } else {
          // No key, or no matching map entry => skipped (legacy path).
          assert.strictEqual(
            entry.recipe,
            null,
            `file[${i}] (key=${JSON.stringify(key)}) should be skipped (recipe null)`
          );
        }
      });
    }),
    { numRuns: NUM_RUNS }
  );
});

test('Property 2: no recipe leaks to a file whose key it is not stored under', () => {
  fc.assert(
    fc.property(scenarioArb(), ({ files, recipesMap }) => {
      const routed = routeRecipes(files, recipesMap);

      routed.forEach((entry, i) => {
        if (entry.recipe === null) return;
        // The routed recipe must be the SAME object the map holds under this
        // file's key — never an object stored under any other key.
        const key = files[i].key;
        assert.strictEqual(
          entry.recipe,
          recipesMap[key],
          `file[${i}] received a recipe that is not the one keyed by its own key`
        );
        // And it must not be any other key's distinct recipe object.
        for (const mapKey of Object.keys(recipesMap)) {
          if (mapKey !== key) {
            assert.notStrictEqual(
              entry.recipe,
              recipesMap[mapKey],
              `file[${i}] received the recipe stored under foreign key ${mapKey}`
            );
          }
        }
      });

      // Orphan recipes (keys not on any file) must appear in NO routed entry.
      const fileKeys = new Set(
        files.map((f) => f.key).filter((k) => typeof k === 'string' && k !== '')
      );
      for (const mapKey of Object.keys(recipesMap)) {
        if (!fileKeys.has(mapKey)) {
          const leaked = routed.some((e) => e.recipe === recipesMap[mapKey]);
          assert.strictEqual(leaked, false, `orphan recipe for key ${mapKey} leaked into routing`);
        }
      }
    }),
    { numRuns: NUM_RUNS }
  );
});

test('Property 2: files without a key (or empty key) route to skipped', () => {
  fc.assert(
    fc.property(scenarioArb(), ({ files, recipesMap }) => {
      const routed = routeRecipes(files, recipesMap);
      routed.forEach((entry, i) => {
        const key = files[i].key;
        if (key === undefined || key === '') {
          assert.strictEqual(entry.recipe, null, `keyless file[${i}] must be skipped`);
        }
      });
    }),
    { numRuns: NUM_RUNS }
  );
});

test('Property 2: routeRecipes does not mutate files or recipesMap', () => {
  fc.assert(
    fc.property(scenarioArb(), ({ files, recipesMap }) => {
      const filesSnapshot = JSON.stringify(files);
      const mapSnapshot = JSON.stringify(recipesMap);
      const mapKeysBefore = Object.keys(recipesMap).slice();

      routeRecipes(files, recipesMap);

      assert.strictEqual(JSON.stringify(files), filesSnapshot, 'files must not be mutated');
      assert.strictEqual(JSON.stringify(recipesMap), mapSnapshot, 'recipesMap must not be mutated');
      assert.deepStrictEqual(
        Object.keys(recipesMap),
        mapKeysBefore,
        'recipesMap keys must not change'
      );
    }),
    { numRuns: NUM_RUNS }
  );
});
