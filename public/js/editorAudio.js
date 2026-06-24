/**
 * StatusDrop in-app video editor — audio panel (browser side).
 *
 * Task 13.1: the audio editing tools that operate on an EditorInstance's
 * `audio` recipe state. Implements:
 *   - a mute toggle for the original video audio (default UNMUTED, Req 7.1),
 *   - enforcement of EXACTLY ONE Music_Track (a second add is rejected, the
 *     existing track is retained, an indication is returned — Req 7.2/7.10),
 *   - independent original/music volume levels as integers 0..100 (Req 7.3),
 *   - loopMode "loop"/"once" with default "loop" (Req 10.4),
 * all recorded in the Edit_Recipe `audio` block (Req 7.4).
 *
 * Architectural invariant (Req 2.1): nothing here decodes/re-renders the source
 * video; the audio tools only mutate the small JSON recipe state on an
 * EditorInstance (created by public/js/editor.js) and call markDirty().
 *
 * The waveform window + source picker (task 13.3), the music upload flow
 * (task 13.5), and recipe submission wiring (task 13.7) are intentionally NOT
 * implemented here.
 *
 * The audio mutation functions are written as pure, instance-operating helpers
 * (setMuted, setOriginalVolume, addMusicTrack, setMusicVolume, setLoopMode, ...)
 * so they are fully unit/property testable WITHOUT a real DOM (task 13.2). The
 * browser tool layer (`audioToolInitializer`/`registerAudioTools`) only
 * translates DOM events into calls to those same helpers, and degrades to
 * "model-only" when no DOM/surface is present.
 *
 * UMD wrapper: attaches to `window.StatusDropEditorAudio` in the browser and
 * exports via CommonJS so the helpers can be required under the
 * node:test + fast-check harness, consistent with public/js/editor.js.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.10, 10.4
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StatusDropEditorAudio = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ==========================================================================
   * Mirrored constants.
   *
   * The browser cannot require() the CommonJS module at src/shared/constants.js,
   * so the relevant numeric limits/defaults are mirrored here. These values MUST
   * be kept in sync with src/shared/constants.js (RECIPE_LIMITS, DEFAULT_LOOP_MODE)
   * and with public/js/editor.js (LIMITS, DEFAULT_LOOP_MODE).
   * ======================================================================== */

  /** Volume percentage range (integer, inclusive) — mirrors RECIPE_LIMITS. */
  var VOLUME_MIN = 0;
  var VOLUME_MAX = 100;

  /** Default Loop_Mode when a Music_Track is shorter than the video (Req 10.3/10.4). */
  var DEFAULT_LOOP_MODE = 'loop';

  /** The two valid Loop_Mode values (Req 10.4). */
  var LOOP_MODES = Object.freeze({ LOOP: 'loop', ONCE: 'once' });

  /** The two valid Music_Track sources (Req 8.1/8.2). */
  var MUSIC_SOURCES = Object.freeze({ UPLOAD: 'upload', LIBRARY: 'library' });

  /** Exactly one Music_Track is allowed (Req 7.2/7.10). */
  var MAX_MUSIC_TRACKS = 1;

  /** Default original audio volume — unmuted at full volume (Req 7.1/7.3). */
  var DEFAULT_ORIGINAL_VOLUME = VOLUME_MAX;

  /** Default Music_Track volume applied when none is supplied (Req 7.3). */
  var DEFAULT_MUSIC_VOLUME = 80;

  /**
   * Configured clip length (seconds) used as the default Waveform_Window length
   * ceiling (Req 9.1). Mirrors CLIP_DURATION_LIMIT in src/shared/constants.js.
   */
  var CLIP_DURATION_LIMIT = 29;

  /**
   * Maximum Waveform_Window drag increment in milliseconds (Req 9.2): dragging
   * sets audioStart in increments of no more than 100 ms.
   */
  var WAVEFORM_STEP_MS = 100;

  /**
   * Deadline (ms) within which the waveform must be displayed once a track is
   * selected (Req 9.1). The DOM layer renders synchronously, well inside this.
   */
  var WAVEFORM_DISPLAY_DEADLINE_MS = 500;

  /* ==========================================================================
   * Pure value helpers — no DOM, no EditorInstance dependency.
   * ======================================================================== */

  /**
   * Clamp a numeric value to an inclusive [min, max] range. Non-finite input
   * falls back to `min` so callers never record NaN/Infinity.
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function clamp(value, min, max) {
    var n = Number(value);
    if (!isFinite(n)) return min;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  /**
   * Clamp and round a volume to an integer percentage in [0, 100] (Req 7.3).
   * Mirrors `clampVolume` in public/js/editor.js exactly.
   * @param {number} value
   * @returns {number} Integer in [0, 100].
   */
  function clampVolume(value) {
    return Math.round(clamp(value, VOLUME_MIN, VOLUME_MAX));
  }

  /**
   * Normalize a Loop_Mode value to "loop" or "once" (Req 10.4). Anything other
   * than the exact string "once" maps to the default "loop" (Req 10.3).
   * @param {string} mode
   * @returns {('loop'|'once')}
   */
  function normalizeLoopMode(mode) {
    return mode === LOOP_MODES.ONCE ? LOOP_MODES.ONCE : LOOP_MODES.LOOP;
  }

  /**
   * Normalize a Music_Track source to "upload" or "library" (Req 8.1/8.2).
   * Anything other than the exact string "library" maps to "upload".
   * @param {string} source
   * @returns {('upload'|'library')}
   */
  function normalizeSource(source) {
    return source === MUSIC_SOURCES.LIBRARY ? MUSIC_SOURCES.LIBRARY : MUSIC_SOURCES.UPLOAD;
  }

  /**
   * Coerce an audio start offset to a finite, non-negative number of seconds.
   * Out-of-range/absent values fall back to 0 (the render engine applies its own
   * 0-fallback too, Req 9.6); the waveform tool (task 13.3) refines this later.
   * @param {number} value
   * @returns {number} Seconds, >= 0.
   */
  function sanitizeAudioStart(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return 0;
    return n;
  }

  /**
   * Build a complete, in-range Music_Track recipe entry from partial props
   * (Req 7.4). Every recorded value is clamped/normalized into range so a
   * recorded track is always a valid recipe `audio.music` block: volume to
   * [0,100] integer, source to upload/library, loopMode to loop/once, audioStart
   * to a non-negative number.
   *
   * Does NOT validate that the asset exists/is uploaded — that is the upload
   * flow's responsibility (task 13.5) and the server Recipe_Validator's (Req 3.6).
   *
   * @param {Object} props - { assetRef, source, volume, audioStart, loopMode }
   * @returns {Object} A normalized MusicConfig entry.
   */
  function buildMusicConfig(props) {
    props = props || {};
    return {
      assetRef: props.assetRef,
      source: normalizeSource(props.source),
      volume: clampVolume(props.volume != null ? props.volume : DEFAULT_MUSIC_VOLUME),
      audioStart: sanitizeAudioStart(props.audioStart != null ? props.audioStart : 0),
      loopMode: normalizeLoopMode(props.loopMode != null ? props.loopMode : DEFAULT_LOOP_MODE),
    };
  }

  /** Deep-copy a MusicConfig so callers never receive a mutable internal ref. */
  function cloneMusicConfig(m) {
    if (!m) return null;
    return {
      assetRef: m.assetRef,
      source: m.source,
      volume: m.volume,
      audioStart: m.audioStart,
      loopMode: m.loopMode || DEFAULT_LOOP_MODE,
    };
  }

  /* ==========================================================================
   * EditorInstance audio helpers (the testable core of the audio panel).
   *
   * Each helper takes the EditorInstance (from public/js/editor.js) as its first
   * argument, reads/writes `instance.audio`, and calls `instance.markDirty()` on
   * a state change so the recipe is emitted (untouched audio leaves the video
   * skipped, Req 1.2). They never touch the DOM, so they are fully testable.
   *
   * `instance.audio` shape (initialized by EditorInstance):
   *   { originalMuted: boolean, originalVolume: number, music: MusicConfig|null }
   * ======================================================================== */

  /**
   * Ensure `instance.audio` exists with in-range defaults. Defensive so the
   * helpers work even if called against a bare object in a test.
   * @param {Object} instance
   * @returns {Object} instance.audio
   */
  function ensureAudio(instance) {
    if (!instance.audio || typeof instance.audio !== 'object') {
      instance.audio = {
        originalMuted: false,
        originalVolume: DEFAULT_ORIGINAL_VOLUME,
        music: null,
      };
    }
    return instance.audio;
  }

  /** Call instance.markDirty() if available. */
  function markDirty(instance) {
    if (instance && typeof instance.markDirty === 'function') instance.markDirty();
  }

  /**
   * Toggle the original video audio between muted and unmuted (Req 7.1). The
   * default state of a fresh EditorInstance is UNMUTED (originalMuted=false).
   * @param {Object} instance - The EditorInstance.
   * @param {boolean} muted - true to mute the original audio, false to unmute.
   * @returns {boolean} The recorded mute state.
   */
  function setMuted(instance, muted) {
    var audio = ensureAudio(instance);
    audio.originalMuted = !!muted;
    markDirty(instance);
    return audio.originalMuted;
  }

  /** @returns {boolean} The recorded original-audio mute state (Req 7.4). */
  function isMuted(instance) {
    return !!ensureAudio(instance).originalMuted;
  }

  /**
   * Set the original video audio volume (Req 7.3). The value is clamped and
   * rounded to an integer in [0, 100] before being recorded (Req 7.4).
   * @param {Object} instance - The EditorInstance.
   * @param {number} volume - Desired volume percentage.
   * @returns {number} The recorded integer volume in [0, 100].
   */
  function setOriginalVolume(instance, volume) {
    var audio = ensureAudio(instance);
    audio.originalVolume = clampVolume(volume);
    markDirty(instance);
    return audio.originalVolume;
  }

  /** @returns {number} The recorded original-audio volume in [0, 100]. */
  function getOriginalVolume(instance) {
    return clampVolume(ensureAudio(instance).originalVolume);
  }

  /** @returns {boolean} Whether a Music_Track is currently present (Req 7.2). */
  function hasMusic(instance) {
    return !!ensureAudio(instance).music;
  }

  /** @returns {Object|null} A clone of the recorded Music_Track, or null. */
  function getMusic(instance) {
    return cloneMusicConfig(ensureAudio(instance).music);
  }

  /**
   * Add exactly one Music_Track to mix with the original audio (Req 7.2). If a
   * Music_Track is ALREADY present, the addition is rejected, the existing track
   * is retained unchanged, and an indication is returned (Req 7.10). A new track
   * requires a non-empty `assetRef`; every recorded value is clamped/normalized
   * into range (Req 7.4).
   *
   * @param {Object} instance - The EditorInstance.
   * @param {Object} props - { assetRef, source, volume, audioStart, loopMode }
   * @returns {{ok:true, music:Object}|{ok:false, error:string, music:(Object|null)}}
   *   On success, `music` is the newly recorded track. On rejection, `music` is
   *   the retained existing track (or null when the rejection is `invalid_asset`).
   */
  function addMusicTrack(instance, props) {
    var audio = ensureAudio(instance);
    props = props || {};

    // Req 7.10: only one Music_Track is allowed — reject and retain the existing.
    if (audio.music) {
      return { ok: false, error: 'music_exists', music: cloneMusicConfig(audio.music) };
    }
    // A track must reference an asset (the upload/library flow supplies this).
    if (typeof props.assetRef !== 'string' || props.assetRef.length === 0) {
      return { ok: false, error: 'invalid_asset', music: null };
    }

    audio.music = buildMusicConfig(props);
    markDirty(instance);
    return { ok: true, music: cloneMusicConfig(audio.music) };
  }

  /**
   * Remove the current Music_Track if present (returns to original-only/silence
   * audio). Recipe-model primitive used by the source picker/upload flow
   * (tasks 13.3/13.5) and by tests; keeps single-track enforcement symmetric.
   * @param {Object} instance - The EditorInstance.
   * @returns {boolean} Whether a track was removed.
   */
  function removeMusicTrack(instance) {
    var audio = ensureAudio(instance);
    if (!audio.music) return false;
    audio.music = null;
    markDirty(instance);
    return true;
  }

  /**
   * Set the Music_Track volume (Req 7.3). Clamped/rounded to an integer in
   * [0, 100] (Req 7.4). Requires a Music_Track to be present; otherwise the call
   * is a no-op that returns an indication.
   * @param {Object} instance - The EditorInstance.
   * @param {number} volume - Desired music volume percentage.
   * @returns {{ok:true, volume:number}|{ok:false, error:string}}
   */
  function setMusicVolume(instance, volume) {
    var audio = ensureAudio(instance);
    if (!audio.music) return { ok: false, error: 'no_music' };
    audio.music.volume = clampVolume(volume);
    markDirty(instance);
    return { ok: true, volume: audio.music.volume };
  }

  /**
   * Set the Loop_Mode for the current Music_Track to "loop" or "once" (Req 10.4),
   * retaining it as the preference for that track. Any value other than "once"
   * normalizes to the default "loop" (Req 10.3). Requires a Music_Track to be
   * present; otherwise the call is a no-op that returns an indication.
   * @param {Object} instance - The EditorInstance.
   * @param {('loop'|'once')} mode
   * @returns {{ok:true, loopMode:string}|{ok:false, error:string}}
   */
  function setLoopMode(instance, mode) {
    var audio = ensureAudio(instance);
    if (!audio.music) return { ok: false, error: 'no_music' };
    audio.music.loopMode = normalizeLoopMode(mode);
    markDirty(instance);
    return { ok: true, loopMode: audio.music.loopMode };
  }

  /** @returns {('loop'|'once'|null)} The current track's Loop_Mode, or null. */
  function getLoopMode(instance) {
    var audio = ensureAudio(instance);
    return audio.music ? normalizeLoopMode(audio.music.loopMode) : null;
  }

  /* ==========================================================================
   * Waveform_Window selection + music source picker (task 13.3).
   *
   * Pure, instance-operating helpers for picking the audio segment via a
   * draggable Waveform_Window (Req 9.1–9.4) and for choosing the Music_Track
   * source (upload vs library, Req 8.1/8.2). As with the rest of the audio
   * panel, all recording logic lives in these DOM-free helpers so the math is
   * fully unit/property testable (task 13.4); the browser picker layer below
   * only translates DOM events into calls to them.
   * ======================================================================== */

  /**
   * Round a time value (seconds) to millisecond precision so a recorded
   * `audioStart` is expressed in seconds with ms precision (Req 9.4) and never
   * carries binary-float noise (e.g. 12.30000000001 -> 12.3).
   * @param {number} value
   * @returns {number} Seconds rounded to 3 decimal places, or 0 for bad input.
   */
  function roundToMsPrecision(value) {
    var n = Number(value);
    if (!isFinite(n)) return 0;
    return Math.round(n * 1000) / 1000;
  }

  /**
   * Compute the default Waveform_Window for a freshly selected Music_Track
   * (Req 9.1): offset 0 with a selected length equal to the lesser of the
   * configured clip length and the track's total duration. Negative/non-finite
   * inputs are treated as 0 so the window is always valid.
   * @param {number} clipLength - Configured clip length in seconds (e.g. 29).
   * @param {number} trackDuration - Music_Track total duration in seconds.
   * @returns {{offset:number, length:number}} `{ offset: 0, length: min(clip, dur) }`.
   */
  function defaultWaveformWindow(clipLength, trackDuration) {
    var clip = Number(clipLength);
    var dur = Number(trackDuration);
    if (!isFinite(clip) || clip < 0) clip = 0;
    if (!isFinite(dur) || dur < 0) dur = 0;
    return { offset: 0, length: Math.min(clip, dur) };
  }

  /**
   * Clamp a requested Waveform_Window offset to the valid range
   * `[0, trackDuration - selectedLength]` (Req 9.2/9.3): a selection may not
   * extend before the start (offset < 0) or past the end (offset + length >
   * total duration). When the window is at least as long as the track the only
   * valid offset is 0.
   * @param {number} offset - Requested start offset in seconds.
   * @param {number} trackDuration - Music_Track total duration in seconds.
   * @param {number} selectedLength - Selected window length in seconds.
   * @returns {number} The nearest in-range offset in seconds.
   */
  function clampWaveformOffset(offset, trackDuration, selectedLength) {
    var dur = Number(trackDuration);
    var len = Number(selectedLength);
    if (!isFinite(dur) || dur < 0) dur = 0;
    if (!isFinite(len) || len < 0) len = 0;
    var max = dur - len;
    if (!(max > 0)) max = 0;
    return clamp(offset, 0, max);
  }

  /**
   * Quantize a time value (seconds) to a step grid expressed in milliseconds
   * (Req 9.2): dragging the window sets the offset in increments of no more than
   * `stepMs` (default 100 ms). The result is also rounded to ms precision.
   * @param {number} value - Time in seconds.
   * @param {number} [stepMs] - Step size in milliseconds (default 100).
   * @returns {number} The quantized time in seconds (ms precision).
   */
  function quantizeToMs(value, stepMs) {
    var step = Number(stepMs);
    if (!isFinite(step) || step <= 0) step = WAVEFORM_STEP_MS;
    var n = Number(value);
    if (!isFinite(n)) return 0;
    var stepSeconds = step / 1000;
    return roundToMsPrecision(Math.round(n / stepSeconds) * stepSeconds);
  }

  /**
   * Record the Waveform_Window's selected audio start offset into the recipe
   * on drag release (Req 9.4). The requested offset is clamped to
   * `[0, trackDuration - selectedLength]` (Req 9.3), quantized to a 100 ms grid
   * (Req 9.2), re-clamped (so rounding can never push it past the end), and
   * stored in `instance.audio.music.audioStart` in seconds with ms precision.
   * Requires a Music_Track to be present; otherwise it is a no-op indication.
   *
   * @param {Object} instance - The EditorInstance.
   * @param {number} offsetSeconds - Requested start offset (seconds) from the drag.
   * @param {number} trackDuration - Music_Track total duration in seconds.
   * @param {number} selectedLength - Selected window length in seconds.
   * @returns {{ok:true, audioStart:number}|{ok:false, error:string}}
   */
  function setAudioStart(instance, offsetSeconds, trackDuration, selectedLength) {
    var audio = ensureAudio(instance);
    if (!audio.music) return { ok: false, error: 'no_music' };
    var clamped = clampWaveformOffset(offsetSeconds, trackDuration, selectedLength);
    var quantized = quantizeToMs(clamped, WAVEFORM_STEP_MS);
    // Re-clamp: a quantize step could round just past the valid maximum.
    var recorded = roundToMsPrecision(
      clampWaveformOffset(quantized, trackDuration, selectedLength)
    );
    audio.music.audioStart = recorded;
    markDirty(instance);
    return { ok: true, audioStart: recorded };
  }

  /** @returns {number} The recorded music audioStart in seconds (0 when none). */
  function getAudioStart(instance) {
    var audio = ensureAudio(instance);
    return audio.music ? sanitizeAudioStart(audio.music.audioStart) : 0;
  }

  /**
   * Set the source of the current Music_Track to "upload" or "library"
   * (Req 8.1/8.2). Any value other than "library" normalizes to "upload".
   * Requires a Music_Track to be present; otherwise a no-op indication.
   * @param {Object} instance - The EditorInstance.
   * @param {('upload'|'library')} source
   * @returns {{ok:true, source:string}|{ok:false, error:string}}
   */
  function setMusicSource(instance, source) {
    var audio = ensureAudio(instance);
    if (!audio.music) return { ok: false, error: 'no_music' };
    audio.music.source = normalizeSource(source);
    markDirty(instance);
    return { ok: true, source: audio.music.source };
  }

  /** @returns {('upload'|'library'|null)} The current track's source, or null. */
  function getMusicSource(instance) {
    var audio = ensureAudio(instance);
    return audio.music ? normalizeSource(audio.music.source) : null;
  }

  /**
   * Select a Music_Track from a source (upload or library) and initialize its
   * Waveform_Window to the default (offset 0, length = min(clipLength,
   * trackDuration), Req 9.1). This is the recipe-model primitive the source
   * picker drives: it adds the track via {@link addMusicTrack} (so the
   * single-track rule of Req 7.10 is enforced — a second selection while a track
   * is present is rejected and the existing track retained) and, on success,
   * records the default audioStart of 0.
   *
   * @param {Object} instance - The EditorInstance.
   * @param {Object} props - { assetRef, source, volume, loopMode, trackDuration }
   * @param {number} [clipLength] - Configured clip length (default CLIP_DURATION_LIMIT).
   * @returns {{ok:true, music:Object, window:{offset:number,length:number}}|{ok:false, error:string, music:(Object|null)}}
   */
  function selectMusicTrack(instance, props, clipLength) {
    props = props || {};
    var clip = clipLength != null ? clipLength : CLIP_DURATION_LIMIT;
    var trackDuration = Number(props.trackDuration);
    var result = addMusicTrack(instance, {
      assetRef: props.assetRef,
      source: props.source,
      volume: props.volume,
      audioStart: 0, // default window offset (Req 9.1)
      loopMode: props.loopMode,
    });
    if (!result.ok) return result;
    var win = defaultWaveformWindow(clip, trackDuration);
    // audioStart defaults to the window offset (0). Record it through the same
    // clamp/quantize path so the value is always a valid recorded start.
    setAudioStart(instance, win.offset, trackDuration, win.length);
    return { ok: true, music: getMusic(instance), window: win };
  }

  /* ==========================================================================
   * Browser audio tool layer (DOM).
   *
   * A tool initializer suitable for VideoEditorController#registerTool, mirroring
   * overlayToolInitializer/trimToolInitializer in public/js/editor.js. It builds
   * the audio panel UI (mute toggle, original + music volume sliders, loop/once
   * control, and a one-track indication) onto each per-video surface's toolbar,
   * and degrades to model-only when there is no DOM/surface.
   *
   * Register with `controller.registerTool(audioToolInitializer(opts))`, or call
   * `registerAudioTools(controller, opts)` for the common case.
   * ======================================================================== */

  /**
   * Create a tool initializer that wires the audio panel onto each per-video
   * surface. The returned function has the signature `(instance, surface,
   * controller)` expected by VideoEditorController#registerTool.
   *
   * @param {Object} [opts]
   * @param {Document} [opts.document] - Document used to build DOM (browser).
   * @returns {Function} initializer (instance, surface, controller) => void
   */
  function audioToolInitializer(opts) {
    opts = opts || {};

    return function initAudioTool(instance, surface, controller) {
      var doc = (controller && controller._document) || opts.document
        || (typeof document !== 'undefined' ? document : null);
      // No DOM surface -> the audio tool is model-only (still fully functional
      // via the instance helpers above). Graceful degradation (Req 15.x style).
      if (!doc || !surface || !surface.toolbar) return;

      // ---- Panel scaffold ------------------------------------------------
      var panel = doc.createElement('div');
      panel.className = 'editor-audio-panel';

      // Mute toggle (Req 7.1) — reflects the default UNMUTED state.
      var muteLabel = doc.createElement('label');
      muteLabel.className = 'editor-audio-mute';
      var muteToggle = doc.createElement('input');
      muteToggle.type = 'checkbox';
      muteToggle.className = 'editor-audio-mute-toggle';
      muteToggle.checked = isMuted(instance);
      var muteText = doc.createElement('span');
      muteText.textContent = 'Mute original audio';
      muteLabel.appendChild(muteToggle);
      muteLabel.appendChild(muteText);

      // Original audio volume slider (Req 7.3).
      var origVol = doc.createElement('input');
      origVol.type = 'range';
      origVol.className = 'editor-audio-original-volume';
      origVol.min = String(VOLUME_MIN);
      origVol.max = String(VOLUME_MAX);
      origVol.step = '1';
      origVol.value = String(getOriginalVolume(instance));
      var origVolLabel = doc.createElement('label');
      origVolLabel.className = 'editor-audio-original-volume-label';
      origVolLabel.appendChild(doc.createTextNode('Original volume'));
      origVolLabel.appendChild(origVol);

      // Music section: volume slider + loop/once control, shown when a track is
      // present. The source picker / waveform / upload live in tasks 13.3/13.5.
      var musicVol = doc.createElement('input');
      musicVol.type = 'range';
      musicVol.className = 'editor-audio-music-volume';
      musicVol.min = String(VOLUME_MIN);
      musicVol.max = String(VOLUME_MAX);
      musicVol.step = '1';
      var musicVolLabel = doc.createElement('label');
      musicVolLabel.className = 'editor-audio-music-volume-label';
      musicVolLabel.appendChild(doc.createTextNode('Music volume'));
      musicVolLabel.appendChild(musicVol);

      var loopSelect = doc.createElement('select');
      loopSelect.className = 'editor-audio-loop-mode';
      var loopOpt = doc.createElement('option');
      loopOpt.value = LOOP_MODES.LOOP;
      loopOpt.textContent = 'Loop';
      var onceOpt = doc.createElement('option');
      onceOpt.value = LOOP_MODES.ONCE;
      onceOpt.textContent = 'Play once';
      loopSelect.appendChild(loopOpt);
      loopSelect.appendChild(onceOpt);
      var loopLabel = doc.createElement('label');
      loopLabel.className = 'editor-audio-loop-label';
      loopLabel.appendChild(doc.createTextNode('When shorter than video'));
      loopLabel.appendChild(loopSelect);

      var musicSection = doc.createElement('div');
      musicSection.className = 'editor-audio-music-section';
      musicSection.appendChild(musicVolLabel);
      musicSection.appendChild(loopLabel);

      // One-track indication (Req 7.10): shown when a second add is rejected.
      var indicator = doc.createElement('div');
      indicator.className = 'editor-audio-music-indicator';
      indicator.setAttribute('role', 'alert');
      indicator.style.display = 'none';
      indicator.textContent = 'Only one music track is allowed';

      panel.appendChild(muteLabel);
      panel.appendChild(origVolLabel);
      panel.appendChild(musicSection);
      panel.appendChild(indicator);
      surface.toolbar.appendChild(panel);

      // ---- Sync DOM <- recipe state -------------------------------------
      function syncPanel() {
        muteToggle.checked = isMuted(instance);
        origVol.value = String(getOriginalVolume(instance));
        var music = ensureAudio(instance).music;
        if (music) {
          musicSection.style.display = '';
          musicVol.value = String(clampVolume(music.volume));
          loopSelect.value = normalizeLoopMode(music.loopMode);
        } else {
          musicSection.style.display = 'none';
        }
      }

      function flashIndicator(show) {
        indicator.style.display = show ? '' : 'none';
      }

      // ---- DOM events -> instance helpers -------------------------------
      if (muteToggle.addEventListener) {
        muteToggle.addEventListener('change', function () {
          setMuted(instance, !!muteToggle.checked);
        });
      }
      if (origVol.addEventListener) {
        origVol.addEventListener('input', function () {
          setOriginalVolume(instance, origVol.value);
        });
      }
      if (musicVol.addEventListener) {
        musicVol.addEventListener('input', function () {
          setMusicVolume(instance, musicVol.value);
        });
      }
      if (loopSelect.addEventListener) {
        loopSelect.addEventListener('change', function () {
          setLoopMode(instance, loopSelect.value);
        });
      }

      // Expose hooks so the source picker/upload flow (tasks 13.3/13.5) can add
      // a track and refresh the panel, surfacing the one-track indication when a
      // second add is rejected (Req 7.10).
      instance._syncAudioPanel = syncPanel;
      instance._addMusicViaPanel = function (props) {
        var result = addMusicTrack(instance, props);
        flashIndicator(!result.ok && result.error === 'music_exists');
        syncPanel();
        return result;
      };

      syncPanel();
    };
  }

  /**
   * Register the audio tool on a controller (convenience wrapper), mirroring
   * registerOverlayTools/registerTrimTool in public/js/editor.js.
   * @param {Object} controller - A VideoEditorController.
   * @param {Object} [opts] - See {@link audioToolInitializer}.
   * @returns {Object} controller
   */
  function registerAudioTools(controller, opts) {
    if (controller && typeof controller.registerTool === 'function') {
      controller.registerTool(audioToolInitializer(opts));
    }
    return controller;
  }

  /* ==========================================================================
   * Music source picker + waveform tool layer (DOM, task 13.3).
   *
   * A second tool initializer (mounted alongside audioToolInitializer) that adds
   * a music source picker — a list of Royalty_Free_Library tracks plus an
   * "Upload your own" option (Req 8.1/8.2) — and, once a track is selected, a
   * draggable Waveform_Window over a simple waveform placeholder (Req 9.1–9.4).
   *
   * The upload FLOW itself (presign/PUT/retry) is task 13.5; this layer only
   * surfaces the upload OPTION and invokes an injected `onUploadRequested`
   * callback so 13.5 can wire it. Library tracks are fetched from GET /api/library.
   *
   * Like every other initializer here, it degrades to "model-only" when there is
   * no DOM/surface: the waveform/source helpers above remain fully usable.
   * ======================================================================== */

  /**
   * Default library fetcher: GET /api/library via the global `fetch`, returning
   * the array of `{ id, title, artist, duration, url }` library tracks. Resolves
   * to an empty list when fetch is unavailable or the request fails, so the
   * picker still renders (with only the upload option) and never throws.
   * @returns {Promise<Array>}
   */
  function defaultFetchLibrary() {
    if (typeof fetch !== 'function') return Promise.resolve([]);
    return fetch('/api/library')
      .then(function (res) { return res && res.ok ? res.json() : []; })
      .then(function (list) { return Array.isArray(list) ? list : []; })
      .catch(function () { return []; });
  }

  /**
   * Create a tool initializer (suitable for {@link VideoEditorController#registerTool})
   * that wires the music source picker and Waveform_Window onto each per-video
   * surface. The returned function has the `(instance, surface, controller)`
   * signature the controller invokes for every video.
   *
   * @param {Object} [opts]
   * @param {Document} [opts.document] - Document used to build DOM (browser).
   * @param {number} [opts.clipLength] - Configured clip length seconds (default 29).
   * @param {() => Promise<Array>} [opts.fetchLibrary] - Library fetcher (default GET /api/library).
   * @param {(instance:Object) => void} [opts.onUploadRequested] - Hook for the
   *   upload option; the actual upload flow is task 13.5.
   * @returns {Function} initializer (instance, surface, controller) => void
   */
  function musicPickerToolInitializer(opts) {
    opts = opts || {};
    var clipLength = opts.clipLength != null ? opts.clipLength : CLIP_DURATION_LIMIT;
    var fetchLibrary = typeof opts.fetchLibrary === 'function' ? opts.fetchLibrary : defaultFetchLibrary;
    var onUploadRequested = typeof opts.onUploadRequested === 'function' ? opts.onUploadRequested : null;

    return function initMusicPicker(instance, surface, controller) {
      var doc = (controller && controller._document) || opts.document
        || (typeof document !== 'undefined' ? document : null);
      // No DOM surface -> model-only (helpers above remain fully usable).
      if (!doc || !surface || !surface.toolbar) return;

      // ---- Panel scaffold ------------------------------------------------
      var panel = doc.createElement('div');
      panel.className = 'editor-music-picker';

      var heading = doc.createElement('div');
      heading.className = 'editor-music-picker-heading';
      heading.textContent = 'Add music';
      panel.appendChild(heading);

      // Source list: library tracks + an upload option (Req 8.1/8.2).
      var sourceList = doc.createElement('div');
      sourceList.className = 'editor-music-source-list';
      panel.appendChild(sourceList);

      var uploadBtn = doc.createElement('button');
      uploadBtn.type = 'button';
      uploadBtn.className = 'editor-music-source editor-music-source-upload';
      uploadBtn.setAttribute('data-source', MUSIC_SOURCES.UPLOAD);
      uploadBtn.textContent = 'Upload your own audio';
      sourceList.appendChild(uploadBtn);

      // Waveform area (rendered/shown when a track is selected, Req 9.1).
      var waveform = doc.createElement('div');
      waveform.className = 'editor-waveform';
      waveform.style.position = 'relative';
      waveform.style.display = 'none';
      var waveformTrack = doc.createElement('div');
      waveformTrack.className = 'editor-waveform-track';
      var windowEl = doc.createElement('div');
      windowEl.className = 'editor-waveform-window';
      windowEl.style.position = 'absolute';
      windowEl.style.left = '0%';
      windowEl.setAttribute('role', 'slider');
      windowEl.setAttribute('aria-label', 'Audio segment start');
      waveform.appendChild(waveformTrack);
      waveform.appendChild(windowEl);
      panel.appendChild(waveform);

      surface.toolbar.appendChild(panel);

      // Per-instance Waveform_Window state (offset/length/duration in seconds).
      instance._waveformWindow = { offset: 0, length: 0, trackDuration: 0 };

      /**
       * Render the Waveform_Window for the currently selected track at offset 0
       * with the default length (Req 9.1). Called synchronously on selection, so
       * the waveform is shown well within the 500 ms deadline.
       */
      function showWaveform(trackDuration) {
        var win = defaultWaveformWindow(clipLength, trackDuration);
        instance._waveformWindow = {
          offset: win.offset,
          length: win.length,
          trackDuration: Number(trackDuration) || 0,
        };
        waveform.style.display = '';
        var dur = instance._waveformWindow.trackDuration;
        var widthPct = dur > 0 ? Math.min(100, (win.length / dur) * 100) : 100;
        windowEl.style.width = widthPct + '%';
        windowEl.style.left = '0%';
      }

      function syncWindowEl() {
        var w = instance._waveformWindow;
        var dur = w.trackDuration;
        var leftPct = dur > 0 ? Math.max(0, Math.min(100, (w.offset / dur) * 100)) : 0;
        windowEl.style.left = leftPct + '%';
      }

      // ---- Source selection -> add track + show waveform ----------------
      function chooseTrack(props) {
        // Prefer the audio panel's hook (flashes the one-track indicator on a
        // rejected second add, Req 7.10) when present, else add directly.
        var result;
        if (typeof instance._addMusicViaPanel === 'function') {
          result = instance._addMusicViaPanel({
            assetRef: props.assetRef,
            source: props.source,
            volume: props.volume,
            audioStart: 0,
            loopMode: props.loopMode,
          });
        } else {
          result = addMusicTrack(instance, {
            assetRef: props.assetRef,
            source: props.source,
            audioStart: 0,
          });
        }
        if (result && result.ok) {
          showWaveform(props.trackDuration);
          // Record the default offset (0) through the clamp/quantize path.
          setAudioStart(instance, 0, instance._waveformWindow.trackDuration, instance._waveformWindow.length);
        }
        return result;
      }

      function addLibraryButton(track) {
        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'editor-music-source editor-music-source-library';
        btn.setAttribute('data-source', MUSIC_SOURCES.LIBRARY);
        btn.setAttribute('data-asset-ref', String(track.id));
        btn.textContent = (track.title || track.id) + (track.artist ? ' — ' + track.artist : '');
        if (btn.addEventListener) {
          btn.addEventListener('click', function () {
            chooseTrack({
              assetRef: track.id,
              source: MUSIC_SOURCES.LIBRARY,
              trackDuration: track.duration,
            });
          });
        }
        // Insert library tracks before the upload option.
        sourceList.insertBefore(btn, uploadBtn);
      }

      if (uploadBtn.addEventListener) {
        uploadBtn.addEventListener('click', function () {
          // The upload flow (presign/PUT/validate/retry) is task 13.5; here we
          // only surface the option and hand off to the injected hook.
          if (onUploadRequested) onUploadRequested(instance);
        });
      }

      // Populate the library list (Req 8.2). Failures degrade to upload-only.
      Promise.resolve(fetchLibrary())
        .then(function (tracks) {
          (Array.isArray(tracks) ? tracks : []).forEach(addLibraryButton);
        })
        .catch(function () { /* upload-only fallback */ });

      // ---- Waveform_Window drag (Req 9.2/9.3/9.4) -----------------------
      // Translate a horizontal drag of the window into an offset within
      // [0, trackDuration - length], committing on release with ms precision.
      var dragging = false;

      function rectOf(el) {
        return el && typeof el.getBoundingClientRect === 'function'
          ? el.getBoundingClientRect()
          : { left: 0, width: 0 };
      }

      function offsetFromClientX(clientX) {
        var rect = rectOf(waveform);
        var width = rect.width || 0;
        var w = instance._waveformWindow;
        var dur = w.trackDuration;
        if (width <= 0 || dur <= 0) return 0;
        // Center the window under the pointer, then convert px -> seconds.
        var winWidthPx = dur > 0 ? (w.length / dur) * width : 0;
        var leftPx = (Number(clientX) - rect.left) - winWidthPx / 2;
        var frac = leftPx / width;
        return clampWaveformOffset(frac * dur, dur, w.length);
      }

      function previewOffset(clientX) {
        var w = instance._waveformWindow;
        w.offset = clampWaveformOffset(quantizeToMs(offsetFromClientX(clientX), WAVEFORM_STEP_MS), w.trackDuration, w.length);
        syncWindowEl();
      }

      function commitOffset(clientX) {
        var w = instance._waveformWindow;
        var result = setAudioStart(instance, offsetFromClientX(clientX), w.trackDuration, w.length);
        if (result.ok) {
          w.offset = result.audioStart;
          syncWindowEl();
        }
      }

      if (windowEl.addEventListener) {
        windowEl.addEventListener('pointerdown', function (e) {
          dragging = true;
          previewOffset(e.clientX);
        });
      }
      if (doc.addEventListener) {
        doc.addEventListener('pointermove', function (e) {
          if (dragging) previewOffset(e.clientX);
        });
        doc.addEventListener('pointerup', function (e) {
          if (!dragging) return;
          dragging = false;
          commitOffset(e.clientX);
        });
      }

      // Expose hooks for the upload flow (task 13.5) to complete a selection
      // and render the waveform once an uploaded track is validated.
      instance._selectMusicTrack = function (props) {
        var result = chooseTrack({
          assetRef: props.assetRef,
          source: props.source || MUSIC_SOURCES.UPLOAD,
          volume: props.volume,
          loopMode: props.loopMode,
          trackDuration: props.trackDuration,
        });
        return result;
      };
      instance._showWaveform = showWaveform;
    };
  }

  /**
   * Register the music picker tool on a controller (convenience wrapper),
   * mirroring registerAudioTools.
   * @param {Object} controller - A VideoEditorController.
   * @param {Object} [opts] - See {@link musicPickerToolInitializer}.
   * @returns {Object} controller
   */
  function registerMusicPickerTools(controller, opts) {
    if (controller && typeof controller.registerTool === 'function') {
      controller.registerTool(musicPickerToolInitializer(opts));
    }
    return controller;
  }

  /* ==========================================================================
   * Music upload flow with retry + proceed-without-music (task 13.5).
   *
   * Uploads a user-supplied audio file via the Worker -> R2 path, mirroring how
   * the app uploads video: presign (POST /api/music/upload-url -> { uploadUrl,
   * assetId, key }) -> PUT the bytes to uploadUrl -> validate (POST
   * /api/music/validate -> { ok, duration }). On success the validated track is
   * recorded into the recipe as the single Music_Track.
   *
   * Error handling (Req 15.3/15.4/15.5/15.6):
   *   - On ANY failed attempt the remainder of the Edit_Recipe is RETAINED
   *     unchanged and an error describing the cause is surfaced (Req 15.3). The
   *     flow never mutates the recipe until validation has succeeded, so a
   *     failed upload can never corrupt the recipe.
   *   - The user is offered up to 3 attempts plus a proceed-without-music option
   *     (Req 15.4): after a non-final failure the controller is in state
   *     "failed" with `canRetry === true`.
   *   - After the 3rd failed attempt the flow automatically proceeds WITHOUT a
   *     Music_Track (Req 15.5), removing only a tentatively-added track (if any)
   *     via {@link removeMusicTrack} while keeping ALL other recipe fields
   *     intact (Req 15.6).
   *
   * The three network calls are INJECTABLE via `deps` so the controller is fully
   * unit/property testable WITHOUT real network access; when a dep is omitted a
   * `fetch`-based default is used in the browser.
   *
   * Requirements: 15.3, 15.4, 15.5, 15.6
   * ======================================================================== */

  /** Maximum number of Music_Track upload attempts before auto-proceeding (Req 15.4/15.5). */
  var MUSIC_UPLOAD_MAX_ATTEMPTS = 3;

  /** Lifecycle states for the music upload controller. */
  var MUSIC_UPLOAD_STATES = Object.freeze({
    IDLE: 'idle',
    UPLOADING: 'uploading',
    FAILED: 'failed',
    SUCCEEDED: 'succeeded',
    PROCEEDED_WITHOUT_MUSIC: 'proceeded_without_music',
  });

  /**
   * Tag a promise's rejection with the upload step that produced it, so the
   * surfaced error can describe the failure cause (Req 15.3).
   * @param {Promise|*} promise
   * @param {string} step - 'presign' | 'upload' | 'validate'
   * @returns {Promise}
   */
  function tagUploadStep(promise, step) {
    return Promise.resolve(promise).catch(function (err) {
      var e = err instanceof Error ? err : new Error(err == null ? 'Upload failed' : String(err));
      if (!e.step) e.step = step;
      throw e;
    });
  }

  /**
   * Default presign call: POST /api/music/upload-url, returning
   * `{ uploadUrl, assetId, key }`. Used only in the browser; tests inject a dep.
   * @param {File|Blob} file
   * @returns {Promise<{uploadUrl:string, assetId:string, key:string}>}
   */
  function defaultRequestUploadUrl(file) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('Network is unavailable'));
    return fetch('/api/music/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file && file.name,
        contentType: (file && file.type) || 'application/octet-stream',
        size: file && file.size,
      }),
    }).then(function (res) {
      if (!res || !res.ok) {
        throw new Error('Could not get a music upload URL (HTTP ' + (res && res.status) + ')');
      }
      return res.json();
    });
  }

  /**
   * Default upload call: PUT the file bytes to the presigned Worker URL.
   * @param {string} uploadUrl
   * @param {File|Blob} file
   * @returns {Promise<true>}
   */
  function defaultPutFile(uploadUrl, file) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('Network is unavailable'));
    return fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': (file && file.type) || 'application/octet-stream' },
      body: file,
    }).then(function (res) {
      if (!res || !res.ok) {
        throw new Error('Audio upload failed (HTTP ' + (res && res.status) + ')');
      }
      return true;
    });
  }

  /**
   * Default validation call: POST /api/music/validate, returning
   * `{ ok, duration }`. A non-2xx response (size/duration limits, Req 8.6/8.7)
   * is turned into an Error whose message describes the cause.
   * @param {{assetId:string, key:string, size:number}} params
   * @returns {Promise<{ok:boolean, duration:number}>}
   */
  function defaultValidateAsset(params) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('Network is unavailable'));
    return fetch('/api/music/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }).then(function (res) {
      if (!res) throw new Error('Audio validation failed');
      return Promise.resolve(res.json()).catch(function () { return null; }).then(function (body) {
        if (!res.ok) {
          throw new Error((body && (body.error || body.reason)) || 'Audio validation failed');
        }
        return body || { ok: false };
      });
    });
  }

  /**
   * Resolve the injectable network dependencies, falling back to the fetch-based
   * browser defaults for any omitted call.
   * @param {Object} [deps] - { requestUploadUrl, putFile, validateAsset }
   * @returns {{requestUploadUrl:Function, putFile:Function, validateAsset:Function}}
   */
  function normalizeUploadDeps(deps) {
    deps = deps || {};
    return {
      requestUploadUrl: typeof deps.requestUploadUrl === 'function'
        ? deps.requestUploadUrl : defaultRequestUploadUrl,
      putFile: typeof deps.putFile === 'function' ? deps.putFile : defaultPutFile,
      validateAsset: typeof deps.validateAsset === 'function'
        ? deps.validateAsset : defaultValidateAsset,
    };
  }

  /**
   * Run a single end-to-end upload attempt: presign -> PUT -> validate. Resolves
   * with the validated asset descriptor or rejects with a step-tagged error.
   * Performs NO recipe mutation (the caller records the track only on success).
   * @param {File|Blob} file
   * @param {Object} deps - normalized deps
   * @returns {Promise<{assetId:string, key:string, duration:number, source:'upload'}>}
   */
  function performMusicUpload(file, deps) {
    var presign;
    return tagUploadStep(
      Promise.resolve().then(function () { return deps.requestUploadUrl(file); }),
      'presign'
    )
      .then(function (p) {
        presign = p || {};
        if (!presign.uploadUrl) {
          var e = new Error('No upload URL was returned');
          e.step = 'presign';
          throw e;
        }
        return tagUploadStep(
          Promise.resolve().then(function () { return deps.putFile(presign.uploadUrl, file); }),
          'upload'
        );
      })
      .then(function () {
        return tagUploadStep(
          Promise.resolve().then(function () {
            return deps.validateAsset({
              assetId: presign.assetId,
              key: presign.key,
              size: file && file.size,
            });
          }),
          'validate'
        );
      })
      .then(function (validation) {
        if (!validation || validation.ok !== true) {
          var e = new Error(
            (validation && (validation.error || validation.reason)) || 'Audio validation failed'
          );
          e.step = 'validate';
          throw e;
        }
        return {
          assetId: presign.assetId,
          key: presign.key,
          duration: Number(validation.duration),
          source: MUSIC_SOURCES.UPLOAD,
        };
      });
  }

  /**
   * Turn an upload error into a surfaced `{ cause, message }` describing the
   * failure (Req 15.3). `cause` names the failing step; `message` is human text.
   * @param {*} err
   * @returns {{cause:string, message:string}}
   */
  function describeUploadError(err) {
    if (!err) return { cause: 'unknown', message: 'Upload failed' };
    return {
      cause: err.step || err.cause || 'upload',
      message: err.message || String(err),
    };
  }

  /**
   * Create a Music_Track upload controller (a small state machine) that uploads
   * `file` via the Worker -> R2 path, records the validated track into the
   * recipe on success, and on failure retains the recipe while offering up to
   * `maxAttempts` attempts plus a proceed-without-music option (Req 15.3–15.6).
   *
   * The controller does NOT start automatically; call `start()` to run the first
   * attempt, `retry()` to run a subsequent attempt, and `proceedWithoutMusic()`
   * to give up. After the final (3rd) failed attempt the controller proceeds
   * without music automatically (Req 15.5).
   *
   * @param {Object} instance - The EditorInstance whose recipe is being edited.
   * @param {File|Blob} file - The user-selected audio file.
   * @param {Object} [deps] - Injectable network calls:
   *   { requestUploadUrl(file), putFile(uploadUrl, file), validateAsset({assetId,key,size}) }.
   *   Any omitted call uses a fetch-based default.
   * @param {Object} [opts] - { maxAttempts=3, clipLength, volume, loopMode }.
   * @returns {Object} The upload controller (state machine).
   */
  function uploadMusic(instance, file, deps, opts) {
    opts = opts || {};
    var resolvedDeps = normalizeUploadDeps(deps);
    var maxAttempts = opts.maxAttempts != null && opts.maxAttempts > 0
      ? Math.floor(opts.maxAttempts) : MUSIC_UPLOAD_MAX_ATTEMPTS;
    var clipLength = opts.clipLength != null ? opts.clipLength : CLIP_DURATION_LIMIT;

    var controller = {
      state: MUSIC_UPLOAD_STATES.IDLE,
      attempts: 0,
      maxAttempts: maxAttempts,
      error: null,
      music: null,
    };

    // Derived flags. `canRetry` is true only while a non-final attempt has
    // failed; `exhausted` once all attempts are spent (Req 15.4/15.5).
    Object.defineProperty(controller, 'canRetry', {
      enumerable: true,
      get: function () {
        return controller.state === MUSIC_UPLOAD_STATES.FAILED
          && controller.attempts < maxAttempts;
      },
    });
    Object.defineProperty(controller, 'attemptsRemaining', {
      enumerable: true,
      get: function () { return Math.max(0, maxAttempts - controller.attempts); },
    });
    Object.defineProperty(controller, 'exhausted', {
      enumerable: true,
      get: function () { return controller.attempts >= maxAttempts; },
    });

    /** Record the validated track into the recipe (single-track, Req 7.x). */
    function recordTrack(asset) {
      var props = {
        assetRef: asset.assetId,
        source: MUSIC_SOURCES.UPLOAD,
        volume: opts.volume,
        loopMode: opts.loopMode,
        trackDuration: asset.duration,
      };
      // Prefer the picker's selection hook (renders the waveform) when present.
      var result;
      if (typeof instance._selectMusicTrack === 'function') {
        result = instance._selectMusicTrack(props);
      } else {
        result = selectMusicTrack(instance, props, clipLength);
      }
      return result && result.ok ? getMusic(instance) : null;
    }

    /**
     * Proceed without a Music_Track (Req 15.5/15.6): remove ONLY a
     * tentatively-added music track (if any) while keeping every other recipe
     * field intact, and enter the terminal proceeded state.
     */
    function proceed() {
      removeMusicTrack(instance); // only nulls audio.music; rest of recipe intact
      controller.state = MUSIC_UPLOAD_STATES.PROCEEDED_WITHOUT_MUSIC;
      controller.music = null;
      return {
        ok: false,
        state: controller.state,
        attempts: controller.attempts,
        error: controller.error,
        proceededWithoutMusic: true,
      };
    }

    function successResult() {
      return {
        ok: true,
        state: controller.state,
        attempts: controller.attempts,
        music: controller.music,
      };
    }

    function failureResult() {
      return {
        ok: false,
        state: controller.state,
        attempts: controller.attempts,
        error: controller.error,
        canRetry: controller.canRetry,
      };
    }

    function runAttempt() {
      // Terminal states are not re-entered; report the current result.
      if (controller.state === MUSIC_UPLOAD_STATES.SUCCEEDED) {
        return Promise.resolve(successResult());
      }
      if (controller.state === MUSIC_UPLOAD_STATES.PROCEEDED_WITHOUT_MUSIC) {
        return Promise.resolve(proceed());
      }
      if (controller.state === MUSIC_UPLOAD_STATES.UPLOADING) {
        return Promise.resolve(failureResult());
      }
      // No attempts left -> proceed without music (Req 15.5).
      if (controller.attempts >= maxAttempts) {
        return Promise.resolve(proceed());
      }

      controller.state = MUSIC_UPLOAD_STATES.UPLOADING;
      controller.error = null;
      controller.attempts += 1;

      return performMusicUpload(file, resolvedDeps)
        .then(function (asset) {
          controller.music = recordTrack(asset);
          controller.state = MUSIC_UPLOAD_STATES.SUCCEEDED;
          return successResult();
        })
        .catch(function (err) {
          // Req 15.3: the recipe is retained unchanged (nothing was mutated).
          controller.error = describeUploadError(err);
          if (controller.attempts >= maxAttempts) {
            // Req 15.5: after the 3rd failed attempt, proceed without music.
            return proceed();
          }
          controller.state = MUSIC_UPLOAD_STATES.FAILED;
          return failureResult();
        });
    }

    controller.start = runAttempt;
    controller.retry = runAttempt;
    controller.proceedWithoutMusic = proceed;

    return controller;
  }

  /* ==========================================================================
   * Public API
   * ======================================================================== */
  return {
    // Browser audio tool layer (task 13.1)
    audioToolInitializer: audioToolInitializer,
    registerAudioTools: registerAudioTools,

    // Music source picker + waveform tool layer (task 13.3)
    musicPickerToolInitializer: musicPickerToolInitializer,
    registerMusicPickerTools: registerMusicPickerTools,
    defaultFetchLibrary: defaultFetchLibrary,

    // Music upload flow with retry + proceed-without-music (task 13.5)
    uploadMusic: uploadMusic,
    performMusicUpload: performMusicUpload,
    describeUploadError: describeUploadError,
    normalizeUploadDeps: normalizeUploadDeps,
    defaultRequestUploadUrl: defaultRequestUploadUrl,
    defaultPutFile: defaultPutFile,
    defaultValidateAsset: defaultValidateAsset,

    // EditorInstance audio helpers (testable core; task 13.2 targets these)
    setMuted: setMuted,
    isMuted: isMuted,
    setOriginalVolume: setOriginalVolume,
    getOriginalVolume: getOriginalVolume,
    addMusicTrack: addMusicTrack,
    removeMusicTrack: removeMusicTrack,
    hasMusic: hasMusic,
    getMusic: getMusic,
    setMusicVolume: setMusicVolume,
    setLoopMode: setLoopMode,
    getLoopMode: getLoopMode,

    // Waveform_Window + music source helpers (testable core; task 13.4 targets these)
    defaultWaveformWindow: defaultWaveformWindow,
    clampWaveformOffset: clampWaveformOffset,
    quantizeToMs: quantizeToMs,
    roundToMsPrecision: roundToMsPrecision,
    setAudioStart: setAudioStart,
    getAudioStart: getAudioStart,
    setMusicSource: setMusicSource,
    getMusicSource: getMusicSource,
    selectMusicTrack: selectMusicTrack,

    // Pure value helpers (exported for the tool layers and tests)
    clamp: clamp,
    clampVolume: clampVolume,
    normalizeLoopMode: normalizeLoopMode,
    normalizeSource: normalizeSource,
    sanitizeAudioStart: sanitizeAudioStart,
    buildMusicConfig: buildMusicConfig,
    cloneMusicConfig: cloneMusicConfig,

    // Constants (mirrored from src/shared/constants.js and public/js/editor.js)
    VOLUME_MIN: VOLUME_MIN,
    VOLUME_MAX: VOLUME_MAX,
    DEFAULT_LOOP_MODE: DEFAULT_LOOP_MODE,
    LOOP_MODES: LOOP_MODES,
    MUSIC_SOURCES: MUSIC_SOURCES,
    MAX_MUSIC_TRACKS: MAX_MUSIC_TRACKS,
    DEFAULT_ORIGINAL_VOLUME: DEFAULT_ORIGINAL_VOLUME,
    DEFAULT_MUSIC_VOLUME: DEFAULT_MUSIC_VOLUME,
    CLIP_DURATION_LIMIT: CLIP_DURATION_LIMIT,
    WAVEFORM_STEP_MS: WAVEFORM_STEP_MS,
    WAVEFORM_DISPLAY_DEADLINE_MS: WAVEFORM_DISPLAY_DEADLINE_MS,
    MUSIC_UPLOAD_MAX_ATTEMPTS: MUSIC_UPLOAD_MAX_ATTEMPTS,
    MUSIC_UPLOAD_STATES: MUSIC_UPLOAD_STATES,
  };
});
