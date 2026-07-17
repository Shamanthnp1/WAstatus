const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const compression = require('compression');
const crypto = require('crypto');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { enforceInputLimits } = require('./src/server/inputLimits');
const { routeRecipes, collectAvailableAssets } = require('./src/server/processRouting');
const { planRecipeAssets, markLoopingImageInputs } = require('./src/server/assetResolver');
const { rasterizeTextOverlay } = require('./src/server/textRaster');
const tgsRaster = require('./src/server/tgsRaster');
const musicRoutes = require('./src/server/musicRoutes');
const { validateRecipe } = require('./src/server/recipeValidator');
const { planRender, planChunk, chunkCount } = require('./src/server/renderEngine');
const { RequestContext, cleanupRequest, makeR2Deps, startupSweep, makeSweepDeps } = require('./src/server/cleanup');
const { defaultEncodeSemaphore } = require('./src/server/encodeSemaphore');
const {
  runGatedEncode,
  buildRecipeCommand,
  encodeRecipePlan,
  tightenEncodeOptions,
  FULL_VIDEO_TIMEOUT_MS,
  CHUNK_TIMEOUT_MS,
  RETRY_SIZE_MB,
  MAX_ENCODE_ATTEMPTS,
} = require('./src/server/encodeExec');
const { CLIP_DURATION_LIMIT } = require('./src/shared/constants');
require('dotenv').config();

// ========================
// APP SETUP
// ========================
const app = express();
app.use(compression());
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

if (!ffmpegStatic) {
  console.error('ffmpeg-static path is null!');
  process.exit(1);
}

console.log('FFmpeg path:', ffmpegStatic);
console.log('FFprobe path:', ffprobePath);
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobePath);

// ========================
// MIDDLEWARE
// ========================
app.use(cors({
  origin: [
    'https://wastatusvideo.com',
    'https://www.wastatusvideo.com',
    'https://wastatus-sigma.vercel.app',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(express.json());
app.use(express.static('public'));
// Serve Bootstrap Icons fonts/CSS for the in-app editor controls.
app.use('/vendor/bootstrap-icons', express.static(path.join(__dirname, 'node_modules/bootstrap-icons/font')));
// Serve @fontsource font CSS + files for the editor's text font picker.
app.use('/vendor/fonts', express.static(path.join(__dirname, 'node_modules/@fontsource')));
// Serve pako (gunzip .tgs) + lottie-web (render animated stickers) for the editor.
app.use('/vendor/pako', express.static(path.join(__dirname, 'node_modules/pako/dist')));
app.use('/vendor/lottie', express.static(path.join(__dirname, 'node_modules/lottie-web/build/player')));

// Mount the music / asset endpoints: GET /api/library (curated royalty-free
// library) and POST /api/music/upload-url + POST /api/music/validate (user
// audio upload path). No streaming-rip/import surface is exposed (Req 8.4).
musicRoutes.register(app);
app.use((req, res, next) => {
  req.on('aborted', () => {
    console.warn(`Request aborted by client: ${req.path}`);
  });
  next();
});

// ========================
// FOLDERS
// ========================
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads', { recursive: true });
if (!fs.existsSync('compressed')) fs.mkdirSync('compressed', { recursive: true });
// Persistent cache for animated .tgs stickers rendered to .webp (Stage 3), so
// built-in stickers are rendered once and reused across requests.
if (!fs.existsSync('tgs-cache')) fs.mkdirSync('tgs-cache', { recursive: true });

// ========================
// CLOUDFLARE R2 SETUP
// ========================
const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ========================
// CLEANUP_PROCESS WIRING
// ========================
// Set of RequestContext ledgers for requests currently in progress. The
// Startup_Sweep consults this so live work is retained while orphan temp files
// from a previous run are reclaimed (Req 14.5). Each /api/process invocation
// registers its ledger here on entry and removes it in `finally`.
const activeRequests = new Set();

// Production Cleanup_Process dependencies built from the real R2/S3 client and
// `fs`. cleanupRequest(ctx, cleanupDeps) deletes every registered local path
// and R2 key, logs per-item failures without aborting (Req 14.6), then lists
// the request prefix and re-attempts any survivor (Req 14.7/14.8).
const cleanupDeps = makeR2Deps({
  r2Client,
  bucket: process.env.R2_BUCKET_NAME,
  DeleteObjectCommand,
  ListObjectsV2Command,
  fs,
  logger: console,
});

/**
 * Collect the R2 object keys of UPLOADED Music_Track / Sticker assets referenced
 * by a recipe. These are non-output assets baked into the single encode, so they
 * are safe to purge once rendering is done; they are registered in the request
 * ledger (cleaned in the request `finally`) AND carried on the session so
 * delivery-time cleanup re-attempts their removal within 60s of delivery (Req
 * 14.2/14.4). Library (server-owned) assets are not uploaded and carry no key,
 * so they are never deleted.
 *
 * @param {Object|null} recipe
 * @returns {string[]}
 */
function collectAssetR2Keys(recipe) {
  const keys = [];
  if (!recipe) return keys;
  const music = recipe.audio && recipe.audio.music;
  if (music) {
    if (music.key) keys.push(String(music.key));
    else if (music.assetRef) keys.push(`music/${music.assetRef}`);
  }
  const stickers = Array.isArray(recipe.stickers) ? recipe.stickers : [];
  for (const sticker of stickers) {
    // Only uploaded stickers carry an R2 key; library stickers are server-owned.
    if (sticker && sticker.key) keys.push(String(sticker.key));
  }
  return keys;
}

// ========================
// SESSION STORAGE
// ========================
const sessions = new Map();
const recentlySentCodes = new Set();
// A send normally finishes in seconds; if a code has been "processing" for
// longer than this, the attempt is considered wedged and a new webhook may
// re-attempt delivery (kept above the per-send timeouts to avoid double-sends).
const PROCESSING_STALE_MS = 300000;

setInterval(async () => {
  const now = Date.now();
  for (const [code, session] of sessions.entries()) {
    if (now - session.createdAt > 300000) {
      for (const file of session.files) {
        try {
          await deleteFromR2(file.fileName);
          console.log(`R2 cleanup: ${file.fileName} deleted`);
        } catch (err) {
          console.error('R2 cleanup error:', err.message);
        }
      }
      sessions.delete(code);
      console.log(`Session expired & R2 cleaned: ${code}`);
    }
  }
}, 60000);

// =======================
// RATE LIMITING
// =======================
const limiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 50,
  message: { error: 'Daily limit reached! Try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/health',
});

// ========================
// HELPER FUNCTIONS
// ========================
function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 9; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Guarantee at least one digit. This lets the inbound parser pick the code out
  // of a natural sentence without ever matching a plain 9-letter English word.
  if (!/[0-9]/.test(code)) {
    const pos = Math.floor(Math.random() * 9);
    code = code.slice(0, pos) + Math.floor(Math.random() * 10) + code.slice(pos + 1);
  }
  return code;
}

function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error('ffprobe timeout after 30s'));
    }, 30000);
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) return reject(err);
      const duration = metadata.format.duration;
      console.log(`Video duration: ${duration} seconds`);
      resolve(duration);
    });
  });
}

function getVideoDimensions(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const v = metadata.streams.find(s => s.codec_type === 'video');
      const hasAudio = metadata.streams.some(s => s.codec_type === 'audio');
      resolve({ width: v?.width || 1080, height: v?.height || 1920, hasAudio });
    });
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Convert phone number to Baileys JID
function toJid(numberOrJid) {
  if (!numberOrJid) return null;
  if (numberOrJid.includes('@')) return numberOrJid;
  return `${numberOrJid.replace(/^\+/, '').replace(/\D/g, '')}@s.whatsapp.net`;
}

