'use strict';

/**
 * Audio sub-graph planning for the Render_Engine.
 *
 * This module owns the pure, deterministic audio planning logic that is folded
 * into the single ffmpeg Compression_Pass. It contains no ffmpeg invocation and
 * no I/O, so it can be unit- and property-tested in isolation.
 *
 * Task 5.1 implements the mute x music truth table (`planAudio`). Later tasks
 * extend this module:
 *   - 5.3 `audioRenderedLength` (loop/once/truncate length semantics)
 *   - 5.5 audio start offset mapping with safe fallback
 *   - 5.7 `chunkAudioOffset` (continuity across split chunks)
 *
 * CommonJS module to match the existing codebase (server.js).
 *
 * @see Requirements 7.5, 7.6, 7.7, 7.8, 7.9
 */

const {
  DEFAULT_LOOP_MODE,
  AUDIO_EQUAL_TOLERANCE_SECONDS,
  CLIP_DURATION_LIMIT,
} = require('../shared/constants');

/**
 * Audio plan modes, one per cell of the mute x music truth table.
 * @readonly
 * @enum {string}
 */
const AUDIO_MODE = Object.freeze({
  /** Unmuted original, no music: original-only at its volume (Req 7.8). */
  ORIGINAL: 'original',
  /** Muted original, music present: music-only at its volume (Req 7.5). */
  MUSIC: 'music',
  /** Unmuted original, music present: amix of both at their volumes (Req 7.6). */
  MIX: 'mix',
  /** Muted original, no music: full-duration silence (Req 7.7). */
  SILENCE: 'silence',
});

/**
 * Resolve the audio plan for one video from its recipe audio settings.
 *
 * Implements the mute x music truth table from the design (Req 7.5–7.8):
 *
 * | originalMuted | hasMusic | mode      | output audio                         |
 * | ------------- | -------- | --------- | ------------------------------------ |
 * | false         | false    | original  | original at its volume (7.8)         |
 * | true          | false    | silence   | zero-amplitude full duration (7.7)   |
 * | true          | true     | music     | music only at its volume (7.5)       |
 * | false         | true     | mix       | amix(original, music) each vol (7.6) |
 *
 * Each source is carried at its configured volume so the execution layer can
 * emit the matching `volume`/`amix` filter nodes. The result is encoded to the
 * WhatsApp_Spec audio format within the single Compression_Pass (Req 7.9).
 *
 * @param {import('../shared/constants').AudioConfig} audioConfig
 *   Recipe audio settings: `{ originalMuted, originalVolume, music? }`.
 * @param {boolean} hasMusic
 *   Whether a Music_Track is present and resolved for this video. This is
 *   authoritative over `audioConfig.music` so a stale/unresolved reference
 *   never produces a music plan.
 * @returns {import('../shared/constants').AudioPlan} The resolved audio plan.
 */
function planAudio(audioConfig, hasMusic) {
  const config = audioConfig || {};
  const originalMuted = config.originalMuted === true;
  const originalVolume = normalizeVolume(config.originalVolume);
  const musicPresent = hasMusic === true;

  /** @type {import('../shared/constants').AudioPlan} */
  const plan = {
    mode: selectMode(originalMuted, musicPresent),
    originalMuted,
    originalVolume,
    hasMusic: musicPresent,
  };

  if (musicPresent) {
    const music = config.music || {};
    plan.musicVolume = normalizeVolume(music.volume);
    plan.audioStart = Number.isFinite(music.audioStart) ? music.audioStart : 0;
    plan.loopMode = music.loopMode === 'once' ? 'once' : DEFAULT_LOOP_MODE;
  }

  return plan;
}

/**
 * Select the truth-table mode for a given mute/music combination.
 * @param {boolean} originalMuted
 * @param {boolean} hasMusic
 * @returns {('original'|'music'|'mix'|'silence')}
 */
function selectMode(originalMuted, hasMusic) {
  if (hasMusic) {
    return originalMuted ? AUDIO_MODE.MUSIC : AUDIO_MODE.MIX;
  }
  return originalMuted ? AUDIO_MODE.SILENCE : AUDIO_MODE.ORIGINAL;
}

