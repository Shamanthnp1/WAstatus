'use strict';
/**
 * Copy the editor's vendor assets into public/vendor/ so the static frontend
 * (Vercel serves public/) can load them same-origin — bootstrap-icons, the
 * @fontsource latin webfonts, pako (gunzip .tgs) and lottie-web. The backend
 * also serves /vendor from node_modules, but the public copies are what the
 * live site uses. Re-runnable.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'public', 'vendor');

function cp(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Bootstrap Icons: CSS + the two webfonts it references.
cp(path.join(NM, 'bootstrap-icons/font/bootstrap-icons.css'), path.join(OUT, 'bootstrap-icons/bootstrap-icons.css'));
for (const f of ['bootstrap-icons.woff2', 'bootstrap-icons.woff']) {
  cp(path.join(NM, 'bootstrap-icons/font/fonts', f), path.join(OUT, 'bootstrap-icons/fonts', f));
}

// @fontsource fonts: each font's latin.css (400) + the latin-400 woff2/woff it references.
const FONTS = ['roboto', 'caveat', 'fira-code', 'bebas-neue', 'opendyslexic', 'great-vibes', 'cormorant-garamond'];
for (const dir of FONTS) {
  cp(path.join(NM, '@fontsource', dir, 'latin.css'), path.join(OUT, 'fonts', dir, 'latin.css'));
  for (const ext of ['woff2', 'woff']) {
    const name = `${dir}-latin-400-normal.${ext}`;
    const src = path.join(NM, '@fontsource', dir, 'files', name);
    if (fs.existsSync(src)) cp(src, path.join(OUT, 'fonts', dir, 'files', name));
  }
}

// pako (gunzip) + lottie-web (animated sticker render).
cp(path.join(NM, 'pako/dist/pako_inflate.min.js'), path.join(OUT, 'pako/pako_inflate.min.js'));
cp(path.join(NM, 'lottie-web/build/player/lottie.min.js'), path.join(OUT, 'lottie/lottie.min.js'));

let count = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else count++; } })(OUT);
console.log(`vendor assets copied to public/vendor/ (${count} files)`);
