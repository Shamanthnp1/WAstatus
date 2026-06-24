'use strict';
/**
 * Copy the user-provided sticker packs from "super stickers/" into
 * public/stickers/ with clean numbered names and write a manifest.json the
 * editor fetches. Animated = .tgs (gzipped Lottie), Normal = .webp.
 *
 * Re-runnable: clears and rebuilds public/stickers each time.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'super stickers');
const OUT = path.join(ROOT, 'public', 'stickers');

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function listFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(ext))
    .sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    })
    .map((f) => path.join(dir, f));
}

rmrf(OUT);
fs.mkdirSync(path.join(OUT, 'animated'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'normal'), { recursive: true });

const manifest = { animated: [], normal: [] };

// --- Animated (.tgs): every batch folder under animated/ ---
const animRoot = path.join(SRC, 'animated');
let animIdx = 0;
if (fs.existsSync(animRoot)) {
  for (const sub of fs.readdirSync(animRoot)) {
    const subDir = path.join(animRoot, sub);
    if (!fs.statSync(subDir).isDirectory()) continue;
    for (const file of listFiles(subDir, '.tgs')) {
      const name = animIdx + '.tgs';
      fs.copyFileSync(file, path.join(OUT, 'animated', name));
      manifest.animated.push('/stickers/animated/' + name);
      animIdx++;
    }
  }
}

// --- Normal (.webp): every batch folder under normal/ ---
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
console.log(`Stickers built: ${manifest.animated.length} animated, ${manifest.normal.length} normal -> ${OUT}`);
