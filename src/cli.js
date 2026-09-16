#!/usr/bin/env node
/**
 * VideoForge command line interface.
 *
 *   video-forge forge "<topic>"     render a video from a topic
 *   video-forge forge --storyboard my.json
 *   video-forge plan  "<topic>"     print the storyboard it would render
 *   video-forge doctor              check every dependency and both MCP servers
 *   video-forge voices              list Kokoro voices
 *   video-forge connect <url>       point VideoForge at a ComfyUI (e.g. a tunnel)
 *   video-forge serve               start the web UI
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from './config.js';
import { createLogger } from './util/log.js';
import { ffmpegAvailable } from './util/ffmpeg.js';
import { forge } from './pipeline/forge.js';
import { loadStoryboard, planFromTopic } from './pipeline/planner.js';
import { ComfyClient } from './mcp/comfy.js';
import { KokoroNarration } from './mcp/kokoro.js';

const USAGE = `
VideoForge - turn a topic into a finished video with ComfyUI MCP + Kokoro MCP.

USAGE
  video-forge forge [topic] [options]     Render a video
  video-forge plan  [topic] [options]     Print the storyboard, render nothing
  video-forge doctor                      Check dependencies and both MCP servers
  video-forge voices [--lang en-us]       List available Kokoro voices
  video-forge connect <comfyui-url>       Save a ComfyUI URL (local or tunnelled)
  video-forge serve [--port 4321]         Start the web UI

OPTIONS
  -t, --topic <text>        Topic to generate a video about
  -s, --storyboard <file>   Use a hand-authored storyboard JSON instead of a topic
      --scenes <n>          Scene count for the template planner (default: intent-based)
      --resolution <r>      720p | 1080p | 4k          (default: 4k)
      --backend <b>         auto | comfy | mock        (default: auto)
      --voice <name>        Kokoro voice                (default: af_heart)
      --speed <n>           Narration speed 0.5-2.0    (default: 1.0)
      --steps <n>           Diffusion steps            (default: 25; lower = faster on CPU)
      --out <dir>           Output directory           (default: ./output)
      --plan-only           Plan and stop
      --json                Machine-readable output summary
  -h, --help                Show this help

EXAMPLES
  video-forge forge "how to brew better coffee" --scenes 5
  video-forge forge --storyboard my-video.storyboard.json --resolution 4k
  video-forge doctor
  video-forge connect https://random-words-here.trycloudflare.com
`;

/** Minimal, dependency-free flag parser: supports --k v, --k=v and booleans. */
export function parseFlags(argv) {
  const flags = { _: [] };
  const aliases = { t: 'topic', s: 'storyboard', h: 'help', o: 'out' };
  const booleans = new Set(['help', 'plan-only', 'json', 'silent']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--') || token.startsWith('-')) {
      const eq = token.indexOf('=');
      let key = (eq === -1 ? token : token.slice(0, eq)).replace(/^-+/, '');
      let value = eq === -1 ? null : token.slice(eq + 1);
      key = aliases[key] ?? key;

      if (value === null) {
        if (booleans.has(key)) {
          value = true;
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          value = argv[++i];
        } else {
          value = true;
        }
      }
      flags[key] = value;
    } else {
      flags._.push(token);
    }
  }
  return flags;
}

/** Build loadConfig overrides from parsed flags. */
export function configFromFlags(flags) {
  const overrides = {};
  if (flags.resolution) overrides.resolution = flags.resolution;
  if (flags.backend) overrides.backend = flags.backend;
  if (flags.out) overrides.outputDir = flags.out;
  if (flags.voice) overrides.voice = flags.voice;
  if (flags.speed) overrides.speed = Number(flags.speed);
  if (flags.steps) overrides.steps = Number(flags.steps);
  if (flags.comfyUrl) overrides.comfyUrl = flags.comfyUrl;
  return overrides;
}

const topicFrom = (flags) => {
  const positional = flags._.join(' ').trim();
  return flags.topic && flags.topic !== true ? String(flags.topic) : positional || null;
};

function summarise(result) {
  const m = result.manifest;
  return {
    ok: result.ok,
    title: result.title,
    video: result.video,
    outputDir: result.outputDir,
    manifest: result.manifestPath,
    resolution: m.output.width && m.output.height ? `${m.output.width}x${m.output.height}` : null,
    durationSeconds: m.output.durationSeconds ? Math.round(m.output.durationSeconds * 10) / 10 : null,
    scenes: m.scenes.length,
    visuals: m.backend.visuals,
    visualsDetail: m.backend.visualsDetail,
    voice: m.backend.voice,
    sceneMethods: [...new Set(m.scenes.map((s) => s.method))],
    elapsedSeconds: m.timings.totalSeconds,
  };
}

async function cmdForge(flags) {
  const topic = topicFrom(flags);
  const storyboardFile = flags.storyboard && flags.storyboard !== true ? flags.storyboard : null;
  if (!topic && !storyboardFile) {
    console.error('Provide a topic or --storyboard <file>.\n');
    console.log(USAGE);
    process.exitCode = 2;
    return;
  }
  if (storyboardFile && !fs.existsSync(storyboardFile)) {
    throw new Error(`Storyboard file not found: ${storyboardFile}`);
  }

  const result = await forge({
    topic,
    storyboardFile,
    config: configFromFlags(flags),
    scenes: flags.scenes ? Number(flags.scenes) : undefined,
    planOnly: Boolean(flags['plan-only']),
    silent: Boolean(flags.json),
  });

  if (flags['plan-only']) {
    console.log(JSON.stringify(result.storyboard, null, 2));
    return;
  }
  if (flags.json) console.log(JSON.stringify(summarise(result), null, 2));
  else console.log(`\nVideo: ${result.video}`);
}

