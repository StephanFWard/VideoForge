# ComfyUI backend image — optional companion to the VideoForge web service.
#
# Runs ComfyUI itself. Works on a CPU instance (slow but genuine diffusion) or
# on a Render GPU instance (switch the service's instance type in the dashboard;
# for GPU builds swap the CPU torch wheels for the CUDA ones, see the comment
# below).
#
# The VideoForge web service points at this with:
#   COMFYUI_URL=http://videoforge-comfyui:8188   (Render private network)

FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git ComfyUI
WORKDIR /app/ComfyUI

# CPU torch wheels. On a GPU instance type, replace this line with the CUDA
# wheels instead, e.g.:
#   pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
RUN pip install --no-cache-dir torch torchvision torchaudio \
        --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements.txt

# A working checkpoint baked in, so the very first render does not 404.
# (Swap or add checkpoints under /data/models and expose them with
#  --extra-model-paths-config if you want bigger models.)
RUN mkdir -p models/checkpoints /data/output /data/input \
 && curl -fL -o models/checkpoints/v1-5-pruned-emaonly-fp16.safetensors \
      https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors

# /data is meant to be a Render persistent disk: renders survive redeploys.
EXPOSE 8188
CMD ["python", "main.py", "--listen", "0.0.0.0", "--port", "8188", \
     "--output-directory", "/data/output", "--input-directory", "/data/input"]
