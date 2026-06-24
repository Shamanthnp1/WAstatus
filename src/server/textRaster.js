'use strict';

/**
 * Stage 2 — server-side Text_Overlay rasterization.
 *
 * The Render_Engine graph composites each Text_Overlay from a transparent PNG
 * resolved through `meta.textRasterPaths[overlayId]`. This module renders that
 * PNG from the recipe's text fields (text, color, optional background box,
 * font, fontSize) using `@napi-rs/canvas` (a prebuilt native canvas, no system
 * deps). The overlay's rotation/scale are applied by ffmpeg in the filter
 * graph, so the rasterized PNG itself is unrotated and rendered at fontSize px
 * (the recipe fontSize is already in 1920-tall canvas pixels, matching output).
 *
 * Editor fonts (@fontsource woff2) are registered best-effort so the rendered
 * text matches the in-app preview; unknown fonts fall back to the canvas
 * default. The native canvas is lazy-required so the server still starts if the
 * binary is unavailable on a platform (text rasterization then reports as
 * unavailable rather than crashing import).
 */

const fs = require('fs');
const path = require('path');

// Editor font catalog: [familyName, @fontsource dir, render weight].
const FONTS = [
  ['Roboto', 'roboto', 600],
  ['Caveat', 'caveat', 400],
  ['Fira Code', 'fira-code', 500],
  ['Bebas Neue', 'bebas-neue', 400],
  ['OpenDyslexic', 'opendyslexic', 600],
  ['Great Vibes', 'great-vibes', 400],
  ['Cormorant Garamond', 'cormorant-garamond', 600],
];
const FONT_WEIGHT = FONTS.reduce((m, f) => { m[f[0]] = f[2]; return m; }, {});

let _canvas = null;       // lazy @napi-rs/canvas module
let _fontsReady = false;

/** Lazy-load the native canvas; returns null when unavailable. */
function getCanvas() {
  if (_canvas !== null) return _canvas || null;
  try { _canvas = require('@napi-rs/canvas'); }
  catch (_) { _canvas = false; }
  return _canvas || null;
}

/** @returns {boolean} whether text rasterization is available on this host. */
function available() { return !!getCanvas(); }

/**
 * Register the editor fonts with the canvas (best-effort, once). Missing files
 * are skipped silently; the corresponding family simply falls back at render.
 * @param {Object} [opts]
 * @param {string} [opts.fontsRoot] - node_modules/@fontsource root.
 */
function ensureFonts(opts) {
  if (_fontsReady) return;
  const cv = getCanvas();
  if (!cv || !cv.GlobalFonts) { _fontsReady = true; return; }
  const root = (opts && opts.fontsRoot) || path.join(__dirname, '..', '..', 'node_modules', '@fontsource');
  for (const [family, dir] of FONTS) {
    const file = path.join(root, dir, 'files', `${dir}-latin-400-normal.woff2`);
    try { if (fs.existsSync(file)) cv.GlobalFonts.registerFromPath(file, family); } catch (_) {}
  }
  _fontsReady = true;
}

/**
 * Decide whether a recipe bgColor denotes a visible background box. A missing
 * color, or an 8-digit hex with a fully-transparent alpha (`...00`), means no
 * box (the text is drawn directly on the video).
 * @param {string} bgColor
 * @returns {{visible:boolean, color:string}}
 */
function parseBox(bgColor) {
  if (typeof bgColor !== 'string' || bgColor === '') return { visible: false, color: '' };
  const m8 = /^#([0-9a-f]{8})$/i.exec(bgColor);
  if (m8) {
    const alpha = m8[1].slice(6).toLowerCase();
    if (alpha === '00') return { visible: false, color: '' };
    // Canvas accepts #RRGGBBAA.
    return { visible: true, color: bgColor };
  }
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(bgColor)) return { visible: true, color: bgColor };
  return { visible: false, color: '' };
}

/**
 * Compute the PNG canvas dimensions and text placement for a text overlay.
 * Pure: line widths are supplied via the injected `measure` function so the
 * layout math is testable without a real canvas.
 *
 * @param {Object} args
 * @param {string} args.text
 * @param {number} args.fontSize - px (output-canvas units).
 * @param {boolean} args.hasBox
 * @param {(line:string)=>number} args.measure - line pixel-width measurer.
 * @returns {{width:number,height:number,padX:number,padY:number,lineHeight:number,lines:string[]}}
 */
