'use strict';

/**
 * Tests for tightenEncodeOptions (src/server/encodeExec.js) — the per-attempt
 * encode tightening that makes the size-retry actually shrink an over-size clip
 * (previously retries re-encoded with identical settings and could never get a
 * ~15.5MB clip under the limit).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { tightenEncodeOptions } = require('../../src/server/encodeExec');

const BASE = ['-c:v', 'libx264', '-crf', '23', '-maxrate', '3800k', '-bufsize', '5700k', '-movflags', '+faststart'];

function val(opts, flag) { const i = opts.indexOf(flag); return i === -1 ? undefined : opts[i + 1]; }

test('attempt 0 returns the spec options unchanged (byte-identical primary encode)', () => {
  const out = tightenEncodeOptions(BASE, 0);
  assert.deepEqual(out, BASE);
  // returns a copy, not the same reference
  assert.notEqual(out, BASE);
});

test('each retry lowers maxrate and raises CRF, preserving other tokens', () => {
  const a1 = tightenEncodeOptions(BASE, 1);
  const a2 = tightenEncodeOptions(BASE, 2);

  const m0 = 3800, m1 = parseInt(val(a1, '-maxrate'), 10), m2 = parseInt(val(a2, '-maxrate'), 10);
  assert.ok(m1 < m0, 'attempt 1 maxrate below base');
  assert.ok(m2 < m1, 'attempt 2 maxrate below attempt 1');

  assert.equal(val(a1, '-crf'), '24');
  assert.equal(val(a2, '-crf'), '26');

  // bufsize tracks maxrate (1.5x)
  assert.equal(val(a1, '-bufsize'), Math.round(m1 * 1.5) + 'k');

  // untouched tokens remain
  assert.equal(val(a1, '-c:v'), 'libx264');
  assert.equal(val(a1, '-movflags'), '+faststart');
});

test('maxrate never collapses below a sane floor', () => {
  const a5 = tightenEncodeOptions(BASE, 5);
  assert.ok(parseInt(val(a5, '-maxrate'), 10) >= 800, 'maxrate stays >= 800k');
});

test('adds the tokens when the base lacks them', () => {
  const out = tightenEncodeOptions(['-c:v', 'libx264'], 1);
  assert.ok(out.indexOf('-maxrate') !== -1 && out.indexOf('-crf') !== -1 && out.indexOf('-bufsize') !== -1);
});
