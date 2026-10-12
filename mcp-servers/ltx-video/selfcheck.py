"""Offline validation of the LTX-Video MCP server's pure logic.

The real `mcp` package only exists inside `.venv-ltx`, so this stubs the small
surface the server imports. That keeps the check runnable on a bare Python,
which is what `npm run setup:ltx` runs before the heavy deps are installed.
"""
import importlib.util as util
import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# --- stub mcp.server.mcpserver.MCPServer -----------------------------------
mcp_mod = types.ModuleType("mcp")
server_mod = types.ModuleType("mcp.server")
mcpserver_mod = types.ModuleType("mcp.server.mcpserver")


class MCPServer:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.tools = {}

    def tool(self, **tool_kwargs):
        def decorator(func):
            self.tools[tool_kwargs.get("name", func.__name__)] = func
            return func

        return decorator

    def run(self, transport=None):
        return None


mcpserver_mod.MCPServer = MCPServer
server_mod.mcpserver = mcpserver_mod
mcp_mod.server = server_mod
sys.modules.setdefault("mcp", mcp_mod)
sys.modules.setdefault("mcp.server", server_mod)
sys.modules.setdefault("mcp.server.mcpserver", mcpserver_mod)

spec = util.spec_from_file_location("ltx_video_mcp_server", ROOT / "server.py")
module = util.module_from_spec(spec)
spec.loader.exec_module(module)

failures = []


def check(label, condition, detail=""):
    status = "ok  " if condition else "FAIL"
    print(f"  {status}  {label}{(' -> ' + str(detail)) if detail else ''}")
    if not condition:
        failures.append(label)


print("\nLTX-Video MCP server checks\n")

configs = module.available_configs()
check("ships every upstream preset", len(configs) == 11, len(configs))
check(
    "presets include 2B distilled and 13B dev",
    "ltxv-2b-0.9.8-distilled.yaml" in configs and "ltxv-13b-0.9.8-dev.yaml" in configs,
)
check(
    "preset names resolve with or without .yaml",
    module.config_path_for("ltxv-2b-0.9.8-distilled")
    == module.config_path_for("ltxv-2b-0.9.8-distilled.yaml"),
)

try:
    module.config_path_for("not-a-model")
    check("unknown preset raises", False)
except ValueError as exc:
    check("unknown preset raises", "Unknown LTX-Video model preset" in str(exc))

config = module.load_pipeline_config("ltxv-2b-0.9.8-distilled")
check(
    "distilled 2B preset is multi-scale",
    config.get("pipeline_type") == "multi-scale",
    config.get("checkpoint_path"),
)
check(
    "13B dev preset uses bfloat16",
    module.load_pipeline_config("ltxv-13b-0.9.8-dev").get("precision") == "bfloat16",
)
check(
    "fp8 preset declares float8_e4m3fn",
    module.load_pipeline_config("ltxv-13b-0.9.8-dev-fp8").get("precision") == "float8_e4m3fn",
)

health = json.loads(module.ltx_video_health())
check("health returns a well-formed report", isinstance(health, dict) and "device" in health)
check(
    "health exposes the device probe",
    health["device"] in {"cpu", "cuda", "mps"},
    health["device"],
)
check("health exposes video_scale_factor", health["video_scale_factor"] == 8)
check(
    "health lists the full capability surface",
    set(health["precisions"]) >= {"bfloat16", "float8_e4m3fn"}
    and set(health["samplers"]) >= {"uniform", "from_checkpoint"}
    and set(health["stg_modes"])
    >= {"attention_values", "attention_skip", "residual", "transformer_block"},
)

# `ok` reflects whether the ltx_video package is importable. In this stub
# environment it usually is not, which must be reported honestly - with a
# remediation hint - rather than a bare crash.
ltx_installed = health.get("ok", False)
if not ltx_installed:
    check(
        "health explains a missing install",
        bool(health.get("error")) and bool(health.get("hint")),
        health.get("error"),
    )
else:
    check("health reports ok", True)

listed = json.loads(module.ltx_video_list_models())
check("list_models returns every preset", listed["count"] == len(configs), listed["count"])
check(
    "list_models flags multi-scale presets",
    all(m["multi_scale"] for m in listed["models"] if "0.9.8" in m["config"]),
)

registered = sorted(module.server.tools)
expected = [
    "ltx_video_download_model",
    "ltx_video_generate",
    "ltx_video_health",
    "ltx_video_list_models",
    "ltx_video_reference_info",
]
check("all five tools are registered", registered == expected, registered)

# --- media inspection (the reference-upload contract) ----------------------
reference = ROOT.parent.parent / "work" / "ltx-reference-check"
reference.mkdir(parents=True, exist_ok=True)

try:
    from PIL import Image

    image_path = reference / "reference.png"
    Image.new("RGB", (1216, 704), (32, 64, 128)).save(image_path)

    info = json.loads(module.ltx_video_reference_info(str(image_path)))
    check("image reference reports kind=image", info["kind"] == "image")
    check(
        "image reference reports dimensions",
        info["width"] == 1216 and info["height"] == 704,
    )
    check(
        "image reference is always 1 frame",
        info["frames"] == 1 and info["valid_frames"] == 1,
    )
except ImportError:
    print("  skip  PIL unavailable - image reference inspection not checked")

try:
    module.ltx_video_reference_info(str(reference / "missing.png"))
    check("missing reference raises", False)
except ValueError as exc:
    check("missing reference raises", "not found" in str(exc))

try:
    unsupported = reference / "reference.txt"
    unsupported.write_text("nope", encoding="utf-8")
    module.ltx_video_reference_info(str(unsupported))
    check("unsupported extension raises", False)
except ValueError as exc:
    check("unsupported extension raises", "Unsupported reference media" in str(exc))

# --- generation argument validation (never loads weights) ------------------
for label, kwargs in [
    ("empty prompt", {"prompt": "   "}),
    (
        "conditioning without start frames",
        {"prompt": "p", "conditioning_media_paths": ["a.png"]},
    ),
    (
        "mismatched conditioning lengths",
        {
            "prompt": "p",
            "conditioning_media_paths": ["a.png", "b.png"],
            "conditioning_start_frames": [0],
        },
    ),
    (
        "strength out of range",
        {
            "prompt": "p",
            "conditioning_media_paths": ["a.png"],
            "conditioning_start_frames": [0],
            "conditioning_strengths": [1.7],
        },
    ),
    (
        "start frame past the end",
        {
            "prompt": "p",
            "conditioning_media_paths": ["a.png"],
            "conditioning_start_frames": [121],
            "num_frames": 121,
        },
    ),
    ("bad precision", {"prompt": "p", "precision": "float16"}),
    ("bad sampler", {"prompt": "p", "sampler": "dpmpp"}),
    ("bad stg mode", {"prompt": "p", "stg_mode": "magic"}),
    (
        "missing reference file",
        {
            "prompt": "p",
            "conditioning_media_paths": ["nope.png"],
            "conditioning_start_frames": [0],
        },
    ),
]:
    try:
        module.ltx_video_generate(**kwargs)
        check(f"generate rejects {label}", False)
    except ValueError:
        check(f"generate rejects {label}", True)

print(f"\n{len(failures)} failure(s)\n")
sys.exit(1 if failures else 0)