// Extract phone number from JID
function jidToNumber(jid) {
  return jid.split('@')[0];
}

// Incoming messages older than this (seconds) are treated as replays from a
// reconnect/relink history sync, not live requests, and are ignored. A real
// user sends their code within seconds of receiving it, so this window is safe.
const STALE_MESSAGE_SECONDS = 90;

// Normalize Baileys' messageTimestamp (number | Long | string) to seconds.
function messageTimestampSeconds(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts.toNumber === 'function') { try { return ts.toNumber(); } catch (_) { return 0; } }
  const n = Number(ts);
  return Number.isFinite(n) ? n : 0;
}

// ========================
// FFMPEG OPTIONS
// ========================
function getOutputOptions(duration, inputHeight = 1920, attempt = 0, enc = {}) {
  console.log(`✓ getOutputOptions called!`);
  // Encode target — defaults reproduce the exact WhatsApp_Spec 1080×1920 output
  // (byte-identical to the legacy path). The optional 60s mode overrides these
  // with a 720×1280 / lower-bitrate profile so a 60s clip still fits under 16MB.
  const W = enc.width || 1080;
  const H = enc.height || 1920;
  const crf = enc.crf != null ? enc.crf : 23;
  const maxrateK = enc.maxrateK != null ? enc.maxrateK : 3800;
  const bufsizeK = enc.bufsizeK != null ? enc.bufsizeK : 5700;
  let vfFilter = `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  const base = [
    '-vf', vfFilter,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'tv',
    '-color_primaries', 'bt470bg',
    '-color_trc', 'bt709',
    '-colorspace', 'bt470bg',
    '-crf', String(crf),
    '-maxrate', maxrateK + 'k',
    '-bufsize', bufsizeK + 'k',
    '-g', '250',
    '-profile:v', 'high',
    '-level:v', '4.0',
    '-x264-params', 'sei=0',
    // '-r', '29.97',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-b:a', '128k',
    '-brand', 'isom',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-threads', '2',
  ];
  // Attempt 0 is the exact WhatsApp_Spec encode (byte-identical legacy output).
  // Retries (attempt > 0) progressively lower the bitrate so an over-size clip
  // actually shrinks instead of failing the "under 16MB" check forever.
  return tightenEncodeOptions(base, attempt);
}

// Encode profile for the optional "Longer clips — 60s per part" mode: 720×1280
// at ~2 Mbps. At this bitrate 720p looks cleaner than a starved 1080p, and a
// ~59s clip lands comfortably under the 16MB WhatsApp limit.
const LONG_CLIP_ENC = { width: 720, height: 1280, crf: 24, maxrateK: 2200, bufsizeK: 3300 };
const LONG_CLIP_SECONDS = 59; // safety margin under WhatsApp's ~60s ceiling

// ========================
// ENCODE EXECUTION (semaphore-gated, with timeouts + size retry)
// ========================
// The encode-execution helpers (runGatedEncode, buildRecipeCommand,
// encodeRecipePlan) and the timeout / retry constants live in
// ./src/server/encodeExec.js so they can be unit-tested deterministically with
// mocked ffmpeg, a mock semaphore, and a mock fs (no real encoding / real time).
// They are imported at the top of this file and used unchanged below.

async function splitVideo(inputPath, outputDir, duration, chunkDuration = 29, inputHeight = 1920, enc = {}) {
  const totalChunks = Math.ceil(duration / chunkDuration);
  console.log(`Splitting into ${totalChunks} chunks of ${chunkDuration}s each`);

  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    const startTime = i * chunkDuration;
    const chunkFileName = `chunk_${uuidv4()}.mp4`;
    const chunkPath = path.join(outputDir, chunkFileName);
    chunks.push({ index: i, startTime, chunkPath });
  }

  // Semaphore-gated fan-out: every chunk encode acquires a permit from the
  // shared EncodeSemaphore, so simultaneous encodes never exceed the CPU-derived
  // Concurrency_Limit and the rest queue (Req 13.1/13.2). This replaces the old
  // hardcoded BATCH_SIZE ladder + per-batch Promise.all. The ffmpeg command per
  // chunk is unchanged, so skip-path chunk output stays byte-for-byte identical.
  const chunkPaths = await Promise.all(
    chunks.map(async ({ index, startTime, chunkPath }) => {
      let startAttempt = (chunkDuration >= 59) ? 1 : 0;
      for (let attempt = startAttempt; attempt < MAX_ENCODE_ATTEMPTS; attempt++) {
        await runGatedEncode(
          () => ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(chunkDuration)
            .outputOptions(getOutputOptions(chunkDuration, inputHeight, attempt, enc)),
          chunkPath,
          CHUNK_TIMEOUT_MS,
          `Chunk ${index + 1}`
        );

        const sizeMB = fs.statSync(chunkPath).size / (1024 * 1024);
        if (sizeMB <= RETRY_SIZE_MB) {
          console.log(`✓ Chunk ${index + 1}/${totalChunks} done! Size: ${sizeMB.toFixed(2)}MB`);
          return chunkPath;
        }
        console.log(`⚠️ Chunk ${index + 1} failed size check (${sizeMB.toFixed(2)}MB > 15.5MB). Retrying...`);
      }
      throw new Error(`Chunk ${index + 1} could not be compressed under 16MB.`);
    })
  );
  return chunkPaths;
}

async function compressVideo(inputPath, outputPath, knownDuration, inputHeight = 1920, enc = {}) {
  const duration = Number.isFinite(knownDuration) ? knownDuration : await getVideoDuration(inputPath);
  let startAttempt = (duration >= 59) ? 1 : 0;

  for (let attempt = startAttempt; attempt < MAX_ENCODE_ATTEMPTS; attempt++) {
    console.log(`🎬 compressVideo → Attempt ${attempt} | height:${inputHeight}`);
    // Gated through the EncodeSemaphore with the 600s full-video timeout. The
    // ffmpeg command is unchanged, so skip-path output stays byte-for-byte
    // identical to the no-editor flow (Req 1.2/1.4/1.5).
    await runGatedEncode(
      () => ffmpeg(inputPath).outputOptions(getOutputOptions(duration, inputHeight, attempt, enc)),
      outputPath,
      FULL_VIDEO_TIMEOUT_MS,
      `compressVideo attempt ${attempt}`
    );

    const postFFmpegSha = await sha256File(outputPath);
    console.log(`🔬 [HASH] Post-FFmpeg local file: ${postFFmpegSha}`);

    const sizeMB = fs.statSync(outputPath).size / (1024 * 1024);
    if (sizeMB <= RETRY_SIZE_MB) {
      console.log(`✓ Compression successful! Size: ${sizeMB.toFixed(2)}MB`);
      return;
    }
    console.log(`⚠️ Attempt ${attempt} failed size check (${sizeMB.toFixed(2)}MB > 15.5MB). Retrying...`);
  }
  throw new Error('Video could not be compressed under 16MB even at 540p resolution.');
}

async function uploadToR2(filePath, fileName) {
  try {
    const r2Start = Date.now();
    console.log(`Uploading to R2: ${fileName}`);
    const stats = await fs.promises.stat(filePath);
    const fileStream = fs.createReadStream(filePath);
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: fileStream,
      ContentLength: stats.size,
      ContentType: 'video/mp4',
    });
    const abortController = new AbortController();
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort();
        fileStream.destroy();
        reject(new Error('R2 upload timeout after 5 minutes'));
      }, 300000);
    });
    try {
      await Promise.race([
        r2Client.send(command, { abortSignal: abortController.signal }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
    const publicUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;
    console.log(`R2 Upload success! ✓ (${((Date.now() - r2Start) / 1000).toFixed(2)}s)`);
    return publicUrl;
  } catch (error) {
    console.error('R2 Upload Error:', error.message);
    throw error;
  }
}

async function deleteFromR2(fileName) {
  await r2Client.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: fileName,
  }));
}

// ========================
// R2 ORPHAN SWEEP (safety net for the "code never redeemed" + restart case)
// ========================
// While the server runs, each session's expiry timer + the 60s interval sweep
// delete a never-redeemed video from R2 within ~5 min. But those timers live in
// memory: if the process restarts before they fire, the session Map is lost and
// the already-uploaded R2 object would be orphaned forever. This sweep reclaims
// such orphans by listing only the EPHEMERAL prefixes and deleting objects that
// are (a) older than a wide safety margin and (b) not referenced by any live
// session. Permanent assets (library/, stickers/) are never listed, so they are
// never at risk.
const R2_ORPHAN_AGE_MS = 30 * 60 * 1000; // 30 min — far beyond the 5-min delivery window
const R2_EPHEMERAL_PREFIXES = ['compressed_', 'chunk_', 'uploads/', 'music/'];

async function listR2ObjectsByPrefix(prefix) {
  const objects = [];
  let ContinuationToken;
  do {
    const resp = await r2Client.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: prefix,
      ContinuationToken,
    }));
    for (const obj of (resp.Contents || [])) objects.push(obj);
    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return objects;
}

async function sweepOrphanR2Objects() {
  // Names still owned by a live session (pending delivery / retry window) must
  // never be deleted, regardless of age.
  const tracked = new Set();
  for (const session of sessions.values()) {
    for (const f of (session.files || [])) if (f && f.fileName) tracked.add(f.fileName);
    for (const k of (session.assetKeys || [])) if (k) tracked.add(k);
  }
  const now = Date.now();
  let removed = 0;
  for (const prefix of R2_EPHEMERAL_PREFIXES) {
    let objects;
    try {
      objects = await listR2ObjectsByPrefix(prefix);
    } catch (err) {
      console.error(`R2 orphan sweep: list "${prefix}" failed: ${err.message}`);
      continue;
    }
    for (const obj of objects) {
      const key = obj.Key;
      if (!key || tracked.has(key)) continue; // owned by a live session
      const age = now - new Date(obj.LastModified).getTime();
      if (!(age > R2_ORPHAN_AGE_MS)) continue; // too fresh — could be in-flight
      try {
        await deleteFromR2(key);
        removed++;
        console.log(`🧹 R2 orphan removed: ${key} (age ${Math.round(age / 60000)}m)`);
      } catch (err) {
        console.error(`R2 orphan delete "${key}" failed: ${err.message}`);
      }
    }
  }
  if (removed) console.log(`🧹 R2 orphan sweep: removed ${removed} stale object(s).`);
  return removed;
}

// ========================
// BAILEYS WHATSAPP TRANSPORT
// ========================
let sock = null;
let baileysConnected = false;
let reconnecting = false;
let reconnectAttempts = 0; // drives exponential backoff so a 403 loop doesn't hammer WhatsApp
// Where the Baileys session is stored. Configurable so it can point at a mounted
// persistent volume on any host (Railway volume, Azure Files, etc.). Default keeps
// the current relative folder so existing deployments are unaffected.
const BAILEYS_AUTH_DIR = process.env.BAILEYS_AUTH_DIR || 'baileys_auth';

// Device footprint = the client type WhatsApp shows for the linked device. We
// persist a randomly chosen footprint alongside the auth so it stays consistent
// across reconnects of the SAME session — but a RESET_BAILEYS re-link (which
// wipes the auth dir) regenerates a NEW random one. So each fresh link presents
// as a different device type, not a repeat of the previously flagged one.
// (Baileys already regenerates the Signal identity keys on re-link, so a re-link
// is cryptographically a new device regardless; this just varies the visible
// device type to match.)
const DEVICE_FOOTPRINT_POOL = [
  Browsers.macOS('Desktop'),
  Browsers.windows('Desktop'),
  Browsers.macOS('Chrome'),
  Browsers.windows('Chrome'),
  Browsers.ubuntu('Chrome'),
  Browsers.macOS('Safari'),
  Browsers.windows('Edge'),
];

function getOrCreateDeviceFootprint(dir) {
  const file = path.join(dir, 'device-footprint.json');
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved) && saved.length === 3) return saved;
    }
  } catch (e) { /* fall through and pick a fresh one */ }
  const choice = DEVICE_FOOTPRINT_POOL[Math.floor(Math.random() * DEVICE_FOOTPRINT_POOL.length)];
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(choice));
  } catch (e) { /* non-fatal — footprint just won't persist across restarts */ }
  return choice;
}

async function startBaileys() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(BAILEYS_AUTH_DIR);

    const rawSock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      // Random-but-persisted device footprint: consistent across reconnects of
      // this session, but a fresh RESET_BAILEYS re-link picks a new one so the
      // new device doesn't look like the previously flagged one.
      browser: getOrCreateDeviceFootprint(BAILEYS_AUTH_DIR),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      printQRInTerminal: false,  // 🆕 disable QR
    });

    // NOTE: baileys-antiban v4.10.0 `wrapSocket().sendMessage()` crashes on every
    // send ("Cannot read properties of undefined (reading 'circuitBreaker')"),
    // which took down all delivery. So we do NOT wrap the socket. Delivery uses
    // the raw socket directly; anti-ban behavior is handled natively below
    // (typing/recording presence, paced outbound sends, reconnect backoff).
    sock = rawSock;

    // Low-level protocol (events, auth, pairing) is bound to the RAW socket —
    // the antiban wrapper only needs to intercept outbound sends, and may not
    // proxy these internals. Outbound sends use the wrapped `sock`.
    rawSock.ev.on('creds.update', saveCreds);

    rawSock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      // QR intentionally not printed — we link via pairing code only (below).
      if (connection === 'close') {
        baileysConnected = false;
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log(`Baileys closed (code ${code}). Reconnect: ${shouldReconnect}`);
        reconnecting = false;
        if (shouldReconnect) {
          // Exponential backoff with jitter (3s → 6s → 12s … capped 60s) so a
          // repeated 403/close loop doesn't hammer WhatsApp, which itself looks
          // abusive and worsens flagging.
          reconnectAttempts += 1;
          // Fast recovery for transient drops; mild backoff only if it keeps
          // failing, capped low (15s) so the bot never stays offline long.
          const delay = Math.min(15000, 3000 * reconnectAttempts) + randBetween(0, 1500);
          console.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
          setTimeout(() => startBaileys().catch(e => console.error('Reconnect failed:', e)), delay);
        } else {
          console.error('!!! Baileys logged out — set RESET_BAILEYS=true and redeploy to re-link.');
        }
      } else if (connection === 'open') {
        baileysConnected = true;
        reconnecting = false;
        reconnectAttempts = 0; // healthy connection — reset backoff
        console.log('✓ Baileys connected to WhatsApp');
      }
    });

    // Pairing-code linking (no QR). Retries a few times since requestPairingCode
    // can fail if called before the socket is fully ready.
    if (!rawSock.authState.creds.registered) {
      const phoneNumber = (process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, '');
      if (!phoneNumber) {
        console.error('!!! Cannot request pairing code: WHATSAPP_BUSINESS_NUMBER is not set (use full international number, e.g. +9198XXXXXXXX).');
      } else {
        let attempts = 0;
        const requestPair = async () => {
          attempts++;
          try {
            const code = await rawSock.requestPairingCode(phoneNumber);
            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
            console.log('\n=========================================');
            console.log(`  PAIRING CODE: ${formatted}`);
            console.log(`  For number: +${phoneNumber}`);
            console.log('  In WhatsApp on that phone:');
            console.log('  Settings → Linked Devices → Link a Device');
            console.log('  → "Link with phone number instead" → enter this code');
            console.log('=========================================\n');
          } catch (err) {
            console.error(`Pairing code attempt ${attempts} failed:`, err.message);
            if (attempts < 4) setTimeout(requestPair, 5000);
            else console.error('!!! Could not obtain a pairing code after several tries. Verify WHATSAPP_BUSINESS_NUMBER and redeploy.');
          }
        };
        setTimeout(requestPair, 3000);
      }
    }

    rawSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        if (!from || from.endsWith('@g.us') || from === 'status@broadcast') continue;
        const text = msg.message.conversation
          || msg.message.extendedTextMessage?.text
          || msg.message.imageMessage?.caption
          || msg.message.videoMessage?.caption
          || '';
        try {
          await handleIncomingMessage(from, text.trim());
        } catch (err) {
          console.error('Message handler error:', err.message);
        }
      }
    });
  } catch (err) {
    reconnecting = false;
    console.error('Baileys startup error:', err);
    setTimeout(() => startBaileys().catch(e => console.error('Restart failed:', e)), 5000);
  }
}

// Reject a promise if it doesn't settle within `ms`, so a stalled network call
// (R2 download, Baileys send) can never hang the delivery flow forever. The
// underlying operation is abandoned (its result is ignored) once we time out.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label || 'operation'} timed out after ${Math.round(ms / 1000)}s`);
      e.isTimeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Per-send wall-clock limits for WhatsApp delivery (prevents a stuck send from
// stranding a session in `processing`).
const WA_MESSAGE_TIMEOUT_MS = 30000;   // text message send
const WA_DOWNLOAD_TIMEOUT_MS = 120000; // R2 -> buffer download
const WA_VIDEO_SEND_TIMEOUT_MS = 180000; // Baileys video upload+send

// Jitter + human-pacing helpers.
//
// randBetween  : uniform integer in [min,max] (used by the reconnect backoff).
// gaussianDelay: normally-distributed delay that CLUSTERS around `mean` (via the
//                Box–Muller transform), clamped to [min,max]. Real human timing
//                is bell-shaped, not flat — a fixed or uniform gap is easy for
//                WhatsApp to fingerprint as a bot, a Gaussian one is not.
// humanPause   : before a send, show typing/recording presence, hold for a
//                Gaussian pause (~6s), then clear it — mimicking a person
//                composing a reply. Best-effort: presence errors never block the
//                real send. Set HUMANIZE_SENDS=false to disable if you need raw speed.
function randBetween(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }

function gaussianDelay(mean, stddev, min, max) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.round(Math.min(max, Math.max(min, mean + z * stddev)));
}

