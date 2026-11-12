'use strict';

const fs = require('fs');
const path = require('path');

/**
 * WhatsApp handover lease.
 *
 * During a restart or deploy, Azure App Service starts the new container while
 * the old one is still running, and stops the old one only after the new one
 * answers HTTP (30-46 s in practice). Two containers connected with the same
 * WhatsApp login knock each other off (440) and then get refused (403), which
 * is how both numbers were lost on 9 Nov 2026.
 *
 * Both containers share /home, so the one that owns the WhatsApp lines keeps a
 * small lease file there and refreshes it every few seconds. A starting
 * container connects only when the lease is free:
 *   - no lease file (first start, or the owner deleted it while shutting down)
 *   - a lease older than LEASE_STALE_MS (the owner crashed or was killed)
 *   - a lease it wrote itself
 * The owner deletes the lease as soon as it has hung up on SIGTERM, so the new
 * container connects within about a second of that instead of after a fixed wait.
 */

const LEASE_HEARTBEAT_MS = 5_000;
// Several missed heartbeats in a row. Long enough to ride out a slow write on
// the shared /home volume, short enough that a crashed owner frees it quickly.
const LEASE_STALE_MS = 20_000;
const LEASE_POLL_MS = 1_000;

/**
 * Decide whether `selfId` may take the WhatsApp lines.
 *
 * @param {{owner?: string, heartbeatAt?: number}|null} lease current file contents, or null when absent
 * @param {string} selfId this process's owner id
 * @param {number} now Date.now()
 * @param {number} [staleMs]
 * @returns {{take: boolean, reason: string}}
 */
function leaseDecision(lease, selfId, now, staleMs = LEASE_STALE_MS) {
  if (!lease || !lease.owner) return { take: true, reason: 'no other container holds the lines' };
  if (lease.owner === selfId) return { take: true, reason: 'this container already holds the lines' };
  const age = now - Number(lease.heartbeatAt || 0);
  if (!(age < staleMs)) return { take: true, reason: `the previous holder stopped refreshing ${Math.round(age / 1000)}s ago` };
  return { take: false, reason: `held by ${lease.owner}, refreshed ${Math.max(0, Math.round(age / 1000))}s ago` };
}

/**
 * Read the lease. Returns null when there is none. A file that exists but can't
 * be parsed (caught mid-write) falls back to its modification time, so a
 * half-written lease is never mistaken for a free one.
 */
function readLease(file, fsImpl = fs) {
  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const lease = JSON.parse(text);
    if (lease && typeof lease.owner === 'string') return lease;
  } catch (_) { /* fall through */ }
  const stat = fsImpl.statSync(file);
  return { owner: 'unreadable lease file', heartbeatAt: stat.mtimeMs };
}

/** Write the lease for `owner` (temp file + rename, so readers never see half a file). */
function writeLease(file, owner, fsImpl = fs, now = Date.now()) {
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(tmp, JSON.stringify({ owner, heartbeatAt: now }));
  fsImpl.renameSync(tmp, file);
}

/** Delete the lease, but only if `owner` still holds it. */
function releaseLease(file, owner, fsImpl = fs) {
  try {
    const lease = readLease(file, fsImpl);
    if (lease && lease.owner === owner) fsImpl.unlinkSync(file);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Wait until this process holds the lease, then keep it fresh.
 *
 * @param {object} options
 * @param {string} options.file lease file path (on storage shared by all containers)
 * @param {string} options.owner this process's id
 * @param {(message: string) => void} [options.log]
 * @param {() => boolean} [options.cancelled] stop waiting (for example on SIGTERM)
 * @param {() => void} [options.onLost] called once if another container takes the lease
 * @returns {Promise<{stop: () => void} | null>} null when cancelled before acquiring
 */
async function acquireLease({ file, owner, log = () => {}, cancelled = () => false, onLost = () => {}, fsImpl = fs, timers = { setTimeout, setInterval, clearInterval } }) {
  const sleep = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));
  const startedAt = Date.now();
  let lastWaitLogAt = 0;
  for (;;) {
    if (cancelled()) return null;
    let decision;
    try {
      decision = leaseDecision(readLease(file, fsImpl), owner, Date.now());
    } catch (error) {
      decision = { take: false, reason: `could not read the lease (${error.message})` };
    }
    if (decision.take) {
      try {
        writeLease(file, owner, fsImpl);
        // Re-read after a beat: if another starting container wrote at the same
        // moment, only one of us sees its own id and goes ahead.
        await sleep(300);
        const check = readLease(file, fsImpl);
        if (check && check.owner === owner) {
          log(`WhatsApp lease acquired after ${Math.round((Date.now() - startedAt) / 1000)}s: ${decision.reason}.`);
          break;
        }
      } catch (error) {
        log(`Could not write the WhatsApp lease (${error.message}); retrying.`);
      }
    } else if (Date.now() - lastWaitLogAt >= 10_000) {
      log(`Waiting to connect WhatsApp: the lines are ${decision.reason}.`);
      lastWaitLogAt = Date.now();
    }
    await sleep(LEASE_POLL_MS);
  }

  let lost = false;
  const heartbeat = timers.setInterval(() => {
    try {
      const lease = readLease(file, fsImpl);
      if (lease && lease.owner !== owner && lease.owner !== 'unreadable lease file') {
        if (!lost) {
          lost = true;
          timers.clearInterval(heartbeat);
          onLost(lease.owner);
        }
        return;
      }
      writeLease(file, owner, fsImpl);
    } catch (_) {
      // A missed heartbeat is fine; LEASE_STALE_MS allows for several.
    }
  }, LEASE_HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    stop() {
      timers.clearInterval(heartbeat);
      releaseLease(file, owner, fsImpl);
    },
  };
}

module.exports = {
  LEASE_HEARTBEAT_MS,
  LEASE_STALE_MS,
  leaseDecision,
  readLease,
  writeLease,
  releaseLease,
  acquireLease,
};
