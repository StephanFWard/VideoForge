# VideoForge

**Turn any topic into a finished narrated video — entirely on your own machine.**

VideoForge is a local AI video generator. Give it a topic (or a hand-written
storyboard), and it writes the script, generates every visual through the
**ComfyUI MCP** server, narrates it through a **Kokoro TTS MCP** server, and
cuts everything together with **ffmpeg** — up to a 4K delivery file. No API
keys, no cloud, no per-render cost.

```
topic ──▶ planner ──▶ ComfyUI MCP (keyframe + motion) ──▶ Kokoro MCP (narration) ──▶ ffmpeg ──▶ video
```

## Highlights

- **Any topic → storyboard → video.** A deterministic template planner writes a
  hook / body / outro script and per-scene image prompts, or you supply your own
  storyboard JSON for full control.
- **Real diffusion visuals.** Keyframes are rendered through the ComfyUI MCP
  server (any SD checkpoint), then animated with an image-to-video model when
  one is installed, or a Ken Burns push when it is not.
- **Real narration.** Kokoro-82M text-to-speech runs locally through the bundled
  Kokoro MCP server (`mcp-servers/kokoro-tts`), with 50+ voices.
- **Graceful degradation ladder.** ComfyUI down? Visuals fall back to offline
  placeholder footage and the video still ships. Every scene's backend and
  method is recorded in the run manifest.
- **4K delivery.** Scenes are diffused small (fast), cut at 1080p, then
  upscaled once to the delivery resolution.
- **CLI + web UI.** `video-forge forge "…"` from a terminal, or `video-forge
  serve` and drive the exact same pipeline from the browser with live progress.
- **Transparent runs.** Every render writes `manifest.json` with the storyboard,
  backend, per-scene methods, narration timings and output metadata.

## Requirements

| Component   | Notes                                                          |
| ----------- | -------------------------------------------------------------- |
| Node.js     | ≥ 20.11                                                        |
| ffmpeg      | on PATH, or `FFMPEG_PATH` / `FFPROBE_PATH` env vars            |
| Python 3.11 | for the Kokoro MCP server (uv-managed venv is created for you) |
| [uv](https://docs.astral.sh/uv/) | installs the Kokoro Python deps           |
| ComfyUI     | any local instance (`--cpu` works, GPU is much faster)         |

## Quick start

```bash
npm install              # node deps (express, MCP SDK)
npm run setup:kokoro     # creates .venv + installs kokoro & the MCP SDK

# start ComfyUI somewhere (example: CPU mode, port 8188)
#   python main.py --cpu --port 8188     (from your ComfyUI checkout)

npm run doctor           # verifies ffmpeg, both MCP servers, everything
```

### Render from the CLI

```bash
npm run forge -- "how to cold brew coffee" --scenes 5
npm run forge -- --storyboard my-video.storyboard.json --resolution 4k
npm run forge -- "a 60 second pitch for my app" --resolution 1080p --voice am_michael
```

Useful flags: `--resolution 720p|1080p|4k`, `--scenes <n>`, `--voice <name>`,
`--steps <n>` (fewer = much faster on CPU), `--plan-only`, `--json`.

### Render from the web UI

```bash
npm start                # http://localhost:4321
```

The UI exposes the same pipeline: type a topic, pick resolution/voice, hit
**Generate video** and watch the log stream live (server-sent events). Finished
renders appear in the gallery below with thumbnails, inline playback and a
**Delete** button that removes the run's files from disk (with a confirmation,
and only once the render has finished). `GET /api/health`, `POST /api/generate`,
`GET /api/runs` and `DELETE /api/runs/:id` are plain JSON if you want to script
the service instead.

## Configuration

Everything is configured through environment variables (or a `.env` file — see
`.env.example`):

| Variable              | Default                  | Purpose                          |
| --------------------- | ------------------------ | -------------------------------- |
| `COMFYUI_URL`         | `http://127.0.0.1:8188`  | ComfyUI instance to render with  |
| `VIDEO_FORGE_BACKEND` | `auto`                   | `auto` / `comfy` / `mock`        |
| `RESOLUTION`          | `4k`                     | delivery resolution              |
| `VIDEO_FORGE_STEPS`   | `25`                     | diffusion steps                  |
| `KOKORO_VOICE`        | `af_heart`               | narration voice                  |
| `KOKORO_MCP_COMMAND`  | bundled venv python      | custom Kokoro MCP server command |
| `COMFYUI_MCP_COMMAND` | `npx comfyui-mcp@latest` | custom ComfyUI MCP server        |
| `VIDEO_FORGE_OUT`     | `./output`               | finished videos                  |
| `FFMPEG_PATH`         | `ffmpeg`                 | ffmpeg binary                    |

## MCP servers

VideoForge speaks MCP end-to-end:

- **ComfyUI MCP** — the published `comfyui-mcp` npm server, launched per run and
  pointed at your ComfyUI. Point `COMFYUI_URL` at a remote or tunnelled ComfyUI
  (e.g. a free cloud GPU exposed with `cloudflared tunnel --url
  http://localhost:8188`) and VideoForge renders there without code changes.
- **Kokoro MCP** — a bundled Python MCP server (`mcp-servers/kokoro-tts`) that
  exposes health, voice listing and per-scene TTS over stdio, run with the
  repo's uv-managed `.venv`.

You can also register both servers in a Cline-style MCP settings file and point
`COMFYUI_MCP_COMMAND` / `KOKORO_MCP_COMMAND` at them — VideoForge is a normal
MCP client and does not care who launched the server.

## Testing

```bash
npm test                       # planner, MCP parsing, Kokoro server contract
npm run doctor                 # live dependency + MCP server checks
npm run forge -- "any topic" --plan-only   # inspect a storyboard without rendering
```

The pipeline itself is backend-switchable (`VIDEO_FORGE_BACKEND=mock`), so the
whole forge path can be exercised without a GPU or network.


## Repository layout

```
src/
  cli.js               CLI (forge / plan / doctor / voices / connect / serve)
  server.js            express web UI + JSON API + SSE progress
  config.js            env-driven configuration
  pipeline/            forge orchestrator, planner, visuals, audio, assembly
  mcp/                 MCP client + ComfyUI and Kokoro adapters
  util/                logging, fs, ffmpeg helpers
mcp-servers/kokoro-tts bundled Kokoro TTS MCP server (Python)
public/                web UI (single page, no build step)
test/                  node:test suites
```

## License

MIT