const HUMANIZE_SENDS = process.env.HUMANIZE_SENDS !== 'false'; // on by default

async function humanPause(jid, kind = 'text') {
  if (!HUMANIZE_SENDS) return;
  const presence = kind === 'video' ? 'recording' : 'composing';
  try {
    await sock.sendPresenceUpdate('available', jid);
    await sock.sendPresenceUpdate(presence, jid);
  } catch (e) { /* presence is best-effort — never block the actual send */ }
  // Cluster around ~6s: most pauses land ~4–8s, hard-capped to 2.5–11s.
  await new Promise(r => setTimeout(r, gaussianDelay(6000, 1500, 2500, 11000)));
  try { await sock.sendPresenceUpdate('paused', jid); } catch (e) { /* ignore */ }
}

// ========================
// MESSAGE VARIATION (anti-fingerprint)
// Hundreds of chats using the *identical* inbound/outbound text is a strong
// "automated broadcast service" signal. Rotating the phrasing makes each
// conversation look a little different. The inbound code is still parsed by the
// 9-char token fallback regex regardless of the words around it.
// ========================
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Prefilled text for the wa.me link the user taps to message the bot. Each
// keeps the 9-char code as a standalone token so handleIncomingMessage still
// parses it.
const INBOUND_CODE_TEMPLATES = [
  c => `Hey! I just made a video on StatusDrop and I'd love the HD version — my code is ${c} 🙏`,
  c => `Hi there, could you send me my compressed video please? My code is ${c} 😊`,
  c => `Hello! Just finished editing on StatusDrop, my code is ${c} — please send it over.`,
  c => `Hi, I'd like to get my HD status video. My code is ${c}, thank you!`,
  c => `Hey, can you send my video in HD? My code is ${c} 🎬`,
  c => `Just made my status on StatusDrop — my code is ${c}, please send it my way!`,
  c => `Hi! Requesting my HD video, my code is ${c}. Appreciate it 🙏`,
];
function buildInboundText(code) { return pick(INBOUND_CODE_TEMPLATES)(code); }

