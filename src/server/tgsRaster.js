'use strict';

/**
 * Stage 3 — animated Telegram sticker (.tgs) rasterization.
 *
 * A .tgs is gzipped Lottie JSON. ffmpeg cannot render Lottie, so this module
 * renders the animation server-side and re-encodes it to an animated, alpha
 * VP9 `.webm` that the existing sticker pipeline composites (Stage 1 loops the
 * overlay input bounded by the clip length). Rendering uses `lottie-web`'s
 * canvas renderer driven by `@napi-rs/canvas` through a minimal DOM shim — no
 * headless Chromium and no native node-canvas/cairo build.
 *
 * The output is an **APNG** (animated PNG with alpha). APNG is used rather than
 * animated webp (ffmpeg-static can't decode ANIM webp) or VP9/webm (its alpha
 * plane is dropped by the overlay filter in this build, rendering transparent
 * areas black); APNG round-trips alpha correctly through ffmpeg's overlay.
 *
 * The shim + lottie player are loaded lazily and once; if either is unavailable
 * the module reports `available() === false` and callers fall back (the .tgs is
 * simply not composited rather than crashing the encode).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let _ready = null;     // null=untried, false=unavailable, true=ready
let _cv = null;        // @napi-rs/canvas
let _lottie = null;    // lottie-web canvas player

/** Install a minimal DOM shim (idempotent) so lottie-web loads under Node. */
function installShim(cv) {
  function def(name, value) {
    try { global[name] = value; }
    catch (_) { Object.defineProperty(global, name, { value: value, configurable: true, writable: true }); }
  }
  function fakeEl() {
    return {
      style: {}, attributes: {}, childNodes: [],
      setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
      appendChild(c) { this.childNodes.push(c); return c; },
      removeChild() {}, insertBefore(c) { this.childNodes.push(c); return c; },
      addEventListener() {}, removeEventListener() {},
      getContext() { return null; },
    };
  }
  if (typeof global.navigator === 'undefined') def('navigator', { userAgent: 'node' });
  if (typeof global.window === 'undefined') def('window', global);
  // Drive frames manually via goToAndStop; never schedule real animation loops.
  def('requestAnimationFrame', function () { return 0; });
  def('cancelAnimationFrame', function () {});
  if (typeof global.document === 'undefined') {
    def('document', {
      createElement(tag) { return tag === 'canvas' ? cv.createCanvas(1, 1) : fakeEl(); },
      createElementNS() { return fakeEl(); },
      getElementsByTagName() { return []; },
      body: fakeEl(),
    });
  }
}

/** Lazily load @napi-rs/canvas + lottie-web (canvas build). */
function ensureLottie() {
  if (_ready !== null) return _ready;
  try {
    _cv = require('@napi-rs/canvas');
    installShim(_cv);
    _lottie = require('lottie-web/build/player/lottie_canvas.js');
    _ready = !!(_lottie && typeof _lottie.loadAnimation === 'function');
  } catch (_) {
    _ready = false;
  }
  return _ready;
}

/** @returns {boolean} whether .tgs rasterization is available on this host. */
function available() { return ensureLottie(); }

function inflateTgs(pakoMod, srcPath) {
  const bytes = new Uint8Array(fs.readFileSync(srcPath));
  // .tgs is always gzipped Lottie; tolerate already-plain JSON too.
  const json = (bytes[0] === 0x1f && bytes[1] === 0x8b)
    ? pakoMod.inflate(bytes, { to: 'string' })
    : Buffer.from(bytes).toString('utf8');
  return JSON.parse(json);
}

function execFileP(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 1 << 24 }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Render a .tgs file to an animated, alpha **APNG** at `outApngPath`.
 *
 * @param {string} srcTgsPath - Local path to the .tgs (gzipped Lottie).
 * @param {string} outApngPath - Destination .apng path.
 * @param {Object} [opts]
 * @param {number} [opts.maxSize=512] - Max width/height (square stickers).
 * @param {number} [opts.fps=30] - Target fps cap (native fps is downsampled to this).
 * @param {string} [opts.ffmpegPath] - ffmpeg binary (defaults to ffmpeg-static).
 * @param {Object} [opts.pako] - pako module (defaults to require('pako')).
 * @returns {Promise<string>} resolves to outApngPath.
 */
