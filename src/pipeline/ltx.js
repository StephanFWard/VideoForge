/**
 * Reference media and LTX-Video's shape rules.
 *
 * LTX-Video is a *latent video diffusion* model, so unlike a text-to-image
 * checkpoint it has hard constraints on the shape of everything it consumes and
 * produces. This module owns those rules on the JavaScript side, so the rest of
 * VideoForge can ask plain questions ("is this reference usable?", "what size
 * should this scene render at?") without knowing about latent factors.
 *
 * The three rules that matter, all taken from the upstream model:
 *
 *   1. Resolution must be divisible by 32. Anything else is padded with black
 *      and cropped back after decoding, so an exact fit is always better.
 *   2. Frame counts must be `N * 8 + 1` (9, 17, 25, ... 257). The VAE compresses
 *      time by 8, and the `+1` is the causal 3D convolution's boundary frame.
 *   3. Aspect ratios are snapped to the nearest training bin. Off-bin sizes
 *      still work, but picture quality is best on a bin.
 *
 * A "reference" is one uploaded picture or video the user wants the generation
 * to be conditioned on - LTX-Video calls these conditioning items, and each one
 * carries a strength (0..1) and the frame it starts at.
 */

/** LTX-Video's temporal compression factor: frame counts are `N * 8 + 1`. */
export const VIDEO_SCALE_FACTOR = 8;

/** Spatial constraint: width and height must both be divisible by this. */
export const SPATIAL_MULTIPLE = 32;

/** The model is tuned for at most this many frames (about 8.5s at 30fps). */
export const MAX_FRAMES = 257;

/** File extensions accepted as reference media, by kind. */
export const REFERENCE_EXTENSIONS = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'],
  video: ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v'],
};

/**
 * LTX-Video's training aspect-ratio bins, from
 * `LTXVideoPipeline.ASPECT_RATIO_1024_BIN`, as `{ label, width, height }`.
 *
 * Resolution binning is what makes off-spec sizes look intentional rather than
 * stretched, so VideoForge can snap any request to one of these.
 */
export const ASPECT_BINS = [
  { label: '0.25', width: 512, height: 2048 },
  { label: '0.28', width: 512, height: 1856 },
  { label: '0.32', width: 576, height: 1792 },
  { label: '0.33', width: 576, height: 1728 },
  { label: '0.35', width: 576, height: 1664 },
  { label: '0.4', width: 640, height: 1600 },
  { label: '0.42', width: 640, height: 1536 },
  { label: '0.48', width: 704, height: 1472 },
  { label: '0.5', width: 704, height: 1408 },
  { label: '0.52', width: 704, height: 1344 },
  { label: '0.57', width: 768, height: 1344 },
  { label: '0.6', width: 768, height: 1280 },
  { label: '0.68', width: 832, height: 1216 },
  { label: '0.72', width: 832, height: 1152 },
  { label: '0.78', width: 896, height: 1152 },
  { label: '0.82', width: 896, height: 1088 },
  { label: '0.88', width: 960, height: 1088 },
  { label: '0.94', width: 960, height: 1024 },
  { label: '1.0', width: 1024, height: 1024 },
  { label: '1.07', width: 1024, height: 960 },
  { label: '1.13', width: 1088, height: 960 },
  { label: '1.21', width: 1088, height: 896 },
  { label: '1.29', width: 1152, height: 896 },
  { label: '1.38', width: 1152, height: 832 },
  { label: '1.46', width: 1216, height: 832 },
  { label: '1.67', width: 1280, height: 768 },
  { label: '1.75', width: 1344, height: 768 },
  { label: '2.0', width: 1408, height: 704 },
  { label: '2.09', width: 1472, height: 704 },
  { label: '2.4', width: 1536, height: 640 },
  { label: '2.5', width: 1600, height: 640 },
  { label: '3.0', width: 1728, height: 576 },
  { label: '4.0', width: 2048, height: 512 },
];

