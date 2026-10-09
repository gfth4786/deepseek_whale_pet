#!/usr/bin/env python
"""
Extract the first 6 seconds of the "big fish eating tokens" video, remove the
green background via chroma key, and output a transparent PNG sequence for the
desk-pet thinking animation.

Thin wrapper around extract_video.py — the extraction, chroma key, and manifest
logic all live there.

Input:  pet/assets/video/大肥鱼吃token.mp4
Output: pet/assets/whale/eat_token/frame_0000.png, frame_0001.png, …

Usage:
    python scripts/extract_eat_token.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_video import main  # noqa: E402

PROJECT = Path(__file__).resolve().parent.parent
VIDEO = PROJECT / "pet" / "assets" / "video" / "大肥鱼吃token.mp4"
OUTPUT = PROJECT / "pet" / "assets" / "whale" / "eat_token"

# ── tunables ──────────────────────────────────────────────────────────────
DURATION_S = 6.0          # seconds to extract
# ──────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    main([
        "--input", str(VIDEO),
        "--output", str(OUTPUT),
        "--start", "0",
        "--end", str(DURATION_S),
    ])
