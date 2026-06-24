'use strict';

/**
 * Render_Engine — pure planning core.
 *
 * This module builds the ffmpeg argument list (filter graph + inputs + encode
 * options) for one video. It is intentionally split into a pure planning layer
 * (testable without ffmpeg) and a thin execution layer added by later tasks.
 *
 * This file (task 3.1) provides the resolution-independent coordinate and
 * transform mapping primitives. Later tasks extend it with `planRender`
 * (task 3.3) and `planChunk` (task 4.1), which reuse these helpers.
 *
 * Resolution independence: an Edit_Recipe stores overlay positions as fractions
 * of frame width/height (0.0–1.0) and rotation in degrees. The Render_Engine
 * maps them to pixels against the fixed WhatsApp_Spec canvas (1080×1920):
 *   x = round(relX * W), y = round(relY * H)
 * Because every chunk shares the same canvas, overlays land identically in
 * every chunk (Req 11.1).
 *
 * Overlay positioning is center-based to match the editor preview, where the
 * recorded relative position denotes the center of the overlay. The ffmpeg
 * `overlay` filter places by top-left corner, so given an overlay of pixel
 * size (w, h) the top-left is:
 *   x = W * relX - w / 2,  y = H * relY - h / 2
 *
 * @see Requirements 5.8, 6.7
 *
 * CommonJS module to match the existing codebase (server.js).
 */

const { WHATSAPP_SPEC, CLIP_DURATION_LIMIT } = require('../shared/constants');
const { planAudio } = require('./audioPlan');

const CANVAS_WIDTH = WHATSAPP_SPEC.CANVAS_WIDTH; // 1080
const CANVAS_HEIGHT = WHATSAPP_SPEC.CANVAS_HEIGHT; // 1920

/**
 * The base video normalization filter chain (scale → pad → even-dimension
 * scale). This is the EXACT filter string used by the legacy no-editor encode
 * in `server.js` `getOutputOptions`. Keeping it as a single shared constant
 * guarantees the skip path produces a byte-for-byte identical command and lets
 * the recipe path reuse the same normalization inside `-filter_complex`.
 *
 * @see Requirements 1.2, 1.4, 1.5, 12.1
 */
const BASE_VIDEO_FILTER =
  'scale=w=1080:h=1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,scale=trunc(iw/2)*2:trunc(ih/2)*2';

/**
 * Map a relative coordinate pair (each axis in [0.0, 1.0]) to integer pixel
 * coordinates on a canvas of the given dimensions.
 *
 * x = round(relX * w), y = round(relY * h)
 *
 * @param {number} relX - Horizontal relative position, 0.0 (left) to 1.0 (right).
 * @param {number} relY - Vertical relative position, 0.0 (top) to 1.0 (bottom).
 * @param {number} w - Canvas width in pixels.
 * @param {number} h - Canvas height in pixels.
 * @returns {{ x: number, y: number }} Pixel coordinates (rounded to integers).
 * @see Requirements 5.8, 6.7
 */
function mapRelToPixels(relX, relY, w, h) {
  return {
    x: Math.round(relX * w),
    y: Math.round(relY * h),
  };
}

/**
 * Convert an angle in degrees to radians, as required by ffmpeg's `rotate`
 * filter (which expects radians).
 *
 * radians = degrees * PI / 180
 *
 * @param {number} degrees - Rotation in degrees (recipe range 0–360).
 * @returns {number} The equivalent angle in radians.
 * @see Requirements 5.8, 6.7
 */
