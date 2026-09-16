/**
 * ComfyUI MCP adapter (visuals).
 *
 * VideoForge never talks to ComfyUI's HTTP API directly - it drives the ComfyUI
 * MCP server, which means the same code renders on a local CPU box, a local
 * GPU, a tunnelled free Colab GPU, or a paid pod, purely by changing
 * COMFYUI_URL.
 *
 * ComfyUI renders are asynchronous. The MCP tools enqueue and hand back a
 * prompt_id, so this adapter enqueues, then polls the queue and history until
 * the outputs are ready, then pulls the files down to local disk.
 */
import path from 'node:path';
import { McpConnection } from './client.js';
import { ensureDirAsync } from '../util/fs.js';

/** Poll cadence while waiting for a render. */
const POLL_MS = 3000;

export class ComfyClient {
  /**
   * @param {object} config VideoForge config
   * @param {object} [options] { logger }
   */
  constructor(config, { logger = null } = {}) {
    this.config = config;
    this.logger = logger;
    this.connection = new McpConnection('comfyui', config.comfyMcp, {
      logger,
      timeoutMs: config.timeouts.toolCallMs,
    });
  }

  async connect() {
    await this.connection.connect();
    return this;
  }

  async hasTool(name) {
    return this.connection.hasTool(name);
  }

  /**
   * Is a ComfyUI actually reachable behind the MCP server?
   * Returns { ok, detail } rather than throwing, so `backend: auto` can decide.
   */
  async health() {
    try {
      await this.connect();
      const stats = await this.connection.callJson(
        'get_system_stats',
        { action: 'stats' },
        { timeoutMs: 60000 },
      );
      const devices = stats.devices ?? [];
      const device = devices[0] ?? {};
      return {
        ok: true,
        detail: {
          comfyui: stats.system?.comfyui_version ?? stats.comfyui_version ?? 'unknown',
          python: stats.system?.python_version ?? 'unknown',
          device: device.name ?? 'unknown',
          vramTotalGb: device.vram_total ? Math.round((device.vram_total / 1024 ** 3) * 10) / 10 : null,
          vramFreeGb: device.vram_free ? Math.round((device.vram_free / 1024 ** 3) * 10) / 10 : null,
          raw: stats,
        },
      };
    } catch (error) {
      return { ok: false, detail: { error: error.message }, stderr: this.connection.stderr };
    }
  }

  /** Render a single keyframe image. Returns the enqueued prompt id. */
  async renderImage({
    prompt,
    negativePrompt = '',
    width,
    height,
    steps = 25,
    cfg = 7,
    seed,
    checkpoint,
    filenamePrefix = 'vf/frame',
  } = {}) {
    const args = {
      action: 'image',
      prompt,
      negative_prompt: negativePrompt,
      width,
      height,
      steps,
      cfg,
      filename_prefix: filenamePrefix,
    };
    if (seed !== undefined && seed !== null) args.seed = seed;
    if (checkpoint) args.checkpoint = checkpoint;

    const result = await this.connection.call('generate_image', args, {
      timeoutMs: this.config.timeouts.toolCallMs,
    });
    return { promptId: extractPromptId(result), text: result.text };
  }

  /** Animate a keyframe image into a shot (image-to-video). */
  async renderVideo({
    image,
    prompt,
    seconds = 4,
    resolution,
    fps,
    steps,
    cfg,
    seed,
    checkpoint,
    filenamePrefix = 'vf/shot',
  } = {}) {
    const args = {
      action: 'video',
      prompt,
      image,
      seconds,
      resolution,
      fps,
      filename_prefix: filenamePrefix,
    };
    if (steps) args.steps = steps;
    if (cfg) args.cfg = cfg;
    if (seed !== undefined && seed !== null) args.seed = seed;
    if (checkpoint) args.checkpoint = checkpoint;

    const result = await this.connection.call('generate_image', args, {
      timeoutMs: this.config.timeouts.toolCallMs,
    });
    return { promptId: extractPromptId(result), text: result.text };
  }

  /** Super-resolve an existing image (Real-ESRGAN and friends). */
  async upscaleImage({ image, model, scale = 2 } = {}) {
    const args = { action: 'upscale', image, scale };
    if (model) args.model = model;
    const result = await this.connection.call('generate_image', args, {
      timeoutMs: this.config.timeouts.toolCallMs,
    });
    return { promptId: extractPromptId(result), text: result.text };
  }

