#!/usr/bin/env python
"""
Generic green-screen video -> transparent PNG sequence extractor.

Extract a time slice of a square, green-screen MP4 into a transparent PNG
sequence (chroma-keyed) plus a manifest.json, for the desk-pet animation
pipeline.

Required inputs (given as CLI flags, or prompted interactively when missing):

    --input  / -i   path to the source MP4 (must be square + green-screen)
    --output / -o   directory to write frame_0000.png ... + manifest.json
    --start  / -s   start time in seconds (e.g. 1)
    --end    / -e   end time in seconds   (e.g. 3)

Optional tunables:

    --fps   target frame rate of the output (default 24)
    --size  resize the longest edge to this many pixels (default 360)

Usage:
    python scripts/extract_video.py \
        --input pet/assets/video/idle.mp4 \
        --output pet/assets/whale/idle \
        --start 0 --end 3

    python scripts/extract_video.py     # any missing value is prompted

The script refuses to run unless the video is square and its border is green,
so a wrong source fails loudly instead of producing a broken animation.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

# ── tunables ──────────────────────────────────────────────────────────────
CHROMA_LOWER = (40, 60, 60)    # HSV lower bound for the green screen
CHROMA_UPPER = (85, 255, 255)  # HSV upper bound for the green screen
MARGIN_ERODE = 4               # erode the green mask to kill a fringe
MARGIN_BLUR = 3                # Gaussian blur on the alpha edge
DESPILL = True                 # remove green spill from edge pixels
DESPILL_STRENGTH = 1.0         # 0.0 = off, 1.0 = full clamp of the green channel
GREEN_BORDER_BAND = 0.08       # border band width, as a fraction of the frame
GREEN_BORDER_RATIO = 0.6       # min fraction of border pixels that must be green
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


def despill(bgr: np.ndarray, strength: float = DESPILL_STRENGTH) -> np.ndarray:
    """Suppress green spill by pulling the green channel back toward max(R, B).

    Only green-dominant pixels change (where G exceeds both R and B), which is
    exactly the fringe a green screen leaves on the subject's edge; the interior
    of the subject keeps its color untouched.
    """
    out = bgr.astype(np.float32)
    green = out[:, :, 1]
    max_rb = np.maximum(out[:, :, 0], out[:, :, 2])
    excess = green - max_rb
    out[:, :, 1] = green - strength * np.maximum(excess, 0.0)
    return np.clip(out, 0, 255).astype(np.uint8)


def border_green_ratio(bgr: np.ndarray) -> float:
    """Fraction of border pixels that fall inside the green-screen range."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, w = hsv.shape[:2]
    band = max(1, int(min(h, w) * GREEN_BORDER_BAND))
    border = np.zeros((h, w), np.uint8)
    border[:band, :] = 255
    border[-band:, :] = 255
    border[:, :band] = 255
    border[:, -band:] = 255
    green = cv2.inRange(hsv, CHROMA_LOWER, CHROMA_UPPER)
    border_area = int((border > 0).sum())
    if border_area == 0:
        return 0.0
    green_area = int(((border > 0) & (green > 0)).sum())
    return green_area / border_area


def prompt_nonempty(label: str) -> str:
    """Prompt for a non-empty string, looping until one is given."""
    while True:
        try:
            value = input(f"{label}: ").strip()
        except EOFError:
            sys.exit("没有可用的输入，已退出")
        if value:
            return value
        print(f"  {label} 不能为空，请重新输入")