function degToRad(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Compute the top-left pixel position for an `overlay` filter, given the
 * overlay's center expressed as a relative coordinate and the overlay's pixel
 * dimensions. The ffmpeg `overlay` filter positions by the top-left corner,
 * while the recipe records the overlay center, so we offset by half the
 * overlay size:
 *   x = W * relX - w / 2,  y = H * relY - h / 2
 *
 * @param {number} relX - Center horizontal relative position, 0.0 to 1.0.
 * @param {number} relY - Center vertical relative position, 0.0 to 1.0.
 * @param {number} overlayW - Overlay width in pixels.
 * @param {number} overlayH - Overlay height in pixels.
 * @param {number} [canvasW=CANVAS_WIDTH] - Canvas width in pixels.
 * @param {number} [canvasH=CANVAS_HEIGHT] - Canvas height in pixels.
 * @returns {{ x: number, y: number }} Top-left pixel position (rounded).
 * @see Requirements 5.8, 6.7
 */
function overlayTopLeft(
  relX,
  relY,
  overlayW,
  overlayH,
  canvasW = CANVAS_WIDTH,
  canvasH = CANVAS_HEIGHT
) {
  return {
    x: Math.round(canvasW * relX - overlayW / 2),
    y: Math.round(canvasH * relY - overlayH / 2),
  };
}

/**
 * Resolve a recipe overlay's relative position, scale, and rotation into the
 * concrete placement values used to build the ffmpeg filter graph on the fixed
 * WhatsApp_Spec canvas (1080×1920).
 *
 * The returned object exposes everything a later `planRender`/`planChunk` step
 * needs to emit `scale → rotate → overlay` nodes for one overlay:
 *  - `center`   : the overlay center in pixels (round(rel × dimension)).
 *  - `scale`    : the recipe scale factor, passed through unchanged.
 *  - `rotationDeg` / `rotationRad` : rotation in degrees and the radians ffmpeg needs.
 *
 * Because the canvas is fixed, the same recipe yields the same placement in
 * every chunk (Req 11.1), and the mapping stays within 1% of `rel × dimension`
 * per axis, scale within 1%, and rotation within 1 degree (Req 5.8, 6.7).
 *
 * @param {{ pos: { x: number, y: number }, scale?: number, rotation?: number }} overlay
 *   A recipe overlay (Sticker or rasterized Text_Overlay). `scale` defaults to
 *   1 (text overlays are pre-rasterized at their font size), `rotation` to 0.
 * @param {number} [canvasW=CANVAS_WIDTH] - Canvas width in pixels.
 * @param {number} [canvasH=CANVAS_HEIGHT] - Canvas height in pixels.
 * @returns {{
 *   center: { x: number, y: number },
 *   scale: number,
 *   rotationDeg: number,
 *   rotationRad: number
 * }} The resolved overlay placement.
 * @see Requirements 5.8, 6.7
 */
function mapOverlayTransform(overlay, canvasW = CANVAS_WIDTH, canvasH = CANVAS_HEIGHT) {
  const relX = overlay.pos.x;
  const relY = overlay.pos.y;
  const scale = typeof overlay.scale === 'number' ? overlay.scale : 1;
  const rotationDeg = typeof overlay.rotation === 'number' ? overlay.rotation : 0;

  return {
    center: mapRelToPixels(relX, relY, canvasW, canvasH),
    scale,
    rotationDeg,
    rotationRad: degToRad(rotationDeg),
  };
}

/**
 * The encode-only ffmpeg options (everything after the `-vf` filter): codec,
 * color, rate-control, profile/level, audio, container, and threading. These
 * are identical for both the skip path and the recipe path, so editing never
 * changes the encode settings — only the filter graph differs. This is the
 * exact tail of `server.js` `getOutputOptions`.
 *
 * Exactly one `-c:v` appears here, which is the single video encode operation
 * (Property 20 / Req 12.3).
 *
 * @returns {string[]} A fresh array of encode-only option tokens.
 */
function encodeOnlyOptions() {
  return [
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'tv',
    '-color_primaries', 'bt470bg',
    '-color_trc', 'bt709',
    '-colorspace', 'bt470bg',
    '-crf', '23',
    '-maxrate', '3800k',
    '-bufsize', '5700k',
    '-g', '250',
    '-profile:v', 'high',
    '-level:v', '4.0',
    '-x264-params', 'sei=0',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-b:a', '128k',
    '-brand', 'isom',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-threads', '2',
  ];
}

/**
 * Reproduce the legacy single-pass output options exactly as produced by
 * `server.js` `getOutputOptions` for the no-editor path: the constant `-vf`
 * scale/pad chain followed by the encode-only options. The legacy builder
 * ignores its `duration`/`inputHeight`/`attempt` arguments for the filter
 * string, so this takes none and returns the same constant token list.
 *
 * The skip path (`planRender(null, meta)`) returns these options verbatim,
 * guaranteeing a byte-for-byte identical ffmpeg command (Req 1.2/1.4/1.5).
 *
 * @returns {string[]} The full legacy `-vf` + encode option token list.
 * @see Requirements 1.2, 1.4, 1.5, 12.1
 */
function getOutputOptions() {
  return ['-vf', BASE_VIDEO_FILTER, ...encodeOnlyOptions()];
}

/**
 * Count the video encode operations represented by a RenderPlan. The encode
 * settings carry exactly one `-c:v` token, so a well-formed plan always yields
 * exactly one video encode — the single Compression_Pass (Property 20).
 *
 * @param {RenderPlan} plan - A plan produced by `planRender`.
 * @returns {number} The number of video encode operations (must be 1).
 * @see Requirements 2.6, 12.3
 */
function countVideoEncodes(plan) {
  if (!plan || !Array.isArray(plan.encodeOptions)) return 0;
  return plan.encodeOptions.filter((token) => token === '-c:v').length;
}

/**
 * Resolve the on-disk path for an overlay/music asset from an optional asset
 * map carried on `meta`, falling back to the recipe reference itself. The
 * execution layer (later task) populates `meta.assetPaths` with real local
 * paths once assets are downloaded; the pure planner stays usable with or
 * without them.
 *
 * @param {string} ref - The recipe asset reference.
 * @param {VideoMeta & { assetPaths?: Object<string,string> }} meta
 * @returns {string} The resolved path (or `ref` when unmapped).
 */
function resolveAssetPath(ref, meta) {
  const map = meta && meta.assetPaths;
  if (map && typeof map[ref] === 'string') return map[ref];
  return ref;
}

/**
 * Resolve the rasterized PNG path for a Text_Overlay. Text overlays are
 * rasterized to a transparent PNG by the execution layer and registered under
 * `meta.textRasterPaths` keyed by overlay id; absent a mapping the planner
 * emits a deterministic placeholder so the graph wiring stays stable.
 *
 * @param {TextOverlay} overlay
 * @param {VideoMeta & { textRasterPaths?: Object<string,string> }} meta
 * @returns {string}
 */
function resolveTextRasterPath(overlay, meta) {
  const map = meta && meta.textRasterPaths;
  if (map && typeof map[overlay.id] === 'string') return map[overlay.id];
  return `text_${overlay.id}.png`;
}

/**
 * Collect the ordered list of image overlays (stickers first, then rasterized
 * text overlays) together with their resolved input paths. The order fixes the
 * ffmpeg input indices: input 0 is always the source video, inputs 1..N are
 * these overlays in this order, and any music input follows them.
 *
 * Each returned overlay carries the recipe transform fields (`pos`, `scale`,
 * `rotation`) so `buildVideoFilterComplex` — shared with `planChunk` — can emit
 * an identical `scale → rotate → overlay` sub-chain for every chunk (Req 11.1).
 *
 * @param {EditRecipe} recipe
 * @param {VideoMeta} meta
 * @returns {{ overlay: (Sticker|TextOverlay), path: string }[]}
 */
function collectOverlays(recipe, meta) {
  const stickers = Array.isArray(recipe.stickers) ? recipe.stickers : [];
  const textOverlays = Array.isArray(recipe.textOverlays) ? recipe.textOverlays : [];

  const result = [];
  for (const sticker of stickers) {
    result.push({ overlay: sticker, path: resolveAssetPath(sticker.assetRef, meta) });
  }
  for (const text of textOverlays) {
    result.push({ overlay: text, path: resolveTextRasterPath(text, meta) });
  }
  return result;
}

/**
 * Format a finite number for embedding in an ffmpeg filter expression without
 * scientific notation or trailing noise.
 *
 * @param {number} n
 * @returns {string}
 */
function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n));
}

