/**
 * The visual renderer: turns each scene into a moving shot.
 *
 * Two backends, chosen at runtime so the app is never dead in the water:
 *
 *   comfy - real diffusion through the ComfyUI MCP server. Renders a keyframe,
 *           then tries to animate it with an image-to-video model.
 *   mock  - deterministic placeholder footage rendered by ffmpeg locally.
 *           Needs no GPU, no models and no network, so tests and dry runs are
 *           fast and reproducible.
 *
 * The motion ladder inside the comfy backend matters: if no image-to-video
 * model is installed, a keyframe is still animated with a Ken Burns push, so a
 * video always comes out even on a text-to-image-only install.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ComfyClient } from '../mcp/comfy.js';
import { LtxClient } from '../mcp/ltx.js';
import { placeholderShot, probe, stillToVideo, extractFrame } from '../util/ffmpeg.js';
import { cacheKey, readCacheEntry, writeCacheEntry } from '../util/cache.js';
import { randomSeed, resolveMotion, wantsDiffusionMotion, zoompanFilter } from './motion.js';
import { alignFrames, resolveLtxResolution } from './ltx.js';

export const BACKENDS = ['auto', 'comfy', 'ltx', 'mock'];
export const REFERENCE_SCOPES = ['first', 'all'];

export class VisualRenderer {
  /**
   * @param {object} config VideoForge config.
   * @param {object} [options] { logger, onProgress, look, negative, steps, cfg, seedBase }
   *   `look` is appended to every scene prompt so a multi-scene video keeps one
   *   consistent visual style instead of looking like a patchwork.
   *   `seedBase` (usually the topic) gives every scene a deterministic
   *   diffusion seed, so reruns and cache lookups agree.
   *   `references` are uploaded images/videos used as LTX-Video conditioning.
   */
  constructor(
    config,
    {
      logger = null,
      onProgress = null,
      look = '',
      negative = '',
      steps = 25,
      cfg = 7,
      seedBase = '',
      references = [],
      referenceScope = 'first',
    } = {},
  ) {
    this.config = config;
    this.logger = logger;
    this.onProgress = onProgress;
    this.look = look;
    this.negative = negative;
    this.steps = steps;
    this.cfg = cfg;
    this.seedBase = seedBase;
    // Reference media for LTX-Video conditioning: [{path, strength, startFrame}].
    this.references = Array.isArray(references) ? references : [];
    this.referenceScope = REFERENCE_SCOPES.includes(referenceScope) ? referenceScope : 'first';
    this.backend = null;
    this.comfy = null;
    this.ltx = null;
    this.reason = null;
    this.cache = { hits: 0, misses: 0 };
  }

  /**
   * The seed a scene will render with: the storyboard's own seed when given,
   * otherwise a value derived deterministically from the topic and scene index.
   */
  seedFor(scene, index) {
    if (scene && scene.seed !== null && scene.seed !== undefined) return scene.seed;
    return randomSeed(`${this.seedBase}#${index}`);
  }

  /**
   * Decide which backend to use. `auto` probes for a real renderer and degrades
   * gracefully rather than throwing, because a topic should still render even
   * with no GPU and no diffusion server at all.
   *
   * Without references, `auto` prefers ComfyUI and falls back to LTX-Video then
   * mock. Reference-conditioned runs require LTX-Video, so auto selects it
   * directly rather than producing an unconditioned result.
   */
  async init() {
    if (this.references.length > 0 && !['auto', 'ltx'].includes(this.config.backend)) {
      throw new Error(
        'Reference-conditioned rendering requires the LTX-Video backend. ' +
          'Choose backend "auto" or "ltx" and run `npm run setup:ltx` if needed.',
      );
    }

    if (this.config.backend === 'mock') {
      this.backend = 'mock';
      this.reason = 'VIDEO_FORGE_BACKEND=mock';
      return this;
    }

    if (this.config.backend === 'ltx' || this.config.backend === 'auto') {
      const required = this.config.backend === 'ltx' || this.references.length > 0;
      if (await this.initLtx(required)) return this;
      if (required) throw this.ltxError;
    }

    if (this.config.backend === 'comfy' || this.config.backend === 'auto') {
      this.comfy = new ComfyClient(this.config, { logger: this.logger });
      const health = await this.comfy.health();

      if (health.ok) {
        this.backend = 'comfy';
        const detail = health.detail ?? {};
        this.reason = `ComfyUI ${detail.comfyui ?? '?'} on ${detail.device ?? '?'}`;
        this.logger?.ok?.(`Visual backend: comfy (${this.reason})`);
        return this;
      }

      if (this.config.backend === 'comfy') {
        await this.comfy.close();
        this.comfy = null;
        throw new Error(
          `VIDEO_FORGE_BACKEND=comfy but ComfyUI is unreachable at ${this.config.comfyUrl}.\n` +
            `${health.detail?.error ?? ''}\n` +
            'Start ComfyUI, point COMFYUI_URL at a remote or tunnelled instance, ' +
            'or set VIDEO_FORGE_BACKEND=mock.',
        );
      }

      await this.comfy.close();
      this.comfy = null;
    }

    this.backend = 'mock';
    this.reason =
      this.ltxUnreachable ?? `ComfyUI unreachable at ${this.config.comfyUrl}`;
    this.logger?.warn?.(
      `Visual backend: mock (${this.reason}). Rendering placeholder footage; ` +
        'start ComfyUI, run `npm run setup:ltx` for local LTX-Video, ' +
        'or set COMFYUI_URL for real diffusion.',
    );
    return this;
  }

  /**
   * Probe the LTX-Video MCP server. Returns true when it can render.
   *
   * `required` separates required LTX renders from auto-mode probing where a
   * different backend can still render without references.
   */
  async initLtx(required) {
    this.ltx = new LtxClient(this.config, { logger: this.logger });
    const health = await this.ltx.health();

    if (health.ok) {
      this.backend = 'ltx';
      const detail = health.detail ?? {};
      this.reason =
        `LTX-Video ${detail.version ?? '?'} on ${detail.device ?? '?'}` +
        (detail.vramGb ? ` (${detail.vramGb} GB VRAM)` : '');
      this.logger?.ok?.(`Visual backend: ltx (${this.reason})`);
      return true;
    }

    await this.ltx.close().catch(() => {});
    this.ltx = null;

    const detail = health.detail ?? {};
    const error = detail.error ?? 'unknown error';
    this.ltxUnreachable = `LTX-Video unavailable (${firstLine(error)})`;
    const requirement = this.references.length > 0
      ? 'Reference-conditioned rendering requires a ready LTX-Video backend.'
      : 'VIDEO_FORGE_BACKEND=ltx but LTX-Video is not ready.';
    this.ltxError = new Error(
      `${requirement}\n${error}\n` +
        'Run `npm run setup:ltx` to install it, then `npm run doctor` to verify.',
    );

    if (required) this.logger?.error?.(`LTX-Video backend unavailable: ${firstLine(error)}`);
    else this.logger?.debug?.(`ltx: unavailable (${firstLine(error)})`);
    return false;
  }

  /**
   * Render one keyframe image.
   *
   * Returns `{path, cached, seed}`, or null when the backend is not ComfyUI.
   * Identical inputs (prompt, sampler settings, seed) always produce the same
   * picture, so they also form the cache key; a hit skips diffusion entirely.
   */
  async renderStill({ scene, index, outDir, width, height }) {
    if (this.backend !== 'comfy') return null;

    const prompt = this.look ? `${scene.imagePrompt}. ${this.look}` : scene.imagePrompt;
    const seed = this.seedFor(scene, index);
    const key = cacheKey([
      'vf-still-v1',
      prompt,
      this.negative,
      width,
      height,
      this.steps,
      this.cfg,
      seed,
    ]);

    if (this.config.cache) {
      const hit = readCacheEntry({ cacheDir: this.config.cacheDir, key });
      if (hit) {
        this.cache.hits += 1;
        this.logger?.debug?.(`scene ${index}: keyframe served from cache`);
        return { path: hit, cached: true, seed };
      }
    }

    this.logger?.debug?.(`scene ${index}: requesting keyframe`);

    const { promptId } = await this.comfy.renderImage({
      prompt,
      negativePrompt: this.negative,
      width,
      height,
      steps: this.steps,
      cfg: this.cfg,
      seed,
      filenamePrefix: `video-forge/scene${String(index).padStart(2, '0')}`,
    });

    if (!promptId) throw new Error(`ComfyUI did not return a prompt id for scene ${index}.`);

    const { downloaded } = await this.comfy.renderAndFetch(promptId, {
      saveDir: outDir,
      onProgress: (status, elapsed) =>
        this.onProgress?.({ phase: 'still', scene: index, status, elapsed }),
    });

    const image = downloaded.find((f) => f.kind === 'image') ?? downloaded[0];
    if (!image) throw new Error(`ComfyUI produced no image for scene ${index}.`);

    this.cache.misses += 1;
    if (this.config.cache) {
      writeCacheEntry({ source: image.local, cacheDir: this.config.cacheDir, key });
    }
    return { path: image.local, cached: false, seed };
  }

  /**
   * Try to animate a keyframe with a diffusion image-to-video model.
   * Returns null when unavailable, letting the caller fall back to Ken Burns.
   */
  async renderMotion({ scene, index, still, outDir }) {
    if (this.backend !== 'comfy' || !still) return null;
    if (!wantsDiffusionMotion(scene.motion)) return null;

    const { width, height } = this.config.render;

    try {
      const { promptId } = await this.comfy.renderVideo({
        image: path.basename(still),
        prompt: scene.videoPrompt || scene.imagePrompt,
        seconds: scene.seconds ?? 4,
        resolution: `${width}x${height}`,
        fps: this.config.fps,
        filenamePrefix: `video-forge/motion${String(index).padStart(2, '0')}`,
      });
      if (!promptId) return null;

      const { downloaded } = await this.comfy.renderAndFetch(promptId, {
        saveDir: outDir,
        onProgress: (status, elapsed) =>
          this.onProgress?.({ phase: 'video', scene: index, status, elapsed }),
      });

      const video =
        downloaded.find((f) => f.kind === 'video') ??
        downloaded.find((f) => /\.(mp4|webm|mkv|mov)$/i.test(f.local ?? ''));
      if (!video) return null;

      const info = await probe(video.local, this.config.ffprobe);
      if (!info?.hasVideo) return null;
      return video.local;
    } catch (error) {
      this.logger?.warn?.(
        `scene ${index}: image-to-video unavailable (${firstLine(error.message)}); ` +
          'using Ken Burns motion.',
      );
      return null;
    }
  }

  /**
   * Render one scene end-to-end.
   *
   * The ladder, most desirable first:
   *   1. LTX-Video diffusion clip     (native video diffusion, real motion)
   *   2. diffusion keyframe -> diffusion image-to-video  (ComfyUI)
   *   3. diffusion keyframe -> Ken Burns push            (no video model needed)
   *   4. ffmpeg placeholder                              (no renderer at all)
   *
   * Returns an un-normalised motion clip plus the keyframe that produced it,
   * the resolved motion preset, the deterministic seed and whether the
   * keyframe came from the cache; audio, timing and resolution normalisation
   * happen in the assembler.
   *
   * @returns {Promise<{still: string|null, clip: string, method: string, backend: string, motion: string, seed: number|null, cached: boolean}>}
   */
  async renderScene({ scene, index, outDir, width, height, fps }) {
    const { width: renderWidth, height: renderHeight } = this.config.render;
    const tag = String(index).padStart(2, '0');
    const targetStill = path.join(outDir, `scene${tag}_still.png`);
    const rawClip = path.join(outDir, `scene${tag}_raw.mp4`);

    // 0. LTX-Video: a real video diffusion render, in one shot. -----------------
    if (this.backend === 'ltx') {
      const sceneReferences = this.referencesForScene(scene, index);
      try {
        const rendered = await this.renderLtxScene({ scene, index, outDir, fps });
        if (rendered?.clip && fs.existsSync(rendered.clip)) {
          fs.copyFileSync(rendered.clip, rawClip);
          return {
            still: rendered.still,
            clip: rawClip,
            method: 'ltx-video',
            backend: 'ltx',
            motion: 'video',
            seed: rendered.seed,
            cached: false,
            model: rendered.model,
            references: rendered.references,
            renderSeconds: rendered.renderSeconds,
          };
        }
        if (sceneReferences.length > 0) {
          throw new Error('LTX-Video did not return a video for a reference-conditioned scene.');
        }
      } catch (error) {
        if (sceneReferences.length > 0) {
          throw new Error(
            `scene ${index}: reference-conditioned LTX-Video render failed: ${firstLine(error.message)}`,
            { cause: error },
          );
        }
        this.logger?.warn?.(
          `scene ${index}: LTX-Video render failed (${firstLine(error.message)}); ` +
            'falling back to placeholder footage.',
        );
      }
      return this.renderPlaceholder({ scene, index, outDir, rawClip, fps, renderWidth, renderHeight });
    }

    let still = null;
    let cached = false;
    let seed = null;

    // 1. Keyframe (diffusion, cache-aware) ------------------------------------
    if (this.backend === 'comfy') {
      try {
        const rendered = await this.renderStill({
          scene,
          index,
          outDir,
          width: renderWidth,
          height: renderHeight,
        });
        if (rendered?.path && fs.existsSync(rendered.path)) {
          fs.copyFileSync(rendered.path, targetStill);
          still = targetStill;
          cached = rendered.cached;
          seed = rendered.seed;
        }
      } catch (error) {
        this.logger?.warn?.(
          `scene ${index}: keyframe failed (${firstLine(error.message)}); ` +
            'falling back to placeholder footage.',
        );
      }
    }

    // 2. Motion ---------------------------------------------------------------
    if (still) {
      const motion = await this.renderMotion({ scene, index, still, outDir });
      if (motion) {
        fs.copyFileSync(motion, rawClip);
        return {
          still,
          clip: rawClip,
          method: 'diffusion-video',
          backend: this.backend,
          motion: 'video',
          seed,
          cached,
        };
      }

      // Ken Burns is always available once we have a picture, and it reads as
      // intentional camera movement rather than a broken render. The preset is
      // resolved deterministically (`auto` cycles by scene index) and compiled
      // into an exact, frame-counted filter chain.
      const preset = resolveMotion(scene.motion, index);
      const clipSeconds = scene.seconds ?? 4;
      const frames = Math.max(2, Math.round(clipSeconds * fps));
      await stillToVideo({
        image: still,
        output: rawClip,
        width: renderWidth,
        height: renderHeight,
        fps,
        seconds: clipSeconds,
        filter: zoompanFilter({ motion: preset, width: renderWidth, height: renderHeight, frames, fps }),
        ffmpeg: this.config.ffmpeg,
      });
      return {
        still,
        clip: rawClip,
        method: 'ken-burns',
        backend: this.backend,
        motion: preset,
        seed,
        cached,
      };
    }

    // 3. Placeholder ----------------------------------------------------------
    return this.renderPlaceholder({ scene, index, rawClip, fps, renderWidth, renderHeight });
  }

  /**
   * Render a scene with LTX-Video.
   *
   * Unlike the ComfyUI ladder there is no separate keyframe step: LTX-Video is a
   * *video* model, so one call produces the moving shot directly. The frame count
   * is derived from the narration timing so the clip lines up with the timeline,
   * then snapped to the model's `N * 8 + 1` lattice.
   *
   * References are attached per scene. A reference the storyboard tagged for this
   * scene conditions it; run-wide uploads condition the first or every scene,
   * according to the selected reference scope.
   *
   * @returns {Promise<{clip: string, still: string|null, seed: number|null, model: string, references: object[], renderSeconds: number}>}
   */
  async renderLtxScene({ scene, index, outDir, fps }) {
    const seed = this.seedFor(scene, index);
    const clipSeconds = Math.max(1, Number(scene.seconds) || 5);
    const numFrames = alignFrames(clipSeconds * fps);

    // Resolution: what the model should actually draw. 'bin' mode snaps to a
    // training aspect ratio, which produces noticeably better pictures off-spec.
    const target = resolveLtxResolution({
      width: this.config.render.width,
      height: this.config.render.height,
      mode: this.config.ltx.resolutionMode,
    });

    const sceneReferences = this.referencesForScene(scene, index);
    const prompt = this.look ? `${scene.videoPrompt}. ${this.look}` : scene.videoPrompt;

    this.logger?.debug?.(
      `scene ${index}: LTX-Video ${target.width}x${target.height}x${numFrames} ` +
        `seed ${seed}${sceneReferences.length ? `, ${sceneReferences.length} reference(s)` : ''}`,
    );

    const result = await this.ltx.generate({
      prompt,
      negativePrompt: this.negative,
      outputPath: outDir,
      model: this.config.ltx.model,
      height: target.height,
      width: target.width,
      numFrames,
      frameRate: Math.round(fps),
      seed,
      precision: this.config.ltx.precision,
      sampler: this.config.ltx.sampler,
      stgMode: this.config.ltx.stgMode,
      enhancePrompt: this.config.ltx.enhancePrompt,
      offloadToCpu: this.config.ltx.offloadToCpu,
      imageCondNoiseScale: this.config.ltx.imageCondNoiseScale,
      references: sceneReferences,
    });

    const clip = result.path;
    if (!clip || !fs.existsSync(clip)) {
      throw new Error(`LTX-Video reported ${clip ?? 'no path'} but no file exists there.`);
    }

    const info = await probe(clip, this.config.ffprobe);
    if (!info?.hasVideo) {
      throw new Error(`LTX-Video wrote ${clip}, but ffprobe found no video stream in it.`);
    }

    // A representative still keeps the thumbnail pipeline working unchanged.
    let still = null;
    try {
      still = await extractFrame({
        input: clip,
        output: path.join(outDir, `scene${String(index).padStart(2, '0')}_still.png`),
        at: 0,
        ffmpeg: this.config.ffmpeg,
      });
    } catch {
      /* a missing still must never fail a successful render */
    }

    return {
      clip,
      still,
      seed,
      model: result.model,
      references: result.conditioning ?? [],
      renderSeconds: result.renderSeconds ?? null,
    };
  }

  /**
   * Which references condition a given scene.
   *
   * A scene's own `reference`/`references` win outright. Otherwise the run-wide
   * uploads condition the first scene, or every scene when `referenceScope` is
   * `all`.
   */
  referencesForScene(scene, index) {
    const own = Array.isArray(scene?.references)
      ? scene.references
      : scene?.reference
        ? [scene.reference]
        : [];
    if (own.length > 0) return own;
    return this.referenceScope === 'all' || index === 1 ? this.references : [];
  }

  /** Offline placeholder footage - the last rung of the degradation ladder. */
  async renderPlaceholder({ scene, index, rawClip, fps, renderWidth, renderHeight }) {
    await placeholderShot({
      output: rawClip,
      width: renderWidth,
      height: renderHeight,
      fps,
      seconds: scene.seconds ?? 5,
      index,
      label: scene.title || scene.narration.slice(0, 60),
      ffmpeg: this.config.ffmpeg,
    });
    return {
      still: null,
      clip: rawClip,
      method: 'placeholder',
      backend: this.backend,
      motion: 'placeholder',
      seed: null,
      cached: false,
    };
  }

  async close() {
    await this.comfy?.close();
    await this.ltx?.close();
    this.comfy = null;
    this.ltx = null;
  }
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0].slice(0, 200);
}

export default VisualRenderer;