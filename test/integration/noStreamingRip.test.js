'use strict';

/**
 * Smoke test: no streaming-rip / import surface (task 15.3).
 *
 * Requirement 8.4: StatusDrop SHALL NOT provide any capability to extract,
 * rip, or import audio from third-party streaming services.
 * Requirement 8.3: Music_Tracks are sourced ONLY from user-uploaded audio
 * files and the curated Royalty_Free_Library.
 *
 * This is a fast, static/smoke assertion — no network, no ffmpeg, no server
 * boot (server.js binds a port and starts Baileys, so it is deliberately NOT
 * imported). It asserts the music API surface exposes ONLY:
 *   - GET  /api/library            (curated royalty-free library)
 *   - POST /api/music/upload-url   (user-upload path)
 *   - POST /api/music/validate     (user-upload path)
 * and that nowhere in the music surface — routes, library manifest, or the
 * browser music-source tooling — is there any affordance to extract/rip/import
 * audio from a third-party streaming service.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const musicRoutes = require('../../src/server/musicRoutes.js');
const editorAudio = require('../../public/js/editorAudio.js');

/**
 * Tokens that would signal a streaming-extraction / rip / import surface.
 * Matched case-insensitively against route paths, exported names, manifest
 * URLs, and source text. None of these belong anywhere in StatusDrop's music
 * surface (Req 8.4).
 */
const STREAMING_RIP_PATTERN =
  /\b(rip|ripper|stream(?:ing)?[-_ ]?(?:rip|extract|import|download)|youtube|yt[-_ ]?dl|ytdl|youtube-dl|spotify|soundcloud|deezer|tidal|apple[-_ ]?music|napster|extract[-_ ]?audio|audio[-_ ]?extract)\b/i;

/** The only music/asset routes the surface is permitted to expose. */
const ALLOWED_ROUTES = [
  { path: '/api/library', method: 'get' },
  { path: '/api/music/upload-url', method: 'post' },
  { path: '/api/music/validate', method: 'post' },
];

/** Third-party streaming hostnames that a library URL must never point at. */
const STREAMING_HOSTS = [
  'youtube.com',
  'youtu.be',
  'spotify.com',
  'soundcloud.com',
  'deezer.com',
  'tidal.com',
  'music.apple.com',
];

/** Enumerate the router's registered routes as { path, method } pairs. */
function listRoutes(router) {
  return router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => ({
        path: layer.route.path,
        method,
      }))
    );
}

test('music router exposes ONLY the upload and library routes', () => {
  const routes = listRoutes(musicRoutes.router);

  // The set of exposed routes is exactly the allowed upload + library set.
  assert.equal(
    routes.length,
    ALLOWED_ROUTES.length,
    `unexpected number of music routes: ${JSON.stringify(routes)}`
  );
  for (const allowed of ALLOWED_ROUTES) {
    assert.ok(
      routes.some((r) => r.path === allowed.path && r.method === allowed.method),
      `missing expected route ${allowed.method.toUpperCase()} ${allowed.path}`
    );
  }
});

test('no route path suggests streaming extraction / rip / import (Req 8.4)', () => {
  const routes = listRoutes(musicRoutes.router);
  for (const { path: routePath } of routes) {
    assert.ok(
      !STREAMING_RIP_PATTERN.test(routePath),
      `route path exposes a streaming-rip surface: ${routePath}`
    );
  }
});

test('no exported music handler name suggests streaming extraction / rip / import (Req 8.4)', () => {
  for (const name of Object.keys(musicRoutes)) {
    assert.ok(
      !STREAMING_RIP_PATTERN.test(name),
      `musicRoutes export "${name}" suggests a streaming-rip surface`
    );
  }
});

test('library manifest returns only curated {id,title,artist,duration,url} tracks (Req 8.3)', () => {
  const manifest = musicRoutes.getLibraryManifest();
  assert.ok(Array.isArray(manifest) && manifest.length > 0, 'library manifest is a non-empty array');

  for (const track of manifest) {
    // Exactly the public shape — and nothing that smells like an import source.
    assert.deepEqual(
      Object.keys(track).sort(),
      ['artist', 'duration', 'id', 'title', 'url'],
      `library track has unexpected fields: ${JSON.stringify(track)}`
    );
    assert.equal(typeof track.id, 'string');
    assert.equal(typeof track.title, 'string');
    assert.equal(typeof track.artist, 'string');
    assert.equal(typeof track.duration, 'number');
    assert.equal(typeof track.url, 'string');
  }
});

test('library track URLs point at StatusDrop-hosted assets, never third-party streaming (Req 8.4)', () => {
  const manifest = musicRoutes.getLibraryManifest();
  for (const track of manifest) {
    const url = track.url.toLowerCase();
    assert.ok(
      !STREAMING_RIP_PATTERN.test(url),
      `library URL exposes a streaming-rip source: ${track.url}`
    );
    for (const host of STREAMING_HOSTS) {
      assert.ok(
        !url.includes(host),
        `library URL points at a third-party streaming host (${host}): ${track.url}`
      );
    }
    // Library audio is served from the StatusDrop-hosted `library/` prefix
    // (R2 public URL in prod, relative path in dev) — not an external service.
    assert.ok(
      url.includes('/library/'),
      `library URL is not served from the StatusDrop library prefix: ${track.url}`
    );
  }
});

test('browser music sources are ONLY upload and library — no streaming source (Req 8.3)', () => {
  const sources = editorAudio.MUSIC_SOURCES;
  assert.deepEqual(
    Object.keys(sources).sort(),
    ['LIBRARY', 'UPLOAD'],
    'MUSIC_SOURCES exposes a source beyond upload/library'
  );
  assert.deepEqual(
    Object.values(sources).sort(),
    ['library', 'upload'],
    'MUSIC_SOURCES values are not exactly upload/library'
  );

  // No exported browser symbol hints at a streaming-rip affordance.
  for (const name of Object.keys(editorAudio)) {
    assert.ok(
      !STREAMING_RIP_PATTERN.test(name),
      `editorAudio export "${name}" suggests a streaming-rip surface`
    );
  }
});

test('music source files contain no streaming-rip/import affordance (Req 8.4)', () => {
  const files = [
    path.join(__dirname, '..', '..', 'src', 'server', 'musicRoutes.js'),
    path.join(__dirname, '..', '..', 'public', 'js', 'editorAudio.js'),
  ];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    // Strip comments/strings prose where the words "rip" / "import" / "extract"
    // legitimately appear in explanatory text describing the ABSENCE of such a
    // surface. We only care about identifiers/literals that would constitute an
    // actual affordance, so scan line-by-line skipping comment lines and the
    // documented denial wording.
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip comment lines (block + line comments) — prose may describe the
      // deliberate absence of any rip/import capability.
      if (
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('//')
      ) {
        continue;
      }

      // `import` is a legitimate JS keyword and appears in benign prose; the
      // streaming pattern intentionally only matches it joined to a streaming
      // qualifier (e.g. "streaming-import"), so executable code is still scanned.
      assert.ok(
        !STREAMING_RIP_PATTERN.test(line),
        `${path.basename(file)}:${i + 1} contains a streaming-rip affordance: ${trimmed}`
      );
    }
  }
});
