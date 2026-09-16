/**
 * Manual probe: render one real image through the ComfyUI MCP server.
 *
 *   node scripts/probe-comfy-render.js
 *
 * This exercises the full remote path - MCP handshake, enqueue, queue polling,
 * history lookup, file download - against whatever COMFYUI_URL points at.
 */
import { loadConfig } from '../src/config.js';
import { ComfyClient } from '../src/mcp/comfy.js';
import { createLogger } from '../src/util/log.js';
import { probe } from '../src/util/ffmpeg.js';

const config = loadConfig({});
const logger = createLogger({ name: 'probe' });
const comfy = new ComfyClient(config, { logger });

const t0 = Date.now();

try {
  const health = await comfy.health();
  console.log(`health ok=${health.ok} device=${health.detail?.device ?? '?'} comfyui=${health.detail?.comfyui ?? '?'}`);
  if (!health.ok) {
    console.log('ComfyUI unreachable:', health.detail?.error);
    process.exit(1);
  }

  const models = await comfy.listModels('checkpoints');
  console.log('checkpoints:', JSON.stringify(models).slice(0, 500));

  console.log('enqueueing 512x512 / 12 steps ...');
  const { promptId } = await comfy.renderImage({
    prompt: 'a red apple resting on a weathered wooden table, studio photograph, soft light',
    negativePrompt: 'blurry, text, watermark',
    width: 512,
    height: 512,
    steps: 12,
    cfg: 7,
    filenamePrefix: 'video-forge/probe',
  });
  console.log(`promptId=${promptId}  (enqueued in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!promptId) throw new Error('no prompt id returned');

  const { files, downloaded } = await comfy.renderAndFetch(promptId, {
    saveDir: 'work/probe',
    onProgress: (status, elapsed) => {
      if (Math.round(elapsed) % 15 === 0) {
        console.log(`  ... ${elapsed.toFixed(0)}s running=${status.running} pending=${status.pending} done=${status.done}`);
      }
    },
  });

  console.log('history files:', JSON.stringify(files, null, 2));
  console.log('downloaded:', JSON.stringify(downloaded, null, 2));

  for (const file of downloaded) {
    const info = await probe(file.local, config.ffprobe);
    console.log(`  ${file.local} -> ${info ? `${info.width}x${info.height} ${info.duration}s` : 'probe failed'}`);
  }

  console.log(`TOTAL ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (error) {
  console.error('PROBE FAILED:', error.message);
  if (comfy.connection.stderr) console.error('--- server stderr ---\n', comfy.connection.stderr.slice(-2000));
  process.exitCode = 1;
} finally {
  await comfy.close();
}