/**
 * Build the `-filter_complex` video graph for a recipe: the shared base
 * normalization (`BASE_VIDEO_FILTER`) labeled `[base]`, then for each overlay a
 * `scale → rotate → overlay` sub-chain composited onto the running result. The
 * final video is always labeled `[vout]`.
 *
 * Overlay placement uses ffmpeg `overlay` expressions in terms of the main and
 * overlay dimensions (`W`, `H`, `w`, `h`) so the recorded center relative
 * position maps to a top-left corner of `W*relX - w/2, H*relY - h/2` regardless
 * of the runtime overlay size (Req 5.8/6.7). Overlays are never time-gated, so
 * each is visible for the full duration of the output/chunk (Req 5.7/6.6/11.1).
 *
 * This function is shared by `planRender` and (later) `planChunk` so a split
 * video renders identical overlays in every chunk.
 *
 * @param {{ overlay: (Sticker|TextOverlay), path: string }[]} overlays
 * @returns {string} The filter_complex graph string.
 * @see Requirements 5.7, 5.8, 6.6, 6.7, 11.1
 */
function buildVideoFilterComplex(overlays) {
  if (!overlays || overlays.length === 0) {
    return `[0:v]${BASE_VIDEO_FILTER}[vout]`;
  }

  const parts = [`[0:v]${BASE_VIDEO_FILTER}[base]`];
  let currentLabel = 'base';

  overlays.forEach(({ overlay }, idx) => {
    const inputIdx = idx + 1; // input 0 is the source video
    const t = mapOverlayTransform(overlay);
    const rad = fmt(t.rotationRad);
    const scale = fmt(t.scale);
    const relX = fmt(overlay.pos.x);
    const relY = fmt(overlay.pos.y);

    const scaledLabel = `ov${idx}`;
    // scale the overlay by its recipe scale factor, then rotate by its angle,
    // expanding the output box (rotw/roth) and keeping transparency (c=none).
    parts.push(
      `[${inputIdx}:v]scale=iw*${scale}:ih*${scale},` +
        `rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=none[${scaledLabel}]`
    );

    const outLabel = idx === overlays.length - 1 ? 'vout' : `step${idx}`;
    parts.push(
      `[${currentLabel}][${scaledLabel}]overlay=x=(W*${relX})-(w/2):y=(H*${relY})-(h/2)[${outLabel}]`
    );
    currentLabel = outLabel;
  });

  return parts.join(';');
}

