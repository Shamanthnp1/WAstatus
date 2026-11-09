// StatusDrop self-host bot.
//
// Runs inside the Android app's ":selfhost" foreground-service process on
// nodejs-mobile (Node 18). It links ONE WhatsApp number the user owns as a
// companion device (Baileys) and sends the clips the app compressed, straight
// from the phone. The Flutter app controls it over a local, token-protected
// TCP socket (newline-delimited JSON). See .kiro/specs/self-host-mode/design.md.
//
// main.js has already installed the Node 18 / Android polyfills and validated
// SD_DATA_DIR, SD_TMP_DIR and SD_CLIPS_DIR.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pino from 'pino';
import * as Baileys from '@whiskeysockets/baileys';

const makeWASocket = Baileys.makeWASocket || Baileys.default;
const {
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  buildPairingQRData,
  jidNormalizedUser,
} = Baileys;

// ---------------------------------------------------------------------------
// Paths and limits
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.SD_DATA_DIR;
const CLIPS_DIR = process.env.SD_CLIPS_DIR;
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const BRIDGE_FILE = path.join(DATA_DIR, 'bridge.json');
const PAIRING_FILE = path.join(DATA_DIR, 'pairing.json');
const VERSION_FILE = path.join(DATA_DIR, 'wa-version.json');
const LAST_DELIVERY_FILE = path.join(DATA_DIR, 'last-delivery.json');
const LOG_FILE = path.join(DATA_DIR, 'bot.log');

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_CLIPS = 20;
const MAX_CLIP_BYTES = 100 * 1024 * 1024;
const MAX_THUMB_CHARS = 64 * 1024;
const CODE_PATTERN = /^[A-Z0-9]{9}$/;
const PAIRING_WINDOW_MS = 10 * 60 * 1000;
const PAIRING_MAX_IN_WINDOW = 2;
const PAIRING_MIN_GAP_MS = 30 * 1000;
const PAIRING_BLOCK_AFTER_429_MS = 60 * 60 * 1000;
const PAIRING_CODE_LIFETIME_MS = 150 * 1000;
const MAX_ARM_MS = 30 * 60 * 1000;
const SEND_TIMEOUT_MS = 180 * 1000;
const OPEN_TIMEOUT_MS = 45 * 1000;
const IDLE_EXIT_MS = 2 * 60 * 1000;
const WA_IDLE_CLOSE_MS = 90 * 1000;
const BROWSER = Browsers.windows('Chrome');

