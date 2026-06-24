'use strict';

/**
 * Shared constants for the StatusDrop video editor.
 *
 * Centralizes the WhatsApp Status output specification, splitting/size limits,
 * Edit_Recipe validation caps, and input limits so the Recipe_Validator,
 * Render_Engine, and browser editor all agree on the same numbers.
 *
 * CommonJS module to match the existing codebase (server.js).
 */

/**
 * The target output format every clip is normalized to (WhatsApp_Spec).
 * Mirrors the encode settings produced by `getOutputOptions` in server.js.
 * @see Requirements 12.1
 */
const WHATSAPP_SPEC = Object.freeze({
  /** Fixed output canvas width in pixels. */
  CANVAS_WIDTH: 1080,
  /** Fixed output canvas height in pixels. */
  CANVAS_HEIGHT: 1920,
  VIDEO_CODEC: 'libx264',
  PROFILE: 'high',
  LEVEL: '4.0',
  PIXEL_FORMAT: 'yuv420p',
  CRF: 23,
  MAXRATE: '3800k',
  BUFSIZE: '5700k',
  AUDIO_CODEC: 'aac',
  AUDIO_BITRATE: '128k',
  AUDIO_SAMPLE_RATE: 44100,
  FASTSTART: true,
});

/**
 * Maximum duration (seconds) of a single Status clip used when splitting.
 * Videos longer than this are split into chunks each <= this duration.
 * @see Requirements 4.6
 */
const CLIP_DURATION_LIMIT = 29;

/**
 * Per-clip size ceiling (bytes) above which WhatsApp re-compresses.
 * Outputs target staying at or under 16 MB.
 * @see Requirements 11.5, 12.2
 */
const SIZE_LIMIT_BYTES = 16 * 1024 * 1024; // 16,777,216

/**
 * Practical re-encode trigger used by the existing retry loop (15.5 MB),
 * kept just under the hard Size_Limit to leave container overhead headroom.
 */
const RETRY_SIZE_THRESHOLD_BYTES = Math.round(15.5 * 1024 * 1024); // 16,252,928

/**
 * Edit_Recipe validation caps enforced by the Recipe_Validator.
 * @see Requirements 3.7, 5.2, 6.3, 2.2, 2.3
 */
const RECIPE_LIMITS = Object.freeze({
  /** Maximum serialized recipe size in bytes. */
  MAX_SERIALIZED_BYTES: 65536,
  /** Maximum combined Sticker + Music_Track operations. */
  MAX_STICKER_MUSIC_OPS: 50,
  /** Maximum number of Text_Overlays. */
  MAX_TEXT_OVERLAYS: 20,
  /** Maximum number of Stickers. */
  MAX_STICKERS: 20,
  /** Exactly one Music_Track is allowed. */
  MAX_MUSIC_TRACKS: 1,
  /** Font size range for Text_Overlays (inclusive). */
  FONT_SIZE_MIN: 8,
  FONT_SIZE_MAX: 200,
  /** Sticker scale factor range (inclusive). */
  SCALE_MIN: 0.1,
  SCALE_MAX: 5.0,
  /** Volume percentage range (integer, inclusive). */
  VOLUME_MIN: 0,
  VOLUME_MAX: 100,
  /** Text content length range (inclusive). */
  TEXT_LENGTH_MIN: 1,
  TEXT_LENGTH_MAX: 200,
  /** Rotation range in degrees (inclusive). */
  ROTATION_MIN: 0,
  ROTATION_MAX: 360,
  /** Relative coordinate range per axis (inclusive). */
  COORD_MIN: 0.0,
  COORD_MAX: 1.0,
});

/**
 * Input limits enforced before any encode operation begins.
 * @see Requirements 1.6, 13.5, 13.6, 8.5
 */
