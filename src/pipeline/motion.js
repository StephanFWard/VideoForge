/**
 * Deterministic motion: VideoForge's answer to frame-based animation.
 *
 * Remotion's model is that a video is a function of frame numbers - given the
 * frame index, you compute exactly what the picture does, with `interpolate()`
 * and `Easing` mapping `0..durationInFrames` onto a range of values. VideoForge
 * renders through ffmpeg instead of React, so the same contract is carried by
 * ffmpeg expressions: every motion preset compiles to one deterministic
 * `zoompan` filter built from (width, height, frames, fps). The same scene
 * always compiles to the same filter string, which is what keeps re-renders
 * reproducible - and cacheable.
 *
 * The vocabulary is deliberately small and tasteful:
 *
 *   kenburns     classic slow centre push (the long-standing default)
 *   kenburns-in  eased push in
 *   kenburns-out eased pull out
 *   pan-left     eased horizontal drift, towards the left
 *   pan-right    eased horizontal drift, towards the right
 *
 * `auto` cycles through the eased presets by scene index, deterministically:
 * scene 1 gets one move, scene 2 the next, and so on. No randomness anywhere -
 * the same storyboard always produces the same motion.
 */

/** Every motion preset a storyboard may name. */
export const MOTION_PRESETS = ['kenburns', 'kenburns-in', 'kenburns-out', 'pan-left', 'pan-right'];

/** The order `auto` cycles through, keyed by scene index. */
const AUTO_CYCLE = ['kenburns-in', 'pan-right', 'kenburns-out', 'pan-left'];

/** Is this an explicit motion preset (as opposed to auto/video)? */
export function isMotionPreset(name) {
  return MOTION_PRESETS.includes(String(name ?? '').toLowerCase());
}

/**
 * Resolve a storyboard motion value into the preset that will actually be
 * rendered. `auto` cycles by index; `video` means "try image-to-video first,
 * then fall back to a preset", so it resolves to the auto choice too.
 */
export function resolveMotion(motion, index = 0) {
  const name = String(motion ?? 'auto').toLowerCase();
  if (name === 'auto' || name === 'video') {
    const i = Math.abs(Math.trunc(Number(index) || 0));
    return AUTO_CYCLE[i % AUTO_CYCLE.length];
  }
  return isMotionPreset(name) ? name : 'kenburns';
}

/** Should the diffusion image-to-video model be attempted for this scene? */
export function wantsDiffusionMotion(motion) {
  const name = String(motion ?? 'auto').toLowerCase();
  return name === 'auto' || name === 'video';
}

/**
 * Easing curves as ffmpeg expressions over the symbol `p` (progress 0..1).
 * These are the ffmpeg-side equivalent of Remotion's `Easing` object; the
 * cubic-bezier family is approximated by the usual polynomial stand-ins, all
 * of which ffmpeg evaluates natively inside a filter graph.
 */
export const EASINGS = {
  linear: 'p',
  easeIn: 'p*p',
  easeOut: '1-(1-p)*(1-p)',
  easeInOut: 'p*p*(3-2*p)',
};

/**
 * Frame-accurate progress across a clip of `frames` output frames. `on`
 * counts from 0 on the first frame, so progress reaches exactly 1 on the
 * last frame (`on = frames - 1`), and the two guards clamp any overshoot
 * from fps rounding into [0, 1].
 */
function progressExpression(frames) {
  const count = Math.max(2, Math.round(frames));
  return `min(1,max(0,on/${count - 1}))`;
}

/** Substitute the progress expression into an easing curve. */
function easeExpression(easing, frames) {
  const curve = EASINGS[easing] ?? EASINGS.linear;
  return `(${curve.split('p').join(progressExpression(frames))})`;
}

/**
 * Compile a motion preset into the exact `-vf` filter chain for
 * `stillToVideo()`. Oversampling before zoompan keeps the motion sharp.
 *
 * @param {object} req
 * @param {string} req.motion  Preset name (unknown names fall back to kenburns).
 * @param {number} req.width   Output width in pixels.
 * @param {number} req.height  Output height in pixels.
 * @param {number} req.frames  Exact number of output frames.
 * @param {number} [req.fps]
 * @returns {string} an ffmpeg filter chain
 */
export function zoompanFilter({ motion = 'kenburns', width, height, frames, fps = 30 }) {
  const count = Math.max(2, Math.round(frames));
  const preset = isMotionPreset(motion) ? String(motion).toLowerCase() : 'kenburns';

  let zoom;
  let x;
  let y;
  switch (preset) {
    case 'kenburns-in': {
      const eased = easeExpression('easeOut', count);
      zoom = `min(1+0.14*${eased},1.35)`;
      x = 'iw/2-(iw/zoom/2)';
      y = 'ih/2-(ih/zoom/2)';
      break;
    }
    case 'kenburns-out': {
      const eased = easeExpression('easeInOut', count);
      zoom = `max(1.14-0.14*${eased},1)`;
      x = 'iw/2-(iw/zoom/2)';
      y = 'ih/2-(ih/zoom/2)';
      break;
    }
    case 'pan-left': {
      const eased = easeExpression('easeOut', count);
      zoom = '1.08';
      x = `(iw-iw/zoom)*(1-${eased})`;
      y = 'ih/2-(ih/zoom/2)';
      break;
    }
    case 'pan-right': {
      const eased = easeExpression('easeOut', count);
      zoom = '1.08';
      x = `(iw-iw/zoom)*${eased}`;
      y = 'ih/2-(ih/zoom/2)';
      break;
    }
    case 'kenburns':
    default: {
      // The original VideoForge move: a slow, constant centre push.
      zoom = 'min(zoom+0.0009,1.35)';
      x = 'iw/2-(iw/zoom/2)';
      y = 'ih/2-(ih/zoom/2)';
    }
  }

  const oversample =
    `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,` +
    `crop=${width * 2}:${height * 2}`;
  const zoompan =
    `zoompan=z='${zoom}':d=${count}:x='${x}':y='${y}':s=${width}x${height}:fps=${fps}`;
  return `${oversample},${zoompan},format=yuv420p`;
}

/**
 * Deterministic pseudo-random seed derived from a string - the equivalent of
 * Remotion's `random(seed)`. Used to give every scene a stable diffusion seed
 * (so re-renders and cache lookups agree) when the storyboard does not set one.
 *
 * @param {string} text
 * @param {number} [max] upper bound, exclusive (default 2^31 - 1)
 * @returns {number} 0 <= seed < max
 */
export function randomSeed(text, max = 2147483647) {
  const value = String(text ?? '');
  let hash = 0x811c9dc5; // FNV-1a, 32-bit
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash | 0) % max;
}

export default {
  MOTION_PRESETS,
  EASINGS,
  isMotionPreset,
  resolveMotion,
  wantsDiffusionMotion,
  zoompanFilter,
  randomSeed,
};
