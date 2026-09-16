/** Filesystem helpers. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function ensureDirAsync(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

export function existsSync(file) {
  return fs.existsSync(file);
}

export async function sizeOf(file) {
  const stat = await fsp.stat(file);
  return stat.size;
}

/** Filesystem-safe slug, e.g. "Realistic 4K — Fitness!" -> "realistic-4k-fitness". */
export function slugify(text, max = 60) {
  const slug = String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'video';
}

export async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

export async function writeJson(file, data) {
  await ensureDirAsync(path.dirname(file));
  await fsp.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}

export async function writeText(file, text) {
  await ensureDirAsync(path.dirname(file));
  await fsp.writeFile(file, text, 'utf8');
  return file;
}

/** Timestamped run folder so repeated renders never clobber each other. */
export function runStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export default { ensureDir, ensureDirAsync, exists, existsSync, sizeOf, slugify, readJson, writeJson, writeText, runStamp };
