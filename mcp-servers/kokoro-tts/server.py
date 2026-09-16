#!/usr/bin/env python3
"""
Kokoro TTS MCP server
=====================

A Model Context Protocol server that turns text into narration audio using the
Kokoro-82M text-to-speech model.

Why Kokoro: it is only 82M parameters, so it runs *comfortably on CPU* - no GPU
is required. That makes narration the one part of an AI video pipeline that is
genuinely free and local on a laptop.

Transport is stdio, so any MCP host can use it directly:

    cline / Claude Desktop / Cursor
        command: .venv/Scripts/python.exe
        args:    mcp-servers/kokoro-tts/server.py

VideoForge connects to this same server as an MCP client, which is what lets the
video pipeline and the audio pipeline speak the same protocol.

Tools
-----
text_to_speech   Synthesize narration to a .wav/.mp3 file.
list_voices      Enumerate available voices, optionally filtered by language.
kokoro_health    Readiness/self-report, used by `video-forge doctor`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from mcp.server.mcpserver import MCPServer

# Kokoro-82M always synthesises at 24 kHz mono.
SAMPLE_RATE = 24_000

REPO_ID = "hexgrad/Kokoro-82M"

# Kokoro language codes:  https://github.com/hexgrad/kokoro
LANG_CODES: dict[str, str] = {
    "en-us": "a",   # American English
    "en-gb": "b",   # British English
    "es": "e",
    "fr": "f",
    "hi": "h",
    "it": "i",
    "pt-br": "p",
    "ja": "j",
    "zh": "z",
}

# Canonical voice list shipped with Kokoro v1.0. Prefixed by language + gender
# (a=US English, b=British English, e=Spanish, f=French, h=Hindi, i=Italian,
#  p=Brazilian Portuguese, j=Japanese, z=Mandarin).
VOICES: dict[str, list[str]] = {
    "en-us": [
        "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
        "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
        "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
        "am_onyx", "am_puck", "am_santa",
    ],
    "en-gb": ["bf_alice", "bf_emma", "bf_isabella", "bf_lily",
              "bm_daniel", "bm_fable", "bm_george", "bm_lewis"],
    "es": ["ef_dora", "em_alex", "em_santa"],
    "fr": ["ff_siwis"],
    "hi": ["hf_alpha", "hf_beta", "hm_omega", "hm_psi"],
    "it": ["if_sara", "im_nicola"],
    "pt-br": ["pf_dora", "pm_alex", "pm_santa"],
    "ja": ["jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo"],
    "zh": ["zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi",
           "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang"],
}

DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
DEFAULT_SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))
DEFAULT_LANG = os.environ.get("KOKORO_LANG", "en-us")

# ---------------------------------------------------------------------------
# Lazy model loading
#
# Importing torch + the Kokoro weights takes ~10-40s on a cold CPU. Tools that
# only read metadata (list_voices, kokoro_health) must stay instant, so the
# pipeline is only built on the first real synthesis request.
# ---------------------------------------------------------------------------
_pipeline: Any = None
_pipeline_lang: str | None = None
_load_seconds: float | None = None


def lang_code_for(lang: str) -> str:
    """Accept 'en-us', 'a', or 'a,b' style specifiers."""
    key = (lang or DEFAULT_LANG).strip().lower()
    if key in LANG_CODES:
        return LANG_CODES[key]
    if key in LANG_CODES.values():
        return key
    raise ValueError(
        f"Unsupported language '{lang}'. Use one of: {', '.join(sorted(LANG_CODES))}"
    )


def get_pipeline(lang: str = DEFAULT_LANG):
    """Build (once) and return the Kokoro pipeline for a language."""
    global _pipeline, _pipeline_lang, _load_seconds
    code = lang_code_for(lang)
    if _pipeline is None or _pipeline_lang != code:
        from kokoro import KPipeline

        started = time.time()
        _pipeline = KPipeline(lang_code=code, repo_id=REPO_ID)
        _pipeline_lang = code
        _load_seconds = round(time.time() - started, 1)
    return _pipeline


def resolve_voice(voice: str | None, lang: str) -> str:
    """Validate a voice name and make sure it matches the requested language."""
    code = lang_code_for(lang)
    chosen = (voice or DEFAULT_VOICE).strip()
    # A bare prefix such as "af" means "the af voice" - expand to the default.
    if len(chosen) <= 3 and "_" not in chosen:
        for candidate in VOICES.get(lang, []):
            if candidate.startswith(chosen):
                return candidate
    if not chosen.startswith(code):
        # The voice belongs to another language; the language arg wins.
        fallback = VOICES.get(lang, [])
        if fallback:
            return fallback[0]
    return chosen


def synthesize(text: str, voice: str | None, speed: float, lang: str) -> tuple[Any, str]:
    """Run Kokoro and return (numpy waveform, voice_used)."""
    import numpy as np

    pipeline = get_pipeline(lang)
    voice_used = resolve_voice(voice, lang)
    chunks = [
        audio
        for _, _, audio in pipeline(text, voice=voice_used, speed=speed)
        if audio is not None and len(audio)
    ]
    if not chunks:
        raise RuntimeError("Kokoro returned no audio for the supplied text.")
    return np.concatenate(chunks), voice_used


# ---------------------------------------------------------------------------
# MCP server + tools
# ---------------------------------------------------------------------------
server = MCPServer(
    name="kokoro-tts",
    title="Kokoro TTS",
    version="1.0.0",
    description="Neural text-to-speech narration with Kokoro-82M (CPU friendly).",
    instructions=(
        "Text-to-speech narration. Call kokoro_health first if unsure the model "
        "is available, then text_to_speech to render narration to a .wav/.mp3 file."
    ),
)


def _out_path(output_path: str | None, output_format: str) -> Path:
    """Resolve where the audio should land, creating parents as needed."""
    if output_path:
        target = Path(output_path).expanduser()
        if not target.is_absolute():
            target = Path.cwd() / target
    else:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        target = Path.cwd() / "kokoro-output" / f"kokoro-{stamp}.{output_format}"
    if target.suffix.lower().lstrip(".") != output_format:
        target = target.with_suffix(f".{output_format}")
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def _to_mp3(wav_path: Path, mp3_path: Path) -> None:
    """Convert with ffmpeg; Kokoro itself only emits PCM."""
    import subprocess

    result = subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-i", str(wav_path), "-codec:a", "libmp3lame", "-qscale:a", "2", str(mp3_path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg could not write mp3 output: {result.stderr.strip()[:400]}"
        )


@server.tool(
    name="text_to_speech",
    title="Text to speech",
    description=(
        "Synthesize narration audio from text with Kokoro-82M. Returns the audio "
        "file path, its duration in seconds, sample rate and voice used, as JSON."
    ),
)
def text_to_speech(
    text: str,
    voice: str | None = None,
    speed: float = DEFAULT_SPEED,
    lang: str = DEFAULT_LANG,
    output_path: str | None = None,
    output_format: str = "wav",
) -> str:
    if not text or not text.strip():
        raise ValueError("`text` must contain something to speak.")

    output_format = (output_format or "wav").lower().lstrip(".")
    if output_format not in {"wav", "mp3"}:
        raise ValueError("`output_format` must be 'wav' or 'mp3'.")

    # Guard against a runaway render; narration lines are normally far shorter.
    if len(text) > 20_000:
        raise ValueError("`text` is longer than 20000 characters; split it into scenes.")

    try:
        speed = max(0.5, min(2.0, float(speed)))
    except (TypeError, ValueError):
        speed = DEFAULT_SPEED

    wave, voice_used = synthesize(text, voice, speed, lang)
    target = _out_path(output_path, output_format)

    import soundfile as sf

    if output_format == "mp3":
        wav_target = target.with_suffix(".wav")
        sf.write(str(wav_target), wave, SAMPLE_RATE)
        _to_mp3(wav_target, target)
        wav_target.unlink(missing_ok=True)
    else:
        sf.write(str(target), wave, SAMPLE_RATE)

    duration = round(len(wave) / SAMPLE_RATE, 3)
    return json.dumps(
        {
            "ok": True,
            "path": str(target),
            "absolute_path": str(target.resolve()),
            "duration_seconds": duration,
            "sample_rate": SAMPLE_RATE,
            "channels": 1,
            "voice": voice_used,
            "speed": speed,
            "language": lang,
            "format": output_format,
            "characters": len(text),
            "bytes": target.stat().st_size,
        },
        indent=2,
    )


@server.tool(
    name="list_voices",
    title="List voices",
    description="List Kokoro voice names, optionally limited to one language.",
)
def list_voices(lang: str | None = None) -> str:
    if lang:
        key = lang.strip().lower()
        if key not in VOICES:
            key = next((k for k, v in LANG_CODES.items() if v == key), key)
        if key not in VOICES:
            raise ValueError(
                f"Unknown language '{lang}'. Use one of: {', '.join(sorted(VOICES))}"
            )
        return json.dumps(
            {"languages": [key], "voices": {key: VOICES[key]}, "default_voice": DEFAULT_VOICE},
            indent=2,
        )
    return json.dumps(
        {
            "languages": sorted(VOICES),
            "voices": VOICES,
            "default_voice": DEFAULT_VOICE,
            "total": sum(len(v) for v in VOICES.values()),
        },
        indent=2,
    )


@server.tool(
    name="kokoro_health",
    title="Kokoro health",
    description="Report whether Kokoro can synthesize, plus model and runtime details.",
)
def kokoro_health() -> str:
    import platform

    info: dict[str, Any] = {
        "ok": True,
        "model": REPO_ID,
        "sample_rate": SAMPLE_RATE,
        "model_loaded": _pipeline is not None,
        "load_seconds": _load_seconds,
        "default_voice": DEFAULT_VOICE,
        "default_language": DEFAULT_LANG,
        "voices": sum(len(v) for v in VOICES.values()),
        "languages": sorted(VOICES),
        "python": platform.python_version(),
        "platform": f"{platform.system()} {platform.machine()}",
    }
    try:
        import torch

        info["torch"] = torch.__version__
        info["cpu_threads"] = torch.get_num_threads()
        info["cuda_available"] = bool(torch.cuda.is_available())
    except Exception as exc:  # pragma: no cover
        info["torch"] = f"unavailable: {exc}"
    try:
        import soundfile

        info["soundfile"] = soundfile.__version__
    except Exception as exc:  # pragma: no cover
        info["soundfile"] = f"unavailable: {exc}"
    return json.dumps(info, indent=2)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def selftest() -> int:
    """Non-MCP smoke test: synthesize a short line and report the result."""
    print("[kokoro-tts] self-test starting (first run downloads the model)...")
    target = str(Path.cwd() / "work" / "smoke" / "kokoro_selftest.wav")
    result = json.loads(text_to_speech("VideoForge narration is online.", output_path=target))
    print(
        f"[kokoro-tts] ok  voice={result['voice']}  "
        f"duration={result['duration_seconds']}s  path={result['path']}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Kokoro TTS MCP server (stdio)")
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="synthesize one line and exit, without speaking MCP",
    )
    parser.add_argument(
        "--transport",
        default="stdio",
        choices=["stdio", "sse", "streamable-http"],
    )
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()

    print("[kokoro-tts] ready (stdio)", file=sys.stderr, flush=True)
    server.run(transport=args.transport)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

