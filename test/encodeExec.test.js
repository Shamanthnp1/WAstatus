'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  createEncodeExec,
  RETRY_SIZE_MB,
  MAX_ENCODE_ATTEMPTS,
} = require('../src/server/encodeExec');

/**
 * Unit tests for the encode-execution timeout, retry, and retry-exhaustion paths.
 *
 * These exercise `createEncodeExec` with fully mocked dependencies — a mock
 * ffmpeg command (never touches real ffmpeg), a mock semaphore (release spy), a
 * mock fs (statSync/unlinkSync), and an injectable fake timer — so the SIGKILL
 * timeout path, the 15.5MB size-retry loop, and the retry-exhaustion error are
 * verified deterministically and fast (no real encoding, no real waits).
 *
 * Validates: Requirements 12.4 (timeout), 12.5 (retry exhaustion),
 * 13.4 (per-encode time limit), and the 12.2/11.5 size-retry behavior.
 */

const MB = 1024 * 1024;

// --- Mock helpers -----------------------------------------------------------

/**
 * A mock encode semaphore that spies on acquire/release. `acquire()` resolves
 * immediately with a release fn, mirroring the real EncodeSemaphore contract.
 */
function createMockSemaphore() {
  return {
    acquireCount: 0,
    releaseCount: 0,
    async acquire() {
      this.acquireCount += 1;
      return () => {
        this.releaseCount += 1;
      };
    },
  };
}

/**
 * A mock fs shim. `statSync` returns sizes from `sizesBytes` in order (the last
 * size repeats once exhausted), and every `unlinkSync` path is recorded.
 */
function createMockFs(sizesBytes) {
  const sizes = Array.isArray(sizesBytes) ? sizesBytes : [sizesBytes];
  let statCalls = 0;
  const unlinked = [];
  return {
    unlinked,
    get statCalls() {
      return statCalls;
    },
    statSync() {
      const idx = Math.min(statCalls, sizes.length - 1);
      statCalls += 1;
      return { size: sizes[idx] };
    },
    unlinkSync(p) {
      unlinked.push(p);
    },
  };
}

/**
 * A controllable fake timer. Timers only fire when `fireAll()` is invoked, which
 * lets the timeout path be driven deterministically with no real wall-clock wait.
 */