fs.mkdirSync(AUTH_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Logging: concise, size-capped, phone numbers masked (requirement 6.4)
// ---------------------------------------------------------------------------
const LOG_CAP_BYTES = 512 * 1024;
function mask(text) {
  return String(text).replace(/\d{8,}/g, (digits) => `${digits.slice(0, 2)}…${digits.slice(-3)}`);
}
function writeLogLine(line) {
  const safe = mask(line.endsWith('\n') ? line : `${line}\n`);
  try {
    const size = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    if (size > LOG_CAP_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    fs.appendFileSync(LOG_FILE, safe);
  } catch (_) {
    // Logging must never break the bot.
  }
  try {
    process.stdout.write(safe);
  } catch (_) {
    // stdout goes to logcat through the native shim.
  }
}
function log(message) {
  writeLogLine(`${new Date().toISOString()} [bot] ${message}`);
}
const baileysLogger = pino(
  { level: 'warn', timestamp: pino.stdTimeFunctions.isoTime, base: undefined },
  { write: (chunk) => writeLogLine(String(chunk)) },
);

process.on('uncaughtException', (error) => log(`uncaught: ${error && error.stack ? error.stack : error}`));
process.on('unhandledRejection', (error) => log(`unhandled rejection: ${error && error.stack ? error.stack : error}`));

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
class BotError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new BotError('TIMEOUT', `${label} timed out.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function digitsOf(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}
function statusCodeOf(lastDisconnect) {
  const error = lastDisconnect && lastDisconnect.error;
  return error && error.output ? error.output.statusCode : undefined;
}

// ---------------------------------------------------------------------------
// Session state on disk
// ---------------------------------------------------------------------------
function credsOnDisk() {
  return readJson(path.join(AUTH_DIR, 'creds.json'), null);
}
// Baileys only sets `registered` for pairing-code links; QR links set
// `platform` on pair-success. Either, plus `me`, means a finished link.
function isFinishedLink(creds) {
  return !!(creds && creds.me && (creds.registered || creds.platform));
}
function isLinked() {
  return isFinishedLink(sock ? sock.authState.creds : credsOnDisk());
}
function linkedNumber() {
  const creds = sock ? sock.authState.creds : credsOnDisk();
  return isFinishedLink(creds) ? digitsOf(creds.me.id) : null;
}
function clearAuth() {
  try {
    for (const entry of fs.readdirSync(AUTH_DIR)) {
      fs.rmSync(path.join(AUTH_DIR, entry), { recursive: true, force: true });
    }
  } catch (error) {
    log(`could not clear the session folder: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Pairing-code rate limits (requirement 2.4), persisted across restarts
// ---------------------------------------------------------------------------
function pairingState() {
  const state = readJson(PAIRING_FILE, {});
  const now = Date.now();
  return {
    attempts: (Array.isArray(state.attempts) ? state.attempts : []).filter((t) => now - t < PAIRING_WINDOW_MS),
    blockedUntil: Number(state.blockedUntil) || 0,
  };
}
function pairingRetryAt() {
  const now = Date.now();
  const state = pairingState();
  let retryAt = 0;
  if (state.blockedUntil > now) retryAt = state.blockedUntil;
  const last = state.attempts.length ? Math.max(...state.attempts) : 0;
  if (last && now - last < PAIRING_MIN_GAP_MS) retryAt = Math.max(retryAt, last + PAIRING_MIN_GAP_MS);
  if (state.attempts.length >= PAIRING_MAX_IN_WINDOW) {
    retryAt = Math.max(retryAt, Math.min(...state.attempts) + PAIRING_WINDOW_MS);
  }
  return retryAt > now ? retryAt : 0;
}
function recordPairingAttempt() {
  const state = pairingState();
  state.attempts.push(Date.now());
  writeJsonAtomic(PAIRING_FILE, state);
}
function blockPairing(ms) {
  const state = pairingState();
  state.blockedUntil = Date.now() + ms;
  writeJsonAtomic(PAIRING_FILE, state);
}

// ---------------------------------------------------------------------------
// WhatsApp Web version (cached 12 h; WhatsApp 405s clients that look stale)
// ---------------------------------------------------------------------------
async function waVersion() {
  const cached = readJson(VERSION_FILE, null);
  if (cached && Array.isArray(cached.version) && Date.now() - cached.at < 12 * 60 * 60 * 1000) {
    return cached.version;
  }
  try {
    const { version } = await withTimeout(fetchLatestWaWebVersion(), 10000, 'WhatsApp version check');
    writeJsonAtomic(VERSION_FILE, { version, at: Date.now() });
    return version;
  } catch (error) {
    log(`WhatsApp version check failed (${error.message}); using ${cached ? 'the cached' : "Baileys' bundled"} version`);
    return cached && Array.isArray(cached.version) ? cached.version : undefined;
  }
}

// ---------------------------------------------------------------------------
// Bridge to the Flutter app
// ---------------------------------------------------------------------------
const bridgeToken = crypto.randomBytes(32).toString('hex');
let client = null;
let lastActivity = Date.now();
let shuttingDown = false;

function markActivity() {
  lastActivity = Date.now();
}
function send(socket, payload) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(`${JSON.stringify(payload)}\n`);
  } catch (_) {
    // The client went away; it reconnects when it needs us.
  }
}
function emit(event, data = {}) {
  if (client) send(client, { event, ...data });
}
function emitState() {
  emit('state', { status: statusSnapshot() });
}
function tokenMatches(candidate) {
  if (typeof candidate !== 'string' || candidate.length !== bridgeToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(bridgeToken));
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  let authed = false;
  const authTimer = setTimeout(() => socket.destroy(), 5000);

  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      socket.destroy();
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        socket.destroy();
        return;
      }
      if (!authed) {
        if (message && message.cmd === 'hello' && tokenMatches(message.token)) {
          authed = true;
          clearTimeout(authTimer);
          if (client && client !== socket) client.destroy();
          client = socket;
          markActivity();
          send(socket, { id: message.id, ok: true, result: statusSnapshot() });
        } else {
          socket.destroy();
          return;
        }
        continue;
      }
      handleCommand(socket, message);
    }
  });
  socket.on('close', () => {
    clearTimeout(authTimer);
    if (client === socket) client = null;
    markActivity();
  });
  socket.on('error', () => {});
});