def prompt_seconds(label: str) -> float:
    """Prompt for a non-negative number of seconds, looping until valid."""
    while True:
        try:
            raw = input(f"{label}（秒，如 1 或 2.5）: ").strip()
        except EOFError:
            sys.exit("没有可用的输入，已退出")
        try:
            value = float(raw)
        except ValueError:
            print("  请输入数字，例如 1 或 2.5")
            continue
        if value < 0:
            print("  时间不能为负数，请重新输入")
            continue
        return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Extract a square green-screen MP4 time slice into a transparent PNG sequence.",
    )
    parser.add_argument("--input", "-i", help="source MP4 path")
    parser.add_argument("--output", "-o", help="output directory for the frame sequence")
    parser.add_argument("--start", "-s", type=float, help="start time in seconds")
    parser.add_argument("--end", "-e", type=float, help="end time in seconds")
    parser.add_argument("--fps", type=float, default=24, help="output frame rate (default 24)")
    parser.add_argument("--size", type=int, default=360, help="resize longest edge to this many px (default 360)")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)

    # 1) Required inputs: use the flag when present, otherwise prompt.
    input_path = Path(args.input) if args.input else Path(prompt_nonempty("输入 mp4 路径"))
    output_dir = Path(args.output) if args.output else Path(prompt_nonempty("输出序列文件夹"))
    start = args.start if args.start is not None else prompt_seconds("start_time")
    end = args.end if args.end is not None else prompt_seconds("end_time")

    if start >= end:
        sys.exit(f"start_time（{start}）必须小于 end_time（{end}）")
    if not input_path.is_file():
        sys.exit(f"视频不存在: {input_path}")

    target_fps = args.fps
    output_size = args.size

    cap = cv2.VideoCapture(str(input_path))
    if not cap.isOpened():
        sys.exit(f"无法打开视频: {input_path}")

    source_fps = cap.get(cv2.CAP_PROP_FPS) or target_fps
    source_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    source_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    source_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration = source_frames / max(source_fps, 1)

    print(f"Video: {source_w}x{source_h}, {source_fps:.2f} fps, "
          f"{source_frames} frames, {duration:.2f}s")

    # 2) Square requirement.
    if source_w != source_h:
        sys.exit(f"视频必须是正方形，当前为 {source_w}x{source_h}")

    # 3) Green-screen requirement: sample the border at a few frames.
    if source_frames <= 0:
        sys.exit("视频没有任何帧")
    sample_indices = sorted({0, source_frames // 2, source_frames - 1})
    for idx in sample_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, bgr = cap.read()
        if not ret:
            continue
        ratio = border_green_ratio(bgr)
        if ratio < GREEN_BORDER_RATIO:
            sys.exit(f"背景不是绿幕：第 {idx} 帧边缘绿色占比 {ratio:.0%}，"
                     f"低于阈值 {GREEN_BORDER_RATIO:.0%}")
    print("绿幕校验通过")

    # 4) Clamp the time slice into the video and derive the frame range.
    requested_end = end
    start = max(0.0, start)
    end = min(requested_end, duration)
    if start >= end:
        sys.exit(f"裁剪区间无效：start={start}s end={end}s（视频长 {duration:.2f}s）")
    if requested_end > duration:
        print(f"提示：end_time（{requested_end}s）超过视频时长，已截到 {duration:.2f}s")

    segment_duration = end - start
    keep_count = math.ceil(segment_duration * target_fps)
    start_frame = int(round(start * source_fps))
    end_frame = min(int(round(end * source_fps)), source_frames)
    step = source_fps / target_fps

    scale = output_size / max(source_w, source_h)
    new_w = int(source_w * scale)
    new_h = int(source_h * scale)

    output_dir.mkdir(parents=True, exist_ok=True)
    written = 0

    for idx_out in range(keep_count):
        src_index = min(start_frame + int(round(idx_out * step)), end_frame - 1)
        cap.set(cv2.CAP_PROP_POS_FRAMES, src_index)
        ret, bgr = cap.read()
        if not ret:
            print(f"  frame {idx_out:04d}: source frame {src_index} not readable, stopping")
            break

        alpha = chroma_key_alpha(bgr)
        if DESPILL:
            bgr = despill(bgr)
        bgr_small = cv2.resize(bgr, (new_w, new_h), interpolation=cv2.INTER_AREA)
        alpha_small = cv2.resize(alpha, (new_w, new_h), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(output_dir / f"frame_{idx_out:04d}.png"), to_bgra(bgr_small, alpha_small))
        written += 1

    cap.release()

    # ── manifest ──────────────────────────────────────────────────────────
    manifest = {
        "frames": written,
        "fps": target_fps,
        "duration_s": segment_duration,
        "size": [new_w, new_h],
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"\nWrote {written} frames + manifest to {output_dir}")
    print(f"  fps={target_fps}  size={new_w}x{new_h}  segment={start:.2f}s..{end:.2f}s")


if __name__ == "__main__":
    main()
