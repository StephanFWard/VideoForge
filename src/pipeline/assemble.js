/**
 * Assembly: cut each scene to its narration, join them, then deliver at the
 * requested resolution.
 *
 * Every scene is normalised to one canonical format before concatenation
 * (same size, fps, SAR, pix_fmt, audio layout). That is what makes the final
 * join a stream copy instead of a second full re-encode.
 */
import path from 'node:path';
import { ensureDir } from '../util/fs.js';
import { concatVideos, extractFrame, normalizeScene, probe, upscaleVideo } from '../util/ffmpeg.js';

const pad = (n) => String(n).padStart(2, '0');

/**
 * @param {object} req
 * @param {object} req.storyboard  Normalised storyboard.
 * @param {Array} req.scenes       Per-scene {scene, clip, still, audio, duration, method}.
 * @param {object} req.config      VideoForge config.
 * @param {string} req.outDir      Run directory.
 * @param {string} req.name        Base filename for outputs.
 * @param {object} [req.logger]
 * @param {Function} [req.onEvent]
 */
export async function assembleVideo({
  storyboard,
  scenes,
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

  for (const scene of scenes) {
    const target = path.join(segmentsDir, `seg${pad(scene.scene)}.mp4`);
    logger?.step?.(
      `Cutting scene ${scene.scene}/${total} (${scene.method}) at ${width}x${height}, ` +
        `${scene.duration.toFixed(1)}s narration`,
    );

    await normalizeScene({
      input: scene.clip,
      audio: scene.audio,
      output: target,
      width,
      height,
      fps: config.fps,
      duration: scene.duration,
      padSeconds: config.padSeconds,
      ffmpeg: config.ffmpeg,
    });

    const info = await probe(target, config.ffprobe);
    cut.push({ ...scene, segment: target, segmentDuration: info?.duration ?? null });
    onEvent?.({ type: 'segment', scene: scene.scene, total, segment: target });
  }

  const masterPath = path.join(outDir, `${name}_master.mp4`);
  logger?.step?.(`Joining ${cut.length} scenes`);
  await concatVideos({
    inputs: cut.map((s) => s.segment),
    output: masterPath,
    ffmpeg: config.ffmpeg,
  });

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

  return { masterPath, finalPath, thumbnail, segments: cut, video };
}

export default { assembleVideo };