/** LTX-Video pipeline presets, best quality first (mirrors configs/*.yaml). */
export const LTX_MODELS = [
  'ltxv-13b-0.9.8-dev.yaml',
  'ltxv-13b-0.9.8-dev-fp8.yaml',
  'ltxv-13b-0.9.8-distilled.yaml',
  'ltxv-13b-0.9.8-distilled-fp8.yaml',
  'ltxv-2b-0.9.8-distilled.yaml',
  'ltxv-2b-0.9.8-distilled-fp8.yaml',
  'ltxv-2b-0.9.6-dev.yaml',
  'ltxv-2b-0.9.6-distilled.yaml',
  'ltxv-2b-0.9.5.yaml',
  'ltxv-2b-0.9.1.yaml',
  'ltxv-2b-0.9.yaml',
];

/** Default preset: the 2B distilled model - the fastest that still looks good. */
export const DEFAULT_LTX_MODEL = 'ltxv-2b-0.9.8-distilled.yaml';

/** Classify a filename as reference media, or null when unsupported. */
export function referenceKind(filename) {
  const name = String(filename ?? '').toLowerCase();
  for (const [kind, extensions] of Object.entries(REFERENCE_EXTENSIONS)) {
    if (extensions.some((ext) => name.endsWith(ext))) return kind;
  }
  return null;
}

/** Is this filename acceptable as a reference? */
export function isReferenceFile(filename) {
  return referenceKind(filename) !== null;
}

/**
 * Snap a frame count to LTX-Video's `N * 8 + 1` lattice.
 *
 * Rounds to the *nearest* legal value rather than always up, so a 6 second clip
 * at 30fps (180 frames) becomes 177 rather than 185 - closer to what was asked.
 * Never returns fewer than 9 frames (one latent step plus the boundary frame),
 * and never more than MAX_FRAMES.
 */
export function alignFrames(frames) {
  const value = Math.trunc(Number(frames));
  if (!Number.isFinite(value)) return 9;

  const nearestSteps = Math.round((value - 1) / VIDEO_SCALE_FACTOR);
  const maxSteps = (MAX_FRAMES - 1) / VIDEO_SCALE_FACTOR;
  const steps = Math.min(Math.max(nearestSteps, 1), maxSteps);
  return steps * VIDEO_SCALE_FACTOR + 1;
}

/**
 * Round a dimension up to the nearest multiple of 32.
 *
 * Up rather than down: the model pads anyway, and aligning to a multiple of 32
 * keeps the crop centred on the requested framing.
 */
export function alignSpatial(value) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number <= 0) return SPATIAL_MULTIPLE;
  return Math.ceil(number / SPATIAL_MULTIPLE) * SPATIAL_MULTIPLE;
}

/** Snap to the nearest training aspect-ratio bin for a target size. */
export function nearestAspectBin(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return ASPECT_BINS.find((bin) => bin.label === '1.0');
  }

  const target = w / h;
  let best = ASPECT_BINS[0];
  let bestDelta = Infinity;
  for (const bin of ASPECT_BINS) {
    const delta = Math.abs(bin.height / bin.width - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = bin;
    }
  }
  return best;
}

/**
 * Frame count a conditioning video segment must have.
 *
 * The model reads `N * 8 + 1` frames from a reference video; anything longer is
 * trimmed. Returning the legal count (not the raw one) is what keeps a caller
 * from being rejected at render time.
 */
export function alignReferenceFrames(frames) {
  const value = Math.trunc(Number(frames));
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.trunc((value - 1) / VIDEO_SCALE_FACTOR) * VIDEO_SCALE_FACTOR + 1;
}

/**
 * Clamp a conditioning strength into LTX-Video's 0..1 range.
 * 1.0 is full conditioning (the reference is obeyed exactly).
 */
export function clampStrength(strength, fallback = 1) {
  const value = Number(strength);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}


/**
 * Resolve the dimensions LTX-Video should actually render at.
 *
 * `mode` chooses the trade-off:
 *   'exact'  - keep the requested size, only aligned to multiples of 32
 *   'bin'    - snap to the nearest training aspect bin (best picture quality)
 *
 * @param {object} req { width, height, mode }
 * @returns {{width: number, height: number, aspect: string, snapped: boolean}}
 */
