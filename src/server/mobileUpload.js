'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const MAX_MOBILE_CLIPS = 20;
const MAX_CLIP_BYTES = 15_800_000;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const UPLOAD_IDLE_TTL_MS = 10 * 60 * 1000;
const UPLOAD_ABSOLUTE_TTL_MS = 60 * 60 * 1000;
const CLIP_UPLOAD_TIMEOUT_MS = 6 * 60 * 1000;
const FINALIZED_TOMBSTONE_MS = 10 * 60 * 1000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PROFILES = Object.freeze({
  hd29: Object.freeze({ width: 1080, height: 1920, maxDuration: 29 }),
  long59: Object.freeze({ width: 720, height: 1280, maxDuration: 59 }),
});

class MobileUploadError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'MobileUploadError';
    this.status = status;
  }
}

function validateMobileManifest(body) {
  if (!body || typeof body !== 'object') {
    throw new MobileUploadError(400, 'A JSON upload manifest is required.');
  }
  const profile = PROFILES[body.profile];
  if (!profile) {
    throw new MobileUploadError(400, 'Unknown mobile quality profile.');
  }
  if (!Array.isArray(body.clips) || body.clips.length === 0) {
    throw new MobileUploadError(400, 'At least one processed clip is required.');
  }
  if (body.clips.length > MAX_MOBILE_CLIPS) {
    throw new MobileUploadError(413, `A mobile delivery can contain at most ${MAX_MOBILE_CLIPS} clips.`);
  }

  let totalBytes = 0;
  const clips = body.clips.map((raw, index) => {
    const expectedOrder = index + 1;
    if (!raw || typeof raw !== 'object' || raw.order !== expectedOrder) {
      throw new MobileUploadError(400, `Clip orders must be consecutive from 1; expected ${expectedOrder}.`);
    }
    if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 128 ||
        path.basename(raw.name) !== raw.name || !/^[A-Za-z0-9._ -]+\.mp4$/i.test(raw.name)) {
      throw new MobileUploadError(400, `Clip ${expectedOrder} has an invalid MP4 filename.`);
    }
    if (!Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes < 1 || raw.sizeBytes > MAX_CLIP_BYTES) {
      throw new MobileUploadError(413, `Clip ${expectedOrder} must be between 1 byte and 15.8 MB.`);
    }
    totalBytes += raw.sizeBytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new MobileUploadError(413, 'Processed clips exceed the 300 MB total limit.');
    }
    if (!Number.isFinite(raw.durationSeconds) || raw.durationSeconds <= 0 ||
        raw.durationSeconds > profile.maxDuration + 0.75) {
      throw new MobileUploadError(
        400,
        `Clip ${expectedOrder} exceeds the ${profile.maxDuration}-second profile limit.`,
      );
    }
    if (typeof raw.sha256 !== 'string' || !HASH_PATTERN.test(raw.sha256)) {
      throw new MobileUploadError(400, `Clip ${expectedOrder} has an invalid SHA-256 digest.`);
    }
    return Object.freeze({
      order: expectedOrder,
      name: raw.name,
      sizeBytes: raw.sizeBytes,
      durationSeconds: raw.durationSeconds,
      sha256: raw.sha256,
    });
  });

  return Object.freeze({
    profileId: body.profile,
    profile,
    clips: Object.freeze(clips),
    totalBytes,
  });
}

function parseFrameRate(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !value) return NaN;
  const [numerator, denominator = '1'] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return NaN;
  return numerator / denominator;
}

