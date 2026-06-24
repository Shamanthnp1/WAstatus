'use strict';

/**
 * Stage 1 asset resolution for the Render_Engine execution layer.
 *
 * The pure planner (`renderEngine.planRender`) emits a filter graph that
 * references each overlay / music asset by its recipe `assetRef`, resolving the
 * concrete on-disk path through `meta.assetPaths[ref]`. This module decides,
 * for a given recipe, which assets are server-owned static files (served from
 * `public/`, e.g. built-in stickers under `/stickers/...` or library audio
 * under `/library/...`) versus user-uploaded assets that must be downloaded
 * from R2 (carrying an R2 `key`).
 *
 * It is intentionally side-effect free: it returns the local-path map for
 * static assets plus a list of remote downloads for the caller (server.js) to
 * fetch and register for cleanup. This keeps the path/decision logic unit
 * testable without R2 or the filesystem.
 */

const path = require('path');

/** Lower-cased extension (with dot) of a name, or '' when none. */
function extOf(name) {
  const s = typeof name === 'string' ? name : '';
  const dot = s.lastIndexOf('.');
  if (dot <= 0 || dot === s.length - 1) return '';
  // Strip any query string from a URL-ish ref before reading the extension.
  return s.slice(dot).split('?')[0].toLowerCase();
}

/** A ref is a server-owned static asset when it lives under /stickers or /library. */
function isStaticPublicRef(ref) {
  return typeof ref === 'string' && /^\/(stickers|library)\//.test(ref);
}

/**
 * Plan the asset resolution for a recipe.
 *
 * @param {Object|null} recipe - The Edit_Recipe (or null for skip path).
 * @param {Object} [opts]
 * @param {string} [opts.publicDir='public'] - Directory that serves static assets.
 * @param {string} [opts.tmpDir='uploads'] - Directory for downloaded temp files.
 * @param {() => string} [opts.genId] - Unique id generator for temp filenames.
 * @returns {{ localPaths: Object<string,string>, remotes: {ref:string,key:string,tmpPath:string}[] }}
 *   `localPaths` maps assetRef -> absolute local path for static public assets.
 *   `remotes` lists uploaded assets to download (ref, R2 key, target temp path).
 */
function planRecipeAssets(recipe, opts) {
  opts = opts || {};
  const publicDir = opts.publicDir || 'public';
  const tmpDir = opts.tmpDir || 'uploads';
  const genId = typeof opts.genId === 'function' ? opts.genId : () => String(Date.now()) + Math.random().toString(36).slice(2);

  const localPaths = {};
  const remotes = [];
  const seen = new Set();
  const root = path.resolve(publicDir);

  function consider(ref, key) {
    if (!ref || typeof ref !== 'string' || seen.has(ref)) return;
    seen.add(ref);

    if (isStaticPublicRef(ref)) {
      // Server-owned file under public/. Guard against path traversal so a
      // crafted ref can never escape the public directory.
      const rel = ref.replace(/^\/+/, '');
      const abs = path.resolve(publicDir, rel);
      if (abs === root || abs.startsWith(root + path.sep)) {
        localPaths[ref] = abs;
      }
      return;
    }
    if (key && typeof key === 'string') {
      const ext = extOf(key) || extOf(ref) || '';
      remotes.push({ ref, key, tmpPath: path.join(tmpDir, `asset_${genId()}${ext}`) });
    }
    // Otherwise unresolvable (no static path, no R2 key): left unmapped so the
    // planner falls back to the raw ref (the encode will surface the error).
  }

  if (recipe) {
    const stickers = Array.isArray(recipe.stickers) ? recipe.stickers : [];
    for (const s of stickers) consider(s && s.assetRef, s && s.key);
    const music = recipe.audio && recipe.audio.music;
    if (music) consider(music.assetRef, music.key);
  }

  return { localPaths, remotes };
}

/**
 * Mutate a RenderPlan so animated/static `.webp` image inputs loop for the full
 * clip. Each webp image input gets `-stream_loop -1 -t <duration>` prepended to
 * its args (idempotent): `-stream_loop -1` repeats the animation and `-t` bounds
 * that otherwise-endless input to the clip length so the encode terminates
 * (an unbounded looped input would make ffmpeg run forever). The source video
 * and non-webp inputs are untouched.
 *
 * Looping is only applied when a finite positive `durationSeconds` is supplied;
 * otherwise webp inputs are left as a single pass (overlay holds the last
 * frame), which is still safe.
 *
 * @param {{inputs?: {type?:string, path?:string, args?:string[]}[]}} plan
 * @param {number} durationSeconds - The clip/output duration to bound loops to.
 * @returns {typeof plan} the same plan, mutated in place.
 */
function markLoopingImageInputs(plan, durationSeconds) {
  if (!plan || !Array.isArray(plan.inputs)) return plan;
  const dur = Number(durationSeconds);
  if (!Number.isFinite(dur) || dur <= 0) return plan; // no safe bound -> no loop
  const tval = String(Math.max(0.1, dur));
  for (const input of plan.inputs) {
    if (!input || input.type !== 'image') continue;
    var ext = extOf(input.path);
    if (ext !== '.webp' && ext !== '.webm' && ext !== '.apng') continue;
    const args = Array.isArray(input.args) ? input.args.slice() : [];
    if (args.indexOf('-stream_loop') === -1) {
      input.args = ['-stream_loop', '-1', '-t', tval].concat(args);
    }
  }
  return plan;
}

module.exports = { planRecipeAssets, markLoopingImageInputs, isStaticPublicRef, extOf };
