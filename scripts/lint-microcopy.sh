#!/usr/bin/env bash
# lint-microcopy.sh — fail CI on off-voice microcopy.
#
# The supermux voice is builder-to-builder: calm, direct, no cheerleading. This gate
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
# WORD BOUNDARIES on every alternative (B5/T9.6). Without the leading `\b`,
# `oops` matched inside `loops` — seven false positives across the codebase, all
# in prose about render loops and event loops, which meant this gate had been
# red on `main` and was therefore not gating anything.
PATTERN='\boops\b|\bwhoops\b|\bawesome\b|\boh no\b|\byay\b|\buh[ -]?oh\b|\bgreat[!.]'

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

# ── B5/T9.6: no raw browser dialogs ─────────────────────────────────────────
#
# `window.confirm` / `alert` / `prompt` block the whole tab, cannot be styled,
# and can only render a STRING — which is why the consequence enumeration a
# destructive action needs was impossible before B5. All four call sites are
# gone; this is what stops the fifth.
#
# Cheap actions use `useArmedConfirm` + `<ArmedButton>`; consequential ones use
# `useConfirm()` from `components/ui/confirm-dialog.tsx`. That file holds the
# single sanctioned fallback (for a component rendered with no provider, in a
# test), so it is the one allowlisted path.
echo "→ dialog lint: scanning web/src for raw browser dialogs"

DIALOG_PATTERN='window\.(confirm|alert|prompt)\(|globalThis\.(confirm|alert|prompt)\?\?\.\('
if command -v rg >/dev/null 2>&1; then
  DIALOG_HITS="$(rg -n -e 'window\.(confirm|alert|prompt)\(' -e 'globalThis\.(confirm|alert|prompt)' \
    --glob '*.ts' --glob '*.tsx' \
    --glob '!**/confirm-dialog.tsx' "$SCAN_DIR" || true)"
else
  DIALOG_HITS="$(grep -rnE 'window\.(confirm|alert|prompt)\(|globalThis\.(confirm|alert|prompt)' \
    --include='*.ts' --include='*.tsx' "$SCAN_DIR" \
    | grep -v 'ui/confirm-dialog.tsx' || true)"
fi

if [ -n "$DIALOG_HITS" ]; then
  echo "✗ raw browser dialog found — use the app's own confirms:"
  echo "$DIALOG_HITS"
  echo
  echo "  Cheap + destructive     → useArmedConfirm + <ArmedButton>"
  echo "  Consequential           → useConfirm() (components/ui/confirm-dialog.tsx)"
  echo "  A blocking OS dialog can only render a string, so it can never"
  echo "  enumerate what the action actually does."
  exit 1
fi

echo "✓ no raw browser dialogs"
