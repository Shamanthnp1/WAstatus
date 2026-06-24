'use strict';

/**
 * Integration test — output conformance (task 15.1).
 *
 * Encodes representative EDITED videos through the real Render_Engine plan +
 * encode-execution layer (`planRender`/`planChunk` + `encodeRecipePlan`) using
 * the project's bundled `ffmpeg-static`/`ffprobe-static` binaries, then ffprobes
 * each output and asserts it conforms to the WhatsApp_Spec and stays within the
 * Size_Limit:
 *   - 1080×1920, H.264, profile High, level 4.0 (40), yuv420p
 *   - AAC audio at ~128 kbps
 *   - +faststart (the `moov` atom precedes `mdat` in the file)
 *   - average video bitrate stays within the maxrate envelope (CRF/maxrate)
 *   - every produced clip is ≤ 16 MB (Size_Limit)
 *
 * Two representative cases are exercised:
 *   (a) a single edited clip — trim + a sticker overlay + original audio;
 *   (b) a longer source split into multiple chunks — each chunk ffprobed.
 *
 * The test is self-contained: it synthesizes tiny source videos and a sticker
 * PNG with ffmpeg in a temp dir (no committed fixtures) and removes everything
 * afterward. If ffmpeg/ffprobe are unavailable, every case SKIPS gracefully so
 * the suite never hard-fails in an environment without ffmpeg.
 *
 * Validates: Requirements 7.9, 11.5, 12.1, 12.2
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { SIZE_LIMIT_BYTES } = require('../../src/shared/constants');
const { planRender, planChunk, chunkCount } = require('../../src/server/renderEngine');
const { encodeRecipePlan } = require('../../src/server/encodeExec');

// ---- ffmpeg/ffprobe availability detection (skip-safe) --------------------

let ffmpegPath = null;
let ffprobePath = null;
let ffmpeg = null;
let ffmpegAvailable = false;

try {
  ffmpegPath = require('ffmpeg-static');
  ffprobePath = require('ffprobe-static').path;
  ffmpeg = require('fluent-ffmpeg');
  ffmpegAvailable =
    Boolean(ffmpegPath) &&
    Boolean(ffprobePath) &&
    fs.existsSync(ffmpegPath) &&
    fs.existsSync(ffprobePath);
  if (ffmpegAvailable) {
    // The fluent-ffmpeg module is a singleton; configuring it here also
    // configures the instance used inside encodeExec's buildRecipeCommand.
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);
  }
} catch (e) {
  ffmpegAvailable = false;
}

const SKIP_REASON = ffmpegAvailable ? false : 'ffmpeg/ffprobe binaries unavailable';

// A smaller clip limit keeps the split case fast while still exercising the
// real multi-chunk tiling and per-chunk conformance/size path (the encode
// settings and Size_Limit are identical regardless of the limit value).
const TEST_CLIP_LIMIT = 4;
const CASE_TIMEOUT_MS = 180000;

// ---- temp workspace -------------------------------------------------------

let tmpDir = null;
let singleSrc = null;
let splitSrc = null;
let stickerPng = null;

/** Run the bundled ffmpeg binary with the given args (throws on failure). */
function runFfmpeg(args) {
  execFileSync(ffmpegPath, args, { stdio: 'pipe' });
}

/**
 * Synthesize a source video (testsrc video + sine audio) of the given duration
 * and dimensions into `outPath`. The content is intentionally simple so the
 * encode is fast; the Render_Engine always normalizes to 1080×1920 anyway.
 */
function genSource(outPath, durationSec, w, h) {
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${w}x${h}:rate=24:duration=${durationSec}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-t', String(durationSec),
    outPath,
  ]);
}

/** Synthesize a small transparent (RGBA) sticker PNG for overlay compositing. */
function genSticker(outPath) {
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=120x120,format=rgba',
    '-frames:v', '1',
    outPath,
  ]);
}

/** Probe a media file, resolving { streams, format }. */
function probe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata);
    });
  });
}

/**
 * Assert that a produced clip conforms to the WhatsApp_Spec and the Size_Limit.
 * @param {string} file - Output clip path.
 * @param {string} label - Human label for assertion messages.
 */
