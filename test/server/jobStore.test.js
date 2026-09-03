'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { JobStore } = require('../../src/server/jobStore');

const T0 = 1_700_000_000_000;

function makeStore(opts = {}) {
  let n = 0;
  let t = opts.startTime || T0;
  const store = new JobStore({
    ttlMs: opts.ttlMs != null ? opts.ttlMs : 1000,
    now: () => t,
    genId: () => `job${++n}`,
  });
  return { store, advance: (ms) => { t += ms; }, at: () => t };
}

test('a new job starts in processing', () => {
  const { store } = makeStore();
  const id = store.create();
  assert.strictEqual(id, 'job1');
  assert.deepStrictEqual(store.get(id), { status: 'processing' });
});

test('resolve exposes the result the sync path would have returned', () => {
  const { store } = makeStore();
  const id = store.create();
  const body = { success: true, activationCode: 'K10VJA4KA', waLink: 'https://wa.me/x', fileCount: 2 };
  store.resolve(id, body);
  assert.deepStrictEqual(store.get(id), { status: 'done', result: body });
});

test('reject preserves the HTTP status of the sync path', () => {
  const { store } = makeStore();
  const id = store.create();
  store.reject(id, 422, { error: 'Failed to apply edits', fileName: 'a.mp4' });
  const got = store.get(id);
  assert.strictEqual(got.status, 'error');
  assert.strictEqual(got.httpStatus, 422);
  assert.strictEqual(got.error.error, 'Failed to apply edits');
});

test('an unknown job id reads as null', () => {
  const { store } = makeStore();
  assert.strictEqual(store.get('nope'), null);
});

test('a finished job cannot be overwritten by a late completion', () => {
  const { store } = makeStore();
  const id = store.create();
  store.resolve(id, { activationCode: 'FIRST1234' });
  store.resolve(id, { activationCode: 'SECOND123' });
  store.reject(id, 500, { error: 'late failure' });
  assert.deepStrictEqual(store.get(id), { status: 'done', result: { activationCode: 'FIRST1234' } });
});

test('resolving or rejecting an unknown id is a no-op, not a throw', () => {
  const { store } = makeStore();
  assert.doesNotThrow(() => store.resolve('ghost', {}));
  assert.doesNotThrow(() => store.reject('ghost', 500, {}));
});

test('a job still processing is NEVER swept, however long it takes', () => {
  const { store, advance } = makeStore({ ttlMs: 1000 });
  const id = store.create();
  advance(60 * 60 * 1000); // an hour-long encode
  assert.deepStrictEqual(store.get(id), { status: 'processing' },
    'a slow encode must not be discarded while the client waits');
});

test('a finished job is swept after its TTL', () => {
  const { store, advance } = makeStore({ ttlMs: 1000 });
  const id = store.create();
  store.resolve(id, { ok: true });
  advance(999);
  assert.strictEqual(store.get(id).status, 'done');
  advance(2);
  assert.strictEqual(store.get(id), null);
  assert.strictEqual(store.size, 0);
});

test('sweep only removes the expired ones', () => {
  const { store, advance } = makeStore({ ttlMs: 1000 });
  const oldJob = store.create();
  store.resolve(oldJob, { ok: 1 });
  advance(1500);
  const freshJob = store.create();
  store.resolve(freshJob, { ok: 2 });
  assert.strictEqual(store.sweep(), 1);
  assert.strictEqual(store.get(oldJob), null);
  assert.strictEqual(store.get(freshJob).status, 'done');
});

test('ids are unique across many jobs', () => {
  const { store } = makeStore();
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(store.create());
  assert.strictEqual(ids.size, 50);
});

test('the real generator produces distinct ids', () => {
  const store = new JobStore();
  const a = store.create();
  const b = store.create();
  assert.notStrictEqual(a, b);
  assert.match(a, /^[0-9a-f-]{36}$/);
});
