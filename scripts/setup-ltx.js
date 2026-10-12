#!/usr/bin/env node
/**
 * One-time setup for the bundled LTX-Video MCP server.
 *
 * Creates a Python 3.11 virtualenv in .venv-ltx (via uv when available, falling
 * back to a plain python venv), runs the offline selfcheck once the light
 * prerequisites are in place, then installs the full pinned dependency set from
 * mcp-servers/ltx-video/requirements.txt. Run by `npm run setup:ltx`.
 *
 * The venv is deliberately separate from Kokoro's `.venv`: LTX-Video pins
 * `transformers < 4.52` and needs a full torch + diffusers + PyAV stack, a very
 * different dependency closure to Kokoro-82M, so neither setup can break the
 * other.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENV = path.join(ROOT, '.venv-ltx');
const REQUIREMENTS = path.join(ROOT, 'mcp-servers', 'ltx-video', 'requirements.txt');
const SELFCHECK = path.join(ROOT, 'mcp-servers', 'ltx-video', 'selfcheck.py');

const win = process.platform === 'win32';
const venvPython = path.join(VENV, win ? 'Scripts\\python.exe' : 'bin/python');

/** Run a command, inheriting stdio so progress is visible; exits on failure. */
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

/**
 * CUDA wheels only pay off on NVIDIA hardware. Everywhere else the CPU index
 * saves several GB of unusable CUDA runtime downloads (see requirements.txt).
 */
function hasNvidiaGpu() {
  const result = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
    encoding: 'utf8',
  });
  return !result.error && result.status === 0;
}

/** Install packages into the venv with whichever installer is available. */
function pipInstall(packages, { requirements = null, cpuIndex = false } = {}) {
  // `unsafe-best-match` lets uv pick the best version across PyPI and the CPU
  // index (its default first-index strategy deadlocks when the CPU index ships
  // an old transitive pin). `--link-mode copy` avoids hardlink failures when
  // the venv lives inside OneDrive or another cloud-synced folder.
  const indexArgs = cpuIndex
    ? ['--extra-index-url', 'https://download.pytorch.org/whl/cpu', '--index-strategy', 'unsafe-best-match']
    : [];
  if (has('uv')) {
    const args = ['pip', 'install', '--python', venvPython, '--link-mode', 'copy'];
    if (requirements) args.push('-r', requirements);
    else args.push(...packages);
    run('uv', [...args, ...indexArgs]);
  } else {
    run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
    const args = ['-m', 'pip', 'install'];
    if (requirements) args.push('-r', requirements);
    else args.push(...packages);
    run(venvPython, [...args, ...indexArgs]);
  }
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
    console.error(`Missing ${REQUIREMENTS} — cannot install LTX-Video dependencies.`);
    process.exit(1);
  }

  // Phase 1: the selfcheck's own prerequisites (yaml reads the bundled presets;
  // `mcp` is stubbed by the check itself). This keeps the fail-fast check cheap
  // — it runs before the multi-gigabyte torch download.
  console.log('\nInstalling the selfcheck prerequisites (PyYAML)…');
  pipInstall(['PyYAML']);

  if (fs.existsSync(SELFCHECK)) {
    console.log('Running the offline server selfcheck…');
    run(venvPython, [SELFCHECK]);
  } else {
    console.warn(`Warning: ${SELFCHECK} not found — skipping the offline selfcheck.`);
  }

  const cpuOnly = !hasNvidiaGpu();
  if (cpuOnly) console.log('\nNo NVIDIA GPU detected — using the CPU-only PyTorch index.');
  console.log('Installing LTX-Video dependencies (torch is a large download; be patient)…');
  pipInstall([], { requirements: REQUIREMENTS, cpuIndex: cpuOnly });

  if (fs.existsSync(SELFCHECK)) {
    console.log('\nRe-running the selfcheck against the installed environment…');
    run(venvPython, [SELFCHECK]);
  }

  console.log('\nLTX-Video MCP server ready:');
  console.log(`  python : ${venvPython}`);
  console.log('  server : mcp-servers/ltx-video/server.py');
  console.log('\nNext: npm run doctor   (verifies ffmpeg + both MCP servers)');
}

main();