export function resolveLtxResolution({ width, height, mode = 'exact' } = {}) {
  if (mode === 'bin') {
    const bin = nearestAspectBin(width, height);
    return {
      width: bin.width,
      height: bin.height,
      aspect: bin.label,
      snapped: bin.width !== Number(width) || bin.height !== Number(height),
    };
  }

  const alignedWidth = alignSpatial(width);
  const alignedHeight = alignSpatial(height);
  return {
    width: alignedWidth,
    height: alignedHeight,
    aspect: (alignedWidth / alignedHeight).toFixed(2),
    snapped: alignedWidth !== Number(width) || alignedHeight !== Number(height),
  };
}

/**
 * Validate and canonicalise one reference-upload request.
 *
 * A reference is `{ path, strength, startFrame }`. Everything a caller might
 * plausibly get wrong - a missing path, an unsupported extension, a strength
 * outside 0..1, a start frame beyond the clip - is either corrected or reported
 * here rather than 40 seconds later when the model has already loaded.
 *
 * @param {object} raw    The reference as supplied.
 * @param {object} [opts] { numFrames, index, requireStartFrame }
 * @returns {{reference: object, warnings: string[]}}
 */
export function normalizeReference(raw, { numFrames = 121, index = 1 } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Reference ${index} must be an object with a "path".`);
  }

  const warnings = [];
  const path = String(raw.path ?? raw.file ?? raw.filename ?? '').trim();
  if (!path) {
    throw new Error(`Reference ${index} has no path. Supply the uploaded file's path.`);
  }

  const kind = referenceKind(path);
  if (!kind) {
    throw new Error(
      `Reference ${index} ("${path}") is not a supported image or video. ` +
        `Accepted: ${[...REFERENCE_EXTENSIONS.image, ...REFERENCE_EXTENSIONS.video].join(', ')}.`,
    );
  }

  const frames = Math.trunc(Number(numFrames)) || 121;

  // An image is a single frame, so it can only ever condition the first frame.
  let startFrame = Math.trunc(Number(raw.startFrame ?? raw.start_frame ?? raw.frame ?? 0));
  if (!Number.isFinite(startFrame)) startFrame = 0;
  if (startFrame < 0) {
    warnings.push(`Reference ${index}: start frame ${startFrame} is negative; using 0.`);
    startFrame = 0;
  }
  if (kind === 'image' && startFrame !== 0) {
    warnings.push(
      `Reference ${index} is a still image, so it can only condition frame 0; ` +
        `ignoring start frame ${startFrame}.`,
    );
    startFrame = 0;
  }
  if (startFrame >= frames) {
    warnings.push(
      `Reference ${index}: start frame ${startFrame} is past the end of a ${frames}-frame ` +
        'render; clamping to frame 0.',
    );
    startFrame = 0;
  }

  const rawStrength = raw.strength;
  const strength = rawStrength === undefined || rawStrength === null || rawStrength === ''
    ? 1
    : clampStrength(rawStrength, 1);
  if (rawStrength !== undefined && rawStrength !== null && Number(rawStrength) !== strength) {
    warnings.push(
      `Reference ${index}: strength ${rawStrength} is outside 0..1; using ${strength}.`,
    );
  }

  return {
    reference: {
      path,
      kind,
      strength,
      startFrame,
      label: String(raw.label ?? '').trim() || undefined,
    },
    warnings,
  };
}

/**
 * Validate a whole set of references for one render.
 *
 * LTX-Video requires the conditioning lists to be the same length, so this is
 * the single place that guarantee is established; the MCP layer re-checks it
 * because it is a hard model requirement, not a UI nicety.
 *
 * @param {Array<object>} raw     References as supplied.
 * @param {object} [opts]         { numFrames }
 * @returns {{references: object[], paths: string[], strengths: number[], startFrames: number[], warnings: string[]}}
 */
export function normalizeReferences(raw, opts = {}) {
  const list = Array.isArray(raw) ? raw : [];
  const warnings = [];
  const references = [];

  for (const [index, entry] of list.entries()) {
    const { reference, warnings: entryWarnings } = normalizeReference(entry, {
      ...opts,
      index: index + 1,
    });
    references.push(reference);
    warnings.push(...entryWarnings);
  }

  return {
    references,
    paths: references.map((r) => r.path),
    strengths: references.map((r) => r.strength),
    startFrames: references.map((r) => r.startFrame),
    warnings,
  };
}

