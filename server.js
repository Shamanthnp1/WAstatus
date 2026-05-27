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
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const compression = require('compression');
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

// Set FFmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

// Set ffprobe path
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

// =======================
// RATE LIMITING
// =======================
const limiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 50,                         // ✅ 50 uploads per day
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
    const filename = uuidv4() + path.extname(file.originalname);
    req.uploadFilePaths = req.uploadFilePaths || [];
    req.uploadFilePaths.push(path.join('uploads', filename));
    cb(null, filename);
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
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      resolve({
        width: videoStream?.width || 1080,
        height: videoStream?.height || 1920
      });
    });
  });
}


// ========================
// SHARED FFMPEG OPTIONS
// ========================
function getOutputOptions(duration, inputHeight = 1920) {
  console.log(`✅ getOutputOptions called! (Spoofing Mobile MP4 Atoms)`);

  const durationMs = duration * 1000;
  let bufSizeK;
  if (durationMs < 6000) {
    bufSizeK = 1900;
  } else if (durationMs < 11000) {
    bufSizeK = 3800;
  } else if (durationMs < 16000) {
    bufSizeK = 5700;
  } else {
    bufSizeK = 7600;
  }

  let vfFilter = inputHeight >= 2160 ? 'scale=1080:trunc(ow/a/2)*2' : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

  return [
    '-vf', vfFilter,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    
    // 1. MATCH BITRATE & QUALITY EXACTLY
    '-crf', '23',
    '-maxrate', '3800k',
    '-bufsize', `${bufSizeK}k`,

    // 2. FORCE KEYFRAMES (CRITICAL FOR WHATSAPP PASS-THROUGH)
    // WhatsApp transcodes videos if keyframes are too far apart.
    '-g', '30',
    '-keyint_min', '30',
    
    // 3. MATCH PROFILE EXACTLY
    '-profile:v', 'high',      
    '-level', '4.0',           
    
    // 🚨 4. SPOOF THE MP4 ATOMS AND HANDLERS (The Mobile Trap) 🚨
    '-metadata:s:v:0', 'handler_name=VideoHandle',
    '-metadata:s:a:0', 'handler_name=SoundHandle',
    '-metadata:s:v:0', 'language=eng',
    '-metadata:s:a:0', 'language=eng',
    
    // 🚨 5. CLONE THE COMPETITOR'S EXACT ENCODER VERSION 🚨
    // Instead of stripping tags, we forge the trusted mobile version.
    '-metadata', 'encoder=Lavf59.27.100',
    '-metadata:s:v:0', 'encoder=Lavc59.37.100 libx264',
    
    // 🚨 6. DISABLE EDIT LISTS 🚨
    // Modern FFmpeg adds these. WhatsApp hates them and re-encodes to remove them.
    '-use_editlist', '0',

    // 7. STANDARD AUDIO & CONTAINER
    '-r', '29.97',
    '-c:a', 'aac',
    '-ar', '44100',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-threads', '2',
  ];
}

// Split video into chunks of maxDuration seconds
async function splitVideo(inputPath, outputDir, duration, chunkDuration = 29, inputHeight = 1920) {
  const totalChunks = Math.ceil(duration / chunkDuration);
  console.log(`Splitting into ${totalChunks} chunks of ${chunkDuration}s each`);

  console.log(`splitVideo → chunkDuration:${chunkDuration}s | using CRF 23`);
  const videoBitrateK = 3800; // only for reference

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
    console.log(
      `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/` +
      `${Math.ceil(chunks.length / BATCH_SIZE)} ` +
      `(chunks ${i + 1}-${Math.min(i + BATCH_SIZE, chunks.length)})`
    );

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
              if (chunkCommand) {
                try { chunkCommand.kill('SIGKILL'); } catch (e) { }
              }
              finishChunk(new Error(`Chunk ${index + 1} timeout after 5 minutes`));
            }, 300000);

            chunkCommand = ffmpeg(inputPath)
              .setStartTime(startTime)
              .setDuration(chunkDuration)
              .outputOptions(getOutputOptions(chunkDuration, inputHeight, attempt)) // Pass attempt here
              .output(chunkPath)
              .on('end', () => finishChunk(null))
              .on('error', (err) => finishChunk(err));

            chunkCommand.run();
          });

          // Size check for the chunk
          const sizeMB = fs.statSync(chunkPath).size / (1024 * 1024);
          if (sizeMB <= 15.5) {
            console.log(`✅ Chunk ${index + 1}/${totalChunks} done! Size: ${sizeMB.toFixed(2)}MB`);
            return chunkPath; // Success, move to next chunk
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

// Compress single video with Multi-Pass Fallback
async function compressVideo(inputPath, outputPath, knownDuration, inputHeight = 1920) {
  const duration = Number.isFinite(knownDuration) ? knownDuration : await getVideoDuration(inputPath);
  
  // The 60-Second Rule: Skip 1080p completely if the video is roughly 60 seconds.
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
        if (ffmpegCommand) {
          try { ffmpegCommand.kill('SIGKILL'); } catch (e) { }
        }
        finish(new Error(`compressVideo timeout after 10 minutes on attempt ${attempt}`));
      }, 600000);

      // Pass the 'attempt' variable into getOutputOptions
      ffmpegCommand = ffmpeg(inputPath)
        .outputOptions(getOutputOptions(duration, inputHeight, attempt))
        .output(outputPath)
        .on('end', () => finish())
        .on('error', finish);

      ffmpegCommand.run();
    });

    // Check file size after FFmpeg finishes
    const sizeMB = fs.statSync(outputPath).size / (1024 * 1024);
    if (sizeMB <= 15.5) { // 15.5MB gives a safe 0.5MB buffer for the WhatsApp API
      console.log(`✅ Compression successful! Size: ${sizeMB.toFixed(2)}MB`);
      return; 
    }

    console.log(`⚠️ Attempt ${attempt} failed size check (${sizeMB.toFixed(2)}MB > 15.5MB). Retrying...`);
    // Loop continues and FFmpeg will overwrite the file with a lower resolution.
  }

  throw new Error('Video could not be compressed under 16MB even at 540p resolution.');
}

