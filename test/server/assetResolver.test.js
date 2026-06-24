'use strict';

/**
 * Tests for the Stage 1 asset resolver (src/server/assetResolver.js).
 *
 * Covers:
 *  - built-in stickers (/stickers/...) and library audio (/library/...) resolve
 *    to local public files;
 *  - uploaded assets (carrying an R2 key) become remote downloads;
 *  - path-traversal refs never escape the public directory;
 *  - markLoopingImageInputs adds -stream_loop only to .webp image inputs and is
 *    idempotent and non-destructive to the source video / non-webp inputs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  planRecipeAssets,
  markLoopingImageInputs,
  isStaticPublicRef,
  extOf,
} = require('../../src/server/assetResolver');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

test('built-in sticker refs resolve to local public paths (no download)', () => {
  const recipe = {
    stickers: [
      { id: 's1', assetRef: '/stickers/normal/0.webp' },
      { id: 's2', assetRef: '/stickers/animated/3.tgs' },
    ],
  };
  const { localPaths, remotes } = planRecipeAssets(recipe, { publicDir: PUBLIC });
  assert.equal(remotes.length, 0, 'no remote downloads for static assets');
  assert.equal(localPaths['/stickers/normal/0.webp'], path.resolve(PUBLIC, 'stickers/normal/0.webp'));
  assert.equal(localPaths['/stickers/animated/3.tgs'], path.resolve(PUBLIC, 'stickers/animated/3.tgs'));
});

test('uploaded sticker + music (with R2 key) become remote downloads keyed by ref', () => {
  const recipe = {
    stickers: [{ id: 's1', assetRef: 'asset_abc', key: 'stickers/asset_abc.webp' }],
    audio: { music: { assetRef: 'asset_song', key: 'music/asset_song.m4a' } },
  };
  let n = 0;
  const { localPaths, remotes } = planRecipeAssets(recipe, {
    publicDir: PUBLIC,
    tmpDir: 'uploads',
    genId: () => 'id' + (++n),
  });
  assert.deepEqual(localPaths, {}, 'no static local paths');
  assert.equal(remotes.length, 2);
  const byRef = Object.fromEntries(remotes.map((r) => [r.ref, r]));
  assert.equal(byRef['asset_abc'].key, 'stickers/asset_abc.webp');
  assert.ok(byRef['asset_abc'].tmpPath.endsWith('.webp'), 'temp keeps the asset extension');
  assert.equal(byRef['asset_song'].key, 'music/asset_song.m4a');
  assert.ok(byRef['asset_song'].tmpPath.endsWith('.m4a'));
});

test('path-traversal refs never escape the public directory', () => {
  const recipe = { stickers: [{ id: 's1', assetRef: '/stickers/../../etc/passwd' }] };
  const { localPaths } = planRecipeAssets(recipe, { publicDir: PUBLIC });
  assert.deepEqual(localPaths, {}, 'traversal ref is rejected, not mapped');
});

test('null recipe and missing fields are handled safely', () => {
  assert.deepEqual(planRecipeAssets(null, { publicDir: PUBLIC }), { localPaths: {}, remotes: [] });
  const r = planRecipeAssets({ stickers: [{ id: 'x' }], audio: {} }, { publicDir: PUBLIC });
  assert.deepEqual(r, { localPaths: {}, remotes: [] }, 'sticker without ref/key is unmapped');
});

test('isStaticPublicRef and extOf helpers', () => {
  assert.equal(isStaticPublicRef('/stickers/normal/0.webp'), true);
  assert.equal(isStaticPublicRef('/library/a.m4a'), true);
  assert.equal(isStaticPublicRef('asset_abc'), false);
  assert.equal(isStaticPublicRef('/uploads/x.webp'), false);
  assert.equal(extOf('/stickers/normal/0.webp'), '.webp');
  assert.equal(extOf('music/asset.m4a?x=1'), '.m4a');
  assert.equal(extOf('noext'), '');
});

test('markLoopingImageInputs loops .webp image inputs only, idempotently', () => {
  const plan = {
    inputs: [
      { type: 'video', path: 'uploads/in.mp4', args: ['-ss', '0', '-to', '5'] },
      { type: 'image', path: '/abs/public/stickers/normal/0.webp', args: [] },
      { type: 'image', path: 'text_t1.png', args: [] },
      { type: 'audio', path: 'uploads/asset_song.m4a', args: ['-ss', '2'] },
    ],
  };
  markLoopingImageInputs(plan, 5);
  assert.deepEqual(plan.inputs[0].args, ['-ss', '0', '-to', '5'], 'video input untouched');
  assert.deepEqual(plan.inputs[1].args, ['-stream_loop', '-1', '-t', '5'], 'webp loops, bounded by -t');
  assert.deepEqual(plan.inputs[2].args, [], 'png image untouched');
  assert.deepEqual(plan.inputs[3].args, ['-ss', '2'], 'audio input untouched');

  // Idempotent: a second pass does not duplicate the loop flag.
  markLoopingImageInputs(plan, 5);
  assert.deepEqual(plan.inputs[1].args, ['-stream_loop', '-1', '-t', '5']);
});

test('markLoopingImageInputs without a finite duration leaves webp un-looped (safe)', () => {
  const plan = { inputs: [{ type: 'image', path: 'a.webp', args: [] }] };
  markLoopingImageInputs(plan, 0);
  assert.deepEqual(plan.inputs[0].args, [], 'no unbounded loop when duration is missing');
  markLoopingImageInputs(plan, NaN);
  assert.deepEqual(plan.inputs[0].args, []);
});
