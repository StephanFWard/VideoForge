# VideoForge — single-container image for Render.com (or anywhere Docker runs).
#
# One image carries the whole narration + web tier:
#   Node 20            web UI, pipeline orchestration, MCP client
#   Python 3.11        the bundled Kokoro TTS MCP server (+ its venv, baked in)
#   ffmpeg/ffprobe     scene cutting, concat, upscale, thumbnail
#   uv                 fast venv/pip management
# The diffusion backend (ComfyUI) is NOT in this image — point COMFYUI_URL at
# whatever runs it: another Render service (see docker/comfyui.Dockerfile),
# a tunnelled local machine, or any GPU cloud.

FROM node:20-bookworm-slim

# --- system dependencies ----------------------------------------------------
# python3.11 is the Debian 12 default interpreter; ffmpeg is in the repos.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-venv \
        ffmpeg \
        git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# uv — used to build the Kokoro virtualenv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# --- node dependencies (cached layer) ---------------------------------------
COPY package.json ./
RUN npm install --omit=dev

# --- application source -----------------------------------------------------
COPY . .

# --- kokoro venv (baked into the image so cold starts skip the torch download)
RUN uv venv .venv --python 3.11 \
 && uv pip install --python .venv -r mcp-servers/kokoro-tts/requirements.txt

# --- model + tool caches (baked in, so the first render is not the slowest) --
# 1. npx would otherwise download comfyui-mcp on the first MCP spawn.
# 2. kokoro fetches its 82M model and voices from Hugging Face on first use.
# Either step failing should not fail the build — they simply re-run lazily.
ENV HF_HOME=/opt/hf-cache
RUN npx -y comfyui-mcp@latest --help >/dev/null 2>&1 || true
RUN .venv/bin/python -c " \
      from kokoro import KPipeline; \
      p = KPipeline(lang_code='a'); \
      list(p('VideoForge warmup.', voice='af_heart')) \
    " || true

ENV NODE_ENV=production \
    PORT=10000 \
    VIDEO_FORGE_BACKEND=comfy

EXPOSE 10000
CMD ["node", "src/cli.js", "serve"]
