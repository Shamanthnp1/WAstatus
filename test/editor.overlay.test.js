'use strict';

/**
 * Unit tests for the text-overlay and sticker tools (task 12.2).
 *
 * Exercises the testable EditorInstance tool methods and the exported pure
 * helpers WITHOUT a real DOM, covering the add/edit/drag/transform paths and
 * the range/validation behavior in Requirements 5.1–5.6 and 6.1–6.5.
 */

const test = require('node:test');
const assert = require('node:assert');

const Editor = require('../public/js/editor');
const { EditorInstance, LIMITS } = Editor;

function newInstance() {
  return new EditorInstance(0, { uploadKey: 'upload/k0', sourceDuration: 30 });
}

test('isValidTextContent enforces 1..200 length and string type', () => {
  assert.strictEqual(Editor.isValidTextContent(''), false);
  assert.strictEqual(Editor.isValidTextContent('a'), true);
  assert.strictEqual(Editor.isValidTextContent('x'.repeat(200)), true);
  assert.strictEqual(Editor.isValidTextContent('x'.repeat(201)), false);
  assert.strictEqual(Editor.isValidTextContent(null), false);
  assert.strictEqual(Editor.isValidTextContent(123), false);
});

test('addTextOverlay records a complete in-range entry (Req 5.2/5.5)', () => {
  const inst = newInstance();
  const res = inst.addTextOverlay({
    text: 'Hello',
    textColor: '#FF0000',
    bgColor: '#00000080',
    font: 'Arial',
    fontSize: 999, // out of range -> clamped to 200
    pos: { x: 1.4, y: -0.2 }, // out of range -> clamped
    rotation: 400, // -> 40
  });
  assert.strictEqual(res.ok, true);
  const o = res.overlay;
  assert.strictEqual(o.text, 'Hello');
  assert.strictEqual(o.fontSize, LIMITS.FONT_SIZE_MAX);
  assert.strictEqual(o.pos.x, 1.0);
  assert.strictEqual(o.pos.y, 0.0);
  assert.strictEqual(o.rotation, 40);
  assert.ok(o.id);
  assert.strictEqual(inst.textOverlays.length, 1);
});

test('addTextOverlay rejects empty/over-length text without adding (Req 5.6)', () => {
  const inst = newInstance();
  assert.strictEqual(inst.addTextOverlay({ text: '' }).ok, false);
  assert.strictEqual(inst.addTextOverlay({ text: 'x'.repeat(201) }).ok, false);
  assert.strictEqual(inst.textOverlays.length, 0);
});

