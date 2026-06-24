'use strict';

/**
 * Tests for the Stage 3 .tgs rasterizer (src/server/tgsRaster.js).
 *
 * `inflateTgs` (gunzip + parse) is tested directly against a real built-in
 * sticker. The full render to a VP9/webm runs only when the canvas + lottie
 * stack is available on the host (skipped otherwise so CI stays green), and
 * asserts a non-trivial webm is produced.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pako = require('pako');

const tgs = require('../../src/server/tgsRaster');

const SAMPLE = path.join(__dirname, '..', '..', 'public', 'stickers', 'animated', '0.tgs');

test('inflateTgs gunzips a .tgs into Lottie JSON with expected fields', () => {
  if (!fs.existsSync(SAMPLE)) { return; } // sticker pack not present
  const data = tgs.inflateTgs(pako, SAMPLE);
  assert.equal(typeof data, 'object');
  assert.ok(data.w > 0 && data.h > 0, 'has dimensions');
  assert.ok(Array.isArray(data.layers), 'has layers');
  assert.ok(Number(data.fr) > 0, 'has frame rate');
});

test('renderTgsToApng produces an animated APNG when the stack is available', async (t) => {
  if (!tgs.available() || !fs.existsSync(SAMPLE)) { t.skip('canvas/lottie or sticker pack unavailable'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdtgs-'));
  const out = path.join(dir, 'a.apng');
  await tgs.renderTgsToApng(SAMPLE, out, { fps: 24 });
  assert.ok(fs.existsSync(out), 'apng written');
  assert.ok(fs.statSync(out).size > 500, 'apng has content');
  // PNG / APNG signature.
  const head = fs.readFileSync(out).slice(0, 4);
  assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47], 'output is a PNG/APNG');
  fs.rmSync(dir, { recursive: true, force: true });
});
