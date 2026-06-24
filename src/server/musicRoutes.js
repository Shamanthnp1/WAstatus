'use strict';

/**
 * Music & asset routes — Royalty_Free_Library manifest and the
 * `GET /api/library` endpoint.
 *
 * This module exposes ONLY the curated, server-hosted royalty-free library.
 * Music_Tracks may originate solely from user uploads (handled elsewhere) or
 * from this licensed library — there is deliberately NO capability anywhere in
 * this surface to extract, rip, or import audio from third-party streaming
 * services.
 *
 * The library is a static, server-curated manifest of licensed tracks. The
 * public endpoint returns only the fields a client needs to list and preview a
 * track: `{ id, title, artist, duration, url }`. The internal manifest also
 * records the `license` for each track for auditing, but that is not exposed.
 *
 * Structured to mount into the existing Express app (server.js) either by
 * using the exported router (`app.use(router)`) or the `register(app)` helper.
 * CommonJS to match the existing codebase.
 *
 * @see Requirements 8.2, 8.3, 8.4
 * @see design.md "Music & asset endpoints"
 */

const express = require('express');
const crypto = require('crypto');
const { INPUT_LIMITS } = require('../shared/constants.js');

/**
 * Content types accepted for uploaded Music_Tracks. The browser sends the
 * file's MIME type when requesting an upload URL; anything outside this set is
 * rejected before a presigned URL is issued (no audio-rip surface).
 * @type {string[]}
 */
const ALLOWED_AUDIO_CONTENT_TYPES = Object.freeze([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/aac',
  'audio/x-m4a',
  'audio/m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
  'audio/x-flac',
  'audio/3gpp',
]);

/**
 * Derive a lower-cased file extension (including the leading dot) from a name,
 * or '' when none is present. Kept dependency-free (no `path`) so the handler
 * factories stay trivially testable.
 * @param {string} filename
 * @returns {string}
 */
function extOf(filename) {
  const str = typeof filename === 'string' ? filename : '';
  const dot = str.lastIndexOf('.');
  if (dot <= 0 || dot === str.length - 1) {
    return '';
  }
  return str.slice(dot).toLowerCase();
}

/**
 * Build the public base URL where curated library audio is hosted.
 *
 * Library audio is hosted by StatusDrop (on R2, like every other asset). When
 * `R2_PUBLIC_URL` is configured we serve tracks from a `library/` prefix under
 * it; otherwise we fall back to a relative path so the manifest is still
 * well-formed in local/dev environments.
 *
 * @returns {string} Base URL (no trailing slash) for library track files.
 */
function libraryBaseUrl() {
  const base = process.env.R2_PUBLIC_URL;
  if (typeof base === 'string' && base.trim() !== '') {
    return `${base.replace(/\/+$/, '')}/library`;
  }
  return '/library';
}

/**
 * The curated, licensed Royalty_Free_Library manifest.
 *
 * Each entry is a {@link import('../shared/constants.js').LibraryTrack}. The
 * `file` is resolved against {@link libraryBaseUrl} at request time so the
 * manifest itself stays environment-independent. `license` is retained for
 * internal auditing and intentionally omitted from the public response.
 *
 * @see Requirements 8.2
 */
