/**
 * Assembly: cut each scene to its narration, join them, then deliver at the
 * requested resolution.
 *
 * Every scene is normalised to one canonical format before concatenation
 * (same size, fps, SAR, pix_fmt, audio layout). That is what makes the final
 * join a stream copy instead of a second full re-encode - unless the timeline
 * asked for crossfades, in which case the join is a single xfade/acrossfade
 * pass whose offsets are the timeline's own frame positions.
 *
 * Each segment is cut to the exact frame count from the timeline
 * (`durationInFrames / fps` seconds), which is what keeps the final duration
 * identical to the metadata the manifest reports.
 */
import path from 'node:path';
import { ensureDir } from '../util/fs.js';
import {
  concatVideos,
  crossfadeVideos,
  extractFrame,
  normalizeScene,
  probe,
  upscaleVideo,
} from '../util/ffmpeg.js';
import { crossfades } from './timeline.js';
import { writeCaptions } from './captions.js';
import { burnSubtitles } from '../util/ffmpeg.js';

const pad = (n) => String(n).padStart(2, '0');

/**
 * @param {object} req
 * @param {object} req.storyboard  Normalised storyboard.
 * @param {Array} req.scenes       Per-scene {scene, clip, still, audio, duration, method, motion}.
 * @param {object} [req.timeline]  Frame-exact timeline from buildTimeline().
 * @param {object} req.config      VideoForge config.
 * @param {string} req.outDir      Run directory.
 * @param {string} req.name        Base filename for outputs.
 * @param {object} [req.logger]
 * @param {Function} [req.onEvent]
 */
export async function assembleVideo({
  storyboard,
  scenes,
  timeline = null,
  config,
  outDir,
  name,
  logger = null,
  onEvent = null,
}) {
  const segmentsDir = ensureDir(path.join(outDir, 'segments'));
  const { width, height } = config.intermediate;
  const total = scenes.length;
  const cut = [];
  const fadeSeconds = Math.max(0, Number(config.transitionSeconds) || 0);

  for (const [index, scene] of scenes.entries()) {
    const target = path.join(segmentsDir, `seg${pad(scene.scene)}.mp4`);
    const entry = timeline?.scenes?.[index] ?? null;
    const next = timeline?.scenes?.[index + 1] ?? null;

    // 'fade' bakes a dip-to-black into the segment itself: the boundary never
    // moves, and the join still needs no re-encode. Clamped to half the scene
    // so a fade can never swallow it whole.
    const sceneSeconds = entry?.durationSeconds ?? scene.duration;
    const fadeInSeconds = entry?.transition === 'fade' ? Math.min(fadeSeconds, sceneSeconds / 2) : 0;
    const fadeOutSeconds = next?.transition === 'fade' ? Math.min(fadeSeconds, sceneSeconds / 2) : 0;

    logger?.step?.(
      `Cutting scene ${scene.scene}/${total} (${scene.method}${scene.motion ? ` · ${scene.motion}` : ''}) ` +
        `at ${width}x${height} · ` +
        (entry ? `${entry.durationInFrames} frames from ${entry.from}` : `${scene.duration.toFixed(1)}s narration`),
    );

    await normalizeScene({
      input: scene.clip,
      audio: scene.audio,
      output: target,
      width,
      height,
      fps: config.fps,
      duration: scene.duration,
      seconds: entry?.durationSeconds ?? null,
      padSeconds: config.padSeconds,
      fadeInSeconds,
      fadeOutSeconds,
      ffmpeg: config.ffmpeg,
    });

    const info = await probe(target, config.ffprobe);
    cut.push({
      ...scene,
      segment: target,
      segmentDuration: info?.duration ?? null,
      frames: entry?.durationInFrames ?? null,
      from: entry?.from ?? null,
    });
    onEvent?.({ type: 'segment', scene: scene.scene, total, segment: target });
  }

  const masterPath = path.join(outDir, `${name}_master.mp4`);
  if (timeline?.mode === 'xfade') {
    const joins = crossfades(timeline);
    logger?.step?.(`Joining ${cut.length} scenes with ${joins.length} crossfade(s)`);
    await crossfadeVideos({
      inputs: cut.map((s) => s.segment),
      output: masterPath,
      transitions: joins,
      fps: timeline.fps,
      ffmpeg: config.ffmpeg,
    });
  } else {
    logger?.step?.(`Joining ${cut.length} scenes`);
    await concatVideos({
      inputs: cut.map((s) => s.segment),
      output: masterPath,
      ffmpeg: config.ffmpeg,
    });
  }

  const { width: dw, height: dh } = config.delivery;
  const finalPath = path.join(outDir, `${name}.mp4`);
  logger?.step?.(`Delivering ${config.resolution} master at ${dw}x${dh}`);

  // A 4K delivery is a genuine super-resolution pass over the intermediate cut.
  await upscaleVideo({
    input: masterPath,
    output: finalPath,
    width: dw,
    height: dh,
    fps: config.fps,
    ffmpeg: config.ffmpeg,
  });

  // Remotion renders captions as components; here they are an SRT sidecar
  // written from the timeline's own frame positions, plus an optional
  // burned-in pass (VIDEO_FORGE_CAPTIONS=burn).
  let captions = null;
  try {
    captions = writeCaptions({
      outDir,
      name,
      scenes: storyboard.scenes.map((scene, index) => ({
        narration: scene.narration,
        title: scene.title,
        scene: scene.id ?? index + 1,
      })),
      timeline,
      config,
      maxChars: config.captions?.maxChars ?? 72,
    });
    if (captions) logger?.info?.(`Captions: ${captions}`);
  } catch (error) {
    logger?.debug?.(`caption sidecar skipped: ${error.message}`);
  }

  let captionedPath = null;
  if (captions && config.captions?.mode === 'burn') {
    try {
      captionedPath = path.join(outDir, `${name}_captioned.mp4`);
      await burnSubtitles({
        input: finalPath,
        subtitles: captions,
        output: captionedPath,
        ffmpeg: config.ffmpeg,
      });
      logger?.info?.(`Burned-in captions: ${captionedPath}`);
    } catch (error) {
      logger?.warn?.(`burned-in captions skipped: ${String(error.message).split('\n')[0]}`);
      captionedPath = null;
    }
  }

  let thumbnail = null;
  try {
    thumbnail = await extractFrame({
      input: finalPath,
      output: path.join(outDir, `${name}_thumb.jpg`),
      at: Math.min(1, (await probe(finalPath, config.ffprobe))?.duration ?? 1),
      ffmpeg: config.ffmpeg,
    });
  } catch (error) {
    logger?.debug?.(`thumbnail generation skipped: ${error.message}`);
  }

  const video = await probe(finalPath, config.ffprobe);
  onEvent?.({ type: 'assembled', master: masterPath, output: finalPath });

  return { masterPath, finalPath, captionedPath, captions, thumbnail, segments: cut, video, timeline };
}

export default { assembleVideo };