function validateMobileProbe(metadata, manifestClip, profile) {
  const formatName = String(metadata?.format?.format_name || '');
  if (!formatName.split(',').some((name) => name === 'mp4' || name === 'mov')) {
    throw new MobileUploadError(422, `Clip ${manifestClip.order} is not an MP4 video.`);
  }

  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const audios = streams.filter((stream) => stream.codec_type === 'audio');
  const otherStreams = streams.filter((stream) => !['video', 'audio'].includes(stream.codec_type));
  if (videos.length !== 1 || audios.length > 1 || otherStreams.length > 0) {
    throw new MobileUploadError(422, `Clip ${manifestClip.order} has unsupported media streams.`);
  }

  const video = videos[0];
  const frameRate = parseFrameRate(video.avg_frame_rate || video.r_frame_rate);
  if (video.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p' ||
      Number(video.width) !== profile.width || Number(video.height) !== profile.height ||
      !Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 30.1) {
    throw new MobileUploadError(422, `Clip ${manifestClip.order} does not match the selected H.264 profile.`);
  }

  if (audios.length === 1) {
    const audio = audios[0];
    if (audio.codec_name !== 'aac' || Number(audio.channels || 0) < 1 || Number(audio.channels) > 2 ||
        Number(audio.sample_rate || 0) < 1 || Number(audio.sample_rate) > 48000) {
      throw new MobileUploadError(422, `Clip ${manifestClip.order} has unsupported audio.`);
    }
  }

  const duration = Number(metadata?.format?.duration || video.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > profile.maxDuration + 0.75 ||
      Math.abs(duration - manifestClip.durationSeconds) > 1.0) {
    throw new MobileUploadError(422, `Clip ${manifestClip.order} has an unexpected duration.`);
  }
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token).digest();
}

function hasValidToken(session, authorization) {
  const match = typeof authorization === 'string' && authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const supplied = tokenDigest(match[1]);
  return supplied.length === session.tokenDigest.length &&
    crypto.timingSafeEqual(supplied, session.tokenDigest);
}

class MobileUploadStore {
  constructor({ deleteFromR2, logger = console }) {
    this.sessions = new Map();
    this.deleteFromR2 = deleteFromR2;
    this.logger = logger;
  }

  create(manifest) {
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    const session = {
      id,
      tokenDigest: tokenDigest(token),
      manifest,
      createdAt,
      expiresAt: createdAt + UPLOAD_IDLE_TTL_MS,
      absoluteExpiresAt: createdAt + UPLOAD_ABSOLUTE_TTL_MS,
      state: 'uploading',
      slots: manifest.clips.map((clip) => ({ manifest: clip, status: 'pending', key: null, url: null })),
      result: null,
      timer: null,
      inFlight: 0,
    };
    this.sessions.set(id, session);
    this.scheduleExpiry(session);
    return { session, token };
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  scheduleExpiry(session) {
    if (session.timer) clearTimeout(session.timer);
    const delay = Math.max(1, session.expiresAt - Date.now());
    session.timer = setTimeout(() => this.expire(session.id), delay);
    session.timer.unref?.();
  }

  touch(session) {
    const now = Date.now();
    if (now >= session.absoluteExpiresAt || session.state === 'finalized') return false;
    session.expiresAt = Math.min(
      session.absoluteExpiresAt,
      now + UPLOAD_IDLE_TTL_MS,
    );
    this.scheduleExpiry(session);
    return true;
  }

  async expire(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.state === 'finalized') return;
    if (Date.now() < session.expiresAt) {
      this.scheduleExpiry(session);
      return;
    }
    // Active request phases are independently bounded (stream, probe, and R2).
    // Let their finally blocks release ownership rather than deleting underneath.
    if (session.inFlight > 0) {
      session.timer = setTimeout(() => this.expire(id), 30_000);
      session.timer.unref?.();
      return;
    }
    this.sessions.delete(id);
    if (session.timer) clearTimeout(session.timer);
    const keys = session.slots.map((slot) => slot.key).filter(Boolean);
    await Promise.all(keys.map(async (key) => {
      try {
        await this.deleteFromR2(key);
      } catch (error) {
        this.logger.error(`Mobile upload cleanup failed for ${key}: ${error.message}`);
      }
    }));
  }

  markFinalized(session, result) {
    session.state = 'finalized';
    session.result = Object.freeze({ ...result });
    session.slots.forEach((slot) => { slot.ownedByDelivery = true; });
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      this.sessions.delete(session.id);
    }, FINALIZED_TOMBSTONE_MS);
    session.timer.unref?.();
  }
}

