# Deploying VideoForge on Render

VideoForge is three things: a Node web app, a Python/PyTorch TTS engine, and a
diffusion backend. On Render:

| Piece | Where it runs | Notes |
| --- | --- | --- |
| Web UI + API + narration + ffmpeg | **`videoforge` web service** (this repo's `Dockerfile`) | Node 20 + Python 3.11 + ffmpeg in one image; the Kokoro venv and model are baked in |
| ComfyUI (diffusion) | **Your choice** — see "Connecting ComfyUI" below | Not fixed by the blueprint; pick a tunnel to your PC, a Render GPU service, or any GPU cloud |
| Finished videos | **Persistent disk** mounted at `/data` | Survives redeploys on paid plans |

> **Hardware reality check:** narration is CPU-cheap, but *diffusion is not*.
> The free 512 MB plan will OOM on PyTorch, and CPU-only instances render
> minutes per frame. Plan for **at least 2 GB RAM** (Standard) for the web
> service, and a **GPU instance** for ComfyUI if you want real 4K renders.

## Option A — Blueprint deploy (recommended)

1. Fork or use the repo as-is: `https://github.com/StephanFWard/VideoForge`
2. Click:

   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

   (or in the Render dashboard: **New → Blueprint**, pick the repo — Render
   reads `render.yaml` at the root automatically.)
3. When prompted for **`COMFYUI_URL`**, enter one of:
   - `http://videoforge-comfyui:8188` if you also uncommented the ComfyUI
     service in `render.yaml`, or
   - your cloudflared tunnel URL (Option B2 below), or
   - leave it and set it later in **Environment** — the app boots either way
     and `doctor`/`/api/health` will tell you what is missing.
4. Deploy. First build takes a while (PyTorch + model warm-up are baked into
   the image, so *deploys* are slow but *cold starts* stay fast).

## Option B — Manual dashboard setup

1. **New → Web Service**, connect the repo, runtime **Docker**.
2. Dockerfile path: `./Dockerfile`, instance **Standard (2 GB)** or larger,
   health check path `/api/health`.
3. Optional: **Disks → Add disk**, mount at `/data`, 5 GB.
4. Environment variables (minimum set):

| Variable | Value | Purpose |
| --- | --- | --- |
| `COMFYUI_URL` | see "Connecting ComfyUI" | the diffusion backend |
| `VIDEO_FORGE_BACKEND` | `comfy` | require ComfyUI (use `auto` to fall back to mock visuals) |
| `RESOLUTION` | `1080p` | delivery resolution (4k works, costs CPU time) |
| `VIDEO_FORGE_OUT` | `/data/output` | finished videos on the disk |
| `VIDEO_FORGE_WORK` | `/data/work` | scratch space on the disk |
| `KOKORO_VOICE` | `af_heart` | narration voice |
| `VIDEO_FORGE_STEPS` | `25` | fewer = faster on CPU |

## Connecting ComfyUI

### 1. Run ComfyUI on Render itself (all-cloud)

Uncomment the `videoforge-comfyui` service in `render.yaml` (image:
`docker/comfyui.Dockerfile` — clones ComfyUI, installs torch, bakes the SD 1.5
checkpoint, serves on `:8188`). Then set:

```
COMFYUI_URL=http://videoforge-comfyui:8188
```

That hostname works because Render puts all services in one region on a
private network. For usable speed, switch that service's instance type to a
**GPU plan** in the dashboard and swap the CPU torch wheels in
`docker/comfyui.Dockerfile` for CUDA ones (the line to change is marked in the
file).

### 2. Tunnel to your own machine (free, uses your GPU)

Run ComfyUI locally, then expose it:

```bash
cloudflared tunnel --url http://localhost:8188
# -> https://some-random-words.trycloudflare.com
```

Set `COMFYUI_URL=https://some-random-words.trycloudflare.com` on the Render
service. The web app and narration run on Render; diffusion happens on your
hardware. The tunnel URL changes on restart — update the env var (or use a
named cloudflared tunnel for a stable URL).

### 3. Any other GPU provider

Anything that speaks the ComfyUI HTTP API works — RunPod, Vast.ai, a Colab
tunnel, your homelab. Same one-variable hookup.

## Verify the deployment

```bash
curl https://YOUR-SERVICE.onrender.com/api/health
# {"ok":true,"comfy":{"ok":true,...},"kokoro":{"ok":true,...},"ffmpeg":true,...}
```

Then open the service URL, type a topic, and hit **Generate video**. Watch the
Render logs — the same pipeline log lines from local runs appear there. Note
that `/api/health` intentionally returns HTTP 200 even when ComfyUI is
unreachable (with `comfy.ok: false`), so health checks don't flap while you
wire up the backend.

## Limits, costs, gotchas

- **Free plan**: works for browsing the UI and `mock` renders; real Kokoro
  inference needs more RAM. Persistent disks also require a paid plan.
- **Disk**: without it, `output/` lives in the container's ephemeral layer and
  disappears on every deploy.
- **Cold starts**: free/starter plans spin down; the first request after idle
  pays a full boot (the venv/model are baked in, so it is seconds, not minutes).
- **Concurrency**: one render at a time (the app serialises renders); scale up
  the instance rather than running parallel renders.
- **Timeouts**: a 6-scene 4K render is minutes of CPU — fine for web service
  requests because `POST /api/generate` returns immediately and progress
  streams over SSE.

## Local test of the image

```bash
docker build -t videoforge .
docker run -p 10000:10000 -e COMFYUI_URL=http://host.docker.internal:8188 videoforge
# open http://localhost:10000
```
