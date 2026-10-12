# VideoForge

<img width="1631" height="658" alt="image" src="https://github.com/user-attachments/assets/20af843f-3211-481c-b0da-0beed485e3c5" />


**Turn any topic into a finished narrated video — entirely on your own machine.**

VideoForge is a local AI video generator. Give it a topic (or a hand-written
storyboard), and it writes the script, generates every visual through the
**ComfyUI MCP** or **LTX-Video MCP** server, narrates it through a **Kokoro TTS
MCP** server, and cuts everything together with **ffmpeg** — up to a 4K delivery
file. No API keys, no cloud, no per-render cost.

```
topic ──▶ planner ──▶ ComfyUI / LTX-Video MCP ──▶ Kokoro MCP (narration) ──▶ ffmpeg ──▶ video
                           ▲
              reference images / videos (optional)
```

## Highlights

- **Any topic → storyboard → video.** A deterministic template planner writes a
  hook / body / outro script and per-scene image prompts, or you supply your own
  storyboard JSON for full control.
- **Real diffusion visuals.** Keyframes are rendered through the ComfyUI MCP
  server (any SD checkpoint), then animated with an image-to-video model when
  one is installed, or a Ken Burns push when it is not. The bundled
  **LTX-Video MCP** server instead renders video diffusion locally (GPU,
  Apple MPS or CPU) with no ComfyUI at all.
- **Condition on your own media.** Upload a reference image or video in the
  web UI — or pass `--reference ./clip.mp4` on the CLI — and LTX-Video renders
  *from* it: image-to-video, multi-keyframe conditioning, clip continuation,
  each with its own strength (0–1) and start frame.
- **Real narration.** Kokoro-82M text-to-speech runs locally through the bundled
  Kokoro MCP server (`mcp-servers/kokoro-tts`), with 50+ voices.
- **Graceful degradation ladder.** The `auto` backend probes ComfyUI, then
  LTX-Video, then falls back to offline placeholder footage — the video still
  ships. Every scene's backend and method is recorded in the run manifest.
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
| ComfyUI     | any local instance, or `npm run setup:comfyui`                 |
| LTX-Video   | optional — `npm run setup:ltx` for local video diffusion       |

## Quick start

```bash
npm install              # node deps (express, MCP SDK)
npm run setup:kokoro     # creates .venv + installs kokoro & the MCP SDK
npm run setup:ltx        # creates .venv-ltx + LTX-Video (local video diffusion)
npm run setup:comfyui    # clones ComfyUI into vendor/ + venv + starter checkpoint

# …or start an existing ComfyUI yourself (example: CPU mode, port 8188)
#   python main.py --cpu --port 8188     (from your ComfyUI checkout)

npm run doctor           # verifies ffmpeg, the MCP servers, everything
```

### Render from the CLI

```bash
npm run forge -- "how to cold brew coffee" --scenes 5
npm run forge -- --storyboard my-video.storyboard.json --resolution 4k
npm run forge -- "a 60 second pitch for my app" --resolution 1080p --voice am_michael
```

Useful flags: `--resolution 720p|1080p|4k`, `--scenes <n>`, `--voice <name>`,
`--steps <n>` (fewer = much faster on CPU), `--backend auto|comfy|ltx|mock`,
`--reference <path>` (repeatable), `--plan-only`, `--json`.

### Render from the web UI

```bash
npm start                # http://localhost:4321
```

The UI exposes the same pipeline: type a topic, pick resolution/voice,
optionally upload **reference images or videos** (LTX-Video conditions the
render on them), hit **Generate video** and watch the log stream live
(server-sent events). Finished renders appear in the gallery below with
thumbnails, inline playback and a **Delete** button that removes the run's
files from disk (with a confirmation, and only once the render has finished).
`GET /api/health`, `POST /api/generate`, `GET /api/runs` and
`DELETE /api/runs/:id` — plus `POST /api/references` for raw-body uploads —
are plain JSON if you want to script the service instead.

### Condition on a reference image or video

LTX-Video can render *from* your own media — an image to animate, or a clip to
continue:

```bash
npm run forge -- "animate my product" --backend ltx --reference ./product.png
npm run forge -- "continue this clip"  --backend ltx --reference ./shot.mp4 --reference-start 60
```