async function handleCommand(socket, message) {
  const id = message && message.id;
  const handler = message && COMMANDS[message.cmd];
  markActivity();
  if (!handler) {
    send(socket, { id, ok: false, code: 'UNKNOWN_COMMAND', error: 'Unknown command.' });
    return;
  }
  try {
    const result = await handler(message);
    send(socket, { id, ok: true, result: result === undefined ? null : result });
  } catch (error) {
    const code = error instanceof BotError ? error.code : 'FAILED';
    if (!(error instanceof BotError)) log(`${message.cmd} failed: ${error && error.stack ? error.stack : error}`);
    send(socket, { id, ok: false, code, error: error && error.message ? error.message : String(error) });
  } finally {
    markActivity();
  }
}

// ---------------------------------------------------------------------------
// WhatsApp connection
// ---------------------------------------------------------------------------
let sock = null;
let connState = 'closed'; // closed | connecting | open
let link = null; // { method, number, codeRequested, code, expiresAt, ref, rateLimited }
let armed = null; // { code, clips, armedAt, expiresAt, inProgress, timer }
// How the last armed delivery ended, so the app can catch up after it was in
// the background (or restarted) while the bot delivered. Kept on disk for a
// day because the bot may stop before the user returns to the app.
let lastDelivery = (() => {
  const saved = readJson(LAST_DELIVERY_FILE, null);
  return saved && typeof saved.code === 'string' && Date.now() - Number(saved.at) < 24 * 60 * 60 * 1000 ? saved : null;
})(); // { code, outcome: 'delivered'|'expired', total, at }
function rememberDelivery(code, outcome, total) {
  lastDelivery = { code, outcome, total, at: Date.now() };
  try {
    writeJsonAtomic(LAST_DELIVERY_FILE, lastDelivery);
  } catch (_) {
    // In-memory copy is enough while the bot runs.
  }
}
let sending = false;
let loggingOut = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let openWaiters = [];

function needsConnection() {
  return !shuttingDown && (sending || !!armed || openWaiters.length > 0 || loggingOut);
}
function settleWaiters(error) {
  const waiters = openWaiters;
  openWaiters = [];
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve();
  }
}
function waitForOpen(timeoutMs) {
  if (connState === 'open' && sock) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      openWaiters = openWaiters.filter((w) => w !== waiter);
      reject(new BotError('OFFLINE', 'Could not reach WhatsApp. Check the internet connection and try again.'));
    }, timeoutMs);
    openWaiters.push(waiter);
  });
}
function endSocket() {
  const current = sock;
  if (!current) return;
  try {
    current.end(undefined);
  } catch (_) {
    // already closed
  }
}

