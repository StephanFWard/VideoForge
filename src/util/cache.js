/**
 * Keyframe cache.
 *
 * Diffusion renders are the expensive, deterministic part of a VideoForge run:
 * the same prompt, size, sampler settings and seed always produce the same
 * picture. Remotion caches rendered work for exactly this reason, so a retry
 * or a re-render after a downstream failure does not pay for it twice.
 *
 * Entries are content-addressed: the key is the sha1 of every input that can
 * change the picture, and the file lives under a two-character prefix
 * directory so thousands of entries stay in manageable folders.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fs.js';

/** Stable hash of everything that can change a cached artefact. */
export function cacheKey(parts) {
  return crypto.createHash('sha1').update(JSON.stringify(parts ?? [])).digest('hex');
}

function cacheDirFor(cacheDir, key) {
  return path.join(cacheDir, key.slice(0, 2));
}

/** Path an entry would be written to, given its extension. */
export function cachePath({ cacheDir, key, ext = '.png' }) {
  return path.join(cacheDirFor(cacheDir, key), `${key}${ext}`);
}

/**
 * Find a cached entry without knowing the extension it was stored with.
 * Returns a local path, or null when the key has never been written.
 */
export function readCacheEntry({ cacheDir, key }) {
  const dir = cacheDirFor(cacheDir, key);
  if (!fs.existsSync(dir)) return null;
  const match = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${key}.`))
    .sort()[0];
  return match ? path.join(dir, match) : null;
}

/**
 * Store a rendered artefact under its key. The source file is copied (not
 * moved) because the caller still owns the original path.
 *
 * @returns {string} the cached path
 */
export function writeCacheEntry({ source, cacheDir, key, ext = null }) {
  const extension = ext ?? path.extname(source) ?? '.png';
  const target = cachePath({ cacheDir, key, ext: extension || '.png' });
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
  return target;
}

export default { cacheKey, cachePath, readCacheEntry, writeCacheEntry };
