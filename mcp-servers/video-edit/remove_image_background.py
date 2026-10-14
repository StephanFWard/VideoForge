#!/usr/bin/env python3
"""Create a transparent foreground cutout from a generated theme image."""

import argparse
import io
from pathlib import Path

from PIL import Image
from rembg import new_session, remove


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    session = new_session("isnet-general-use")
    with Image.open(args.input) as image:
        result = remove(image.convert("RGB"), session=session)
    if isinstance(result, bytes):
        result = Image.open(io.BytesIO(result))
    result.convert("RGBA").save(args.output, format="PNG")
    print(f"Transparent foreground saved: {args.output}", flush=True)


if __name__ == "__main__":
    main()
