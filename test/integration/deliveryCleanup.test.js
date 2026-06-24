'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  RequestContext,
  cleanupRequest,
  startupSweep,
} = require('../../src/server/cleanup');

/**
 * Integration test — end-to-end delivery and cleanup.
 *
 * Validates: Requirements 14.1, 14.2, 14.7
 *
 *  - 14.1: on successful processing, all local-disk artifacts (uploads,
 *          compressed outputs, chunks, music files, sticker assets) are deleted.
 *  - 14.2: once all output clips are delivered, all R2 output clips, chunks,
 *          music files, and sticker assets for the request are deleted from R2.
 *  - 14.7: after cleanup, the request prefix is verified empty in R2 and any
 *          survivor is re-attempted (cleanupRequest result.verified === true).
 *
 * Reality check: `server.js` binds the HTTP port and starts Baileys as a side
 * effect of `require`, so it is NOT imported here. Instead the end-to-end flow
 * is assembled from the EXTRACTED, testable modules (`RequestContext`,
 * `cleanupRequest`, `startupSweep` from `src/server/cleanup.js`) against:
 *   - an IN-MEMORY mock R2 store (a Map of key -> bytes), and
 *   - a REAL temporary local disk directory (so the disk-cleanup contract is
 *     exercised against the filesystem, not a mock).
 *
 * Baileys is mocked entirely (a stub `sendMessage` / `sendWhatsAppVideo` that
 * resolves) — no real network. No ffmpeg is involved: outputs are modeled as
 * plain temp files, so this test needs no real encoder.
 *
 * The modeled lifecycle mirrors `server.js`:
 *   1. process: download inputs, produce outputs/chunks, upload outputs +
 *      music/sticker assets to R2, register every artifact in the ledger.
 *   2. deliver: the mocked Baileys "sends" each output clip (fetching its bytes
 *      from the mock R2 first), and delivery-time cleanup deletes each delivered
 *      clip from R2 and purges the music/sticker asset keys (as
 *      `handleIncomingMessage` does).
 *   3. teardown: `cleanupRequest` removes every remaining ledger item from both
 *      stores and verifies the request prefix is empty in R2.
 *
 * Note on ordering: in the live server the request `finally` cleanup and the
 * later delivery both contribute to the final empty state. Delivery clips are
 * tracked on the session (NOT the cleanup ledger) so they survive the request
 * `finally` long enough to be sent. This test runs delivery (+ its cleanup)
 * before the final `cleanupRequest` so the asserted END STATE — nothing left
 * under the request prefix on either store — matches production, without the
 * teardown sweeping not-yet-delivered clips.
 */

// --- In-memory mock R2 store ------------------------------------------------

function makeMockR2() {
  /** @type {Map<string, Buffer>} */
  const store = new Map();
  return {
    put(key, data) {
      store.set(key, Buffer.from(data));
    },
    get(key) {
      if (!store.has(key)) {
        throw new Error(`R2 object not found: ${key}`);
      }
      return store.get(key);
    },
    delete(key) {
      store.delete(key);
    },
    has(key) {
      return store.has(key);
    },
    list(prefix) {
      const out = [];
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) out.push(k);
      }
      return out;
    },
    keys() {
      return [...store.keys()];
    },
  };
}

// --- Mock Baileys (resolves; no network) ------------------------------------

function makeBaileysMock(r2) {
  const sentVideos = [];
  const sentMessages = [];
  const baileys = {
    async sendMessage(jid, content) {
      if (content && content.video) {
        sentVideos.push({ jid, bytes: content.video.length, caption: content.caption });
      } else {
        sentMessages.push({ jid, text: content && content.text });
      }
    },
    // Mirrors server.js sendWhatsAppVideo: fetch the clip bytes from R2 then send.
    async sendWhatsAppVideo(jid, r2Key, caption) {
      const videoBuffer = r2.get(r2Key); // throws if the clip is missing
      await baileys.sendMessage(jid, { video: videoBuffer, caption: caption || '' });
    },
    sentVideos,
    sentMessages,
  };
  return baileys;
}