const ROYALTY_FREE_LIBRARY = Object.freeze([
  Object.freeze({
    id: 'lib_sunrise_drive',
    title: 'Sunrise Drive',
    artist: 'StatusDrop Audio',
    duration: 60,
    file: 'sunrise-drive.m4a',
    license: 'CC0-1.0',
  }),
  Object.freeze({
    id: 'lib_city_lights',
    title: 'City Lights',
    artist: 'StatusDrop Audio',
    duration: 60,
    file: 'city-lights.m4a',
    license: 'CC0-1.0',
  }),
  Object.freeze({
    id: 'lib_calm_waters',
    title: 'Calm Waters',
    artist: 'StatusDrop Audio',
    duration: 60,
    file: 'calm-waters.m4a',
    license: 'CC0-1.0',
  }),
  Object.freeze({
    id: 'lib_festival_beat',
    title: 'Festival Beat',
    artist: 'StatusDrop Audio',
    duration: 60,
    file: 'festival-beat.m4a',
    license: 'CC0-1.0',
  }),
  Object.freeze({
    id: 'lib_quiet_morning',
    title: 'Quiet Morning',
    artist: 'StatusDrop Audio',
    duration: 60,
    file: 'quiet-morning.m4a',
    license: 'CC0-1.0',
  }),
  Object.freeze({
    id: 'lib_neon_nights',
    title: 'Neon Nights',
    artist: 'StatusDrop Audio',
    duration: 60,
    file: 'neon-nights.m4a',
    license: 'CC0-1.0',
  }),
]);

/**
 * Project a manifest entry to the public shape returned by `GET /api/library`.
 *
 * @param {{id:string,title:string,artist:string,duration:number,file:string}} track
 * @param {string} baseUrl - Base URL for library audio files.
 * @returns {{id:string,title:string,artist:string,duration:number,url:string}}
 */
function toPublicTrack(track, baseUrl) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    url: `${baseUrl}/${track.file}`,
  };
}

/**
 * Build the public library listing: an array of
 * `{ id, title, artist, duration, url }`.
 *
 * @returns {Array<{id:string,title:string,artist:string,duration:number,url:string}>}
 */
function getLibraryManifest() {
  const baseUrl = libraryBaseUrl();
  return ROYALTY_FREE_LIBRARY.map((track) => toPublicTrack(track, baseUrl));
}

/**
 * Express handler for `GET /api/library`. Returns the curated royalty-free
 * library as an array of public track descriptors.
 *
 * @param {express.Request} _req
 * @param {express.Response} res
 */
function getLibraryHandler(_req, res) {
  res.json(getLibraryManifest());
}

/* ============================================================================
 * Music upload-url & validate handlers (Req 8.1, 8.5, 8.6, 8.7)
 *
 * Both handlers are built by factories that take their side effects (presign,
 * ffprobe duration probe, audio loader) as injected dependencies, mirroring the
 * dependency-injection style of cleanup.js (`makeR2Deps`/`makeSweepDeps`). This
 * keeps the boundary logic — the size/duration gates that Property 15 covers —
 * pure and unit/property testable with no real R2 or ffmpeg.
 *
 * These endpoints are stateless with respect to the user's current Music_Track
 * selection: a rejection simply returns an error and performs no server-side
 * mutation, so "any previously selected Music_Track is retained unchanged"
 * (Req 8.6/8.7) holds by construction — the editor keeps its prior selection.
 * ==========================================================================*/

/**
 * Build the `POST /api/music/upload-url` handler.
 *
 * Pre-checks the requested upload size against the 20 MB audio limit BEFORE a
 * presigned URL is issued. On success it allocates an `assetId` and returns
 * `{ uploadUrl, assetId, key }`; when the requested size exceeds the limit it
 * rejects with HTTP 400 naming the violated size limit and issues no URL.
 *
 * @param {Object} deps
 * @param {(args: { key: string, assetId: string, contentType: string }) => string} deps.presign
 *   Returns the upload URL the browser should PUT the audio to (Worker → R2).
 * @param {() => string} [deps.generateAssetId] - Allocates a unique asset id
 *   (defaults to `crypto.randomUUID`).
 * @param {number} [deps.maxAudioBytes] - Size ceiling in bytes
 *   (defaults to {@link INPUT_LIMITS.MAX_AUDIO_BYTES}, 20 MB).
 * @param {string[]} [deps.allowedContentTypes] - Accepted audio MIME types
 *   (defaults to {@link ALLOWED_AUDIO_CONTENT_TYPES}).
 * @returns {(req: express.Request, res: express.Response) => void}
 */
