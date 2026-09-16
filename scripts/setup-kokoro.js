#!/usr/bin/env node
/**
 * One-time setup for the bundled Kokoro TTS MCP server.
 *
 * Creates a Python 3.11 virtualenv in .venv (via uv when available, falling
 * back to a plain python venv) and installs the pinned Kokoro dependencies
 * from mcp-servers/kokoro-tts/requirements.txt. Run by `npm run setup:kokoro`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENV = path.join(ROOT, '.venv');
const REQUIREMENTS = path.join(ROOT, 'mcp-servers', 'kokoro-tts', 'requirements.txt');

const win = process.platform === 'win32';
const venvPython = path.join(VENV, win ? 'Scripts\\python.exe' : 'bin/python');

/** Run a command, inheriting stdio so progress is visible; returns success. */
function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`\n${cmd} ${args.join(' ')} failed (exit ${result.status ?? 'spawn error'}).`);
    process.exit(1);
  }
  return true;
}

/** True when the command resolves on PATH. */
function has(cmd) {
  const result = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

function main() {
  if (fs.existsSync(venvPython)) {
    console.log(`Reusing existing virtualenv: ${VENV}`);
  } else if (has('uv')) {
    console.log('Creating virtualenv with uv (python 3.11)…');
    run('uv', ['venv', VENV, '--python', '3.11']);
  } else {
    console.log('uv not found — falling back to "python -m venv".');
    console.log('(Install https://docs.astral.sh/uv/ for faster, pinned-python setups.)');
    const py = win ? 'python' : 'python3';
    if (!has(py)) {
      console.error(`Neither uv nor ${py} is available. Install one of them first.`);
      process.exit(1);
    }
    run(py, ['-m', 'venv', VENV]);
  }

  if (!fs.existsSync(REQUIREMENTS)) {
    console.error(`Missing ${REQUIREMENTS} — cannot install Kokoro dependencies.`);
    process.exit(1);
  }

  console.log('Installing Kokoro dependencies (this downloads PyTorch; be patient)…');
  if (has('uv')) {
    run('uv', ['pip', 'install', '--python', venvPython, '-r', REQUIREMENTS]);
  } else {
    run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
    run(venvPython, ['-m', 'pip', 'install', '-r', REQUIREMENTS]);
  }

  console.log('\nKokoro MCP server ready:');
  console.log(`  python : ${venvPython}`);
  console.log(`  server : mcp-servers/kokoro-tts/server.py`);
  console.log('\nNext: npm run doctor   (verifies ffmpeg + both MCP servers)');
}

main();