async function startSocket() {
  if (sock || shuttingDown) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  connState = 'connecting';
  emitState();

  let { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  // An expired pairing code leaves half-made creds (`me` set, never
  // registered). Logging in with them gets a 401 and kills the next code.
  if (!isFinishedLink(state.creds) && state.creds.me) {
    clearAuth();
    ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
  }
  const version = await waVersion();
  if (shuttingDown) return;

  const current = makeWASocket({
    auth: state,
    version,
    browser: BROWSER,
    logger: baileysLogger,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });
  sock = current;
  const creds = current.authState.creds;

  current.ev.on('creds.update', saveCreds);
  current.ev.on('connection.update', (update) => {
    if (sock !== current) return;
    onConnectionUpdate(current, update).catch((error) => log(`connection handler: ${error.stack || error}`));
  });
  current.ev.on('messages.upsert', (upsert) => {
    if (sock !== current) return;
    onMessages(upsert).catch((error) => log(`message handler: ${error.stack || error}`));
  });

  // WhatsApp answers a refused pairing-code request with an iq error that
  // Baileys does not surface (e.g. 429 rate-overlimit).
  current.ws.on('CB:iq,type:error', (node) => {
    const child = Array.isArray(node && node.content) ? node.content.find((c) => c && c.tag === 'error') : null;
    const code = child && child.attrs ? String(child.attrs.code || '') : '';
    if (!link || link.method !== 'code' || !link.codeRequested || isFinishedLink(creds)) return;
    log(`WhatsApp refused the pairing-code request (${code} ${child && child.attrs ? child.attrs.text || '' : ''})`);
    const rateLimited = code === '429';
    if (rateLimited) blockPairing(PAIRING_BLOCK_AFTER_429_MS);
    endLink(rateLimited ? 'rateLimited' : 'refused');
  });

  // QR linking: WhatsApp can retire the advertised secret
  // (companion_reg_refresh). Rotate it and redraw, or scans fail with
  // "Couldn't link device" (WhiskeySockets/Baileys#2737). Never during a
  // pairing-code attempt: there `me` is set and the secret is part of it.
  current.ws.on('CB:notification,type:companion_reg_refresh', () => {
    if (creds.me || !link || link.method !== 'qr') return;
    const adv = crypto.randomBytes(32).toString('base64');
    Object.assign(creds, { advSecretKey: adv });
    current.ev.emit('creds.update', { advSecretKey: adv });
    emitQr(current);
  });
}

function emitQr(current) {
  if (!link || link.method !== 'qr' || !link.ref) return;
  const creds = current.authState.creds;
  const data = buildPairingQRData(
    link.ref,
    Buffer.from(creds.noiseKey.public).toString('base64'),
    Buffer.from(creds.signedIdentityKey.public).toString('base64'),
    creds.advSecretKey,
    BROWSER,
  );
  emit('qr', { data });
}

function endLink(reason) {
  if (!link) return;
  link = null;
  log(`link attempt ended: ${reason}`);
  emit('linkEnded', { reason });
  endSocket();
  if (!isLinked()) clearAuth();
  emitState();
}

async function onConnectionUpdate(current, update) {
  const creds = current.authState.creds;
  const { connection, lastDisconnect, qr } = update;

  if (qr && link && !isFinishedLink(creds)) {
    const fragment = qr.includes('#') ? qr.split('#')[1] : qr;
    link.ref = fragment.split(',')[0];
    if (link.method === 'qr') emitQr(current);
    if (link.method === 'code' && !link.codeRequested) {
      link.codeRequested = true;
      const attempt = link;
      setTimeout(async () => {
        if (link !== attempt || sock !== current) return;
        try {
          recordPairingAttempt();
          const raw = await current.requestPairingCode(attempt.number);
          if (link !== attempt) return;
          attempt.code = (raw.match(/.{1,4}/g) || [raw]).join('-');
          attempt.expiresAt = Date.now() + PAIRING_CODE_LIFETIME_MS;
          emit('pairingCode', { code: attempt.code, expiresAt: new Date(attempt.expiresAt).toISOString() });
          emitState();
        } catch (error) {
          log(`pairing code request failed: ${error.message}`);
          endLink('error');
        }
      }, 1500);
    }
  }

  if (connection === 'open') {
    connState = 'open';
    reconnectAttempts = 0;
    if (!creds.registered) {
      // QR links never set `registered`; mark it so every check agrees.
      Object.assign(creds, { registered: true });
      current.ev.emit('creds.update', { registered: true });
    }
    if (link) {
      link = null;
      const me = linkedNumber();
      log('linked');
      emit('linked', { me });
    }
    settleWaiters();
    emitState();
    return;
  }

  if (connection === 'close') {
    const code = statusCodeOf(lastDisconnect);
    const finished = isFinishedLink(creds);
    sock = null;
    connState = 'closed';
    log(`WhatsApp connection closed (code ${code})`);

    if (shuttingDown) return;

    if (finished && (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden)) {
      const reason = loggingOut ? 'user' : code === DisconnectReason.forbidden ? 'forbidden' : 'whatsapp';
      clearAuth();
      if (armed) disarm('loggedOut');
      settleWaiters(new BotError('NOT_LINKED', 'This number is no longer linked. Link it again.'));
      emit('loggedOut', { reason });
      emitState();
      return;
    }
    if (code === DisconnectReason.restartRequired) {
      // Normal right after WhatsApp accepts a new link.
      await startSocket();
      return;
    }
    if (link && !finished) {
      endLink(code === DisconnectReason.timedOut ? 'expired' : 'closed');
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      settleWaiters(new BotError('REPLACED', 'Another copy of this session connected. Close other StatusDrop copies.'));
      emitState();
      return;
    }
    if (finished && needsConnection()) {
      reconnectAttempts += 1;
      const delay = Math.min(30000, 3000 * reconnectAttempts);
      reconnectTimer = setTimeout(() => startSocket().catch((e) => log(`reconnect failed: ${e.message}`)), delay);
    } else {
      settleWaiters(new BotError('OFFLINE', 'The WhatsApp connection closed. Try again.'));
    }
    emitState();
  }
}

async function ensureConnected(timeoutMs = OPEN_TIMEOUT_MS) {
  if (!isLinked()) throw new BotError('NOT_LINKED', 'Link a WhatsApp number first.');
  if (connState === 'open' && sock) return;
  const opened = waitForOpen(timeoutMs);
  if (!sock) await startSocket();
  await opened;
}

// Close an idle WhatsApp connection while keeping Node up for the app.
setInterval(() => {
  if (connState === 'open' && !needsConnection() && !link && Date.now() - lastActivity > WA_IDLE_CLOSE_MS) {
    log('closing the idle WhatsApp connection');
    endSocket();
  }
}, 15000).unref();

// ---------------------------------------------------------------------------
// Sending clips
// ---------------------------------------------------------------------------
function validateClips(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CLIPS) {
    throw new BotError('INVALID_CLIPS', `Send between 1 and ${MAX_CLIPS} clips.`);
  }
  const root = fs.realpathSync(CLIPS_DIR) + path.sep;
  return raw.map((clip, index) => {
    if (!clip || typeof clip.path !== 'string') throw new BotError('INVALID_CLIPS', `Clip ${index + 1} has no file.`);
    let real;
    try {
      real = fs.realpathSync(clip.path);
    } catch (_) {
      throw new BotError('CLIP_MISSING', `Clip ${index + 1} is no longer on this phone. Compress again.`);
    }
    if (!real.startsWith(root)) throw new BotError('PATH_NOT_ALLOWED', `Clip ${index + 1} is outside StatusDrop's clip folder.`);
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CLIP_BYTES) {
      throw new BotError('INVALID_CLIPS', `Clip ${index + 1} has an invalid size.`);
    }
    const width = Number(clip.width);
    const height = Number(clip.height);
    const seconds = Math.round(Number(clip.seconds));
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) {
      throw new BotError('INVALID_CLIPS', `Clip ${index + 1} has invalid dimensions.`);
    }
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) {
      throw new BotError('INVALID_CLIPS', `Clip ${index + 1} has an invalid duration.`);
    }
    const thumb = typeof clip.thumb === 'string' && clip.thumb.length <= MAX_THUMB_CHARS &&
      /^[A-Za-z0-9+/=]+$/.test(clip.thumb) ? clip.thumb : undefined;
    return { path: real, width, height, seconds, thumb };
  });
}

