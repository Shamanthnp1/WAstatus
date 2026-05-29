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
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
// SESSION STORAGE
// ========================
const sessions = new Map();
const recentlySentCodes = new Set();

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
      resolve({ width: v?.width || 1080, height: v?.height || 1920 });
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

// ========================
// FFMPEG OPTIONS
// ========================
function getOutputOptions(duration, inputHeight = 1920) {
  console.log(`✓ getOutputOptions called!`);
  let vfFilter = 'scale=w=1080:h=1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,scale=trunc(iw/2)*2:trunc(ih/2)*2';
  return [
    '-vf', vfFilter,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'tv',
    '-color_primaries', 'bt470bg',
    '-color_trc', 'bt709',
    '-colorspace', 'bt470bg',
    '-crf', '23',
    '-maxrate', '3800k',
    '-bufsize', '5700k',
    '-g', '250',
    '-profile:v', 'high',
    '-level:v', '4.0',
    '-x264-params', 'sei=0',
    '-r', '29.97',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-b:a', '128k',
    '-brand', 'isom',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-threads', '2',
  ];
}

async function splitVideo(inputPath, outputDir, duration, chunkDuration = 29, inputHeight = 1920) {
  const totalChunks = Math.ceil(duration / chunkDuration);
  console.log(`Splitting into ${totalChunks} chunks of ${chunkDuration}s each`);

  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    const startTime = i * chunkDuration;
    const chunkFileName = `chunk_${uuidv4()}.mp4`;
    const chunkPath = path.join(outputDir, chunkFileName);
    chunks.push({ index: i, startTime, chunkPath });
  }

  let BATCH_SIZE;
  if (totalChunks <= 4) BATCH_SIZE = 2;
  else if (totalChunks <= 10) BATCH_SIZE = 3;
  else BATCH_SIZE = 4;
  console.log(`Total chunks: ${totalChunks} → BATCH_SIZE: ${BATCH_SIZE}`);

  const chunkPaths = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(chunks.length / BATCH_SIZE)}`);

    const batchResults = await Promise.all(
      batch.map(async ({ index, startTime, chunkPath }) => {
        let startAttempt = (chunkDuration >= 59) ? 1 : 0;
        for (let attempt = startAttempt; attempt < 3; attempt++) {
          await new Promise((res, rej) => {
            let settled = false;
            let chunkCommand = null;
            const finishChunk = (err) => {
              if (settled) return;
              settled = true;
              clearTimeout(chunkTimer);
              if (err) { rej(err); return; }
              res();
            };
            const chunkTimer = setTimeout(() => {
              if (chunkCommand) { try { chunkCommand.kill('SIGKILL'); } catch (e) { } }
              finishChunk(new Error(`Chunk ${index + 1} timeout after 5 minutes`));
            }, 300000);
            chunkCommand = ffmpeg(inputPath)
              .setStartTime(startTime)
              .setDuration(chunkDuration)
              .outputOptions(getOutputOptions(chunkDuration, inputHeight, attempt))
              .output(chunkPath)
              .on('end', () => finishChunk(null))
              .on('error', (err) => finishChunk(err));
            chunkCommand.run();
          });

          const sizeMB = fs.statSync(chunkPath).size / (1024 * 1024);
          if (sizeMB <= 15.5) {
            console.log(`✓ Chunk ${index + 1}/${totalChunks} done! Size: ${sizeMB.toFixed(2)}MB`);
            return chunkPath;
          }
          console.log(`⚠️ Chunk ${index + 1} failed size check (${sizeMB.toFixed(2)}MB > 15.5MB). Retrying...`);
        }
        throw new Error(`Chunk ${index + 1} could not be compressed under 16MB.`);
      })
    );
    chunkPaths.push(...batchResults);
  }
  return chunkPaths;
}

async function compressVideo(inputPath, outputPath, knownDuration, inputHeight = 1920) {
  const duration = Number.isFinite(knownDuration) ? knownDuration : await getVideoDuration(inputPath);
  let startAttempt = (duration >= 59) ? 1 : 0;

  for (let attempt = startAttempt; attempt < 3; attempt++) {
    console.log(`🎬 compressVideo → Attempt ${attempt} | height:${inputHeight}`);
    await new Promise((resolve, reject) => {
      let settled = false;
      let ffmpegCommand = null;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (err) return reject(err);
        resolve();
      };
      const timeoutId = setTimeout(() => {
        if (ffmpegCommand) { try { ffmpegCommand.kill('SIGKILL'); } catch (e) { } }
        finish(new Error(`compressVideo timeout after 10 minutes on attempt ${attempt}`));
      }, 600000);
      ffmpegCommand = ffmpeg(inputPath)
        .outputOptions(getOutputOptions(duration, inputHeight, attempt))
        .output(outputPath)
        .on('end', () => finish())
        .on('error', finish);
      ffmpegCommand.run();
    });

    const postFFmpegSha = await sha256File(outputPath);
    console.log(`🔬 [HASH] Post-FFmpeg local file: ${postFFmpegSha}`);

    const sizeMB = fs.statSync(outputPath).size / (1024 * 1024);
    if (sizeMB <= 15.5) {
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
// BAILEYS WHATSAPP TRANSPORT
// ========================
let sock = null;
let baileysConnected = false;
let reconnecting = false;

async function startBaileys() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.appropriate('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      printQRInTerminal: false,  // 🆕 disable QR
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log('=========================================');
        console.log('  SCAN THIS QR CODE WITH WHATSAPP BUSINESS');
        console.log('  (Settings → Linked Devices → Link a Device)');
        console.log('=========================================');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'close') {
        baileysConnected = false;
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log(`Baileys closed (code ${code}). Reconnect: ${shouldReconnect}`);
        reconnecting = false;
        if (shouldReconnect) {
          setTimeout(() => startBaileys().catch(e => console.error('Reconnect failed:', e)), 3000);
        } else {
          console.error('!!! Baileys logged out — delete /app/baileys_auth and re-scan QR');
        }
      } else if (connection === 'open') {
        baileysConnected = true;
        reconnecting = false;
        console.log('✓ Baileys connected to WhatsApp');
      }
    });

    // Pairing code (alternative to QR)
    if (!sock.authState.creds.registered) {
      // Wait briefly for the socket to be ready
      setTimeout(async () => {
        try {
          const phoneNumber = process.env.WHATSAPP_BUSINESS_NUMBER.replace(/\D/g, '');
          const code = await sock.requestPairingCode(phoneNumber);
          const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
          console.log('\n=========================================');
          console.log(`  PAIRING CODE: ${formatted}`);
          console.log('  In WhatsApp: Settings → Linked Devices');
          console.log('  → Link a Device → "Link with phone number instead"');
          console.log('  → Enter this code');
          console.log('=========================================\n');
        } catch (err) {
          console.error('Pairing code error:', err.message);
        }
      }, 3000);
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
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

async function sendWhatsAppMessage(to, message) {
  if (!sock || !baileysConnected) throw new Error('Baileys not connected');
  const jid = toJid(to);
  await sock.sendMessage(jid, { text: message });
}

async function sendWhatsAppVideo(to, videoUrl, caption) {
  if (!sock || !baileysConnected) throw new Error('Baileys not connected');
  const jid = toJid(to);

  // Download from R2 into a buffer
  const r2Response = await axios.get(videoUrl, {
    responseType: 'arraybuffer',
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  const videoBuffer = Buffer.from(r2Response.data);

  await sock.sendMessage(jid, {
    video: videoBuffer,
    caption: caption,
    mimetype: 'video/mp4',
  });
  console.log('Video sent via Baileys! ✓');
}

// ========================
// INCOMING MESSAGE HANDLER
// (your old webhook logic, transport-swapped)
// ========================
async function handleIncomingMessage(from, text) {
  console.log(`Message from ${jidToNumber(from)}: ${text}`);

  const codeMatch = text?.match(/Activation Code[:\s]+([A-Z0-9]{9})/i)
    || text?.match(/\b([A-Z0-9]{9})\b/i);

  if (!codeMatch) {
    try {
      await sendWhatsAppMessage(from,
        '👋 Welcome to StatusDrop!' +
        'Please visit our website to compress and receive your HD videos!' +
        '🌐 https://wastatusvideo.com'
      );
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
    console.log(`Duplicate webhook for code: ${code} while processing - ignoring!`);
    return;
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
  sessions.set(code, session);

  try {
    const isMultiple = session.files.length > 1;
    await sendWhatsAppMessage(from,
      '✓ Code verified!\n\n' +
      `Sending ${session.files.length} video${isMultiple ? 's' : ''} now...\n\n` +
      (isMultiple ? `📱 Your video was split into ${session.files.length} parts for WhatsApp Status!\n\n` : '') +
      '📱 *How to post as HD Status:*\n' +
      '1. Tap & hold the video\n' +
      '2. Tap "Forward"\n' +
      '3. Select "My Status"\n' +
      '4. Post directly — done!\n\n' +
      '⚠️ *Important:* Do NOT edit or trim the video in WhatsApp before posting. Any editing will re-compress it and reduce quality. Just forward it as-is for full HD!\n\n' +
      'Please wait a moment! 🎬'
    );
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
      if (i < session.files.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    console.log(`✓ All sends completed (${((Date.now() - waStartTime) / 1000).toFixed(2)}s)`);
    session.status = 'sent';
  } catch (err) {
    session.status = 'failed';
    sessions.set(code, session);
    console.error('Video send failed:', err.message);
    try {
      await sendWhatsAppMessage(from,
        'Failed to send your video.' +
        'Please compress your video again and try with a new code.'
      );
    } catch (messageErr) {
      console.error('Failed send-failure message:', messageErr.message);
    }
  } finally {
    for (const file of session.files) {
      try {
        await deleteFromR2(file.fileName);
        console.log(`R2 deleted after send: ${file.fileName}`);
      } catch (err) {
        console.error('R2 delete error:', err.message);
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
  session.createdAt = Date.now();
  session.expiryTimer = newTimer;
  sessions.set(code, session);

  if (session.status === 'sent') {
    recentlySentCodes.add(code);
    setTimeout(() => recentlySentCodes.delete(code), 600000);
  }
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
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files provided!' });
    }
    if (files.length > 3) {
      return res.status(400).json({ error: 'Max 3 files allowed!' });
    }
    const totalSizeMB = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
    console.log(`📥 Processing ${files.length} file(s) — Total: ${totalSizeMB.toFixed(1)}MB`);
    if (totalSizeMB > 300) {
      return res.status(400).json({ error: `Total size ${totalSizeMB.toFixed(0)}MB exceeds 300MB!` });
    }

    const activationCode = generateCode();
    const r2Files = [];
    const uploadedKeys = files.map(f => f.key);

    try {
      const allGroupResults = await Promise.all(
        files.map(async (fileInfo, index) => {
          const { key, originalName, size } = fileInfo;
          const inputUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
          console.log(`📹 [${index + 1}/${files.length}] Processing: ${originalName} (${(size / 1024 / 1024).toFixed(1)}MB)`);
          const localInputPath = path.join('uploads', `input_${uuidv4()}${path.extname(originalName)}`);

          try {
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

            if (duration <= 29) {
              const outputFileName = `compressed_${uuidv4()}.mp4`;
              const outputPath = path.join('compressed', outputFileName);
              await compressVideo(localInputPath, outputPath, duration, dimensions.height);
              const url = await uploadToR2(outputPath, outputFileName);
              await fs.promises.unlink(outputPath).catch(() => { });
              return [{ fileName: outputFileName, url }];
            } else {
              const chunkPaths = await splitVideo(localInputPath, 'compressed', duration, 29, dimensions.height);
              const chunkResults = [];
              for (let i = 0; i < chunkPaths.length; i++) {
                const chunkPath = chunkPaths[i];
                const chunkFileName = path.basename(chunkPath);
                const url = await uploadToR2(chunkPath, chunkFileName);
                await fs.promises.unlink(chunkPath).catch(() => { });
                chunkResults.push({ fileName: chunkFileName, url });
              }
              return chunkResults;
            }
          } finally {
            await fs.promises.unlink(localInputPath).catch(() => { });
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
        createdAt: Date.now(),
        status: 'pending',
        expiryTimer: expiryTimer,
        caption: userCaption,  // 🆕 store user's caption
      });

      const cleanNumber = process.env.WHATSAPP_BUSINESS_NUMBER.replace('+', '');
      const waLink = `https://wa.me/${cleanNumber}?text=Activation%20Code%3A%20${activationCode}`;
      res.json({ success: true, activationCode, waLink, fileCount: r2Files.length });

    } catch (processingError) {
      console.error('✗ Processing error, cleaning up R2 uploads...');
      for (const key of uploadedKeys) {
        try { await deleteFromR2(key); } catch (cleanupErr) { console.error(`Failed cleanup ${key}:`, cleanupErr.message); }
      }
      throw processingError;
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
  // Start Baileys after Express is up so QR shows in logs
  startBaileys().catch(err => console.error('Baileys startup failed:', err));
});

server.requestTimeout = 0;
server.headersTimeout = 620000;
server.keepAliveTimeout = 610000;
