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
    /reference-conditioned LTX-Video render failed: model failed/,
  );
});