// The posting instructions are important, so they stay constant; only the
// surrounding phrasing rotates.
const HD_STEPS =
  '📱 *How to post as HD Status:*\n' +
  '1. Tap & hold the video\n' +
  '2. Tap "Forward"\n' +
  '3. Select "My Status"\n' +
  '4. Post directly — done!\n\n' +
  '⚠️ *Important:* Do NOT edit or trim the video before posting — any editing re-compresses it and drops the quality. Just forward it as-is for full HD!';

function buildVerifiedMessage(count) {
  const multi = count > 1;
  const openers = [
    '✓ Code verified!',
    '✅ Got it — code confirmed!',
    'Perfect, your code checks out! ✓',
    'Verified! ✅',
  ];
  const closers = [
    'Please wait a moment! 🎬',
    'Sending them your way now… 🎬',
    'Hang tight, coming right up! 🎬',
    'One moment please! 🎬',
  ];
  return (
    pick(openers) + '\n\n' +
    `Sending ${count} video${multi ? 's' : ''} now...\n\n` +
    (multi ? `📱 Your video was split into ${count} parts for WhatsApp Status!\n\n` : '') +
    HD_STEPS + '\n\n' +
    pick(closers)
  );
}

const WELCOME_MESSAGES = [
  '👋 Welcome to StatusDrop! Visit our website to compress and receive your HD videos! 🌐 https://wastatusvideo.com',
  'Hey there! 👋 To get HD videos for your status, head to https://wastatusvideo.com and compress your clip first.',
  'Hi! 👋 StatusDrop makes HD WhatsApp statuses — start at https://wastatusvideo.com 🌐',
];

async function sendWhatsAppMessage(to, message) {
  if (!sock || !baileysConnected) throw new Error('Baileys not connected');
  const jid = toJid(to);
  await humanPause(jid, 'text');
  await withTimeout(sock.sendMessage(jid, { text: message }), WA_MESSAGE_TIMEOUT_MS, 'WhatsApp message send');
}

async function sendWhatsAppVideo(to, videoUrl, caption) {
  if (!sock || !baileysConnected) throw new Error('Baileys not connected');
  const jid = toJid(to);

  // Human pacing: show "recording" presence and hold a Gaussian pause before
  // sending (the R2 download below also runs during this window).
  await humanPause(jid, 'video');

  // Download from R2 into a buffer (bounded by a timeout so a stalled fetch
  // can't hang the whole delivery).
  const r2Response = await axios.get(videoUrl, {
    responseType: 'arraybuffer',
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: WA_DOWNLOAD_TIMEOUT_MS,
  });
  const videoBuffer = Buffer.from(r2Response.data);

  await withTimeout(
    sock.sendMessage(jid, {
      video: videoBuffer,
      caption: caption,
      mimetype: 'video/mp4',
    }),
    WA_VIDEO_SEND_TIMEOUT_MS,
    'WhatsApp video send'
  );
  console.log('Video sent via Baileys! ✓');
}

