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

// ========================
// MIDDLEWARE
// ========================
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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
// (Activation codes)
// ========================
const sessions = new Map();

// Auto cleanup sessions
// every 30 minutes
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
  message: {
    error: 'Daily limit reached!'
  }
});

// ========================
// FILE UPLOAD SETUP
// ========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueName = uuidv4() + 
      path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = 
    /mp4|mov|avi|mkv|3gp|wmv/;
  const extname = allowedTypes.test(
    path.extname(
      file.originalname
    ).toLowerCase()
  );
  if (extname) {
    cb(null, true);
  } else {
    cb(new Error('Only video files!'));
  }
};

const upload = multer({
  storage: storage,
  limits: { 
    fileSize: 200 * 1024 * 1024 
  },
  fileFilter: fileFilter
});

// ========================
// HELPER FUNCTIONS
// ========================

// Generate activation code
function generateCode() {
  const chars = 
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 9; i++) {
    code += chars.charAt(
      Math.floor(Math.random() * chars.length)
    );
  }
  return code;
}

// Upload to Cloudflare R2
async function uploadToR2(
  filePath, 
  fileName
) {
  try {
    console.log('Uploading to R2...');
    console.log('File:', filePath);
    console.log('R2 Config:', {
      endpoint: process.env.R2_ENDPOINT,
      bucket: process.env.R2_BUCKET_NAME,
      keyId: process.env.R2_ACCESS_KEY_ID 
        ? 'SET ✅' : 'MISSING ❌',
      secret: process.env.R2_SECRET_ACCESS_KEY 
        ? 'SET ✅' : 'MISSING ❌'
    });

    const fileContent = 
      fs.readFileSync(filePath);
    
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: fileContent,
      ContentType: 'video/mp4',
    });

    await r2Client.send(command);
    console.log('R2 Upload success! ✅');
    
    const publicUrl = 
      `${process.env.R2_PUBLIC_URL}/${fileName}`;
    console.log('Public URL:', publicUrl);
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

// Compress video with FFmpeg
function compressVideo(
  inputPath, 
  outputPath
) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',
        '-crf 28',
        '-preset medium',
        '-c:a aac',
        '-b:a 128k',
        '-movflags faststart',
        '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-fs 15728640',
      ])
      .output(outputPath)
      .on('start', () => {
        console.log('Compression started...');
      })
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

// Send WhatsApp message
async function sendWhatsAppMessage(
  to, 
  message
) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: message }
    },
    {
      headers: {
        'Authorization': 
          `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// Send WhatsApp video
async function sendWhatsAppVideo(
  to, 
  videoUrl, 
  caption
) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: to,
      type: 'video',
      video: {
        link: videoUrl,
        caption: caption
      }
    },
    {
      headers: {
        'Authorization': 
          `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// ========================
// ROUTES
// ========================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: '✅ Server Running!' 
  });
});

// Upload & Compress Videos
app.post(
  '/api/compress',
  limiter,
  upload.array('videos', 10),
  async (req, res) => {
    try {
      if (!req.files || 
          req.files.length === 0) {
        return res.status(400).json({ 
          error: 'No files uploaded!' 
        });
      }

      // Generate activation code
      const activationCode = generateCode();
      const r2Files = [];

      // Process each video
      for (const file of req.files) {
        const outputFileName = 
          `compressed_${uuidv4()}.mp4`;
        const outputPath = path.join(
          'compressed', 
          outputFileName
        );

        // Compress video
        await compressVideo(
          file.path, 
          outputPath
        );

        // Upload to R2
        const publicUrl = await uploadToR2(
          outputPath,
          outputFileName
        );

        r2Files.push({
          fileName: outputFileName,
          url: publicUrl
        });

        // Delete local files
        fs.unlinkSync(file.path);
        fs.unlinkSync(outputPath);
      }

      // Store session
      sessions.set(activationCode, {
        files: r2Files,
        createdAt: Date.now(),
        status: 'pending'
      });

      // WhatsApp click-to-chat link
      const cleanNumber = 
        process.env.WHATSAPP_BUSINESS_NUMBER
        .replace('+', '');

      const waLink = 
        `https://wa.me/${cleanNumber}` +
        `?text=Activation%20Code%3A%20${activationCode}`;

      res.json({
        success: true,
        activationCode: activationCode,
        waLink: waLink,
        fileCount: r2Files.length
      });

    } catch (error) {
      console.error('Compress error:', error);
      res.status(500).json({ 
        error: error.message 
      });
    }
  }
);

// ========================
// WEBHOOK ROUTES
// ========================

// Webhook verification (Meta)
app.get('/webhook', (req, res) => {
  const mode = 
    req.query['hub.mode'];
  const token = 
    req.query['hub.verify_token'];
  const challenge = 
    req.query['hub.challenge'];

  if (mode === 'subscribe' && 
      token === process.env.WEBHOOK_VERIFY_TOKEN) {
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

    if (!messages || 
        messages.length === 0) {
      return res.sendStatus(200);
    }

    const message = messages[0];
    const from = message.from;
    const text = message.text?.body?.trim();

    console.log(`Message from ${from}: ${text}`);

    // Extract activation code
    const codeMatch = text?.match(
      /Activation Code[:\s]+([A-Z0-9]{9})/i
    );

    if (!codeMatch) {
      // Unknown message
      await sendWhatsAppMessage(
        from,
        '👋 Welcome to StatusDrop!\n\n' +
        'Please visit our website to ' +
        'compress and receive your HD videos!\n\n' +
        '🌐 www.statusdrop.com'
      );
      return res.sendStatus(200);
    }

    const code = codeMatch[1]
      .toUpperCase();
    const session = sessions.get(code);

    if (!session) {
      await sendWhatsAppMessage(
        from,
        '❌ Invalid or expired code!\n\n' +
        'Please compress your video again ' +
        'at www.statusdrop.com'
      );
      return res.sendStatus(200);
    }

    if (session.status === 'sent') {
      await sendWhatsAppMessage(
        from,
        '✅ Videos already sent!\n\n' +
        'Check your WhatsApp messages!'
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
      `Sending ${session.files.length} ` +
      'HD video(s) now...\n\n' +
      'Please wait a moment! 🎬'
    );

    // Send each video
    for (let i = 0; 
         i < session.files.length; 
         i++) {
      const file = session.files[i];
      
      await sendWhatsAppVideo(
        from,
        file.url,
        `🎬 HD Status Video ` +
        `${i + 1}/${session.files.length}\n\n` +
        `✅ How to upload as Status:\n` +
        `1. Tap & hold this video\n` +
        `2. Tap "Forward"\n` +
        `3. Select "My Status"\n` +
        `4. Done! 🎉\n\n` +
        `Powered by StatusDrop 💚`
      );

      // Small delay between videos
      if (i < session.files.length - 1) {
        await new Promise(r => 
          setTimeout(r, 1000)
        );
      }
    }

    // Schedule R2 cleanup
    setTimeout(async () => {
      for (const file of session.files) {
        try {
          await deleteFromR2(file.fileName);
          console.log(
            `Deleted from R2: ${file.fileName}`
          );
        } catch (err) {
          console.error('R2 delete error:', err);
        }
      }
      sessions.delete(code);
    }, 3600000); // 1 hour

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