async function assertConformance(file, label) {
  assert.ok(fs.existsSync(file), `${label}: output file should exist`);

  // ---- Size_Limit (Req 11.5, 12.2) ----
  const size = fs.statSync(file).size;
  assert.ok(
    size <= SIZE_LIMIT_BYTES,
    `${label}: size ${size} must be <= Size_Limit ${SIZE_LIMIT_BYTES}`
  );
  assert.ok(size > 0, `${label}: output must not be empty`);

  const meta = await probe(file);
  const video = meta.streams.find((s) => s.codec_type === 'video');
  const audio = meta.streams.find((s) => s.codec_type === 'audio');

  // ---- Video conformance (Req 12.1) ----
  assert.ok(video, `${label}: must contain a video stream`);
  assert.equal(video.codec_name, 'h264', `${label}: video codec must be H.264`);
  assert.equal(video.width, 1080, `${label}: width must be 1080`);
  assert.equal(video.height, 1920, `${label}: height must be 1920`);
  assert.equal(video.pix_fmt, 'yuv420p', `${label}: pixel format must be yuv420p`);
  assert.equal(
    String(video.profile).toLowerCase(),
    'high',
    `${label}: H.264 profile must be High`
  );
  // ffprobe reports H.264 level as an integer scaled by 10 (4.0 -> 40).
  assert.equal(Number(video.level), 40, `${label}: H.264 level must be 4.0 (40)`);

  // ---- Audio conformance (Req 7.9, 12.1) ----
  assert.ok(audio, `${label}: must contain an audio stream`);
  assert.equal(audio.codec_name, 'aac', `${label}: audio codec must be AAC`);
  const audioBitrate = Number(audio.bit_rate);
  if (Number.isFinite(audioBitrate) && audioBitrate > 0) {
    // Target is 128k; allow encoder/container tolerance.
    assert.ok(
      audioBitrate >= 96000 && audioBitrate <= 160000,
      `${label}: audio bitrate ${audioBitrate} should be ~128k`
    );
  }

  // ---- CRF/maxrate behavior (Req 12.1) ----
  // The encode caps peak rate at maxrate=3800k; the average for simple content
  // must comfortably stay within that envelope (with headroom for short clips).
  const formatBitrate = Number(meta.format && meta.format.bit_rate);
  if (Number.isFinite(formatBitrate) && formatBitrate > 0) {
    assert.ok(
      formatBitrate <= 3800000 * 1.5,
      `${label}: overall bitrate ${formatBitrate} should respect the maxrate envelope`
    );
  }

  // ---- +faststart (Req 12.1) ----
  // With +faststart the moov atom is relocated ahead of mdat. Detect by the
  // byte offsets of the atom markers (outputs are small, well under 16 MB).
  const head = fs.readFileSync(file);
  const moovIdx = head.indexOf(Buffer.from('moov'));
  const mdatIdx = head.indexOf(Buffer.from('mdat'));
  assert.ok(moovIdx !== -1, `${label}: moov atom must be present`);
  assert.ok(mdatIdx !== -1, `${label}: mdat atom must be present`);
  assert.ok(
    moovIdx < mdatIdx,
    `${label}: +faststart requires the moov atom before mdat (moov=${moovIdx}, mdat=${mdatIdx})`
  );
}

test.before(() => {
  if (!ffmpegAvailable) return;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wastatus-conf-'));
  singleSrc = path.join(tmpDir, 'single-src.mp4');
  splitSrc = path.join(tmpDir, 'split-src.mp4');
  stickerPng = path.join(tmpDir, 'sticker.png');

  // Small, fast sources. The single source is short; the split source is long
  // enough to tile into 3 chunks at the reduced TEST_CLIP_LIMIT.
  genSource(singleSrc, 4, 1280, 720);
  genSource(splitSrc, 9, 1280, 720);
  genSticker(stickerPng);
});

test.after(() => {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      /* best-effort cleanup */
    }
  }
});

test(
  'single edited clip (trim + sticker overlay + original audio) conforms to WhatsApp_Spec and Size_Limit',
  { skip: SKIP_REASON, timeout: CASE_TIMEOUT_MS },
  async () => {
    const outPath = path.join(tmpDir, 'single-out.mp4');

    const recipe = {
      version: 1,
      trim: { start: 0.5, end: 3.5 },
      textOverlays: [],
      stickers: [
        {
          id: 's1',
          assetRef: 'sticker_red',
          pos: { x: 0.5, y: 0.4 },
          scale: 1.0,
          rotation: 15,
        },
      ],
      audio: { originalMuted: false, originalVolume: 100 },
    };

    const meta = {
      width: 1280,
      height: 720,
      duration: 4,
      key: 'single',
      path: singleSrc,
      assetPaths: { sticker_red: stickerPng },
    };

    const plan = planRender(recipe, meta);
    assert.equal(plan.encodeCount, 1, 'a recipe plan must represent exactly one video encode');

    await encodeRecipePlan(plan, outPath, CASE_TIMEOUT_MS, 'single-clip');

    await assertConformance(outPath, 'single clip');

    try {
      fs.unlinkSync(outPath);
    } catch (e) {
      /* best-effort */
    }
  }
);

test(
  'split-into-chunks video produces multiple chunks each conforming to WhatsApp_Spec and Size_Limit',
  { skip: SKIP_REASON, timeout: CASE_TIMEOUT_MS },
  async () => {
    const recipe = {
      version: 1,
      textOverlays: [],
      stickers: [
        {
          id: 's1',
          assetRef: 'sticker_red',
          pos: { x: 0.3, y: 0.7 },
          scale: 0.8,
          rotation: 0,
        },
      ],
      audio: { originalMuted: false, originalVolume: 100 },
    };

    const meta = {
      width: 1280,
      height: 720,
      duration: 9,
      key: 'split',
      path: splitSrc,
      assetPaths: { sticker_red: stickerPng },
    };

    const plan = planRender(recipe, meta);
    const count = chunkCount(plan.plannedDuration, TEST_CLIP_LIMIT);
    assert.ok(count >= 2, `split source should tile into 2+ chunks (got ${count})`);

    const chunkPaths = [];
    for (let i = 0; i < count; i++) {
      const chunkPlan = planChunk(plan, i, TEST_CLIP_LIMIT);
      assert.equal(
        chunkPlan.encodeCount,
        1,
        `chunk ${i} must represent exactly one video encode`
      );
      const outPath = path.join(tmpDir, `split-out-${i}.mp4`);
      chunkPaths.push(outPath);
      // eslint-disable-next-line no-await-in-loop
      await encodeRecipePlan(chunkPlan, outPath, CASE_TIMEOUT_MS, `chunk-${i}`);
    }

    for (let i = 0; i < chunkPaths.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      await assertConformance(chunkPaths[i], `chunk ${i}`);
    }

    for (const p of chunkPaths) {
      try {
        fs.unlinkSync(p);
      } catch (e) {
        /* best-effort */
      }
    }
  }
);
