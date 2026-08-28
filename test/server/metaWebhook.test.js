'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const {
  safeEqual,
  verifyChallenge,
  isValidSignature,
  summarizeEvent,
} = require('../../src/server/metaWebhook');

// ---------------------------------------------------------------------------
// GET verification handshake
// ---------------------------------------------------------------------------

test('a correct handshake echoes the challenge', () => {
  const r = verifyChallenge(
    { mode: 'subscribe', token: 'sekret', challenge: '12345' },
    'sekret'
  );
  assert.deepStrictEqual(r, { ok: true, challenge: '12345' });
});

test('a wrong token is rejected with 403', () => {
  const r = verifyChallenge(
    { mode: 'subscribe', token: 'nope', challenge: '12345' },
    'sekret'
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 403);
});

test('an unconfigured server refuses instead of accepting anything', () => {
  const r = verifyChallenge({ mode: 'subscribe', token: '', challenge: '1' }, '');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 500);
});

test('a non-subscribe mode is rejected', () => {
  const r = verifyChallenge({ mode: 'unsubscribe', token: 'sekret', challenge: '1' }, 'sekret');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
});

test('a missing challenge is rejected', () => {
  const r = verifyChallenge({ mode: 'subscribe', token: 'sekret' }, 'sekret');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
});

test('an empty query object does not throw', () => {
  assert.strictEqual(verifyChallenge(undefined, 'sekret').ok, false);
  assert.strictEqual(verifyChallenge({}, 'sekret').ok, false);
});

// ---------------------------------------------------------------------------
// safeEqual
// ---------------------------------------------------------------------------

test('safeEqual matches identical strings and rejects everything else', () => {
  assert.strictEqual(safeEqual('abc', 'abc'), true);
  assert.strictEqual(safeEqual('abc', 'abd'), false);
  assert.strictEqual(safeEqual('abc', 'abcd'), false); // length mismatch must not throw
  assert.strictEqual(safeEqual('', ''), true);
  assert.strictEqual(safeEqual(null, 'abc'), false);
  assert.strictEqual(safeEqual('abc', undefined), false);
});

// ---------------------------------------------------------------------------
// POST signature validation
// ---------------------------------------------------------------------------

const SECRET = 'app-secret-value';
const BODY = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }), 'utf8');
const goodSig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(BODY).digest('hex');

test('a correct signature validates', () => {
  assert.strictEqual(isValidSignature(BODY, goodSig, SECRET), true);
});

test('a tampered body fails validation', () => {
  assert.strictEqual(isValidSignature(Buffer.from('{"x":1}'), goodSig, SECRET), false);
});

test('a wrong secret fails validation', () => {
  assert.strictEqual(isValidSignature(BODY, goodSig, 'other-secret'), false);
});

test('a malformed or missing header fails validation', () => {
  assert.strictEqual(isValidSignature(BODY, 'garbage', SECRET), false);
  assert.strictEqual(isValidSignature(BODY, undefined, SECRET), false);
  assert.strictEqual(isValidSignature(BODY, 'sha1=abc', SECRET), false);
});

test('validation is skipped when no app secret is configured', () => {
  assert.strictEqual(isValidSignature(BODY, undefined, ''), true);
  assert.strictEqual(isValidSignature(BODY, 'anything', undefined), true);
});

test('a null body with a configured secret fails rather than throwing', () => {
  assert.strictEqual(isValidSignature(null, goodSig, SECRET), false);
});

// ---------------------------------------------------------------------------
// Log summaries (must not leak message text)
// ---------------------------------------------------------------------------

test('an inbound message payload is summarized without its text', () => {
  const s = summarizeEvent({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: { messages: [{ type: 'text', text: { body: 'my secret code ABC123XYZ' } }] },
      }],
    }],
  });
  assert.match(s, /field=messages/);
  assert.match(s, /messages=1/);
  assert.match(s, /types=text/);
  assert.ok(!s.includes('ABC123XYZ'), 'summary must not leak message text');
});

test('a delivery status payload is summarized', () => {
  const s = summarizeEvent({
    entry: [{ changes: [{ field: 'messages', value: { statuses: [{ status: 'delivered' }] } }] }],
  });
  assert.match(s, /statuses=1/);
  assert.match(s, /state=delivered/);
});

test('odd payloads degrade gracefully', () => {
  assert.strictEqual(typeof summarizeEvent(null), 'string');
  assert.strictEqual(typeof summarizeEvent({}), 'string');
  assert.strictEqual(typeof summarizeEvent({ object: 'x', entry: [] }), 'string');
  assert.strictEqual(typeof summarizeEvent({ entry: [{}] }), 'string');
});
