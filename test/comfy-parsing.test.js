/**
 * Parsing tests for the ComfyUI MCP adapter.
 *
 * The fixtures below are verbatim captures from a live comfyui-mcp server.
 * They matter because the server answers these tools with Markdown, not JSON -
 * the exact shape that originally broke output discovery.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ComfyClient, extractPromptId } from '../src/mcp/comfy.js';

/** Verbatim `get_history action:"list"` output. */
const HISTORY_MARKDOWN = `## Execution: 564947b8-2af4-4078-8a33-e8ac676e47fa
**Status**: success | Completed: true
**Duration**: 148.79s
**Cached nodes**: 1, 4

### Outputs (1 nodes)
- Node 7: images \u2192 **ComfyUI_00002_.png (type=output)**
`;

/** Verbatim `get_image action:"list_outputs"` output. */
const LIST_OUTPUTS_MARKDOWN = `Found 2 media file(s): Read from ComfyUI's generation history over HTTP.

1. **ComfyUI_00002_.png** [image]
2. **ComfyUI_00001_.png** [image]
`;

/** Verbatim `generate_image` response for a successful enqueue. */
const ENQUEUE_RESPONSE = JSON.stringify({
  status: 'enqueued',
  prompt_id: '564947b8-2af4-4078-8a33-e8ac676e47fa',
  queue_remaining: 1,
  checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors',
  note: 'asset_id will be available in the completion notification.',
});

test('extractPromptId reads a real enqueue response', () => {
  assert.equal(
    extractPromptId({ json: JSON.parse(ENQUEUE_RESPONSE), text: ENQUEUE_RESPONSE }),
    '564947b8-2af4-4078-8a33-e8ac676e47fa',
  );
});

test('extractPromptId falls back to scraping prose', () => {
  assert.equal(extractPromptId({ text: 'queued as prompt_id: abc123def456' }), 'abc123def456');
  assert.equal(extractPromptId({ text: 'nothing useful here' }), null);
});

test('harvestOutputs parses the Markdown history listing', () => {
  const files = ComfyClient.harvestOutputs(HISTORY_MARKDOWN, '564947b8');
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'ComfyUI_00002_.png');
  assert.equal(files[0].kind, 'image');
  assert.equal(files[0].subfolder, '');
  assert.equal(files[0].type, 'output');
});

test('harvestOutputs parses the Markdown output listing', () => {
  const files = ComfyClient.harvestOutputs(LIST_OUTPUTS_MARKDOWN, null);
  assert.deepEqual(
    files.map((f) => f.filename),
    ['ComfyUI_00002_.png', 'ComfyUI_00001_.png'],
  );
  assert.ok(files.every((f) => f.kind === 'image'));
});

test('harvestOutputs keeps video outputs and their subfolder', () => {
  const markdown = '- Node 12: gifs \u2192 **video-forge/shot_00001.mp4 (type=output)**';
  const files = ComfyClient.harvestOutputs(markdown, null);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'shot_00001.mp4');
  assert.equal(files[0].subfolder, 'video-forge');
  assert.equal(files[0].kind, 'video');
});

test('harvestOutputs still understands JSON when a server emits it', () => {
  const payload = {
    outputs: {
      '9': { images: [{ filename: 'a.png', subfolder: 'sub', type: 'output' }] },
      '12': { gifs: [{ filename: 'b.mp4', subfolder: '', type: 'output' }] },
    },
  };
  const files = ComfyClient.harvestOutputs(payload, null);
  assert.deepEqual(files.map((f) => f.filename).sort(), ['a.png', 'b.mp4']);
  assert.equal(files.find((f) => f.filename === 'a.png').subfolder, 'sub');
  assert.equal(files.find((f) => f.filename === 'b.mp4').kind, 'video');
});

test('harvestOutputs ignores prose that is not a media file', () => {
  const noisy = '**Status**: success\n**Duration**: 12s\n- Node 3: text \u2192 some summary';
  assert.deepEqual(ComfyClient.harvestOutputs(noisy, null), []);
});

test('harvestOutputs deduplicates across both sources', () => {
  const merged = [
    ...ComfyClient.harvestOutputs(HISTORY_MARKDOWN, null),
    ...ComfyClient.harvestOutputs(HISTORY_MARKDOWN, null),
  ];
  const unique = new Map(merged.map((f) => [f.filename, f]));
  assert.equal(unique.size, 1);
});