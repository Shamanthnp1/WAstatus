'use strict';
// Entry point for the StatusDrop self-host bot inside the Android app.
//
// The app embeds nodejs-mobile 18 (Node 18, built without ICU). Baileys is
// written for Node 20+, and Android apps cannot write to /tmp. Everything here
// patches those gaps BEFORE the bot bundle (and Baileys inside it) loads, then
// imports bot.mjs. Each fix was found on a real phone during the spike.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

// 1. Node 18 has no global `crypto`; Baileys destructures `globalThis.crypto`.
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
}

// 2. AbortSignal.any arrived in Node 20 (used by file-type, a Baileys dependency).
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
  AbortSignal.any = (signals) => {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
  };
}

// 3. Without ICU, `new TextDecoder(label, { fatal: true })` throws. The WASM
//    glue in whatsapp-rust-bridge asks for a fatal UTF-8 decoder for strings
//    coming out of WASM memory, which are always valid UTF-8, so dropping
//    `fatal` is safe.
(() => {
  const Native = globalThis.TextDecoder;
  if (!Native) return;
  try {
    new Native('utf-8', { fatal: true });
    return;
  } catch (_) {
    // fall through and install the lenient decoder
  }
  class LenientTextDecoder extends Native {
    constructor(label = 'utf-8', options = undefined) {
      const opts = Object.assign({}, options || {});
      delete opts.fatal;
      super(label, opts);
    }
  }
  globalThis.TextDecoder = LenientTextDecoder;
  try {
    require('util').TextDecoder = LenientTextDecoder;
  } catch (_) {
    // util.TextDecoder is read-only on some builds; the global is enough.
  }
})();

// 4. Baileys writes encrypted media copies to os.tmpdir(). App processes run
//    with AT_SECURE set, so Node ignores TMPDIR and falls back to /tmp, which
//    apps cannot write. Point os.tmpdir() at the app's cache folder and sync
//    the ESM named export that Baileys imports.
const tmpDir = process.env.SD_TMP_DIR;
if (tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  os.tmpdir = () => tmpDir;
  require('module').syncBuiltinESMExports();
}

for (const name of ['SD_DATA_DIR', 'SD_TMP_DIR', 'SD_CLIPS_DIR']) {
  if (!process.env[name]) {
    console.error(`[selfhost] ${name} is not set; refusing to start.`);
    process.exit(2);
  }
}

import(pathToFileURL(path.join(__dirname, 'bot.mjs')).href).catch((error) => {
  console.error('[selfhost] bot failed to load:', error && error.stack ? error.stack : error);
  process.exit(1);
});