// --- Delivery model (mirrors handleIncomingMessage delivery + cleanup) -------

async function deliverSession(session, baileys, r2, jid) {
  // Send every output clip via the mocked Baileys transport.
  for (let i = 0; i < session.files.length; i++) {
    const file = session.files[i];
    const caption = i === 0 ? (session.caption || '') : '';
    await baileys.sendWhatsAppVideo(jid, file.fileName, caption);
  }
  // Delivery-time cleanup (Req 14.2): delete each delivered clip from R2, then
  // purge any uploaded Music_Track / Sticker R2 assets associated with the
  // request. Deletion is idempotent so the later teardown is a safe backstop.
  for (const file of session.files) {
    r2.delete(file.fileName);
  }
  for (const assetKey of session.assetKeys || []) {
    r2.delete(assetKey);
  }
}

// --- Cleanup deps: real disk for local paths, mock R2 for keys --------------

function makeCleanupDeps(r2) {
  const logged = { error: [], warn: [], info: [] };
  const deps = {
    async deleteLocalPath(p) {
      // force: absent ⇒ success (idempotent); recursive: remove dirs too.
      await fs.promises.rm(p, { force: true, recursive: true });
    },
    deleteR2Key(key) {
      r2.delete(key);
    },
    listR2Keys(prefix) {
      return r2.list(prefix);
    },
    logger: {
      error: (m) => logged.error.push(m),
      warn: (m) => logged.warn.push(m),
      info: (m) => logged.info.push(m),
    },
  };
  return { deps, logged };
}

// --- Disk scaffold helpers --------------------------------------------------

async function makeTempBase() {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'statusdrop-e2e-'));
  for (const dir of ['uploads', 'compressed', 'assets']) {
    await fs.promises.mkdir(path.join(base, dir), { recursive: true });
  }
  return base;
}

async function writeArtifact(absPath, bytes) {
  await fs.promises.writeFile(absPath, Buffer.from(bytes));
  return absPath;
}

/**
 * List every file remaining under the temp base across the swept dirs.
 * @param {string} base
 * @returns {Promise<string[]>}
 */
async function listDiskFiles(base) {
  const out = [];
  for (const dir of ['uploads', 'compressed', 'assets']) {
    const full = path.join(base, dir);
    let names = [];
    try {
      names = await fs.promises.readdir(full);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const name of names) out.push(path.join(full, name));
  }
  return out;
}