/**
 * Plan the single ffmpeg Compression_Pass for one video.
 *
 * When `recipe` is `null` (the video was skipped / not edited), this returns
 * the **legacy plan**: an empty `filterComplex` and the exact `getOutputOptions`
 * token list (including the `-vf` scale/pad chain). The resulting command is
 * byte-for-byte identical to today's no-editor flow (Property 1, Req 1.2/1.4/1.5).
 *
 * When `recipe` is present, the same scale/pad normalization is moved into a
 * `-filter_complex` graph, each sticker and rasterized text overlay is chained
 * through `scale → rotate → overlay`, the encode-only options are reused
 * UNCHANGED (so the encode settings — and the single `-c:v` — are identical),
 * and any trim is applied as `-ss start -to end` input args before the graph
 * (Req 4.4/4.5). Audio is resolved via `planAudio` and attached as `audioPlan`.
 *
 * Exactly one video encode is represented (`encodeCount === 1`,
 * `countVideoEncodes(plan) === 1`) satisfying Property 20 / Req 12.3.
 *
 * The graph construction is factored (`collectOverlays` + `buildVideoFilterComplex`)
 * so `planChunk` (task 4.1) can reuse it to render identical overlays per chunk.
 *
 * @param {EditRecipe|null} recipe - The validated recipe, or `null` when skipped.
 * @param {VideoMeta & {
 *   path?: string,
 *   assetPaths?: Object<string,string>,
 *   textRasterPaths?: Object<string,string>
 * }} meta - Source video metadata plus optional resolved asset paths.
 * @returns {RenderPlan & { plannedDuration: number, encodeCount: number }}
 * @see Requirements 1.2, 1.4, 1.5, 2.6, 4.4, 4.5, 5.7, 6.6, 12.3
 */
