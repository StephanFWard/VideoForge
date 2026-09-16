/**
 * ffmpeg / ffprobe helpers.
 *
 * Everything video-shaped that VideoForge does locally lives here:
 * probing, turning a still into motion (Ken Burns), normalising every scene to
 * one common format, concatenating, mixing narration, and the final 4K pass.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fs.js';

/** Run a binary and resolve with captured output. Rejects with a rich error. */
export function run(bin, args, { cwd, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true, env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `${bin} was not found on PATH. Install ffmpeg (https://ffmpeg.org/download.html) ` +
              `or set FFMPEG_PATH / FFPROBE_PATH.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`${bin} exited with code ${code}\n${stderr.slice(-4000)}`);
        err.code = code;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

/** True when ffmpeg + ffprobe are runnable. */
export async function ffmpegAvailable(ffmpeg = 'ffmpeg', ffprobe = 'ffprobe') {
  try {
    await run(ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 15000 });
    await run(ffprobe, ['-hide_banner', '-version'], { timeoutMs: 15000 });
    return true;
  } catch {
    return false;
  }
}

function evalRate(rate) {
  const [num, den] = String(rate).split('/').map(Number);
  if (!den) return num || null;
  return num / den;
}

/** Probe a media file. Returns null when the file does not exist. */
export async function probe(file, ffprobe = 'ffprobe') {
  if (!fs.existsSync(file)) return null;
  const { stdout } = await run(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeoutMs: 60000 },
  );
  const json = JSON.parse(stdout);
  const video = json.streams?.find((s) => s.codec_type === 'video');
  const audio = json.streams?.find((s) => s.codec_type === 'audio');
  return {
    duration: Number(json.format?.duration ?? 0),
    size: Number(json.format?.size ?? 0),
    width: video ? Number(video.width) : null,
    height: video ? Number(video.height) : null,
    fps: video?.r_frame_rate ? evalRate(video.r_frame_rate) : null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}

/** Local font used for the (optional) mock-renderer caption. */
export function findFont() {
  const candidates = [
    'C:/Windows/Fonts/arial.ttf',
    'C:/Windows/Fonts/segoeui.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];
  return candidates.find((f) => fs.existsSync(f)) ?? null;
}

/**
 * Turn a single still image into a moving shot (Ken Burns).
 * Used as the guaranteed-available motion fallback when a diffusion
 * image-to-video model is not installed.
 */
export async function stillToVideo({
  image,
  output,
  width,
  height,
  fps = 30,
  seconds = 4,
  zoom = 0.0009,
  ffmpeg = 'ffmpeg',
}) {
  ensureDir(path.dirname(output));
  const frames = Math.max(2, Math.round(seconds * fps));
  // Oversample first so the zoom stays sharp rather than pixelated.
  const filter =
    `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,` +
    `crop=${width * 2}:${height * 2},` +
    `zoompan=z='min(zoom+${zoom},1.35)':d=${frames}` +
    `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps},` +
    `format=yuv420p`;

  await run(
    ffmpeg,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-loop', '1', '-i', image,
      '-t', String(seconds),
      '-vf', filter,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-pix_fmt', 'yuv420p',
      output,
    ],
    { timeoutMs: 20 * 60 * 1000 },
  );
  return output;
}

/**
 * The offline placeholder renderer used by the `mock` backend and by tests.
 * Deterministic: the same scene index always produces the same clip.
 */
export async function placeholderShot({
  output,
  width,
  height,
  fps = 30,
  seconds = 4,
  index = 0,
  label = '',
  ffmpeg = 'ffmpeg',
}) {
  ensureDir(path.dirname(output));
  const hue = (index * 47) % 360;
  const drawText = [];
  const font = findFont();
  if (label && font) {
    const safe = String(label)
      .replace(/[\\]/g, '')
      .replace(/:/g, '\\:')
      .replace(/'/g, '')
      .replace(/\r?\n/g, ' ');
    drawText.push(
      `drawtext=fontfile='${filterPath(font)}':text='${safe}':fontcolor=white@0.92:` +
        `fontsize=h/12:box=1:boxcolor=black@0.45:boxborderw=18:x=(w-text_w)/2:y=h-text_h-60`,
    );
  }
  // testsrc2 gives real motion so concat/duration maths are exercised honestly.
  const filter = [
    `testsrc2=size=${width}x${height}:rate=${fps}:duration=${seconds}`,
    `hue=h=${hue}:s=0.6`,
    'format=yuv420p',
    ...drawText,
  ].join(',');

  await run(
    ffmpeg,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', filter,
      '-t', String(seconds),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      output,
    ],
    { timeoutMs: 10 * 60 * 1000 },
  );
  return output;
}

/**
 * Force a clip into the project's canonical format: exact resolution, fps,
 * SAR 1:1, yuv420p, optional narration, and an exact duration.
 * Canonicalising every scene is what makes the concat step safe.
 */
export async function normalizeScene({
  input,
  audio,
  output,
  width,
  height,
  fps = 30,
  duration,
  padSeconds = 0.6,
  ffmpeg = 'ffmpeg',
}) {
  ensureDir(path.dirname(output));
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input];
  if (audio) args.push('-i', audio);

  const target = Math.max(0.5, Number(duration ?? 0) + padSeconds);

  // `tpad` holds the final frame if the clip is shorter than the narration,
  // so speech is never cut off mid-word.
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
    'setsar=1',
    `fps=${fps}`,
    `tpad=stop_mode=clone:stop_duration=${padSeconds}`,
    'format=yuv420p',
  ].join(',');

  // Silent rows get a synthetic silent track so every segment carries the
  // same stream layout and concatenation stays trivial.
  if (!audio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }

  args.push(
    '-map', '0:v:0',
    '-map', '1:a:0',
    ...(audio ? ['-af', 'apad'] : []),
    '-vf', vf,
    '-t', String(target),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k',
    ...(audio ? ['-ar', '48000', '-ac', '2'] : []),
    '-movflags', '+faststart',
    '-shortest',
    output,
  );

  await run(ffmpeg, args, { timeoutMs: 30 * 60 * 1000 });
  return output;
}

/** Concatenate identically-encoded segments using the concat demuxer. */
export async function concatVideos({ inputs, output, listFile, ffmpeg = 'ffmpeg' }) {
  ensureDir(path.dirname(output));
  const list = listFile ?? path.join(path.dirname(output), 'concat.txt');
  const body = inputs
    .map((f) => `file '${path.resolve(f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(list, `${body}\n`, 'utf8');

  await run(
    ffmpeg,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-c', 'copy', '-movflags', '+faststart',
      output,
    ],
    { timeoutMs: 30 * 60 * 1000 },
  );
  return output;
}

