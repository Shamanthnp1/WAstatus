// Bundles the self-host bot for the Android app.
//
// Output (gitignored, rebuilt by Gradle before every Android build):
//   android/app/src/max/assets/selfhost/main.js                  polyfills + loader
//   android/app/src/max/assets/selfhost/bot.mjs                  bot + Baileys, one ESM file for Node 18
//   android/app/src/max/assets/selfhost/THIRD_PARTY_LICENSES.txt licenses of every bundled package
// MAX edition only: the global (Play) build has no src/max assets.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'android', 'app', 'src', 'max', 'assets', 'selfhost');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(here, 'src', 'bot.mjs')],
  outfile: path.join(outDir, 'bot.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  // CommonJS dependencies call require() for Node built-ins; ESM output needs
  // a real require in scope for that.
  banner: {
    js: "import { createRequire as __statusdropCreateRequire } from 'node:module';\nconst require = __statusdropCreateRequire(import.meta.url);",
  },
  // Optional Baileys/ws helpers that are loaded with try/catch and are not
  // needed for sending videos.
  external: ['jimp', 'sharp', 'link-preview-js', 'audio-decode', 'qrcode-terminal', 'bufferutil', 'utf-8-validate'],
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

fs.copyFileSync(path.join(here, 'src', 'main.js'), path.join(outDir, 'main.js'));

// Collect a license notice for every npm package that ended up in the bundle.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const normalized = input.split(path.sep).join('/');
  const match = normalized.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//g);
  if (!match) continue;
  const last = match[match.length - 1];
  const start = normalized.lastIndexOf(last) + last.length;
  const root = path.resolve(here, normalized.slice(0, start));
  if (packages.has(root)) continue;
  packages.set(root, null);
}

const sections = [];
for (const root of [...packages.keys()].sort()) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const licenseFile = fs.readdirSync(root).find((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name));
  const text = licenseFile ? fs.readFileSync(path.join(root, licenseFile), 'utf8').trim() : '(No license file in the package. Declared license shown above.)';
  const declared = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license || 'UNKNOWN');
  sections.push(`${pkg.name} ${pkg.version}\nLicense: ${declared}\n\n${text}`);
}
const header = 'Third-party JavaScript packages bundled in the StatusDrop self-host bot (assets/selfhost/bot.mjs).\n' +
  'The bot runs on nodejs-mobile; its Node.js license is listed in THIRD_PARTY_NOTICES.md.\n';
fs.writeFileSync(
  path.join(outDir, 'THIRD_PARTY_LICENSES.txt'),
  `${header}\n${'='.repeat(78)}\n\n${sections.join(`\n\n${'='.repeat(78)}\n\n`)}\n`,
);

const size = fs.statSync(path.join(outDir, 'bot.mjs')).size;
console.log(`selfhost bundle: ${(size / 1024 / 1024).toFixed(2)} MB, ${packages.size} packages -> ${outDir}`);
