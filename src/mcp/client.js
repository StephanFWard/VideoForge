/**
 * A thin, fail-loud wrapper around an MCP stdio server.
 *
 * VideoForge is an MCP *client*: the ComfyUI MCP server and the Kokoro MCP
 * server are both driven over this one class, which is why the video pipeline
 * and the audio pipeline feel identical to the rest of the app.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MAX_STDERR = 8000;

export class McpConnection {
  /**
   * @param {string} name      Human label, e.g. "comfyui".
   * @param {object} spec      { command, args, cwd, env }
   * @param {object} [options] { logger, timeoutMs }
   */
  constructor(name, spec, { logger = null, timeoutMs = 45 * 60 * 1000 } = {}) {
    this.name = name;
    this.spec = spec;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.client = null;
    this.transport = null;
    this.toolList = null;
    this.stderr = '';
    this.lastError = null;
  }

  get connected() {
    return Boolean(this.client);
  }

  /** Spawn the server and complete the MCP initialize handshake. */
  async connect() {
    if (this.client) return this;

    const transport = new StdioClientTransport({
      command: this.spec.command,
      args: this.spec.args ?? [],
      cwd: this.spec.cwd,
      // The SDK's default environment is a deliberately tiny allow-list
      // (HOME/PATH/...), which would silently drop HF_TOKEN, COMFYUI_URL and
      // friends. Pass the real environment through on purpose.
      env: { ...process.env, ...(this.spec.env ?? {}) },
      stderr: 'pipe',
    });

    // Keep recent stderr: when a server fails to boot, its own explanation is
    // far more useful than a generic "connection closed".
    transport.stderr?.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-MAX_STDERR);
    });

    const client = new Client(
      { name: 'video-forge', version: '1.0.0' },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
    } catch (error) {
      const detail = this.stderr.trim();
      this.lastError = error;
      throw new Error(
        `Could not start the "${this.name}" MCP server ` +
          `(${this.spec.command} ${(this.spec.args ?? []).join(' ')}): ${error.message}` +
          (detail ? `\n--- server stderr ---\n${detail}` : ''),
      );
    }

    this.client = client;
    this.transport = transport;
    return this;
  }

  /** Cached tools/list. */
  async listTools(force = false) {
    if (this.toolList && !force) return this.toolList;
    await this.connect();
    const { tools } = await this.client.listTools(undefined, {
      timeout: 120000,
      maxTotalTimeout: 120000,
    });
    this.toolList = tools ?? [];
    return this.toolList;
  }

  async listToolNames() {
    return (await this.listTools()).map((t) => t.name);
  }

  async hasTool(name) {
    return (await this.listToolNames()).includes(name);
  }

  /**
   * Find a tool by exact name, or by a predicate over name/description.
   * Used so the Kokoro adapter also works against third-party TTS MCP servers
   * whose tool names we cannot know in advance.
   */
  async findTool(candidates, matcher) {
    const tools = await this.listTools();
    for (const candidate of candidates) {
      const hit = tools.find((t) => t.name === candidate);
      if (hit) return hit;
    }
    if (matcher) {
      const hits = tools.filter((t) => matcher(t));
      // Deterministic pick: shortest name wins, so `tts` beats `tts_preview`.
      hits.sort((a, b) => a.name.length - b.name.length);
      if (hits.length) return hits[0];
    }
    return null;
  }

  /**
   * Call an MCP tool and normalise the response.
   *
   * The SDK defaults every request to a 60s timeout, which is far too short for
   * a diffusion render, so an explicit per-request timeout is always supplied.
   * @returns {Promise<{ok: true, text: string, json: any, raw: object}>}
   */
  async call(name, args = {}, { timeoutMs = this.timeoutMs } = {}) {
    await this.connect();

    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    });

    const text = (result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    if (result.isError) {
      throw new Error(`Tool "${name}" on "${this.name}" failed: ${text || 'unknown error'}`);
    }

    return { ok: true, text, json: tryParseJson(text), raw: result };
  }

  /**
   * Call a tool and require a JSON payload back.
   * MCP tool results carry text; our own servers emit JSON there.
   */
  async callJson(name, args = {}, options = {}) {
    const result = await this.call(name, args, options);
    if (result.json === undefined || result.json === null) {
      throw new Error(
        `Tool "${name}" on "${this.name}" did not return JSON. Raw output:\n` +
          result.text.slice(0, 1500),
      );
    }
    return result.json;
  }

  async close() {
    try {
      await this.client?.close();
    } catch {
      /* shutting down is best-effort */
    } finally {
      this.client = null;
      this.transport = null;
      this.toolList = null;
    }
  }
}

/** Tolerant JSON extraction: servers often wrap JSON in prose or code fences. */
export function tryParseJson(text) {
  if (!text) return undefined;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to extraction */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const first = trimmed.search(/[[{]/);
  const last = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* give up */
    }
  }
  return undefined;
}

export default McpConnection;