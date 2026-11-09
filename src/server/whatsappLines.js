'use strict';

const path = require('path');

/**
 * WhatsApp delivery lines.
 *
 * Each line is one WhatsApp number linked to this server through its own
 * Baileys session (its own auth folder). Line 1 always exists and uses the
 * original variables, so a deployment without the new ones behaves exactly as
 * before:
 *
 *   line1: WHATSAPP_BUSINESS_NUMBER    BAILEYS_AUTH_DIR    (default 'baileys_auth')  RESET_BAILEYS
 *   line2: WHATSAPP_BUSINESS_NUMBER_2  BAILEYS_AUTH_DIR_2  (default '<line1 dir>_2') RESET_BAILEYS_2
 */

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @param {{ error: Function }} [logger]
 * @returns {Array<{id: string, number: string, numberEnv: string, authDir: string, resetEnv: string, reset: boolean}>}
 */
function parseLineConfigs(env = process.env, logger = console) {
  const authDir1 = env.BAILEYS_AUTH_DIR || 'baileys_auth';
  const lines = [{
    id: 'line1',
    number: digitsOnly(env.WHATSAPP_BUSINESS_NUMBER),
    numberEnv: 'WHATSAPP_BUSINESS_NUMBER',
    authDir: authDir1,
    resetEnv: 'RESET_BAILEYS',
    reset: env.RESET_BAILEYS === 'true',
  }];

  const number2 = digitsOnly(env.WHATSAPP_BUSINESS_NUMBER_2);
  if (number2) {
    const authDir2 = env.BAILEYS_AUTH_DIR_2 || `${authDir1.replace(/[\\/]+$/, '')}_2`;
    if (number2 === lines[0].number) {
      logger.error('!!! WHATSAPP_BUSINESS_NUMBER_2 is the same number as WHATSAPP_BUSINESS_NUMBER. Ignoring the second line.');
    } else if (path.resolve(authDir2) === path.resolve(authDir1)) {
      logger.error('!!! BAILEYS_AUTH_DIR_2 points at the same folder as BAILEYS_AUTH_DIR. Ignoring the second line.');
    } else {
      lines.push({
        id: 'line2',
        number: number2,
        numberEnv: 'WHATSAPP_BUSINESS_NUMBER_2',
        authDir: authDir2,
        resetEnv: 'RESET_BAILEYS_2',
        reset: env.RESET_BAILEYS_2 === 'true',
      });
    }
  }
  return lines;
}

/**
 * True when saved credentials are left over from a pairing-code attempt that
 * never completed: requestPairingCode() stores `me` and `pairingCode`, but
 * `registered` only turns true once the phone accepts the code. Baileys then
 * tries to LOG IN with that half-made identity on the next connect, WhatsApp
 * rejects it (401), and any pairing code shown on that connection is dead on
 * arrival. A linked session is `registered`, so it never matches.
 *
 * @param {{registered?: boolean, pairingCode?: string}|null|undefined} creds
 */
function isUnfinishedPairing(creds) {
  return !!creds && !creds.registered && !!creds.pairingCode;
}

/**
 * Disconnect codes after which a LINKED line must stay offline until someone
 * acts. Retrying cannot fix them, and a client that keeps knocking after
 * WhatsApp said no is what anti-abuse systems look for.
 */
const STOP_CODES = Object.freeze({
  401: 'WhatsApp logged this device out (removed from Linked devices on the phone)',
  403: 'WhatsApp refused this number (restricted, banned or under review)',
  411: 'the saved session no longer matches the account',
  // Two connections with one login: usually the old and new server
  // containers overlapping during a restart. Fighting back gets numbers banned.
  440: 'another connection is using this login',
  500: 'the saved session is broken',
});

/** Transient drops (timeouts, WhatsApp restarts) give up after this many tries in a row. */
const MAX_RECONNECT_ATTEMPTS = 12;
const FIRST_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;
/** While a number is not linked, one pairing code per minute (see server.js). */
const PAIRING_RETRY_DELAY_MS = 60 * 1000;

/**
 * What to do after a line's connection closed.
 *
 * Linked lines reconnect only after transient drops (for example 408
 * timeouts, which WhatsApp sends to idle connections), backing off 3 s, 6 s,
 * 12 s ... up to 5 minutes, and stop after MAX_RECONNECT_ATTEMPTS failures in
 * a row. A refusal (STOP_CODES) stops at once. Jitter is added by the caller.
 *
 * @param {{code?: number, linked: boolean, attempt: number, shuttingDown?: boolean}} input
 *   attempt: 1 for the first reconnect after a healthy connection
 * @returns {{reconnect: true, delayMs: number} | {reconnect: false, reason: string}}
 */
function reconnectPlan({ code, linked, attempt, shuttingDown = false }) {
  if (shuttingDown) return { reconnect: false, reason: 'the server is shutting down' };
  if (!linked) return { reconnect: true, delayMs: PAIRING_RETRY_DELAY_MS };
  if (Object.prototype.hasOwnProperty.call(STOP_CODES, code)) {
    return { reconnect: false, reason: STOP_CODES[code] };
  }
  if (attempt > MAX_RECONNECT_ATTEMPTS) {
    return { reconnect: false, reason: `it failed to reconnect ${MAX_RECONNECT_ATTEMPTS} times in a row` };
  }
  const delayMs = Math.min(MAX_RECONNECT_DELAY_MS, FIRST_RECONNECT_DELAY_MS * 2 ** (Math.max(1, attempt) - 1));
  return { reconnect: true, delayMs };
}

/**
 * Delete the CONTENTS of an auth dir (not the folder itself: on a mounted
 * volume, removing the mount point fails with EBUSY).
 *
 * @param {string} dir
 * @param {{ keep?: string[], fsImpl?: typeof import('fs') }} [options] entries to keep
 * @returns {number} entries removed
 */
function clearAuthDir(dir, { keep = [], fsImpl = require('fs') } = {}) {
  let removed = 0;
  if (!fsImpl.existsSync(dir)) return removed;
  for (const entry of fsImpl.readdirSync(dir)) {
    if (keep.includes(entry)) continue;
    fsImpl.rmSync(path.join(dir, entry), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/**
 * Choose the line a new activation code should point at: a connected line
 * with the fewest open deliveries. Ties go to the line assigned least
 * recently (`lastAssignedAt`, a counter), so an idle pair alternates.
 *
 * @param {Array<{connected: boolean, sock?: object|null, lastAssignedAt: number}>} lines
 * @param {(line: object) => number} activeCountFor open deliveries on a line
 * @returns {object|null} the chosen line, or null when none is connected
 */
function pickDeliveryLine(lines, activeCountFor) {
  let best = null;
  let bestActive = Infinity;
  for (const line of lines) {
    if (!line.connected || !line.sock) continue;
    const active = activeCountFor(line);
    if (active < bestActive || (active === bestActive && line.lastAssignedAt < best.lastAssignedAt)) {
      best = line;
      bestActive = active;
    }
  }
  return best;
}

module.exports = {
  STOP_CODES,
  MAX_RECONNECT_ATTEMPTS,
  reconnectPlan,
  parseLineConfigs,
  pickDeliveryLine,
  isUnfinishedPairing,
  clearAuthDir,
};
