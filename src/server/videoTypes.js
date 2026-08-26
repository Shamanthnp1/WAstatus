'use strict';

/**
 * Upload type gate for the video picker.
 *
 * Why this exists: the browser's `File.type` (the MIME type we receive as
 * `contentType`) is NOT reliable. It is derived from OS-level registrations, so
 * for containers like Matroska it is frequently an EMPTY STRING — Chrome has a
 * long-standing inconsistency with `.mkv` / `video/x-matroska`, and MDN warns
 * against using `File.type` as a sole validation scheme.
 *
 * A real user hit exactly this: a valid 14MB `.mkv` was rejected with
 * "Only video files allowed!" because `contentType` arrived as "".
 *
 * So we accept an upload when EITHER the MIME type is a known video type OR the
 * filename extension is a known video container. Being permissive here is safe:
 * every upload is re-encoded by ffmpeg downstream, and anything ffmpeg cannot
 * decode fails later with a clear error instead of a misleading "not a video".
 */

// Known-good MIME types (kept as the primary signal when the browser sends one).
const ALLOWED_MIME = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/3gpp',
  'video/3gpp2',
  'video/x-ms-wmv',
  'video/webm',
  'video/x-m4v',
  'video/mpeg',
  'video/x-flv',
];

// Extension fallback for when the MIME type is empty or unrecognized.
const ALLOWED_EXT = [
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.3gp',
  '.3g2',
  '.wmv',
  '.webm',
  '.m4v',
  '.mpeg',
  '.mpg',
  '.flv',
  '.ts',
  '.m2ts',
  '.mts',
];

/**
 * Extract a lowercase extension (including the dot) from a filename.
 * Returns '' when there is no usable extension.
 *
 * @param {string} filename
 * @returns {string}
 */
function extensionOf(filename) {
  if (typeof filename !== 'string') return '';
  // Strip any query/fragment a client may have appended, then take the last dot
  // segment of the basename only (so "my.folder/clip" isn't treated as ".folder/clip").
  const clean = filename.split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot).toLowerCase();
}

/**
 * True when the MIME type is a recognized video type.
 *
 * @param {string} contentType
 * @returns {boolean}
 */
function isAllowedMime(contentType) {
  if (typeof contentType !== 'string' || !contentType) return false;
  // Ignore any parameters, e.g. "video/mp4;codecs=avc1".
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return ALLOWED_MIME.indexOf(mime) !== -1;
}

/**
 * True when the filename extension is a recognized video container.
 *
 * @param {string} filename
 * @returns {boolean}
 */
function isAllowedExtension(filename) {
  return ALLOWED_EXT.indexOf(extensionOf(filename)) !== -1;
}

/**
 * The upload gate: accept if EITHER signal says "video".
 *
 * @param {string} filename    original file name from the client
 * @param {string} contentType browser-reported MIME type (may be '')
 * @returns {boolean}
 */
function isAllowedVideoUpload(filename, contentType) {
  return isAllowedMime(contentType) || isAllowedExtension(filename);
}

module.exports = {
  ALLOWED_MIME,
  ALLOWED_EXT,
  extensionOf,
  isAllowedMime,
  isAllowedExtension,
  isAllowedVideoUpload,
};

/** Hard cap on a single upload (matches the client-side limit). */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

/**
 * Validate an /api/upload-url request body.
 *
 * Kept as one pure function on purpose. The original inline version checked
 * `!contentType` BEFORE the video-type check, so an empty MIME type (exactly
 * what browsers send for .mkv) was rejected as "Missing required fields" and the
 * extension fallback below never ran. Ordering bugs like that are invisible in
 * review but obvious in a test, so the whole gate lives here.
 *
 * @param {{filename?: string, contentType?: string, fileSize?: any}} body
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
function validateUploadRequest(body) {
  const { filename, contentType, fileSize } = body || {};
  const numericFileSize = Number(fileSize);

  // contentType is deliberately NOT required — it is frequently empty.
  if (!filename || !Number.isFinite(numericFileSize)) {
    return { ok: false, status: 400, error: 'Missing required fields' };
  }
  if (numericFileSize > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 400, error: 'File too large! Max 300MB.' };
  }
  if (!isAllowedVideoUpload(filename, contentType)) {
    return {
      ok: false,
      status: 400,
      error: 'That file does not look like a video. Supported: MP4, MOV, AVI, MKV, WMV, 3GP, WEBM.',
    };
  }
  return { ok: true };
}

module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
module.exports.validateUploadRequest = validateUploadRequest;
