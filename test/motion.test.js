/**
 * Motion compiler tests.
 *
 * These lock in the determinism contract: the same scene always compiles to
 * the same ffmpeg filter chain, `auto` cycles by scene index, easing curves
 * are substituted into the graph (never leaked as placeholders), and seeds
 * derived from text are stable, bounded and distinct.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOTION_PRESETS,
  isMotionPreset,
  randomSeed,
  resolveMotion,
  wantsDiffusionMotion,
  zoompanFilter,
} from '../src/pipeline/motion.js';

test('randomSeed is deterministic, bounded and distinct per input', () => {
  assert.equal(randomSeed('cold brew#1'), randomSeed('cold brew#1'));
  assert.notEqual(randomSeed('cold brew#1'), randomSeed('cold brew#2'));
  const value = randomSeed('cold brew#1');
  assert.ok(value >= 0 && value < 2147483647);
  assert.ok(randomSeed('anything', 1000) < 1000);
});

test('isMotionPreset recognises exactly the documented presets', () => {
  for (const preset of MOTION_PRESETS) assert.equal(isMotionPreset(preset), true, preset);
  assert.equal(isMotionPreset('teleport'), false);
  assert.equal(isMotionPreset(undefined), false);
});

test('resolveMotion cycles deterministically for auto and video', () => {
  assert.equal(resolveMotion('auto', 0), 'kenburns-in');
  assert.equal(resolveMotion('auto', 1), 'pan-right');
  assert.equal(resolveMotion('auto', 2), 'kenburns-out');
  assert.equal(resolveMotion('auto', 3), 'pan-left');
  assert.equal(resolveMotion('auto', 5), resolveMotion('auto', 1), 'index 5 wraps to 1');
  assert.equal(resolveMotion('video', 0), 'kenburns-in', 'video falls back to the auto pick');
});

test('resolveMotion passes presets through and falls back for unknown names', () => {
  assert.equal(resolveMotion('pan-left', 7), 'pan-left');
  assert.equal(resolveMotion('kenburns', 7), 'kenburns');
  assert.equal(resolveMotion('teleport', 0), 'kenburns');
});

test('wantsDiffusionMotion is true only for auto and video', () => {
  assert.equal(wantsDiffusionMotion(undefined), true);
  assert.equal(wantsDiffusionMotion('auto'), true);
  assert.equal(wantsDiffusionMotion('video'), true);
  assert.equal(wantsDiffusionMotion('kenburns-in'), false);
});

test('zoompanFilter compiles the classic preset exactly as before', () => {
  const filter = zoompanFilter({ motion: 'kenburns', width: 640, height: 360, frames: 90, fps: 30 });
  assert.equal(
    filter,
    `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,` +
      `zoompan=z='min(zoom+0.0009,1.35)':d=90:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=640x360:fps=30,` +
      `format=yuv420p`,
  );
  // Unknown names must fall back to exactly the same chain.
  assert.equal(
    zoompanFilter({ motion: 'teleport', width: 640, height: 360, frames: 90, fps: 30 }),
    filter,
  );
});

test('zoompanFilter is deterministic and frame-aware for eased presets', () => {
  const a = zoompanFilter({ motion: 'kenburns-in', width: 640, height: 360, frames: 90, fps: 30 });
  assert.equal(a, zoompanFilter({ motion: 'kenburns-in', width: 640, height: 360, frames: 90, fps: 30 }));
  assert.ok(a.includes(':d=90:'), 'the clip frame count drives the zoompan duration');
  // Progress spans frames 0..N-1, so 90 output frames means on/89 and the
  // last frame lands exactly on 1 before the clamp.
  assert.ok(a.includes('on/89'), 'progress is expressed in output frames');
  assert.ok(a.includes('0.14'), 'the preset moves 14% closer');

  const pan = zoompanFilter({ motion: 'pan-right', width: 640, height: 360, frames: 60, fps: 30 });
  assert.ok(pan.includes('1.08'), 'pans hold a fixed 1.08 zoom');
  assert.ok(pan.includes('(iw-iw/zoom)*'), 'pans travel across the oversampled frame');
  assert.notEqual(pan, a);
});

test('every preset compiles to a full, post-processable chain', () => {
  for (const preset of MOTION_PRESETS) {
    const filter = zoompanFilter({ motion: preset, width: 1280, height: 720, frames: 120, fps: 30 });
    assert.ok(filter.startsWith('scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440,'), preset);
    assert.ok(filter.includes('zoompan='), preset);
    assert.ok(filter.endsWith('format=yuv420p'), preset);
  }
});

test('easing placeholders never leak into the filter graph', () => {
  for (const preset of MOTION_PRESETS) {
    const filter = zoompanFilter({ motion: preset, width: 100, height: 100, frames: 30, fps: 30 });
    assert.ok(!filter.includes('EASE_PLACEHOLDER'), preset);
    // The classic preset is deliberately linear, so it carries no easing terms.
    if (preset === 'kenburns') continue;
    assert.ok(filter.includes('on/'), `${preset} is driven by the output frame counter`);
    assert.ok(filter.includes('min(1,max(0,'), `${preset} clamps progress into 0..1`);
  }
});
