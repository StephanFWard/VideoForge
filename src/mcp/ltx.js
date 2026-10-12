/**
 * LTX-Video MCP adapter (video diffusion visuals).
 *
 * Mirrors the ComfyUI adapter's role, but against a *local* LTX-Video server
 * instead of a remote ComfyUI. Where ComfyUI is asynchronous (enqueue a prompt,
 * poll the queue, harvest filenames), LTX-Video renders synchronously inside one
 * MCP tool call and hands back the finished file - so this adapter is mostly
 * about shaping a request and reporting the result.
 *
 * Everything LTX-Video can do is reachable from here: text-to-video,
 * image-to-video, multi-keyframe conditioning, video-to-video, video extension,
 * the multi-scale two-pass pipeline, and the STG/CFG guidance schedules.
 */
import { McpConnection } from './client.js';
import { DEFAULT_LTX_MODEL, normalizeReferences } from '../pipeline/ltx.js';

export class LtxClient {
  /**
   * @param {object} config VideoForge config (uses config.ltxMcp + config.ltx)
   * @param {object} [options] { logger }
   */
  constructor(config, { logger = null } = {}) {
    this.config = config;
    this.logger = logger;
    this.connection = new McpConnection('ltx-video', config.ltxMcp, {
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
   * Is LTX-Video actually usable behind the MCP server?
   *
   * Returns `{ok, detail}` rather than throwing, so `backend: auto` can decide -
   * exactly like the ComfyUI adapter. `ok` is only true when the Python package
   * imports *and* a preset is available, because a server that boots but has no
   * model installed cannot render anything.
   */
  async health() {
    try {
      await this.connect();
      const health = await this.connection.callJson('ltx_video_health', {}, { timeoutMs: 120000 });

      const models = health.configs ?? [];
      return {
        ok: Boolean(health.ok) && models.length > 0,
        detail: {
          device: health.device ?? 'unknown',
          name: health.name ?? null,
          vramGb: health.vram_gb ?? null,
          torch: health.torch ?? null,
          version: health.ltx_video_version ?? null,
          python: health.python ?? null,
          modelDir: health.model_dir ?? null,
          presets: models.length,
          defaultModel: health.default_model ?? DEFAULT_LTX_MODEL,
          error: health.error ?? null,
          hint: health.hint ?? null,
          raw: health,
        },
      };
    } catch (error) {
      return { ok: false, detail: { error: error.message }, stderr: this.connection.stderr };
    }
  }

  /** The bundled pipeline presets, with whether their weights are already local. */
  async listModels() {
    try {
      const result = await this.connection.callJson(
        'ltx_video_list_models',
        {},
        { timeoutMs: 120000 },
      );
      return { models: result.models ?? [], error: result.error ?? null };
    } catch (error) {
      return { models: [], error: error.message };
    }
  }

  /**
   * Pre-fetch a checkpoint (and its spatial upscaler) from Hugging Face, so the
   * first real render does not spend minutes downloading.
   */
  async downloadModel({ model = DEFAULT_LTX_MODEL } = {}) {
    const result = await this.connection.call(
      'ltx_video_download_model',
      { model },
      { timeoutMs: this.config.timeouts.toolCallMs },
    );
    return result.json ?? { error: result.text };
  }

  /**
   * Inspect a reference file (image or video) through the server, which knows
   * how to count frames. Returns `{ok: false}` when the call fails.
   */
  async referenceInfo(path) {
    try {
      return await this.connection.callJson(
        'ltx_video_reference_info',
        { path },
        { timeoutMs: 120000 },
      );
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /**
   * Render a video with LTX-Video.
   *
   * `references` is the upload-friendly shape: `[{path, strength, startFrame}]`.
   * It is normalised here (so a bad upload fails before the model loads) and
   * then fanned out into the three parallel lists LTX-Video expects.
   *
   * @param {object} req
   * @param {string} req.prompt           The generation prompt.
   * @param {string} [req.outputPath]     Directory to write the video into.
   * @param {Array<object>} [req.references] Conditioning images/videos.
   * @returns {Promise<object>} the server's JSON report, plus the output path.
   */
  async generate({
    prompt,
    negativePrompt,
    outputPath,
    model,
    height,
    width,
    numFrames,
    frameRate,
    seed,
    precision,
    sampler,
    stgMode,
    enhancePrompt,
    offloadToCpu,
    imageCondNoiseScale,
    inputMediaPath,
    references = [],
  } = {}) {
    if (!prompt || !String(prompt).trim()) {
      throw new Error('generate() needs a non-empty `prompt`.');
    }

    const conditioning = normalizeReferences(references, { numFrames });

    const args = {
      prompt: String(prompt),
      model: model ?? this.config.ltx.model ?? DEFAULT_LTX_MODEL,
      height,
      width,
      num_frames: numFrames,
      frame_rate: frameRate ?? this.config.fps,
      offload_to_cpu: Boolean(offloadToCpu ?? this.config.ltx.offloadToCpu),
      image_cond_noise_scale: imageCondNoiseScale ?? this.config.ltx.imageCondNoiseScale,
    };
    if (outputPath) args.output_path = outputPath;
    if (negativePrompt) args.negative_prompt = negativePrompt;
    if (seed !== undefined && seed !== null) args.seed = Math.trunc(Number(seed));
    if (precision) args.precision = precision;
    if (sampler) args.sampler = sampler;
    if (stgMode) args.stg_mode = stgMode;
    if (enhancePrompt !== undefined && enhancePrompt !== null) {
      args.enhance_prompt = Boolean(enhancePrompt);
    }
    if (inputMediaPath) args.input_media_path = inputMediaPath;

    if (conditioning.paths.length > 0) {
      args.conditioning_media_paths = conditioning.paths;
      args.conditioning_strengths = conditioning.strengths;
      args.conditioning_start_frames = conditioning.startFrames;
    }

    for (const warning of conditioning.warnings) {
      this.logger?.warn?.(`ltx: ${warning}`);
    }

    const result = await this.connection.call('ltx_video_generate', args, {
      timeoutMs: this.config.timeouts.toolCallMs,
    });

    const data = result.json;
    if (!data || data.ok !== true) {
      throw new Error(
        `LTX-Video generation failed: ${data?.error ?? result.text?.slice(0, 800) ?? 'unknown error'}`,
      );
    }

    return { ...data, conditioning: conditioning.references, warnings: conditioning.warnings };
  }

  async close() {
    await this.connection.close();
  }
}

export default LtxClient;

