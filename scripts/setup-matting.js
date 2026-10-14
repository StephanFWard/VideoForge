#!/usr/bin/env node
/** Install the lightweight CPU foreground-matting runtime used by video edits. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENV = path.join(ROOT, '.venv-matting');
const REQUIREMENTS = path.join(ROOT, 'mcp-servers', 'video-edit', 'requirements.txt');
const win = process.platform === 'win32';
const venvPython = path.join(VENV, win ? 'Scripts\\python.exe' : 'bin/python');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`\n${command} ${args.join(' ')} failed (exit ${result.status ?? 'spawn error'}).`);
    process.exit(1);
  }
}

function has(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

if (!fs.existsSync(venvPython)) {
  if (has('uv')) run('uv', ['venv', VENV, '--python', '3.11']);
  else {
    const python = win ? 'python' : 'python3';
    if (!has(python)) {
      console.error('Install Python 3.11 or uv before setting up foreground matting.');
      process.exit(1);
    }
    run(python, ['-m', 'venv', VENV]);
  }
}

if (has('uv')) {
  run('uv', ['pip', 'install', '--python', venvPython, '--link-mode', 'copy', '-r', REQUIREMENTS]);
} else {
  run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  run(venvPython, ['-m', 'pip', 'install', '-r', REQUIREMENTS]);
}

console.log(`\nForeground matting ready:\n  python: ${venvPython}`);
