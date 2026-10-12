#!/usr/bin/env node
/**
 * One-time setup for a local ComfyUI — the general-purpose diffusion backend.
 *
 * Clones ComfyUI into vendor/ (gitignored), creates a dedicated virtualenv
 * inside the checkout, and installs ComfyUI's requirements with the CPU torch
 * wheels when no NVIDIA GPU is present (mirrors docker/comfyui.Dockerfile).
 * Run by `npm run setup:comfyui`.
 *
 * VideoForge never launches ComfyUI itself: setup prints the command that
 * starts it, `npm run doctor` verifies the connection, and
 * `npm run connect <url>` points VideoForge at any remote or tunnelled
 * instance instead of a local one.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKOUT = path.join(ROOT, 'vendor', 'ComfyUI');
const REPO = 'https://github.com/comfyanonymous/ComfyUI.git';
// The same working checkpoint docker/comfyui.Dockerfile bakes in, so the very
// first render does not 404 on an empty models/ directory.
const CKPT_URL =
  'https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors';

const win = process.platform === 'win32';
const venvDir = path.join(CHECKOUT, '.venv');
const venvPython = path.join(venvDir, win ? 'Scripts\\python.exe' : 'bin/python');
const REQUIREMENTS = path.join(CHECKOUT, 'requirements.txt');

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

/** CUDA wheels only pay off on NVIDIA hardware; elsewhere prefer the CPU index. */
function hasNvidiaGpu() {
  const result = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
    encoding: 'utf8',
  });
  return !result.error && result.status === 0;
}

/** Is a ComfyUI already serving on the configured URL? */
async function reachable(url) {
  try {
    const response = await fetch(new URL('/system_stats', url), {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Stream a URL to disk (Node >= 18 ships fetch, so no extra dependency). */
async function download(url, target) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.download`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
  fs.renameSync(partial, target);
}

/** Install ComfyUI's requirements with whichever installer is available. */
function installRequirements(cpuIndex) {
  // `unsafe-best-match` lets uv pick the best version across PyPI and the CPU
  // index (its default first-index strategy deadlocks when the CPU index ships
  // an old transitive pin). `--link-mode copy` avoids hardlink failures when
  // the checkout lives inside OneDrive or another cloud-synced folder.
  const indexArgs = cpuIndex
    ? ['--extra-index-url', 'https://download.pytorch.org/whl/cpu', '--index-strategy', 'unsafe-best-match']
    : [];
  if (has('uv')) {
    run('uv', ['pip', 'install', '--python', venvPython, '-r', REQUIREMENTS, '--link-mode', 'copy', ...indexArgs]);
  } else {
    run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
    run(venvPython, ['-m', 'pip', 'install', '-r', REQUIREMENTS, ...indexArgs]);
  }
}

async function main() {
  if (!has('git')) {
    console.error('git is required to clone ComfyUI. Install it from https://git-scm.com first.');
    process.exit(1);
  }

  if (fs.existsSync(path.join(CHECKOUT, 'main.py'))) {
    console.log(`Reusing existing ComfyUI checkout: ${CHECKOUT}`);
  } else {
    console.log(`Cloning ComfyUI (shallow) into ${CHECKOUT}…`);
    fs.mkdirSync(path.dirname(CHECKOUT), { recursive: true });
    run('git', ['clone', '--depth', '1', REPO, CHECKOUT]);
  }

  if (fs.existsSync(venvPython)) {
    console.log(`Reusing existing virtualenv: ${venvDir}`);
  } else if (has('uv')) {
    console.log('Creating ComfyUI virtualenv with uv (python 3.12)…');
    run('uv', ['venv', venvDir, '--python', '3.12']);
  } else {
    console.log('uv not found — falling back to "python -m venv".');
    console.log('(Install https://docs.astral.sh/uv/ for faster, pinned-python setups.)');
    const py = win ? 'python' : 'python3';
    if (!has(py)) {
      console.error(`Neither uv nor ${py} is available. Install one of them first.`);
      process.exit(1);
    }
    run(py, ['-m', 'venv', venvDir]);
  }

  if (!fs.existsSync(REQUIREMENTS)) {
    console.error(`Missing ${REQUIREMENTS} — cannot install ComfyUI dependencies.`);
    process.exit(1);
  }

  const cpuOnly = !hasNvidiaGpu();
  if (cpuOnly) console.log('\nNo NVIDIA GPU detected — using the CPU-only PyTorch index.');
  console.log('Installing ComfyUI dependencies (torch is a large download; be patient)…');
  installRequirements(cpuOnly);

  // A working checkpoint, so the very first render does not 404. Failure is a
  // warning, not an exit: the install itself succeeded and the file can be
  // fetched by hand later.
  const checkpoint = path.join(
    CHECKOUT,
    'models',
    'checkpoints',
    'v1-5-pruned-emaonly-fp16.safetensors',
  );
  if (fs.existsSync(checkpoint)) {
    console.log('\nStarter checkpoint already present — skipping the download.');
  } else {
    console.log('\nDownloading the starter checkpoint (v1-5-pruned-emaonly-fp16, ~2.2 GB)…');
    try {
      await download(CKPT_URL, checkpoint);
      console.log('Checkpoint saved.');
    } catch (error) {
      console.warn(`Warning: checkpoint download failed (${error.message}).`);
      console.warn(`  ComfyUI renders will fail until a .safetensors checkpoint exists in`);
      console.warn(`  ${path.join(CHECKOUT, 'models', 'checkpoints')}`);
      console.warn(`  You can fetch it yourself from: ${CKPT_URL}`);
    }
  }

  // Report whether an instance is already up, else print how to start one.
  const config = loadConfig({ backend: 'mock' });
  const running = await reachable(config.comfyUrl);
  let port = '8188';
  try {
    port = new URL(config.comfyUrl).port || '8188';
  } catch {
    // An unparsable COMFYUI_URL falls back to the ComfyUI default port.
  }

  console.log('\nComfyUI setup complete:');
  console.log(`  checkout : ${CHECKOUT}`);
  console.log(`  python   : ${venvPython}`);
  console.log('');
  if (running) {
    console.log(`ComfyUI is already reachable at ${config.comfyUrl} — nothing else to do.`);
    console.log('Verify with:  npm run doctor');
  } else {
    console.log('Start it with:');
    console.log(
      `  "${venvPython}" main.py${cpuOnly ? ' --cpu' : ''} --port ${port}   (from ${CHECKOUT})`,
    );
    console.log('');
    console.log('Then verify VideoForge can reach it:  npm run doctor');
    console.log('Remote or tunnelled instance instead?  npm run connect <url>');
  }
}

main();
