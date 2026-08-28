'use strict';

const crypto = require('crypto');

/**
 * Meta (WhatsApp Cloud API) webhook helpers.
 *
 * Meta's "Configure Webhooks" step requires a public HTTPS endpoint that does
 * two things:
 *   GET  -> echo back `hub.challenge` when `hub.verify_token` matches ours.
 *   POST -> accept event payloads and answer 200 quickly, or Meta retries.
 *
 * This module holds only the pure decision logic so it can be unit-tested; the
 * Express wiring lives in server.js.
 *
 * IMPORTANT: the webhook is RECEIVE-ONLY. Message delivery continues to run
 * through Baileys, which is what preserves HD quality. Nothing here triggers a
 * send, so an attacker posting junk to the endpoint cannot cause a delivery.
 */

/**
 * Constant-time string comparison that never throws on length mismatch.
 * Used so a wrong verify token can't be discovered by timing the response.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (_) {
    return false;
  }
}

/**
 * Decide how to answer Meta's GET verification handshake.
 *
 * @param {{mode?: string, token?: string, challenge?: string}} query
 * @param {string} expectedToken value of WEBHOOK_VERIFY_TOKEN
 * @returns {{ok: true, challenge: string} | {ok: false, status: number, reason: string}}
 */
function verifyChallenge(query, expectedToken) {
  const { mode, token, challenge } = query || {};

  // Refuse rather than accept-by-default when the server has no token set,
  // otherwise anyone could complete the handshake against our endpoint.
  if (!expectedToken) {
    return { ok: false, status: 500, reason: 'WEBHOOK_VERIFY_TOKEN is not configured' };
  }
  if (mode !== 'subscribe') {
    return { ok: false, status: 400, reason: 'unexpected hub.mode' };
  }
  if (!safeEqual(String(token || ''), expectedToken)) {
    return { ok: false, status: 403, reason: 'verify token mismatch' };
  }
  if (typeof challenge !== 'string' || !challenge) {
    return { ok: false, status: 400, reason: 'missing hub.challenge' };
  }
  return { ok: true, challenge };
}

/**
 * Validate Meta's X-Hub-Signature-256 header against the raw request body.
 * Only meaningful when an app secret is configured; callers treat "no secret"
 * as "skip verification" so the endpoint still works before it's set up.
 *
 * @param {Buffer|string} rawBody exact bytes Meta sent
 * @param {string} header value of the X-Hub-Signature-256 header
 * @param {string} appSecret Meta app secret
 * @returns {boolean}
 */
function isValidSignature(rawBody, header, appSecret) {
  if (!appSecret) return true; // not configured -> nothing to check
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  if (rawBody == null) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(body).digest('hex');
  return safeEqual(header, expected);
}

/**
 * Build a short, log-friendly summary of a webhook payload. Deliberately does
 * NOT log message text or full phone numbers — those are user data.
 *
 * @param {Object} body parsed webhook JSON
 * @returns {string}
 */
function summarizeEvent(body) {
  if (!body || typeof body !== 'object') return 'unrecognized payload';
  const entries = Array.isArray(body.entry) ? body.entry : [];
  if (!entries.length) return `object=${body.object || 'unknown'} (no entries)`;

  const parts = [];
  for (const entry of entries) {
    const changes = Array.isArray(entry && entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const field = (change && change.field) || 'unknown';
      const value = (change && change.value) || {};
      const bits = [`field=${field}`];
      if (Array.isArray(value.messages)) {
        bits.push(`messages=${value.messages.length}`);
        const types = value.messages.map((m) => (m && m.type) || '?');
        if (types.length) bits.push(`types=${types.join(',')}`);
      }
      if (Array.isArray(value.statuses)) {
        bits.push(`statuses=${value.statuses.length}`);
        const st = value.statuses.map((s) => (s && s.status) || '?');
        if (st.length) bits.push(`state=${st.join(',')}`);
      }
      if (value.event) bits.push(`event=${value.event}`);
      parts.push(bits.join(' '));
    }
  }
  return parts.length ? parts.join(' | ') : `object=${body.object || 'unknown'}`;
}

module.exports = {
  safeEqual,
  verifyChallenge,
  isValidSignature,
  summarizeEvent,
};