function mobileErrorResponse(res, error, logger = console) {
  const status = error instanceof MobileUploadError ? error.status : 500;
  if (status >= 500) logger.error('Mobile upload error:', error);
  return res.status(status).json({
    error: status >= 500 ? 'Mobile upload failed. Please try again.' : error.message,
  });
}

function requireAuthorizedSession(store, req) {
  const session = store.get(req.params.sessionId);
  if (!session) throw new MobileUploadError(404, 'Mobile upload session was not found or has expired.');
  if (!hasValidToken(session, req.get('authorization'))) {
    throw new MobileUploadError(401, 'Invalid mobile upload capability.');
  }
  if (session.state !== 'finalized' &&
      (Date.now() >= session.expiresAt || Date.now() >= session.absoluteExpiresAt)) {
    store.expire(session.id).catch(() => {});
    throw new MobileUploadError(410, 'Mobile upload session has expired.');
  }
  return session;
}

function registerMobileUploadRoutes(app, {
  limiter,
  uploadDir,
  uploadToR2,
  deleteFromR2,
  probeClip,
  createDeliverySession,
  logger = console,
}) {
  const store = new MobileUploadStore({ deleteFromR2, logger });

  app.post('/api/mobile/sessions', limiter, (req, res) => {
    try {
      const manifest = validateMobileManifest(req.body);
      const { session, token } = store.create(manifest);
      const origin = `${req.protocol}://${req.get('host')}`;
      return res.status(201).json({
        sessionId: session.id,
        uploadToken: token,
        uploadExpiresAt: new Date(session.expiresAt).toISOString(),
        uploadAbsoluteExpiresAt: new Date(session.absoluteExpiresAt).toISOString(),
        uploads: session.slots.map((slot) => ({
          order: slot.manifest.order,
          method: 'PUT',
          url: `${origin}/api/mobile/sessions/${encodeURIComponent(session.id)}/clips/${slot.manifest.order}`,
          headers: { 'Content-Type': 'video/mp4' },
        })),
      });
    } catch (error) {
      return mobileErrorResponse(res, error, logger);
    }
  });

  app.put('/api/mobile/sessions/:sessionId/clips/:order', async (req, res) => {
    let session;
    let slot;
    let tempPath;
    let sealedKey;
    let countedInFlight = false;
    try {
      session = requireAuthorizedSession(store, req);
      if (session.state !== 'uploading') {
        throw new MobileUploadError(409, 'This mobile upload is no longer accepting clips.');
      }
      const order = Number(req.params.order);
      slot = session.slots[order - 1];
      if (!Number.isSafeInteger(order) || !slot || slot.manifest.order !== order) {
        throw new MobileUploadError(404, 'Unknown mobile clip slot.');
      }
      if (slot.status === 'uploaded') {
        req.resume();
        return res.json({ success: true, order, sizeBytes: slot.manifest.sizeBytes });
      }
      if (slot.status === 'receiving') {
        throw new MobileUploadError(409, 'This clip is already uploading.');
      }

      const contentType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const contentLength = Number(req.get('content-length'));
      if (contentType !== 'video/mp4') {
        throw new MobileUploadError(415, 'Mobile clips must use video/mp4.');
      }
      if (!Number.isSafeInteger(contentLength) || contentLength !== slot.manifest.sizeBytes) {
        throw new MobileUploadError(400, 'Clip Content-Length does not match the manifest.');
      }

      if (!store.touch(session)) {
        throw new MobileUploadError(410, 'Mobile upload session has expired.');
      }
      slot.status = 'receiving';
      session.inFlight += 1;
      countedInFlight = true;
      await fs.promises.mkdir(uploadDir, { recursive: true });
      tempPath = path.join(uploadDir, `mobile_${crypto.randomUUID()}.mp4`);
      const hash = crypto.createHash('sha256');
      let received = 0;
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          if (received > slot.manifest.sizeBytes || received > MAX_CLIP_BYTES) {
            return callback(new MobileUploadError(413, 'Uploaded clip exceeds its declared size.'));
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const abortController = new AbortController();
      const uploadTimer = setTimeout(() => abortController.abort(), CLIP_UPLOAD_TIMEOUT_MS);
      uploadTimer.unref?.();
      try {
        await pipeline(
          req,
          meter,
          fs.createWriteStream(tempPath, { flags: 'wx' }),
          { signal: abortController.signal },
        );
      } catch (error) {
        if (abortController.signal.aborted) {
          throw new MobileUploadError(408, 'Clip upload timed out.');
        }
        throw error;
      } finally {
        clearTimeout(uploadTimer);
      }
      if (received !== slot.manifest.sizeBytes) {
        throw new MobileUploadError(400, 'Uploaded clip ended before its declared size.');
      }
      if (!store.touch(session)) {
        throw new MobileUploadError(410, 'Mobile upload session expired while receiving the clip.');
      }
      const actualDigest = Buffer.from(hash.digest('hex'), 'hex');
      const expectedDigest = Buffer.from(slot.manifest.sha256, 'hex');
      if (actualDigest.length !== expectedDigest.length || !crypto.timingSafeEqual(actualDigest, expectedDigest)) {
        throw new MobileUploadError(422, `Clip ${order} failed its integrity check.`);
      }

      const metadata = await probeClip(tempPath);
      validateMobileProbe(metadata, slot.manifest, session.manifest.profile);
      sealedKey = `mobile-sealed/${session.id}/${crypto.randomBytes(12).toString('hex')}_${order}.mp4`;
      const url = await uploadToR2(tempPath, sealedKey);
      if (store.get(session.id) !== session || !store.touch(session)) {
        await deleteFromR2(sealedKey).catch(() => {});
        sealedKey = null;
        throw new MobileUploadError(410, 'Mobile upload session expired while receiving the clip.');
      }

      slot.key = sealedKey;
      slot.url = url;
      slot.status = 'uploaded';
      sealedKey = null;
      return res.status(201).json({
        success: true,
        order,
        sizeBytes: received,
        uploadExpiresAt: new Date(session.expiresAt).toISOString(),
      });
    } catch (error) {
      if (slot && slot.status === 'receiving') slot.status = 'pending';
      if (sealedKey) await deleteFromR2(sealedKey).catch(() => {});
      return mobileErrorResponse(res, error, logger);
    } finally {
      if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
      if (countedInFlight && session && session.inFlight > 0) session.inFlight -= 1;
      if (session &&
          (Date.now() >= session.expiresAt || Date.now() >= session.absoluteExpiresAt) &&
          session.state !== 'finalized') {
        store.expire(session.id).catch(() => {});
      }
    }
  });

  app.post('/api/mobile/sessions/:sessionId/finalize', limiter, async (req, res) => {
    let session;
    let countedInFlight = false;
    try {
      session = requireAuthorizedSession(store, req);
      if (session.state === 'finalized') return res.json(session.result);
      if (session.state !== 'uploading') {
        throw new MobileUploadError(409, 'This mobile upload cannot be finalized right now.');
      }
      if (session.slots.some((slot) => slot.status !== 'uploaded' || !slot.key || !slot.url)) {
        throw new MobileUploadError(409, 'Upload every clip before finalizing.');
      }

      session.state = 'finalizing';
      session.inFlight += 1;
      countedInFlight = true;
      const files = session.slots.map((slot) => ({ fileName: slot.key, url: slot.url }));
      const delivery = await createDeliverySession(files, '');
      const result = {
        success: true,
        activationCode: delivery.activationCode,
        whatsAppUrl: delivery.waLink,
        fileCount: delivery.fileCount,
        expiresAt: delivery.expiresAt,
      };
      store.markFinalized(session, result);
      return res.json(result);
    } catch (error) {
      if (session && session.state === 'finalizing') session.state = 'uploading';
      return mobileErrorResponse(res, error, logger);
    } finally {
      if (countedInFlight && session && session.inFlight > 0) session.inFlight -= 1;
    }
  });

  return store;
}

module.exports = {
  MAX_MOBILE_CLIPS,
  MAX_CLIP_BYTES,
  MAX_TOTAL_BYTES,
  PROFILES,
  MobileUploadError,
  MobileUploadStore,
  validateMobileManifest,
  validateMobileProbe,
  registerMobileUploadRoutes,
};
