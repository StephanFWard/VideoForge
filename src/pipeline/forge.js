/**
 * VideoForge orchestrator.
 *
 *   topic | storyboard file
 *        -> planner            (script + per-scene prompts)
 *        -> VisualRenderer     (ComfyUI MCP: keyframe -> motion)
 *        -> KokoroNarration    (Kokoro MCP: narration per scene)
 *        -> assembleVideo      (ffmpeg: cut, join, deliver at 4K)
 *
 * Each stage is independently testable, and every stage reports progress
 * through `onEvent` so the CLI and the web UI can show the same run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { createLogger } from '../util/log.js';
import { ensureDir, runStamp, slugify, writeJson } from '../util/fs.js';
import { ffmpegAvailable, placeholderStill } from '../util/ffmpeg.js';
import { loadStoryboard } from './planner.js';
import { VisualRenderer } from './visuals.js';
import { KokoroNarration } from '../mcp/kokoro.js';
import { narrateScenes } from './audio.js';
import { assembleVideo } from './assemble.js';
import { buildTimeline } from './timeline.js';

/**
 * Render a video.
 *
 * @param {object} req
 * @param {string}   [req.topic]           e.g. "how to brew better coffee"
 * @param {string}   [req.storyboardFile]  a hand-authored storyboard JSON
 * @param {object}   [req.config]          overrides passed to loadConfig
 * @param {object}   [req.logger]
 * @param {Function} [req.onEvent]         progress sink
 * @param {number}   [req.scenes]          scene count for the template planner
 * @param {string}   [req.transition]      default scene entry transition
 * @param {boolean}  [req.planOnly]        stop after planning
 * @param {boolean}  [req.silent]
 */
