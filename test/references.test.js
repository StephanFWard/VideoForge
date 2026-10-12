/**
 * Reference upload and validation tests.
 *
 * Locks in the contract for how user-supplied pictures and videos become
 * LTX-Video conditioning items: extension filtering, path resolution against
 * the repo root, run-scoped storage of uploads, and the stable reference-set
 * id used in run manifests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomFillSync } from 'node:crypto';

import { referenceKind, isReferenceFile } from '../src/pipeline/ltx.js';
import {
  assertReferenceFile,
  referenceDirFor,
  saveReferenceUpload,
  resolveReferences,
  clearReferences,
  referenceSetId,
} from '../src/pipeline/references.js';

/** A throwaway config whose reference store sits inside the OS temp folder. */
function tmpConfig() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'video-forge-test-'));
  return { root, referencesDir: path.join(root, 'references') };
}

/** Random hex so parallel runs never share a run stamp. */
function hex(bytes) {
  const buf = new Uint8Array(bytes);
  randomFillSync(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

test('referenceKind classifies supported image extensions', () => {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']) {
    assert.equal(referenceKind(`photo${ext}`), 'image');
    assert.equal(referenceKind(`photo${ext.toUpperCase()}`), 'image');
  }
});

test('referenceKind classifies supported video extensions', () => {
  for (const ext of ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v']) {
    assert.equal(referenceKind(`clip${ext}`), 'video');
    assert.equal(referenceKind(`clip${ext.toUpperCase()}`), 'video');
  }
});

test('referenceKind rejects unknown extensions', () => {
  assert.equal(referenceKind('notes.txt'), null);
  assert.equal(referenceKind('README'), null);
  assert.equal(referenceKind('archive.zip'), null);
  assert.equal(referenceKind(null), null);
});

test('isReferenceFile is a boolean gate on the extension', () => {
  assert.equal(isReferenceFile('a.png'), true);
  assert.equal(isReferenceFile('b.mp4'), true);
  assert.equal(isReferenceFile('notes.txt'), false);
});

test('assertReferenceFile throws for unsupported media', () => {
  assert.throws(() => assertReferenceFile('notes.txt'), /is not a supported reference/);
  assert.throws(() => assertReferenceFile(''), /is not a supported reference/);
});

test('assertReferenceFile accepts supported media and reports its kind', () => {
  assert.equal(assertReferenceFile('photo.png'), 'image');
  assert.equal(assertReferenceFile('clip.mp4'), 'video');
});

test('referenceDirFor creates the run folder under the references directory', () => {
  const config = tmpConfig();
  const stamp = `run-${hex(8)}`;

  const dir = referenceDirFor(config, stamp);
  assert.equal(dir, path.join(config.referencesDir, stamp));
  assert.ok(fs.existsSync(dir));
});

test('saveReferenceUpload writes bytes into a run-scoped folder', async () => {
  const config = tmpConfig();
  const stamp = `run-${hex(8)}`;
  const data = Buffer.from('reference bytes');

  const saved = await saveReferenceUpload({
    config,
    stamp,
    index: 1,
    filename: 'my-reference.png',
    data,
  });

  // Exactly <referencesDir>/<stamp>/01-my-reference.png — never shared between runs.
  assert.equal(saved.path, path.join(config.referencesDir, stamp, '01-my-reference.png'));
  assert.equal(saved.filename, '01-my-reference.png');
  assert.equal(saved.bytes, data.length);
  assert.equal(saved.kind, 'image');
  assert.ok(fs.existsSync(saved.path));
  assert.equal(fs.readFileSync(saved.path, 'utf8'), 'reference bytes');
});

test('saveReferenceUpload sanitises the original name and keeps the index prefix', async () => {
  const config = tmpConfig();
  const stamp = `run-${hex(8)}`;

  const saved = await saveReferenceUpload({
    config,
    stamp,
    index: 2,
    filename: 'my reference clip.mp4',
    data: Buffer.from('v'),
  });

  assert.equal(saved.filename, '02-my_reference_clip.mp4');
  assert.equal(saved.kind, 'video');
});

test('saveReferenceUpload rejects empty uploads', async () => {
  const config = tmpConfig();
  await assert.rejects(
    saveReferenceUpload({
      config,
      stamp: `run-${hex(4)}`,
      index: 1,
      filename: 'a.png',
      data: Buffer.from(''),
    }),
    /was empty/,
  );
});

test('saveReferenceUpload rejects unsupported media', async () => {
  const config = tmpConfig();
  await assert.rejects(
    saveReferenceUpload({
      config,
      stamp: `run-${hex(4)}`,
      index: 1,
      filename: 'notes.txt',
      data: Buffer.from('x'),
    }),
    /not a supported reference/,
  );
});

test('resolveReferences resolves relative paths against config.root', () => {
  const config = tmpConfig();
  const absolute = path.join(config.root, 'frame.png');
  fs.writeFileSync(absolute, 'mock');

  const { references } = resolveReferences([{ path: 'frame.png' }], { config, numFrames: 17 });
  assert.equal(references.length, 1);
  assert.equal(references[0].path, absolute);
});

test('resolveReferences accepts an absolute path', () => {
  const config = tmpConfig();
  const absolute = path.join(config.root, 'abs.png');
  fs.writeFileSync(absolute, 'mock');

  const { references } = resolveReferences([{ path: absolute }], { config, numFrames: 9 });
  assert.equal(references[0].path, absolute);
});

test('resolveReferences throws when a file does not exist', () => {
  const config = tmpConfig();
  assert.throws(
    () => resolveReferences(['does-not-exist.png'], { config, numFrames: 17 }),
    /Reference file not found: does-not-exist\.png/,
  );
});

test('resolveReferences normalises null and undefined to an empty list', () => {
  const config = tmpConfig();
  assert.deepEqual(resolveReferences(null, { config }).references, []);
  assert.deepEqual(resolveReferences(undefined, { config }).references, []);
});

test('clearReferences removes the reference directory', () => {
  const config = tmpConfig();
  const stamp = `run-${hex(8)}`;
  const dir = path.join(config.referencesDir, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.png'), 'data');

  assert.equal(clearReferences(config, stamp), true);
  assert.ok(!fs.existsSync(dir));
});

test('referenceSetId is stable for the same conditioning items', () => {
  const items = [
    { path: 'a.png', strength: 1, startFrame: 0 },
    { path: 'b.mp4', strength: 0.5, startFrame: 60 },
  ];

  const first = referenceSetId(items);
  assert.equal(first, referenceSetId([...items]));
  assert.equal(first.length, 12);
});

test('referenceSetId changes when any conditioning field changes', () => {
  const base = [{ path: 'a.png', strength: 1, startFrame: 0 }];
  const id = referenceSetId(base);

  assert.notEqual(id, referenceSetId([{ path: 'a.png', strength: 0.5, startFrame: 0 }]));
  assert.notEqual(id, referenceSetId([{ path: 'a.png', strength: 1, startFrame: 4 }]));
  assert.notEqual(id, referenceSetId([{ path: 'c.png', strength: 1, startFrame: 0 }]));
});