// Upload to Cloudflare R2
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
        timeoutPromise
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

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
    responseType: 'stream'
  });

  // Upload to WhatsApp
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', response.data, {
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
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
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

// ✅ Increase server timeout for long processing
app.use((req, res, next) => {
  // Set timeout to 15 minutes for /api/process
  if (req.path === '/api/process') {
    req.setTimeout(900000); // 15 minutes
    res.setTimeout(900000);
  }
  next();
});

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

// Replace /api/presign with this simpler endpoint
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

    // Return the Worker URL — no signing needed
    res.json({
      uploadUrl: `https://upload.wastatusvideo.com/upload/${key}`,
      key,
    });

  } catch (error) {
    console.error('Upload URL error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Process already-uploaded videos from R2
app.post('/api/process', limiter, async (req, res) => {
  try {
    const { files } = req.body;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files provided!' });
    }

    if (files.length > 3) {
      return res.status(400).json({ error: 'Max 3 files allowed!' });
    }

    // Total size check
    const totalSizeMB = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
    console.log(`📥 Processing ${files.length} file(s) — Total: ${totalSizeMB.toFixed(1)}MB`);

    if (totalSizeMB > 300) {
      return res.status(400).json({
        error: `Total size ${totalSizeMB.toFixed(0)}MB exceeds 300MB!`
      });
    }

    const activationCode = generateCode();
    const r2Files = [];
    const uploadedKeys = files.map(f => f.key);

    console.log(`🔧 Processing ${files.length} file(s) in parallel...`);

    try {
      // ✅ Process ALL files in parallel
      const allGroupResults = await Promise.all(
        files.map(async (fileInfo, index) => {
          const { key, originalName, size } = fileInfo;
          const inputUrl = `${process.env.R2_PUBLIC_URL}/${key}`;

          console.log(`📹 [${index + 1}/${files.length}] Processing: ${originalName} (${(size / 1024 / 1024).toFixed(1)}MB)`);

          const localInputPath = path.join('uploads', `input_${uuidv4()}${path.extname(originalName)}`);

          try {
            // ── STEP 1: Download from R2 ──
            console.log(`⬇️  [${index + 1}] Downloading from R2: ${key}`);
            const downloadStart = Date.now();

            const response = await axios.get(inputUrl, {
              responseType: 'stream',
              timeout: 300000,
            });

            await new Promise((resolve, reject) => {
              const writer = fs.createWriteStream(localInputPath);
              response.data.pipe(writer);
              writer.on('finish', resolve);
              writer.on('error', reject);
              response.data.on('error', reject);
            });

            const downloadDuration = ((Date.now() - downloadStart) / 1000).toFixed(2);
            console.log(`✅ [${index + 1}] Downloaded in ${downloadDuration}s`);

            // ── STEP 2: Delete original from R2 ──
            await deleteFromR2(key);
            console.log(`🗑️  [${index + 1}] Deleted original from R2: ${key}`);

            // ── STEP 3: Get duration & dimensions ──
            const duration = await getVideoDuration(localInputPath);
            const dimensions = await getVideoDimensions(localInputPath);
            console.log(`⏱️  [${index + 1}] Duration: ${duration.toFixed(1)}s | Dimensions: ${dimensions.width}x${dimensions.height}`);

            // ── STEP 4: Compress or Split ──
            if (duration <= 29) {
              // SHORT VIDEO
              console.log(`🎬 [${index + 1}] Short video — compressing...`);
              const outputFileName = `compressed_${uuidv4()}.mp4`;
              const outputPath = path.join('compressed', outputFileName);

              await compressVideo(localInputPath, outputPath, duration, dimensions.height);

              const url = await uploadToR2(outputPath, outputFileName);
              await fs.promises.unlink(outputPath).catch(() => { });

              console.log(`✅ [${index + 1}] R2 upload done: ${outputFileName}`);
              return [{ fileName: outputFileName, url }];

            } else {
              // LONG VIDEO
              console.log(`✂️  [${index + 1}] Long video (${duration.toFixed(1)}s) — splitting...`);
              const chunkPaths = await splitVideo(localInputPath, 'compressed', duration, 29, dimensions.height);

              console.log(`☁️  [${index + 1}] Uploading ${chunkPaths.length} chunks to R2...`);

              // ✅ Upload chunks sequentially to avoid overwhelming R2
              const chunkResults = [];
              for (let i = 0; i < chunkPaths.length; i++) {
                const chunkPath = chunkPaths[i];
                const chunkFileName = path.basename(chunkPath);

                const url = await uploadToR2(chunkPath, chunkFileName);
                await fs.promises.unlink(chunkPath).catch(() => { });

                console.log(`✅ [${index + 1}] Chunk ${i + 1}/${chunkPaths.length} uploaded: ${chunkFileName}`);
                chunkResults.push({ fileName: chunkFileName, url });
              }

              return chunkResults;
            }

          } finally {
            // ✅ Always clean local temp file
            await fs.promises.unlink(localInputPath).catch(() => { });
          }
        })
      );

      // ── STEP 5: Flatten results ──
      for (const group of allGroupResults) {
        for (const { fileName, url } of group) {
          r2Files.push({ fileName, url });
        }
      }

      console.log(`🎉 All ${r2Files.length} file(s) ready!`);

      // ── STEP 6: Store session ──
      const expiryTimer = setTimeout(async () => {
        const session = sessions.get(activationCode);
        if (session) {
          for (const file of session.files) {
            try {
              await deleteFromR2(file.fileName);
              console.log(`🗑️  R2 deleted (expired): ${file.fileName}`);
            } catch (err) {
              console.error('R2 cleanup error:', err.message);
            }
          }
          sessions.delete(activationCode);
          console.log(`⏰ Session expired: ${activationCode}`);
        }
      }, 300000);

      sessions.set(activationCode, {
        files: r2Files,
        createdAt: Date.now(),
        status: 'pending',
        expiryTimer: expiryTimer
      });

      // ── STEP 7: Return success ──
      const cleanNumber = process.env.WHATSAPP_BUSINESS_NUMBER.replace('+', '');
      const waLink = `https://wa.me/${cleanNumber}?text=Activation%20Code%3A%20${activationCode}`;

      res.json({
        success: true,
        activationCode,
        waLink,
        fileCount: r2Files.length
      });

    } catch (processingError) {
      // ✅ Cleanup uploaded files on error
      console.error('❌ Processing error, cleaning up R2 uploads...');
      for (const key of uploadedKeys) {
        try {
          await deleteFromR2(key);
          console.log(`🗑️  Cleaned up: ${key}`);
        } catch (cleanupErr) {
          console.error(`Failed to cleanup ${key}:`, cleanupErr.message);
        }
      }
      throw processingError;
    }

  } catch (error) {
    console.error('❌ Process error:', error);
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

    if (session.status === 'processing') {
      console.log(`Duplicate webhook for code: ${code} while processing - ignoring!`);
      return res.sendStatus(200);
    }

    if (session.status === 'failed') {
      try {
        await sendWhatsAppMessage(
          from,
          'Failed to send your video.\n\n' +
          'Please compress your video again and try with a new code.'
        );
      } catch (err) {
        console.error('Failed retry message:', err.message);
      }

      return res.sendStatus(200);
    }

    // Mark as processing
    session.status = 'processing';
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
      session.status = 'sent';
    } catch (err) {
      session.status = 'failed';
      sessions.set(code, session);
      console.error('WhatsApp video send failed:', err.message);

      try {
        await sendWhatsAppMessage(
          from,
          'Failed to send your video.\n\n' +
          'Please compress your video again and try with a new code.'
        );
      } catch (messageErr) {
        console.error('Failed send-failure message:', messageErr.message);
      }
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
      console.log(`Session cleaned after ${session.status}: ${code}`);
    }, 300000);

    session.files = [];           // R2 already deleted
    session.createdAt = Date.now(); // Reset for setInterval
    session.expiryTimer = newTimer; // ✅ Store new timer
    sessions.set(code, session);

    // ✅ Track sent code to silently ignore post-deletion duplicates
    if (session.status === 'sent') {
      recentlySentCodes.add(code);
      setTimeout(() => {
        recentlySentCodes.delete(code);
      }, 600000); // Keep for 10 mins
    }

    res.sendStatus(200);

  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(200);
  }
});

// ========================
// ERROR HANDLER
// ========================
app.use((err, req, res, next) => {
  if (
    err?.message === 'Request aborted' ||
    err?.code === 'ECONNABORTED' ||
    err?.type === 'request.aborted'
  ) {
    console.warn('Client aborted upload - cleaning up');
    if (!res.headersSent) {
      res.status(499).end();
    }
    return;
  }

  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message });
  }
});

// ========================
// START SERVER
// ========================
const server = app.listen(PORT, () => {
  console.log(`
================================
🚀 StatusDrop Server Running!
================================
Local: http://localhost:${PORT}
================================
  `);
});

server.requestTimeout = 0;
server.headersTimeout = 620000;
server.keepAliveTimeout = 610000;