function computeTextLayout(args) {
  const text = typeof args.text === 'string' ? args.text : '';
  const fontSize = Math.max(1, Number(args.fontSize) || 1);
  const hasBox = !!args.hasBox;
  const measure = typeof args.measure === 'function' ? args.measure : () => 0;

  const lines = text.split('\n');
  const lineHeight = Math.round(fontSize * 1.28);
  const padX = Math.round(fontSize * (hasBox ? 0.34 : 0.08));
  const padY = Math.round(fontSize * (hasBox ? 0.2 : 0.12));

  let textWidth = 0;
  for (const line of lines) textWidth = Math.max(textWidth, Math.ceil(measure(line) || 0));

  const width = Math.max(1, textWidth + 2 * padX);
  const height = Math.max(1, lineHeight * lines.length + 2 * padY);
  return { width, height, padX, padY, lineHeight, lines };
}

/** Draw a rounded rectangle path on a 2D context. */
function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Rasterize one Text_Overlay to a transparent PNG at `outPath`.
 *
 * @param {Object} overlay - { text, textColor, bgColor, font, fontSize }
 * @param {string} outPath - destination .png path.
 * @param {Object} [deps] - { fontsRoot } test override.
 * @returns {Promise<string>} resolves to outPath.
 */
async function rasterizeTextOverlay(overlay, outPath, deps) {
  const cv = getCanvas();
  if (!cv) throw new Error('text rasterization unavailable: @napi-rs/canvas not loaded');
  ensureFonts(deps);

  const o = overlay || {};
  const fontSize = Math.max(1, Number(o.fontSize) || 48);
  const family = (o.font && FONT_WEIGHT[o.font] != null) ? o.font : 'Roboto';
  const weight = FONT_WEIGHT[family] || 600;
  const fontSpec = `${weight} ${fontSize}px "${family}", sans-serif`;
  const box = parseBox(o.bgColor);

  // Measure with a scratch context, then size the real canvas.
  const scratch = cv.createCanvas(8, 8).getContext('2d');
  scratch.font = fontSpec;
  const layout = computeTextLayout({
    text: o.text, fontSize, hasBox: box.visible,
    measure: (line) => scratch.measureText(line).width,
  });

  const canvas = cv.createCanvas(layout.width, layout.height);
  const ctx = canvas.getContext('2d');
  if (box.visible) {
    ctx.fillStyle = box.color;
    roundRect(ctx, 0, 0, layout.width, layout.height, Math.round(fontSize * 0.34));
    ctx.fill();
  }
  ctx.font = fontSpec;
  ctx.fillStyle = o.textColor || '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < layout.lines.length; i++) {
    const y = layout.padY + i * layout.lineHeight + (layout.lineHeight - fontSize) / 2;
    ctx.fillText(layout.lines[i], layout.width / 2, y);
  }

  const buf = canvas.toBuffer('image/png');
  await fs.promises.writeFile(outPath, buf);
  return outPath;
}

/**
 * Rasterize all Text_Overlays in a recipe, writing PNGs into `outDir`.
 * @param {Object} recipe
 * @param {Object} opts - { outDir, genId, fontsRoot }
 * @returns {Promise<Object<string,string>>} map overlayId -> png path.
 */
async function rasterizeRecipeText(recipe, opts) {
  opts = opts || {};
  const outDir = opts.outDir || 'uploads';
  const genId = typeof opts.genId === 'function' ? opts.genId : () => String(Date.now()) + Math.random().toString(36).slice(2);
  const overlays = recipe && Array.isArray(recipe.textOverlays) ? recipe.textOverlays : [];
  const map = {};
  for (const t of overlays) {
    const outPath = path.join(outDir, `text_${genId()}.png`);
    await rasterizeTextOverlay(t, outPath, opts);
    map[t.id] = outPath;
  }
  return map;
}

module.exports = {
  available,
  ensureFonts,
  parseBox,
  computeTextLayout,
  rasterizeTextOverlay,
  rasterizeRecipeText,
  FONTS,
  FONT_WEIGHT,
};