function makeMusicUploadUrlHandler(deps = {}) {
  const presign = deps.presign;
  if (typeof presign !== 'function') {
    throw new Error('makeMusicUploadUrlHandler requires a presign function');
  }
  const generateAssetId = typeof deps.generateAssetId === 'function'
    ? deps.generateAssetId
    : () => crypto.randomUUID();
  const maxAudioBytes = Number.isFinite(deps.maxAudioBytes)
    ? deps.maxAudioBytes
    : INPUT_LIMITS.MAX_AUDIO_BYTES;
  const allowedContentTypes = Array.isArray(deps.allowedContentTypes) && deps.allowedContentTypes.length > 0
    ? deps.allowedContentTypes
    : ALLOWED_AUDIO_CONTENT_TYPES;

  return function musicUploadUrlHandler(req, res) {
    try {
      const body = req.body || {};
      const { filename, contentType } = body;
      const numericFileSize = Number(body.fileSize);

      if (!filename || !contentType || !Number.isFinite(numericFileSize)) {
        return res.status(400).json({ error: 'Missing required fields: filename, contentType, fileSize' });
      }
      if (!allowedContentTypes.includes(contentType)) {
        return res.status(400).json({ error: 'Only audio files are allowed for music uploads.' });
      }
      // Size pre-check BEFORE issuing any upload URL (Req 8.6). Prior selection
      // is left unchanged: we return an error and perform no mutation.
      if (numericFileSize > maxAudioBytes) {
        return res.status(400).json({
          error: `Audio file exceeds the 20 MB size limit (${maxAudioBytes} bytes).`,
          limit: 'size',
          maxBytes: maxAudioBytes,
        });
      }

      const assetId = generateAssetId();
      const key = `music/${assetId}${extOf(filename)}`;
      const uploadUrl = presign({ key, assetId, contentType });
      return res.json({ uploadUrl, assetId, key });
    } catch (error) {
      return res.status(500).json({ error: error && error.message ? error.message : String(error) });
    }
  };
}

/**
 * Build the `POST /api/music/validate` handler.
 *
 * Validates an already-uploaded Music_Track against BOTH the 20 MB size limit
 * and the 600 s (10 minute) duration limit. The size is taken from the loaded
 * asset (authoritative) and the duration is measured with the injected ffprobe
 * probe. On any violation it returns HTTP 400 naming the violated limit (`size`
 * or `duration`) and performs no mutation, so any prior selection is retained
 * (Req 8.6/8.7). On success it returns `{ ok: true, duration, assetId }`.
 *
 * @param {Object} deps
 * @param {(args: { key: string, assetId: string }) => (Promise<{ localPath?: string, sizeBytes: number, cleanup?: Function }>|{ localPath?: string, sizeBytes: number, cleanup?: Function })} deps.loadAudio
 *   Locates the uploaded audio for probing and reports its authoritative size in
 *   bytes. MAY return a `localPath` to probe and a `cleanup` fn to remove temp data.
 * @param {(source: string) => (Promise<number>|number)} deps.probeDuration
 *   ffprobe-style duration probe returning seconds for the loaded audio.
 * @param {number} [deps.maxAudioBytes] - Size ceiling in bytes
 *   (defaults to {@link INPUT_LIMITS.MAX_AUDIO_BYTES}, 20 MB).
 * @param {number} [deps.maxAudioDurationSeconds] - Duration ceiling in seconds
 *   (defaults to {@link INPUT_LIMITS.MAX_AUDIO_DURATION_SECONDS}, 600 s).
 * @returns {(req: express.Request, res: express.Response) => Promise<void>}
 */
