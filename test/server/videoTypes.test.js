'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  extensionOf,
  isAllowedMime,
  isAllowedExtension,
  isAllowedVideoUpload,
} = require('../../src/server/videoTypes');

// ---------------------------------------------------------------------------
// The bug this guards against: a real user's valid 14MB .mkv was rejected with
// "Only video files allowed!" because the browser reported an EMPTY MIME type.
// ---------------------------------------------------------------------------

test('mkv with an EMPTY browser MIME type is accepted via the extension fallback', () => {
  assert.strictEqual(isAllowedVideoUpload('holiday.mkv', ''), true);
  assert.strictEqual(isAllowedVideoUpload('holiday.mkv', undefined), true);
  assert.strictEqual(isAllowedVideoUpload('holiday.mkv', null), true);
});

test('mkv with its proper MIME type is still accepted', () => {
  assert.strictEqual(isAllowedVideoUpload('holiday.mkv', 'video/x-matroska'), true);
});

test('the original supported formats keep working unchanged', () => {
  assert.strictEqual(isAllowedVideoUpload('a.mp4', 'video/mp4'), true);
  assert.strictEqual(isAllowedVideoUpload('a.mov', 'video/quicktime'), true);
  assert.strictEqual(isAllowedVideoUpload('a.avi', 'video/x-msvideo'), true);
  assert.strictEqual(isAllowedVideoUpload('a.3gp', 'video/3gpp'), true);
  assert.strictEqual(isAllowedVideoUpload('a.wmv', 'video/x-ms-wmv'), true);
});

test('a good MIME type is enough even when the extension is missing', () => {
  assert.strictEqual(isAllowedVideoUpload('recording', 'video/mp4'), true);
});

test('non-video uploads are still rejected', () => {
  assert.strictEqual(isAllowedVideoUpload('resume.pdf', 'application/pdf'), false);
  assert.strictEqual(isAllowedVideoUpload('photo.jpg', 'image/jpeg'), false);
  assert.strictEqual(isAllowedVideoUpload('song.mp3', 'audio/mpeg'), false);
  assert.strictEqual(isAllowedVideoUpload('notes.txt', 'text/plain'), false);
});

test('an unknown file with no MIME type is rejected (no blanket pass)', () => {
  assert.strictEqual(isAllowedVideoUpload('mystery', ''), false);
  assert.strictEqual(isAllowedVideoUpload('archive.zip', ''), false);
});

test('MIME parameters are ignored', () => {
  assert.strictEqual(isAllowedMime('video/mp4;codecs=avc1'), true);
  assert.strictEqual(isAllowedMime('VIDEO/MP4'), true);
});

test('extension matching is case-insensitive', () => {
  assert.strictEqual(isAllowedExtension('CLIP.MKV'), true);
  assert.strictEqual(isAllowedExtension('CLIP.MoV'), true);
});

test('extensionOf handles awkward names without throwing', () => {
  assert.strictEqual(extensionOf('a.b.mp4'), '.mp4');
  assert.strictEqual(extensionOf('.hidden'), '');
  assert.strictEqual(extensionOf('trailingdot.'), '');
  assert.strictEqual(extensionOf('noext'), '');
  assert.strictEqual(extensionOf(''), '');
  assert.strictEqual(extensionOf(null), '');
  assert.strictEqual(extensionOf(undefined), '');
  assert.strictEqual(extensionOf(42), '');
});

test('a dotted folder path does not fake an extension', () => {
  assert.strictEqual(extensionOf('my.videos/clip'), '');
  assert.strictEqual(extensionOf('my.videos\\clip'), '');
});

test('extension is read from the basename of a path', () => {
  assert.strictEqual(extensionOf('C:\\Users\\me\\clip.mkv'), '.mkv');
  assert.strictEqual(extensionOf('/home/me/clip.mkv'), '.mkv');
});
