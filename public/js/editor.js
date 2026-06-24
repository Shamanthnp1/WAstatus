/**
 * StatusDrop in-app video editor (browser side) — entry point + recipe model.
 *
 * Task 12.1: editor entry, per-video instance scaffolding, the Edit_Recipe data
 * model, gesture -> relative-coordinate conversion, and a 10s load-failure
 * fallback that routes back to the existing no-editor flow.
 *
 * Architectural invariant (Req 2.1): the browser NEVER decodes, re-renders, or
 * re-encodes the source video pixels. The native <video> element is used purely
 * for preview/playback; edits are captured as a small JSON Edit_Recipe using
 * relative coordinates (0..1) and degrees. No canvas pixel export of the video
 * happens anywhere in this module.
 *
 * The text/sticker tools (task 12.2), trim UI (task 12.6), and audio panel
 * (task 13.x) are intentionally NOT implemented here. This module exposes the
 * recipe state containers and a tool registry so those tools can be layered on
 * later without touching the entry point or recipe model.
 *
 * UMD wrapper: attaches to `window.StatusDropEditor` in the browser and exports
 * via CommonJS so the pure helpers and recipe model can be unit/property tested
 * under the node:test + fast-check harness (tasks 12.3–12.5).
 *
 * Requirements: 1.1, 1.3, 2.1, 2.2, 2.3, 15.1, 15.2
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StatusDropEditor = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ==========================================================================
   * Mirrored constants.
   *
   * The browser cannot require() the CommonJS module at src/shared/constants.js,
   * so the relevant numeric limits are mirrored here. These values MUST be kept
   * in sync with src/shared/constants.js (WHATSAPP_SPEC, RECIPE_LIMITS).
   * ======================================================================== */

  /** Fixed WhatsApp_Spec output canvas (Req 12.1, mirrors WHATSAPP_SPEC). */
  var CANVAS = Object.freeze({ WIDTH: 1080, HEIGHT: 1920 });

  /** Edit_Recipe field ranges (mirrors RECIPE_LIMITS in src/shared/constants.js). */
  var LIMITS = Object.freeze({
    COORD_MIN: 0.0,
    COORD_MAX: 1.0,
    ROTATION_MIN: 0,
    ROTATION_MAX: 360,
    SCALE_MIN: 0.1,
    SCALE_MAX: 5.0,
    FONT_SIZE_MIN: 8,
    FONT_SIZE_MAX: 200,
    TEXT_LENGTH_MIN: 1,
    TEXT_LENGTH_MAX: 200,
    VOLUME_MIN: 0,
    VOLUME_MAX: 100,
    MAX_TEXT_OVERLAYS: 20,
    MAX_STICKERS: 20,
    MAX_MUSIC_TRACKS: 1,
  });

  /** Maximum number of videos that can be edited (mirrors INPUT_LIMITS.MAX_VIDEOS). */
  var MAX_VIDEOS = 3;

  /** Edit_Recipe schema version emitted by this editor. */
  var RECIPE_VERSION = 1;

  /** Default Loop_Mode when a Music_Track is shorter than the video (Req 10.3). */
  var DEFAULT_LOOP_MODE = 'loop';

  /**
   * Default styling applied to a newly added Text_Overlay (Req 5.2). These are
   * in-range defaults so an added overlay is always a complete, valid recipe
   * entry before the user customizes it.
   */
  var TEXT_OVERLAY_DEFAULTS = Object.freeze({
    text: '',
    textColor: '#FFFFFF',
    bgColor: '#00000080',
    font: 'Roboto',
    fontSize: 48,
    rotation: 0,
  });

  /** Default scale/rotation for a newly added Sticker (Req 6.3/6.4). */
  var STICKER_DEFAULTS = Object.freeze({
    scale: 1.0,
    rotation: 0,
  });

  /** Default placement (frame center) for a freshly added overlay/sticker. */
  var DEFAULT_POSITION = Object.freeze({ x: 0.5, y: 0.5 });

  /**
   * Editor load-failure timeout (Req 15.1/15.2). If a video preview fails to
   * become ready within this window, the editor falls back to the no-editor flow.
   */
  var EDITOR_LOAD_TIMEOUT_MS = 10000;

  /* ==========================================================================
   * Pure helpers — coordinate conversion and range clamping.
   *
   * These functions have no DOM dependency so they can be property-tested
   * directly (tasks 12.3/12.4) and reused by the tool layers (12.2/12.6/13.x).
   * ======================================================================== */

  /**
   * Clamp a numeric value to an inclusive [min, max] range.
   * Non-finite input falls back to `min` so callers never record NaN/Infinity.
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
   * Clamp a single relative-axis value to [0, 1] (Req 2.2, 5.3, 6.5).
   * @param {number} value
   * @returns {number}
   */
  function clampRelative(value) {
    return clamp(value, LIMITS.COORD_MIN, LIMITS.COORD_MAX);
  }

  /**
   * Clamp a relative position object so both axes lie within [0, 1].
   * @param {{x:number, y:number}} pos
   * @returns {{x:number, y:number}}
   */
  function clampRelativePosition(pos) {
    var p = pos || {};
    return { x: clampRelative(p.x), y: clampRelative(p.y) };
  }

  /**
   * Normalize a rotation (degrees) into the inclusive range [0, 360] (Req 2.3).
   * Values are wrapped modulo 360 so any gesture-derived angle maps into range.
   * @param {number} degrees
   * @returns {number}
   */
  function normalizeRotation(degrees) {
    var d = Number(degrees);
    if (!isFinite(d)) return LIMITS.ROTATION_MIN;
    // Wrap into [0, 360). 360 itself is kept as a valid in-range value.
    if (d === LIMITS.ROTATION_MAX) return LIMITS.ROTATION_MAX;
    var wrapped = d % 360;
    if (wrapped < 0) wrapped += 360;
    return wrapped;
  }

  /** Clamp a sticker scale factor to [0.1, 5.0] (Req 6.3). */
  function clampScale(value) {
    return clamp(value, LIMITS.SCALE_MIN, LIMITS.SCALE_MAX);
  }

  /** Clamp a font size to [8, 200] (Req 5.2). */
  function clampFontSize(value) {
    return clamp(value, LIMITS.FONT_SIZE_MIN, LIMITS.FONT_SIZE_MAX);
  }

  /** Clamp and round a volume to an integer in [0, 100] (Req 7.3). */
  function clampVolume(value) {
    return Math.round(clamp(value, LIMITS.VOLUME_MIN, LIMITS.VOLUME_MAX));
  }

  /**
   * Convert a pixel position over the preview surface into a relative (0..1)
   * coordinate pair, clamped to the frame (Req 2.2). This is the core
   * gesture -> relative-coordinate conversion used by every placement tool.
   *
   * The conversion is resolution-independent: it divides by the preview's
   * rendered size, so the recorded value is identical regardless of how large
   * the preview is drawn. The fixed WhatsApp_Spec canvas (1080x1920) is applied
   * later, server-side, when the recipe is rendered.
   *
   * @param {number} pixelX - X offset in pixels from the left edge of the preview.
   * @param {number} pixelY - Y offset in pixels from the top edge of the preview.
   * @param {number} previewWidth - Rendered preview width in pixels (> 0).
   * @param {number} previewHeight - Rendered preview height in pixels (> 0).
   * @returns {{x:number, y:number}} Relative coordinate, each axis in [0, 1].
   */
  function pixelToRelative(pixelX, pixelY, previewWidth, previewHeight) {
    var w = Number(previewWidth);
    var h = Number(previewHeight);
    var relX = w > 0 ? Number(pixelX) / w : 0;
    var relY = h > 0 ? Number(pixelY) / h : 0;
    return { x: clampRelative(relX), y: clampRelative(relY) };
  }

  /**
   * Convert a relative (0..1) coordinate back into a pixel position over a
   * preview of the given rendered size. Inverse of {@link pixelToRelative};
   * used to render/position overlays in the preview.
   *
   * @param {number} relX - Relative X in [0, 1].
   * @param {number} relY - Relative Y in [0, 1].
   * @param {number} previewWidth - Rendered preview width in pixels.
   * @param {number} previewHeight - Rendered preview height in pixels.
   * @returns {{x:number, y:number}} Pixel position over the preview.
   */
  function relativeToPixel(relX, relY, previewWidth, previewHeight) {
    return {
      x: clampRelative(relX) * Number(previewWidth),
      y: clampRelative(relY) * Number(previewHeight),
    };
  }

  /**
   * Map a relative (0..1) coordinate onto the fixed WhatsApp_Spec canvas
   * (1080x1920). Mirrors the server-side `mapRelToPixels` so the editor preview
   * and the rendered output agree on placement (Req 5.8/6.7).
   * @param {number} relX
   * @param {number} relY
   * @returns {{x:number, y:number}} Pixel position on the 1080x1920 canvas.
   */
  function mapRelToCanvas(relX, relY) {
    return {
      x: Math.round(clampRelative(relX) * CANVAS.WIDTH),
      y: Math.round(clampRelative(relY) * CANVAS.HEIGHT),
    };
  }

  /**
   * Resolve a pointer/touch client position to a relative coordinate over a
   * given bounding rectangle (e.g. a preview element's getBoundingClientRect()).
   * @param {number} clientX - Pointer clientX.
   * @param {number} clientY - Pointer clientY.
   * @param {{left:number, top:number, width:number, height:number}} rect
   * @returns {{x:number, y:number}} Relative coordinate clamped to [0, 1].
   */
  function clientPointToRelative(clientX, clientY, rect) {
    var r = rect || { left: 0, top: 0, width: 0, height: 0 };
    return pixelToRelative(
      Number(clientX) - r.left,
      Number(clientY) - r.top,
      r.width,
      r.height
    );
  }

  /* ==========================================================================
   * Text / sticker tool pure helpers (task 12.2).
   *
   * These have no DOM dependency, so the text-overlay and sticker tools are
   * fully unit/property testable WITHOUT a real DOM (tasks 12.3–12.5). The
   * EditorInstance methods below are thin wrappers that record results into the
   * recipe state; the browser tool layer (registerOverlayTools) only translates
   * pointer/touch gestures into calls to those same methods.
   * ======================================================================== */

  /**
   * Validate Text_Overlay content (Req 5.2/5.6): a string whose length is
   * within [1, 200]. Empty strings and strings longer than 200 characters are
   * invalid; non-strings are invalid.
   * @param {string} text
   * @returns {boolean}
   */
  function isValidTextContent(text) {
    if (typeof text !== 'string') return false;
    var len = text.length;
    return len >= LIMITS.TEXT_LENGTH_MIN && len <= LIMITS.TEXT_LENGTH_MAX;
  }

  /**
   * Build a complete, in-range Text_Overlay recipe entry from partial props
   * (Req 5.2/5.5). Every recorded value is clamped/normalized into range:
   * position to [0,1] per axis, rotation to [0,360], fontSize to [8,200].
   * Missing fields fall back to {@link TEXT_OVERLAY_DEFAULTS}.
   *
   * Note: this does NOT validate the text length — callers that add/edit text
   * must gate on {@link isValidTextContent} first (Req 5.6). When `text` is
   * omitted the default ('') is used; that is only a placeholder for an
   * already-validated caller.
   *
   * @param {Object} props
   * @returns {Object} A normalized TextOverlay entry.
   */
  function buildTextOverlay(props) {
    props = props || {};
    return {
      id: props.id,
      text: typeof props.text === 'string' ? props.text : TEXT_OVERLAY_DEFAULTS.text,
      textColor: props.textColor || TEXT_OVERLAY_DEFAULTS.textColor,
      bgColor: props.bgColor || TEXT_OVERLAY_DEFAULTS.bgColor,
      font: props.font || TEXT_OVERLAY_DEFAULTS.font,
      fontSize: clampFontSize(props.fontSize != null ? props.fontSize : TEXT_OVERLAY_DEFAULTS.fontSize),
      pos: clampRelativePosition(props.pos || DEFAULT_POSITION),
      rotation: normalizeRotation(props.rotation != null ? props.rotation : TEXT_OVERLAY_DEFAULTS.rotation),
    };
  }

  /**
   * Build a complete, in-range Sticker recipe entry from partial props
   * (Req 6.2/6.4). Position is clamped to [0,1] per axis (Req 6.5), scale to
   * [0.1,5.0] (Req 6.3), rotation to [0,360].
   * @param {Object} props - Must include `assetRef`.
   * @returns {Object} A normalized Sticker entry.
   */
  function buildSticker(props) {
    props = props || {};
    return {
      id: props.id,
      assetRef: props.assetRef,
      pos: clampRelativePosition(props.pos || DEFAULT_POSITION),
      scale: clampScale(props.scale != null ? props.scale : STICKER_DEFAULTS.scale),
      rotation: normalizeRotation(props.rotation != null ? props.rotation : STICKER_DEFAULTS.rotation),
    };
  }

  /**
   * Apply a multiplicative pinch factor to a scale, clamped to [0.1, 5.0]
   * (Req 6.3). Used to translate a touch pinch ratio or mouse-resize ratio into
   * a recorded sticker scale.
   * @param {number} currentScale
   * @param {number} factor - Pinch ratio (e.g. 1.2 to grow, 0.8 to shrink).
   * @returns {number} The new clamped scale.
   */
  function scaleByFactor(currentScale, factor) {
    var base = Number(currentScale);
    var f = Number(factor);
    if (!isFinite(base)) base = STICKER_DEFAULTS.scale;
    if (!isFinite(f)) return clampScale(base);
    return clampScale(base * f);
  }

  /**
   * Apply a multiplicative pinch factor to a font size, clamped to [8, 200]
   * (Req 5.4). The text-overlay equivalent of {@link scaleByFactor}.
   * @param {number} currentFontSize
   * @param {number} factor
   * @returns {number} The new clamped font size.
   */
  function fontSizeByFactor(currentFontSize, factor) {
    var base = Number(currentFontSize);
    var f = Number(factor);
    if (!isFinite(base)) base = TEXT_OVERLAY_DEFAULTS.fontSize;
    if (!isFinite(f)) return clampFontSize(base);
    return clampFontSize(base * f);
  }

  /**
   * Apply a rotation delta (degrees) and normalize into [0, 360] (Req 5.4/6.3).
   * Used to translate a two-finger twist or mouse-rotate delta into a recorded
   * rotation.
   * @param {number} currentRotation
   * @param {number} deltaDegrees
   * @returns {number} The new normalized rotation.
   */
  function rotateBy(currentRotation, deltaDegrees) {
    var base = Number(currentRotation);
    var d = Number(deltaDegrees);
    if (!isFinite(base)) base = 0;
    if (!isFinite(d)) d = 0;
    return normalizeRotation(base + d);
  }

  /* ==========================================================================
   * Trim tool pure helpers (task 12.6).
   *
   * These have no DOM dependency so the dual-handle trim control's recording
   * logic is fully unit/property testable WITHOUT a real DOM. The
   * EditorInstance.attemptTrim wrapper records results into the recipe via the
   * existing setTrim primitive; the browser tool layer (trimToolInitializer)
   * only translates dual-handle drag gestures into attemptTrim calls.
   * ======================================================================== */

  /**
   * Validate a Trim selection (Req 2.4, 4.1, 4.2, 4.3). A selection is valid
   * iff both bounds are finite, `start >= 0`, `start < end`, and (when a source
   * duration is known) `end <= duration`. A non-positive `duration` is treated
   * as "unknown" so the upper bound is not enforced — this mirrors the behavior
   * of the existing {@link EditorInstance#setTrim} primitive exactly.
   *
   * @param {number} start - Trim start in seconds.
   * @param {number} end - Trim end in seconds.
   * @param {number} duration - Source video duration in seconds (<=0 => unknown).
   * @returns {boolean} Whether the selection is a valid Trim.
   */
  function isValidTrim(start, end, duration) {
    var s = Number(start);
    var e = Number(end);
    var d = Number(duration) || 0;
    return isFinite(s) && isFinite(e) && s >= 0 && s < e && (d <= 0 || e <= d);
  }

  /**
   * Convert a normalized track fraction (0..1) into a time in seconds along a
   * timeline of the given duration. The fraction is clamped to [0, 1] first so
   * a handle dragged past either end of the track maps to the timeline bound.
   * @param {number} fraction - Position along the track, 0 = start, 1 = end.
   * @param {number} duration - Timeline duration in seconds.
   * @returns {number} Time in seconds, in [0, duration].
   */
  function fractionToTime(fraction, duration) {
    var d = Number(duration);
    if (!isFinite(d) || d <= 0) return 0;
    return clamp(fraction, 0, 1) * d;
  }

  /**
   * Convert a time in seconds into a normalized track fraction (0..1). Inverse
   * of {@link fractionToTime}; used to position the dual handles for a recorded
   * (or default) trim. Returns 0 when the duration is unknown/non-positive.
   * @param {number} time - Time in seconds.
   * @param {number} duration - Timeline duration in seconds.
   * @returns {number} Fraction in [0, 1].
   */
  function timeToFraction(time, duration) {
    var d = Number(duration);
    if (!isFinite(d) || d <= 0) return 0;
    return clamp(Number(time) / d, 0, 1);
  }

  /**
   * Compute the candidate trim produced by dragging one of the two handles to a
   * track fraction, holding the other handle at its current value (Req 4.2/4.3).
   * The result is a pure {start, end} candidate that the caller passes to
   * {@link EditorInstance#attemptTrim}; this helper performs NO validation, so
   * an out-of-order or out-of-range candidate is returned as-is and rejected by
   * attemptTrim (which then retains the prior trim and flags it invalid).
   *
   * @param {('start'|'end')} which - Which handle is being dragged.
   * @param {number} fraction - Target track fraction (0..1) of the dragged handle.
   * @param {{start:number, end:number}} current - Current handle times in seconds.
   * @param {number} duration - Timeline duration in seconds.
   * @returns {{start:number, end:number}} The candidate trim (unvalidated).
   */
  function computeTrimFromDrag(which, fraction, current, duration) {
    var cur = current || { start: 0, end: 0 };
    var t = fractionToTime(fraction, duration);
    if (which === 'start') {
      return { start: t, end: Number(cur.end) };
    }
    return { start: Number(cur.start), end: t };
  }

  /* ==========================================================================
   * EditorInstance — one per uploaded video.
   *
   * Owns the in-memory Edit_Recipe state for a single video and exposes the
   * recipe accessors (getRecipe/isDirty) plus the gesture-conversion helpers
   * bound to this instance's preview surface. The actual editing tools push
   * into the state containers (textOverlays / stickers / audio / trim) and call
   * markDirty(); those tools are implemented in later tasks.
   * ======================================================================== */

  /**
   * @param {number} videoIndex - Which uploaded video this edits (0..2).
   * @param {Object} [options]
   * @param {HTMLVideoElement|null} [options.previewEl] - Preview element (browser only).
   * @param {string} [options.uploadKey] - Upload key, attached to the recipe when submitting.
   * @param {number} [options.sourceDuration] - Source duration in seconds (set on load).
   */
  function EditorInstance(videoIndex, options) {
    options = options || {};
    this.videoIndex = videoIndex;
    this.uploadKey = options.uploadKey || null;
    this.previewEl = options.previewEl || null;

    /** Source video duration in seconds; resolved when the preview loads. */
    this.sourceDuration = typeof options.sourceDuration === 'number'
      ? options.sourceDuration
      : 0;

    /** True once the preview's metadata has loaded (Req 15.1 readiness). */
    this.ready = false;

    /** Set to true the moment any edit is recorded (drives skip vs edited). */
    this._dirty = false;

    /**
     * Mutable recipe state. Tool layers append/modify these; getRecipe()
     * serializes a clean copy. Defaults here represent "no edit" so an
     * untouched instance produces a null recipe (skipped, Req 1.2).
     */
    this._trim = null; // { start, end } | null
    this.textOverlays = []; // TextOverlay[] (tool: task 12.2)
    this.stickers = []; // Sticker[] (tool: task 12.2)
    this.audio = {
      originalMuted: false,
      originalVolume: LIMITS.VOLUME_MAX,
      music: null, // MusicConfig | null (tool: task 13.x)
    };

    /** Monotonic counter for generating stable overlay/sticker ids. */
    this._idCounter = 0;

    /**
     * Whether the last attempted trim selection was invalid (Req 4.3 invalid
     * indication). Set by {@link EditorInstance#attemptTrim} on a rejected
     * selection and cleared on the next accepted one. Mirrors the per-overlay
     * `_invalidEntries` indication pattern used by updateTextOverlay.
     */
    this._trimInvalid = false;

    /**
     * Set of overlay/sticker ids whose last attempted edit was invalid
     * (Req 5.6 invalid indication). Cleared when a subsequent valid edit lands.
     * @type {Object<string, boolean>}
     */
    this._invalidEntries = {};
  }

  /** Flag the instance as edited. Called by tool layers after recording a change. */
  EditorInstance.prototype.markDirty = function markDirty() {
    this._dirty = true;
  };

  /**
   * @returns {boolean} Whether the user has made any edit to this video.
   */
  EditorInstance.prototype.isDirty = function isDirty() {
    return this._dirty;
  };

  /**
   * The preview's rendered content rectangle, used for gesture conversion.
   * Returns a zero-rect when no DOM preview is attached (e.g. under tests).
   * @returns {{left:number, top:number, width:number, height:number}}
   */
  EditorInstance.prototype.getPreviewRect = function getPreviewRect() {
    if (this.previewEl && typeof this.previewEl.getBoundingClientRect === 'function') {
      return this.previewEl.getBoundingClientRect();
    }
    return { left: 0, top: 0, width: 0, height: 0 };
  };

  /**
   * Convert a pointer/touch client position into a relative (0..1) coordinate
   * over this instance's preview (Req 2.2). The single gesture-conversion entry
   * point every placement tool uses.
   * @param {number} clientX
   * @param {number} clientY
   * @param {Object} [rect] - Optional explicit rect (defaults to the preview rect).
   * @returns {{x:number, y:number}}
   */
  EditorInstance.prototype.pointerToRelative = function pointerToRelative(clientX, clientY, rect) {
    return clientPointToRelative(clientX, clientY, rect || this.getPreviewRect());
  };

  /**
   * Record/replace the trim selection. Validates the bounds (Req 2.4): a valid
   * selection requires 0 <= start < end <= sourceDuration. On an invalid
   * selection the previously recorded trim is retained and false is returned.
   * (The trim UI itself is task 12.6; this is the recipe-model primitive.)
   * @param {number} start
   * @param {number} end
   * @returns {boolean} Whether the trim was accepted and recorded.
   */
  EditorInstance.prototype.setTrim = function setTrim(start, end) {
    var s = Number(start);
    var e = Number(end);
    var duration = this.sourceDuration || 0;
    var valid = isFinite(s) && isFinite(e) && s >= 0 && s < e && (duration <= 0 || e <= duration);
    if (!valid) return false;
    this._trim = { start: s, end: e };
    this.markDirty();
    return true;
  };

  /** @returns {{start:number, end:number}|null} The recorded trim, if any. */
  EditorInstance.prototype.getTrim = function getTrim() {
    return this._trim ? { start: this._trim.start, end: this._trim.end } : null;
  };

  /**
   * The effective trim selection for display: the recorded trim when present,
   * otherwise the full-video default selection (0 .. sourceDuration). Used by
   * the dual-handle trim UI to position its handles before the user makes a
   * selection (the recipe still records no trim until {@link attemptTrim}
   * accepts one, so an untouched video is still skipped — Req 4.5).
   * @returns {{start:number, end:number}}
   */
  EditorInstance.prototype.getTrimOrDefault = function getTrimOrDefault() {
    if (this._trim) return { start: this._trim.start, end: this._trim.end };
    return { start: 0, end: this.sourceDuration || 0 };
  };

  /**
   * Attempt to record a trim selection from the trim UI (Req 4.1/4.2/4.3). This
   * is the testable recording wrapper the dual-handle control drives: it routes
   * through the existing {@link setTrim} primitive (which enforces
   * `0 <= start < end <= sourceDuration`) and adds the invalid-indication
   * bookkeeping that mirrors the overlay tools' updateTextOverlay/isEntryInvalid
   * pattern.
   *
   * On a VALID selection the trim is recorded exactly, the invalid indication is
   * cleared, and `{ ok: true, trim }` is returned. On an INVALID selection the
   * previously recorded trim is retained unchanged, the invalid indication is
   * set, and `{ ok: false, error, trim }` is returned (where `trim` is the
   * retained prior value, possibly null).
   *
   * @param {number} start - Candidate Trim start in seconds.
   * @param {number} end - Candidate Trim end in seconds.
   * @returns {{ok:true, trim:{start:number,end:number}}|{ok:false, error:string, trim:({start:number,end:number}|null)}}
   */
  EditorInstance.prototype.attemptTrim = function attemptTrim(start, end) {
    var accepted = this.setTrim(start, end);
    if (!accepted) {
      // Retain the previously recorded trim and flag the invalid selection.
      this._trimInvalid = true;
      return { ok: false, error: 'invalid_trim', trim: this.getTrim() };
    }
    this._trimInvalid = false;
    return { ok: true, trim: this.getTrim() };
  };

  /**
   * @returns {boolean} Whether the last attempted trim selection was invalid
   *   and the invalid indication should be shown (Req 4.3).
   */
  EditorInstance.prototype.isTrimInvalid = function isTrimInvalid() {
    return this._trimInvalid;
  };

  /* ---- Text overlay & sticker tools (task 12.2) ----------------------------
   *
   * These methods are the testable core of the text/sticker tools. They record
   * results directly into the recipe state (textOverlays/stickers) with every
   * value clamped/normalized into range, enforce the 1..20 add limits, and
   * implement the text-content validation that preserves prior state (Req 5.6).
   * The browser tool layer translates gestures into calls to these methods.
   * ----------------------------------------------------------------------- */

  /** Generate a stable unique id for a new overlay/sticker. @returns {string} */
  EditorInstance.prototype._nextId = function _nextId(prefix) {
    this._idCounter += 1;
    return prefix + this._idCounter;
  };

  /**
   * Locate an overlay or sticker by id.
   * @param {string} id
   * @returns {{entry:Object, kind:('text'|'sticker'), list:Array, index:number}|null}
   */
  EditorInstance.prototype._findEntry = function _findEntry(id) {
    for (var i = 0; i < this.textOverlays.length; i++) {
      if (this.textOverlays[i].id === id) {
        return { entry: this.textOverlays[i], kind: 'text', list: this.textOverlays, index: i };
      }
    }
    for (var j = 0; j < this.stickers.length; j++) {
      if (this.stickers[j].id === id) {
        return { entry: this.stickers[j], kind: 'sticker', list: this.stickers, index: j };
      }
    }
    return null;
  };

  /** Mark an entry's last edit as invalid (Req 5.6 indication). */
  EditorInstance.prototype._setInvalid = function _setInvalid(id, invalid) {
    if (invalid) {
      this._invalidEntries[id] = true;
    } else {
      delete this._invalidEntries[id];
    }
  };

  /**
   * @param {string} id
   * @returns {boolean} Whether the entry currently has an invalid-input indication.
   */
  EditorInstance.prototype.isEntryInvalid = function isEntryInvalid(id) {
    return !!this._invalidEntries[id];
  };

  /** @returns {boolean} Whether any overlay/sticker currently has invalid input. */
  EditorInstance.prototype.hasInvalidInput = function hasInvalidInput() {
    for (var k in this._invalidEntries) {
      if (Object.prototype.hasOwnProperty.call(this._invalidEntries, k)) return true;
    }
    return false;
  };

  /**
   * Add a Text_Overlay (Req 5.1/5.2/5.5). Allowed only while fewer than 20
   * overlays exist. The text content must be valid (1..200 chars, Req 5.2);
   * an invalid/missing text is rejected without adding anything (Req 5.6).
   * Every recorded value is clamped/normalized into range.
   *
   * @param {Object} props - { text, textColor, bgColor, font, fontSize, pos, rotation }
   * @returns {{ok:true, overlay:Object}|{ok:false, error:string}}
   */
  EditorInstance.prototype.addTextOverlay = function addTextOverlay(props) {
    props = props || {};
    if (this.textOverlays.length >= LIMITS.MAX_TEXT_OVERLAYS) {
      return { ok: false, error: 'max_overlays' };
    }
    if (!isValidTextContent(props.text)) {
      return { ok: false, error: 'invalid_text' };
    }
    var overlay = buildTextOverlay(props);
    overlay.id = props.id || this._nextId('t');
    this.textOverlays.push(overlay);
    this._setInvalid(overlay.id, false);
    this.markDirty();
    return { ok: true, overlay: cloneTextOverlay(overlay) };
  };

  /**
   * Update a Text_Overlay's properties (Req 5.2/5.5). If the change includes a
   * `text` field that is empty or longer than 200 characters, the ENTIRE change
   * is rejected, the overlay's previously recorded state is preserved, and an
   * invalid-input indication is set (Req 5.6). Other fields are clamped into
   * range. Position/rotation/fontSize changes go through the same range guards.
   *
   * @param {string} id
   * @param {Object} changes - Any subset of { text, textColor, bgColor, font, fontSize, pos, rotation }
   * @returns {{ok:true, overlay:Object}|{ok:false, error:string}}
   */
  EditorInstance.prototype.updateTextOverlay = function updateTextOverlay(id, changes) {
    var found = this._findEntry(id);
    if (!found || found.kind !== 'text') return { ok: false, error: 'not_found' };
    changes = changes || {};

    // Text content validation preserves prior state on failure (Req 5.6).
    if ('text' in changes) {
      if (!isValidTextContent(changes.text)) {
        this._setInvalid(id, true);
        return { ok: false, error: 'invalid_text' };
      }
    }

    var entry = found.entry;
    if ('text' in changes) entry.text = changes.text;
    if ('textColor' in changes && changes.textColor) entry.textColor = changes.textColor;
    if ('bgColor' in changes && changes.bgColor) entry.bgColor = changes.bgColor;
    if ('font' in changes && changes.font) entry.font = changes.font;
    if (changes.fontSize != null) entry.fontSize = clampFontSize(changes.fontSize);
    if (changes.pos) entry.pos = clampRelativePosition(changes.pos);
    if (changes.rotation != null) entry.rotation = normalizeRotation(changes.rotation);

    this._setInvalid(id, false);
    this.markDirty();
    return { ok: true, overlay: cloneTextOverlay(entry) };
  };

  /**
   * Add a Sticker (Req 6.1/6.2/6.4). Allowed only while fewer than 20 stickers
   * exist. An `assetRef` is required. Position is clamped to [0,1] per axis
   * (Req 6.5), scale to [0.1,5.0], rotation to [0,360].
   *
   * @param {Object} props - { assetRef, pos, scale, rotation }
   * @returns {{ok:true, sticker:Object}|{ok:false, error:string}}
   */
  EditorInstance.prototype.addSticker = function addSticker(props) {
    props = props || {};
    if (this.stickers.length >= LIMITS.MAX_STICKERS) {
      return { ok: false, error: 'max_stickers' };
    }
    if (!props.assetRef || typeof props.assetRef !== 'string') {
      return { ok: false, error: 'missing_asset_ref' };
    }
    var sticker = buildSticker(props);
    sticker.id = props.id || this._nextId('s');
    this.stickers.push(sticker);
    this.markDirty();
    return { ok: true, sticker: cloneSticker(sticker) };
  };

  /**
   * Update a Sticker's properties (Req 6.4). Position clamped to [0,1] per axis,
   * scale to [0.1,5.0], rotation to [0,360].
   * @param {string} id
   * @param {Object} changes - Any subset of { assetRef, pos, scale, rotation }
   * @returns {{ok:true, sticker:Object}|{ok:false, error:string}}
   */
  EditorInstance.prototype.updateSticker = function updateSticker(id, changes) {
    var found = this._findEntry(id);
    if (!found || found.kind !== 'sticker') return { ok: false, error: 'not_found' };
    changes = changes || {};
    var entry = found.entry;
    if (changes.assetRef && typeof changes.assetRef === 'string') entry.assetRef = changes.assetRef;
    if (changes.pos) entry.pos = clampRelativePosition(changes.pos);
    if (changes.scale != null) entry.scale = clampScale(changes.scale);
    if (changes.rotation != null) entry.rotation = normalizeRotation(changes.rotation);
    this.markDirty();
    return { ok: true, sticker: cloneSticker(entry) };
  };

  /**
   * Record a drag of an overlay/sticker to a target relative position (Req 5.3,
   * 6.2, 6.5). The recorded position is clamped to the nearest in-range value
   * ([0,1] per axis) so a center dragged outside the frame is retained at the
   * nearest valid spot. Works for both text overlays and stickers.
   *
   * @param {string} id
   * @param {{x:number, y:number}} relPos - Target relative position (may be out of range).
   * @returns {{x:number, y:number}|null} The clamped recorded position, or null if not found.
   */
  EditorInstance.prototype.applyDragToRelative = function applyDragToRelative(id, relPos) {
    var found = this._findEntry(id);
    if (!found) return null;
    found.entry.pos = clampRelativePosition(relPos);
    this.markDirty();
    return { x: found.entry.pos.x, y: found.entry.pos.y };
  };

  /**
   * Apply a scale/rotation transform from a pinch (touch) or mouse interaction
   * (Req 5.4, 6.3). For stickers the `scale` field is updated (0.1..5.0); for
   * text overlays the `fontSize` field is updated (8..200). `rotation` (0..360)
   * applies to both. Absolute values are clamped; pass-through of any axis is
   * skipped when its value is omitted.
   *
   * @param {string} id
   * @param {{scale?:number, fontSize?:number, rotation?:number}} transform
   * @returns {{ok:true, kind:string, entry:Object}|{ok:false, error:string}}
   */
  EditorInstance.prototype.applyTransform = function applyTransform(id, transform) {
    var found = this._findEntry(id);
    if (!found) return { ok: false, error: 'not_found' };
    transform = transform || {};
    var entry = found.entry;

    if (transform.rotation != null) entry.rotation = normalizeRotation(transform.rotation);

    if (found.kind === 'sticker') {
      if (transform.scale != null) entry.scale = clampScale(transform.scale);
    } else {
      // Text overlay: a pinch resizes the font within [8, 200].
      if (transform.fontSize != null) entry.fontSize = clampFontSize(transform.fontSize);
      else if (transform.scale != null) entry.fontSize = clampFontSize(entry.fontSize * Number(transform.scale));
    }

    this.markDirty();
    var clone = found.kind === 'sticker' ? cloneSticker(entry) : cloneTextOverlay(entry);
    return { ok: true, kind: found.kind, entry: clone };
  };

  /**
   * Apply a multiplicative pinch transform (gesture ratio + twist) to an entry
   * (Req 5.4, 6.3). Convenience over {@link applyTransform} for raw gestures:
   * multiplies the current scale/fontSize by `factor` and adds `rotationDelta`.
   *
   * @param {string} id
   * @param {number} factor - Pinch ratio relative to the current size.
   * @param {number} [rotationDelta] - Twist in degrees to add to current rotation.
   * @returns {{ok:true, kind:string, entry:Object}|{ok:false, error:string}}
   */
  EditorInstance.prototype.applyPinch = function applyPinch(id, factor, rotationDelta) {
    var found = this._findEntry(id);
    if (!found) return { ok: false, error: 'not_found' };
    var entry = found.entry;
    if (found.kind === 'sticker') {
      entry.scale = scaleByFactor(entry.scale, factor);
    } else {
      entry.fontSize = fontSizeByFactor(entry.fontSize, factor);
    }
    if (rotationDelta != null) entry.rotation = rotateBy(entry.rotation, rotationDelta);
    this.markDirty();
    var clone = found.kind === 'sticker' ? cloneSticker(entry) : cloneTextOverlay(entry);
    return { ok: true, kind: found.kind, entry: clone };
  };

  /**
   * Remove an overlay/sticker by id.
   * @param {string} id
   * @returns {boolean} Whether an entry was removed.
   */
  EditorInstance.prototype.removeEntry = function removeEntry(id) {
    var found = this._findEntry(id);
    if (!found) return false;
    found.list.splice(found.index, 1);
    this._setInvalid(id, false);
    this.markDirty();
    return true;
  };

  /**
   * Build the Edit_Recipe for this video, or null when the video is skipped
   * (no edits recorded). The returned object contains no rendered pixels
   * (Req 2.1) and uses relative coordinates + degrees + seconds only.
   * @returns {Object|null} EditRecipe or null when skipped.
   */
  EditorInstance.prototype.getRecipe = function getRecipe() {
    if (!this._dirty) return null;

    var recipe = {
      version: RECIPE_VERSION,
      textOverlays: this.textOverlays.map(cloneTextOverlay),
      stickers: this.stickers.map(cloneSticker),
      audio: cloneAudio(this.audio),
    };
    if (this._trim) {
      recipe.trim = { start: this._trim.start, end: this._trim.end };
    }
    return recipe;
  };

  /** Reset all edits back to the skipped (no-recipe) state. */
  EditorInstance.prototype.reset = function reset() {
    this._dirty = false;
    this._trim = null;
    this._trimInvalid = false;
    this.textOverlays = [];
    this.stickers = [];
    this._idCounter = 0;
    this._invalidEntries = {};
    this.audio = {
      originalMuted: false,
      originalVolume: LIMITS.VOLUME_MAX,
      music: null,
    };
  };

  /* ---- recipe-state deep-copy helpers (avoid leaking mutable internals) ---- */

  function cloneTextOverlay(t) {
    return {
      id: t.id,
      text: t.text,
      textColor: t.textColor,
      bgColor: t.bgColor,
      font: t.font,
      fontSize: t.fontSize,
      pos: { x: t.pos.x, y: t.pos.y },
      rotation: t.rotation,
    };
  }

  function cloneSticker(s) {
    return {
      id: s.id,
      assetRef: s.assetRef,
      pos: { x: s.pos.x, y: s.pos.y },
      scale: s.scale,
      rotation: s.rotation,
    };
  }

  function cloneAudio(a) {
    var out = {
      originalMuted: !!a.originalMuted,
      originalVolume: a.originalVolume,
    };
    if (a.music) {
      out.music = {
        assetRef: a.music.assetRef,
        source: a.music.source,
        volume: a.music.volume,
        audioStart: a.music.audioStart,
        loopMode: a.music.loopMode || DEFAULT_LOOP_MODE,
      };
    }
    return out;
  }

  /* ==========================================================================
   * VideoEditorController — editor entry point.
   *
   * Instantiated once after upload. Creates one EditorInstance per uploaded
   * video (0..2, capped at MAX_VIDEOS) and manages the per-video preview
   * surfaces plus the 10s load-failure fallback to the no-editor flow.
   * ======================================================================== */

  /**
   * @param {Object} [options]
   * @param {Function} [options.onFallback] - Called when the editor cannot load
   *   within the timeout; should route to the existing no-editor flow (Req 15.2).
   * @param {number} [options.loadTimeoutMs] - Override the 10s load timeout.
   * @param {Document} [options.document] - Document used to build DOM (browser).
   */
  function VideoEditorController(options) {
    options = options || {};
    this.onFallback = typeof options.onFallback === 'function' ? options.onFallback : null;
    this.loadTimeoutMs = typeof options.loadTimeoutMs === 'number'
      ? options.loadTimeoutMs
      : EDITOR_LOAD_TIMEOUT_MS;
    this._document = options.document || (typeof document !== 'undefined' ? document : null);

    /** @type {EditorInstance[]} */
    this.instances = [];

    /** Registry of tool initializers added by later tasks (12.2/12.6/13.x). */
    this._tools = [];

    this._loadTimer = null;
    this._fellBack = false;
    this._objectUrls = [];
  }

  /**
   * Register a tool initializer. Each registered initializer is invoked with
   * `(instance, surface, controller)` for every video when the editor mounts,
   * letting the text/sticker/trim/audio tools attach themselves to each
   * per-video surface without modifying this entry point.
   * @param {Function} initFn
   */
  VideoEditorController.prototype.registerTool = function registerTool(initFn) {
    if (typeof initFn === 'function') this._tools.push(initFn);
    return this;
  };

  /**
   * Mount the editor for an uploaded video set. Builds a per-video edit surface
   * (preview + overlay layer + toolbar placeholder) inside `container` and
   * creates one EditorInstance per video. Videos beyond MAX_VIDEOS are ignored
   * here (the server input-limit gate is authoritative, Req 1.6/13.6).
   *
   * Starts the load-failure fallback timer (Req 15.1/15.2): if not every preview
   * reports ready within `loadTimeoutMs`, or any preview errors, the editor tears
   * itself down and invokes `onFallback`.
   *
   * @param {HTMLElement|null} container - Where to render surfaces (browser only).
   * @param {Array<{file?:File, key?:string, originalName?:string, url?:string}>} videos
   * @returns {EditorInstance[]} The created instances (index 0..2).
   */
  VideoEditorController.prototype.mount = function mount(container, videos) {
    var self = this;
    var list = (videos || []).slice(0, MAX_VIDEOS);

    this.instances = [];
    this._fellBack = false;

    var readiness = [];

    for (var i = 0; i < list.length; i++) {
      var video = list[i] || {};
      var surface = this._buildSurface(container, i);
      var previewEl = surface ? surface.previewEl : null;

      var instance = new EditorInstance(i, {
        previewEl: previewEl,
        uploadKey: video.key || null,
      });
      this.instances.push(instance);

      readiness.push(this._setupPreview(instance, previewEl, video));

      // Let registered tools attach to this surface (no-ops until 12.2/12.6/13.x).
      for (var t = 0; t < this._tools.length; t++) {
        try {
          this._tools[t](instance, surface, this);
        } catch (err) {
          // A failing tool must not break the editor entry point.
          if (typeof console !== 'undefined') console.warn('Editor tool init failed:', err);
        }
      }
    }

    // Start the 10s load-failure fallback (Req 15.1/15.2).
    this._armFallbackTimer();

    // When every preview becomes ready, cancel the fallback timer.
    if (readiness.length > 0 && typeof Promise !== 'undefined') {
      Promise.all(readiness).then(function () {
        self._cancelFallbackTimer();
      }).catch(function () {
        // A preview failed to load -> route to the no-editor flow immediately.
        self._triggerFallback();
      });
    } else {
      // Nothing to preview (e.g. headless/test) -> no editor surface to wait on.
      this._cancelFallbackTimer();
    }

    return this.instances;
  };

  /**
   * Build a single per-video edit surface. Returns null when there is no DOM
   * (test/headless), in which case the instance has no preview element and the
   * editor naturally degrades to the no-editor flow.
   * @param {HTMLElement|null} container
   * @param {number} index
   * @returns {{root:HTMLElement, previewEl:HTMLVideoElement, overlayLayer:HTMLElement, toolbar:HTMLElement}|null}
   */
  VideoEditorController.prototype._buildSurface = function _buildSurface(container, index) {
    var doc = this._document;
    if (!doc || !container) return null;

    var root = doc.createElement('div');
    root.className = 'editor-surface';
    root.setAttribute('data-video-index', String(index));
    root.style.position = 'relative';

    var stage = doc.createElement('div');
    stage.className = 'editor-stage';
    stage.style.position = 'relative';

    // Native <video> preview only. NO canvas pixel export of the video (Req 2.1).
    var previewEl = doc.createElement('video');
    previewEl.className = 'editor-preview';
    previewEl.setAttribute('playsinline', '');
    previewEl.setAttribute('preload', 'metadata');
    previewEl.muted = true;
    previewEl.controls = true;
    previewEl.style.display = 'block';
    previewEl.style.maxWidth = '100%';

    // Absolutely-positioned overlay layer for DOM overlays (filled by 12.2).
    var overlayLayer = doc.createElement('div');
    overlayLayer.className = 'editor-overlay-layer';
    overlayLayer.style.position = 'absolute';
    overlayLayer.style.left = '0';
    overlayLayer.style.top = '0';
    overlayLayer.style.right = '0';
    overlayLayer.style.bottom = '0';
    overlayLayer.style.pointerEvents = 'none';

    // Toolbar placeholder; tools (text/sticker/trim/audio) append controls here.
    var toolbar = doc.createElement('div');
    toolbar.className = 'editor-toolbar';

    stage.appendChild(previewEl);
    stage.appendChild(overlayLayer);
    root.appendChild(stage);
    root.appendChild(toolbar);
    container.appendChild(root);

    return { root: root, previewEl: previewEl, overlayLayer: overlayLayer, toolbar: toolbar };
  };

  /**
   * Wire a preview element to its video source and resolve when ready.
   * Resolves on 'loadedmetadata' (capturing source duration, Req 2.4 bounds),
   * rejects on 'error'. Resolves immediately when there is no preview element.
   * @returns {Promise<void>}
   */
  VideoEditorController.prototype._setupPreview = function _setupPreview(instance, previewEl, video) {
    var self = this;
    if (!previewEl) return Promise.resolve();

    var src = video && video.url ? video.url : null;
    if (!src && video && video.file && typeof URL !== 'undefined' && URL.createObjectURL) {
      try {
        src = URL.createObjectURL(video.file);
        this._objectUrls.push(src);
      } catch (err) {
        // Could not create a preview source -> treat as a load failure (Req 15.2).
        return Promise.reject(err);
      }
    }

    return new Promise(function (resolve, reject) {
      function onLoaded() {
        instance.ready = true;
        instance.sourceDuration = isFinite(previewEl.duration) ? previewEl.duration : 0;
        cleanup();
        resolve();
      }
      function onError() {
        cleanup();
        reject(new Error('Preview failed to load for video ' + instance.videoIndex));
      }
      function cleanup() {
        previewEl.removeEventListener('loadedmetadata', onLoaded);
        previewEl.removeEventListener('error', onError);
      }
      previewEl.addEventListener('loadedmetadata', onLoaded);
      previewEl.addEventListener('error', onError);

      if (src) {
        previewEl.src = src;
      } else {
        // No usable source -> cannot preview; treat as a load failure.
        cleanup();
        reject(new Error('No preview source for video ' + instance.videoIndex));
      }
    });
  };

  VideoEditorController.prototype._armFallbackTimer = function _armFallbackTimer() {
    var self = this;
    this._cancelFallbackTimer();
    if (typeof setTimeout !== 'function') return;
    this._loadTimer = setTimeout(function () {
      self._triggerFallback();
    }, this.loadTimeoutMs);
  };

  VideoEditorController.prototype._cancelFallbackTimer = function _cancelFallbackTimer() {
    if (this._loadTimer != null && typeof clearTimeout === 'function') {
      clearTimeout(this._loadTimer);
    }
    this._loadTimer = null;
  };

  /**
   * Route to the existing no-editor flow (Req 15.2). Idempotent: only fires
   * once, tears down editor resources, then invokes the onFallback callback.
   */
  VideoEditorController.prototype._triggerFallback = function _triggerFallback() {
    if (this._fellBack) return;
    this._fellBack = true;
    this._cancelFallbackTimer();
    this.destroy();
    if (this.onFallback) {
      try {
        this.onFallback();
      } catch (err) {
        if (typeof console !== 'undefined') console.error('Editor fallback handler failed:', err);
      }
    }
  };

  /** @returns {boolean} Whether the editor fell back to the no-editor flow. */
  VideoEditorController.prototype.didFallback = function didFallback() {
    return this._fellBack;
  };

  /** @returns {EditorInstance[]} All per-video instances. */
  VideoEditorController.prototype.getInstances = function getInstances() {
    return this.instances.slice();
  };

  /**
   * @param {number} index
   * @returns {EditorInstance|null}
   */
  VideoEditorController.prototype.getInstance = function getInstance(index) {
    return this.instances[index] || null;
  };

  /**
   * Collect the per-video recipes keyed by upload key (the shape /api/process
   * expects). Videos with no edits are omitted (skipped). The actual request
   * wiring is task 13.7; this provides the data it will serialize.
   * @returns {Object<string, Object>} Map of uploadKey -> EditRecipe.
   */
  VideoEditorController.prototype.getRecipesByKey = function getRecipesByKey() {
    var map = {};
    for (var i = 0; i < this.instances.length; i++) {
      var inst = this.instances[i];
      var recipe = inst.getRecipe();
      if (recipe && inst.uploadKey) {
        map[inst.uploadKey] = recipe;
      }
    }
    return map;
  };

  /** Release object URLs and timers. Safe to call multiple times. */
  VideoEditorController.prototype.destroy = function destroy() {
    this._cancelFallbackTimer();
    if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
      for (var i = 0; i < this._objectUrls.length; i++) {
        try { URL.revokeObjectURL(this._objectUrls[i]); } catch (e) { /* ignore */ }
      }
    }
    this._objectUrls = [];
  };

  /* ==========================================================================
   * Browser DOM tool layer (task 12.2).
   *
   * Translates pointer/touch gestures into calls on the EditorInstance tool
   * methods above. This is the ONLY DOM-dependent part of the text/sticker
   * tools; all recording logic lives in the (testable) instance methods. The
   * layer degrades gracefully: with no surface/DOM it does nothing, so the
   * recipe model stays fully usable (and testable) without a browser.
   *
   * Register it with `controller.registerTool(overlayToolInitializer(opts))`,
   * or call `registerOverlayTools(controller, opts)` for the common case.
   * ======================================================================== */

  /** Default sticker palette used by the picker when none is supplied. */
  var DEFAULT_STICKER_ASSETS = ['emoji_smile', 'emoji_heart', 'emoji_fire', 'emoji_star', 'emoji_party'];

  /**
   * Create a tool initializer (suitable for {@link VideoEditorController#registerTool})
   * that wires the text-overlay and sticker tools onto each per-video surface.
   *
   * @param {Object} [opts]
   * @param {string[]} [opts.stickerAssets] - Asset refs offered by the picker.
   * @param {Document} [opts.document] - Document for DOM creation (browser default).
   * @returns {Function} initializer (instance, surface, controller) => void
   */
  function overlayToolInitializer(opts) {
    opts = opts || {};
    var stickerAssets = opts.stickerAssets || DEFAULT_STICKER_ASSETS;

    return function initOverlayTools(instance, surface, controller) {
      var doc = (controller && controller._document) || opts.document
        || (typeof document !== 'undefined' ? document : null);
      // No DOM surface -> tools are model-only (still fully functional via API).
      if (!doc || !surface || !surface.toolbar || !surface.overlayLayer) return;

      var overlayLayer = surface.overlayLayer;
      var elements = {}; // id -> overlay DOM node

      function syncElement(id) {
        var found = instance._findEntry(id);
        var el = elements[id];
        if (!found) {
          if (el && el.parentNode) el.parentNode.removeChild(el);
          delete elements[id];
          return;
        }
        var rect = instance.getPreviewRect();
        var px = relativeToPixel(found.entry.pos.x, found.entry.pos.y, rect.width, rect.height);
        if (!el) {
          el = doc.createElement('div');
          el.className = found.kind === 'text' ? 'editor-text-overlay' : 'editor-sticker';
          el.setAttribute('data-entry-id', id);
          el.style.position = 'absolute';
          el.style.pointerEvents = 'auto';
          el.style.cursor = 'move';
          el.style.userSelect = 'none';
          el.style.touchAction = 'none';
          overlayLayer.appendChild(el);
          elements[id] = el;
          attachDrag(el, id);
        }
        if (found.kind === 'text') {
          el.textContent = found.entry.text;
          el.style.color = found.entry.textColor;
          el.style.background = found.entry.bgColor;
          el.style.fontFamily = found.entry.font;
          el.style.fontSize = found.entry.fontSize + 'px';
          el.style.transform = 'translate(-50%, -50%) rotate(' + found.entry.rotation + 'deg)';
          el.style.outline = instance.isEntryInvalid(id) ? '2px solid #ff3b30' : 'none';
        } else {
          el.textContent = found.entry.assetRef;
          el.style.transform = 'translate(-50%, -50%) rotate(' + found.entry.rotation + 'deg) scale(' + found.entry.scale + ')';
        }
        el.style.left = px.x + 'px';
        el.style.top = px.y + 'px';
      }

      function attachDrag(el, id) {
        var dragging = false;
        function onDown(ev) {
          dragging = true;
          if (el.setPointerCapture && ev.pointerId != null) {
            try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
          }
          ev.preventDefault();
        }
        function onMove(ev) {
          if (!dragging) return;
          var rel = instance.pointerToRelative(ev.clientX, ev.clientY);
          instance.applyDragToRelative(id, rel);
          syncElement(id);
        }
        function onUp() { dragging = false; }
        if (el.addEventListener) {
          el.addEventListener('pointerdown', onDown);
          el.addEventListener('pointermove', onMove);
          el.addEventListener('pointerup', onUp);
          el.addEventListener('pointercancel', onUp);
          // Wheel = resize (mouse interaction, Req 5.4/6.3).
          el.addEventListener('wheel', function (ev) {
            var factor = ev.deltaY < 0 ? 1.05 : 0.95;
            instance.applyPinch(id, factor, 0);
            syncElement(id);
            ev.preventDefault();
          });
        }
      }

      // ---- Toolbar: add-text and sticker picker -----------------------------
      var addTextBtn = doc.createElement('button');
      addTextBtn.type = 'button';
      addTextBtn.className = 'editor-add-text';
      addTextBtn.textContent = 'Add text';
      addTextBtn.addEventListener('click', function () {
        var initial = typeof opts.promptText === 'function'
          ? opts.promptText()
          : (typeof prompt !== 'undefined' ? prompt('Text:') : null);
        var result = instance.addTextOverlay({ text: initial == null ? '' : initial });
        if (result.ok) syncElement(result.overlay.id);
      });
      surface.toolbar.appendChild(addTextBtn);

      for (var a = 0; a < stickerAssets.length; a++) {
        (function (assetRef) {
          var btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'editor-add-sticker';
          btn.setAttribute('data-asset-ref', assetRef);
          btn.textContent = assetRef;
          btn.addEventListener('click', function () {
            var result = instance.addSticker({ assetRef: assetRef });
            if (result.ok) syncElement(result.sticker.id);
          });
          surface.toolbar.appendChild(btn);
        })(stickerAssets[a]);
      }

      // Expose a redraw hook so external edits (e.g. text edit dialogs) refresh.
      instance._syncOverlayElement = syncElement;
    };
  }

  /**
   * Register the overlay tools on a controller (convenience wrapper).
   * @param {VideoEditorController} controller
   * @param {Object} [opts] - See {@link overlayToolInitializer}.
   * @returns {VideoEditorController}
   */
  function registerOverlayTools(controller, opts) {
    if (controller && typeof controller.registerTool === 'function') {
      controller.registerTool(overlayToolInitializer(opts));
    }
    return controller;
  }

  /* ==========================================================================
   * Browser DOM trim tool layer (task 12.6).
   *
   * Translates dual-handle drag gestures into EditorInstance.attemptTrim calls.
   * This is the ONLY DOM-dependent part of the trim tool; all recording and
   * validation logic lives in the (testable) instance methods and the pure
   * helpers (isValidTrim / fractionToTime / computeTrimFromDrag) above. The
   * layer degrades gracefully: with no surface/DOM it does nothing, so the
   * recipe model's trim recording stays fully usable (and testable) without a
   * browser.
   *
   * Register it with `controller.registerTool(trimToolInitializer(opts))`, or
   * call `registerTrimTool(controller, opts)` for the common case.
   * ======================================================================== */

  /**
   * Create a tool initializer (suitable for {@link VideoEditorController#registerTool})
   * that wires a dual-handle trim control onto each per-video surface. The
   * control renders a track with a start handle and an end handle; dragging a
   * handle records the selection through {@link EditorInstance#attemptTrim}.
   * A valid selection is recorded exactly; an invalid one retains the prior
   * values and shows an invalid indication (Req 4.3).
   *
   * @param {Object} [opts]
   * @param {Document} [opts.document] - Document for DOM creation (browser default).
   * @returns {Function} initializer (instance, surface, controller) => void
   */
  function trimToolInitializer(opts) {
    opts = opts || {};

    return function initTrimTool(instance, surface, controller) {
      var doc = (controller && controller._document) || opts.document
        || (typeof document !== 'undefined' ? document : null);
      // No DOM surface -> tool is model-only (still fully functional via API).
      if (!doc || !surface || !surface.toolbar) return;

      // ---- Build the dual-handle control --------------------------------
      var control = doc.createElement('div');
      control.className = 'editor-trim-control';
      control.style.position = 'relative';

      var track = doc.createElement('div');
      track.className = 'editor-trim-track';
      track.style.position = 'relative';
      track.style.touchAction = 'none';

      var selection = doc.createElement('div');
      selection.className = 'editor-trim-selection';
      selection.style.position = 'absolute';
      selection.style.top = '0';
      selection.style.bottom = '0';
      selection.style.pointerEvents = 'none';

      var startHandle = doc.createElement('div');
      startHandle.className = 'editor-trim-handle editor-trim-handle-start';
      startHandle.setAttribute('data-handle', 'start');
      startHandle.style.position = 'absolute';
      startHandle.style.touchAction = 'none';
      startHandle.style.cursor = 'ew-resize';

      var endHandle = doc.createElement('div');
      endHandle.className = 'editor-trim-handle editor-trim-handle-end';
      endHandle.setAttribute('data-handle', 'end');
      endHandle.style.position = 'absolute';
      endHandle.style.touchAction = 'none';
      endHandle.style.cursor = 'ew-resize';

      var indicator = doc.createElement('div');
      indicator.className = 'editor-trim-invalid';
      indicator.setAttribute('role', 'alert');
      indicator.style.display = 'none';
      indicator.textContent = 'Invalid trim range';

      track.appendChild(selection);
      track.appendChild(startHandle);
      track.appendChild(endHandle);
      control.appendChild(track);
      control.appendChild(indicator);
      surface.toolbar.appendChild(control);

      // ---- Track geometry ------------------------------------------------
      function trackRect() {
        if (typeof track.getBoundingClientRect === 'function') {
          return track.getBoundingClientRect();
        }
        return { left: 0, width: 0 };
      }

      // Position the two handles + selection band from the effective trim, and
      // reflect the current invalid indication on the control (Req 4.3).
      function syncControl() {
        var duration = instance.sourceDuration || 0;
        var sel = instance.getTrimOrDefault();
        var startFrac = timeToFraction(sel.start, duration);
        var endFrac = timeToFraction(sel.end, duration);
        startHandle.style.left = (startFrac * 100) + '%';
        endHandle.style.left = (endFrac * 100) + '%';
        selection.style.left = (startFrac * 100) + '%';
        selection.style.width = Math.max(0, (endFrac - startFrac) * 100) + '%';
        var invalid = instance.isTrimInvalid();
        indicator.style.display = invalid ? '' : 'none';
        control.style.outline = invalid ? '2px solid #ff3b30' : 'none';
      }

      // ---- Drag handling -------------------------------------------------
      function attachHandle(handleEl, which) {
        var dragging = false;
        function onDown(ev) {
          dragging = true;
          if (handleEl.setPointerCapture && ev.pointerId != null) {
            try { handleEl.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
          }
          if (ev.preventDefault) ev.preventDefault();
        }
        function onMove(ev) {
          if (!dragging) return;
          var rect = trackRect();
          var fraction = rect.width > 0 ? (Number(ev.clientX) - rect.left) / rect.width : 0;
          // Drag this handle, hold the other at its current effective value.
          var current = instance.getTrimOrDefault();
          var candidate = computeTrimFromDrag(which, fraction, current, instance.sourceDuration || 0);
          // Records when valid; retains prior + flags invalid otherwise (Req 4.3).
          instance.attemptTrim(candidate.start, candidate.end);
          syncControl();
        }
        function onUp() { dragging = false; }
        if (handleEl.addEventListener) {
          handleEl.addEventListener('pointerdown', onDown);
          handleEl.addEventListener('pointermove', onMove);
          handleEl.addEventListener('pointerup', onUp);
          handleEl.addEventListener('pointercancel', onUp);
        }
      }

      attachHandle(startHandle, 'start');
      attachHandle(endHandle, 'end');

      // Initial layout (uses sourceDuration if already known; re-sync on load).
      syncControl();
      if (instance.previewEl && instance.previewEl.addEventListener) {
        instance.previewEl.addEventListener('loadedmetadata', syncControl);
      }

      // Expose a redraw hook so external trim edits (e.g. numeric inputs) refresh.
      instance._syncTrimControl = syncControl;
    };
  }

  /**
   * Register the trim tool on a controller (convenience wrapper).
   * @param {VideoEditorController} controller
   * @param {Object} [opts] - See {@link trimToolInitializer}.
   * @returns {VideoEditorController}
   */
  function registerTrimTool(controller, opts) {
    if (controller && typeof controller.registerTool === 'function') {
      controller.registerTool(trimToolInitializer(opts));
    }
    return controller;
  }

  /* ==========================================================================
   * Public API
   * ======================================================================== */
  return {
    // Entry point + instances
    VideoEditorController: VideoEditorController,
    EditorInstance: EditorInstance,

    // Browser overlay tool layer (task 12.2)
    overlayToolInitializer: overlayToolInitializer,
    registerOverlayTools: registerOverlayTools,

    // Browser trim tool layer (task 12.6)
    trimToolInitializer: trimToolInitializer,
    registerTrimTool: registerTrimTool,

    // Pure helpers (exported for the tool layers and property tests)
    clamp: clamp,
    clampRelative: clampRelative,
    clampRelativePosition: clampRelativePosition,
    normalizeRotation: normalizeRotation,
    clampScale: clampScale,
    clampFontSize: clampFontSize,
    clampVolume: clampVolume,
    pixelToRelative: pixelToRelative,
    relativeToPixel: relativeToPixel,
    mapRelToCanvas: mapRelToCanvas,
    clientPointToRelative: clientPointToRelative,

    // Text / sticker tool pure helpers (task 12.2, exported for tasks 12.3–12.5)
    isValidTextContent: isValidTextContent,
    buildTextOverlay: buildTextOverlay,
    buildSticker: buildSticker,
    scaleByFactor: scaleByFactor,
    fontSizeByFactor: fontSizeByFactor,
    rotateBy: rotateBy,

    // Trim tool pure helpers (task 12.6, exported for unit/property tests)
    isValidTrim: isValidTrim,
    fractionToTime: fractionToTime,
    timeToFraction: timeToFraction,
    computeTrimFromDrag: computeTrimFromDrag,

    // Constants (mirrored from src/shared/constants.js)
    CANVAS: CANVAS,
    LIMITS: LIMITS,
    MAX_VIDEOS: MAX_VIDEOS,
    RECIPE_VERSION: RECIPE_VERSION,
    DEFAULT_LOOP_MODE: DEFAULT_LOOP_MODE,
    TEXT_OVERLAY_DEFAULTS: TEXT_OVERLAY_DEFAULTS,
    STICKER_DEFAULTS: STICKER_DEFAULTS,
    DEFAULT_STICKER_ASSETS: DEFAULT_STICKER_ASSETS,
    EDITOR_LOAD_TIMEOUT_MS: EDITOR_LOAD_TIMEOUT_MS,
  };
});