  /**
   * Wait for an enqueued render to finish.
   *
   * ComfyUI executes asynchronously, so we poll the queue and then read the
   * history entry, which is where the produced filenames live.
   */
  async awaitCompletion(promptId, { timeoutMs = this.config.timeouts.toolCallMs, onProgress } = {}) {
    if (!promptId) throw new Error('awaitCompletion needs a promptId.');

    const started = Date.now();
    let lastStatus = null;
    let sawRecord = false;

    for (;;) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `Render ${promptId} did not finish within ${Math.round(timeoutMs / 1000)}s ` +
            `(last status: ${JSON.stringify(lastStatus)?.slice(0, 300)}).`,
        );
      }

      let status = null;
      try {
        status = await this.connection.callJson(
          'queue',
          { action: 'status', prompt_id: promptId },
          { timeoutMs: 60000 },
        );
      } catch (error) {
        this.logger?.debug?.(`comfy: queue status failed (${error.message}); retrying`);
      }

      if (status) {
        lastStatus = status;
        if (status.found === false && status.done !== true) {
          // The prompt is neither queued nor in history: a server restart or a
          // rejected prompt. Do not spin forever on it.
          if (sawRecord) break;
          throw new Error(
            `ComfyUI has no record of render ${promptId}; it was never executed. ` +
              `Check the ComfyUI console for a validation error.`,
          );
        }
        sawRecord = true;
        onProgress?.(status, (Date.now() - started) / 1000);
        if (status.done) break;
      }

      await sleep(POLL_MS);
    }

    const history = await this.connection.call(
      'get_history',
      { action: 'list', prompt_id: promptId },
      { timeoutMs: 180000 },
    );

    return { promptId, status: lastStatus, history: history.json ?? tryTextAsJson(history.text) };
  }

  /**
   * Harvest output file references from a history or listing response.
   *
   * The ComfyUI MCP server returns these tools as Markdown, not JSON, so both
   * shapes are understood:
   *   get_history  action:list -> "- Node 7: images -> **ComfyUI_00002_.png (type=output)**"
   *   get_image    list_outputs-> "1. **ComfyUI_00002_.png** [image]"
   * JSON is still parsed first in case a server build emits structured output.
   */
  static harvestOutputs(source, promptId) {
    const files = [];
    const seen = new Set();

    const push = (raw, kindHint) => {
      const ref = toFileRef(raw, kindHint);
      if (!ref) return;
      const key = `${ref.subfolder}/${ref.filename}`;
      if (seen.has(key)) return;
      seen.add(key);
      files.push(ref);
    };

    const isObject = source && typeof source === 'object';

    if (isObject) {
      const outputs =
        source.outputs ?? source[promptId]?.outputs ?? source.result?.outputs ?? null;
      if (outputs && typeof outputs === 'object') {
        for (const node of Object.values(outputs)) {
          for (const bucket of ['images', 'gifs', 'videos', 'audio', 'files']) {
            for (const item of node?.[bucket] ?? []) push(item, bucket);
          }
          if (node?.filename) push(node.filename);
        }
      }
      for (const item of source.files ?? []) {
        push(typeof item === 'string' ? item : item?.filename, item?.kind);
      }
    }

    if (typeof source === 'string') {
      for (const line of source.split(/\r?\n/)) {
        const history = line.match(/[-*]\s+Node\s+\d+:.*?(?:->|→)\s*(.+)$/);
        if (history) {
          for (const match of history[1].matchAll(/\*\*([^*]+?)\*\*/g)) push(match[1]);
          continue;
        }
        const listing = line.match(/^\s*\d+\.\s*\*\*([^*]+?)\*\*\s*(?:\[(\w+)\])?/);
        if (listing) push(listing[1], listing[2]);
      }
    }

    return files;
  }

  /**
   * Copy a rendered file from the ComfyUI server to local disk.
   *
   * The MCP server answers with "Saved to: <path>"; that path is authoritative
   * (it handles subfolders and preserves video extensions), so it is parsed
   * rather than reconstructed. Works against remote instances too, which is what
   * makes the tunnelled-Colab workflow possible.
   */
  async fetchOutput({ filename, subfolder = '', type = 'output', saveDir }) {
    if (!filename) throw new Error('fetchOutput needs a filename.');
    const targetDir = await ensureDirAsync(saveDir ?? this.config.workDir);

    const result = await this.connection.call(
      'get_image',
      { action: 'get', filename, subfolder, type, save_dir: targetDir },
      { timeoutMs: this.config.timeouts.toolCallMs },
    );

    const saved = result.text.match(/Saved to:\s*(.+?)\s*$/im);
    if (saved) return saved[1].trim();

    // Fall back to where the MCP would have written it.
    return path.join(targetDir, subfolder ? path.join(subfolder, path.basename(filename)) : path.basename(filename));
  }

  /**
   * Await a render, then download everything it produced.
   *
   * Two sources are combined because neither is complete on its own:
   *   - get_history lists what each node emitted, including video outputs.
   *   - get_image list_outputs lists registered media files.
   */
  async renderAndFetch(promptId, { saveDir, timeoutMs, onProgress } = {}) {
    const { history } = await this.awaitCompletion(promptId, { timeoutMs, onProgress });

    const candidates = ComfyClient.harvestOutputs(history, promptId);

    // Only consult the global listing when this run's own history yielded
    // nothing: list_outputs reports every file on the server, not just ours,
    // so using it eagerly would re-download older renders on every scene.
    if (candidates.length === 0) {
      try {
        const listing = await this.connection.call(
          'get_image',
          { action: 'list_outputs' },
          { timeoutMs: 120000 },
        );
        candidates.push(...ComfyClient.harvestOutputs(listing.text, promptId));
      } catch (error) {
        this.logger?.debug?.(`comfy: list_outputs unavailable (${error.message})`);
      }
    }

    const downloaded = [];
    for (const file of candidates) {
      try {
        const local = await this.fetchOutput({ ...file, saveDir });
        downloaded.push({ ...file, local });
      } catch (error) {
        this.logger?.warn?.(`comfy: could not download ${file.filename}: ${error.message}`);
      }
    }
    return { files: candidates, downloaded };
  }

  /** Which model files this ComfyUI has, per category. */
  async listModels(modelType) {
    const args = { action: 'list' };
    if (modelType) args.model_type = modelType;
    try {
      return await this.connection.callJson('list_local_models', args, { timeoutMs: 120000 });
    } catch (error) {
      return { error: error.message };
    }
  }

  /** Free VRAM between model families. Best-effort. */
  async clearVram() {
    try {
      await this.connection.call('clear_vram', {}, { timeoutMs: 120000 });
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    await this.connection.close();
  }
}

