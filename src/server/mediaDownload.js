'use strict';

const fs = require('fs');
const { pipeline } = require('stream/promises');
const axios = require('axios');

/**
 * Stream a remote file (an R2 clip) straight to disk instead of buffering the
 * whole body in memory, so a WhatsApp send no longer holds the full video in
 * RAM. The whole transfer (connect, headers and body) is bounded by
 * `timeoutMs`.
 *
 * `destPath` must not exist yet: it is created exclusively ('wx'), so this can
 * never overwrite or delete a file it did not create. On any failure the
 * partial file is removed and the error rethrown.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {{ timeoutMs: number, label?: string }} options
 * @returns {Promise<number>} bytes written
 */
async function downloadToFile(url, destPath, { timeoutMs, label = 'Download' } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('downloadToFile requires a positive timeoutMs.');
  }
  const handle = await fs.promises.open(destPath, 'wx');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await axios.get(url, {
      responseType: 'stream',
      signal: controller.signal,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      response.data.destroy();
      throw new Error(`${label} failed with HTTP ${response.status}`);
    }
    // The write stream owns the handle from here and closes it when done.
    await pipeline(response.data, handle.createWriteStream(), { signal: controller.signal });
    const { size } = await fs.promises.stat(destPath);
    return size;
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.unlink(destPath).catch(() => {});
    if (controller.signal.aborted) {
      const timeoutError = new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
      timeoutError.isTimeout = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { downloadToFile };
