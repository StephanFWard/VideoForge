import test from 'node:test';
import assert from 'node:assert/strict';
import { LtxClient } from '../src/mcp/ltx.js';

test('LTX generation forwards source video-to-video input paths', async () => {
  const client = new LtxClient({
    ltxMcp: { command: 'python' },
    ltx: { model: 'model.yaml', offloadToCpu: false, imageCondNoiseScale: 0.15 },
    fps: 30,
    timeouts: { toolCallMs: 1000 },
  });
  let request;
  client.connection.call = async (_name, args) => {
    request = args;
    return { json: { ok: true, path: 'edited.mp4' } };
  };

  await client.generate({
    prompt: 'Change the background to a golf course',
    outputPath: 'output',
    inputMediaPath: 'source.mp4',
    numFrames: 169,
    height: 512,
    width: 288,
  });

  assert.equal(request.input_media_path, 'source.mp4');
  assert.equal(request.num_frames, 169);
  assert.equal(request.conditioning_media_paths, undefined);
});
