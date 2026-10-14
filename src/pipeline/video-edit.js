import fs from 'node:fs';
import path from 'node:path';
import { ComfyClient } from '../mcp/comfy.js';
import { run } from '../util/ffmpeg.js';
import { ensureDir, slugify } from '../util/fs.js';

export function matteDimensions(width, height, maxSide = 512) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const even = (value) => Math.max(64, Math.round((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

export function buildThemeCompositeArgs({
  source,
  matte,
  background = null,
  foreground = null,
  output,
  width,
  height,
  subjectBounds = { x: 0, y: 0, width, height },
  fps,
  seconds,
  ffmpeg = 'ffmpeg',
}) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', source, '-i', matte];
  let inputIndex = 2;
  let backgroundIndex = null;
  let foregroundIndex = null;
  if (background) {
    backgroundIndex = inputIndex++;
    args.push('-loop', '1', '-framerate', String(fps), '-i', background);
  }
  if (foreground) {
    foregroundIndex = inputIndex;
    args.push('-loop', '1', '-framerate', String(fps), '-i', foreground);
  }

  const sourceSplit = backgroundIndex !== null && foregroundIndex === null;
  const sourceBase = sourceSplit ? 'srcbase' : 'src';
  const sourceFilters = sourceSplit
    ? `fps=${fps},scale=${width}:${height}:flags=lanczos,setsar=1,format=rgba,split=2[srcbase][srcfg]`
    : `fps=${fps},scale=${width}:${height}:flags=lanczos,setsar=1,format=rgba[src]`;
  const filters = [
    `[0:v]${sourceFilters}`,
    `[1:v]fps=${fps},scale=${width}:${height}:flags=bicubic,format=gray[mask]`,
    backgroundIndex === null
      ? '[src]null[base]'
      : `[${backgroundIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height},setsar=1[generatedbg];` +
        `[${sourceBase}][generatedbg]overlay=shortest=1:format=auto[base]`,
  ];

  let subject = 'originalsubject';
  if (foregroundIndex !== null) {
    const bx = Math.max(0, Math.min(width - 1, Math.round(subjectBounds.x)));
    const by = Math.max(0, Math.min(height - 1, Math.round(subjectBounds.y)));
    const bw = Math.max(2, Math.min(width - bx, Math.round(subjectBounds.width)));
    const bh = Math.max(2, Math.min(height - by, Math.round(subjectBounds.height)));
    filters.push(
      `[${foregroundIndex}:v]scale=${bw}:${bh}:force_original_aspect_ratio=decrease,` +
        `pad=${bw}:${bh}:(ow-iw)/2:(oh-ih)/2:color=black@0,` +
        `pad=${width}:${height}:${bx}:${by}:color=black@0,setsar=1,format=rgba[theme]`,
      '[theme]alphaextract[themealpha]',
      "[themealpha][mask]blend=all_expr='A*B/255':shortest=1[combinedalpha]",
      '[theme]format=rgb24[themergb]',
      '[themergb][combinedalpha]alphamerge[subject]',
    );
    subject = 'subject';
  } else {
    filters.push(`[${sourceSplit ? 'srcfg' : 'src'}][mask]alphamerge[originalsubject]`);
  }
  filters.push(`[base][${subject}]overlay=shortest=1:format=auto,format=yuv420p[outv]`);

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    '-an',
    '-t', String(seconds),
    '-r', String(fps),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  );
  return { ffmpeg, args };
}

async function renderThemeImage(comfy, theme, kind, dimensions, outputDir, logger) {
  const subjectInstructions = kind === 'foreground'
    ? 'Show one complete foreground subject, centered and relatively small in frame, ' +
      'camera pulled back, entire head and feet or entire object fully visible, ' +
      'clear silhouette, plain white studio background, no text.'
    : 'Environment-only background plate, no people, animals, vehicles, or foreground subject, ' +
      'wide coherent scenery, no text.';
  const prompt = `${theme}. ${subjectInstructions} Photorealistic, detailed, natural lighting.`;
  const negativePrompt = kind === 'foreground'
    ? 'cropped, close-up, cut off head, cut off feet, partial body, extra people, text, watermark'
    : 'people, animals, vehicles, foreground subject, text, watermark';
  logger?.step?.(`Generating ${kind} theme image: ${theme}`);
  const { promptId } = await comfy.renderImage({
    prompt,
    negativePrompt,
    width: dimensions.width,
    height: dimensions.height,
    steps: 20,
    filenamePrefix: `videoforge/edit/${kind}-${slugify(theme, 32)}`,
  });
  const result = await comfy.renderAndFetch(promptId, {
    saveDir: outputDir,
    timeoutMs: comfy.config.timeouts.toolCallMs,
  });
  const generated = result.downloaded.find((file) => file.local && fs.existsSync(file.local));
  if (!generated) {
    throw new Error(`ComfyUI completed the ${kind} theme render but returned no downloadable image.`);
  }
  return generated.local;
}

/**
 * Replace either video layer while using a local per-frame saliency matte to
 * preserve the source subject's movement and silhouette.
 */
export async function renderVideoThemes({
  source,
  sourceInfo,
  backgroundTheme = '',
  foregroundTheme = '',
  outputDir,
  config,
  logger = null,
}) {
  const backgroundPrompt = String(backgroundTheme).trim();
  const foregroundPrompt = String(foregroundTheme).trim();
  if (!backgroundPrompt && !foregroundPrompt) {
    throw new Error('Provide a background or foreground theme for the uploaded-video edit.');
  }
  if (backgroundPrompt.length > 2000 || foregroundPrompt.length > 2000) {
    throw new Error('Background and foreground themes must be 2,000 characters or fewer.');
  }

  const python = config.matting?.python;
  const script = config.matting?.script;
  const imageScript = config.matting?.imageScript;
  if (
    !python || !fs.existsSync(python) || !script || !fs.existsSync(script) ||
    !imageScript || !fs.existsSync(imageScript)
  ) {
    throw new Error(
      'Automatic foreground segmentation is not set up. Run `npm run setup:matting` and retry.',
    );
  }
  if (!sourceInfo?.width || !sourceInfo?.height || !sourceInfo?.duration) {
    throw new Error('The uploaded video is missing readable dimensions or duration.');
  }

  ensureDir(outputDir);
  const dimensions = matteDimensions(sourceInfo.width, sourceInfo.height);
  const analysisVideo = path.join(outputDir, 'analysis.mp4');
  const matte = path.join(outputDir, 'foreground-matte.mkv');
  const matteMetadataPath = path.join(outputDir, 'foreground-matte.json');
  const clip = path.join(outputDir, 'themed-video.mp4');
  const assets = {};

  logger?.step?.(
    `Preparing ${dimensions.width}x${dimensions.height} frames for automatic subject segmentation`,
  );
  await run(config.ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', source,
    '-map', '0:v:0',
    '-an',
    '-vf', `fps=${config.fps},scale=${dimensions.width}:${dimensions.height}:flags=lanczos,setsar=1`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
    analysisVideo,
  ], { timeoutMs: 60 * 60 * 1000 });

  logger?.step?.('Detecting the moving foreground subject locally (first run downloads the matte model)');
  await run(python, [
    script, '--input', analysisVideo, '--output', matte,
    '--metadata', matteMetadataPath, '--fps', String(config.fps),
  ], { timeoutMs: Math.max(60 * 60 * 1000, sourceInfo.duration * 12000) });
  const matteMetadata = JSON.parse(fs.readFileSync(matteMetadataPath, 'utf8'));

  const comfy = new ComfyClient(config, { logger });
  try {
    await comfy.connect();
    if (backgroundPrompt) {
      assets.background = await renderThemeImage(
        comfy, backgroundPrompt, 'background', dimensions, outputDir, logger,
      );
    }
    if (foregroundPrompt) {
      const subjectSize = matteMetadata.bbox
        ? { width: matteMetadata.bbox.width, height: matteMetadata.bbox.height }
        : dimensions;
      assets.foregroundGenerated = await renderThemeImage(
        comfy, foregroundPrompt, 'foreground', matteDimensions(subjectSize.width, subjectSize.height),
        outputDir, logger,
      );
      assets.foreground = path.join(outputDir, 'foreground-theme-cutout.png');
      logger?.step?.('Removing the generated foreground image background locally');
      await run(python, [
        imageScript, '--input', assets.foregroundGenerated, '--output', assets.foreground,
      ], { timeoutMs: 15 * 60 * 1000 });
    }
  } finally {
    await comfy.close();
  }

  logger?.step?.('Compositing the selected themes over the original video motion');
  const command = buildThemeCompositeArgs({
    source,
    matte,
    background: assets.background ?? null,
    foreground: assets.foreground ?? null,
    output: clip,
    width: sourceInfo.width,
    height: sourceInfo.height,
    subjectBounds: matteMetadata.bbox
      ? {
          x: matteMetadata.bbox.x * sourceInfo.width / matteMetadata.width,
          y: matteMetadata.bbox.y * sourceInfo.height / matteMetadata.height,
          width: matteMetadata.bbox.width * sourceInfo.width / matteMetadata.width,
          height: matteMetadata.bbox.height * sourceInfo.height / matteMetadata.height,
        }
      : undefined,
    fps: config.fps,
    seconds: sourceInfo.duration,
    ffmpeg: config.ffmpeg,
  });
  await run(command.ffmpeg, command.args, { timeoutMs: 60 * 60 * 1000 });

  if (!fs.existsSync(clip)) throw new Error('The video theme compositor produced no output clip.');
  logger?.ok?.('Foreground/background theme compositing complete.');
  return {
    clip,
    assets,
    matte,
    matteMetadata,
    dimensions,
    method: 'automatic-saliency-matte',
  };
}
