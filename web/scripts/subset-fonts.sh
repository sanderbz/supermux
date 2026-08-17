#!/usr/bin/env bash
# Regenerate the `-core` Nerd Font subsets from the full patched faces.
#
# WHY THIS EXISTS
# ───────────────
# JetBrainsMonoNerdFontMono-{Regular,Bold}.woff2 are ~935 KB each, and 10,071 of
# their 11,431 codepoints are Nerd-Font ICON glyphs living in the two Private
# Use Areas. Terminal *text* — Latin, punctuation, box drawing, block elements,
# arrows, geometric shapes — plus the Powerline separators is ~1,400 codepoints
# and subsets to ~86 KB.
#
# `globals.css` declares the small subset as the unrestricted face and the full
# file as a second face of the same family, `unicode-range`-scoped to the PUA
# minus Powerline, so the browser fetches the big one only when it actually has
# a devicon to paint. Regenerating by hand is how the two stay in sync: the
# ranges below MUST be the complement of that `unicode-range`.
#
# Run it after upgrading the vendored Nerd Font, then commit the `-core` files.
#
#   Requires: fonttools with woff2 support  (pip install 'fonttools[woff]' brotli)
set -euo pipefail

cd "$(dirname "$0")/../public/fonts"

# The complement of globals.css's `unicode-range: U+E000-E09F, U+E0D5-F8FF,
# U+F0000-10FFFF` — i.e. everything that is not a PUA icon, plus the Powerline
# block U+E0A0-E0D4 (a Powerline prompt is the common case; it must never flash
# tofu waiting on a 935 KB download).
CORE_UNICODES='U+0-DFFF,U+E0A0-E0D4,U+F900-EFFFF'

for weight in Regular Bold; do
  src="JetBrainsMonoNerdFontMono-${weight}.woff2"
  out="JetBrainsMonoNerdFontMono-${weight}-core.woff2"
  [ -f "$src" ] || { echo "missing $src" >&2; exit 1; }
  pyftsubset "$src" \
    --unicodes="$CORE_UNICODES" \
    --layout-features='*' \
    --flavor=woff2 \
    --output-file="$out"
  printf '%-48s %8s B  ->  %-48s %8s B\n' \
    "$src" "$(stat -c%s "$src")" "$out" "$(stat -c%s "$out")"
done