function planRender(recipe, meta) {
  const videoPath = (meta && (meta.path || meta.key)) || '';

  // ---- Skip path: byte-identical legacy command (Property 1) ----
  if (recipe == null) {
    const plan = {
      inputs: [{ type: 'video', path: videoPath, args: [] }],
      filterComplex: '',
      encodeOptions: getOutputOptions(),
      audioPlan: planAudio(null, false),
      overlays: [],
      plannedDuration: meta ? meta.duration : undefined,
    };
    plan.encodeCount = countVideoEncodes(plan);
    return plan;
  }

  // ---- Recipe path: one encode, expressed as a filter graph ----
  const trim =
    recipe.trim && Number.isFinite(recipe.trim.start) && Number.isFinite(recipe.trim.end)
      ? { start: recipe.trim.start, end: recipe.trim.end }
      : undefined;

  const plannedDuration = trim
    ? trim.end - trim.start
    : meta
      ? meta.duration
      : undefined;

  // Source video input, with trim applied as input seek/limit before the graph.
  const videoInput = {
    type: 'video',
    path: videoPath,
    args: trim ? ['-ss', fmt(trim.start), '-to', fmt(trim.end)] : [],
  };

  const overlays = collectOverlays(recipe, meta);
  const filterComplex = buildVideoFilterComplex(overlays);

  const inputs = [videoInput, ...overlays.map((o) => ({ type: 'image', path: o.path }))];

  // Audio plan + optional music input (after all overlay image inputs).
  const audioConfig = recipe.audio || {};
  const music = audioConfig.music;
  const hasMusic = Boolean(music && music.assetRef);
  const audioPlan = planAudio(audioConfig, hasMusic);

  if (hasMusic) {
    inputs.push({
      type: 'audio',
      path: resolveAssetPath(music.assetRef, meta),
      args: ['-ss', fmt(audioPlan.audioStart)],
    });
  }

  const plan = {
    inputs,
    filterComplex,
    encodeOptions: encodeOnlyOptions(),
    audioPlan,
    overlays,
    plannedDuration,
  };
  if (trim) plan.trim = trim;
  plan.encodeCount = countVideoEncodes(plan);

  return plan;
}

/**
 * Compute the number of chunks required to tile a timeline of length
 * `duration` into pieces each no longer than `clipLimit`. This is the chunk
 * count used by `planChunk` and by the execution layer to know how many
 * per-chunk encodes to schedule.
 *
 * count = ceil(duration / clipLimit)
 *
 * A tiny epsilon guards against floating-point overshoot producing a spurious
 * empty trailing chunk when `duration` is an exact multiple of `clipLimit`.
 *
 * @param {number} duration - Total (possibly trimmed) output duration, seconds.
 * @param {number} [clipLimit=CLIP_DURATION_LIMIT] - Max duration per chunk, seconds.
 * @returns {number} The number of chunks (0 when duration is not positive).
 * @see Requirements 4.6, 11.2
 */
function chunkCount(duration, clipLimit = CLIP_DURATION_LIMIT) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const limit = Number.isFinite(clipLimit) && clipLimit > 0 ? clipLimit : CLIP_DURATION_LIMIT;
  // Subtract a small epsilon so an exact multiple (e.g. 58 / 29) yields the
  // intended count rather than one extra empty chunk from float rounding.
  return Math.max(1, Math.ceil(duration / limit - 1e-9));
}

/**
 * Plan one chunk of a (possibly trimmed) video whose planned output duration
 * `D` exceeds the `Clip_Duration_Limit` and is therefore split for delivery.
 *
 * The timeline `[0, D]` is tiled into `chunkCount(D, clipLimit)` contiguous
 * pieces. For zero-based chunk `i`:
 *   - chunkStart (output timeline) = i * clipLimit
 *   - chunkEnd   (output timeline) = min((i + 1) * clipLimit, D)
 *   - chunkDuration                = chunkEnd - chunkStart   (<= clipLimit)
 * Boundaries are contiguous (chunk i end === chunk i+1 start) with no gap,
 * overlap, or repeated frame, and the union of all chunks is exactly `[0, D]`
 * (Property 10 / Req 4.6, 11.2).
 *
 * The chunk's source seek accounts for any trim start carried by the base plan
 * plus the chunk's slice of the timeline:
 *   sourceSeek = baseTrimStart + i * clipLimit
 * and the video input is bounded to `chunkDuration` via `-ss <sourceSeek> -t
 * <chunkDuration>` so consecutive chunks read consecutive source ranges.
 *
 * Every chunk renders ALL overlays full-duration at the recipe transforms by
 * reusing `buildVideoFilterComplex` over the same collected overlays the base
 * plan carries, so the overlay sub-graph string is byte-identical in every
 * chunk and no overlay is time-gated (Property 11 / Req 5.7, 6.6, 11.1).
 *
 * Exactly one video encode is represented per chunk: the encode-only options
 * (`encodeOnlyOptions`) carry a single `-c:v`, preserving the one-encode-per-
 * clip invariant.
 *
 * Note: per-chunk music offset advancement (Req 11.3/11.4) is handled by the
 * audio layer (`chunkAudioOffset`, task 5.7); this function carries the base
 * plan's overlay/music inputs through unchanged aside from the video seek.
 *
 * @param {RenderPlan & { plannedDuration: number, overlays?: object[], trim?: Trim }} plan
 *   A plan produced by `planRender`, including its `plannedDuration` (D).
 * @param {number} chunkIndex - Zero-based index of the chunk to plan.
 * @param {number} [clipLimit=CLIP_DURATION_LIMIT] - Max duration per chunk, seconds.
 * @returns {ChunkRenderPlan} The render plan for the requested chunk.
 * @see Requirements 4.6, 5.7, 6.6, 11.1, 11.2
 */