test('addTextOverlay enforces the 20-overlay cap (Req 5.1)', () => {
  const inst = newInstance();
  for (let i = 0; i < LIMITS.MAX_TEXT_OVERLAYS; i++) {
    assert.strictEqual(inst.addTextOverlay({ text: 'n' + i }).ok, true);
  }
  const res = inst.addTextOverlay({ text: 'overflow' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'max_overlays');
  assert.strictEqual(inst.textOverlays.length, LIMITS.MAX_TEXT_OVERLAYS);
});

test('updateTextOverlay rejects invalid text and preserves prior state (Req 5.6)', () => {
  const inst = newInstance();
  const { overlay } = inst.addTextOverlay({ text: 'original' });
  const id = overlay.id;

  const bad = inst.updateTextOverlay(id, { text: '', textColor: '#000000' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error, 'invalid_text');
  // Prior state preserved entirely (including the otherwise-valid color change).
  assert.strictEqual(inst.textOverlays[0].text, 'original');
  assert.strictEqual(inst.textOverlays[0].textColor, '#FFFFFF');
  // Invalid indication is set.
  assert.strictEqual(inst.isEntryInvalid(id), true);
  assert.strictEqual(inst.hasInvalidInput(), true);

  const tooLong = inst.updateTextOverlay(id, { text: 'x'.repeat(201) });
  assert.strictEqual(tooLong.ok, false);
  assert.strictEqual(inst.textOverlays[0].text, 'original');
});

test('updateTextOverlay applies valid changes and clears invalid indication', () => {
  const inst = newInstance();
  const { overlay } = inst.addTextOverlay({ text: 'original' });
  const id = overlay.id;
  inst.updateTextOverlay(id, { text: '' }); // set invalid
  assert.strictEqual(inst.isEntryInvalid(id), true);

  const ok = inst.updateTextOverlay(id, { text: 'updated', fontSize: 5, rotation: -10 });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(inst.textOverlays[0].text, 'updated');
  assert.strictEqual(inst.textOverlays[0].fontSize, LIMITS.FONT_SIZE_MIN); // clamped from 5
  assert.strictEqual(inst.textOverlays[0].rotation, 350); // -10 -> 350
  assert.strictEqual(inst.isEntryInvalid(id), false);
});

test('addSticker records assetRef and clamps transforms (Req 6.2/6.4)', () => {
  const inst = newInstance();
  const res = inst.addSticker({ assetRef: 'asset_x', pos: { x: 2, y: 0.3 }, scale: 99, rotation: 720 });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.sticker.assetRef, 'asset_x');
  assert.strictEqual(res.sticker.pos.x, 1.0);
  assert.strictEqual(res.sticker.scale, LIMITS.SCALE_MAX);
  assert.strictEqual(res.sticker.rotation, 0); // 720 % 360
});

test('addSticker rejects missing assetRef and enforces the 20 cap (Req 6.1)', () => {
  const inst = newInstance();
  assert.strictEqual(inst.addSticker({}).ok, false);
  for (let i = 0; i < LIMITS.MAX_STICKERS; i++) {
    assert.strictEqual(inst.addSticker({ assetRef: 'asset_' + i }).ok, true);
  }
  assert.strictEqual(inst.addSticker({ assetRef: 'overflow' }).ok, false);
  assert.strictEqual(inst.stickers.length, LIMITS.MAX_STICKERS);
});

test('applyDragToRelative clamps out-of-range center to nearest valid (Req 5.3/6.5)', () => {
  const inst = newInstance();
  const { sticker } = inst.addSticker({ assetRef: 'asset_x' });
  const pos = inst.applyDragToRelative(sticker.id, { x: 1.8, y: -0.5 });
  assert.deepStrictEqual(pos, { x: 1.0, y: 0.0 });
  assert.deepStrictEqual(inst.stickers[0].pos, { x: 1.0, y: 0.0 });

  const { overlay } = inst.addTextOverlay({ text: 'hi' });
  const p2 = inst.applyDragToRelative(overlay.id, { x: 0.25, y: 0.75 });
  assert.deepStrictEqual(p2, { x: 0.25, y: 0.75 });
});

test('applyTransform sets sticker scale/rotation, text fontSize/rotation (Req 5.4/6.3)', () => {
  const inst = newInstance();
  const { sticker } = inst.addSticker({ assetRef: 'asset_x' });
  const r1 = inst.applyTransform(sticker.id, { scale: 10, rotation: 90 });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(inst.stickers[0].scale, LIMITS.SCALE_MAX);
  assert.strictEqual(inst.stickers[0].rotation, 90);

  const { overlay } = inst.addTextOverlay({ text: 'hi' });
  const r2 = inst.applyTransform(overlay.id, { fontSize: 1, rotation: 45 });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(inst.textOverlays[0].fontSize, LIMITS.FONT_SIZE_MIN);
  assert.strictEqual(inst.textOverlays[0].rotation, 45);
});

test('applyPinch multiplies size and twists rotation, clamped (Req 5.4/6.3)', () => {
  const inst = newInstance();
  const { sticker } = inst.addSticker({ assetRef: 'asset_x', scale: 1.0, rotation: 350 });
  inst.applyPinch(sticker.id, 2.0, 20);
  assert.strictEqual(inst.stickers[0].scale, 2.0);
  assert.strictEqual(inst.stickers[0].rotation, 10); // 350 + 20 -> 370 -> 10

  // Clamp on extreme factor.
  inst.applyPinch(sticker.id, 100, 0);
  assert.strictEqual(inst.stickers[0].scale, LIMITS.SCALE_MAX);
});

test('pure helpers clamp scale/fontSize/rotation correctly', () => {
  assert.strictEqual(Editor.scaleByFactor(1, 100), LIMITS.SCALE_MAX);
  assert.strictEqual(Editor.scaleByFactor(1, 0.001), LIMITS.SCALE_MIN);
  assert.strictEqual(Editor.fontSizeByFactor(100, 10), LIMITS.FONT_SIZE_MAX);
  assert.strictEqual(Editor.rotateBy(350, 30), 20);
  assert.strictEqual(Editor.rotateBy(10, -30), 340);
});

test('recipe records all required fields within range after gestures (Req 5.5/6.4)', () => {
  const inst = newInstance();
  const t = inst.addTextOverlay({ text: 'Caption' }).overlay;
  inst.applyDragToRelative(t.id, { x: 3, y: 3 });
  inst.applyTransform(t.id, { fontSize: 64, rotation: 30 });
  const s = inst.addSticker({ assetRef: 'asset_y' }).sticker;
  inst.applyDragToRelative(s.id, { x: -1, y: 0.5 });
  inst.applyPinch(s.id, 1.5, 45);

  const recipe = inst.getRecipe();
  assert.ok(recipe);
  assert.strictEqual(recipe.textOverlays.length, 1);
  assert.strictEqual(recipe.stickers.length, 1);

  for (const o of recipe.textOverlays) {
    assert.ok(typeof o.id === 'string');
    assert.ok(Editor.isValidTextContent(o.text));
    assert.ok(o.textColor && o.bgColor && o.font);
    assert.ok(o.fontSize >= LIMITS.FONT_SIZE_MIN && o.fontSize <= LIMITS.FONT_SIZE_MAX);
    assert.ok(o.pos.x >= 0 && o.pos.x <= 1 && o.pos.y >= 0 && o.pos.y <= 1);
    assert.ok(o.rotation >= 0 && o.rotation <= 360);
  }
  for (const st of recipe.stickers) {
    assert.ok(typeof st.id === 'string');
    assert.ok(typeof st.assetRef === 'string' && st.assetRef.length > 0);
    assert.ok(st.pos.x >= 0 && st.pos.x <= 1 && st.pos.y >= 0 && st.pos.y <= 1);
    assert.ok(st.scale >= LIMITS.SCALE_MIN && st.scale <= LIMITS.SCALE_MAX);
    assert.ok(st.rotation >= 0 && st.rotation <= 360);
  }
});

test('removeEntry deletes an overlay/sticker and clears invalid flag', () => {
  const inst = newInstance();
  const t = inst.addTextOverlay({ text: 'a' }).overlay;
  inst.updateTextOverlay(t.id, { text: '' }); // set invalid
  assert.strictEqual(inst.removeEntry(t.id), true);
  assert.strictEqual(inst.textOverlays.length, 0);
  assert.strictEqual(inst.isEntryInvalid(t.id), false);
});
