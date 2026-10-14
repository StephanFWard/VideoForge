#!/usr/bin/env python3
"""Generate a low-resolution grayscale foreground matte for a video."""

import argparse
from fractions import Fraction
import io
import json
from pathlib import Path
import sys

import av
import numpy as np
from PIL import Image, ImageFilter
from rembg import new_session, remove


def create_matte(
    input_path: Path, output_path: Path, metadata_path: Path, fps: float
) -> int:
    rate = Fraction(str(fps)).limit_denominator(1000)
    session = new_session("isnet-general-use")
    source = av.open(str(input_path))
    video = next((stream for stream in source.streams if stream.type == "video"), None)
    if video is None:
        raise ValueError(f"No video stream found in {input_path}")

    output = av.open(str(output_path), mode="w", format="matroska")
    stream = output.add_stream("ffv1", rate=rate)
    stream.width = video.codec_context.width
    stream.height = video.codec_context.height
    stream.pix_fmt = "gray"
    stream.time_base = Fraction(rate.denominator, rate.numerator)

    count = 0
    frame_bounds = []
    try:
        for decoded in source.decode(video):
            image = decoded.to_image().convert("RGB")
            mask = remove(image, session=session, only_mask=True)
            if isinstance(mask, bytes):
                mask = Image.open(io.BytesIO(mask))
            mask = mask.convert("L").filter(ImageFilter.GaussianBlur(radius=0.8))
            pixels = np.asarray(mask, dtype=np.uint8)
            active = pixels >= 32
            xs = np.flatnonzero(
                np.count_nonzero(active, axis=0) >= max(4, round(stream.height * 0.015))
            )
            ys = np.flatnonzero(
                np.count_nonzero(active, axis=1) >= max(3, round(stream.width * 0.01))
            )
            if xs.size and ys.size:
                frame_bounds.append(
                    (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
                )
            frame = av.VideoFrame.from_ndarray(pixels, format="gray")
            frame.pts = count
            frame.time_base = Fraction(rate.denominator, rate.numerator)
            for packet in stream.encode(frame):
                output.mux(packet)
            count += 1
            if count % 30 == 0:
                print(f"Segmented {count} frames", file=sys.stderr, flush=True)

        for packet in stream.encode():
            output.mux(packet)
    finally:
        source.close()
        output.close()
    if count == 0:
        raise ValueError(f"No video frames were decoded from {input_path}")
    if not frame_bounds:
        raise ValueError("Foreground segmentation found no subject in the source video.")
    bounds = np.quantile(np.asarray(frame_bounds), [0.1, 0.9], axis=0).astype(int)
    x1, y1 = bounds[0, :2]
    x2, y2 = bounds[1, 2:]
    metadata_path.write_text(
        json.dumps({
            "frames": count,
            "width": stream.width,
            "height": stream.height,
            "bbox": {
                "x": int(x1),
                "y": int(y1),
                "width": int(x2 - x1),
                "height": int(y2 - y1),
            },
        }),
        encoding="utf-8",
    )
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--fps", type=float, required=True)
    args = parser.parse_args()
    frames = create_matte(args.input, args.output, args.metadata, args.fps)
    print(f"Matte ready: {frames} frames -> {args.output}", flush=True)


if __name__ == "__main__":
    main()