async function sendOneClip(jid, clip) {
  const message = {
    video: { url: clip.path },
    mimetype: 'video/mp4',
    width: clip.width,
    height: clip.height,
    seconds: clip.seconds,
  };
  // Baileys cannot probe videos here (no ffmpeg binary), so the app passes
  // the same metadata the StatusDrop server sends.
  if (clip.thumb) message.jpegThumbnail = clip.thumb;
  await withTimeout(sock.sendMessage(jid, message), SEND_TIMEOUT_MS, 'Sending a clip');
}

async function sendClips(jid, clips, { paced }) {
  for (let index = 0; index < clips.length; index += 1) {
    if (paced) {
      try {
        await sock.sendPresenceUpdate('available', jid);
        await sock.sendPresenceUpdate('recording', jid);
      } catch (_) {
        // Presence is best-effort.
      }
      await sleep(randBetween(2500, 4500));
      try {
        await sock.sendPresenceUpdate('paused', jid);
      } catch (_) {
        // Presence is best-effort.
      }
    }
    try {
      await sendOneClip(jid, clips[index]);
    } catch (error) {
      // One retry after a reconnect covers a dropped connection mid-send.
      log(`clip ${index + 1} failed (${error.message}); retrying once`);
      await ensureConnected();
      await sendOneClip(jid, clips[index]);
    }
    emit('sendProgress', { sent: index + 1, total: clips.length });
    if (!paced && index < clips.length - 1) await sleep(800);
  }
}

