'use strict';

/**
 * Guards for inbound WhatsApp messages.
 *
 * Context: one customer received the "welcome / no code found" reply EIGHT times
 * inside a single minute. Three separate holes caused it, all covered here:
 *
 *  1. Replays — on reconnect/relink Baileys re-emits history with type 'notify',
 *     so old messages look new and get answered again. A staleness check existed
 *     in server.js but was never actually wired into the handler.
 *  2. Duplicate delivery — WhatsApp can deliver the same message id more than
 *     once, and two upsert events for one message produced two replies.
 *  3. No per-sender throttle — someone sending "hi", "hello", "?" got a reply to
 *     every single one.
 *
 * These are kept as small pure/stateful units so the behaviour is unit-testable
 * rather than only observable in production.
 */

/** Messages older than this are treated as history replay, not live requests. */
const STALE_MESSAGE_SECONDS = 90;

/**
 * Normalize Baileys' messageTimestamp, which may be a number, a Long-like object
 * with toNumber(), or a numeric string. Returns 0 when it can't be read, and
 * callers treat 0 as "unknown, don't apply the staleness rule".
 *
 * @param {number|string|{toNumber?: () => number}|null|undefined} ts
 * @returns {number} seconds since epoch, or 0
 */
function messageTimestampSeconds(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : 0;
  if (typeof ts.toNumber === 'function') {
    try {
      const n = ts.toNumber();
      return Number.isFinite(n) ? n : 0;
    } catch (_) {
      return 0;
    }
  }
  const n = Number(ts);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Should this message be skipped as a history replay?
 * Unknown timestamps are NOT treated as stale — better to answer a live user
 * than to silently drop a real request.
 *
 * @param {*} rawTimestamp Baileys messageTimestamp
 * @param {number} [nowMs=Date.now()]
 * @param {number} [maxAgeSeconds=STALE_MESSAGE_SECONDS]
 * @returns {{stale: boolean, ageSeconds: number|null}}
 */
function isStaleMessage(rawTimestamp, nowMs = Date.now(), maxAgeSeconds = STALE_MESSAGE_SECONDS) {
  const ts = messageTimestampSeconds(rawTimestamp);
  if (!ts) return { stale: false, ageSeconds: null };
  const ageSeconds = Math.floor(nowMs / 1000) - ts;
  return { stale: ageSeconds > maxAgeSeconds, ageSeconds };
}

/**
 * Remembers handled message ids for a TTL so a re-delivered message is answered
 * once. Time is injectable so tests don't need timers.
 */
class MessageDeduper {
  /**
   * @param {number} [ttlMs=600000] how long an id is remembered
   * @param {() => number} [now=Date.now]
   */
  constructor(ttlMs = 10 * 60 * 1000, now = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, number>} id -> first-seen ms */
    this.seenAt = new Map();
  }

  /**
   * Record an id and report whether it had already been handled.
   * A missing id can't be deduped, so it is always treated as new.
   *
   * @param {string|null|undefined} id
   * @returns {boolean} true if this id was already handled
   */
  isDuplicate(id) {
    if (!id) return false;
    const t = this.now();
    this._prune(t);
    if (this.seenAt.has(id)) return true;
    this.seenAt.set(id, t);
    return false;
  }

  /** Drop entries past their TTL. @param {number} t */
  _prune(t) {
    const cutoff = t - this.ttlMs;
    for (const [id, at] of this.seenAt.entries()) {
      if (at <= cutoff) this.seenAt.delete(id);
    }
  }

  get size() {
    return this.seenAt.size;
  }
}

/**
 * Rate-limits the "no code found" welcome reply to one per sender per window.
 */
class WelcomeThrottle {
  /**
   * @param {number} [cooldownMs=600000]
   * @param {() => number} [now=Date.now]
   */
  constructor(cooldownMs = 10 * 60 * 1000, now = Date.now) {
    this.cooldownMs = cooldownMs;
    this.now = now;
    /** @type {Map<string, number>} jid -> last sent ms */
    this.sentAt = new Map();
  }

  /**
   * @param {string} jid
   * @returns {boolean} true when a welcome may be sent now
   */
  shouldSend(jid) {
    if (!jid) return false;
    const last = this.sentAt.get(jid);
    if (last === undefined) return true;
    return this.now() - last >= this.cooldownMs;
  }

  /** Mark a welcome as sent. @param {string} jid */
  markSent(jid) {
    if (jid) this.sentAt.set(jid, this.now());
  }

  /** Undo a mark, so a failed send can be retried. @param {string} jid */
  clear(jid) {
    this.sentAt.delete(jid);
  }

  /** Drop entries past the cooldown so the map can't grow unbounded. */
  prune() {
    const cutoff = this.now() - this.cooldownMs;
    for (const [jid, at] of this.sentAt.entries()) {
      if (at < cutoff) this.sentAt.delete(jid);
    }
  }

  get size() {
    return this.sentAt.size;
  }
}

module.exports = {
  STALE_MESSAGE_SECONDS,
  messageTimestampSeconds,
  isStaleMessage,
  MessageDeduper,
  WelcomeThrottle,
};
