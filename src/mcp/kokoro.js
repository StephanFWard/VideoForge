/**
 * Kokoro MCP adapter (narration).
 *
 * Wraps the Kokoro TTS MCP server for the rest of the app. The tool name and
 * argument names are *discovered* from the server's own schema rather than
 * hard-coded, so swapping the bundled server for a third-party Kokoro MCP
 * (mberg/kokoro-tts-mcp, giannisanni/kokoro-tts-mcp, ...) keeps working.
 */
import { McpConnection } from './client.js';

/** Tool names we prefer, best first. */
const TTS_TOOL_CANDIDATES = [
  'text_to_speech',
  'kokoro_text_to_speech',
  'generate_speech',
  'generate_audio',
  'synthesize_speech',
  'speak',
  'tts',
];

/** Fallback matcher for servers that name their tool something exotic. */
const TTS_TOOL_MATCHER = (tool) => {
  const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
  if (/list|health|status|voices$/.test(tool.name)) return false;
  return /speech|tts|synthes|narration|speak|voice/.test(haystack);
};

/** Argument aliases, so one call shape fits many servers. */
const ARG_ALIASES = {
  text: ['text', 'input', 'prompt', 'message', 'content', 'script'],
  voice: ['voice', 'speaker', 'voice_id', 'voiceId'],
  speed: ['speed', 'rate', 'speed_ratio', 'length_scale'],
  outputPath: ['output_path', 'outputPath', 'output_file', 'file_path', 'filename', 'path', 'save_path'],
  format: ['output_format', 'format', 'response_format', 'audio_format'],
  lang: ['lang', 'language', 'lang_code'],
};

/** Pick the first alias the tool's schema actually declares. */
function pickArg(schema, aliases) {
  const props = schema?.properties ?? {};
  return aliases.find((alias) => Object.prototype.hasOwnProperty.call(props, alias)) ?? null;
}

export class KokoroNarration {
  /**
   * @param {object} config VideoForge config (uses config.kokoroMcp + config.kokoro)
   * @param {object} [options] { logger }
   */
  constructor(config, { logger = null } = {}) {
    this.config = config;
    this.logger = logger;
    this.connection = new McpConnection('kokoro', config.kokoroMcp, {
      logger,
      timeoutMs: config.timeouts.toolCallMs,
    });
    this.ttsTool = null;
    this.argMap = null;
  }

  async connect() {
    await this.connection.connect();
    return this;
  }

  /** Resolve (once) the synthesize tool and its argument names. */
  async resolveTool() {
    if (this.ttsTool) return { tool: this.ttsTool, args: this.argMap };

    const tool = await this.connection.findTool(TTS_TOOL_CANDIDATES, TTS_TOOL_MATCHER);
    if (!tool) {
      const available = await this.connection.listToolNames();
      throw new Error(
        'The Kokoro MCP server exposes no text-to-speech tool. ' +
          `Available tools: ${available.join(', ') || '(none)'}`,
      );
    }

    const schema = tool.inputSchema ?? {};
    const args = {
      text: pickArg(schema, ARG_ALIASES.text),
      voice: pickArg(schema, ARG_ALIASES.voice),
      speed: pickArg(schema, ARG_ALIASES.speed),
      outputPath: pickArg(schema, ARG_ALIASES.outputPath),
      format: pickArg(schema, ARG_ALIASES.format),
      lang: pickArg(schema, ARG_ALIASES.lang),
    };

    if (!args.text) {
      throw new Error(
        `The text-to-speech tool "${tool.name}" declares no text-like input. ` +
          `Its inputs are: ${Object.keys(schema.properties ?? {}).join(', ')}`,
      );
    }

    this.ttsTool = tool;
    this.argMap = args;
    this.logger?.debug?.(`kokoro: using tool "${tool.name}"`);
    return { tool, args };
  }

  /** Readiness probe used by `video-forge doctor`. */
  async health() {
    await this.connect();
    const health = await this.connection.findTool(['kokoro_health', 'health', 'status']);
    if (health) {
      try {
        return await this.connection.callJson(health.name);
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
    return { ok: true, note: 'server has no health tool; tools were listed successfully' };
  }

  /** List voices (works with the bundled server; optional for others). */
  async voices(lang) {
    await this.connect();
    const tool = await this.connection.findTool(['list_voices', 'voices', 'list_speakers']);
    if (!tool) return null;
    const props = tool.inputSchema?.properties ?? {};
    const langArg = pickArg(tool.inputSchema, ARG_ALIASES.lang);
    const args = langArg && lang && Object.prototype.hasOwnProperty.call(props, langArg)
      ? { [langArg]: lang }
      : {};
    return this.connection.callJson(tool.name, args);
  }

  /**
   * Render narration for one line of script to an audio file.
   *
   * @param {object} req { text, outputPath, voice, speed, lang, format }
   * @returns {Promise<{path:string, durationSeconds:number|null, voice:string, format:string}>}
   */
  async speak({ text, outputPath, voice, speed, lang, format = 'wav' } = {}) {
    if (!text || !String(text).trim()) {
      throw new Error('speak() needs non-empty `text`.');
    }
    const { tool, args } = await this.resolveTool();

    const payload = {};
    if (args.text) payload[args.text] = text;
    if (args.voice && voice) payload[args.voice] = voice;
    if (args.speed && speed !== undefined && speed !== null) payload[args.speed] = speed;
    if (args.outputPath && outputPath) payload[args.outputPath] = outputPath;
    if (args.format && format) payload[args.format] = format;
    if (args.lang && lang) payload[args.lang] = lang;

    const result = await this.connection.call(tool.name, payload);
    const data = result.json ?? {};

    const resolved =
      data.absolute_path ??
      data.path ??
      data.output_path ??
      data.file ??
      extractPath(result.text) ??
      outputPath ??
      null;

    if (!resolved) {
      throw new Error(
        `The Kokoro MCP server (${tool.name}) did not report an output path.\n` +
          result.text.slice(0, 800),
      );
    }

    const duration = Number(
      data.duration_seconds ?? data.duration ?? data.length_seconds ?? data.seconds ?? 0,
    );

    return {
      path: resolved,
      durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      voice: data.voice ?? voice ?? this.config.kokoro.voice,
      format: data.format ?? format,
      raw: data,
    };
  }

  async close() {
    await this.connection.close();
  }
}

/** Last-resort path extraction for servers that only print a filename. */
export function extractPath(text) {
  if (!text) return null;
  const match = String(text).match(/["'`]?([^"'`\s]+\.(?:wav|mp3|flac|ogg|m4a))["'`]?/i);
  return match ? match[1] : null;
}

export default KokoroNarration;