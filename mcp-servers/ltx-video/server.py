#!/usr/bin/env python3
"""
LTX-Video MCP server
====================

A Model Context Protocol server that exposes Lightricks' LTX-Video - a DiT-based
video latent diffusion model - as MCP tools, so VideoForge can render real video
diffusion entirely locally (GPU, Apple MPS or CPU).

This server is a thin, faithful wrapper around the official `ltx_video` package.
Every capability of LTX-Video is reachable from here, because the wrapper drives
the same `InferenceConfig` the upstream `inference.py` CLI uses:

  * text-to-video
  * image-to-video                (condition on one image at a start frame)
  * multi-keyframe conditioning   (several images and/or video segments, each
                                   with its own start frame and strength)
  * video-to-video / extension    (`input_media_path`, plus conditioning a video
                                   segment at any start frame - forward *and*
                                   backward extension both fall out of this)
  * multi-scale rendering         (two-pass pipeline with a latent upsampler)
  * spatiotemporal guidance (STG) and classifier-free guidance schedules
  * distilled / FP8 presets, automatic prompt enhancement

Transport is stdio, so any MCP host can use it directly:

    cline / Claude Desktop / Cursor / VideoForge
        command: .venv-ltx/bin/python
        args:    mcp-servers/ltx-video/server.py

Tools
-----
ltx_video_health          Readiness + runtime report (used by `video-forge doctor`).
ltx_video_list_models     Enumerate the bundled pipeline presets and their settings.
ltx_video_download_model  Pre-fetch a checkpoint / spatial upscaler from Hugging Face.
ltx_video_reference_info  Inspect a reference image or video (size, frames, fps).
ltx_video_generate        Render a video with the full LTX-Video feature set.

Model weights live wherever `LTX_MODEL_DIR` points (or the Hugging Face cache);
nothing is uploaded anywhere - generation is local.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from mcp.server.mcpserver import MCPServer

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CONFIG_DIR = Path(__file__).resolve().parent / "configs"

HF_REPO_ID = "Lightricks/LTX-Video"

#: LTX-Video's temporal compression. Conditioning video segments must contain
#: ``N * 8 + 1`` frames (9, 17, 25, ...) or they are trimmed to that shape.
VIDEO_SCALE_FACTOR = 8

#: The model is tuned for at most this many frames (about 8.5s at 30fps) and for
#: resolutions below 720x1280.
MAX_FRAMES = 257

#: Video containers the model can read as conditioning media.
VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v"}

#: Stills the model can read as conditioning media.
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}

#: Every pipeline preset shipped with this server.
DEFAULT_MODEL = "ltxv-2b-0.9.8-distilled.yaml"

PRECISIONS = ("bfloat16", "float8_e4m3fn", "mixed_precision", "float32")
SAMPLERS = ("from_checkpoint", "uniform", "linear-quadratic")
STG_MODES = ("attention_values", "attention_skip", "residual", "transformer_block")


def model_dir() -> Path | None:
    """Local directory to look for checkpoints in, when the user set one."""
    raw = os.environ.get("LTX_MODEL_DIR", "").strip()
    return Path(raw).expanduser() if raw else None


def available_configs() -> list[str]:
    """The bundled pipeline preset names."""
    if not CONFIG_DIR.is_dir():
        return []
    return sorted(p.name for p in CONFIG_DIR.glob("*.yaml"))


def config_path_for(model: str) -> Path:
    """
    Resolve a preset name (or an explicit .yaml path) to a real file.

    Accepts ``ltxv-2b-0.9.8-distilled`` as well as the full filename, so callers
    never have to remember the ``.yaml`` suffix.
    """
    name = str(model or DEFAULT_MODEL).strip()
    candidate = Path(name).expanduser()
    if candidate.is_file():
        return candidate.resolve()

    if not name.endswith(".yaml"):
        name = f"{name}.yaml"

    bundled = CONFIG_DIR / Path(name).name
    if bundled.is_file():
        return bundled.resolve()

    direct = Path(name).expanduser()
    if direct.is_file():
        return direct.resolve()

    raise ValueError(
        f"Unknown LTX-Video model preset '{model}'. Available presets: "
        f"{', '.join(available_configs()) or '(none found)'}"
    )


def load_pipeline_config(model: str) -> dict[str, Any]:
    """Read a pipeline preset YAML into a plain dict."""
    import yaml  # noqa: PLC0415 - only needed once a render is requested

    with open(config_path_for(model), "r", encoding="utf-8") as handle:
        config = yaml.safe_load(handle) or {}
    if not isinstance(config, dict):
        raise ValueError(f"Pipeline config {model} is not a YAML mapping.")
    return config

def resolve_checkpoint(filename: str | None) -> str | None:
    """
    Point a checkpoint name at a local file when we have one.

    ``LTX_MODEL_DIR`` wins, then the Hugging Face cache. When neither holds the
    file the bare name is returned and the official code downloads it from
    Hugging Face on first use.
    """
    if not filename:
        return None
    name = Path(str(filename)).name
    if Path(str(filename)).is_file():
        return str(Path(str(filename)).resolve())

    directory = model_dir()
    if directory:
        local = directory / name
        if local.is_file():
            return str(local.resolve())

    hf_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    try:
        matches = list(hf_home.glob(f"hub/models--*LTX-Video/snapshots/*/{name}"))
        if matches:
            return str(matches[0].resolve())
    except OSError:
        pass

    return name


def materialise_config(
    config: dict[str, Any],
    out_dir: Path,
    *,
    precision: str | None = None,
    sampler: str | None = None,
    stg_mode: str | None = None,
    enhance_prompt: bool | None = None,
) -> Path:
    """
    Write a runnable pipeline config, applying the caller's overrides.

    The upstream `infer()` re-reads its config from disk, so overrides have to be
    written into a real file. `prompt_enhancement_words_threshold` is the switch:
    0 disables enhancement, and a huge threshold means "enhance every prompt".
    """
    effective = dict(config)
    effective["checkpoint_path"] = (
        resolve_checkpoint(config.get("checkpoint_path")) or config.get("checkpoint_path")
    )

    upscaler = config.get("spatial_upscaler_model_path")
    if upscaler:
        effective["spatial_upscaler_model_path"] = resolve_checkpoint(upscaler)

    if precision:
        effective["precision"] = precision
    if sampler:
        effective["sampler"] = sampler
    if stg_mode:
        effective["stg_mode"] = stg_mode
    if enhance_prompt is True:
        effective["prompt_enhancement_words_threshold"] = 10_000
    elif enhance_prompt is False:
        effective["prompt_enhancement_words_threshold"] = 0

    import yaml  # noqa: PLC0415

    out_dir.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w", suffix=".yaml", delete=False, dir=str(out_dir), encoding="utf-8"
    )
    try:
        yaml.safe_dump(effective, handle, sort_keys=False)
    finally:
        handle.close()
    return Path(handle.name)


def detect_device() -> dict[str, Any]:
    """Which device LTX-Video will run on, and how much room it has."""
    info: dict[str, Any] = {"device": "cpu", "cuda": False, "mps": False, "vram_gb": None}
    try:
        import torch  # noqa: PLC0415
    except Exception as exc:  # pragma: no cover - torch missing
        info["torch"] = f"unavailable: {exc}"
        return info

    info["torch"] = torch.__version__
    try:
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            info.update(
                {
                    "device": "cuda",
                    "cuda": True,
                    "name": props.name,
                    "vram_gb": round(props.total_memory / (1024**3), 1),
                }
            )
        elif torch.backends.mps.is_available():
            info.update({"device": "mps", "mps": True, "name": "Apple Silicon (MPS)"})
    except Exception:  # pragma: no cover - driver problems
        pass
    return info


def inspect_media(path: str) -> dict[str, Any]:
    """
    Describe a reference image or video, in the terms LTX-Video cares about.

    `valid_frames` is the frame count trimmed down to ``N * 8 + 1``, which is what
    a conditioning video segment must contain to be accepted.
    """
    target = Path(path).expanduser()
    if not target.is_file():
        raise ValueError(f"Reference media not found: {path}")

    suffix = target.suffix.lower()
    is_video = suffix in VIDEO_EXTENSIONS
    if not is_video and suffix not in IMAGE_EXTENSIONS:
        raise ValueError(
            f"Unsupported reference media '{target.name}'. Use one of: "
            f"{', '.join(sorted(IMAGE_EXTENSIONS | VIDEO_EXTENSIONS))}"
        )

    result: dict[str, Any] = {
        "ok": True,
        "path": str(target.resolve()),
        "filename": target.name,
        "kind": "video" if is_video else "image",
        "bytes": target.stat().st_size,
    }

    if not is_video:
        from PIL import Image  # noqa: PLC0415

        with Image.open(target) as image:
            result.update(
                {"width": image.width, "height": image.height, "frames": 1, "fps": None}
            )
        result["valid_frames"] = 1
        return result

    import imageio.v2 as imageio  # noqa: PLC0415

    reader = imageio.get_reader(str(target))
    try:
        frames = reader.count_frames()
        meta = reader.get_meta_data() or {}
        fps = meta.get("fps")
        first = reader.get_data(0)
        valid = (frames - 1) // VIDEO_SCALE_FACTOR * VIDEO_SCALE_FACTOR + 1
        result.update(
            {
                "frames": frames,
                "valid_frames": valid,
                "fps": round(float(fps), 3) if fps else None,
                "width": int(first.shape[1]),
                "height": int(first.shape[0]),
                "trimmed": frames != valid,
            }
        )
    finally:
        reader.close()
    return result


def validate_request(request: dict[str, Any]) -> tuple[str, dict[str, Any], Path, dict[str, Any]]:
    """
    Validate a generation request and resolve everything it names.

    Deliberately separate from `run_generation()` so that a bad prompt, an
    unknown preset or a missing upload is rejected *before* torch and diffusers
    are imported - which is a ~10-40s cost on a cold start, and there is no
    reason to pay it to be told a file does not exist.

    Returns ``(prompt, config, out_dir, conditioning)``.
    """
    prompt = str(request.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("`prompt` must contain something to generate.")

    # Raises for an unknown preset name.
    config = load_pipeline_config(str(request.get("model") or DEFAULT_MODEL))

    output_path = request.get("output_path")
    out_dir = (
        Path(str(output_path)).expanduser()
        if output_path
        else Path.cwd() / "ltx-output" / time.strftime("%Y-%m-%d")
    )
    if not out_dir.is_absolute():
        out_dir = Path.cwd() / out_dir

    # Conditioning media: images and/or videos, each with a start frame.
    media_paths = [str(p) for p in (request.get("conditioning_media_paths") or [])]
    strengths = [float(s) for s in (request.get("conditioning_strengths") or [])]
    start_frames = [int(f) for f in (request.get("conditioning_start_frames") or [])]

    if media_paths:
        if not strengths:
            strengths = [1.0] * len(media_paths)
        if not start_frames:
            raise ValueError(
                "`conditioning_start_frames` is required whenever "
                "`conditioning_media_paths` is given (use 0 to condition the first frame)."
            )
        if not (len(media_paths) == len(strengths) == len(start_frames)):
            raise ValueError(
                "`conditioning_media_paths`, `conditioning_strengths` and "
                "`conditioning_start_frames` must all have the same length "
                f"(got {len(media_paths)}, {len(strengths)}, {len(start_frames)})."
            )
        for value in strengths:
            if not 0.0 <= value <= 1.0:
                raise ValueError(
                    f"Conditioning strengths must be between 0 and 1 (got {value})."
                )
        num_frames = int(request.get("num_frames") or 121)
        for frame in start_frames:
            if not 0 <= frame < num_frames:
                raise ValueError(
                    f"Conditioning start frames must be between 0 and {num_frames - 1} "
                    f"(got {frame})."
                )
        # Inspect first so a bad upload fails before a multi-gigabyte model loads.
        for path in media_paths:
            inspect_media(path)

    input_media_path = request.get("input_media_path")
    if input_media_path:
        inspect_media(str(input_media_path))

    conditioning = {
        "paths": media_paths,
        "strengths": strengths,
        "start_frames": start_frames,
    }
    return prompt, config, out_dir, conditioning


def run_generation(request: dict[str, Any]) -> dict[str, Any]:
    """
    Render a video with LTX-Video and report the artefact it produced.

    This is the single entry point every generation path goes through, so the
    full LTX-Video feature set stays reachable from one place.
    """
    prompt, config, out_dir, conditioning = validate_request(request)
    media_paths = conditioning["paths"]
    strengths = conditioning["strengths"]
    start_frames = conditioning["start_frames"]
    model = str(request.get("model") or DEFAULT_MODEL)
    input_media_path = request.get("input_media_path")

    out_dir.mkdir(parents=True, exist_ok=True)

    enhance_prompt = request.get("enhance_prompt")
    config_file = materialise_config(
        config,
        out_dir,
        precision=request.get("precision"),
        sampler=request.get("sampler"),
        stg_mode=request.get("stg_mode"),
        enhance_prompt=None if enhance_prompt is None else bool(enhance_prompt),
    )

    # Imported lazily, and only after validation: torch + diffusers take
    # ~10-40s to import on a cold start.
    from ltx_video.inference import InferenceConfig, infer  # noqa: PLC0415

    inference_config = InferenceConfig(
        prompt=prompt,
        output_path=str(out_dir),
        pipeline_config=str(config_file),
        negative_prompt=str(
            request.get("negative_prompt")
            or "worst quality, inconsistent motion, blurry, jittery, distorted"
        ),
        height=int(request.get("height") or 704),
        width=int(request.get("width") or 1216),
        num_frames=int(request.get("num_frames") or 121),
        frame_rate=int(request.get("frame_rate") or 30),
        seed=int(request.get("seed") if request.get("seed") is not None else 171198),
        offload_to_cpu=bool(request.get("offload_to_cpu", False)),
        image_cond_noise_scale=float(request.get("image_cond_noise_scale", 0.15)),
        input_media_path=str(input_media_path) if input_media_path else None,
        conditioning_media_paths=media_paths or None,
        conditioning_strengths=[float(s) for s in strengths] or None,
        conditioning_start_frames=[int(f) for f in start_frames] or None,
    )

    started = time.time()
    infer(config=inference_config)

    # `infer()` writes its own uniquely-named artefact; find the newest one.
    produced = sorted(
        (p for p in out_dir.iterdir() if p.suffix.lower() in {".mp4", ".png", ".webm"}),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not produced:
        raise RuntimeError(f"LTX-Video reported success but wrote no video to {out_dir}.")

    artefact = produced[0]
    return {
        "ok": True,
        "path": str(artefact.resolve()),
        "filename": artefact.name,
        "kind": "video" if artefact.suffix.lower() != ".png" else "image",
        "bytes": artefact.stat().st_size,
        "model": model,
        "checkpoint": config.get("checkpoint_path"),
        "pipeline_type": config.get("pipeline_type", "base"),
        "device": detect_device()["device"],
        "prompt": prompt,
        "requested": {
            "height": inference_config.height,
            "width": inference_config.width,
            "num_frames": inference_config.num_frames,
            "frame_rate": inference_config.frame_rate,
            "seed": inference_config.seed,
        },
        "conditioning": [
            {"path": p, "strength": s, "start_frame": f}
            for p, s, f in zip(media_paths, strengths, start_frames)
        ]
        or None,
        "input_media_path": str(input_media_path) if input_media_path else None,
        "render_seconds": round(time.time() - started, 2),
    }


# ---------------------------------------------------------------------------
# MCP server + tools
# ---------------------------------------------------------------------------
server = MCPServer(
    name="ltx-video",
    title="LTX-Video",
    version="1.0.0",
    description="Local video latent diffusion (Lightricks LTX-Video): text/image/video to video.",
    instructions=(
        "Video generation with LTX-Video. Call ltx_video_health to confirm the "
        "runtime and weights are ready, ltx_video_list_models to pick a preset, "
        "and ltx_video_reference_info to validate an uploaded image or video "
        "before conditioning on it. Then call ltx_video_generate."
    ),
)


@server.tool(
    name="ltx_video_health",
    title="LTX-Video health",
    description=(
        "Report whether LTX-Video can render, plus device, torch version, VRAM, "
        "the model directory in use and which bundled presets are available."
    ),
)
def ltx_video_health() -> str:
    import platform

    info: dict[str, Any] = {
        "ok": True,
        "package": "ltx-video",
        "configs": available_configs(),
        "default_model": DEFAULT_MODEL,
        "model_dir": str(model_dir()) if model_dir() else None,
        "python": platform.python_version(),
        "platform": f"{platform.system()} {platform.machine()}",
        "video_scale_factor": VIDEO_SCALE_FACTOR,
        "max_frames": MAX_FRAMES,
        "precisions": list(PRECISIONS),
        "samplers": list(SAMPLERS),
        "stg_modes": list(STG_MODES),
    }
    info.update(detect_device())

    try:
        import ltx_video  # noqa: F401, PLC0415

        try:
            from importlib.metadata import version

            info["ltx_video_version"] = version("ltx-video")
        except Exception:  # pragma: no cover
            info["ltx_video_version"] = "installed"
    except Exception as exc:
        info["ok"] = False
        info["ltx_video_version"] = None
        info["error"] = f"ltx_video is not importable: {exc}"
        info["hint"] = (
            "Install it with:  .venv-ltx/Scripts/python -m pip install "
            "mcp-servers/ltx-video/requirements.txt   (or run scripts/setup-ltx.js)"
        )
    return json.dumps(info, indent=2)


@server.tool(
    name="ltx_video_list_models",
    title="List LTX-Video models",
    description=(
        "Enumerate the bundled pipeline presets with their checkpoint, precision, "
        "inference steps, guidance settings and whether the weights are already local."
    ),
)
def ltx_video_list_models() -> str:
    models = []
    for name in available_configs():
        try:
            config = load_pipeline_config(name)
        except Exception as exc:  # pragma: no cover - malformed yaml
            models.append({"config": name, "error": str(exc)})
            continue

        checkpoint = config.get("checkpoint_path")
        resolved = resolve_checkpoint(checkpoint)
        first = config.get("first_pass") or {}
        second = config.get("second_pass") or {}
        models.append(
            {
                "config": name,
                "label": Path(name).stem,
                "checkpoint": checkpoint,
                "local": bool(resolved and Path(str(resolved)).is_file()),
                "pipeline_type": config.get("pipeline_type", "base"),
                "precision": config.get("precision"),
                "sampler": config.get("sampler"),
                "stg_mode": config.get("stg_mode"),
                "num_inference_steps": config.get(
                    "num_inference_steps", first.get("num_inference_steps")
                ),
                "guidance_scale": config.get("guidance_scale", first.get("guidance_scale")),
                "stg_scale": config.get("stg_scale", first.get("stg_scale")),
                "multi_scale": bool(config.get("spatial_upscaler_model_path")),
                "second_pass_steps": second.get("num_inference_steps"),
                "text_encoder": config.get("text_encoder_model_name_or_path"),
                "prompt_enhancement": bool(config.get("prompt_enhancement_words_threshold", 0)),
            }
        )
    return json.dumps({"ok": True, "models": models, "count": len(models)}, indent=2)


@server.tool(
    name="ltx_video_download_model",
    title="Download LTX-Video weights",
    description=(
        "Pre-fetch a checkpoint (and its spatial upscaler, for multi-scale presets) "
        "from the Hugging Face model repo so later renders start instantly and offline."
    ),
)
def ltx_video_download_model(model: str = DEFAULT_MODEL) -> str:
    from huggingface_hub import hf_hub_download  # noqa: PLC0415

    config = load_pipeline_config(model)
    wanted = [config.get("checkpoint_path")]
    if config.get("spatial_upscaler_model_path"):
        wanted.append(config["spatial_upscaler_model_path"])

    downloaded = []
    for filename in filter(None, wanted):
        path = hf_hub_download(repo_id=HF_REPO_ID, filename=str(filename), repo_type="model")
        downloaded.append(
            {"filename": filename, "path": path, "bytes": Path(path).stat().st_size}
        )

    return json.dumps(
        {"ok": True, "model": model, "repo": HF_REPO_ID, "downloaded": downloaded}, indent=2
    )


@server.tool(
    name="ltx_video_reference_info",
    title="Inspect reference media",
    description=(
        "Inspect a reference image or video before conditioning on it: dimensions, "
        "frame count, fps, and the `N * 8 + 1` frame count LTX-Video will accept."
    ),
)
def ltx_video_reference_info(path: str) -> str:
    return json.dumps(inspect_media(path), indent=2)


@server.tool(
    name="ltx_video_generate",
    title="Generate video with LTX-Video",
    description=(
        "Render a video with LTX-Video and return the output file as JSON.\n\n"
        "Capabilities, all driven by the arguments below:\n"
        "  * text-to-video            - no conditioning at all\n"
        "  * image-to-video           - one image in `conditioning_media_paths` at frame 0\n"
        "  * multi-keyframe animation - several images/videos with their own start frames\n"
        "  * video extension          - a video segment conditioned at a later start frame\n"
        "                              (forward), or at frame 0 with `input_media_path`\n"
        "  * video-to-video           - `input_media_path` re-renders an existing video\n\n"
        "Resolutions must be divisible by 32 and frame counts by 8 plus 1 "
        "(9, 17, 25, ... 257); other values are padded and cropped automatically."
    ),
)
def ltx_video_generate(
    prompt: str,
    output_path: str | None = None,
    model: str = DEFAULT_MODEL,
    negative_prompt: str | None = None,
    height: int = 704,
    width: int = 1216,
    num_frames: int = 121,
    frame_rate: int = 30,
    seed: int | None = None,
    precision: str | None = None,
    sampler: str | None = None,
    stg_mode: str | None = None,
    enhance_prompt: bool | None = None,
    offload_to_cpu: bool = False,
    image_cond_noise_scale: float = 0.15,
    input_media_path: str | None = None,
    conditioning_media_paths: list[str] | None = None,
    conditioning_strengths: list[float] | None = None,
    conditioning_start_frames: list[int] | None = None,
) -> str:
    if precision and precision not in PRECISIONS:
        raise ValueError(f"`precision` must be one of: {', '.join(PRECISIONS)}")
    if sampler and sampler not in SAMPLERS:
        raise ValueError(f"`sampler` must be one of: {', '.join(SAMPLERS)}")
    if stg_mode and stg_mode not in STG_MODES:
        raise ValueError(f"`stg_mode` must be one of: {', '.join(STG_MODES)}")

    return json.dumps(
        run_generation(
            {
                "prompt": prompt,
                "output_path": output_path,
                "model": model,
                "negative_prompt": negative_prompt,
                "height": height,
                "width": width,
                "num_frames": num_frames,
                "frame_rate": frame_rate,
                "seed": seed,
                "precision": precision,
                "sampler": sampler,
                "stg_mode": stg_mode,
                "enhance_prompt": enhance_prompt,
                "offload_to_cpu": offload_to_cpu,
                "image_cond_noise_scale": image_cond_noise_scale,
                "input_media_path": input_media_path,
                "conditioning_media_paths": conditioning_media_paths,
                "conditioning_strengths": conditioning_strengths,
                "conditioning_start_frames": conditioning_start_frames,
            }
        ),
        indent=2,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def selftest() -> int:
    """Non-MCP smoke test: render a tiny clip and report the result."""
    print("[ltx-video] self-test starting (first run downloads the weights)...")
    target = str(Path.cwd() / "work" / "smoke" / "ltx_selftest")
    result = json.loads(
        ltx_video_generate(
            prompt="a calm ocean wave rolling onto a sandy beach at golden hour",
            output_path=target,
            num_frames=9,
            height=480,
            width=704,
        )
    )
    print(
        f"[ltx-video] ok  device={result['device']}  "
        f"frames={result['requested']['num_frames']}  path={result['path']}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LTX-Video MCP server (stdio)")
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="render one tiny clip and exit, without speaking MCP",
    )
    parser.add_argument(
        "--transport",
        default="stdio",
        choices=["stdio", "sse", "streamable-http"],
    )
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()

    print("[ltx-video] ready (stdio)", file=sys.stderr, flush=True)
    server.run(transport=args.transport)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

