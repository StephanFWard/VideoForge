import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline } from '../src/pipeline/timeline.js';

test('explicit output duration preserves an edited source clip duration', () => {
  const timeline = buildTimeline({
    storyboard: {
      scenes: [{
        id: 1,
        title: 'Edited video',
        seconds: 5.6,
        outputSeconds: 5.6,
        transition: 'none',
      }],
    },
    narration: [{ scene: 1, duration: 2 }],
    fps: 30,
    padSeconds: 0.6,
  });

  assert.equal(timeline.durationInFrames, 168);
  assert.equal(timeline.durationSeconds, 5.6);
});