function createFakeTimer() {
  let nextId = 1;
  const timers = new Map();
  return {
    get pending() {
      return timers.size;
    },
    setTimeout(fn) {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fireAll() {
      for (const [id, fn] of [...timers.entries()]) {
        timers.delete(id);
        fn();
      }
    },
  };
}

/**
 * A mock ffmpeg command factory. `behavior` controls what `run()` does:
 *   'end'   -> asynchronously invokes the 'end' handler (encode succeeds)
 *   'error' -> asynchronously invokes the 'error' handler (encode fails)
 *   'hang'  -> never settles (simulates a hung encode -> drives the timeout)
 * Every created command is recorded on `factory.commands`.
 */
function createMockFfmpeg(behavior) {
  const commands = [];
  function factory() {
    const cmd = {
      killed: false,
      killSignal: null,
      _end: null,
      _error: null,
      input() {
        return cmd;
      },
      inputOptions() {
        return cmd;
      },
      outputOptions() {
        return cmd;
      },
      output() {
        return cmd;
      },
      on(event, handler) {
        if (event === 'end') cmd._end = handler;
        if (event === 'error') cmd._error = handler;
        return cmd;
      },
      run() {
        if (behavior === 'end') {
          Promise.resolve().then(() => {
            if (!cmd.killed && cmd._end) cmd._end();
          });
        } else if (behavior === 'error') {
          Promise.resolve().then(() => {
            if (!cmd.killed && cmd._error) cmd._error(new Error('ffmpeg failed'));
          });
        }
        // 'hang' => intentionally do nothing.
        return cmd;
      },
      kill(signal) {
        cmd.killed = true;
        cmd.killSignal = signal;
      },
    };
    commands.push(cmd);
    return cmd;
  }
  factory.commands = commands;
  return factory;
}

/** Flush the microtask queue so async/await steps settle. */
async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

/** Minimal RenderPlan accepted by buildRecipeCommand. */
function makePlan() {
  return {
    inputs: [{ path: 'uploads/in.mp4', args: [] }],
    filterComplex: '[0:v]null[vout]',
    encodeOptions: ['-c:v', 'libx264'],
  };
}

// --- Timeout path (Req 12.4, 13.4) -----------------------------------------

test('timeout: hung encode is SIGKILLed, partial output unlinked, inputs retained, isTimeout error', async () => {
  const semaphore = createMockSemaphore();
  const fs = createMockFs(0);
  const timer = createFakeTimer();
  const ffmpegFactory = createMockFfmpeg('hang');
  const { runGatedEncode } = createEncodeExec({
    semaphore,
    fs,
    ffmpegFactory,
    setTimeout: timer.setTimeout.bind(timer),
    clearTimeout: timer.clearTimeout.bind(timer),
  });

  const outputPath = 'compressed/out.mp4';
  const inputPath = 'uploads/in.mp4';

  const promise = runGatedEncode(() => ffmpegFactory(), outputPath, 600000, 'full-video');

  // Let acquire() resolve and the encode start so the timeout timer is armed.
  await flush();
  assert.equal(timer.pending, 1, 'a timeout timer should be armed while the encode runs');

  // Simulate the time limit elapsing.
  timer.fireAll();

  await assert.rejects(
    promise,
    (err) => err && err.isTimeout === true,
    'timeout must reject with an error tagged isTimeout'
  );

  // The ffmpeg process was force-killed.
  const cmd = ffmpegFactory.commands[ffmpegFactory.commands.length - 1];
  assert.equal(cmd.killed, true, 'command should be killed on timeout');
  assert.equal(cmd.killSignal, 'SIGKILL', 'command should be killed with SIGKILL');

  // The partial output was removed; the input was retained (never unlinked).
  assert.deepStrictEqual(fs.unlinked, [outputPath], 'only the partial output should be unlinked');
  assert.ok(!fs.unlinked.includes(inputPath), 'the input file must not be unlinked');

  // The permit was acquired before and released after (even on timeout).
  assert.equal(semaphore.acquireCount, 1, 'a permit should be acquired');
  assert.equal(semaphore.releaseCount, 1, 'the permit should be released after a timeout');
});

// --- Retry path (Req 12.2 / 11.5) ------------------------------------------

test('retry: oversize output triggers a re-encode, then an under-threshold result resolves', async () => {
  const semaphore = createMockSemaphore();
  // First encode is oversize (> RETRY_SIZE_MB), second is under threshold.
  const fs = createMockFs([(RETRY_SIZE_MB + 4) * MB, (RETRY_SIZE_MB - 4) * MB]);
  const timer = createFakeTimer();
  const ffmpegFactory = createMockFfmpeg('end');
  const { encodeRecipePlan } = createEncodeExec({
    semaphore,
    fs,
    ffmpegFactory,
    setTimeout: timer.setTimeout.bind(timer),
    clearTimeout: timer.clearTimeout.bind(timer),
  });

  await encodeRecipePlan(makePlan(), 'compressed/out.mp4', 600000, 'full-video');

  // Two encode attempts: the oversize one and the conforming retry.
  assert.equal(ffmpegFactory.commands.length, 2, 'should run exactly two encode attempts');
  assert.equal(fs.statCalls, 2, 'size should be checked after each attempt');
  // No output was unlinked because the retry produced a conforming clip.
  assert.deepStrictEqual(fs.unlinked, [], 'a conforming retry keeps its output');

  // A permit was acquired and released for each attempt.
  assert.equal(semaphore.acquireCount, 2, 'one permit per encode attempt');
  assert.equal(semaphore.releaseCount, 2, 'each permit released after its attempt');
});

// --- Retry-exhaustion path (Req 12.5) --------------------------------------

test('retry exhaustion: persistently oversize output throws after MAX_ENCODE_ATTEMPTS and keeps no output', async () => {
  const semaphore = createMockSemaphore();
  // Always oversize -> never conforms.
  const fs = createMockFs((RETRY_SIZE_MB + 4) * MB);
  const timer = createFakeTimer();
  const ffmpegFactory = createMockFfmpeg('end');
  const { encodeRecipePlan } = createEncodeExec({
    semaphore,
    fs,
    ffmpegFactory,
    setTimeout: timer.setTimeout.bind(timer),
    clearTimeout: timer.clearTimeout.bind(timer),
  });

  const outputPath = 'compressed/out.mp4';

  await assert.rejects(
    encodeRecipePlan(makePlan(), outputPath, 600000, 'full-video'),
    (err) => err && /could not be brought under 16MB/i.test(err.message),
    'exhausting retries must throw a size-exhaustion error'
  );

  // Exactly MAX_ENCODE_ATTEMPTS encodes were attempted.
  assert.equal(
    ffmpegFactory.commands.length,
    MAX_ENCODE_ATTEMPTS,
    `should attempt the encode ${MAX_ENCODE_ATTEMPTS} times`
  );

  // The final non-conforming output was removed (no non-conforming clip kept).
  assert.deepStrictEqual(fs.unlinked, [outputPath], 'the non-conforming output must be unlinked');

  // A permit was acquired and released for every attempt.
  assert.equal(semaphore.acquireCount, MAX_ENCODE_ATTEMPTS, 'one permit per attempt');
  assert.equal(semaphore.releaseCount, MAX_ENCODE_ATTEMPTS, 'every permit released');
});

// --- Semaphore release on encode error -------------------------------------

test('error path: an ffmpeg error rejects and still releases the permit', async () => {
  const semaphore = createMockSemaphore();
  const fs = createMockFs(0);
  const timer = createFakeTimer();
  const ffmpegFactory = createMockFfmpeg('error');
  const { runGatedEncode } = createEncodeExec({
    semaphore,
    fs,
    ffmpegFactory,
    setTimeout: timer.setTimeout.bind(timer),
    clearTimeout: timer.clearTimeout.bind(timer),
  });

  await assert.rejects(
    runGatedEncode(() => ffmpegFactory(), 'compressed/out.mp4', 600000, 'chunk'),
    (err) => err && /ffmpeg failed/.test(err.message),
    'an ffmpeg error should reject'
  );

  assert.equal(semaphore.acquireCount, 1, 'a permit should be acquired');
  assert.equal(semaphore.releaseCount, 1, 'the permit should be released after an error');
});