const INPUT_LIMITS = Object.freeze({
  /** Maximum number of videos per upload. */
  MAX_VIDEOS: 3,
  /** Maximum total size (bytes) across all videos: 300 MB. */
  MAX_TOTAL_VIDEO_BYTES: 300 * 1024 * 1024, // 314,572,800
  /** Maximum added audio size (bytes) per video: 20 MB. */
  MAX_AUDIO_BYTES: 20 * 1024 * 1024, // 20,971,520
  /** Maximum added audio duration (seconds): 10 minutes. */
  MAX_AUDIO_DURATION_SECONDS: 600,
});

/**
 * Default Loop_Mode applied when a Music_Track is shorter than the output
 * and no preference is set.
 * @see Requirements 10.3
 */
const DEFAULT_LOOP_MODE = 'loop';

/**
 * Tolerance (seconds) within which a Music_Track equal to the output duration
 * plays once without looping or truncation.
 * @see Requirements 10.8
 */
const AUDIO_EQUAL_TOLERANCE_SECONDS = 0.05;

module.exports = {
  WHATSAPP_SPEC,
  CLIP_DURATION_LIMIT,
  SIZE_LIMIT_BYTES,
  RETRY_SIZE_THRESHOLD_BYTES,
  RECIPE_LIMITS,
  INPUT_LIMITS,
  DEFAULT_LOOP_MODE,
  AUDIO_EQUAL_TOLERANCE_SECONDS,
};

/* ============================================================================
 * JSDoc typedefs for the edit recipe and render data models.
 * These are documentation-only (no runtime cost) and give editors/tooling
 * shared type information across the validator, render engine, and browser.
 * ==========================================================================*/

/**
 * A relative coordinate pair on the video frame. Each axis is in [0.0, 1.0]
 * where 0.0 is the top/left edge and 1.0 is the bottom/right edge.
 * @typedef {Object} RelativePosition
 * @property {number} x - Horizontal position, 0.0 (left) to 1.0 (right).
 * @property {number} y - Vertical position, 0.0 (top) to 1.0 (bottom).
 */

/**
 * A full-duration text element rendered over the video.
 * @typedef {Object} TextOverlay
 * @property {string} id - Stable identifier for the overlay.
 * @property {string} text - Text content, 1 to 200 characters.
 * @property {string} textColor - Text color (e.g. "#FFFFFF").
 * @property {string} bgColor - Background color, may be transparent (e.g. "#00000080").
 * @property {string} font - Font family selection.
 * @property {number} fontSize - Font size, 8 to 200.
 * @property {RelativePosition} pos - Relative position, 0.0 to 1.0 per axis.
 * @property {number} rotation - Rotation in degrees, 0 to 360.
 */

/**
 * A full-duration image/emoji element rendered over the video.
 * @typedef {Object} Sticker
 * @property {string} id - Stable identifier for the sticker.
 * @property {string} assetRef - Reference to a validated sticker asset.
 * @property {RelativePosition} pos - Center position, 0.0 to 1.0 per axis (clamped).
 * @property {number} scale - Scale factor, 0.1 to 5.0.
 * @property {number} rotation - Rotation in degrees, 0 to 360.
 */

/**
 * A trim selection over the source video, in seconds.
 * @typedef {Object} Trim
 * @property {number} start - Start time, >= 0 and < end.
 * @property {number} end - End time, > start and <= source duration.
 */

/**
 * Music_Track configuration within an Edit_Recipe.
 * @typedef {Object} MusicConfig
 * @property {string} assetRef - Upload id or library id; must exist and be validated.
 * @property {('upload'|'library')} source - Where the track comes from.
 * @property {number} volume - Music volume, integer 0 to 100.
 * @property {number} audioStart - Selected start offset in seconds (ms precision).
 * @property {('loop'|'once')} loopMode - Behavior when shorter than the video; defaults to "loop".
 */

/**
 * Audio settings within an Edit_Recipe.
 * @typedef {Object} AudioConfig
 * @property {boolean} originalMuted - Whether the original audio is muted (default false).
 * @property {number} originalVolume - Original audio volume, integer 0 to 100.
 * @property {MusicConfig} [music] - Optional single Music_Track.
 */