/**
 * Compute the rendered audio length for one video's audio plan.
 *
 * The rendered audio length is the wall-clock length of the audio track that is
 * muxed into the output. By design it ALWAYS equals the output video duration:
 * every audio mode (original / mix / music-only / silence) and every music
 * length case is shaped — via `atrim`, `apad`, and `stream_loop` filter nodes in
 * the execution layer — so the audio track spans exactly the full output. This
 * is the invariant of Property 18: "rendered audio length always equals output
 * duration" (Req 10.1, 10.2, 10.3, 10.5, 10.6, 10.7, 10.8).
 *
 * The *audible portion* (how much of that span is actually filled by the music
 * segment before padding/looping) is what differs by loop/once/truncate
 * semantics; use {@link audioAudiblePortion} for that value when building the
 * filter graph. This function intentionally returns only the rendered length.
 *
 * Reading the music segment length: see {@link resolveMusicSegmentLength}. The
 * `audio` argument is the resolved music/plan info; the music's playable segment
 * length is read from `musicDuration` (preferred), or the `musicSegmentDuration`
 * / `segmentDuration` / `trackDuration` aliases. The music segment length does
 * not affect the rendered length (which is always `outDuration`) but documents
 * the contract shared with {@link audioAudiblePortion}.
 *
 * Pure and deterministic: no I/O, no clock, no randomness.
 *
 * @param {import('../shared/constants').AudioPlan & {
 *   musicDuration?: number,
 *   musicSegmentDuration?: number,
 *   segmentDuration?: number,
 *   trackDuration?: number,
 * }} audio - The resolved audio plan / music info for this video.
 * @param {number} outDuration - The output video duration in seconds.
 * @returns {number} The rendered audio length in seconds (equals `outDuration`,
 *   clamped to 0 when `outDuration` is non-finite or negative).
 */
function audioRenderedLength(audio, outDuration) {
  // The rendered audio track always spans the full output duration, regardless
  // of music length or mode. Audio shorter than the output is padded with
  // silence (once) or looped (loop); audio longer than the output is truncated.
  return normalizeDuration(outDuration);
}

/**
 * Compute the audible music portion of the rendered audio: how many seconds of
 * the output are covered by the music segment playing, before silence padding.
 *
 * This is the companion to {@link audioRenderedLength}; the rendered length is
 * always `outDuration`, while the audible portion varies with the music segment
 * length `m`, the output duration `D`, and the loop mode:
 *
 * | case                                   | audible portion | requirement     |
 * | -------------------------------------- | --------------- | --------------- |
 * | no resolved music                      | 0               | —               |
 * | `|m - D| <= tolerance` (equal)         | `m` (play once) | 10.8            |
 * | `m > D` (longer)                       | `D` (truncate)  | 10.1, 10.7      |
 * | `m < D`, loopMode `once`               | `m` then silence| 10.6            |
 * | `m < D`, loopMode `loop` (default)     | `D` (fill)      | 10.3, 10.5      |
 *
 * The equal-within-tolerance case (Req 10.8) takes precedence over the longer
 * and shorter branches so a track essentially equal to the output plays exactly
 * once with no looping and no truncation. When the music is shorter and no loop
 * preference is set, the mode defaults to `loop` (Req 10.3) via
 * {@link resolveLoopMode}.
 *
 * Pure and deterministic.
 *
 * @param {import('../shared/constants').AudioPlan & {
 *   musicDuration?: number,
 *   musicSegmentDuration?: number,
 *   segmentDuration?: number,
 *   trackDuration?: number,
 * }} audio - The resolved audio plan / music info for this video.
 * @param {number} outDuration - The output video duration in seconds.
 * @returns {number} The audible music length in seconds, in `[0, outDuration]`.
 */
function audioAudiblePortion(audio, outDuration) {
  const outputDuration = normalizeDuration(outDuration);
  if (outputDuration === 0) {
    return 0;
  }

  const musicSegment = resolveMusicSegmentLength(audio);
  if (musicSegment === null) {
    // No music present/resolved: no music is audible (silence or original-only).
    return 0;
  }

  // Req 10.8: within the equal tolerance, play the segment exactly once with no
  // looping and no truncation. Checked first so a near-equal track is never
  // treated as "longer" (truncated) or "shorter" (looped/padded).
  if (Math.abs(musicSegment - outputDuration) <= AUDIO_EQUAL_TOLERANCE_SECONDS) {
    return musicSegment;
  }

  // Req 10.1 / 10.7: segment longer than the output is truncated to the output.
  if (musicSegment > outputDuration) {
    return outputDuration;
  }

  // Segment shorter than the output (Req 10.5 / 10.6).
  if (resolveLoopMode(audio) === 'once') {
    // Req 10.6: play once, then silence fills the remainder.
    return musicSegment;
  }
  // Req 10.3 / 10.5: loop repeats end-to-end to fill the full output duration.
  return outputDuration;
}