In the web UI, use the **References** control to upload one or more images or
videos (png, jpg, jpeg, webp, bmp, tiff / mp4, mov, avi, mkv, webm, m4v). Each
reference carries a strength (0–1, how strictly it is obeyed) and a start
frame, and uploads are stored under `work/references/<run>/` — nothing ever
leaves your machine. The CLI equivalents are `--reference-strength` and
`--reference-start` (one value applied to every reference, or a
comma-separated list matched positionally).

## Configuration

Everything is configured through environment variables (or a `.env` file — see
`.env.example`):

| Variable              | Default                  | Purpose                          |
| --------------------- | ------------------------ | -------------------------------- |
| `COMFYUI_URL`         | `http://127.0.0.1:8188`  | ComfyUI instance to render with  |
| `VIDEO_FORGE_BACKEND` | `auto`                   | `auto` / `comfy` / `ltx` / `mock` |
| `RESOLUTION`          | `4k`                     | delivery resolution              |
| `VIDEO_FORGE_STEPS`   | `25`                     | diffusion steps                  |
| `KOKORO_VOICE`        | `af_heart`               | narration voice                  |
| `KOKORO_MCP_COMMAND`  | bundled venv python      | custom Kokoro MCP server command |
| `COMFYUI_MCP_COMMAND` | `npx comfyui-mcp@latest` | custom ComfyUI MCP server        |
| `LTX_MCP_COMMAND`     | bundled .venv-ltx python | custom LTX-Video MCP server      |
| `LTX_MODEL`           | `ltxv-2b-0.9.8-distilled.yaml` | LTX-Video pipeline preset  |
| `VIDEO_FORGE_MAX_REFERENCES` | `8`             | cap on uploaded references       |
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
- **LTX-Video MCP** — a bundled Python MCP server (`mcp-servers/ltx-video`)
  that renders video diffusion locally (GPU, Apple MPS or CPU), run with its
  own uv-managed `.venv-ltx`. It is the backend that consumes uploaded
  reference images/videos as conditioning.

You can also register any of these servers in a Cline-style MCP settings file
and point `COMFYUI_MCP_COMMAND` / `KOKORO_MCP_COMMAND` / `LTX_MCP_COMMAND` at
them — VideoForge is a normal MCP client and does not care who launched the
server.

## Deploying to Render

VideoForge ships as a single Docker image (Node + Python/Kokoro + ffmpeg) and a
Render Blueprint:

```bash
docker build -t videoforge . && docker run -p 10000:10000 videoforge
```

or deploy straight to Render — the repo root has a `render.yaml` blueprint:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

Point `COMFYUI_URL` at your diffusion backend (a Render GPU service, a tunnelled
local machine, or any cloud GPU). Full instructions, sizing guidance and
gotchas: **[docs/deploy-render.md](docs/deploy-render.md)**.

## Testing

```bash
npm test                       # planner, MCP parsing, references, Kokoro contract
npm run doctor                 # live dependency + MCP server checks
npm run forge -- "any topic" --plan-only   # inspect a storyboard without rendering

# live web API smoke test, with a server already listening:
VIDEO_FORGE_BACKEND=mock node src/cli.js serve --port 4399 &
node scripts/smoke-server.js 4399
```

The pipeline itself is backend-switchable (`VIDEO_FORGE_BACKEND=mock`), so the
whole forge path can be exercised without a GPU or network.


## Repository layout

```
src/
  cli.js               CLI (forge / plan / doctor / voices / connect / serve)
  server.js            express web UI + JSON API + SSE progress
  config.js            env-driven configuration
  pipeline/            forge orchestrator, planner, visuals, audio, assembly,
                       references (upload → conditioning)
  mcp/                 MCP client + ComfyUI, LTX-Video and Kokoro adapters
  util/                logging, fs, ffmpeg helpers
mcp-servers/kokoro-tts bundled Kokoro TTS MCP server (Python)
mcp-servers/ltx-video  bundled LTX-Video MCP server (Python)
scripts/               setup + smoke scripts (setup:kokoro / ltx / comfyui)
public/                web UI (single page, no build step)
test/                  node:test suites
```

## License

MIT
