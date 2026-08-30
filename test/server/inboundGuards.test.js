'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  STALE_MESSAGE_SECONDS,
  messageTimestampSeconds,
  isStaleMessage,
  MessageDeduper,
  WelcomeThrottle,
} = require('../../src/server/inboundGuards');

// ---------------------------------------------------------------------------
// The bug: one customer got the welcome reply EIGHT times in one minute.
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

// --- timestamp normalization ------------------------------------------------

test('messageTimestampSeconds handles number, Long-like, and string', () => {
  assert.strictEqual(messageTimestampSeconds(NOW_S), NOW_S);
  assert.strictEqual(messageTimestampSeconds({ toNumber: () => NOW_S }), NOW_S);
  assert.strictEqual(messageTimestampSeconds(String(NOW_S)), NOW_S);
});

test('messageTimestampSeconds returns 0 for unusable input instead of throwing', () => {
  assert.strictEqual(messageTimestampSeconds(null), 0);
  assert.strictEqual(messageTimestampSeconds(undefined), 0);
  assert.strictEqual(messageTimestampSeconds('abc'), 0);
  assert.strictEqual(messageTimestampSeconds(NaN), 0);
  assert.strictEqual(messageTimestampSeconds({ toNumber: () => { throw new Error('x'); } }), 0);
  assert.strictEqual(messageTimestampSeconds({}), 0);
});

// --- staleness (replay) guard ----------------------------------------------

test('a fresh message is not stale', () => {
  const r = isStaleMessage(NOW_S - 5, NOW_MS);
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.ageSeconds, 5);
});

test('a history-replayed message is stale', () => {
  // Reconnect replays messages from hours earlier as type 'notify'.
  const r = isStaleMessage(NOW_S - 7200, NOW_MS);
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.ageSeconds, 7200);
});

test('the staleness boundary is exclusive', () => {
  assert.strictEqual(isStaleMessage(NOW_S - STALE_MESSAGE_SECONDS, NOW_MS).stale, false);
  assert.strictEqual(isStaleMessage(NOW_S - STALE_MESSAGE_SECONDS - 1, NOW_MS).stale, true);
});

test('an unknown timestamp is NOT treated as stale (never drop a real request)', () => {
  const r = isStaleMessage(undefined, NOW_MS);
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.ageSeconds, null);
});

test('a clock-skewed future timestamp is not stale', () => {
  assert.strictEqual(isStaleMessage(NOW_S + 30, NOW_MS).stale, false);
});

// --- duplicate message id guard -------------------------------------------

test('the same message id is only handled once', () => {
  const d = new MessageDeduper(1000, () => NOW_MS);
  assert.strictEqual(d.isDuplicate('MSG1'), false, 'first sighting is new');
  assert.strictEqual(d.isDuplicate('MSG1'), true, 'second sighting is a duplicate');
  assert.strictEqual(d.isDuplicate('MSG1'), true);
});

test('different message ids are independent', () => {
  const d = new MessageDeduper(1000, () => NOW_MS);
  assert.strictEqual(d.isDuplicate('A'), false);
  assert.strictEqual(d.isDuplicate('B'), false);
  assert.strictEqual(d.isDuplicate('A'), true);
});

test('ids are forgotten after the TTL so the set cannot grow forever', () => {
  let t = NOW_MS;
  const d = new MessageDeduper(1000, () => t);
  assert.strictEqual(d.isDuplicate('A'), false);
  t += 1001;
  assert.strictEqual(d.isDuplicate('A'), false, 'expired, treated as new');
  assert.strictEqual(d.size, 1, 'old entry pruned, not accumulated');
});

test('a missing id cannot be deduped and is treated as new', () => {
  const d = new MessageDeduper(1000, () => NOW_MS);
  assert.strictEqual(d.isDuplicate(undefined), false);
  assert.strictEqual(d.isDuplicate(null), false);
  assert.strictEqual(d.isDuplicate(''), false);
});

// --- welcome throttle ------------------------------------------------------

const JID = '94761677205@s.whatsapp.net';

test('the first welcome is allowed, immediate repeats are not', () => {
  const w = new WelcomeThrottle(600000, () => NOW_MS);
  assert.strictEqual(w.shouldSend(JID), true);
  w.markSent(JID);
  assert.strictEqual(w.shouldSend(JID), false);
});

test('EIGHT rapid non-code messages produce exactly ONE welcome', () => {
  let t = NOW_MS;
  const w = new WelcomeThrottle(600000, () => t);
  let sent = 0;
  for (let i = 0; i < 8; i++) {
    if (w.shouldSend(JID)) { w.markSent(JID); sent++; }
    t += 1000; // a second apart, like the real incident
  }
  assert.strictEqual(sent, 1, 'this is the reported bug: 8 replies became 1');
});

test('a welcome is allowed again after the cooldown', () => {
  let t = NOW_MS;
  const w = new WelcomeThrottle(600000, () => t);
  w.markSent(JID);
  t += 599999;
  assert.strictEqual(w.shouldSend(JID), false);
  t += 1;
  assert.strictEqual(w.shouldSend(JID), true);
});

test('senders are throttled independently', () => {
  const w = new WelcomeThrottle(600000, () => NOW_MS);
  w.markSent(JID);
  assert.strictEqual(w.shouldSend('other@s.whatsapp.net'), true);
});

test('a failed send can be retried via clear()', () => {
  const w = new WelcomeThrottle(600000, () => NOW_MS);
  w.markSent(JID);
  assert.strictEqual(w.shouldSend(JID), false);
  w.clear(JID);
  assert.strictEqual(w.shouldSend(JID), true);
});

test('prune drops entries past the cooldown', () => {
  let t = NOW_MS;
  const w = new WelcomeThrottle(1000, () => t);
  w.markSent(JID);
  assert.strictEqual(w.size, 1);
  t += 5000;
  w.prune();
  assert.strictEqual(w.size, 0);
});

test('an empty jid is never sent to', () => {
  const w = new WelcomeThrottle(600000, () => NOW_MS);
  assert.strictEqual(w.shouldSend(''), false);
  assert.strictEqual(w.shouldSend(undefined), false);
});
