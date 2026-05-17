const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const compression = require('compression');
require('dotenv').config();

// ========================
// APP SETUP
// ========================
const app = express();
app.use(compression());
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// Set FFmpeg path

ffmpeg.setFfmpegPath(ffmpegStatic);

// Set ffprobe path
const ffprobePath = require('ffprobe-static').path;
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

// ========================
// CREATE REQUIRED FOLDERS
// ========================
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads', { recursive: true });
}
if (!fs.existsSync('compressed')) {
  fs.mkdirSync('compressed', { recursive: true });
}

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
const recentlySentCodes = new Set(); // ✅ Track recently sent codes for duplicate handling

// Auto cleanup every 1 minute
setInterval(async () => {
  const now = Date.now();
  for (const [code, session] of sessions.entries()) {
    if (now - session.createdAt > 300000) { // 5 minutes = 300000ms

      // Delete from R2
      for (const file of session.files) {
        try {
          await deleteFromR2(file.fileName);
          console.log(`R2 cleanup: ${file.fileName} deleted`);
        } catch (err) {
          console.error('R2 cleanup error:', err.message);
        }
      }

      // Delete session from memory
      sessions.delete(code);
      console.log(`Session expired & R2 cleaned: ${code}`);
    }
  }
}, 60000); // Check every 1 minute

// ========================
// RATE LIMITING
// ========================
const limiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 10,                         // ✅ 10 uploads per day
  message: {
    error: 'Daily limit reached! Try again tomorrow.'
  },
  standardHeaders: true,  // ✅ Sends limit info in headers
  legacyHeaders: false,   // ✅ Cleaner response
  skip: (req) => {
    // ✅ Skip rate limit for health checks
    return req.path === '/api/health';
  }
});

// ========================
// FILE UPLOAD SETUP
// ========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    cb(null, uuidv4() + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /mp4|mov|avi|mkv|3gp|wmv/;
  const extname = allowedTypes.test(
    path.extname(file.originalname).toLowerCase()
  );
  if (extname) {
    cb(null, true);
  } else {
    cb(new Error('Only video files allowed!'));
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 300 * 1024 * 1024,  // 300MB per file
    files: 3                        // ✅ Max 3 files
  },
  fileFilter: fileFilter
});

// ========================
// HELPER FUNCTIONS
// ========================

// Generate activation code
function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 9; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Get video duration in seconds
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata.format.duration;
      console.log(`Video duration: ${duration} seconds`);
      resolve(duration);
    });
  });
}

// Split video into chunks of maxDuration seconds
function splitVideo(inputPath, outputDir, chunkDuration = 29) {
  return new Promise(async (resolve, reject) => {
    try {
      const duration = await getVideoDuration(inputPath);
      const totalChunks = Math.ceil(duration / chunkDuration);
      console.log(`Splitting into ${totalChunks} chunks of ${chunkDuration}s each`);

      const targetSizeMB = 15; // 1MB buffer from WhatsApp's 16MB limit
      const audioBitrateK = 192;
      const totalBitrateK = (targetSizeMB * 8 * 1024) / chunkDuration;
      const videoBitrateK = Math.floor(totalBitrateK - audioBitrateK);

      console.log(`Target size per chunk: ${targetSizeMB}MB`);
      console.log(`Video bitrate: ${videoBitrateK}kbps`);
      console.log(`Audio bitrate: ${audioBitrateK}kbps`);

      // Build chunk list first
      const chunks = [];
      for (let i = 0; i < totalChunks; i++) {
        const startTime = i * chunkDuration;
        const chunkFileName = `chunk_${uuidv4()}.mp4`;
        const chunkPath = path.join(outputDir, chunkFileName);
        chunks.push({ index: i, startTime, chunkPath });
      }

      // ✅ Always parallel — Railway 8GB RAM handles this easily
      console.log(
        `Encoding ${totalChunks} chunks in parallel...`
      );

      const chunkPaths = await Promise.all(
        chunks.map(({ index, startTime, chunkPath }) =>
          new Promise((res, rej) => {
            ffmpeg(inputPath)
              .setStartTime(startTime)
              .setDuration(chunkDuration)
              .outputOptions([
                '-c:v libx264',
                `-b:v ${videoBitrateK}k`,
                `-maxrate ${videoBitrateK}k`,
                `-bufsize ${videoBitrateK * 2}k`,
                '-preset ultrafast',
                '-profile:v high',
                '-level 4.1',
                '-c:a aac',
                `-b:a ${audioBitrateK}k`,
                '-ar 44100',
                '-movflags faststart',
                '-pix_fmt yuv420p',
                '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
              ])
              .output(chunkPath)
              .on('start', () =>
                console.log(
                  `Chunk ${index + 1}/${totalChunks} started...`
                )
              )
              .on('end', () => {
                const stats = fs.statSync(chunkPath);
                const sizeMB = stats.size / (1024 * 1024);
                console.log(
                  `Chunk ${index + 1}/${totalChunks} done! ` +
                  `Size: ${sizeMB.toFixed(2)}MB`
                );
                res(chunkPath);
              })
              .on('error', (err) => {
                console.error(`Chunk ${index + 1} error:`, err);
                rej(err);
              })
              .run();
          })
        )
      );

      resolve(chunkPaths);
    } catch (err) {
      reject(err);
    }
  });
}

