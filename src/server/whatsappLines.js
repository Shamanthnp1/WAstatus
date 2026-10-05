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
  parseLineConfigs,
  pickDeliveryLine,
};