export async function forge({
  topic,
  storyboardFile,
  config: configOverrides = {},
  logger = null,
  onEvent = null,
  scenes,
  transition,
  planOnly = false,
  silent = false,
} = {}) {
  const started = Date.now();
  const log = logger ?? createLogger({ silent, onEvent });
  const config = loadConfig(configOverrides);

  if (!(await ffmpegAvailable(config.ffmpeg, config.ffprobe))) {
    throw new Error(
      'ffmpeg/ffprobe are required but were not runnable. Install ffmpeg or set ' +
        'FFMPEG_PATH and FFPROBE_PATH.',
    );
  }

  // ---- 1. Plan ------------------------------------------------------------
  const { storyboard, warnings, source, mode } = await loadStoryboard({
    file: storyboardFile,
    topic,
    config,
    scenes,
    defaults: {
      voice: config.kokoro.voice,
      speed: config.kokoro.speed,
      lang: config.kokoro.lang,
      transition: transition ?? config.transition,
    },
  });

  log.ok(`Storyboard ready from ${mode}: "${storyboard.title}" (${storyboard.scenes.length} scenes)`);
  for (const warning of warnings) log.warn(warning);

  if (planOnly) {
    return { ok: true, planOnly: true, storyboard, warnings, source, mode };
  }

  // ---- 2. Prepare the run directory ---------------------------------------
  const slug = slugify(storyboard.title);
  const stamp = runStamp();
  const outputDir = ensureDir(path.join(config.outputDir, slug, stamp));
  const workDir = ensureDir(path.join(config.workDir, slug, stamp));
  log.info(`Run directory: ${outputDir}`);

  const renderer = new VisualRenderer(config, {
    logger: log,
    onProgress: (p) => onEvent?.({ type: 'render-progress', ...p }),
    look: storyboard.look,
    negative: storyboard.negative,
    steps: config.steps,
    cfg: config.cfg,
    // Deterministic seeds: every scene is derived from the topic, so reruns
    // (and cache lookups) agree on exactly the same keyframe.
    seedBase: storyboard.topic,
  });

  const segmentResults = [];
  let narration = null;

  try {
    // ---- 3. Visuals + narration, scene by scene ---------------------------
    const visual = await renderer.init();

    narration = new KokoroNarration(config, { logger: log });
    await narration.connect();

    for (const [index, scene] of storyboard.scenes.entries()) {
      const sceneNumber = index + 1;
      const sceneDir = ensureDir(path.join(workDir, `scene${String(sceneNumber).padStart(2, '0')}`));
      const sceneStarted = Date.now();

      onEvent?.({
        type: 'scene-start',
        scene: sceneNumber,
        total: storyboard.scenes.length,
        title: scene.title,
      });
      log.step(`Scene ${sceneNumber}/${storyboard.scenes.length}: ${scene.title}`);

      // Visuals first, so scene length is then driven by the narration we make.
      const visualResult = await visual.renderScene({
        scene,
        index: sceneNumber,
        outDir: sceneDir,
        width: config.render.width,
        height: config.render.height,
        fps: config.fps,
      });
      log.info(`  visuals: ${visualResult.method}`);

      const [spoken] = await narrateScenes({
        storyboard: { ...storyboard, scenes: [scene] },
        kokoro: narration,
        outDir: ensureDir(path.join(sceneDir, 'audio')),
        config,
        logger: null,
      });
      log.info(`  narration: ${spoken.duration.toFixed(1)}s (${config.kokoro.voice})`);

      segmentResults.push({
        scene: sceneNumber,
        title: scene.title,
        clip: visualResult.clip,
        still: visualResult.still,
        audio: spoken.path,
        duration: spoken.duration,
        method: visualResult.method,
        backend: visualResult.backend,
        motion: visualResult.motion,
        seed: visualResult.seed,
        cached: visualResult.cached,
        voice: spoken.voice,
        seconds: Math.round((Date.now() - sceneStarted) / 100) / 10,
      });

      onEvent?.({ type: 'scene-done', scene: sceneNumber, total: storyboard.scenes.length });
    }

    // ---- 4. Timeline: measured narration -> exact frames --------------------
    const timeline = buildTimeline({
      storyboard,
      narration: segmentResults,
      fps: config.fps,
      padSeconds: config.padSeconds,
      transitionSeconds: config.transitionSeconds,
    });
    log.info(
      `Timeline: ${timeline.durationInFrames} frames @ ${timeline.fps} fps ` +
        `(${timeline.durationSeconds.toFixed(2)}s, ${timeline.mode}, ` +
        `${timeline.transitionSeconds}s transitions)`,
    );
    onEvent?.({ type: 'timeline', timeline });

    // ---- 5. Assemble --------------------------------------------------------
    const assembled = await assembleVideo({
      storyboard,
      scenes: segmentResults,
      timeline,
      config,
      outDir: outputDir,
      name: slug,
      logger: log,
      onEvent,
    });

    // ---- 6. Manifest --------------------------------------------------------
    const manifest = {
      generator: 'VideoForge',
      version: config.version,
      generatedAt: new Date().toISOString(),
      title: storyboard.title,
      topic: storyboard.topic,
      description: storyboard.description,
      storyboardSource: source,
      storyboardMode: mode,
      resolution: config.resolution,
      delivery: `${config.delivery.width}x${config.delivery.height}`,
      renderResolution: `${config.render.width}x${config.render.height}`,
      fps: config.fps,
      // The frame-exact timeline: what a renderer like Remotion would call the
      // composition. `from` is where each scene starts, in frames.
      timeline: {
        fps: timeline.fps,
        mode: timeline.mode,
        durationInFrames: timeline.durationInFrames,
        durationSeconds: timeline.durationSeconds,
        padSeconds: timeline.padSeconds,
        transitionSeconds: timeline.transitionSeconds,
        scenes: timeline.scenes.map((s) => ({
          scene: s.scene,
          title: s.title,
          from: s.from,
          durationInFrames: s.durationInFrames,
          narrationSeconds: s.narrationSeconds,
          transition: s.transition,
          overlapFrames: s.overlapFrames,
        })),
      },
      // The normalised storyboard is the complete "props" of this render; with
      // the resolved seeds below, the run can be reproduced exactly.
      storyboard,
      backend: {
        visuals: visual.backend,
        visualsDetail: visual.reason,
        narration: 'kokoro-mcp',
        voice: config.kokoro.voice,
        cache: { enabled: config.cache, hits: renderer.cache.hits, misses: renderer.cache.misses },
      },
      output: {
        video: assembled.finalPath,
        master: assembled.masterPath,
        thumbnail: assembled.thumbnail,
        durationSeconds: assembled.video?.duration ?? null,
        width: assembled.video?.width ?? null,
        height: assembled.video?.height ?? null,
        bytes: assembled.video?.size ?? null,
      },
      cost: { usd: 0, note: 'local: CPU Kokoro narration + ffmpeg assembly' },
      scenes: segmentResults.map((s) => ({
        scene: s.scene,
        title: s.title,
        method: s.method,
        motion: s.motion ?? null,
        seed: s.seed ?? null,
        cached: Boolean(s.cached),
        narrationSeconds: Math.round(s.duration * 100) / 100,
        renderSeconds: s.seconds,
        audio: s.audio,
        still: s.still,
        clip: s.clip,
        segment: s.segment,
      })),
      warnings,
      timings: { totalSeconds: Math.round((Date.now() - started) / 100) / 10 },
    };

    const manifestPath = await writeJson(path.join(outputDir, 'manifest.json'), manifest);

    log.ok(
      `Done in ${manifest.timings.totalSeconds}s -> ${assembled.finalPath} ` +
        `(${manifest.output.width}x${manifest.output.height}, ` +
        `${(manifest.output.durationSeconds ?? 0).toFixed(1)}s)`,
    );

    return {
      ok: true,
      slug,
      title: storyboard.title,
      outputDir,
      workDir,
      video: assembled.finalPath,
      master: assembled.masterPath,
      thumbnail: assembled.thumbnail,
      manifestPath,
      manifest,
      timeline,
      backend: visual.backend,
      backendDetail: visual.reason,
      warnings,
      storyboard,
    };
  } finally {
    await narration?.close();
    await renderer.close();
  }
}

