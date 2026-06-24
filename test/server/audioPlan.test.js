'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  audioRenderedLength,
  audioAudiblePortion,
} = require('../../src/server/audioPlan');
const {
  AUDIO_EQUAL_TOLERANCE_SECONDS,
} = require('../../src/shared/constants');

// Unit tests for the loop/once/truncate length semantics of task 5.3.
// `audioRenderedLength` must ALWAYS equal the output duration (Property 18 /
// Req 10.1, 10.2, 10.3, 10.5, 10.6, 10.7, 10.8); `audioAudiblePortion` exposes
// how much of that span the music actually fills before silence padding.

test('audioRenderedLength always equals the output duration (music shorter, loop)', () => {
  const audio = { hasMusic: true, loopMode: 'loop', musicDuration: 5 };
  assert.equal(audioRenderedLength(audio, 30), 30);
});

test('audioRenderedLength always equals the output duration (music shorter, once)', () => {
  const audio = { hasMusic: true, loopMode: 'once', musicDuration: 5 };
  assert.equal(audioRenderedLength(audio, 30), 30);
});

test('audioRenderedLength always equals the output duration (music longer)', () => {
  const audio = { hasMusic: true, loopMode: 'loop', musicDuration: 90 };
  assert.equal(audioRenderedLength(audio, 29), 29);
});

test('audioRenderedLength always equals the output duration (no music)', () => {
  assert.equal(audioRenderedLength({ hasMusic: false }, 12.5), 12.5);
  assert.equal(audioRenderedLength(null, 12.5), 12.5);
});

test('audioRenderedLength clamps non-finite/negative output duration to 0', () => {
  assert.equal(audioRenderedLength({ hasMusic: true, musicDuration: 5 }, NaN), 0);
  assert.equal(audioRenderedLength({ hasMusic: true, musicDuration: 5 }, -3), 0);
  assert.equal(audioRenderedLength({ hasMusic: true, musicDuration: 5 }, Infinity), 0);
});

test('audible portion: loop mode fills the full output (Req 10.5)', () => {
  const audio = { hasMusic: true, loopMode: 'loop', musicDuration: 7 };
  assert.equal(audioAudiblePortion(audio, 30), 30);
});

test('audible portion: loop is the default when loopMode unset (Req 10.3)', () => {
  const audio = { hasMusic: true, musicDuration: 7 }; // no loopMode
  assert.equal(audioAudiblePortion(audio, 30), 30);
});

test('audible portion: once mode plays the segment once then silence (Req 10.6)', () => {
  const audio = { hasMusic: true, loopMode: 'once', musicDuration: 7 };
  assert.equal(audioAudiblePortion(audio, 30), 7);
});

test('audible portion: segment longer than output is truncated (Req 10.1/10.7)', () => {
  const audio = { hasMusic: true, loopMode: 'loop', musicDuration: 90 };
  assert.equal(audioAudiblePortion(audio, 29), 29);
});

test('audible portion: segment longer than output truncated regardless of mode', () => {
  const audio = { hasMusic: true, loopMode: 'once', musicDuration: 90 };
  assert.equal(audioAudiblePortion(audio, 29), 29);
});

test('audible portion: equal-within-tolerance plays once, no loop/truncate (Req 10.8)', () => {
  // Exactly equal.
  assert.equal(audioAudiblePortion({ hasMusic: true, musicDuration: 29 }, 29), 29);
  // Within tolerance on the short side -> play once (return the segment length).
  const shortM = 29 - AUDIO_EQUAL_TOLERANCE_SECONDS / 2;
  assert.equal(
    audioAudiblePortion({ hasMusic: true, loopMode: 'loop', musicDuration: shortM }, 29),
    shortM
  );
  // Within tolerance on the long side -> play once (no truncation).
  const longM = 29 + AUDIO_EQUAL_TOLERANCE_SECONDS / 2;
  assert.equal(
    audioAudiblePortion({ hasMusic: true, loopMode: 'loop', musicDuration: longM }, 29),
    longM
  );
});

test('audible portion: just outside tolerance is treated as shorter/longer', () => {
  const justShorter = 29 - AUDIO_EQUAL_TOLERANCE_SECONDS - 0.01;
  // once -> plays once
  assert.equal(
    audioAudiblePortion({ hasMusic: true, loopMode: 'once', musicDuration: justShorter }, 29),
    justShorter
  );
  const justLonger = 29 + AUDIO_EQUAL_TOLERANCE_SECONDS + 0.01;
  // longer -> truncated to output
  assert.equal(
    audioAudiblePortion({ hasMusic: true, loopMode: 'loop', musicDuration: justLonger }, 29),
    29
  );
});

test('audible portion: no music resolves to 0', () => {
  assert.equal(audioAudiblePortion({ hasMusic: false }, 30), 0);
  assert.equal(audioAudiblePortion({ hasMusic: false, musicDuration: 10 }, 30), 0);
  assert.equal(audioAudiblePortion(null, 30), 0);
  assert.equal(audioAudiblePortion({ hasMusic: true }, 30), 0); // no length field
});

test('audible portion: zero output duration yields 0', () => {
  assert.equal(audioAudiblePortion({ hasMusic: true, musicDuration: 10 }, 0), 0);
  assert.equal(audioAudiblePortion({ hasMusic: true, musicDuration: 10 }, NaN), 0);
});

test('audible portion: reads trackDuration / segment aliases when musicDuration absent', () => {
  assert.equal(
    audioAudiblePortion({ hasMusic: true, loopMode: 'once', trackDuration: 8 }, 30),
    8
  );
  assert.equal(
    audioAudiblePortion({ hasMusic: true, loopMode: 'once', segmentDuration: 6 }, 30),
    6
  );
  // musicDuration takes priority over trackDuration.
  assert.equal(
    audioAudiblePortion(
      { hasMusic: true, loopMode: 'once', musicDuration: 4, trackDuration: 50 },
      30
    ),
    4
  );
});
