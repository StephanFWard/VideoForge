/**
 * The timeline: a video is a function of frames.
 *
 * Remotion's central idea is that a video is nothing more than a function from
 * a frame number to a picture, and that a composition is fully described by
 * `width`, `height`, `fps` and `durationInFrames` - the first frame is 0 and
 * the last frame is `durationInFrames - 1`. Scenes are positioned with a
 * `<Sequence from={...} durationInFrames={...}>`.
 *
 * VideoForge renders with ffmpeg rather than React, but once narration exists
 * the same contract applies. This module turns a normalised storyboard plus
 * the measured narration lengths into integer, frame-exact scene positions:
 *
 *     scene N: from ... from + durationInFrames - 1
 *
 * Frame-exact timing is what makes assembly reproducible (every segment is cut
 * to `durationInFrames / fps` seconds, never a rounded float), what makes
 * crossfades line up on an exact frame boundary, and what lets the manifest
 * describe a render the way Remotion describes a composition.
 *
 * Transitions consume an exact number of frames too:
 *   - 'crossfade' overlaps the two scenes, so the timeline gets `D` frames
 *     shorter (the second scene starts `D` frames before the first ends);
 *   - 'fade' (dip to black) does not move any boundary - it is baked into the
 *     two segments by the assembler;
 *   - 'none' is a hard cut.
 */
import { LIMITS, isTransition } from './storyboard.js';

/** Seconds -> whole frames, never zero (a scene is at least one frame long). */
export function secondsToFrames(seconds, fps) {
  const value = Number(seconds);
  const rate = Number(fps);
  if (!Number.isFinite(value) || !Number.isFinite(rate) || rate <= 0) return 0;
  return Math.max(1, Math.round(value * rate));
}

/** Whole frames -> seconds, exactly the value ffmpeg will be cut to. */
export function framesToSeconds(frames, fps) {
  const rate = Number(fps);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Number(frames) / rate;
}

/**
 * Build the frame-exact timeline.
 *
 * @param {object} req
 * @param {object} req.storyboard  Normalised storyboard.
 * @param {Array}  [req.narration] Per-scene {scene, duration} from the audio stage.
 * @param {number} [req.fps]       Frames per second of the render.
 * @param {number} [req.padSeconds] Silence held after each narration line.
 * @param {number} [req.transitionSeconds] Requested crossfade length.
 * @returns {object} { fps, mode, durationInFrames, durationSeconds, scenes: [...] }
 */
export function buildTimeline({
  storyboard,
  narration = [],
  fps = 30,
  padSeconds = 0.6,
  transitionSeconds = 0.5,
}) {
  if (!storyboard || !Array.isArray(storyboard.scenes) || storyboard.scenes.length === 0) {
    throw new Error('buildTimeline needs a normalised storyboard with at least one scene.');
  }

  const rate = Number(fps);
  const fpsOut = Number.isFinite(rate) && rate > 0 && rate <= 240 ? Math.round(rate * 1000) / 1000 : 30;
  const pad = Number.isFinite(Number(padSeconds)) ? Math.max(0, Number(padSeconds)) : 0.6;
  const crossfadeWanted = Math.max(0, Number(transitionSeconds) || 0);

  // Every boundary that requests a crossfade makes the whole join a crossfade
  // chain; other boundaries then become 1-frame overlaps (visually a hard cut)
  // so the filter graph stays uniform.
  const mode = storyboard.scenes.some((scene, i) => i > 0 && scene.transition === 'crossfade')
    ? 'xfade'
    : 'concat';

  const scenes = storyboard.scenes.map((scene, index) => {
    const spoken = narration.find((entry) => Number(entry?.scene) === index + 1)?.duration;
    const fallback = Number(scene.seconds) > 0 ? Number(scene.seconds) : LIMITS.defaultSceneSeconds;
    const seconds = (Number.isFinite(Number(spoken)) && Number(spoken) > 0 ? Number(spoken) : fallback) + pad;
    const durationInFrames = secondsToFrames(seconds, fpsOut);

    const requested = isTransition(scene.transition) ? scene.transition : 'none';
    const transition = index === 0 ? (requested === 'crossfade' ? 'none' : requested) : requested;

    return {
      scene: index + 1,
      id: scene.id ?? index + 1,
      title: scene.title ?? `Scene ${index + 1}`,
      narrationSeconds: Number(Number.isFinite(Number(spoken)) ? Number(spoken) : fallback),
      durationInFrames,
      from: 0,
      overlapFrames: 0,
      transition,
    };
  });

  // Position each scene. A crossfade pulls the next scene `D` frames earlier;
  // in 'xfade' mode every other boundary keeps a minimal 1-frame overlap so a
  // single xfade chain can express the whole join.
  let from = 0;
  scenes.forEach((entry, index) => {
    entry.from = from;
    const next = scenes[index + 1];
    let overlapFrames = 0;
    if (next && mode === 'xfade') {
      if (next.transition === 'crossfade') {
        const requested = secondsToFrames(crossfadeWanted, fpsOut);
        overlapFrames = Math.max(
          0,
          Math.min(requested, Math.floor(entry.durationInFrames / 2), Math.floor(next.durationInFrames / 2)),
        );
      }
      if (overlapFrames === 0) overlapFrames = 1; // hard cut, approximated by a 1-frame blend
    }
    entry.overlapFrames = overlapFrames;
    entry.durationSeconds = framesToSeconds(entry.durationInFrames, fpsOut);
    from = entry.from + entry.durationInFrames - overlapFrames;
  });

  const last = scenes[scenes.length - 1];
  const durationInFrames = last.from + last.durationInFrames;

  return {
    fps: fpsOut,
    mode,
    padSeconds: pad,
    transitionSeconds: crossfadeWanted,
    durationInFrames,
    durationSeconds: framesToSeconds(durationInFrames, fpsOut),
    scenes,
  };
}

/**
 * The crossfade boundaries of a timeline, ready for `crossfadeVideos()`:
 * one entry per join, in order, with seconds offsets.
 */
export function crossfades(timeline) {
  if (!timeline || timeline.mode !== 'xfade') return [];
  return timeline.scenes.slice(1).map((entry) => ({
    afterScene: entry.scene - 1,
    offsetSeconds: framesToSeconds(entry.from, timeline.fps),
    durationSeconds: framesToSeconds(entry.overlapFrames, timeline.fps),
  }));
}

/** Is this boundary rendered as a real crossfade chain rather than a cut? */
export function isCrossfadeBoundary(timeline, index) {
  const entry = timeline?.scenes?.[index];
  return Boolean(entry && entry.transition === 'crossfade' && entry.overlapFrames > 0);
}

export default { buildTimeline, crossfades, secondsToFrames, framesToSeconds, isCrossfadeBoundary };

