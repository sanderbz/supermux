#!/usr/bin/env bash
# build-icons.sh — rasterize the single-source app icon.
#
# Source:  web/public/icon.svg  (full-bleed maskable mark)
# Outputs: web/public/icon-192.png          (PWA manifest)
#          web/public/icon-512.png          (PWA manifest / splash)
#          web/public/apple-touch-icon.png  (180×180, iOS home screen)
#
# Source:  web/public/badge.svg (the mark alone, white on transparent)
# Output:  web/public/badge-96.png          (push notification status-bar badge;
#                                            Android masks it by alpha)
#
# Picks the first available rasterizer: rsvg-convert > cairosvg > magick/convert.
# Idempotent: re-run any time icon.svg changes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/web/public/icon.svg"
OUT="$ROOT/web/public"

[ -f "$SRC" ] || { echo "✗ missing source: $SRC" >&2; exit 1; }

# size -> output filename [-> source, default icon.svg]
render() {
  local size="$1" dest="$2" src="${3:-$SRC}"
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$size" -h "$size" "$src" -o "$dest"
  elif command -v cairosvg >/dev/null 2>&1; then
    cairosvg "$src" -W "$size" -H "$size" -o "$dest"
  elif command -v magick >/dev/null 2>&1; then
    magick -background none -density 384 "$src" -resize "${size}x${size}" "$dest"
  elif command -v convert >/dev/null 2>&1; then
    convert -background none -density 384 "$src" -resize "${size}x${size}" "$dest"
  else
    echo "✗ no SVG rasterizer found (install librsvg, cairosvg, or imagemagick)" >&2
    exit 1
  fi
  echo "✓ $(basename "$dest")  ${size}×${size}"
}

render 192 "$OUT/icon-192.png"
render 512 "$OUT/icon-512.png"
render 180 "$OUT/apple-touch-icon.png"
render 96 "$OUT/badge-96.png" "$OUT/badge.svg"

echo "Done. Wrote icons to web/public/."