/**
 * Render a single keyframe - the `video-forge still` command, and the
 * equivalent of Remotion's `remotion still`.
 *
 * With ComfyUI up the still is real diffusion output (and takes part in the
 * keyframe cache); otherwise a deterministic placeholder frame is written so
 * the command works on any machine.
 *
 * @param {object} req { topic, storyboardFile, scene, outPath, config, logger, silent }
 * @returns {Promise<{ok:boolean, scene:number, total:number, path:string, method:string, backend:string, cached:boolean, warnings:string[]}>}
 */
export async function forgeStill({
  topic,
  storyboardFile,
  scene = 1,
  outPath,
  config: configOverrides = {},
  logger = null,
  silent = false,
} = {}) {
  const log = logger ?? createLogger({ silent });
  const config = loadConfig(configOverrides);

  const { storyboard, warnings, source, mode } = await loadStoryboard({
    file: storyboardFile,
    topic,
    config,
    defaults: {
      voice: config.kokoro.voice,
      speed: config.kokoro.speed,
      lang: config.kokoro.lang,
      transition: config.transition,
    },
  });

  const requested = Math.trunc(Number(scene)) || 1;
  const index = Math.min(Math.max(requested, 1), storyboard.scenes.length);
  const target = storyboard.scenes[index - 1];
  if (index !== requested) {
    log.warn(`Scene ${requested} does not exist; using scene ${index} of ${storyboard.scenes.length}.`);
  }

  const stillDir = ensureDir(path.join(config.workDir, 'stills'));
  const destination = outPath
    ? path.resolve(outPath)
    : path.join(stillDir, `${slugify(storyboard.title)}_scene${String(index).padStart(2, '0')}.png`);

  const renderer = new VisualRenderer(config, {
    logger: log,
    look: storyboard.look,
    negative: storyboard.negative,
    steps: config.steps,
    cfg: config.cfg,
    seedBase: storyboard.topic,
  });

  let method = 'placeholder';
  let cached = false;
  let seed = null;

  try {
    await renderer.init();
    if (renderer.backend === 'comfy') {
      try {
        const rendered = await renderer.renderStill({
          scene: target,
          index,
          outDir: stillDir,
          width: config.render.width,
          height: config.render.height,
        });
        if (rendered?.path) {
          fs.copyFileSync(rendered.path, destination);
          method = rendered.cached ? 'cache' : 'diffusion';
          cached = Boolean(rendered.cached);
          seed = rendered.seed;
        }
      } catch (error) {
        log.warn(
          `Keyframe failed (${String(error.message).split('\n')[0]}); ` +
            'writing a placeholder still instead.',
        );
      }
    }

    if (method === 'placeholder') {
      await placeholderStill({
        output: destination,
        width: config.render.width,
        height: config.render.height,
        index,
        label: target.title || target.narration.slice(0, 60),
        ffmpeg: config.ffmpeg,
      });
    }
  } finally {
    await renderer.close();
  }

  log.ok(`Still: ${destination} (${method}${cached ? ', cache hit' : ''})`);
  return {
    ok: true,
    scene: index,
    total: storyboard.scenes.length,
    title: target.title,
    path: destination,
    method,
    backend: renderer.backend,
    cached,
    seed,
    storyboardSource: source,
    storyboardMode: mode,
    warnings,
  };
}

export default forge;