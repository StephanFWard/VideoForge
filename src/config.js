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

  return {
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
    intermediate: resolution === '720p' ? RESOLUTIONS['720p'] : RESOLUTIONS['1080p'],
    delivery: RESOLUTIONS[resolution],
    padSeconds: Number(overrides.padSeconds ?? env('VIDEO_FORGE_PAD_SECONDS', 0.6)),
    // Diffusion sampling controls. Lower steps are dramatically faster on CPU.
    steps: Number(overrides.steps ?? env('VIDEO_FORGE_STEPS', 25)),
    cfg: Number(overrides.cfg ?? env('VIDEO_FORGE_CFG', 7)),
    // Scenes are normalised at this size, then the finished cut is upscaled once
    // to the delivery resolution. Holding the intermediate at 1080p avoids
    // upscaling twice.
    intermediate: RESOLUTIONS[resolution === '720p' ? '720p' : '1080p'],
    fps: Number(overrides.fps ?? env('VIDEO_FORGE_FPS', 30)),
    outputDir: path.resolve(
      ROOT,
      overrides.outputDir ?? env('VIDEO_FORGE_OUT', 'output'),
    ),
    workDir: path.resolve(
      ROOT,
      overrides.workDir ?? env('VIDEO_FORGE_WORK', 'work'),
    ),
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
