/**
 * Reference uploads: turning user-supplied pictures and videos into LTX-Video
 * conditioning items.
 *
 * LTX-Video can be conditioned on images *and* videos - that is what powers
 * image-to-video, multi-keyframe animation, and video extension. The model reads
 * those files straight off disk, so an upload is really two steps:
 *
 *   1. Accept the bytes, into a run-scoped folder under the work directory, so a
 *      render is self-contained and a server restart cannot lose the reference.
 *   2. Validate and canonicalise the file into `{path, kind, strength, startFrame}`,
 *      which is what the renderer and the MCP server both consume.
 *
 * Nothing here talks to a network. Uploads stay on the local machine, which is
 * the whole point of VideoForge.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from '../util/fs.js';
import { isReferenceFile, normalizeReferences, referenceKind } from './ltx.js';

/** Uploads are media, not arbitrary binaries: refuse anything else outright. */
export function assertReferenceFile(filename) {
  if (!isReferenceFile(filename)) {
    throw new Error(
      `"${filename}" is not a supported reference file. ` +
        'Upload an image (png, jpg, jpeg, webp, bmp, tiff) or a video ' +
        '(mp4, mov, avi, mkv, webm, m4v).',
    );
  }
  return referenceKind(filename);
}

/**
 * Where a run's uploads live. Scoped by `stamp` so two renders never collide and
 * a finished run keeps its own references on disk next to its manifest.
 */
export function referenceDirFor(config, stamp) {
  const dir = path.join(config.referencesDir, stamp);
  ensureDir(dir);
  return dir;
}

/**
 * Save uploaded bytes under a run's reference directory.
 *
 * The stored name is `<index>-<safeName>`, where `safeName` is the basename of
 * whatever the caller sent, sanitised. The index keeps ordering stable and makes
 * the sort deterministic, which matters because LTX-Video's conditioning order
 * is the order of the list.
 *
 * @param {object} req { config, stamp, index, filename, data }
 * @returns {Promise<{path: string, filename: string, bytes: number}>}
 */
export async function saveReferenceUpload({ config, stamp, index, filename, data }) {
  const kind = assertReferenceFile(filename);
  const dir = referenceDirFor(config, stamp);

  const base = path
    .basename(String(filename))
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  const name = `${String(index).padStart(2, '0')}-${base || `reference.${kind === 'video' ? 'mp4' : 'png'}`}`;
  const target = path.join(dir, name);

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length === 0) {
    throw new Error(`Reference upload "${filename}" was empty.`);
  }
  await fsp.writeFile(target, buffer);

  return { path: target, filename: name, bytes: buffer.length, kind };
}

/**
 * Validate a set of references already on disk (from the CLI, or a storyboard).
 *
 * Paths may be absolute or relative to the repo root. A relative path is resolved
 * against `config.root`, which is what makes `--reference ./my-photo.jpg` work
 * from any working directory.
 *
 * Existence is checked here rather than in `normalizeReference` because that
 * function is deliberately pure (it is the shared shape/range rulebook, also used
 * for descriptors that do not exist yet). This is the layer that knows about the
 * filesystem, so this is where "no such file" belongs - failing now rather than
 * after a multi-gigabyte model has loaded.
 *
 * @param {Array<object>|object|string} raw
 * @param {object} [opts] { numFrames, config, requireExists }
 * @returns {{references: object[], warnings: string[]}}
 */
export function resolveReferences(raw, { numFrames = 121, config = null, requireExists = true } = {}) {
  const list = Array.isArray(raw)
    ? raw
    : raw === undefined || raw === null || raw === ''
      ? []
      : [raw];

  const expanded = list.map((entry) => {
    // A bare string is the common CLI shape: `--reference photo.jpg`.
    if (typeof entry === 'string') return { path: entry };
    if (entry && typeof entry === 'object') {
      const path = entry.path ?? entry.file ?? entry.filename;
      return path ? { ...entry, path } : entry;
    }
    return entry;
  });

  const resolved = expanded
    .filter(Boolean)
    .map((entry) => {
      if (typeof entry.path !== 'string' || !entry.path) return entry;
      const candidate = path.isAbsolute(entry.path)
        ? entry.path
        : path.resolve(config?.root ?? process.cwd(), entry.path);

      if (requireExists && !fs.existsSync(candidate)) {
        throw new Error(
          `Reference file not found: ${entry.path}` +
            (candidate === entry.path ? '' : ` (resolved to ${candidate})`),
        );
      }
      return { ...entry, path: candidate };
    });

  return normalizeReferences(resolved, { numFrames });
}

/** Remove a run's uploaded references. Best-effort, used when a run is deleted. */
export function clearReferences(config, stamp) {
  const dir = path.join(config.referencesDir, stamp);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** A short, stable id for a run's reference set (used in manifests). */
export function referenceSetId(references) {
  const list = Array.isArray(references) ? references : [];
  const digest = crypto
    .createHash('sha1')
    .update(list.map((r) => `${r.path}:${r.strength}:${r.startFrame}`).join('|'))
    .digest('hex');
  return digest.slice(0, 12);
}

export default {
  assertReferenceFile,
  referenceDirFor,
  saveReferenceUpload,
  resolveReferences,
  clearReferences,
  referenceSetId,
};