/** Final super-resolution pass: lanczos resize to the delivery resolution. */
export async function upscaleVideo({
  input,
  output,
  width,
  height,
  fps = 30,
  crf = 16,
  preset = 'slow',
  ffmpeg = 'ffmpeg',
}) {
  ensureDir(path.dirname(output));
  const filter =
    `scale=${width}:${height}:flags=lanczos:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps},format=yuv420p`;
  await run(
    ffmpeg,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-vf', filter,
      '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
      '-c:a', 'copy',
      '-movflags', '+faststart',
      output,
    ],
    { timeoutMs: 60 * 60 * 1000 },
  );
  return output;
}

/** Extract a representative still (thumbnails, and 4K frame upscaling). */
export async function extractFrame({ input, output, at = 0, ffmpeg = 'ffmpeg' }) {
  ensureDir(path.dirname(output));
  await run(
    ffmpeg,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(at), '-i', input, '-frames:v', '1',
      output,
    ],
    { timeoutMs: 5 * 60 * 1000 },
  );
  return output;
}

export default {
  run,
  ffmpegAvailable,
  probe,
  stillToVideo,
  placeholderShot,
  normalizeScene,
  concatVideos,
  upscaleVideo,
  extractFrame,
  findFont,
  filterPath,
};

/** ffmpeg needs forward slashes and escaped colons inside filter graphs. */
export function filterPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:');
}