async function renderTgsToApng(srcTgsPath, outApngPath, opts) {
  opts = opts || {};
  if (!ensureLottie()) throw new Error('tgs rasterization unavailable (@napi-rs/canvas / lottie-web not loaded)');
  const pako = opts.pako || require('pako');
  const ffmpegPath = opts.ffmpegPath || require('ffmpeg-static');

  const data = inflateTgs(pako, srcTgsPath);
  const maxSize = opts.maxSize || 512;
  const W = Math.max(1, Math.min(maxSize, data.w || maxSize));
  const H = Math.max(1, Math.min(maxSize, data.h || maxSize));
  const nativeFps = Number(data.fr) > 0 ? Number(data.fr) : 30;
  const targetFps = Math.min(nativeFps, opts.fps || 30);
  const step = Math.max(1, Math.round(nativeFps / targetFps));
  const outFps = nativeFps / step;
  const ip = Number.isFinite(data.ip) ? data.ip : 0;
  const op = Number.isFinite(data.op) ? data.op : nativeFps * 3;

  const canvas = _cv.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const anim = _lottie.loadAnimation({
    renderer: 'canvas', loop: false, autoplay: false, animationData: data,
    rendererSettings: { context: ctx, clearCanvas: true },
  });

  const framesDir = path.join(path.dirname(outApngPath), `_tgsframes_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(framesDir, { recursive: true });
  try {
    let n = 0;
    for (let f = ip; f < op; f += step) {
      ctx.clearRect(0, 0, W, H);
      anim.goToAndStop(f, true); // true => absolute frame number
      fs.writeFileSync(path.join(framesDir, 'f_' + String(++n).padStart(5, '0') + '.png'), canvas.toBuffer('image/png'));
    }
    if (n === 0) {
      ctx.clearRect(0, 0, W, H);
      anim.goToAndStop(ip, true);
      fs.writeFileSync(path.join(framesDir, 'f_00001.png'), canvas.toBuffer('image/png'));
    }
    try { anim.destroy(); } catch (_) {}

    // APNG preserves the RGBA alpha channel through ffmpeg's overlay filter.
    await execFileP(ffmpegPath, [
      '-y',
      '-framerate', String(outFps),
      '-i', path.join(framesDir, 'f_%05d.png'),
      '-f', 'apng',
      '-plays', '0',
      outApngPath,
    ]);
  } finally {
    try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch (_) {}
  }
  return outApngPath;
}

module.exports = { available, renderTgsToApng, renderTgsPoster, hasTrackMatte, inflateTgs };

/**
 * Whether a parsed Lottie/tgs uses a track matte (which lottie-web's canvas
 * renderer mishandles → white-shape artifact). Such stickers are excluded.
 * @param {Object} data - parsed Lottie JSON
 * @returns {boolean}
 */
function hasTrackMatte(data) {
  try { return /"tt"\s*:/.test(JSON.stringify(data)); } catch (_) { return false; }
}

/**
 * Render a single representative frame of a .tgs to a transparent PNG (a static
 * "poster" used in the editor preview so it doesn't animate on the client).
 * @param {string} srcTgsPath
 * @param {string} outPngPath
 * @param {Object} [opts] - { maxSize=256, pako }
 * @returns {Promise<string>} outPngPath
 */
async function renderTgsPoster(srcTgsPath, outPngPath, opts) {
  opts = opts || {};
  if (!ensureLottie()) throw new Error('tgs rasterization unavailable');
  const pako = opts.pako || require('pako');
  const data = inflateTgs(pako, srcTgsPath);
  const maxSize = opts.maxSize || 256;
  const W = Math.max(1, Math.min(maxSize, data.w || maxSize));
  const H = Math.max(1, Math.min(maxSize, data.h || maxSize));
  const ip = Number.isFinite(data.ip) ? data.ip : 0;
  const op = Number.isFinite(data.op) ? data.op : ip + 1;
  const canvas = _cv.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const anim = _lottie.loadAnimation({
    renderer: 'canvas', loop: false, autoplay: false, animationData: data,
    rendererSettings: { context: ctx, clearCanvas: true },
  });
  ctx.clearRect(0, 0, W, H);
  anim.goToAndStop(Math.floor((ip + op) / 2), true);
  const buf = canvas.toBuffer('image/png');
  try { anim.destroy(); } catch (_) {}
  fs.writeFileSync(outPngPath, buf);
  return outPngPath;
}
