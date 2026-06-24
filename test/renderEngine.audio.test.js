'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { planRender } = require('../src/server/renderEngine');

/**
 * Audio execution-wiring tests for planRender.
 *
 * planAudio only PLANS the mute×music truth table; the encoder previously
 * mapped only `0:a?`, so a recipe's music was never mixed into the output.
 * These tests lock in that planRender now emits the audio filter graph
 * (`audioFilter`) and the audio output map (`audioMap`), and that the music
 * input is looped/seek-capped so the encode both includes the music and
 * terminates.
 */

const meta = {
  width: 1080,
  height: 1920,
  duration: 18,
  hasSourceAudio: true,
  assetPaths: { 'music/track.mp3': '/tmp/track.mp3' },
};

function recipeWith(audio) {
  return { version: 1, trim: null, textOverlays: [], stickers: [], audio };
}

test('mix mode: unmuted original + music → amix graph mapping [aout]', () => {
  const plan = planRender(recipeWith({
    originalMuted: false,
    originalVolume: 100,
    music: { assetRef: 'music/track.mp3', volume: 80, audioStart: 0, loopMode: 'loop' },
  }), meta);

  assert.match(plan.audioFilter, /amix=inputs=2/, 'mix mode must amix original + music');
  assert.match(plan.audioFilter, /\[0:a\]volume=/, 'original audio must be volume-adjusted');
  assert.strictEqual(plan.audioMap, '[aout]');

  // Music is the last input and is looped + duration-capped so it fills the
  // clip without making the encode run forever.
  const musicInput = plan.inputs[plan.inputs.length - 1];
  assert.strictEqual(musicInput.type, 'audio');
  assert.ok(musicInput.args.includes('-stream_loop'), 'loop mode must loop the music input');
  assert.ok(musicInput.args.includes('-t'), 'music input must be duration-capped');
});

test('music mode: muted original + music → music-only graph', () => {
  const plan = planRender(recipeWith({
    originalMuted: true,
    originalVolume: 100,
    music: { assetRef: 'music/track.mp3', volume: 70, audioStart: 0, loopMode: 'loop' },
  }), meta);

  assert.doesNotMatch(plan.audioFilter, /amix/, 'muted original must not amix');
  assert.doesNotMatch(plan.audioFilter, /\[0:a\]/, 'muted original audio must not be referenced');
  assert.match(plan.audioFilter, /volume=/, 'music volume must be applied');
  assert.strictEqual(plan.audioMap, '[aout]');
});

test('original mode at full volume: passthrough source audio, no filter', () => {
  const plan = planRender(recipeWith({
    originalMuted: false,
    originalVolume: 100,
    music: null,
  }), meta);

  assert.strictEqual(plan.audioFilter, '');
  assert.strictEqual(plan.audioMap, '0:a?');
});

test('mix mode but source has no audio → degrades to music-only', () => {
  const plan = planRender(recipeWith({
    originalMuted: false,
    originalVolume: 100,
    music: { assetRef: 'music/track.mp3', volume: 80, audioStart: 0, loopMode: 'loop' },
  }), Object.assign({}, meta, { hasSourceAudio: false }));

  assert.doesNotMatch(plan.audioFilter, /amix/, 'no source audio → cannot amix');
  assert.doesNotMatch(plan.audioFilter, /\[0:a\]/, 'must not reference a missing source audio stream');
  assert.strictEqual(plan.audioMap, '[aout]');
});

test('silence mode: muted original, no music → no audio track', () => {
  const plan = planRender(recipeWith({
    originalMuted: true,
    originalVolume: 100,
    music: null,
  }), meta);

  assert.strictEqual(plan.audioFilter, '');
  assert.strictEqual(plan.audioMap, null);
});
