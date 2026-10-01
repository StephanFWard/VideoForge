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
 *
 * `filter` lets the caller supply a frame-exact chain compiled from a motion
 * preset (`src/pipeline/motion.js`); the default reproduces the original slow
 * centre push so existing callers keep working unchanged.
 */
export async function stillToVideo({
  image,
  output,
  width,
  height,
  fps = 30,
  seconds = 4,
  zoom = 0.0009,
  filter = null,
  ffmpeg = 'ffmpeg',
}) {
  ensureDir(path.dirname(output));
  const frames = Math.max(2, Math.round(seconds * fps));
  // Oversample first so the zoom stays sharp rather than pixelated.
  const vf =
    filter ??
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
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-pix_fmt', 'yuv420p',
      output,
    ],
    { timeoutMs: 20 * 60 * 1000 },
  );
  return output;
}

/**
 * Shared filter for the offline placeholder renderer: deterministic colour per
 * scene index plus the scene label, so mock renders are honest about which
 * scene is on screen. testsrc2 provides real motion for the video variant.
 */
function placeholderFilter({ width, height, fps, seconds, index, label }) {
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
  return [
    `testsrc2=size=${width}x${height}:rate=${fps}:duration=${seconds}`,
    `hue=h=${hue}:s=0.6`,
    'format=yuv420p',
    ...drawText,
  ].join(',');
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
  const filter = placeholderFilter({ width, height, fps, seconds, index, label });

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
 * A single deterministic placeholder frame - the mock backend's answer to
 * `video-forge still`, so a keyframe can be previewed without a GPU.
 */
export async function placeholderStill({
  output,
  width,
  height,
  index = 0,
  label = '',
  ffmpeg = 'ffmpeg',
}) {
  ensureDir(path.dirname(output));
  const filter = placeholderFilter({ width, height, fps: 2, seconds: 1, index, label });

  await run(
    ffmpeg,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', filter,
      '-frames:v', '1',
      output,
    ],
    { timeoutMs: 5 * 60 * 1000 },
  );
  return output;
}

/**
 * Force a clip into the project's canonical format: exact resolution, fps,
 * SAR 1:1, yuv420p, optional narration, fades, and an exact duration.
 * Canonicalising every scene is what makes the concat/crossfade step safe.
 *
 * `seconds` is the frame-exact length taken from the timeline
 * (`durationInFrames / fps`). When it is absent the legacy behaviour applies:
 * narration duration plus `padSeconds`.
 *
 * `fadeInSeconds` / `fadeOutSeconds` bake a dip-to-black transition into the
 * segment itself (the 'fade' transition), which is why it costs nothing at
 * join time.
 */