function makeMusicValidateHandler(deps = {}) {
  const loadAudio = deps.loadAudio;
  const probeDuration = deps.probeDuration;
  if (typeof loadAudio !== 'function') {
    throw new Error('makeMusicValidateHandler requires a loadAudio function');
  }
  if (typeof probeDuration !== 'function') {
    throw new Error('makeMusicValidateHandler requires a probeDuration function');
  }
  const maxAudioBytes = Number.isFinite(deps.maxAudioBytes)
    ? deps.maxAudioBytes
    : INPUT_LIMITS.MAX_AUDIO_BYTES;
  const maxAudioDurationSeconds = Number.isFinite(deps.maxAudioDurationSeconds)
    ? deps.maxAudioDurationSeconds
    : INPUT_LIMITS.MAX_AUDIO_DURATION_SECONDS;

  return async function musicValidateHandler(req, res) {
    const body = req.body || {};
    const { assetId, key } = body;

    if (!assetId && !key) {
      return res.status(400).json({ error: 'Missing required field: assetId or key' });
    }

    let loaded;
    try {
      loaded = await loadAudio({ key, assetId });
    } catch (error) {
      return res.status(500).json({ error: error && error.message ? error.message : String(error) });
    }

    const cleanup = loaded && typeof loaded.cleanup === 'function' ? loaded.cleanup : null;
    try {
      const sizeBytes = loaded && Number.isFinite(loaded.sizeBytes) ? loaded.sizeBytes : NaN;

      // Size gate first (Req 8.6). Authoritative size from the uploaded asset.
      if (Number.isFinite(sizeBytes) && sizeBytes > maxAudioBytes) {
        return res.status(400).json({
          error: `Audio file exceeds the 20 MB size limit (${maxAudioBytes} bytes).`,
          limit: 'size',
          maxBytes: maxAudioBytes,
        });
      }

      // Duration gate (Req 8.7), measured with ffprobe.
      const source = loaded && loaded.localPath ? loaded.localPath : (key || assetId);
      const duration = await probeDuration(source);

      if (!Number.isFinite(duration)) {
        return res.status(400).json({ error: 'Could not determine audio duration.' });
      }
      if (duration > maxAudioDurationSeconds) {
        return res.status(400).json({
          error: `Audio exceeds the 10-minute duration limit (${maxAudioDurationSeconds} seconds).`,
          limit: 'duration',
          maxDurationSeconds: maxAudioDurationSeconds,
        });
      }

      // Accepted (Req 8.5): size <= 20 MB AND duration <= 600 s.
      return res.json({ ok: true, duration, assetId: assetId || null });
    } catch (error) {
      return res.status(500).json({ error: error && error.message ? error.message : String(error) });
    } finally {
      if (cleanup) {
        try {
          await cleanup();
        } catch (_err) {
          // Best-effort temp cleanup; never fail validation on cleanup error.
        }
      }
    }
  };
}

/* ============================================================================
 * Production wiring — mirrors server.js's R2/Worker upload and ffprobe usage.
 * Provided here so the endpoints can be mounted with real side effects, but
 * musicRoutes is intentionally NOT registered into server.js yet (per task).
 * ==========================================================================*/

/**
 * Build a presign function that points the browser at the Cloudflare Worker
 * upload path, exactly like `POST /api/upload-url` does for video in server.js
 * (`https://upload.wastatusvideo.com/upload/${key}`).
 *
 * @param {Object} [args]
 * @param {string} [args.workerBaseUrl] - Worker upload base
 *   (defaults to `https://upload.wastatusvideo.com/upload`).
 * @returns {(args: { key: string }) => string}
 */
function makeWorkerPresign({ workerBaseUrl } = {}) {
  const base = (typeof workerBaseUrl === 'string' && workerBaseUrl.trim() !== ''
    ? workerBaseUrl
    : 'https://upload.wastatusvideo.com/upload').replace(/\/+$/, '');
  return ({ key }) => `${base}/${key}`;
}

/**
 * Build an ffprobe-backed duration probe mirroring `getVideoDuration` in
 * server.js (30 s timeout, reads `metadata.format.duration`).
 *
 * @param {Object} args
 * @param {Object} args.ffmpeg - The `fluent-ffmpeg` module (already configured
 *   with ffprobe path in server.js).
 * @param {number} [args.timeoutMs] - Probe timeout (defaults to 30000).
 * @returns {(filePath: string) => Promise<number>}
 */
