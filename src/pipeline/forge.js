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
import path from 'node:path';
import { loadConfig } from '../config.js';
import { createLogger } from '../util/log.js';
import { ensureDir, runStamp, slugify, writeJson } from '../util/fs.js';
import { ffmpegAvailable } from '../util/ffmpeg.js';
import { loadStoryboard } from './planner.js';
import { VisualRenderer } from './visuals.js';
import { KokoroNarration } from '../mcp/kokoro.js';
import { narrateScenes } from './audio.js';
import { assembleVideo } from './assemble.js';

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
    defaults: { voice: config.kokoro.voice, speed: config.kokoro.speed, lang: config.kokoro.lang },
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
        voice: spoken.voice,
        seconds: Math.round((Date.now() - sceneStarted) / 100) / 10,
      });

      onEvent?.({ type: 'scene-done', scene: sceneNumber, total: storyboard.scenes.length });
    }

    // ---- 4. Assemble -------------------------------------------------------
    const assembled = await assembleVideo({
      storyboard,
      scenes: segmentResults,
      config,
      outDir: outputDir,
      name: slug,
      logger: log,
      onEvent,
    });

    // ---- 5. Manifest -------------------------------------------------------
    const manifest = {
      generator: 'VideoForge',
      version: '1.0.0',
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
      backend: {
        visuals: visual.backend,
        visualsDetail: visual.reason,
        narration: 'kokoro-mcp',
        voice: config.kokoro.voice,
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

export default forge;