import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThemeCompositeArgs, matteDimensions } from '../src/pipeline/video-edit.js';

test('matte dimensions preserve orientation and stay within the CPU working limit', () => {
  const portrait = matteDimensions(1080, 1920);
  const landscape = matteDimensions(1920, 1080);

  assert.deepEqual(portrait, { width: 288, height: 512 });
  assert.deepEqual(landscape, { width: 512, height: 288 });
  assert.ok(Math.max(portrait.width, portrait.height) <= 512);
});

test('background-only compositing preserves the source foreground with its moving matte', () => {
  const { args } = buildThemeCompositeArgs({
    source: 'source.mp4',
    matte: 'matte.mkv',
    background: 'beach.png',
    output: 'out.mp4',
    width: 1080,
    height: 1920,
    fps: 30,
    seconds: 12,
  });
  const graph = args[args.indexOf('-filter_complex') + 1];

  assert.match(graph, /\[srcfg\]\[mask\]alphamerge\[originalsubject\]/);
  assert.match(graph, /\[2:v\]scale=1080:1920/);
  assert.match(graph, /\[srcbase\]\[generatedbg\]overlay/);
  assert.match(graph, /\[base\]\[originalsubject\]overlay/);
  assert.equal(args[args.indexOf('-t') + 1], '12');
});

test('foreground-only compositing keeps the original background and maps the theme to the subject bounds', () => {
  const { args } = buildThemeCompositeArgs({
    source: 'source.mp4',
    matte: 'matte.mkv',
    foreground: 'golfer.png',
    subjectBounds: { x: 100, y: 200, width: 400, height: 900 },
    output: 'out.mp4',
    width: 1080,
    height: 1920,
    fps: 30,
    seconds: 12,
  });
  const graph = args[args.indexOf('-filter_complex') + 1];

  assert.match(graph, /\[src\]null\[base\]/);
  assert.match(graph, /\[2:v\]scale=400:900/);
  assert.match(graph, /pad=1080:1920:100:200:color=black@0/);
  assert.match(graph, /\[theme\]alphaextract\[themealpha\]/);
  assert.match(graph, /A\*B\/255/);
  assert.match(graph, /\[themergb\]\[combinedalpha\]alphamerge\[subject\]/);
  assert.doesNotMatch(graph, /\[src\]\[mask\]alphamerge\[originalsubject\]/);
});

test('combined compositing numbers theme inputs consistently', () => {
  const { args } = buildThemeCompositeArgs({
    source: 'source.mp4',
    matte: 'matte.mkv',
    background: 'beach.png',
    foreground: 'surfer.png',
    output: 'out.mp4',
    width: 1080,
    height: 1920,
    fps: 30,
    seconds: 12,
  });
  const graph = args[args.indexOf('-filter_complex') + 1];

  assert.match(graph, /\[2:v\]scale=1080:1920/);
  assert.match(graph, /\[3:v\]scale=/);
  assert.match(graph, /\[base\]\[subject\]overlay/);
});