test('end-to-end: process -> deliver (Baileys mocked) -> cleanup leaves R2 and disk empty for the request prefix', async (t) => {
  const base = await makeTempBase();
  t.after(async () => {
    await fs.promises.rm(base, { force: true, recursive: true });
  });

  const requestId = 'req-e2e-0001';
  const prefix = `${requestId}/`;
  const r2 = makeMockR2();
  const baileys = makeBaileysMock(r2);
  const ctx = new RequestContext(requestId, { prefix });

  // --- 1. process: one short video (single clip) + one long video (2 chunks),
  //        plus an uploaded music track and a sticker asset. ----------------

  // Inputs downloaded to local disk + their source upload keys in R2.
  const inputLocal = [];
  for (let i = 0; i < 2; i++) {
    const p = await writeArtifact(path.join(base, 'uploads', `${requestId}-input-${i}.mp4`), `input-${i}`);
    inputLocal.push(p);
    ctx.addLocalPath(p);
    const key = `${prefix}uploads/input-${i}.mp4`;
    r2.put(key, `input-bytes-${i}`);
    ctx.addR2Key(key); // upload keys are ledger items (deleted at teardown)
  }

  // Local outputs/chunks produced on disk (modeled as plain temp files).
  const outputLocal = [];
  const localOutputNames = ['out-0.mp4', 'chunk-1-0.mp4', 'chunk-1-1.mp4'];
  for (const name of localOutputNames) {
    const p = await writeArtifact(path.join(base, 'compressed', `${requestId}-${name}`), `bytes-${name}`);
    outputLocal.push(p);
    ctx.addLocalPath(p);
  }

  // Output clips uploaded to R2 = DELIVERY artifacts tracked on the session,
  // NOT in the cleanup ledger (they must survive the request `finally`).
  const outputR2Keys = [
    `${prefix}output/out-0.mp4`,
    `${prefix}output/chunk-1-0.mp4`,
    `${prefix}output/chunk-1-1.mp4`,
  ];
  for (const key of outputR2Keys) {
    r2.put(key, `r2-${key}`);
  }

  // Music + sticker assets: present on local disk AND in R2; registered in the
  // ledger and also referenced as session asset keys (delivery backstop).
  const musicLocal = await writeArtifact(path.join(base, 'assets', `${requestId}-music.mp3`), 'music');
  const stickerLocal = await writeArtifact(path.join(base, 'assets', `${requestId}-sticker.png`), 'sticker');
  ctx.addLocalPath(musicLocal);
  ctx.addLocalPath(stickerLocal);

  const musicKey = `${prefix}music/track.mp3`;
  const stickerKey = `${prefix}sticker/s1.png`;
  r2.put(musicKey, 'music-bytes');
  r2.put(stickerKey, 'sticker-bytes');
  ctx.addR2Key(musicKey);
  ctx.addR2Key(stickerKey);

  const session = {
    status: 'ready',
    caption: 'My HD Status',
    files: outputR2Keys.map((key) => ({ fileName: key, url: `https://r2.example/${key}` })),
    assetKeys: [musicKey, stickerKey],
  };

  // Sanity: before delivery, the request prefix holds inputs + outputs + assets.
  assert.ok(r2.list(prefix).length >= outputR2Keys.length + 2, 'R2 should hold request artifacts before delivery');

  // --- 2. deliver via mocked Baileys + delivery-time cleanup ---------------
  await deliverSession(session, baileys, r2, '15555550100@s.whatsapp.net');

  // Every output clip was actually "sent" through the mocked transport.
  assert.strictEqual(baileys.sentVideos.length, outputR2Keys.length, 'all output clips delivered');
  assert.strictEqual(baileys.sentVideos[0].caption, 'My HD Status', 'first clip carries the caption');
  // After delivery cleanup, output clips + asset keys are gone from R2.
  for (const key of [...outputR2Keys, musicKey, stickerKey]) {
    assert.ok(!r2.has(key), `R2 should not retain delivered/asset key: ${key}`);
  }

  // --- 3. teardown: cleanupRequest removes remaining ledger items + verifies -
  const { deps } = makeCleanupDeps(r2);
  const result = await cleanupRequest(ctx, deps);

  // 14.7: verification passed — the request prefix is confirmed empty in R2.
  assert.strictEqual(result.verified, true, 'R2 prefix verification must pass');
  assert.deepStrictEqual(result.remaining, [], 'no R2 keys may remain under the prefix');

  // 14.2: no item associated with the request remains in R2.
  assert.deepStrictEqual(r2.list(prefix), [], 'R2 must be empty for the request prefix');
  assert.deepStrictEqual(r2.keys(), [], 'mock R2 must be fully empty');

  // 14.1: no item associated with the request remains on local disk.
  const remainingDisk = await listDiskFiles(base);
  const requestDiskFiles = remainingDisk.filter((p) => path.basename(p).startsWith(requestId));
  assert.deepStrictEqual(requestDiskFiles, [], 'local disk must be empty of request artifacts');
  for (const p of [...inputLocal, ...outputLocal, musicLocal, stickerLocal]) {
    assert.ok(!fs.existsSync(p), `local artifact must be deleted: ${p}`);
  }

  // Belt-and-suspenders (Req 14.x): a startup sweep with no active requests
  // finds no orphan request files left behind.
  const sweepDeps = {
    directories: ['uploads', 'compressed', 'assets'].map((d) => path.join(base, d)),
    normalize: (v) => path.resolve(v),
    async listDir(directory) {
      try {
        const names = await fs.promises.readdir(directory);
        return names.map((n) => path.join(directory, n));
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },
    async deleteLocalPath(p) {
      await fs.promises.rm(p, { force: true, recursive: true });
    },
    logger: { error() {}, warn() {}, info() {} },
  };
  const sweep = await startupSweep([], sweepDeps);
  const sweptRequestFiles = sweep.scanned.filter((p) => path.basename(p).startsWith(requestId));
  assert.deepStrictEqual(sweptRequestFiles, [], 'startup sweep finds no leftover request files');
});

test('end-to-end: a partial-delivery failure still ends with both stores empty after teardown', async (t) => {
  const base = await makeTempBase();
  t.after(async () => {
    await fs.promises.rm(base, { force: true, recursive: true });
  });

  const requestId = 'req-e2e-0002';
  const prefix = `${requestId}/`;
  const r2 = makeMockR2();
  const ctx = new RequestContext(requestId, { prefix });

  // Process produced 3 output clips + a music asset, all uploaded to R2, with
  // local copies on disk registered in the ledger.
  const outputR2Keys = [];
  for (let i = 0; i < 3; i++) {
    const key = `${prefix}output/clip-${i}.mp4`;
    r2.put(key, `clip-${i}`);
    outputR2Keys.push(key);
    const local = await writeArtifact(path.join(base, 'compressed', `${requestId}-clip-${i}.mp4`), `clip-${i}`);
    ctx.addLocalPath(local);
  }
  const musicKey = `${prefix}music/track.mp3`;
  r2.put(musicKey, 'music');
  ctx.addR2Key(musicKey);
  const musicLocal = await writeArtifact(path.join(base, 'assets', `${requestId}-music.mp3`), 'music');
  ctx.addLocalPath(musicLocal);

  // Outputs are delivery artifacts: track them on the ledger too for this
  // failure path, since on ANY failure before delivery completes the request
  // teardown must purge already-uploaded outputs from R2 as well (Req 14.3/14.7).
  for (const key of outputR2Keys) {
    ctx.addR2Key(key);
  }

  // Simulate delivery FAILING after the first clip (mocked Baileys throws).
  const r2ForBaileys = r2;
  const flakyBaileys = {
    sent: 0,
    async sendWhatsAppVideo(jid, key) {
      r2ForBaileys.get(key); // fetch ok
      this.sent += 1;
      if (this.sent >= 2) {
        throw new Error('Baileys send failed (mock)');
      }
    },
  };

  let deliveryError = null;
  try {
    for (const key of outputR2Keys) {
      await flakyBaileys.sendWhatsAppVideo('15555550100@s.whatsapp.net', key);
    }
  } catch (err) {
    deliveryError = err;
  }
  assert.ok(deliveryError, 'delivery should have failed partway');

  // On failure, the request teardown still removes everything from both stores.
  const { deps } = makeCleanupDeps(r2);
  const result = await cleanupRequest(ctx, deps);

  assert.strictEqual(result.verified, true, 'prefix verification must pass after failure teardown');
  assert.deepStrictEqual(r2.list(prefix), [], 'R2 must be empty for the request prefix after failure');
  assert.deepStrictEqual(r2.keys(), [], 'mock R2 must be fully empty after failure');

  const remainingDisk = await listDiskFiles(base);
  const requestDiskFiles = remainingDisk.filter((p) => path.basename(p).startsWith(requestId));
  assert.deepStrictEqual(requestDiskFiles, [], 'local disk must be empty of request artifacts after failure');
});
