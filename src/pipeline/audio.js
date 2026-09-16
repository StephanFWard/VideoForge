/**
 * Narration: one Kokoro MCP call per scene.
 *
 * Each scene gets its own audio file so that scene duration can be driven by
 * how long the spoken line actually takes, rather than a guessed number.
 */
import path from 'node:path';
import { ensureDir, existsSync, sizeOf } from '../util/fs.js';
import { probe } from '../util/ffmpeg.js';

export const AUDIO_FORMAT = 'wav';

const pad = (n) => String(n).padStart(2, '0');

/**
 * Synthesize narration for every scene.
 *
 * @param {object} req { storyboard, kokoro, outDir, config, logger }
 * @returns {Promise<Array<{scene:number, path:string, duration:number, voice:string}>>}
 */
export async function narrateScenes({ storyboard, kokoro, outDir, config, logger = null }) {
  const audioDir = ensureDir(path.join(outDir, 'audio'));
  const results = [];

  for (const [index, scene] of storyboard.scenes.entries()) {
    const sceneNumber = index + 1;
    const outputPath = path.join(audioDir, `scene${pad(sceneNumber)}.${AUDIO_FORMAT}`);

    logger?.step?.(
      `Narration ${sceneNumber}/${storyboard.scenes.length}: "${truncate(scene.narration, 56)}"`,
    );

    const speech = await kokoro.speak({
      text: scene.narration,
      outputPath,
      voice: storyboard.voice,
      speed: storyboard.speed,
      lang: storyboard.lang,
      format: AUDIO_FORMAT,
    });

    if (!existsSync(speech.path)) {
      throw new Error(`Kokoro reported ${speech.path} but no file was written.`);
    }
    const bytes = await sizeOf(speech.path);
    if (bytes < 1000) {
      throw new Error(`Kokoro wrote only ${bytes} bytes to ${speech.path}; that is not audio.`);
    }

    // Trust ffprobe over the server's own duration claim where they disagree.
    const info = await probe(speech.path, config.ffprobe);
    const duration = info?.duration ?? speech.durationSeconds ?? 0;
    if (!duration || duration <= 0) {
      throw new Error(`Could not determine the duration of ${speech.path}.`);
    }

    results.push({
      scene: sceneNumber,
      path: speech.path,
      duration,
      voice: speech.voice,
      bytes,
    });
  }

  return results;
}

function truncate(text, max) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export default { narrateScenes, AUDIO_FORMAT };