/**
 * Resolve the music segment length (seconds) from the audio plan/info.
 *
 * The render engine augments the audio plan with the resolved length of the
 * music that is available to play (the Waveform_Window selection, already
 * clamped to the track bounds). This reader accepts, in priority order:
 *   1. `musicDuration` — the resolved music/segment length (preferred name);
 *   2. `musicSegmentDuration` / `segmentDuration` — explicit segment aliases;
 *   3. `trackDuration` — full-track fallback when no segment is recorded.
 *
 * Returns `null` when no music is present (`hasMusic === false`) or no positive,
 * finite length is available, signalling "no audible music".
 *
 * @param {Object} audio - The resolved audio plan / music info.
 * @returns {number|null} The music segment length in seconds, or `null`.
 */
function resolveMusicSegmentLength(audio) {
  if (!audio || typeof audio !== 'object') {
    return null;
  }
  if (audio.hasMusic === false) {
    return null;
  }
  const candidates = [
    audio.musicDuration,
    audio.musicSegmentDuration,
    audio.segmentDuration,
    audio.trackDuration,
  ];
  for (const candidate of candidates) {
    if (Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolve the effective loop mode, defaulting to `loop` when unset (Req 10.3).
 * @param {Object} audio - The resolved audio plan / music info.
 * @returns {('loop'|'once')} The effective loop mode.
 */
function resolveLoopMode(audio) {
  return audio && audio.loopMode === 'once' ? 'once' : DEFAULT_LOOP_MODE;
}

/**
 * Clamp an output duration to a non-negative, finite number of seconds.
 * @param {*} duration
 * @returns {number} The duration in seconds, or 0 when non-finite/negative.
 */
function normalizeDuration(duration) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return duration;
}

/**
 * Clamp a volume to the integer percentage range [0, 100], defaulting a
 * missing/non-numeric value to full volume (100).
 * @param {*} volume
 * @returns {number} Integer volume in [0, 100].
 */
function normalizeVolume(volume) {
  if (!Number.isFinite(volume)) {
    return 100;
  }
  const rounded = Math.round(volume);
  if (rounded < 0) return 0;
  if (rounded > 100) return 100;
  return rounded;
}

/**
 * Map a recorded `audioStart` to the music seek offset used by the render plan,
 * with a safe fallback that never throws (Req 9.5, 9.6; Property 17).
 *
 * The Waveform_Window records an `audioStart` in seconds (millisecond
 * precision). The render plan seeks the music input to this offset via
 * `-ss audioStart` so playback begins at the user-selected point, accurate to
 * within 100 ms (the recorded seconds value is passed through unchanged, so the
 * mapping is exact — far inside the 100 ms tolerance of Req 9.5).
 *
 * Safe fallback (Req 9.6): when `audioStart` is absent (`undefined`/`null`),
 * non-numeric (`NaN`, `Infinity`, non-number type), or out of range
 * (`< 0`, or `> trackDuration` when a finite `trackDuration` is known), the seek
 * is 0 and planning completes without failure. This guarantees a stale,
 * malformed, or missing offset can never abort the single Compression_Pass.
 *
 * Range handling for `trackDuration`:
 *   - When `trackDuration` is a finite, non-negative number, a recorded
 *     `audioStart` is valid only within `[0, trackDuration]`; anything beyond
 *     the track end falls back to 0.
 *   - When `trackDuration` is unknown/absent (undefined, null, non-numeric, or
 *     negative), the upper bound cannot be enforced, so any finite,
 *     non-negative `audioStart` is treated as valid and passed through. Absent,
 *     non-numeric, or negative `audioStart` still falls back to 0.
 *
 * Pure and deterministic: no I/O, no clock, no randomness.
 *
 * @param {*} audioStart - The recorded audio start offset in seconds.
 * @param {*} [trackDuration] - The Music_Track total duration in seconds, when
 *   known. Used as the inclusive upper bound for `audioStart`.
 * @returns {number} The music seek offset in seconds: the recorded `audioStart`
 *   when present and in range, otherwise `0`.
 */
function audioStartOffset(audioStart, trackDuration) {
  // Absent or non-numeric (NaN, Infinity, non-number) -> safe fallback to 0.
  if (!Number.isFinite(audioStart)) {
    return 0;
  }
  // Negative offsets are always invalid -> fallback to 0.
  if (audioStart < 0) {
    return 0;
  }
  // When the track duration is known, enforce the inclusive upper bound.
  // An unknown/absent/negative trackDuration leaves the upper bound unenforced.
  if (Number.isFinite(trackDuration) && trackDuration >= 0 && audioStart > trackDuration) {
    return 0;
  }
  // In range (and within 100 ms by exact pass-through of the seconds value).
  return audioStart;
}

/**
 * Compute the music seek offset for a single split chunk, so music stays
 * continuous across chunk boundaries (Req 11.3, 11.4; Property 19).
 *
 * A video longer than the `Clip_Duration_Limit` is tiled into contiguous chunks
 * indexed by a zero-based `chunkIndex`, where chunk `i` covers the output
 * timeline `[i * clipLimit, (i + 1) * clipLimit)` (see {@link
 * ../shared/constants.ChunkRenderPlan}). Because the chunks tile the timeline
 * with no gap, overlap, or repeated frames (Req 11.2), the music offset for a
 * chunk is simply the recorded `audioStart` advanced by the wall-clock time
 * already consumed by the preceding chunks:
 *
 *   chunkAudioOffset(i) = audioStart + i * clipLimit            (Req 11.3)
 *
 * This is a single, continuously increasing offset: chunk `i + 1` begins exactly
 * where chunk `i` ended (`offset(i) + clipLimit === offset(i + 1)`), so the
 * offset never resets to `audioStart` at a boundary (Req 11.4). The returned
 * value is identical for both loop modes; `loopMode` does not change the offset
 * arithmetic — it only changes how the caller *interprets* the offset (below).
 *
 * Contract for loop vs once (the silence determination, Req 11.6/11.7, lives in
 * the caller, not here, and is computed with {@link audioAudiblePortion} against
 * the music segment length `m`):
 *
 *   - `loopMode === 'loop'`: the offset feeds a looped music input
 *     (`-stream_loop -1` in the execution layer). The logical offset advances
 *     continuously and never produces silence; wrapping is handled by the loop
 *     filter, so the music is seamless across every boundary (Req 11.4).
 *   - `loopMode === 'once'`: the music plays exactly once from `audioStart`.
 *     The caller detects "music has ended" by comparing this offset to `m`:
 *       • `offset >= m`  → the music ended in a prior chunk; this chunk is
 *         fully silent (Req 11.7).
 *       • `offset < m` and `offset + chunkDuration > m` → music plays until it
 *         ends partway through this chunk, then silence fills the remainder
 *         (Req 11.6). The audible length within the chunk is `m - offset`.
 *       • `offset + chunkDuration <= m` → the chunk is fully covered by music.
 *
 * Input normalization keeps the result pure, deterministic, and total (never
 * throws, never returns a non-finite number):
 *   - `audioStart` is normalized via the same rules as {@link audioStartOffset}
 *     (non-finite or negative → 0), since a chunk offset can never sit before
 *     the recorded start (Req 9.6 safe-fallback parity).
 *   - `chunkIndex` is floored to an integer and clamped to `>= 0`; a non-finite
 *     index falls back to 0 (the first chunk).
 *   - `clipLimit` falls back to `CLIP_DURATION_LIMIT` when non-finite or `<= 0`,
 *     matching the splitting limit used to tile the timeline.
 *   - `loopMode` is accepted for the documented contract above but does not
 *     alter the returned offset; an unset/unknown value defaults to `loop`.
 *
 * @param {*} audioStart - The recorded audio start offset in seconds.
 * @param {*} chunkIndex - The zero-based index of the chunk on the timeline.
 * @param {*} [clipLimit] - The per-chunk duration limit in seconds; defaults to
 *   `CLIP_DURATION_LIMIT`.
 * @param {('loop'|'once')} [loopMode] - The loop behavior; documented contract
 *   only, does not change the returned value. Defaults to `loop`.
 * @returns {number} The continuous music seek offset (seconds) for the chunk:
 *   `audioStart + chunkIndex * clipLimit`.
 */
function chunkAudioOffset(audioStart, chunkIndex, clipLimit, loopMode) {
  // Normalize the base start with the same safe-fallback rules as the
  // single-clip seek mapping: absent/non-numeric/negative -> 0.
  const start = audioStartOffset(audioStart);

  // Floor the index to an integer and clamp negatives/non-finite to the first
  // chunk so the offset can never precede `start`.
  let index = 0;
  if (Number.isFinite(chunkIndex)) {
    index = Math.floor(chunkIndex);
    if (index < 0) {
      index = 0;
    }
  }

  // Fall back to the configured splitting limit when no valid limit is given.
  const limit =
    Number.isFinite(clipLimit) && clipLimit > 0 ? clipLimit : CLIP_DURATION_LIMIT;

  // The continuous offset: advances by one full chunk per index, identical for
  // both loop modes. `loopMode` is part of the caller-facing contract (see the
  // doc comment) but intentionally does not change this arithmetic.
  return start + index * limit;
}

module.exports = {
  planAudio,
  audioRenderedLength,
  audioAudiblePortion,
  audioStartOffset,
  chunkAudioOffset,
  AUDIO_MODE,
};
