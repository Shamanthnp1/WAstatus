'use strict';
/**
 * Copy the user-provided sticker packs from "super stickers/" into
 * public/stickers/ and write manifest.json the editor fetches.
 *
 * Normal = .webp images. Animated = .tgs (gzipped Lottie). For animated stickers
 * we additionally:
 *   - SKIP any sticker that uses a track matte (lottie-web's canvas renderer,
 *     used server-side, renders those incorrectly — white-shape artifact);
 *   - render a static "poster" PNG (a mid frame) used by the editor preview so
 *     animated stickers don't run live Lottie on the client (no flicker/lag);
 *     the final video still animates them server-side.
 *
 * Re-runnable. Async because poster rendering uses the canvas/lottie stack.
 */
const fs = require('fs');
const path = require('path');
const pako = require('pako');
const tgs = require('../src/server/tgsRaster');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'super stickers');
const OUT = path.join(ROOT, 'public', 'stickers');

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function listFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(ext))
    .sort((a, b) => { const na = parseInt(a, 10), nb = parseInt(b, 10); return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b); })
    .map((f) => path.join(dir, f));
}

(async () => {
  rmrf(OUT);
  fs.mkdirSync(path.join(OUT, 'animated', 'poster'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'normal'), { recursive: true });

  const manifest = { animated: [], normal: [] };

  // --- Animated (.tgs): exclude track-matte stickers, build posters ---
  const animRoot = path.join(SRC, 'animated');
  let animIdx = 0, skippedMatte = 0;
  if (fs.existsSync(animRoot)) {
    for (const sub of fs.readdirSync(animRoot)) {
      const subDir = path.join(animRoot, sub);
      if (!fs.statSync(subDir).isDirectory()) continue;
      for (const file of listFiles(subDir, '.tgs')) {
        let data;
        try { data = JSON.parse(pako.inflate(new Uint8Array(fs.readFileSync(file)), { to: 'string' })); }
        catch (e) { continue; }
        if (tgs.hasTrackMatte(data)) { skippedMatte++; continue; } // renders wrong server-side
        const name = animIdx + '.tgs';
        const posterName = animIdx + '.png';
        fs.copyFileSync(file, path.join(OUT, 'animated', name));
        try {
          await tgs.renderTgsPoster(file, path.join(OUT, 'animated', 'poster', posterName), { pako: pako });
        } catch (e) { console.warn('poster failed for', name, e.message); continue; }
        manifest.animated.push({ tgs: '/stickers/animated/' + name, poster: '/stickers/animated/poster/' + posterName });
        animIdx++;
      }
    }
  }

  // --- Normal (.webp) ---
  const normRoot = path.join(SRC, 'normal');
  let normIdx = 0;
  if (fs.existsSync(normRoot)) {
    for (const sub of fs.readdirSync(normRoot)) {
      const subDir = path.join(normRoot, sub);
      if (!fs.statSync(subDir).isDirectory()) continue;
      for (const file of listFiles(subDir, '.webp')) {
        const name = normIdx + '.webp';
        fs.copyFileSync(file, path.join(OUT, 'normal', name));
        manifest.normal.push('/stickers/normal/' + name);
        normIdx++;
      }
    }
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));
  console.log(`Stickers built: ${manifest.animated.length} animated (+${skippedMatte} matte skipped), ${manifest.normal.length} normal`);
  process.exit(0);
})().catch((e) => { console.error('build-stickers failed:', e.message); process.exit(1); });
