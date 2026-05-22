#!/usr/bin/env bash
# build-icons.sh — rasterize the single-source app icon (M28).
#
# Source:  web/public/icon.svg  (full-bleed maskable mark)
# Outputs: web/public/icon-192.png          (PWA manifest)
#          web/public/icon-512.png          (PWA manifest / splash)
#          web/public/apple-touch-icon.png  (180×180, iOS home screen)
#
# Picks the first available rasterizer: rsvg-convert > cairosvg > magick/convert.
# Idempotent: re-run any time icon.svg changes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/web/public/icon.svg"
OUT="$ROOT/web/public"

[ -f "$SRC" ] || { echo "✗ missing source: $SRC" >&2; exit 1; }

# size -> output filename
render() {
  local size="$1" dest="$2"
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$size" -h "$size" "$SRC" -o "$dest"
  elif command -v cairosvg >/dev/null 2>&1; then
    cairosvg "$SRC" -W "$size" -H "$size" -o "$dest"
  elif command -v magick >/dev/null 2>&1; then
    magick -background none -density 384 "$SRC" -resize "${size}x${size}" "$dest"
  elif command -v convert >/dev/null 2>&1; then
    convert -background none -density 384 "$SRC" -resize "${size}x${size}" "$dest"
  else
    echo "✗ no SVG rasterizer found (install librsvg, cairosvg, or imagemagick)" >&2
    exit 1
  fi
  echo "✓ $(basename "$dest")  ${size}×${size}"
}

render 192 "$OUT/icon-192.png"
render 512 "$OUT/icon-512.png"
render 180 "$OUT/apple-touch-icon.png"

echo "Done. Wrote icons to web/public/."
