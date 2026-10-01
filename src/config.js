/**
 * VideoForge configuration.
 *
 * Resolution order:  defaults  ->  .env file  ->  real environment variables.
 * Nothing here throws: VideoForge is designed to boot even when ComfyUI and
 * Kokoro are both absent, so that `doctor` can explain what is missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * VideoForge's own version, read from package.json once so the manifest and
 * `doctor` can never report a stale hard-coded number (Remotion exposes the
 * same idea as its `VERSION` export).
 */
export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Minimal .env parser (no dependency, no surprises). */
function readDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const dotenv = readDotEnv(path.join(ROOT, '.env'));

const env = (key, fallback) => {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  if (dotenv[key] !== undefined && dotenv[key] !== '') return dotenv[key];
  return fallback;
};

/** Named export presets.  Native video diffusion on a free T4 tops out well
 *  below these, so "4k" is reached by a super-resolution pass after the fact. */
export const RESOLUTIONS = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
};

/** The resolution the diffusion model actually renders at.  Small on purpose:
 *  a 16 GB T4 cannot diffuse 4K, and diffusion quality per-VRAM is best here. */
export const RENDER_RESOLUTIONS = {
  '720p': { width: 832, height: 480 },
  '1080p': { width: 1024, height: 576 },
  '4k': { width: 1280, height: 720 },
};

function pythonBin() {
  const rel =
    process.platform === 'win32'
      ? ['.venv', 'Scripts', 'python.exe']
      : ['.venv', 'bin', 'python'];
  return path.join(ROOT, ...rel);
}

function splitArgs(value, fallback) {
  if (!value) return fallback;
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? fallback;
}