// Compress single video (for short videos under 29s)
function compressVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {

    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);

      const duration = metadata.format.duration;

      const targetSizeMB = 15;
      const audioBitrateK = 128;

      const totalBitrateK =
        (targetSizeMB * 8 * 1024) / duration;

      const videoBitrateK =
        Math.floor(totalBitrateK - audioBitrateK);

      ffmpeg(inputPath)
        .outputOptions([
          '-c:v libx264',
          `-b:v ${videoBitrateK}k`,
          `-maxrate ${videoBitrateK}k`,
          `-bufsize ${videoBitrateK * 2}k`,
          '-preset veryfast',
          '-profile:v high',
          '-level 4.1',
          '-pix_fmt yuv420p',
          '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',

          '-c:a aac',
          `-b:a ${audioBitrateK}k`,
          '-ar 44100',

          '-movflags faststart'
        ])

        .output(outputPath)

        .on('start', () => {
          console.log('Compression started...');
        })

        .on('end', () => {
          console.log('Compression complete!');
          resolve();
        })

        .on('error', reject)

        .run();
    });
  });
}

// Upload to Cloudflare R2
async function uploadToR2(filePath, fileName) {
  try {
    const r2Start = Date.now();
    console.log(`Uploading to R2: ${fileName}`);
    const fileContent = fs.readFileSync(filePath);
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: fileContent,
      ContentType: 'video/mp4',
    });
    await r2Client.send(command);
    const publicUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;
    const r2Duration = ((Date.now() - r2Start) / 1000).toFixed(2);
    console.log(`R2 Upload success! ✅ (${r2Duration}s) ${publicUrl}`);
    return publicUrl;
  } catch (error) {
    console.error('R2 Upload Error:', error.message);
    throw error;
  }
}

// Delete from R2
async function deleteFromR2(fileName) {
  const command = new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: fileName,
  });
  await r2Client.send(command);
}

// Send WhatsApp message
async function sendWhatsAppMessage(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error('SendMessage failed!');
    console.error('To:', to);
    console.error('Error:', JSON.stringify(err.response?.data));
    throw err;
  }
}

// Upload video to WhatsApp Media
async function uploadToWhatsAppMedia(videoUrl) {
  // Download from R2 first
  const response = await axios.get(videoUrl, { 
    responseType: 'arraybuffer' 
  });
  const buffer = Buffer.from(response.data);

  // Upload to WhatsApp
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', buffer, {
    filename: 'video.mp4',
    contentType: 'video/mp4'
  });
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'video/mp4');

  const uploadResponse = await axios.post(
    `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_ID}/media`,
    form,
    {
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        ...form.getHeaders()
      }
    }
  );

  return uploadResponse.data.id; // media ID
}

