/**
 * VideoForge orchestrator.
 *
 *   topic | storyboard file
 *        -> planner            (script + per-scene prompts)
 *        -> VisualRenderer     (ComfyUI / LTX), or video theme layers
 *        -> local subject matte + ffmpeg composite (uploaded-video edits)
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
import { ffmpegAvailable, placeholderStill, probe } from '../util/ffmpeg.js';
import { loadStoryboard, planVideoEdit } from './planner.js';
import { REFERENCE_SCOPES, VisualRenderer } from './visuals.js';
import { resolveReferences, referenceSetId } from './references.js';
import { renderVideoThemes } from './video-edit.js';
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
 * @param {Array<object>} [req.references] uploaded images/videos for LTX-Video
 *                                        conditioning: [{path, strength, startFrame}]
 * @param {'first'|'all'} [req.referenceScope] scenes conditioned by run-wide references
 * @param {boolean} [req.editVideo] use one uploaded video as an editable source clip
 * @param {string} [req.backgroundTheme] generated replacement background theme
 * @param {string} [req.foregroundTheme] generated replacement foreground theme
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
  references = [],
  referenceScope = 'first',
  editVideo = false,
  backgroundTheme = '',
  foregroundTheme = '',
} = {}) {
  const started = Date.now();
  const log = logger ?? createLogger({ silent, onEvent });
  const config = loadConfig(configOverrides);
  const requestedBackgroundTheme = String(backgroundTheme ?? '').trim();
  const requestedForegroundTheme = String(foregroundTheme ?? '').trim();

  if (!REFERENCE_SCOPES.includes(referenceScope)) {
    throw new Error(
      `Unknown reference scope "${referenceScope}". Use ${REFERENCE_SCOPES.join(' | ')}.`,
    );
  }

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
  const effectiveBackgroundTheme = requestedBackgroundTheme ||
    (!requestedForegroundTheme ? String(topic || storyboard.topic).trim() : '');

  log.ok(`Storyboard ready from ${mode}: "${storyboard.title}" (${storyboard.scenes.length} scenes)`);
  for (const warning of warnings) log.warn(warning);

  // Reference media (LTX-Video conditioning). Resolved here - before the run
  // directory even exists - so a bad path or an unsupported file fails fast with
  // a clear message instead of after a multi-gigabyte model has loaded.
  const referenceWarnings = [];
  const referenceList = [...(Array.isArray(references) ? references : [])];
  for (const scene of storyboard.scenes) {
    for (const entry of scene.references ?? []) referenceList.push(entry);
  }

  let resolvedReferences = { references: [], warnings: [] };
  if (referenceList.length > 0) {
    resolvedReferences = resolveReferences(referenceList, { config });
    referenceWarnings.push(...resolvedReferences.warnings);

    const described = resolvedReferences.references
      .map((r) => `${path.basename(r.path)} (${r.kind}, strength ${r.strength}, frame ${r.startFrame})`)
      .join('; ');
    log.ok(`Reference media: ${resolvedReferences.references.length} item(s) - ${described}`);
    for (const warning of resolvedReferences.warnings) log.warn(warning);
  }

  let editSource = null;
  let editSourceInfo = null;
  if (editVideo) {
    const videos = resolvedReferences.references.filter((reference) => reference.kind === 'video');
    if (videos.length !== 1) {
      throw new Error(
        `Edit uploaded video requires exactly one video reference; found ${videos.length}.`,
      );
    }
    editSource = videos[0];
    if (!effectiveBackgroundTheme && !requestedForegroundTheme) {
      throw new Error('A video edit needs a background or foreground theme.');
    }
    editSourceInfo = await probe(editSource.path, config.ffprobe);
    if (!editSourceInfo?.hasVideo || !editSourceInfo.duration || !editSourceInfo.width || !editSourceInfo.height) {
      throw new Error(`Could not read video metadata for edit source "${editSource.path}".`);
    }
    const editSeconds = editSourceInfo.duration;
    const editPlan = planVideoEdit(topic || storyboard.topic, {
      seconds: editSeconds,
      defaults: {
        voice: config.kokoro.voice,
        speed: config.kokoro.speed,
        lang: config.kokoro.lang,
        transition: transition ?? config.transition,
      },
    });
    storyboard.scenes = editPlan.storyboard.scenes;
    storyboard.estimatedSeconds = editPlan.storyboard.estimatedSeconds;
    storyboard.look = '';
    storyboard.negative = editPlan.storyboard.negative;
    resolvedReferences.references = resolvedReferences.references.filter(
      (reference) => reference.path !== editSource.path,
    );
    if (resolvedReferences.references.length > 0) {
      throw new Error(
        'Layered video edits currently use the source video and theme prompts only. ' +
          'Remove additional reference images from this edit request.',
      );
    }

    config.render = { ...config.render };
    config.intermediate = { ...config.intermediate };
    config.delivery = { ...config.delivery };
    if (editSourceInfo.height > editSourceInfo.width) {
      for (const size of [config.render, config.intermediate, config.delivery]) {
        [size.width, size.height] = [size.height, size.width];
      }
      storyboard.aspect = '9:16';
    } else {
      storyboard.aspect = '16:9';
    }
    log.ok(
      `Video edit source: ${path.basename(editSource.path)} ` +
        `(${editSourceInfo.width}x${editSourceInfo.height}, ${editSourceInfo.duration.toFixed(1)}s)`,
    );
  }

  const allWarnings = [...warnings, ...referenceWarnings];

  if (planOnly) {
    return {
      ok: true,
      planOnly: true,
      storyboard,
      warnings: allWarnings,
      source,
      mode,
      references: resolvedReferences.references,
    };
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
    // Reference media (LTX-Video conditioning). Validated here, before anything
    // expensive runs, so a bad upload fails in the planning stage.
    references: resolvedReferences.references,
    referenceScope,
    inputVideoPath: editSource?.path ?? null,
    inputVideoInfo: editSourceInfo,
  });

  const segmentResults = [];
  let narration = null;
  let videoThemes = null;

  try {
    // ---- 3. Visuals + narration, scene by scene ---------------------------
    const visual = editVideo
      ? { backend: 'layered-composite', reason: 'Local segmentation and ffmpeg compositing' }
      : await renderer.init();

    narration = new KokoroNarration(config, { logger: log });
    await narration.connect();

    if (editVideo) {
      videoThemes = await renderVideoThemes({
        source: editSource.path,
        sourceInfo: editSourceInfo,
        backgroundTheme: effectiveBackgroundTheme,
        foregroundTheme: requestedForegroundTheme,
        outputDir: ensureDir(path.join(workDir, 'video-edit')),
        config,
        logger: log,
      });
    }

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
      const visualResult = editVideo
        ? {
            clip: videoThemes.clip,
            still: null,
            method: 'segmented-theme-composite',
            backend: 'comfy+rembg+ffmpeg',
            motion: 'source-video',
            seed: null,
            cached: false,
          }
        : await visual.renderScene({
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
        // The LTX-Video preset that produced these clips, when it was used.
        model: visual.backend === 'ltx' ? config.ltx.model : null,
      },
      // Reference media this run was conditioned on, so the render is
      // reproducible from the manifest alone.
      references: resolvedReferences.references.length
        ? {
            id: referenceSetId(resolvedReferences.references),
            items: resolvedReferences.references.map((r) => ({
              path: r.path,
              kind: r.kind,
              strength: r.strength,
              startFrame: r.startFrame,
            })),
          }
        : null,
      videoEdit: editSource
        ? {
            source: editSource.path,
            durationSeconds: editSourceInfo.duration,
            width: editSourceInfo.width,
            height: editSourceInfo.height,
            method: 'automatic-foreground-matte-and-layer-composite',
            backgroundTheme: effectiveBackgroundTheme || null,
            foregroundTheme: requestedForegroundTheme || null,
            assets: videoThemes?.assets ?? {},
          }
        : null,
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
        // LTX-Video specifics: the preset used, and what conditioned this scene.
        model: s.model ?? null,
        references: s.references?.length ? s.references : null,
      })),
      warnings: allWarnings,
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
      warnings: allWarnings,
      storyboard,
      references: resolvedReferences.references,
    };
  } finally {
    await narration?.close();
    if (!editVideo) await renderer.close();
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