export function loadConfig(overrides = {}) {
  const comfyUrl = overrides.comfyUrl ?? env('COMFYUI_URL', 'http://127.0.0.1:8188');

  const comfyCommand = overrides.comfyMcpCommand ?? env('COMFYUI_MCP_COMMAND', null);
  const comfyMcp = comfyCommand
    ? {
        command: comfyCommand,
        args: splitArgs(env('COMFYUI_MCP_ARGS', ''), []),
      }
    : {
        // The published ComfyUI MCP server.  Any --comfyui-url works, so a
        // tunnelled free Colab GPU is wired in by changing one env var.
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['-y', 'comfyui-mcp@latest', '--comfyui-url', comfyUrl],
      };

  const kokoroCommand = overrides.kokoroMcpCommand ?? env('KOKORO_MCP_COMMAND', null);
  const kokoroMcp = kokoroCommand
    ? {
        command: kokoroCommand,
        args: splitArgs(env('KOKORO_MCP_ARGS', ''), []),
      }
    : {
        // The bundled Kokoro MCP server, running in this repo's venv.
        command: overrides.python ?? pythonBin(),
        args: [path.join(ROOT, 'mcp-servers', 'kokoro-tts', 'server.py')],
        cwd: ROOT,
      };

  const backend = String(overrides.backend ?? env('VIDEO_FORGE_BACKEND', 'auto')).toLowerCase();
  if (!['auto', 'comfy', 'mock'].includes(backend)) {
    throw new Error(`Invalid VIDEO_FORGE_BACKEND "${backend}". Use auto | comfy | mock.`);
  }

  const resolutionKey = String(
    overrides.resolution ?? env('RESOLUTION', '4k'),
  ).toLowerCase();
  const resolution = RESOLUTIONS[resolutionKey] ? resolutionKey : '4k';

  // fps is the frame rate every timing calculation is based on; an invalid
  // value would silently break frame-exact cutting, so it is validated here.
  const fpsRaw = Number(overrides.fps ?? env('VIDEO_FORGE_FPS', 30));
  const fps = Number.isFinite(fpsRaw) && fpsRaw > 0 && fpsRaw <= 120
    ? Math.round(fpsRaw * 1000) / 1000
    : 30;

  const padSeconds = Math.max(0, Number(overrides.padSeconds ?? env('VIDEO_FORGE_PAD_SECONDS', 0.6)) || 0);
  const transitionRaw = Number(
    overrides.transitionSeconds ?? env('VIDEO_FORGE_TRANSITION_SECONDS', 0.5),
  );
  const transitionSeconds = Number.isFinite(transitionRaw)
    ? Math.min(Math.max(transitionRaw, 0), 5)
    : 0.5;

  const workDir = path.resolve(ROOT, overrides.workDir ?? env('VIDEO_FORGE_WORK', 'work'));
  const cache = overrides.cache ?? String(env('VIDEO_FORGE_CACHE', '1')) !== '0';
  const cacheDir = path.resolve(
    workDir,
    overrides.cacheDir ?? env('VIDEO_FORGE_CACHE_DIR', 'cache'),
  );

  const captionsMode = String(
    overrides.captions ?? overrides.captionsMode ?? env('VIDEO_FORGE_CAPTIONS', 'sidecar'),
  ).toLowerCase();
  const captionsEnabled = !['0', 'off', 'false', 'none', 'no'].includes(captionsMode);
  const captions = {
    enabled: captionsEnabled,
    // sidecar = always write <name>.srt next to the delivery file (default).
    // burn    = also render the lines into the picture with ffmpeg subtitles.
    mode: captionsMode === 'burn' ? 'burn' : 'sidecar',
    maxChars: Math.max(
      24,
      Math.min(160, Number(overrides.captionsMaxChars ?? env('VIDEO_FORGE_CAPTIONS_MAX_CHARS', 72)) || 72),
    ),
  };

  return {
    version: VERSION,
    root: ROOT,
    comfyUrl,
    comfyMcp,
    kokoroMcp,
    backend,
    resolution,
    // Three resolutions matter, and they are deliberately different:
    //  render       - what the diffusion model actually draws (small, fast)
    //  intermediate - what scenes are cut together at (editing resolution)
    //  delivery     - the finished file's resolution (what you asked for)
    render: RENDER_RESOLUTIONS[resolution],
    intermediate: RESOLUTIONS[resolution === '720p' ? '720p' : '1080p'],
    delivery: RESOLUTIONS[resolution],
    padSeconds,
    captions,
    // The default scene entry transition (none | fade | crossfade). A
    // storyboard may still override it per scene.
    transition: String(overrides.transition ?? env('VIDEO_FORGE_TRANSITION', 'none')).toLowerCase(),
    // Crossfade length. Crossfades overlap scenes, so this many seconds are
    // removed from the final timeline per crossfaded boundary.
    transitionSeconds,
    // Diffusion sampling controls. Lower steps are dramatically faster on CPU.
    steps: Number(overrides.steps ?? env('VIDEO_FORGE_STEPS', 25)),
    cfg: Number(overrides.cfg ?? env('VIDEO_FORGE_CFG', 7)),
    fps,
    // Keyframes are content-addressed and reused across runs; `--no-cache`
    // (VIDEO_FORGE_CACHE=0) turns that off for a forced fresh diffusion pass.
    cache,
    cacheDir,
    outputDir: path.resolve(
      ROOT,
      overrides.outputDir ?? env('VIDEO_FORGE_OUT', 'output'),
    ),
    workDir,
    kokoro: {
      voice: overrides.voice ?? env('KOKORO_VOICE', 'af_heart'),
      speed: Number(overrides.speed ?? env('KOKORO_SPEED', 1.0)),
      lang: overrides.lang ?? env('KOKORO_LANG', 'en-us'),
    },
    ffmpeg: env('FFMPEG_PATH', 'ffmpeg'),
    ffprobe: env('FFPROBE_PATH', 'ffprobe'),
    hfToken: env('HF_TOKEN', null),
    timeouts: {
      mcpConnectMs: Number(env('MCP_CONNECT_TIMEOUT_MS', 120000)),
      toolCallMs: Number(env('MCP_TOOL_TIMEOUT_MS', 45 * 60 * 1000)),
    },
  };
}

export default loadConfig;