// Send WhatsApp video using media ID
async function sendWhatsAppVideo(to, videoUrl, caption) {
  console.log('Uploading video to WhatsApp Media...');
  const mediaId = await uploadToWhatsAppMedia(videoUrl);
  console.log('Media ID:', mediaId);

  await axios.post(
    `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: to,
      type: 'video',
      video: {
        id: mediaId,
        caption: caption
      }
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
  console.log('Video sent via media ID! ✅');
}

// ========================
// ROUTES
// ========================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: '✅ Server Running!' });
});

// Privacy Policy
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname,
    'public', 'privacy.html'));
});

// Upload & Compress Videos
app.post('/api/compress', limiter, upload.array('videos', 3), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded!' });
    }

    // ✅ Total size check across ALL files
    const totalSizeMB = req.files.reduce(
      (sum, f) => sum + f.size, 0
    ) / (1024 * 1024);

    console.log(
      `Total upload: ${totalSizeMB.toFixed(1)}MB ` +
      `across ${req.files.length} file(s)`
    );

    if (totalSizeMB > 300) {
      for (const file of req.files) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      }
      return res.status(400).json({
        error:
          `Total size ${totalSizeMB.toFixed(0)}MB exceeds 300MB! ` +
          `Please upload fewer or smaller videos.`
      });
    }

    const activationCode = generateCode();
    const r2Files = [];

    // STEP 1 + 2: ALL videos in parallel — 8GB RAM allows this!
    console.log(`Processing ${req.files.length} file(s) in parallel...`);

    const allGroupResults = await Promise.all(
      req.files.map(async (file) => {
        try {
          console.log(
            `Processing: ${file.originalname} ` +
            `(${(file.size / 1024 / 1024).toFixed(1)}MB)`
          );

          const duration = await getVideoDuration(file.path);

          if (duration <= 29) {
            // SHORT VIDEO
            console.log('Short video — compressing...');
            const outputFileName = `compressed_${uuidv4()}.mp4`;
            const outputPath = path.join('compressed', outputFileName);

            await compressVideo(file.path, outputPath);

            const url = await uploadToR2(outputPath, outputFileName);

            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath);
            }

            console.log(`R2 upload done: ${outputFileName} ✅`);
            return [{ fileName: outputFileName, url }];

          } else {
            // LONG VIDEO — split into chunks
            console.log(
              `Long video (${duration.toFixed(1)}s) — splitting...`
            );
            const chunkPaths = await splitVideo(
              file.path, 'compressed', 29
            );

            console.log(
              `Uploading ${chunkPaths.length} chunks to R2 in parallel...`
            );

            const chunkResults = await Promise.all(
              chunkPaths.map(async (chunkPath) => {
                const chunkFileName = path.basename(chunkPath);
                const url = await uploadToR2(chunkPath, chunkFileName);

                if (fs.existsSync(chunkPath)) {
                  fs.unlinkSync(chunkPath);
                }

                console.log(`R2 chunk upload done: ${chunkFileName} ✅`);
                return { fileName: chunkFileName, url };
              })
            );

            return chunkResults;
          }

        } finally {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        }
      })
    );

    // Flatten keeping order
    for (const group of allGroupResults) {
      for (const { fileName, url } of group) {
        r2Files.push({ fileName, url });
      }
    }

    console.log(`All ${r2Files.length} file(s) uploaded to R2! ✅`);

    // ✅ Store timer ID in session!
    const expiryTimer = setTimeout(async () => {
      const session = sessions.get(activationCode);
      if (session) {
        for (const file of session.files) {
          try {
            await deleteFromR2(file.fileName);
            console.log(`R2 deleted (expired): ${file.fileName}`);
          } catch (err) {
            console.error('R2 delete error:', err.message);
          }
        }
        sessions.delete(activationCode);
        console.log(`Session expired: ${activationCode}`);
      }
    }, 300000);

    sessions.set(activationCode, {
      files: r2Files,
      createdAt: Date.now(),
      status: 'pending',
      expiryTimer: expiryTimer  // ✅ Store timer ID!
    });

    // WhatsApp link
    const cleanNumber = process.env.WHATSAPP_BUSINESS_NUMBER.replace('+', '');
    const waLink = `https://wa.me/${cleanNumber}?text=Activation%20Code%3A%20${activationCode}`;

    res.json({
      success: true,
      activationCode: activationCode,
      waLink: waLink,
      fileCount: r2Files.length
    });

  } catch (error) {
    console.error('Compress error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// WEBHOOK ROUTES
// ========================

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verified! ✅');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook receive messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') {
      return res.sendStatus(404);
    }

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) {
      return res.sendStatus(200);
    }

    const message = messages[0];
    const from = message.from;
    const text = message.text?.body?.trim();

    console.log(`Message from ${from}: ${text}`);

    // Extract activation code
    const codeMatch = text?.match(
      /Activation Code[:\s]+([A-Z0-9]{9})/i
    ) || text?.match(
      /\b([A-Z0-9]{9})\b/i
    );

    if (!codeMatch) {
      try {
        await sendWhatsAppMessage(
          from,
          '👋 Welcome to StatusDrop!\n\n' +
          'Please visit our website to compress and receive your HD videos!\n\n' +
          '🌐 https://wastatusvideo.com'
        );
      } catch (err) {
        console.error('Failed welcome message:', err.message);
      }

      return res.sendStatus(200);
    }

    const code = codeMatch[1].toUpperCase();

    // ✅ Check for post-deletion duplicates BEFORE sessions.get()
    if (recentlySentCodes.has(code)) {
      console.log(`Duplicate for sent code: ${code} — ignored!`);
      return res.sendStatus(200); // ✅ Silent ignore
    }

    const session = sessions.get(code);

    if (!session) {
      try {
        await sendWhatsAppMessage(
          from,
          '❌ Invalid or expired code!\n\n' +
          'Please compress your video again at our website.'
        );
      } catch (err) {
        console.error('Failed to send expired message:', err.message);
      }

      return res.sendStatus(200);
    }

    if (session.status === 'sent') {
      // ✅ Don't send any message!
      // Videos already delivered — just silently ignore
      console.log(`Duplicate webhook for code: ${code} — ignoring!`);
      return res.sendStatus(200);
    }

    // Mark as processing
    session.status = 'sent';
    sessions.set(code, session);

    // Send confirmation
    try {
      await sendWhatsAppMessage(
        from,
        '✅ Code verified!\n\n' +
        `Sending ${session.files.length} video${session.files.length > 1 ? 's' : ''} now...\n\n` +
        (session.files.length > 1 ? `📱 Your video was split into ${session.files.length} parts for WhatsApp Status!\n\n` : '') +
        'Please wait a moment! 🎬'
      );
    } catch (err) {
      console.error('Failed code verified message:', err.message);
    }

    // ✅ FIX — wrap send loop in try/finally
    const waStartTime = Date.now();
    try {
      for (let i = 0; i < session.files.length; i++) {
        const file = session.files[i];
        const isMultiple = session.files.length > 1;
        const videoSendStart = Date.now();

        await sendWhatsAppVideo(
          from,
          file.url,
          `🎬 ${isMultiple ? `Status Part ${i + 1}/${session.files.length}` : 'HD Status Video'}\n\n` +
          `✅ How to post as Status:\n` +
          `1. Tap & hold this video\n` +
          `2. Tap "Forward"\n` +
          `3. Select "My Status"\n` +
          `4. Done! 🎉\n\n` +
          `Powered by StatusDrop 💚`
        );
        
        const videoSendDuration = ((Date.now() - videoSendStart) / 1000).toFixed(2);
        console.log(`✅ WhatsApp video ${i + 1}/${session.files.length} sent (${videoSendDuration}s)`);

        if (i < session.files.length - 1) {
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      const totalWaDuration = ((Date.now() - waStartTime) / 1000).toFixed(2);
      console.log(`✅ All WhatsApp sends completed (${totalWaDuration}s total)`);
    } finally {
      // ✅ ALWAYS clean R2, even if send fails
      for (const file of session.files) {
        try {
          await deleteFromR2(file.fileName);
          console.log(`R2 deleted after send: ${file.fileName}`);
        } catch (err) {
          console.error('R2 delete error:', err.message);
        }
      }
    }

    // ✅ Cancel original expiry timer!
    if (session.expiryTimer) {
      clearTimeout(session.expiryTimer);
      console.log(`Original timer cancelled for: ${code}`);
    }

    // ✅ Start NEW 5 min timer from send time
    const newTimer = setTimeout(() => {
      sessions.delete(code);
      console.log(`Session cleaned after send: ${code}`);
    }, 300000);

    session.status = 'sent';
    session.files = [];           // R2 already deleted
    session.createdAt = Date.now(); // Reset for setInterval
    session.expiryTimer = newTimer; // ✅ Store new timer
    sessions.set(code, session);

    // ✅ Track sent code to silently ignore post-deletion duplicates
    recentlySentCodes.add(code);
    setTimeout(() => {
      recentlySentCodes.delete(code);
    }, 600000); // Keep for 10 mins

    res.sendStatus(200);

  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(200);
  }
});

// ========================
// START SERVER
// ========================
app.listen(PORT, () => {
  console.log(`
================================
🚀 StatusDrop Server Running!
================================
Local: http://localhost:${PORT}
================================
  `);
});