function planChunk(plan, chunkIndex, clipLimit = CLIP_DURATION_LIMIT) {
  if (!plan || typeof plan !== 'object') {
    throw new TypeError('planChunk requires a RenderPlan produced by planRender');
  }

  const D = plan.plannedDuration;
  if (!Number.isFinite(D) || D <= 0) {
    throw new RangeError('planChunk requires plan.plannedDuration to be a positive number');
  }

  const limit = Number.isFinite(clipLimit) && clipLimit > 0 ? clipLimit : CLIP_DURATION_LIMIT;
  const count = chunkCount(D, limit);

  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= count) {
    throw new RangeError(
      `chunkIndex ${chunkIndex} is out of range for ${count} chunk(s)`
    );
  }

  // Output-timeline boundaries: contiguous, non-overlapping, covering [0, D].
  const chunkStart = chunkIndex * limit;
  const chunkEnd = Math.min((chunkIndex + 1) * limit, D);
  const chunkDuration = chunkEnd - chunkStart;

  // Source seek: base trim start (0 when untrimmed) plus this chunk's slice.
  const baseTrimStart =
    plan.trim && Number.isFinite(plan.trim.start) ? plan.trim.start : 0;
  const sourceSeek = baseTrimStart + chunkStart;

  // Rebuild the video input with the chunk seek; carry overlay/music inputs.
  const baseInputs = Array.isArray(plan.inputs) ? plan.inputs : [];
  const baseVideoInput = baseInputs[0] || { type: 'video', path: '' };
  const chunkVideoInput = {
    type: 'video',
    path: baseVideoInput.path || '',
    args: ['-ss', fmt(sourceSeek), '-t', fmt(chunkDuration)],
  };
  const otherInputs = baseInputs.slice(1).map((input) => ({ ...input }));
  const inputs = [chunkVideoInput, ...otherInputs];

  // Reuse the shared graph builder over the base plan's overlays so the overlay
  // sub-graph is identical in every chunk (Property 11). When the base plan
  // predates overlay tracking, fall back to its filterComplex string.
  const overlays = Array.isArray(plan.overlays) ? plan.overlays : null;
  const filterComplex =
    overlays !== null
      ? buildVideoFilterComplex(overlays)
      : plan.filterComplex || buildVideoFilterComplex([]);

  const chunkPlan = {
    chunkIndex,
    chunkCount: count,
    chunkStart,
    chunkEnd,
    chunkDuration,
    sourceSeek,
    inputs,
    filterComplex,
    encodeOptions: encodeOnlyOptions(),
    audioPlan: plan.audioPlan,
    overlays: overlays || [],
    plannedDuration: D,
  };
  if (plan.trim) chunkPlan.trim = plan.trim;
  chunkPlan.encodeCount = countVideoEncodes(chunkPlan);

  return chunkPlan;
}

module.exports = {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  BASE_VIDEO_FILTER,
  mapRelToPixels,
  degToRad,
  overlayTopLeft,
  mapOverlayTransform,
  getOutputOptions,
  encodeOnlyOptions,
  countVideoEncodes,
  buildVideoFilterComplex,
  collectOverlays,
  planRender,
  chunkCount,
  planChunk,
};
