/**
 * Live MCP integration test for the Kokoro TTS MCP server.
 *
 * This is a real end-to-end check: it spawns the bundled Python MCP server,
 * performs the MCP handshake, discovers tools over the protocol, and renders
 * actual speech. It is deliberately not mocked - the point is to prove the
 * MCP layer works on this machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { KokoroNarration } from '../src/mcp/kokoro.js';
import { probe } from '../src/util/ffmpeg.js';

const config = loadConfig({ backend: 'mock' });
const pythonExists = fs.existsSync(config.kokoroMcp.command);
const skip = pythonExists ? false : `Kokoro venv missing (${config.kokoroMcp.command}). Run: npm run setup:kokoro`;

// Model download + CPU load on first run can take a minute.
const TIMEOUT = 300_000;

test('kokoro MCP: connects over stdio and exposes TTS tools', { skip, timeout: TIMEOUT }, async () => {
  const kokoro = new KokoroNarration(config);
  try {
    await kokoro.connect();
    const names = await kokoro.connection.listToolNames();

    assert.ok(names.length > 0, 'server should expose at least one tool');
    assert.ok(
      names.includes('text_to_speech'),
      `expected text_to_speech among ${names.join(', ')}`,
    );
    assert.ok(names.includes('kokoro_health'), 'expected kokoro_health tool');

    const { tool, args } = await kokoro.resolveTool();
    assert.equal(tool.name, 'text_to_speech');
    assert.equal(args.text, 'text', 'text argument should be discovered from the schema');
    assert.equal(args.outputPath, 'output_path');
  } finally {
    await kokoro.close();
  }
});

test('kokoro MCP: kokoro_health reports a usable runtime', { skip, timeout: TIMEOUT }, async () => {
  const kokoro = new KokoroNarration(config);
  try {
    const health = await kokoro.health();
    assert.equal(health.ok, true);
    assert.equal(health.sample_rate, 24000);
    assert.ok(health.voices > 0, 'health should report available voices');
  } finally {
    await kokoro.close();
  }
});

test('kokoro MCP: synthesizes real narration audio', { skip, timeout: TIMEOUT }, async () => {
  const outDir = path.join(config.workDir, 'test-audio');
  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, 'narration.wav');

  const kokoro = new KokoroNarration(config);
  try {
    const line = 'VideoForge turns a topic into a finished video.';
    const speech = await kokoro.speak({
      text: line,
      outputPath,
      voice: config.kokoro.voice,
      speed: config.kokoro.speed,
      lang: config.kokoro.lang,
    });

    assert.ok(fs.existsSync(speech.path), `audio file should exist at ${speech.path}`);
    const size = fs.statSync(speech.path).size;
    assert.ok(size > 5000, `audio should have real content, got ${size} bytes`);

    // The reported duration must survive an independent ffprobe check.
    const info = await probe(speech.path, config.ffprobe);
    assert.ok(info, 'ffprobe should read the file');
    assert.ok(info.duration > 0.5, `duration should be positive, got ${info.duration}`);
    if (speech.durationSeconds) {
      const delta = Math.abs(speech.durationSeconds - info.duration);
      assert.ok(delta < 0.5, `reported duration ${speech.durationSeconds} vs probe ${info.duration}`);
    }
  } finally {
    await kokoro.close();
  }
});