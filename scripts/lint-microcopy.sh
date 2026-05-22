#!/usr/bin/env bash
# lint-microcopy.sh — fail CI on off-voice microcopy (M28).
#
# The amux voice is builder-to-builder: calm, direct, no cheerleading. This gate
# greps the frontend source for banned interjections and exits non-zero if any
# slip in. Wire it into CI (and pre-commit) alongside eslint.
#
# Scope: TypeScript/TSX under web/src — that's where dialog/empty/error copy
# lives. BRAND.md and scripts/ legitimately *name* the banned words to document
# them, so they're intentionally out of scope.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN_DIR="$ROOT/web/src"

# Case-insensitive, extended-regex. "great" only matches as an interjection
# (followed by ! or .) so words like "greater" / "integrate" don't false-fire.
PATTERN='oops|whoops|awesome|oh no|\byay\b|uh[ -]?oh|great[!.]'

echo "→ microcopy lint: scanning web/src for off-voice strings"

if command -v rg >/dev/null 2>&1; then
  HITS="$(rg -n -i -e "$PATTERN" --glob '*.ts' --glob '*.tsx' "$SCAN_DIR" || true)"
else
  HITS="$(grep -rniE "$PATTERN" --include='*.ts' --include='*.tsx' "$SCAN_DIR" || true)"
fi

if [ -n "$HITS" ]; then
  echo "✗ banned microcopy found (use builder voice — see web/src/brand/BRAND.md):"
  echo "$HITS"
  echo
  echo "  Banned: Oops, Whoops, Awesome, Oh no, Yay, Uh oh, Great! / Great."
  exit 1
fi

echo "✓ microcopy clean"