// ---------------------------------------------------------------------------
// Method 2: wait for the activation code from the user's main WhatsApp
// ---------------------------------------------------------------------------
function disarm(reason) {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed = null;
  log(`delivery disarmed: ${reason}`);
}

function messageText(message) {
  const m = message.message || {};
  return m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.videoMessage && m.videoMessage.caption) ||
    '';
}

function timestampMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value * 1000;
  if (typeof value.toNumber === 'function') return value.toNumber() * 1000;
  return Number(value) * 1000 || 0;
}

async function onMessages({ messages, type }) {
  if (!armed || type !== 'notify') return;
  for (const message of messages || []) {
    if (!armed || armed.inProgress) return;
    const key = message.key || {};
    const jid = key.remoteJid || '';
    if (!message.message || key.fromMe) continue;
    if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
    if (timestampMs(message.messageTimestamp) < armed.armedAt - 60000) continue;
    const tokens = messageText(message).match(/\b[A-Z0-9]{9}\b/g) || [];
    if (!tokens.includes(armed.code)) continue;
    await deliverArmed(jid);
  }
}

// The same "post in full HD" steps the StatusDrop number sends (HD_STEPS in
// server.js), so a bot reply looks like the regular one and matches the
// in-app guide. Forwarding the received copy straight to Status makes
// WhatsApp re-compress it; saving it and sending it again keeps full HD.
const HD_STEPS =
  '📱 *How to post in full HD:*\n' +
  '1. Tap the video, then tap ⬇ *Download* to save it\n' +
  '2. Send it into any chat — easiest is *Message yourself* — via 📎 → *Gallery*\n' +
  '   (add your caption right there in "Add a caption…" if you want one)\n' +
  '3. On that *new* copy, tap the ↪ *Forward* icon → *My Status*\n' +
  '4. Post — done!\n\n' +
  '⚠️ *Important:* Steps 1–2 are what keep it in full HD — forwarding the original directly makes WhatsApp re-compress it. And do NOT edit or trim the video.';

