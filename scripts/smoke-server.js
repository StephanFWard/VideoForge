// Live smoke test of the web API: reference upload, listing, and generation
// rejection. Run with the server already listening, e.g.
//   VIDEO_FORGE_BACKEND=mock node src/cli.js serve --port 4399
//   node scripts/smoke-server.js 4399
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const port = Number(process.argv[2] ?? 4399);
const base = `http://127.0.0.1:${port}`;
const stamp = `smoke${Date.now().toString(36)}`;
let failures = 0;

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` -> ${detail}` : ''}`);
  if (!ok) failures += 1;
}

console.log(`\nVideoForge web API smoke test (${base})\n`);

// --- health ---------------------------------------------------------------
const health = await (await fetch(`${base}/api/health`)).json();
check('health responds', typeof health.version === 'string', `v${health.version}`);
check('health reports both visual backends', health.backends !== undefined,
  `comfy=${health.backends?.comfy} ltx=${health.backends?.ltx}`);
check('health exposes the reference limit', Number(health.maxReferences) > 0, health.maxReferences);
check('health reports ffmpeg', health.ffmpeg === true);

// --- reference upload -----------------------------------------------------
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const tmp = path.join(os.tmpdir(), 'videoforge-smoke-reference.png');
fs.writeFileSync(tmp, png);

const upload = await fetch(`${base}/api/references?stamp=${stamp}`, {
  method: 'POST',
  headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('my reference.png') },
  body: png,
});
const uploaded = await upload.json();
check('accepts an image upload', uploaded.ok === true, uploaded.filename ?? uploaded.error);
check('upload is stored locally', uploaded.path && fs.existsSync(uploaded.path), uploaded.path);
check('upload is classified', uploaded.kind === 'image', uploaded.kind);

const listed = await (await fetch(`${base}/api/references?stamp=${stamp}`)).json();
check('lists the uploaded reference', listed.references?.length === 1, listed.references?.length);

// --- rejection paths ------------------------------------------------------
const badType = await fetch(`${base}/api/references?stamp=${stamp}`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'X-Filename': 'notes.txt' },
  body: Buffer.from('not media'),
});
const badTypeBody = await badType.json();
check('rejects a non-media file', badType.status === 400 && badTypeBody.ok === false,
  badTypeBody.error?.slice(0, 60));

const empty = await fetch(`${base}/api/references?stamp=${stamp}`, {
  method: 'POST',
  headers: { 'Content-Type': 'image/png', 'X-Filename': 'empty.png' },
  body: Buffer.alloc(0),
});
check('rejects an empty upload', empty.status === 400);

// Checked before any successful generate, because a live render makes the
// endpoint answer 409 "already in progress" instead of the real validation error.
const noTopic = await fetch(`${base}/api/generate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
check('still requires a topic', noTopic.status === 400, (await noTopic.text()).slice(0, 60));

const badGenerate = await fetch(`${base}/api/generate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ topic: 'x', references: [{ path: 'does-not-exist.png' }] }),
});
const badGenerateBody = await badGenerate.json();
check('rejects a missing reference before rendering', badGenerate.status === 400,
  badGenerateBody.error?.slice(0, 60));

// --- cleanup --------------------------------------------------------------
const cleared = await (await fetch(`${base}/api/references?stamp=${stamp}`, { method: 'DELETE' })).json();
check('deletes uploaded references', cleared.ok === true && cleared.cleared === true);
fs.rmSync(tmp, { force: true });

console.log(`\n${failures} failure(s)\n`);
process.exit(failures ? 1 : 0);
