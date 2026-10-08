#!/usr/bin/env python
"""
Extract the first 6 seconds of the "big fish eating tokens" video,
remove the green background via chroma key, and output a transparent
PNG sequence for the desk-pet thinking animation.

Input:  pet/assets/video/大肥鱼吃token.mp4
Output: pet/assets/whale/eat_token/frame_0000.png, frame_0001.png, …

Usage:
    python scripts/extract_eat_token.py
"""
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

PROJECT = Path(__file__).resolve().parent.parent
VIDEO = PROJECT / "pet" / "assets" / "video" / "大肥鱼吃token.mp4"
OUTPUT = PROJECT / "pet" / "assets" / "whale" / "eat_token"

# ── tunables ──────────────────────────────────────────────────────────────
DURATION_S = 6.0          # seconds to extract
TARGET_FPS = 24           # frame rate of the output sequence
OUTPUT_SIZE = 360         # resize longest edge to this many pixels
CHROMA_LOWER = (40, 60, 60)   # HSV lower bound for green
CHROMA_UPPER = (85, 255, 255)  # HSV upper bound for green
MARGIN_ERODE = 4          # erode the green mask to kill a fringe
MARGIN_BLUR = 3           # Gaussian blur on the alpha edge
# ──────────────────────────────────────────────────────────────────────────

def chroma_key_alpha(bgr: np.ndarray) -> np.ndarray:
    """Return an alpha channel (0-255 uint8) from a BGR frame."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, CHROMA_LOWER, CHROMA_UPPER)

    if MARGIN_ERODE > 0:
        kernel = np.ones((MARGIN_ERODE, MARGIN_ERODE), np.uint8)
        mask = cv2.erode(mask, kernel)

    if MARGIN_BLUR > 0:
        mask = cv2.GaussianBlur(mask, (MARGIN_BLUR | 1, MARGIN_BLUR | 1), 0)

    # Invert: 255 = opaque (non-green), 0 = transparent (was green)
    return cv2.bitwise_not(mask)


def to_bgra(bgr: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Stack a BGR frame and an alpha channel into BGRA."""
    return np.dstack((bgr, alpha))


def main():
    if not VIDEO.is_file():
        sys.exit(f"Video not found: {VIDEO}")

    cap = cv2.VideoCapture(str(VIDEO))
    if not cap.isOpened():
        sys.exit(f"Cannot open video: {VIDEO}")

    source_fps = cap.get(cv2.CAP_PROP_FPS)
    source_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    source_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    source_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    source_len = source_frames / max(source_fps, 1)

    print(f"Video: {source_w}x{source_h}, {source_fps:.2f} fps, "
          f"{source_frames} frames, {source_len:.2f}s")

    # How many frames to extract to hit DURATION_S at TARGET_FPS.
    keep_count = math.ceil(DURATION_S * TARGET_FPS)

    # Source frames consumed per output frame (may be fractional).
    # If source fps > target fps we skip; if slower we duplicate.
    step = source_fps / TARGET_FPS

    # Resize scale
    scale = OUTPUT_SIZE / max(source_w, source_h)

    OUTPUT.mkdir(parents=True, exist_ok=True)
    written = 0

    for idx_out in range(keep_count):
        src_pos = idx_out * step
        src_index = int(round(src_pos))

        # Clamp so the last output frame uses the last available source frame.
        src_index = min(src_index, source_frames - 1)

        cap.set(cv2.CAP_PROP_POS_FRAMES, src_index)
        ret, bgr = cap.read()
        if not ret:
            print(f"  frame {idx_out:04d}: source frame {src_index} not readable, stopping")
            break

        # Chroma key → alpha
        alpha = chroma_key_alpha(bgr)

        # Resize
        new_w = int(source_w * scale)
        new_h = int(source_h * scale)
        bgr_small = cv2.resize(bgr, (new_w, new_h), interpolation=cv2.INTER_AREA)
        alpha_small = cv2.resize(alpha, (new_w, new_h), interpolation=cv2.INTER_AREA)

        bgra = to_bgra(bgr_small, alpha_small)

        out_path = OUTPUT / f"frame_{idx_out:04d}.png"
        cv2.imwrite(str(out_path), bgra)
        written += 1

    cap.release()

    # ── manifest ──────────────────────────────────────────────────────────
    manifest = {
        "frames": written,
        "fps": TARGET_FPS,
        "duration_s": DURATION_S,
        "size": [int(source_w * scale), int(source_h * scale)],
    }
    manifest_path = OUTPUT / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"\nWrote {written} frames + manifest to {OUTPUT}")
    print(f"  fps={TARGET_FPS}  size={manifest['size'][0]}x{manifest['size'][1]}")


if __name__ == "__main__":
    main()