function botReplyText(count) {
  return '✅ Code verified!\n\n' +
    `Sending ${count} video${count > 1 ? 's' : ''} now...\n\n` +
    HD_STEPS + '\n\nPlease wait a moment! 🎬';
}

async function deliverArmed(jid) {
  const delivery = armed;
  delivery.inProgress = true;
  sending = true;
  log(`activation code received; sending ${delivery.clips.length} clip(s)`);
  emit('deliveryStarted', { total: delivery.clips.length });
  emitState();
  try {
    try {
      await withTimeout(sock.sendMessage(jid, { text: botReplyText(delivery.clips.length) }), 30000,
        'Sending the instructions');
    } catch (error) {
      // The clips matter more than the text; send them anyway.
      log(`instructions message failed (${error.message}); sending clips anyway`);
    }
    await sendClips(jid, delivery.clips, { paced: true });
    if (armed === delivery) disarm('delivered');
    rememberDelivery(delivery.code, 'delivered', delivery.clips.length);
    emit('delivered', { total: delivery.clips.length, code: delivery.code });
  } catch (error) {
    delivery.inProgress = false;
    log(`delivery failed: ${error.message}`);
    emit('deliveryFailed', { error: error.message });
  } finally {
    sending = false;
    markActivity();
    emitState();
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function statusSnapshot() {
  return {
    linked: isLinked(),
    me: linkedNumber(),
    connection: connState,
    linking: link ? {
      method: link.method,
      code: link.code || null,
      expiresAt: link.expiresAt ? new Date(link.expiresAt).toISOString() : null,
    } : null,
    armed: armed ? {
      code: armed.code,
      total: armed.clips.length,
      expiresAt: new Date(armed.expiresAt).toISOString(),
      inProgress: armed.inProgress,
    } : null,
    sending,
    lastDelivery: lastDelivery ? {
      code: lastDelivery.code,
      outcome: lastDelivery.outcome,
      total: lastDelivery.total,
      at: new Date(lastDelivery.at).toISOString(),
    } : null,
    pairingRetryAt: pairingRetryAt() ? new Date(pairingRetryAt()).toISOString() : null,
  };
}

async function beginLink(method, number) {
  if (isLinked()) throw new BotError('ALREADY_LINKED', 'A number is already linked. Disconnect it first.');
  if (link) endLink('restarted');
  endSocket();
  await sleep(300);
  sock = null;
  connState = 'closed';
  clearAuth();
  link = { method, number, codeRequested: false, code: null, expiresAt: 0, ref: null };
  await startSocket();
  return statusSnapshot();
}

const COMMANDS = {
  status: async () => statusSnapshot(),

  verify: async () => {
    if (isLinked()) await ensureConnected();
    return statusSnapshot();
  },

  linkCode: async ({ number }) => {
    const digits = String(number || '').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      throw new BotError('INVALID_NUMBER', 'Enter the full number with country code, for example +91 98765 43210.');
    }
    const retryAt = pairingRetryAt();
    if (retryAt) {
      throw new BotError('RATE_LIMITED', `Wait until ${new Date(retryAt).toISOString()} before asking for another code.`);
    }
    return beginLink('code', digits);
  },

  linkQr: async () => beginLink('qr', null),

  cancelLink: async () => {
    endLink('cancelled');
    return statusSnapshot();
  },

  logout: async () => {
    if (!isLinked()) {
      clearAuth();
      return { removedFromPhone: false };
    }
    disarm('logout');
    loggingOut = true;
    let removedFromPhone = false;
    try {
      await ensureConnected(30000);
      await sock.logout('StatusDrop disconnect');
      removedFromPhone = true;
    } catch (error) {
      log(`logout could not reach WhatsApp: ${error.message}`);
    } finally {
      loggingOut = false;
    }
    endSocket();
    clearAuth();
    emitState();
    return { removedFromPhone };
  },

  sendTest: async () => {
    await ensureConnected();
    await withTimeout(
      sock.sendMessage(jidNormalizedUser(sock.user.id), { text: 'StatusDrop self-host test: this phone can send from your WhatsApp.' }),
      30000,
      'Sending the test message',
    );
    return { sent: true };
  },

  sendToSelf: async ({ clips }) => {
    const valid = validateClips(clips);
    if (sending || (armed && armed.inProgress)) throw new BotError('BUSY', 'A delivery is already being sent.');
    sending = true;
    emitState();
    try {
      await ensureConnected();
      const jid = jidNormalizedUser(sock.user.id);
      await sendClips(jid, valid, { paced: false });
      log(`sent ${valid.length} clip(s) to the linked number's own chat`);
      return { sent: valid.length, to: digitsOf(jid) };
    } finally {
      sending = false;
      emitState();
    }
  },

  armDelivery: async ({ code, clips, expiresAt }) => {
    if (typeof code !== 'string' || !CODE_PATTERN.test(code)) throw new BotError('INVALID_CODE', 'The activation code is invalid.');
    const valid = validateClips(clips);
    if (armed && armed.inProgress) throw new BotError('BUSY', 'A delivery is already being sent.');
    disarm('replaced');
    await ensureConnected();
    const now = Date.now();
    const requested = Date.parse(expiresAt);
    const until = Math.min(Number.isFinite(requested) ? requested : now + 15 * 60 * 1000, now + MAX_ARM_MS);
    if (until <= now) throw new BotError('INVALID_CODE', 'The activation code has already expired.');
    const delivery = { code, clips: valid, armedAt: now, expiresAt: until, inProgress: false, timer: null };
    delivery.timer = setTimeout(() => {
      if (armed !== delivery || delivery.inProgress) return;
      disarm('expired');
      rememberDelivery(delivery.code, 'expired', delivery.clips.length);
      emit('deliveryExpired', { code: delivery.code });
      emitState();
    }, until - now);
    armed = delivery;
    log(`armed a delivery of ${valid.length} clip(s)`);
    emitState();
    return { botNumber: linkedNumber(), expiresAt: new Date(until).toISOString() };
  },

  cancelDelivery: async () => {
    if (armed && armed.inProgress) return { cancelled: false };
    disarm('cancelled');
    emitState();
    return { cancelled: true };
  },

  shutdown: async () => {
    setTimeout(() => shutdown('requested'), 50);
    return { stopping: true };
  },
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`stopping (${reason})`);
  emit('shutdown', { reason });
  disarm('shutdown');
  if (link) link = null;
  endSocket();
  settleWaiters(new BotError('STOPPING', 'StatusDrop self-host is stopping.'));
  server.close();
  try {
    fs.rmSync(BRIDGE_FILE, { force: true });
  } catch (_) {
    // best effort
  }
  if (client) client.end();
  // Give Baileys a moment to flush the session files.
  setTimeout(() => process.exit(0), 1000);
}

// Stop when there is nothing to do. A connected app that has gone quiet (for
// example frozen in the background) only keeps the bot up for 5 minutes.
const CLIENT_QUIET_EXIT_MS = 5 * 60 * 1000;
setInterval(() => {
  const busy = !!link || !!armed || sending || loggingOut;
  const quietFor = Date.now() - lastActivity;
  if (!busy && quietFor > (client ? CLIENT_QUIET_EXIT_MS : IDLE_EXIT_MS)) shutdown('idle');
}, 15000).unref();

process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  writeJsonAtomic(BRIDGE_FILE, { port, token: bridgeToken, pid: process.pid });
  log(`ready on Node ${process.version} (linked: ${isLinked()})`);
});
