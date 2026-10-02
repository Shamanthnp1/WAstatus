'use strict';

/**
 * Web service retirement guard.
 *
 * The website compressor has been retired in favour of the StatusDrop Android
 * app, which compresses videos on the phone. The server now exists only to
 * receive the app's finished clips (/api/mobile/*), deliver them through
 * Baileys, and answer /api/health.
 *
 * The web-only routes below stay registered but answer 410 Gone, so a cached
 * copy of the old website shows a clear message (it renders `error` from the
 * JSON body) instead of starting a server-side upload or encode.
 *
 * Mount this BEFORE the music routes and the web upload/process routes so it
 * takes precedence over them.
 */

const WEB_SERVICE_RETIRED_MESSAGE =
  'The StatusDrop website compressor has been retired. Please use the StatusDrop Android app — get it at https://wastatusvideo.com';

/**
 * Path prefixes served only by the retired website. Express matches each at a
 * path-segment boundary, so '/api/job' covers '/api/job/:jobId' and
 * '/api/music' covers '/api/music/upload-url' and '/api/music/validate',
 * while '/api/mobile/*' and '/api/health' are untouched.
 */
const RETIRED_WEB_ROUTES = Object.freeze([
  '/api/upload-url',
  '/api/process',
  '/api/job',
  '/api/library',
  '/api/music',
]);

/**
 * @param {import('express').Express} app
 */
function registerWebRetirement(app) {
  app.use([...RETIRED_WEB_ROUTES], (req, res) => {
    res.status(410).json({ error: WEB_SERVICE_RETIRED_MESSAGE });
  });
}

module.exports = {
  WEB_SERVICE_RETIRED_MESSAGE,
  RETIRED_WEB_ROUTES,
  registerWebRetirement,
};