export async function normalizeScene({
  input,
  audio,
  output,
  width,
  height,
  fps = 30,
  duration,
  seconds,
  padSeconds = 0.6,
  fadeInSeconds = 0,
  fadeOutSeconds = 0,
  ffmpeg = 'ffmpeg',
}) {
  ensureDir(path.dirname(output));
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input];
  if (audio) args.push('-i', audio);

  const target = Math.max(
    0.5,
    Number.isFinite(Number(seconds)) && Number(seconds) > 0
      ? Number(seconds)
      : Number(duration ?? 0) + padSeconds,
  );

  const fadeIn = Math.max(0, Math.min(Number(fadeInSeconds) || 0, target / 2));
  const fadeOut = Math.max(0, Math.min(Number(fadeOutSeconds) || 0, target / 2));

  // `tpad` holds the final frame if the clip is shorter than the narration,
  // so speech is never cut off mid-word.
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
    'setsar=1',
    `fps=${fps}`,
    `tpad=stop_mode=clone:stop_duration=${padSeconds}`,
    ...(fadeIn > 0 ? [`fade=t=in:st=0:d=${fadeIn.toFixed(3)}`] : []),
    ...(fadeOut > 0 ? [`fade=t=out:st=${Math.max(0, target - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`] : []),
    'format=yuv420p',
  ].join(',');

  // Silent rows get a synthetic silent track so every segment carries the
  // same stream layout and concatenation stays trivial.
  if (!audio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }

  const af = [
    ...(audio ? ['apad'] : []),
    ...(fadeIn > 0 ? [`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`] : []),
    ...(fadeOut > 0 ? [`afade=t=out:st=${Math.max(0, target - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`] : []),
  ];

  args.push(
    '-map', '0:v:0',
    '-map', '1:a:0',
    ...(af.length ? ['-af', af.join(',')] : []),
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

/**
 * Join segments with real, overlapping crossfades (xfade + acrossfade).
 *
 * This is the join Remotion's transitions produce: scene N+1 starts `duration`
 * seconds before scene N ends, at the exact frame offset the timeline computed,
 * so the final duration is the sum of the scenes minus every overlap. Segments
 * must already be canonical (same size, fps, SAR, pix_fmt, audio layout), which
 * `normalizeScene` guarantees.
 *
 * @param {object} req
 * @param {string[]} req.inputs      Canonical segments, in order.
 * @param {string}   req.output      Destination file.
 * @param {Array<{offsetSeconds:number, durationSeconds:number}>} req.transitions
 *        One entry per join (inputs.length - 1), in order.
 * @param {number}   [req.fps]
 * @param {string}   [req.ffmpeg]
 */
export async function crossfadeVideos({ inputs, output, transitions, fps = 30, ffmpeg = 'ffmpeg' }) {
  ensureDir(path.dirname(output));
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('crossfadeVideos needs at least one input.');
  }
  if (inputs.length === 1) {
    await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputs[0], '-c', 'copy', output], {
      timeoutMs: 30 * 60 * 1000,
    });
    return output;
  }

  const joins = transitions ?? [];
  if (joins.length !== inputs.length - 1) {
    throw new Error(
      `crossfadeVideos needs ${inputs.length - 1} transition(s); got ${joins.length}.`,
    );
  }

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const input of inputs) args.push('-i', input);

  const filters = [];
  let lastVideo = '[0:v]';
  let lastAudio = '[0:a]';
  joins.forEach((join, index) => {
    const next = index + 1;
    const duration = Math.max(1 / fps, Number(join.durationSeconds) || 1 / fps);
    const offset = Math.max(0, Number(join.offsetSeconds) || 0);
    const videoOut = `[v${next}]`;
    const audioOut = `[a${next}]`;
    filters.push(
      `${lastVideo}[${next}:v]xfade=transition=fade:duration=${duration.toFixed(3)}:` +
        `offset=${offset.toFixed(3)}${videoOut}`,
    );
    filters.push(
      `${lastAudio}[${next}:a]acrossfade=d=${duration.toFixed(3)}:c1=tri:c2=tri${audioOut}`,
    );
    lastVideo = videoOut;
    lastAudio = audioOut;
  });

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', lastVideo,
    '-map', lastAudio,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    output,
  );

  await run(ffmpeg, args, { timeoutMs: 60 * 60 * 1000 });
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

/** Render SRT captions into the picture (opt-in `burn` mode). */
export async function burnSubtitles({ input, subtitles, output, ffmpeg = 'ffmpeg' }) {
  ensureDir(path.dirname(output));
  // The subtitles filter wants forward slashes; on Windows the drive colon
  // must be escaped the same way drawtext paths are.
  const escaped = filterPath(path.resolve(subtitles)).replace(/'/g, '');
  await run(
    ffmpeg,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-vf', `subtitles='${escaped}'`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
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
  placeholderStill,
  normalizeScene,
  concatVideos,
  crossfadeVideos,
  upscaleVideo,
  burnSubtitles,
  extractFrame,
  findFont,
  filterPath,
};

/** ffmpeg needs forward slashes and escaped colons inside filter graphs. */
export function filterPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:');
}