// ========================
// INCOMING MESSAGE HANDLER
// (your old webhook logic, transport-swapped)
// ========================
async function handleIncomingMessage(from, text) {
  console.log(`Message from ${jidToNumber(from)}: ${text}`);

  // Extract the 9-char code. Order matters:
  //  1) "code (is/:) XXXXXXXXX" — the natural-sentence prefill (case-insensitive).
  //  2) legacy "Activation Code: XXXXXXXXX" prefill (older links).
  //  3) bare UPPERCASE 9-char token — CASE-SENSITIVE on purpose: codes are always
  //     uppercase A-Z0-9, so this won't grab an ordinary lowercase word that
  //     happens to be 9 letters long (e.g. "reference") when the code is embedded
  //     in a sentence.
  const codeMatch =
       text?.match(/\bcode\b\s*(?:is)?\s*:?\s*([A-Z0-9]{9})\b/i)
    || text?.match(/Activation Code[:\s]+([A-Z0-9]{9})/i)
    || text?.match(/\b([A-Z0-9]{9})\b/);

  if (!codeMatch) {
    try {
      await sendWhatsAppMessage(from, pick(WELCOME_MESSAGES));
    } catch (err) {
      console.error('Failed welcome message:', err.message);
    }
    return;
  }

  const code = codeMatch[1].toUpperCase();

  if (recentlySentCodes.has(code)) {
    console.log(`Duplicate for sent code: ${code} — ignored!`);
    return;
  }

  const session = sessions.get(code);

  if (!session) {
    try {
      await sendWhatsAppMessage(from,
        '✗ Invalid or expired code!' +
        'Please compress your video again at our website.'
      );
    } catch (err) {
      console.error('Failed to send expired message:', err.message);
    }
    return;
  }

  if (session.status === 'sent') {
    console.log(`Duplicate webhook for code: ${code} — ignoring!`);
    return;
  }
  if (session.status === 'processing') {
    // Normally a duplicate webhook (WhatsApp re-delivers the same message a few
    // times); ignore it while a send is genuinely in progress. But if the
    // attempt has been "in progress" longer than any real send could take, treat
    // it as wedged and allow this webhook to re-attempt delivery (self-healing
    // so a stuck send can never permanently block the code).
    const since = session.processingSince || 0;
    if (Date.now() - since < PROCESSING_STALE_MS) {
      console.log(`Duplicate webhook for code: ${code} while processing - ignoring!`);
      return;
    }
    console.log(`Stale processing for code: ${code} (${Math.round((Date.now() - since) / 1000)}s) — re-attempting delivery`);
  }
  if (session.status === 'failed') {
    try {
      await sendWhatsAppMessage(from,
        'Failed to send your video.' +
        'Please compress your video again and try with a new code.'
      );
    } catch (err) {
      console.error('Failed retry message:', err.message);
    }
    return;
  }

  session.status = 'processing';
  session.processingSince = Date.now();
  sessions.set(code, session);

  try {
    await sendWhatsAppMessage(from, buildVerifiedMessage(session.files.length));
  } catch (err) {
    console.error('Failed code verified message:', err.message);
  }

  const waStartTime = Date.now();
  try {
    for (let i = 0; i < session.files.length; i++) {
      const file = session.files[i];
      const isMultiple = session.files.length > 1;
      const videoSendStart = Date.now();

      // Build caption: user caption on FIRST part only, nothing on subsequent parts
      let videoCaption = '';
      if (i === 0 && session.caption) {
        // First video/part — use user's caption
        videoCaption = session.caption;
      }
      // All other parts (i > 0) — no caption at all (empty string)

      await sendWhatsAppVideo(from, file.url, videoCaption);

      console.log(`✓ Video ${i + 1}/${session.files.length} sent (${((Date.now() - videoSendStart) / 1000).toFixed(2)}s)`);
      // Spacing between parts is handled by humanPause() before each send.
    }
    console.log(`✓ All sends completed (${((Date.now() - waStartTime) / 1000).toFixed(2)}s)`);
    session.status = 'sent';
  } catch (err) {
    // Delivery stalled/failed — but the video was ALREADY processed and is
    // sitting in R2. Do NOT discard it or brick the code: reset to a retryable
    // state and keep the R2 files so the user can simply resend the same code.
    // The session's existing expiry timer still bounds how long the files live.
    session.status = 'pending';
    session.processingSince = 0;
    sessions.set(code, session);
    console.error('Video send failed:', err.message);
    try {
      await sendWhatsAppMessage(from,
        'Hit a temporary hiccup sending your video. Please send your code again in a moment to retry. 🎬'
      );
    } catch (messageErr) {
      console.error('Failed send-failure message:', messageErr.message);
    }
    return; // keep files + existing expiry timer so the retry can deliver
  }

  // SUCCESS only — purge the delivered files and any uploaded music/sticker R2
  // assets (Req 14.2), then schedule session cleanup. (On failure we returned
  // above WITHOUT deleting, so a resend can still find the files.)
  for (const file of session.files) {
    try {
      await deleteFromR2(file.fileName);
      console.log(`R2 deleted after send: ${file.fileName}`);
    } catch (err) {
      console.error('R2 delete error:', err.message);
    }
  }
  if (Array.isArray(session.assetKeys)) {
    for (const assetKey of session.assetKeys) {
      try {
        await deleteFromR2(assetKey);
        console.log(`R2 asset deleted after send: ${assetKey}`);
      } catch (err) {
        console.error('R2 asset delete error:', err.message);
      }
    }
  }

  if (session.expiryTimer) {
    clearTimeout(session.expiryTimer);
    console.log(`Original timer cancelled for: ${code}`);
  }
  const newTimer = setTimeout(() => {
    sessions.delete(code);
    console.log(`Session cleaned after ${session.status}: ${code}`);
  }, 300000);
  session.files = [];
  session.assetKeys = [];
  session.createdAt = Date.now();
  session.expiryTimer = newTimer;
  sessions.set(code, session);

  recentlySentCodes.add(code);
  setTimeout(() => recentlySentCodes.delete(code), 600000);
}

// ========================
// EXPRESS ROUTES
// ========================
app.use((req, res, next) => {
  if (req.path === '/api/process') {
    req.setTimeout(900000);
    res.setTimeout(900000);
  }
  next();
});

