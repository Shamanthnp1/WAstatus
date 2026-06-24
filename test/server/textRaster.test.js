'use strict';

/**
 * Tests for the Stage 2 text rasterizer (src/server/textRaster.js).
 *
 * The pure pieces (parseBox, computeTextLayout) are tested directly. The actual
 * PNG render is an integration check that runs only when @napi-rs/canvas is
 * available on the host (skipped otherwise so CI without the native binary
 * still passes).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tr = require('../../src/server/textRaster');

test('parseBox: transparent / missing -> no box; opaque -> box', () => {
  assert.deepEqual(tr.parseBox('#00000000'), { visible: false, color: '' });
  assert.deepEqual(tr.parseBox(''), { visible: false, color: '' });
  assert.deepEqual(tr.parseBox(undefined), { visible: false, color: '' });
  assert.equal(tr.parseBox('#000000').visible, true);
  assert.equal(tr.parseBox('#34C759').visible, true);
  assert.equal(tr.parseBox('#000000cc').visible, true);
  assert.equal(tr.parseBox('#000000cc').color, '#000000cc');
});

test('computeTextLayout: single line sizes to text + padding', () => {
  const L = tr.computeTextLayout({ text: 'Hi', fontSize: 100, hasBox: false, measure: () => 180 });
  assert.equal(L.lines.length, 1);
  // padX = round(100*0.08)=8 -> width = 180 + 16
  assert.equal(L.width, 196);
  assert.ok(L.height >= 100, 'height at least one line');
});

test('computeTextLayout: box adds larger padding; multi-line grows height', () => {
  const noBox = tr.computeTextLayout({ text: 'A\nB', fontSize: 100, hasBox: false, measure: () => 50 });
  const box = tr.computeTextLayout({ text: 'A\nB', fontSize: 100, hasBox: true, measure: () => 50 });
  assert.equal(noBox.lines.length, 2);
  assert.ok(box.width > noBox.width, 'box padding widens the canvas');
  assert.ok(box.height > noBox.height, 'box padding heightens the canvas');
  // two lines => height ~ 2*lineHeight + 2*padY
  assert.ok(noBox.height >= noBox.lineHeight * 2);
});

test('computeTextLayout: empty/garbage input stays valid (>=1px)', () => {
  const L = tr.computeTextLayout({ text: '', fontSize: 0, hasBox: false, measure: () => 0 });
  assert.ok(L.width >= 1 && L.height >= 1);
});

test('rasterizeTextOverlay writes a PNG when canvas is available', async (t) => {
  if (!tr.available()) { t.skip('@napi-rs/canvas not available on this host'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdtxt-'));
  const out = path.join(dir, 'text.png');
  await tr.rasterizeTextOverlay(
    { id: 't1', text: 'Hello', textColor: '#FFFFFF', bgColor: '#000000cc', font: 'Roboto', fontSize: 72 },
    out
  );
  const buf = fs.readFileSync(out);
  // PNG signature.
  assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'output is a PNG');
  assert.ok(buf.length > 100, 'PNG has content');
  fs.rmSync(dir, { recursive: true, force: true });
});
