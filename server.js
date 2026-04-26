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
require('dotenv').config();

// ========================
// APP SETUP
// ========================
const app = express();
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
app.use(cors());
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

// Auto cleanup every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, session] of sessions.entries()) {
    if (now - session.createdAt > 3600000) {
      sessions.delete(code);
      console.log(`Session expired: ${code}`);
    }
  }
}, 1800000);

// ========================
// RATE LIMITING
// ========================
const limiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: { error: 'Daily limit reached!' }
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
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
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

      const chunkPaths = [];

      for (let i = 0; i < totalChunks; i++) {
        const startTime = i * chunkDuration;
        const chunkFileName = `chunk_${uuidv4()}.mp4`;
        const chunkPath = path.join(outputDir, chunkFileName);

        await new Promise((res, rej) => {
          ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(chunkDuration)
            .outputOptions([
              '-c:v libx264',
              '-crf 28',
              '-preset ultrafast',
              '-c:a aac',
              '-b:a 128k',
              '-movflags faststart',
              '-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2',
            ])
            .output(chunkPath)
            .on('start', () => console.log(`Chunk ${i + 1}/${totalChunks} started...`))
            .on('end', () => {
              console.log(`Chunk ${i + 1}/${totalChunks} done!`);
              chunkPaths.push(chunkPath);
              res();
            })
            .on('error', (err) => {
              console.error(`Chunk ${i + 1} error:`, err);
              rej(err);
            })
            .run();
        });
      }

      resolve(chunkPaths);
    } catch (err) {
      reject(err);
    }
  });
}

// Compress single video (for short videos under 29s)
function compressVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',
        '-crf 28',
        '-preset ultrafast',
        '-c:a aac',
        '-b:a 128k',
        '-movflags faststart',
        '-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-fs 15728640', // 15MB cap for single videos
      ])
      .output(outputPath)
      .on('start', () => console.log('Compression started...'))
      .on('end', () => {
        console.log('Compression done!');
        resolve();
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        reject(err);
      })
      .run();
  });
}

// Upload to Cloudflare R2
async function uploadToR2(filePath, fileName) {
  try {
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
    console.log('R2 Upload success! ✅', publicUrl);
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
      `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
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
    `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/media`,
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
    `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
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
  res.send(`
    <h1>Privacy Policy - StatusDrop</h1>
    <p><b>Last updated: April 2026</b></p>
    <p>StatusDrop compresses your videos for WhatsApp Status.</p>
    <h2>Data We Collect</h2>
    <p>We temporarily store uploaded videos for compression only. All files are permanently deleted within 1 hour.</p>
    <h2>WhatsApp</h2>
    <p>We use your WhatsApp number only to deliver your compressed video. We do not store or share it.</p>
    <h2>Contact</h2>
    <p>Email: shamanthnadumane@email.com</p>
  `);
});

// Upload & Compress Videos
app.post('/api/compress', limiter, upload.array('videos', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded!' });
    }

    const activationCode = generateCode();
    const r2Files = [];

    for (const file of req.files) {
      console.log(`Processing: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

      // Get video duration
      const duration = await getVideoDuration(file.path);

      if (duration <= 29) {
        // SHORT VIDEO — compress directly
        console.log('Short video — compressing directly...');
        const outputFileName = `compressed_${uuidv4()}.mp4`;
        const outputPath = path.join('compressed', outputFileName);

        await compressVideo(file.path, outputPath);

        const publicUrl = await uploadToR2(outputPath, outputFileName);
        r2Files.push({ fileName: outputFileName, url: publicUrl });

        fs.unlinkSync(outputPath);
      } else {
        // LONG VIDEO — split into 29s chunks
        console.log(`Long video (${duration.toFixed(1)}s) — splitting into chunks...`);
        const chunkPaths = await splitVideo(file.path, 'compressed', 29);

        for (const chunkPath of chunkPaths) {
          const chunkFileName = path.basename(chunkPath);
          const publicUrl = await uploadToR2(chunkPath, chunkFileName);
          r2Files.push({ fileName: chunkFileName, url: publicUrl });
          fs.unlinkSync(chunkPath);
        }
      }

      // Delete original upload
      fs.unlinkSync(file.path);
    }

    // Store session
    sessions.set(activationCode, {
      files: r2Files,
      createdAt: Date.now(),
      status: 'pending'
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
    const codeMatch = text?.match(/Activation Code[:\s]+([A-Z0-9]{9})/i);

    if (!codeMatch) {
      await sendWhatsAppMessage(
        from,
        '👋 Welcome to StatusDrop!\n\n' +
        'Please visit our website to compress and receive your HD videos!\n\n' +
        '🌐 wastatus-production.up.railway.app'
      );
      return res.sendStatus(200);
    }

    const code = codeMatch[1].toUpperCase();
    const session = sessions.get(code);

    if (!session) {
      await sendWhatsAppMessage(
        from,
        '❌ Invalid or expired code!\n\n' +
        'Please compress your video again at our website.'
      );
      return res.sendStatus(200);
    }

    if (session.status === 'sent') {
      await sendWhatsAppMessage(
        from,
        '✅ Videos already sent!\n\nCheck your WhatsApp messages!'
      );
      return res.sendStatus(200);
    }

    // Mark as processing
    session.status = 'sent';
    sessions.set(code, session);

    // Send confirmation
    await sendWhatsAppMessage(
      from,
      '✅ Code verified!\n\n' +
      `Sending ${session.files.length} video${session.files.length > 1 ? 's' : ''} now...\n\n` +
      (session.files.length > 1 ? `📱 Your video was split into ${session.files.length} parts for WhatsApp Status!\n\n` : '') +
      'Please wait a moment! 🎬'
    );

    // Send each video
    for (let i = 0; i < session.files.length; i++) {
      const file = session.files[i];
      const isMultiple = session.files.length > 1;

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

      // Delay between videos
      if (i < session.files.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // Schedule R2 cleanup after 1 hour
    setTimeout(async () => {
      for (const file of session.files) {
        try {
          await deleteFromR2(file.fileName);
          console.log(`Deleted from R2: ${file.fileName}`);
        } catch (err) {
          console.error('R2 delete error:', err);
        }
      }
      sessions.delete(code);
    }, 3600000);

    res.sendStatus(200);

  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
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