function makeFfprobeDurationProbe({ ffmpeg, timeoutMs = 30000 } = {}) {
  if (!ffmpeg || typeof ffmpeg.ffprobe !== 'function') {
    throw new Error('makeFfprobeDurationProbe requires the fluent-ffmpeg module');
  }
  return function probeDuration(filePath) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error('ffprobe timeout after 30s'));
      }, timeoutMs);
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) return reject(err);
        resolve(metadata && metadata.format ? metadata.format.duration : NaN);
      });
    });
  };
}

/**
 * Build a `loadAudio` function that downloads an uploaded Music_Track from R2
 * (via `R2_PUBLIC_URL`) to a local temp file for probing, reporting the file's
 * authoritative size, and exposing a `cleanup` that removes the temp file. This
 * mirrors how `/api/process` streams inputs down from R2 in server.js.
 *
 * @param {Object} args
 * @param {Object} args.axios - The `axios` module (streaming GET).
 * @param {Object} args.fs - The `fs` module (createWriteStream/statSync/promises).
 * @param {Object} args.path - The `path` module.
 * @param {() => string} args.uuid - Unique id generator for temp filenames.
 * @param {string} [args.publicBaseUrl] - R2 public base (defaults to `R2_PUBLIC_URL` env).
 * @param {string} [args.tmpDir] - Temp directory (defaults to `uploads`).
 * @param {number} [args.timeoutMs] - Download timeout (defaults to 300000).
 * @returns {(args: { key?: string, assetId?: string }) => Promise<{ localPath: string, sizeBytes: number, cleanup: Function }>}
 */