/**
 * The browser-captured edits for a single video. Contains no rendered pixels.
 * @typedef {Object} EditRecipe
 * @property {number} version - Recipe schema version.
 * @property {Trim} [trim] - Optional trim; when absent the full source is used.
 * @property {TextOverlay[]} textOverlays - 0 to 20 text overlays.
 * @property {Sticker[]} stickers - 0 to 20 stickers.
 * @property {AudioConfig} audio - Audio settings.
 */

/**
 * Source video metadata resolved on the server.
 * @typedef {Object} VideoMeta
 * @property {number} width - Source pixel width.
 * @property {number} height - Source pixel height.
 * @property {number} duration - Source duration in seconds.
 * @property {string} key - Upload key identifying the video.
 */

/**
 * The resolved audio rendering plan derived from an AudioConfig.
 * @typedef {Object} AudioPlan
 * @property {('original'|'music'|'mix'|'silence')} mode - Which audio sources are present.
 * @property {boolean} originalMuted - Whether the original audio is muted.
 * @property {number} originalVolume - Original volume, 0 to 100.
 * @property {boolean} hasMusic - Whether a Music_Track is present.
 * @property {number} [musicVolume] - Music volume, 0 to 100 (when hasMusic).
 * @property {number} [audioStart] - Music start offset in seconds (when hasMusic).
 * @property {('loop'|'once')} [loopMode] - Loop behavior (when hasMusic).
 */

/**
 * One input to the single ffmpeg Compression_Pass.
 * @typedef {Object} InputSpec
 * @property {('video'|'image'|'audio')} type - Kind of input.
 * @property {string} path - Local path to the input file.
 */

/**
 * The full render plan for one video's single encode.
 * @typedef {Object} RenderPlan
 * @property {InputSpec[]} inputs - Ordered inputs [video, ...stickerPngs, music?].
 * @property {string} filterComplex - The filter graph string; '' when no recipe.
 * @property {string[]} encodeOptions - Encode options (getOutputOptions output), unchanged.
 * @property {Trim} [trim] - Optional trim applied via -ss/-to.
 * @property {AudioPlan} audioPlan - The resolved audio plan.
 */

/**
 * The render plan for a single chunk of a split video. Extends a RenderPlan
 * with the chunk's position on the output timeline and its source seek.
 * @typedef {Object} ChunkRenderPlan
 * @property {number} chunkIndex - Zero-based index of this chunk.
 * @property {number} chunkCount - Total number of chunks tiling [0, D].
 * @property {number} chunkStart - Chunk start on the output timeline (seconds).
 * @property {number} chunkEnd - Chunk end on the output timeline (seconds).
 * @property {number} chunkDuration - chunkEnd - chunkStart (<= Clip_Duration_Limit).
 * @property {number} sourceSeek - Source seek = trim start + chunkIndex * clipLimit.
 * @property {InputSpec[]} inputs - Inputs with the video input bounded to this chunk.
 * @property {string} filterComplex - Overlay graph, identical across chunks.
 * @property {string[]} encodeOptions - Encode-only options (one video encode).
 * @property {AudioPlan} audioPlan - The resolved audio plan.
 * @property {Trim} [trim] - Optional trim carried from the base plan.
 */

/**
 * A validated uploaded music asset.
 * @typedef {Object} MusicAsset
 * @property {string} assetId - Stable asset identifier.
 * @property {string} r2Key - R2 object key.
 * @property {string} [localPath] - Local path once downloaded.
 * @property {number} sizeBytes - File size in bytes (<= 20 MB).
 * @property {number} duration - Duration in seconds (<= 600).
 * @property {boolean} validated - Whether size/duration checks passed.
 */

/**
 * A curated royalty-free library track.
 * @typedef {Object} LibraryTrack
 * @property {string} id - Track identifier.
 * @property {string} title - Track title.
 * @property {string} artist - Track artist.
 * @property {number} duration - Duration in seconds.
 * @property {string} url - Public URL to the track.
 * @property {string} license - License identifier/description.
 */
