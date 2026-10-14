import test from 'node:test';
import assert from 'node:assert/strict';
import { VisualRenderer } from '../src/pipeline/visuals.js';

const references = [{ path: 'reference.mp4', strength: 1, startFrame: 0 }];

test('run-wide references can condition every scene or only the first scene', () => {
  const allScenes = new VisualRenderer({}, { references, referenceScope: 'all' });
  const firstScene = new VisualRenderer({}, { references });

  assert.deepEqual(allScenes.referencesForScene({}, 1), references);
  assert.deepEqual(allScenes.referencesForScene({}, 2), references);
  assert.deepEqual(firstScene.referencesForScene({}, 1), references);
  assert.deepEqual(firstScene.referencesForScene({}, 2), []);
});

test('scene-specific references take precedence over run-wide references', () => {
  const sceneReference = { path: 'scene.png', strength: 0.5, startFrame: 0 };
  const renderer = new VisualRenderer({}, {
    references,
    referenceScope: 'all',
  });

  assert.deepEqual(renderer.referencesForScene({ references: [sceneReference] }, 2), [
    sceneReference,
  ]);
});

test('reference-conditioned renders reject backends that cannot use references', async () => {
  for (const backend of ['comfy', 'mock']) {
    const renderer = new VisualRenderer({ backend }, { references });
    await assert.rejects(
      renderer.init(),
      /Reference-conditioned rendering requires the LTX-Video backend/,
    );
  }
});

test('auto mode requires LTX-Video instead of falling back when references are supplied', async () => {
  const renderer = new VisualRenderer({ backend: 'auto' }, { references });
  renderer.initLtx = async (required) => {
    assert.equal(required, true);
    renderer.ltxError = new Error(
      'Reference-conditioned rendering requires a ready LTX-Video backend.',
    );
    return false;
  };

  await assert.rejects(renderer.init(), /Reference-conditioned rendering requires a ready LTX-Video backend/);
  assert.equal(renderer.comfy, null);
});

test('reference-conditioned LTX failures do not produce placeholder footage', async () => {
  const renderer = new VisualRenderer(
    { render: { width: 640, height: 360 } },
    { references },
  );
  renderer.backend = 'ltx';
  renderer.renderLtxScene = async () => {
    throw new Error('model failed');
  };
  renderer.renderPlaceholder = async () => {
    assert.fail('must not silently render an unconditioned placeholder');
  };

  await assert.rejects(
    renderer.renderScene({ scene: {}, index: 1, outDir: '.', fps: 30 }),
    /conditioned LTX-Video render failed: model failed/,
  );
});

test('video-edit LTX failures do not produce placeholder footage', async () => {
  const renderer = new VisualRenderer(
    { render: { width: 640, height: 360 } },
    { inputVideoPath: 'source.mp4' },
  );
  renderer.backend = 'ltx';
  renderer.renderLtxScene = async () => {
    throw new Error('model failed');
  };
  renderer.renderPlaceholder = async () => {
    assert.fail('a failed source-video edit must not return a placeholder');
  };

  await assert.rejects(
    renderer.renderScene({ scene: {}, index: 1, outDir: '.', fps: 30 }),
    /conditioned LTX-Video render failed: model failed/,
  );
});

test('CPU LTX renders are capped to a memory-conscious working resolution', async () => {
  const renderer = new VisualRenderer({
    render: { width: 1280, height: 720 },
    ltx: { resolutionMode: 'exact' },
  });
  renderer.ltxDevice = 'cpu';
  renderer.inputVideoPath = 'source.mp4';
  renderer.inputVideoInfo = { width: 1080, height: 1920, duration: 5 };
  let request;
  renderer.ltx = {
    generate: async (args) => {
      request = args;
      return { path: 'not-used.mp4' };
    },
  };
  renderer.config = {
    ...renderer.config,
    ltx: { resolutionMode: 'exact', model: 'model', offloadToCpu: false },
    fps: 30,
  };

  await assert.rejects(
    renderer.renderLtxScene({ scene: { seconds: 5 }, index: 1, outDir: '.', fps: 30 }),
    /reported not-used\.mp4 but no file exists/,
  );
  assert.equal(request.inputMediaPath, 'source.mp4');
  assert.ok(request.width <= 512);
  assert.ok(request.height <= 512);
  assert.ok(request.height > request.width);
  assert.equal(request.numFrames, 153);
});