function makeR2AudioLoader({ axios, fs, path, uuid, publicBaseUrl, tmpDir = 'uploads', timeoutMs = 300000 } = {}) {
  if (!axios || typeof axios.get !== 'function') {
    throw new Error('makeR2AudioLoader requires the axios module');
  }
  if (!fs || typeof fs.createWriteStream !== 'function') {
    throw new Error('makeR2AudioLoader requires the fs module');
  }
  if (!path || typeof path.join !== 'function') {
    throw new Error('makeR2AudioLoader requires the path module');
  }
  const genId = typeof uuid === 'function' ? uuid : () => crypto.randomUUID();

  return async function loadAudio({ key, assetId }) {
    const base = (typeof publicBaseUrl === 'string' && publicBaseUrl.trim() !== ''
      ? publicBaseUrl
      : process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
    const objectKey = key || `music/${assetId}`;
    const inputUrl = `${base}/${objectKey}`;
    const ext = extOf(objectKey) || '.audio';
    const localPath = path.join(tmpDir, `music_${genId()}${ext}`);

    // A just-uploaded object can briefly 404 through the public/CDN URL, so
    // retry the download a few times before giving up.
    const maxTries = 4;
    let lastErr = null;
    for (let attempt = 0; attempt < maxTries; attempt++) {
      try {
        const response = await axios.get(inputUrl, { responseType: 'stream', timeout: timeoutMs });
        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(localPath);
          response.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
          response.data.on('error', reject);
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const status = err && err.response && err.response.status;
        console.warn(`🎵 loadAudio attempt ${attempt + 1}/${maxTries} failed for ${inputUrl}${status ? ` (HTTP ${status})` : ''}: ${err && err.message}`);
        if (attempt < maxTries - 1) {
          await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        }
      }
    }
    if (lastErr) throw lastErr;

    let sizeBytes = NaN;
    try {
      sizeBytes = fs.statSync(localPath).size;
    } catch (_err) {
      sizeBytes = NaN;
    }

    return {
      localPath,
      sizeBytes,
      cleanup: async () => {
        try {
          if (fs.promises && typeof fs.promises.rm === 'function') {
            await fs.promises.rm(localPath, { force: true });
          } else if (typeof fs.unlinkSync === 'function') {
            fs.unlinkSync(localPath);
          }
        } catch (_err) {
          // already gone / best-effort
        }
      },
    };
  };
}

/**
 * Build the production music upload-url and validate handlers from the real
 * R2/Worker/ffprobe side effects, ready to mount on a router.
 *
 * @param {Object} args
 * @param {Object} args.ffmpeg - The `fluent-ffmpeg` module.
 * @param {Object} args.axios - The `axios` module.
 * @param {Object} args.fs - The `fs` module.
 * @param {Object} args.path - The `path` module.
 * @param {() => string} [args.uuid] - Unique id generator.
 * @param {string} [args.workerBaseUrl] - Worker upload base URL.
 * @param {string} [args.publicBaseUrl] - R2 public base URL.
 * @returns {{ uploadUrl: Function, validate: Function }}
 */
function makeProductionMusicHandlers({ ffmpeg, axios, fs, path, uuid, workerBaseUrl, publicBaseUrl } = {}) {
  const presign = makeWorkerPresign({ workerBaseUrl });
  const probeDuration = makeFfprobeDurationProbe({ ffmpeg });
  const loadAudio = makeR2AudioLoader({ axios, fs, path, uuid, publicBaseUrl });
  return {
    uploadUrl: makeMusicUploadUrlHandler({ presign, generateAssetId: uuid }),
    validate: makeMusicValidateHandler({ loadAudio, probeDuration }),
  };
}

/**
 * Express router exposing the music/asset endpoints: the royalty-free library
 * listing plus the upload-url and validate endpoints. The upload-url/validate
 * handlers are mounted lazily with production side effects on first use so the
 * module loads without requiring R2/ffmpeg env at import time.
 * @type {express.Router}
 */
const router = express.Router();
router.get('/api/library', getLibraryHandler);

/**
 * Lazily build the production handlers once, on first request, wiring the same
 * R2/Worker/ffprobe approach server.js uses. Kept lazy so importing this module
 * (e.g. in tests) never requires the optional production dependencies.
 * @returns {{ uploadUrl: Function, validate: Function }}
 * @private
 */
let _productionHandlers = null;
function getProductionHandlers() {
  if (_productionHandlers) {
    return _productionHandlers;
  }
  /* eslint-disable global-require */
  const ffmpeg = require('fluent-ffmpeg');
  const axios = require('axios');
  const fs = require('fs');
  const path = require('path');
  const { v4: uuidv4 } = require('uuid');
  /* eslint-enable global-require */
  _productionHandlers = makeProductionMusicHandlers({ ffmpeg, axios, fs, path, uuid: uuidv4 });
  return _productionHandlers;
}

router.post('/api/music/upload-url', (req, res) => {
  const b = req.body || {};
  console.log(`🎵 /api/music/upload-url filename=${b.filename} type=${b.contentType} size=${b.fileSize}`);
  return getProductionHandlers().uploadUrl(req, res);
});
router.post('/api/music/validate', (req, res) => {
  const b = req.body || {};
  console.log(`🎵 /api/music/validate assetId=${b.assetId} key=${b.key} size=${b.size}`);
  return getProductionHandlers().validate(req, res);
});

/**
 * Mount the music routes onto an existing Express app.
 *
 * @param {express.Application} app - The Express application from server.js.
 * @returns {express.Application} the same app, for chaining.
 */
function register(app) {
  app.use(router);
  return app;
}

module.exports = {
  router,
  register,
  getLibraryHandler,
  getLibraryManifest,
  ROYALTY_FREE_LIBRARY,
  // Music upload-url / validate (Req 8.1, 8.5, 8.6, 8.7)
  ALLOWED_AUDIO_CONTENT_TYPES,
  makeMusicUploadUrlHandler,
  makeMusicValidateHandler,
  // Production wiring (R2/Worker/ffprobe), mirroring server.js
  makeWorkerPresign,
  makeFfprobeDurationProbe,
  makeR2AudioLoader,
  makeProductionMusicHandlers,
};