app.get('/api/health', (req, res) => {
  res.json({
    status: '✓ Server Running!',
    baileys: baileysConnected ? 'connected' : 'disconnected',
  });
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.post('/api/upload-url', limiter, async (req, res) => {
  try {
    const { filename, contentType, fileSize } = req.body;
    const numericFileSize = Number(fileSize);
    if (!filename || !contentType || !Number.isFinite(numericFileSize)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (numericFileSize > 300 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large! Max 300MB.' });
    }
    const allowed = [
      'video/mp4', 'video/quicktime', 'video/x-msvideo',
      'video/x-matroska', 'video/3gpp', 'video/x-ms-wmv'
    ];
    if (!allowed.includes(contentType)) {
      return res.status(400).json({ error: 'Only video files allowed!' });
    }
    const ext = path.extname(filename).toLowerCase();
    const key = `uploads/${uuidv4()}${ext}`;
    res.json({
      uploadUrl: `https://upload.wastatusvideo.com/upload/${key}`,
      key,
    });
  } catch (error) {
    console.error('Upload URL error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/process', limiter, async (req, res) => {
  try {
    const { files } = req.body;

    // Input-limit gate: runs BEFORE any download/encode (Req 1.6, 13.5, 13.6).
    // Added-audio size per video comes from the recipe's Music_Track asset size
    // when present in the request body (forward-compatible with the recipes map).
    const recipes = req.body.recipes || null;
    const gate = enforceInputLimits(files, {
      getAudioBytes: recipes
        ? (file) => {
            const music = file && file.key && recipes[file.key]
              && recipes[file.key].audio && recipes[file.key].audio.music;
            return music ? Number(music.sizeBytes) : undefined;
          }
        : undefined,
    });
    if (!gate.ok) {
      return res.status(400).json({ error: gate.error, limit: gate.limit });
    }

    // Process only the retained set (first 3 videos in upload order).
    const acceptedFiles = gate.retained;
    const totalSizeMB = acceptedFiles.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
    console.log(`📥 Processing ${acceptedFiles.length} file(s) — Total: ${totalSizeMB.toFixed(1)}MB`);

    const activationCode = generateCode();
    const r2Files = [];
    const uploadedKeys = acceptedFiles.map(f => f.key);

    // Per-request artifact ledger. Every download, output, and chunk is
    // registered here so the cleanup wiring (task 10.6) can purge the request
    // from disk and R2 on success or any failure. We populate it now.
    const requestContext = new RequestContext(activationCode);
    // Track this request as in-progress so the Startup_Sweep retains its live
    // temp files; removed in `finally`.
    activeRequests.add(requestContext);

    // Output clips/chunks uploaded to R2 are DELIVERY artifacts: they must
    // survive the request `finally` so handleIncomingMessage can send them, then
    // delete them within 60s of delivery (Req 14.2). They are tracked here
    // (NOT in the cleanup ledger) on success; on ANY failure before delivery
    // hand-off they are added to the ledger so partial outputs are purged too
    // (Req 14.3).
    const outputR2Keys = new Set();
    // Uploaded Music_Track / Sticker R2 asset keys for the whole request. Stored
    // on the session so delivery-time cleanup re-attempts their removal (Req 14.2).
    const assetR2Keys = [];
    // Set true once outputs have been handed to the session for delivery.
    let deliveryHandedOff = false;
    // Set when a Render_Engine failure occurs so its source upload is retained
    // for the no-editor compression flow (Req 15.7).
    let renderFailureSourcePath = null;

    // Route each retained upload to its OWN recipe by upload key (Property 2 /
    // Req 1.3, 1.4). A file without a matching key is routed as skipped
    // (recipe === null → byte-identical legacy path, Req 1.2/1.5).
    const routed = routeRecipes(acceptedFiles, recipes);
    // Optional set of client-validated asset ids (music/sticker uploads that
    // passed the /api/music/validate boundary). Full asset wiring lands later.
    const validatedAssets = req.body.assets;

    try {
      // ---- Phase A: download, probe, route, validate, and PLAN each video. ----
      // No encode (Compression_Pass) is started in this phase, so a recipe that
      // fails validation rejects the whole request before any encode runs
      // (Req 2.7, 3.8).
      const prepared = await Promise.all(
        acceptedFiles.map(async (fileInfo, index) => {
          const { key, originalName, size } = fileInfo;
          const inputUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
          console.log(`📹 [${index + 1}/${acceptedFiles.length}] Processing: ${originalName} (${(size / 1024 / 1024).toFixed(1)}MB)`);
          const localInputPath = path.join('uploads', `input_${uuidv4()}${path.extname(originalName)}`);
          requestContext.addLocalPath(localInputPath);

          const response = await axios.get(inputUrl, { responseType: 'stream', timeout: 300000 });
          await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(localInputPath);
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
            response.data.on('error', reject);
          });
          await deleteFromR2(key);

          const duration = await getVideoDuration(localInputPath);
          const dimensions = await getVideoDimensions(localInputPath);

          // Look up this video's recipe (null => skipped / legacy path).
          const recipe = routed[index] ? routed[index].recipe : null;

          // Register every uploaded Music_Track / Sticker R2 asset referenced by
          // the recipe so the request `finally` purges them (Req 14.4), and carry
          // them onto the session for delivery-time re-attempt (Req 14.2).
          for (const assetKey of collectAssetR2Keys(recipe)) {
            requestContext.addR2Key(assetKey);
            assetR2Keys.push(assetKey);
          }

          if (recipe) {
            // Validate BEFORE any encode. On the first fault, reject with the
            // offending field + permitted bound and start NO Compression_Pass
            // (Req 2.7, 3.8). The downloaded source stays on local disk.
            const availableAssets = collectAvailableAssets(recipe, validatedAssets);
            const validation = validateRecipe(recipe, {
              sourceDuration: duration,
              availableAssets,
            });
            if (!validation.ok) {
              const err = new Error(
                `Recipe validation failed for "${originalName}": ${validation.error.reason}`
              );
              err.isRecipeValidationError = true;
              err.validationError = validation.error;
              err.fileName = originalName;
              throw err;
            }
          }

          // ---- Stage 1: resolve overlay/music asset files for the graph. ----
          // Built-in stickers (/stickers/...) and library audio (/library/...)
          // resolve to local public files; uploaded assets (carrying an R2 key)
          // are downloaded to temp and registered for request cleanup. The
          // resulting map is consumed by planRender via meta.assetPaths.
          let assetPaths;
          if (recipe) {
            const { localPaths, remotes } = planRecipeAssets(recipe, {
              publicDir: path.join(__dirname, 'public'),
              tmpDir: 'uploads',
              genId: uuidv4,
            });
            assetPaths = Object.assign({}, localPaths);
            for (const r of remotes) {
              requestContext.addLocalPath(r.tmpPath);
              const assetUrl = `${process.env.R2_PUBLIC_URL}/${r.key}`;
              const aResp = await axios.get(assetUrl, { responseType: 'stream', timeout: 300000 });
              await new Promise((resolve, reject) => {
                const w = fs.createWriteStream(r.tmpPath);
                aResp.data.pipe(w);
                w.on('finish', resolve);
                w.on('error', reject);
                aResp.data.on('error', reject);
              });
              assetPaths[r.ref] = r.tmpPath;
            }

            // ---- Stage 3: convert animated .tgs stickers to alpha .webp. ----
            // ffmpeg can't render Lottie, so each .tgs is rasterized to an
            // animated webp (reusing the Stage 1 webp overlay path). Built-in
            // stickers are cached on disk and rendered once; uploaded ones go to
            // a request temp file. A render failure leaves the .tgs unmapped so
            // only that sticker is dropped — the rest of the edit still renders.
            if (tgsRaster.available()) {
              const stickerList = Array.isArray(recipe.stickers) ? recipe.stickers : [];
              const dropped = [];
              for (const s of stickerList) {
                const ref = s && s.assetRef;
                if (typeof ref !== 'string' || !/\.tgs$/i.test(ref) || !assetPaths[ref]) continue;
                try {
                  const srcTgs = assetPaths[ref];
                  const isStatic = ref.indexOf('/stickers/') === 0 || ref.indexOf('/library/') === 0;
                  if (isStatic) {
                    const cached = path.join('tgs-cache', path.basename(ref).replace(/\.tgs$/i, '') + '.apng');
                    if (!fs.existsSync(cached)) await tgsRaster.renderTgsToApng(srcTgs, cached);
                    assetPaths[ref] = cached;
                  } else {
                    const apngOut = path.join('uploads', `asset_${uuidv4()}.apng`);
                    await tgsRaster.renderTgsToApng(srcTgs, apngOut);
                    requestContext.addLocalPath(apngOut);
                    assetPaths[ref] = apngOut;
                  }
                } catch (tgsErr) {
                  console.warn(`tgs render failed for ${ref}: ${tgsErr.message}`);
                  delete assetPaths[ref];
                  dropped.push(s); // drop just this sticker; keep the rest of the edit
                }
              }
              if (dropped.length) recipe.stickers = stickerList.filter((s) => dropped.indexOf(s) === -1);
            }

            // Drop any overlay/music asset we could NOT resolve to a local file
            // (e.g. an upload that didn't finish, leaving a client-local ref) so
            // a missing input never fails the whole encode — the rest of the
            // edits still render. Mirrors the dev-render harness behaviour.
            if (Array.isArray(recipe.stickers)) {
              recipe.stickers = recipe.stickers.filter((s) => s && assetPaths[s.assetRef]);
            }
            if (recipe.audio && recipe.audio.music && !assetPaths[recipe.audio.music.assetRef]) {
              console.warn(`Dropping unresolved music asset "${recipe.audio.music.assetRef}" for "${originalName}"`);
              recipe.audio.music = null;
            } else if (recipe.audio && recipe.audio.music) {
              console.log(`🎵 Music resolved for "${originalName}": ${recipe.audio.music.assetRef} -> ${assetPaths[recipe.audio.music.assetRef]}`);
            }
          }

          // Rasterize each Text_Overlay to a transparent PNG (Stage 2) and map
          // it by overlay id for the render graph. Files are registered for
          // request cleanup. Skipped when the recipe has no text overlays.
          let textRasterPaths;
          if (recipe && Array.isArray(recipe.textOverlays) && recipe.textOverlays.length) {
            textRasterPaths = {};
            for (const t of recipe.textOverlays) {
              const textPng = path.join('uploads', `text_${uuidv4()}.png`);
              await rasterizeTextOverlay(t, textPng);
              requestContext.addLocalPath(textPng);
              textRasterPaths[t.id] = textPng;
            }
          }

          // Build the single-encode RenderPlan. recipe === null yields the
          // byte-identical legacy plan (Property 1); a recipe folds its edits
          // into one Compression_Pass (Req 2.6, 12.3).
          const plan = planRender(recipe, {
            width: dimensions.width,
            height: dimensions.height,
            duration,
            hasSourceAudio: dimensions.hasAudio !== false,
            key,
            path: localInputPath,
            assetPaths,
            textRasterPaths,
          });
          // Loop animated .webp sticker inputs for the full clip (Stage 1),
          // bounded to the planned output duration so the encode terminates.
          markLoopingImageInputs(plan, Number.isFinite(plan.plannedDuration) ? plan.plannedDuration : duration);

          return { fileInfo, localInputPath, duration, dimensions, recipe, plan };
        })
      );

      // Optional "Longer clips — 60s per part" mode (non-edited path only):
      // split at ~59s and encode 720×1280 so each part still fits under 16MB.
      // Default (off) keeps the byte-identical 1080×1920 / ~29s behavior.
      const longClips = req.body.longClips === true || req.body.longClips === 'true';
      const skipClipLen = longClips ? LONG_CLIP_SECONDS : 29;
      const skipEnc = longClips ? LONG_CLIP_ENC : {};
      if (longClips) console.log('🎚️ Longer-clips mode ON: 720p, ~59s parts');

      // ---- Phase B: encode each prepared video through the EncodeSemaphore. ----
      // Skip/legacy plans (filterComplex === '') run the unchanged
      // compressVideo/splitVideo path so output stays byte-for-byte identical to
      // the no-editor flow. Recipe plans execute the -filter_complex graph from
      // the RenderPlan / per-chunk ChunkRenderPlan. Every ffmpeg invocation is
      // gated by the shared semaphore, so concurrent encodes across all files and
      // chunks never exceed the CPU-derived Concurrency_Limit (Req 13.1/13.2).
      const allGroupResults = await Promise.all(
        prepared.map(async ({ fileInfo, localInputPath, duration, dimensions, recipe, plan }) => {
          let retainSource = false;
          try {
            const isSkip = !plan.filterComplex; // legacy/skip plan
            const plannedDuration = Number.isFinite(plan.plannedDuration)
              ? plan.plannedDuration
              : duration;

            // ----- Skip / legacy path (byte-identical) -----
            if (isSkip) {
              // Longer-clips mode: ~59s parts at 720p (a <=59s video becomes a
              // single 720p part). Default: ~29s parts at full 1080p HD.
              const clipLen = longClips ? LONG_CLIP_SECONDS : 29;
              const enc = longClips ? LONG_CLIP_ENC : {};
              if (duration <= clipLen) {
                const outputFileName = `compressed_${uuidv4()}.mp4`;
                const outputPath = path.join('compressed', outputFileName);
                requestContext.addLocalPath(outputPath);
                await compressVideo(localInputPath, outputPath, duration, dimensions.height, enc);
                const url = await uploadToR2(outputPath, outputFileName);
                // Output is a delivery artifact — tracked separately so the
                // request `finally` does NOT purge it before delivery (Req 14.2).
                outputR2Keys.add(outputFileName);
                await fs.promises.unlink(outputPath).catch(() => { });
                return [{ fileName: outputFileName, url }];
              }
              const chunkPaths = await splitVideo(localInputPath, 'compressed', duration, clipLen, dimensions.height, enc);
              const chunkResults = [];
              for (let i = 0; i < chunkPaths.length; i++) {
                const chunkPath = chunkPaths[i];
                const chunkFileName = path.basename(chunkPath);
                requestContext.addLocalPath(chunkPath);
                const url = await uploadToR2(chunkPath, chunkFileName);
                outputR2Keys.add(chunkFileName);
                await fs.promises.unlink(chunkPath).catch(() => { });
                chunkResults.push({ fileName: chunkFileName, url });
              }
              return chunkResults;
            }

            // ----- Recipe path: execute the filter graph in one encode -----
            // A Render_Engine failure here is surfaced with the specific video
            // identified and its source retained for the no-editor flow (Req
            // 15.6/15.7). Cleanup of partial render artifacts still runs.
            try {
              if (plannedDuration <= CLIP_DURATION_LIMIT) {
                const outputFileName = `compressed_${uuidv4()}.mp4`;
                const outputPath = path.join('compressed', outputFileName);
                requestContext.addLocalPath(outputPath);
                await encodeRecipePlan(plan, outputPath, FULL_VIDEO_TIMEOUT_MS, `Edited video "${fileInfo.originalName}"`);
                const url = await uploadToR2(outputPath, outputFileName);
                outputR2Keys.add(outputFileName);
                await fs.promises.unlink(outputPath).catch(() => { });
                return [{ fileName: outputFileName, url }];
              }

              // Trimmed/edited duration exceeds the clip limit → split into chunks
              // and render overlays in every chunk via planChunk (Req 4.6, 11.x).
              const count = chunkCount(plannedDuration, CLIP_DURATION_LIMIT);
              const indexedResults = await Promise.all(
                Array.from({ length: count }, (_, i) => i).map(async (i) => {
                  const chunkPlan = planChunk(plan, i, CLIP_DURATION_LIMIT);
                  markLoopingImageInputs(chunkPlan, CLIP_DURATION_LIMIT);
                  const chunkFileName = `chunk_${uuidv4()}.mp4`;
                  const chunkPath = path.join('compressed', chunkFileName);
                  requestContext.addLocalPath(chunkPath);
                  await encodeRecipePlan(chunkPlan, chunkPath, CHUNK_TIMEOUT_MS, `Edited chunk ${i + 1} of "${fileInfo.originalName}"`);
                  const url = await uploadToR2(chunkPath, chunkFileName);
                  outputR2Keys.add(chunkFileName);
                  await fs.promises.unlink(chunkPath).catch(() => { });
                  return { index: i, fileName: chunkFileName, url };
                })
              );
              // Preserve chunk order regardless of completion order.
              indexedResults.sort((a, b) => a.index - b.index);
              return indexedResults.map(({ fileName, url }) => ({ fileName, url }));
            } catch (renderErr) {
              // Retain this source upload so the user can still post via the
              // no-editor compression flow (Req 15.7).
              retainSource = true;
              renderFailureSourcePath = localInputPath;
              const err = new Error(
                `Failed to apply edits to "${fileInfo.originalName}": ${renderErr.message}`
              );
              err.isRenderError = true;
              err.fileName = fileInfo.originalName;
              err.cause = renderErr.message;
              throw err;
            }
          } finally {
            // Remove the local source unless it must be retained for the
            // no-editor fallback after a Render_Engine failure (Req 15.7).
            if (!retainSource) {
              await fs.promises.unlink(localInputPath).catch(() => { });
            }
          }
        })
      );

      for (const group of allGroupResults) {
        for (const { fileName, url } of group) {
          r2Files.push({ fileName, url });
        }
      }
      console.log(`🎉 All ${r2Files.length} file(s) ready!`);

      const expiryTimer = setTimeout(async () => {
        const session = sessions.get(activationCode);
        if (session) {
          for (const file of session.files) {
            try { await deleteFromR2(file.fileName); } catch (err) { console.error('R2 cleanup:', err.message); }
          }
          sessions.delete(activationCode);
          console.log(`⏰ Session expired: ${activationCode}`);
        }
      }, 300000);

      // Get user caption (optional)
      const userCaption = req.body.caption?.trim() || '';

      sessions.set(activationCode, {
        files: r2Files,
        assetKeys: assetR2Keys,  // music/sticker R2 assets for delivery-time cleanup (Req 14.2)
        createdAt: Date.now(),
        status: 'pending',
        expiryTimer: expiryTimer,
        caption: userCaption,  // 🆕 store user's caption
      });
      // Outputs are now owned by the session for delivery; the request `finally`
      // must NOT purge the R2 output clips (Req 14.2).
      deliveryHandedOff = true;

      const cleanNumber = process.env.WHATSAPP_BUSINESS_NUMBER.replace('+', '');
      const waText = buildInboundText(activationCode);
      const waLink = `https://wa.me/${cleanNumber}?text=${encodeURIComponent(waText)}`;
      res.json({ success: true, activationCode, waLink, fileCount: r2Files.length });

    } catch (processingError) {
      // A recipe that failed validation rejects the request with HTTP 400,
      // naming the offending field and its permitted bound. No Compression_Pass
      // was started (validation runs in Phase A, before any encode) — Req 3.8.
      if (processingError && processingError.isRecipeValidationError) {
        console.warn(`✗ Recipe validation failed: ${processingError.message}`);
        for (const key of uploadedKeys) {
          try { await deleteFromR2(key); } catch (cleanupErr) { console.error(`Failed cleanup ${key}:`, cleanupErr.message); }
        }
        const ve = processingError.validationError || {};
        return res.status(400).json({
          error: processingError.message,
          field: ve.field,
          bound: ve.bound,
          fileName: processingError.fileName,
        });
      }
      // A Render_Engine failure identifies the specific video and the cause, and
      // leaves that video's source available for the no-editor compression flow
      // (Req 15.6/15.7). Partial render artifacts are purged by the `finally`
      // Cleanup_Process below.
      if (processingError && processingError.isRenderError) {
        console.error(`✗ Render failed: ${processingError.message}`);
        return res.status(422).json({
          error: processingError.message,
          fileName: processingError.fileName,
          cause: processingError.cause,
        });
      }
      console.error('✗ Processing error, cleaning up R2 uploads...');
      for (const key of uploadedKeys) {
        try { await deleteFromR2(key); } catch (cleanupErr) { console.error(`Failed cleanup ${key}:`, cleanupErr.message); }
      }
      throw processingError;
    } finally {
      // Cleanup_Process (Req 14.1/14.3/14.4): purge every registered local path
      // and non-output R2 asset (music/sticker), logging per-item failures and
      // continuing (Req 14.6), then verifying the request prefix is empty in R2.
      //   - On SUCCESS (deliveryHandedOff): the R2 output clips are owned by the
      //     session and are NOT purged here; delivery cleanup removes them later.
      //   - On ANY FAILURE before hand-off: partial output clips already uploaded
      //     to R2 are added to the ledger so nothing leaks (Req 14.3).
      //   - On a Render_Engine failure: the failed video's source is retained for
      //     the no-editor flow (Req 15.7).
      if (!deliveryHandedOff) {
        for (const key of outputR2Keys) {
          requestContext.addR2Key(key);
        }
      }
      if (renderFailureSourcePath) {
        requestContext.localPaths.delete(renderFailureSourcePath);
      }
      try {
        await cleanupRequest(requestContext, cleanupDeps);
      } catch (cleanupErr) {
        console.error(`Cleanup failed for ${activationCode}:`, cleanupErr.message);
      }
      activeRequests.delete(requestContext);
    }
  } catch (error) {
    console.error('✗ Process error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// ERROR HANDLER
// ========================
app.use((err, req, res, next) => {
  if (err?.message === 'Request aborted' || err?.code === 'ECONNABORTED' || err?.type === 'request.aborted') {
    console.warn('Client aborted - cleaning up');
    if (!res.headersSent) res.status(499).end();
    return;
  }
  console.error('Unhandled error:', err);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

// ========================
// START SERVER
// ========================
const server = app.listen(PORT, () => {
  console.log(`
================================
→ StatusDrop Server Running!
================================
Local: http://localhost:${PORT}
================================
  `);
  // One-time WhatsApp re-link: when RESET_BAILEYS=true, wipe the saved session
  // on boot so Baileys starts fresh and prints a new pairing code / QR for the
  // number in WHATSAPP_BUSINESS_NUMBER. Do this ONCE at process start (never on
  // reconnect, which would break an in-progress link). Set RESET_BAILEYS back to
  // false after linking, or every restart will unlink the bot.
  if (process.env.RESET_BAILEYS === 'true') {
    try {
      // Delete the CONTENTS of the auth dir, not the folder itself: on a mounted
      // volume, removing the mount point fails with EBUSY.
      const dir = BAILEYS_AUTH_DIR;
      let removed = 0;
      if (fs.existsSync(dir)) {
        for (const entry of fs.readdirSync(dir)) {
          fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
          removed++;
        }
      }
      console.log(`🔑 RESET_BAILEYS=true → cleared ${removed} saved session file(s). A new pairing code / QR will appear below. Set RESET_BAILEYS=false after linking.`);
    } catch (e) {
      console.error('Failed to clear baileys_auth:', e.message);
    }
  }

  // Start Baileys after Express is up so QR shows in logs
  startBaileys().catch(err => console.error('Baileys startup failed:', err));

  // Startup_Sweep: reclaim disk by deleting orphan temp files in uploads/,
  // compressed/, and assets/ that are not tied to an active in-progress request
  // (Req 14.5). At boot nothing is in-flight, so leftovers from a prior run are
  // removed; live work is retained via the activeRequests ledger set.
  startupSweep(activeRequests, makeSweepDeps({ fs, baseDir: process.cwd() }))
    .then((sweep) => {
      console.log(`🧹 Startup sweep: removed ${sweep.deleted.length} orphan file(s), retained ${sweep.retained.length}.`);
    })
    .catch((err) => console.error('Startup sweep failed:', err.message));

  // R2 orphan sweep: reclaim never-redeemed outputs/inputs/music left in R2 by a
  // prior run that restarted before its in-memory expiry timers fired. Runs once
  // at boot and every 15 minutes thereafter. Only ephemeral prefixes are listed
  // and only objects older than 30 min and not owned by a live session are
  // removed, so in-flight work and permanent assets are never affected.
  sweepOrphanR2Objects().catch((err) => console.error('R2 orphan sweep failed:', err.message));
  setInterval(() => {
    sweepOrphanR2Objects().catch((err) => console.error('R2 orphan sweep failed:', err.message));
  }, 15 * 60 * 1000);
});

server.requestTimeout = 0;
server.headersTimeout = 620000;
server.keepAliveTimeout = 610000;
