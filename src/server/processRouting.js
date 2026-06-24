'use strict';

/**
 * Per-video recipe routing for the StatusDrop /api/process pipeline.
 *
 * This is a PURE, side-effect-free module that maps an optional `recipes` map
 * (keyed by upload `key`) onto the retained set of uploaded videos. It is the
 * testable core behind Property 2 ("Recipes route only to their own video"):
 * the recipe for key K applies ONLY to the file with that key, and a video
 * without a matching key (or without a key at all) is planned as skipped
 * (recipe === null, the legacy/byte-identical path).
 *
 * Keeping this logic out of the HTTP handler lets task 10.4 verify routing
 * without spinning up Express or ffmpeg.
 *
 * CommonJS module to match the existing codebase (server.js).
 *
 * @see Requirements 1.1, 1.3, 1.4
 */

/**
 * @typedef {Object} RoutedFile
 * @property {string|undefined} key - The upload key of the file (as supplied).
 * @property {Object|null} recipe - The Edit_Recipe keyed by this file's `key`,
 *   or `null` when the file has no key or no matching entry in `recipesMap`
 *   (the skipped / legacy path).
 */

/**
 * True for a plain (non-array, non-null) object usable as a recipes map.
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Route each retained upload to its own recipe by upload key.
 *
 * For every file in `files` (in upload order), the result contains an entry
 * `{ key, recipe }` where `recipe` is `recipesMap[file.key]` when that file has
 * a non-empty `key` AND `recipesMap` carries an own, non-null entry for it;
 * otherwise `recipe` is `null` (skipped / legacy path). A recipe is therefore
 * never associated with any file other than the one whose key it is stored
 * under (Property 2 / Req 1.3, 1.4).
 *
 * The function never mutates `files` or `recipesMap` and returns a fresh array
 * aligned 1:1 (by index) with `files`.
 *
 * @param {Array<{ key?: string }>} files - Retained uploads, in upload order.
 * @param {Object<string, Object>|null|undefined} recipesMap - Optional map of
 *   Edit_Recipes keyed by upload key. Missing/non-object => every file skipped.
 * @returns {RoutedFile[]} One routing decision per file, index-aligned.
 */
function routeRecipes(files, recipesMap) {
  if (!Array.isArray(files)) {
    return [];
  }

  const map = isPlainObject(recipesMap) ? recipesMap : null;

  return files.map((file) => {
    const key = file ? file.key : undefined;
    let recipe = null;

    if (
      map &&
      typeof key === 'string' &&
      key !== '' &&
      Object.prototype.hasOwnProperty.call(map, key)
    ) {
      const candidate = map[key];
      // Only a real recipe object routes; null/undefined entries are skips.
      recipe = candidate === undefined || candidate === null ? null : candidate;
    }

    return { key, recipe };
  });
}

/**
 * Collect the set of asset references a recipe may legally reference, used to
 * build the `availableAssets` set passed to `validateRecipe`.
 *
 * Asset validation (uploading + ffprobe of music, sticker asset registration)
 * is owned by the music/asset endpoints and the cleanup wiring in later tasks.
 * Until those are wired into /api/process, the caller can supply the set of
 * client-validated asset ids via `validatedAssets` (array or Set). When that is
 * not provided, this falls back to the asset references the recipe itself
 * carries, so a well-formed recipe whose assets were validated out-of-band is
 * not spuriously rejected for a missing-asset reason.
 *
 * @param {Object|null} recipe - The Edit_Recipe (or null).
 * @param {Array<string>|Set<string>} [validatedAssets] - Known-validated ids.
 * @returns {Set<string>} The set of asset ids treated as available/validated.
 */
function collectAvailableAssets(recipe, validatedAssets) {
  const available = new Set();

  if (validatedAssets instanceof Set) {
    for (const id of validatedAssets) {
      if (typeof id === 'string' && id !== '') available.add(id);
    }
  } else if (Array.isArray(validatedAssets)) {
    for (const id of validatedAssets) {
      if (typeof id === 'string' && id !== '') available.add(id);
    }
  } else if (recipe && typeof recipe === 'object') {
    // Fallback: trust the references the recipe carries (validated out-of-band).
    const stickers = Array.isArray(recipe.stickers) ? recipe.stickers : [];
    for (const sticker of stickers) {
      if (sticker && typeof sticker.assetRef === 'string' && sticker.assetRef !== '') {
        available.add(sticker.assetRef);
      }
    }
    const music = recipe.audio && recipe.audio.music;
    if (music && typeof music.assetRef === 'string' && music.assetRef !== '') {
      available.add(music.assetRef);
    }
  }

  return available;
}

module.exports = { routeRecipes, collectAvailableAssets };
