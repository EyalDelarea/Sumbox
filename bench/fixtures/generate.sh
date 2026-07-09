#!/usr/bin/env bash
# Generate neutral, license-free benchmark fixtures with ffmpeg's synthetic sources.
#
# Why synthetic: we must NOT commit private WhatsApp media, and we want the speed
# benchmark to be reproducible on any machine. These patterns are deterministic and
# vary in visual complexity (simple bars -> detailed fractal) so caption lengths span
# a realistic range.
#
# IMPORTANT: synthetic patterns do NOT exercise Hebrew OCR. To judge whether a vision
# model swap regresses real-world caption/OCR quality, drop real images/videos into
# bench/fixtures/local/ (gitignored) and run the harness with BENCH_FIXTURES_DIR.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/generated"
mkdir -p "$DIR"
FFMPEG="${FFMPEG_PATH:-ffmpeg}"

echo "Generating benchmark fixtures into $DIR"

# --- Still images (single-frame vision path) -------------------------------------
# 1. Detailed fractal — rich content, longer descriptions.
"$FFMPEG" -y -loglevel error -f lavfi -i "mandelbrot=size=768x768:end_pts=1" -frames:v 1 "$DIR/img-fractal.jpg"
# 2. SMPTE color bars — simple, structured, predictable.
"$FFMPEG" -y -loglevel error -f lavfi -i "smptebars=size=768x768:duration=1" -frames:v 1 "$DIR/img-bars.jpg"
# 3. testsrc2 — mixed shapes, gradients, and baked-in numerals (light OCR-ish signal).
"$FFMPEG" -y -loglevel error -f lavfi -i "testsrc2=size=768x768:duration=1" -frames:v 1 "$DIR/img-testpattern.jpg"

# --- Short video (multi-frame video path, fps=1 extraction) ----------------------
# Conway's Game of Life: visibly changes frame-to-frame, so "describe what changes
# across the frames" is a meaningful multi-frame task. 6s -> ~6 frames at fps=1.
"$FFMPEG" -y -loglevel error -f lavfi -i "life=size=512x512:rate=12:mold=10:death_color=#101010:life_color=#30d050:ratio=0.4" -t 6 -pix_fmt yuv420p "$DIR/vid-life.mp4"

echo "Done. Generated:"
ls -la "$DIR"