async function cmdPlan(flags) {
  const topic = topicFrom(flags);
  const storyboardFile = flags.storyboard && flags.storyboard !== true ? flags.storyboard : null;
  const config = loadConfig(configFromFlags(flags));

  const { storyboard, warnings, source, mode } = await loadStoryboard({
    file: storyboardFile,
    topic,
    config,
    scenes: flags.scenes ? Number(flags.scenes) : undefined,
    defaults: { voice: config.kokoro.voice, speed: config.kokoro.speed, lang: config.kokoro.lang },
  });

  console.error(`# ${mode} storyboard from ${source}`);
  for (const warning of warnings) console.error(`# warning: ${warning}`);
  console.log(JSON.stringify(storyboard, null, 2));
}

async function cmdVoices(flags) {
  const kokoro = new KokoroNarration(loadConfig({}));
  try {
    const voices = await kokoro.voices(flags.lang);
    console.log(
      voices
        ? JSON.stringify(voices, null, 2)
        : 'This Kokoro MCP server does not expose a voice list.',
    );
  } finally {
    await kokoro.close();
  }
}

async function cmdConnect(url) {
  if (!url) {
    throw new Error('Provide the ComfyUI URL, e.g. video-forge connect https://x.trycloudflare.com');
  }
  const envPath = path.join(ROOT, '.env');
  const line = `COMFYUI_URL=${url}`;
  let body = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  if (/^COMFYUI_URL=.*$/m.test(body)) body = body.replace(/^COMFYUI_URL=.*$/m, line);
  else body += `${body === '' || body.endsWith('\n') ? '' : '\n'}${line}\n`;
  fs.writeFileSync(envPath, body, 'utf8');

  // Prove the new target works rather than just claiming success.
  console.log(`Saved ${line} to .env`);
  const client = new ComfyClient(loadConfig({ comfyUrl: url }));
  try {
    const health = await client.health();
    if (health.ok) {
      console.log(`Connected: ComfyUI ${health.detail.comfyui} on ${health.detail.device}`);
    } else {
      console.error(`Saved, but not reachable yet: ${health.detail.error}`);
      process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

async function cmdDoctor() {
  const config = loadConfig({});
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('Node.js', Number(process.versions.node.split('.')[0]) >= 20, `v${process.versions.node}`);

  let ffmpeg = false;
  try {
    ffmpeg = await ffmpegAvailable(config.ffmpeg, config.ffprobe);
  } catch {
    ffmpeg = false;
  }
  add('ffmpeg + ffprobe', ffmpeg, ffmpeg ? 'found on PATH' : 'not runnable; install ffmpeg');

  const pythonOk = fs.existsSync(config.kokoroMcp.command);
  add(
    'Kokoro runtime',
    pythonOk,
    pythonOk
      ? config.kokoroMcp.command
      : `missing ${config.kokoroMcp.command} - run: npm run setup:kokoro`,
  );

  if (pythonOk) {
    const kokoro = new KokoroNarration(config);
    try {
      const health = await kokoro.health();
      add(
        'Kokoro MCP',
        Boolean(health.ok),
        health.ok
          ? `${health.voices ?? '?'} voices, ${health.sample_rate ?? '?'} Hz, torch ${health.torch ?? '?'}`
          : (health.error ?? 'unhealthy'),
      );
    } catch (error) {
      add('Kokoro MCP', false, error.message.split('\n')[0]);
    } finally {
      await kokoro.close();
    }
  }

  if (config.backend === 'mock') {
    add('ComfyUI MCP', true, 'skipped (VIDEO_FORGE_BACKEND=mock)');
  } else {
    const client = new ComfyClient(config);
    try {
      const health = await client.health();
      add(
        'ComfyUI MCP',
        Boolean(health.ok),
        health.ok
          ? `ComfyUI ${health.detail.comfyui} on ${health.detail.device}, ` +
              `${health.detail.vramFreeGb ?? '?'} GB free`
          : `${config.comfyUrl} unreachable - visuals will fall back to mock`,
      );
    } catch (error) {
      add('ComfyUI MCP', false, error.message.split('\n')[0]);
    } finally {
      await client.close();
    }
  }

  console.log('\nVideoForge doctor\n');
  for (const check of checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(16)} ${check.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(
    failed.length
      ? `\n${failed.length} check(s) failed. Narration and assembly still work; ` +
          'visuals fall back to the offline mock renderer.\n'
      : '\nAll checks passed.\n',
  );
  if (failed.length) process.exitCode = 1;
}

async function cmdServe(flags) {
  const { startServer } = await import('./server.js');
  await startServer({
    port: Number(flags.port ?? process.env.PORT ?? 4321),
    config: configFromFlags(flags),
  });
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  if (flags.help || command === 'help' || !command) {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case 'forge':
    case 'generate':
      await cmdForge(flags);
      break;
    case 'plan':
      await cmdPlan(flags);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'voices':
      await cmdVoices(flags);
      break;
    case 'connect':
      await cmdConnect(flags._[0] ?? (flags.url === true ? null : flags.url));
      break;
    case 'serve':
      await cmdServe(flags);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  createLogger({}).error(error.message);
  process.exitCode = 1;
});
