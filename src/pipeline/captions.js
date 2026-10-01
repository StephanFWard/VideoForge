/**
 * Captions: VideoForge's answer to Remotion's caption rendering.
 *
 * Remotion renders captions as React components positioned on Sequences;
 * VideoForge renders through ffmpeg, so captions become an SRT sidecar file
 * plus a burned-in option. The sidecar is always written (players can toggle
 * it), the burned-in pass is opt-in via config.captions.mode = 'burn'.
 *
 * Word timings are estimated deterministically from narration audio lengths
 * (measured by ffprobe) rather than a speech recogniser, so the file is
 * stable across runs and exact on scene boundaries — the same frame-exact
 * contract as the timeline itself.
 */
import path from 'node:path';
import fs from 'node:fs';
import { ensureDir } from '../util/fs.js';

/** seconds -> "HH:MM:SS,mmm" for SRT. */
export function srtTimestamp(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(t / 3600);
  const mins = Math.floor((t % 3600) / 60);
  const secs = Math.floor(t % 60);
  const millis = Math.floor((t - Math.floor(t)) * 1000);
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');
  return `${pad2(hours)}:${pad2(mins)}:${pad2(secs)},${pad3(millis)}`;
}

/**
 * Chunk narration text into caption cues of at most `maxChars` characters,
 * breaking on word boundaries. A cue carries { text, startRatio, endRatio }
 * fractions of the scene duration so callers can map them onto frames.
 */
export function chunkCues(text, { maxChars = 72 } = {}) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const cues = [];
  let current = [];
  let length = 0;
  for (const word of words) {
    const extra = (current.length > 0 ? 1 : 0) + word.length;
    if (current.length > 0 && length + extra > maxChars) {
      cues.push(current.join(' '));
      current = [word];
      length = word.length;
    } else {
      current.push(word);
      length += extra;
    }
  }
  if (current.length > 0) cues.push(current.join(' '));
  const totalChars = cues.reduce((sum, cue) => sum + cue.length, 0) || 1;
  let consumed = 0;
  return cues.map((cue) => {
    const startRatio = consumed / totalChars;
    consumed += cue.length;
    return { text: cue, startRatio, endRatio: consumed / totalChars };
  });
}

/**
 * Build SRT content for a rendered timeline. Scene cues span the timeline's
 * own frame positions (from/durationInFrames at timeline.fps), never guessed
 * floats — the manifest can verify every cue against the timeline entry.
 */
export function buildSrt({ scenes, timeline, maxChars = 72 } = {}) {
  const entries = timeline?.scenes ?? [];
  const lines = [];
  let cueIndex = 1;
  entries.forEach((entry, position) => {
    const scene = scenes?.[position] ?? scenes?.find?.((s) => Number(s.scene) === Number(entry.scene));
    const narration = scene?.narration ?? scene?.title ?? entry.title ?? '';
    const fps = timeline?.fps ?? 30;
    const fromSeconds = (entry.from ?? 0) / fps;
    const durationSeconds = (entry.durationInFrames ?? 0) / fps;
    for (const cue of chunkCues(narration, { maxChars })) {
      const start = fromSeconds + cue.startRatio * durationSeconds;
      const end = fromSeconds + cue.endRatio * durationSeconds;
      if (end <= start) continue;
      lines.push(`${cueIndex}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${cue.text}\n`);
      cueIndex += 1;
    }
  });
  return lines.join('\n');
}

/** Write the sidecar `<name>.srt` next to the delivery file. Returns the path or null. */
export function writeCaptions({ outDir, name, scenes, timeline, config, maxChars = 72 }) {
  if (!outDir || !name || !timeline) return null;
  const enabled = config?.captions?.enabled ?? true;
  if (!enabled) return null;
  const content = buildSrt({ scenes, timeline, maxChars });
  if (!content) return null;
  ensureDir(outDir);
  const target = path.join(outDir, `${name}.srt`);
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

export default { srtTimestamp, chunkCues, buildSrt, writeCaptions };