/** Classify a filename by extension, falling back to the server's own wording. */
function normaliseKind(hint, filename) {
  const name = String(filename ?? '').toLowerCase();
  if (/\.(mp4|webm|mkv|mov|avi)$/.test(name)) return 'video';
  if (/\.(wav|mp3|flac|ogg|m4a)$/.test(name)) return 'audio';
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(name)) return 'image';

  const key = String(hint ?? '').toLowerCase();
  if (key.includes('vid') || key === 'gifs') return 'video';
  if (key.includes('audio')) return 'audio';
  return 'image';
}

/**
 * Normalise whatever the MCP printed into {filename, subfolder, type, kind}.
 * Handles "**name.png (type=output)**", "1. **name.png** [image]" and
 * "subfolder/name.png" alike. Returns null for anything that is not media.
 */
function toFileRef(raw, kindHint) {
  if (!raw) return null;

  // Structured input: trust the server's own field names.
  if (typeof raw === 'object') {
    const given = raw.filename ?? raw.name ?? raw.path;
    if (!given) return null;
    const flat = String(given).replace(/\\/g, '/');
    const cut = flat.lastIndexOf('/');
    const name = cut === -1 ? flat : flat.slice(cut + 1);
    const subfolder = raw.subfolder ?? (cut === -1 ? '' : flat.slice(0, cut));
    return {
      filename: name,
      subfolder: subfolder ?? '',
      type: raw.type ?? 'output',
      kind: normaliseKind(kindHint, name),
      ref: String(given),
    };
  }

  let file = String(raw).replace(/\*\*/g, '').trim();
  file = file
    .replace(/\s*\(type=[^)]*\)\s*$/i, '')
    .replace(/\s*\[[^\]]*\]\s*$/i, '')
    .trim();

  if (
    !/\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|webm|mkv|mov|avi|wav|mp3|flac|ogg|m4a)$/i.test(file)
  ) {
    return null;
  }

  const normalised = file.replace(/\\/g, '/');
  const slash = normalised.lastIndexOf('/');
  const filename = slash === -1 ? normalised : normalised.slice(slash + 1);
  const subfolder = slash === -1 ? '' : normalised.slice(0, slash);

  return {
    filename,
    subfolder,
    type: 'output',
    kind: normaliseKind(kindHint, filename),
    ref: file,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tryTextAsJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The MCP servers report prompt ids in slightly different shapes. */
export function extractPromptId(result) {
  const data = result?.json;
  if (data) {
    const direct =
      data.prompt_id ?? data.promptId ?? data.prompt?.prompt_id ?? data.result?.prompt_id;
    if (direct) return String(direct);
  }
  const match = String(result?.text ?? '').match(
    /"?prompt_?id"?\s*[:=]\s*"?([0-9a-fA-F-]{8,})"?/i,
  );
  return match ? match[1] : null;
}