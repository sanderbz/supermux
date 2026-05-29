#!/usr/bin/env bash
# Production build: bundle the web app, embed it into the server static dir,
# then build the release binary.
#
# Runs natively wherever it is invoked — on a dev box for local testing, or on
# the deploy host itself (deploy.sh builds there to avoid cross-compilation).
# Requires `bun` and `cargo` on PATH (provision them once on the host).
#
# INCREMENTAL FAST-PATH:
#   - On the workstation path, deploy.sh PRESERVES $REMOTE_DIR/server/target
#     and $REMOTE_DIR/web/node_modules between deploys (via rsync --exclude),
#     so cargo's incremental cache + bun's symlink tree survive. This file then
#     SKIPS the expensive halves (bun install / vite build / touch-and-relink)
#     when their inputs haven't changed since the last build, using sha256
#     stamps written to .supermux-* sidecars under the cached dirs themselves.
#   - On the on-server path (scripts/deploy-self.sh) the same caches naturally
#     survive — the same skip stamps work without any extra plumbing.
#   - Hard reset: `SUPERMUX_NO_CACHE=1 bash scripts/build.sh` clears the stamps
#     and forces a full rebuild. deploy.sh exposes this as `--no-cache`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# rustup installs cargo to ~/.cargo/bin, which may not be on a non-login PATH.
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
# bun installs to ~/.bun/bin.
[ -d "$HOME/.bun/bin" ] && export PATH="$HOME/.bun/bin:$PATH"

command -v bun   >/dev/null || { echo "build.sh: 'bun' not found on PATH" >&2; exit 1; }
command -v cargo >/dev/null || { echo "build.sh: 'cargo' not found on PATH" >&2; exit 1; }

# ── pure helper: sha256 of a file (portable: prefer sha256sum, fall back to shasum) ──
_sha256_of_file() {
  local f="$1"
  if [ ! -e "$f" ]; then printf ''; return; fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  else
    shasum -a 256 "$f" | awk '{print $1}'
  fi
}

# ── pure helper: hash every file under one or more roots (deterministic order) ──
# Stable across runs: find sorts by path so a renamed/added/removed file changes the hash.
_sha256_of_tree() {
  local hasher="sha256sum"
  command -v "$hasher" >/dev/null 2>&1 || hasher="shasum -a 256"
  # Existence check FIRST — find on a missing path errors and would wedge the
  # check (treated as "changed" by the caller, which is conservative but noisy).
  local roots=()
  for r in "$@"; do [ -e "$r" ] && roots+=("$r"); done
  [ ${#roots[@]} -eq 0 ] && { printf ''; return; }
  # -print0 + sort -z keeps spaces/newlines in paths from corrupting the hash.
  find "${roots[@]}" -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 $hasher 2>/dev/null \
    | $hasher \
    | awk '{print $1}'
}

# ── caller-visible cache control: SUPERMUX_NO_CACHE=1 force a full rebuild ──
NO_CACHE="${SUPERMUX_NO_CACHE:-0}"
if [ "$NO_CACHE" = "1" ]; then
  echo "[build] SUPERMUX_NO_CACHE=1 — clearing skip stamps (full rebuild)"
  rm -f web/node_modules/.supermux-bun-lock-hash 2>/dev/null || true
  rm -f web/dist/.supermux-web-inputs-hash 2>/dev/null || true
  rm -f server/static/.supermux-static-hash 2>/dev/null || true
fi

# ── Win 5a: skip `bun install` when bun.lock hash matches last successful install ──
# `bun install --frozen-lockfile` already aborts on lockfile drift, so the only
# work it does on a "no dep change" deploy is the symlink dance + integrity
# walk (20–80s of pure overhead). Hash bun.lock against a stamp in
# node_modules/ — when they match, we KNOW the existing tree is in sync with
# the locked deps and can skip the call entirely.
SKIP_BUN=0
BUN_LOCK_HASH=""
if [ -f web/bun.lock ] && [ -d web/node_modules ]; then
  BUN_LOCK_HASH="$(_sha256_of_file web/bun.lock)"
  if [ -f web/node_modules/.supermux-bun-lock-hash ] \
     && [ "$BUN_LOCK_HASH" = "$(cat web/node_modules/.supermux-bun-lock-hash 2>/dev/null)" ]; then
    SKIP_BUN=1
  fi
fi

# ── Win 5b: skip `vite build` when no input under web/ has changed ──
# We hash every input dir/file vite actually consumes; if the hash matches the
# stamp written next to the last produced dist/, skipping is safe (worst case:
# we'd re-ship the same bytes). The static-touch+cargo-relink chain below is
# ALSO gated on the same stamp, so we only force a relink when vite ran.
SKIP_VITE=0
WEB_INPUTS_HASH=""
# Inputs vite cares about: src + public assets + entry HTML + every config that
# influences output. tailwind config name varies by version (tailwind.config.{js,ts}).
WEB_INPUT_PATHS=(
  web/src
  web/public
  web/index.html
  web/package.json
  web/bun.lock
  web/vite.config.ts
  web/tsconfig.json
  web/tsconfig.app.json
  web/tsconfig.node.json
  web/tailwind.config.js
  web/tailwind.config.ts
  web/postcss.config.js
  web/postcss.config.ts
)
if [ -d web/dist ] && [ -f web/dist/index.html ]; then
  WEB_INPUTS_HASH="$(_sha256_of_tree "${WEB_INPUT_PATHS[@]}")"
  if [ -n "$WEB_INPUTS_HASH" ] \
     && [ -f web/dist/.supermux-web-inputs-hash ] \
     && [ "$WEB_INPUTS_HASH" = "$(cat web/dist/.supermux-web-inputs-hash 2>/dev/null)" ]; then
    SKIP_VITE=1
  fi
fi

# ── Win 3 (Hash-gate the touch): if web/dist hash matches the last embedded
# tree's hash, the embed is already current → skip both the cp + the touch. ──
# Without the touch, rust-embed re-reads the same static/ and cargo can do a
# zero-recompile incremental (just a 5–10 s cargo check).
STATIC_HASH_NEW=""
STATIC_HASH_OLD=""
STATIC_HASH_OLD_FILE="server/static/.supermux-static-hash"
if [ -d web/dist ]; then
  STATIC_HASH_NEW="$(_sha256_of_tree web/dist)"
fi
[ -f "$STATIC_HASH_OLD_FILE" ] && STATIC_HASH_OLD="$(cat "$STATIC_HASH_OLD_FILE" 2>/dev/null || true)"

# Echo what's being skipped — operator visibility is the difference between
# "deploy got mysteriously fast" and "we know exactly which halves were no-ops".
echo "[build] incremental: skip bun=$([ "$SKIP_BUN" = "1" ] && echo yes || echo no) skip vite=$([ "$SKIP_VITE" = "1" ] && echo yes || echo no) skip static-touch=$([ -n "$STATIC_HASH_NEW" ] && [ "$STATIC_HASH_NEW" = "$STATIC_HASH_OLD" ] && echo yes || echo no)"

# ── frontend halves (gated above) ──
if [ "$SKIP_BUN" = "1" ]; then
  echo "[build] frontend: bun.lock unchanged — skipping 'bun install' (node_modules cache hit)"
else
  echo "[build] frontend: bun install (lockfile changed or no cache)"
  ( cd web && bun install --frozen-lockfile )
  # Re-hash AFTER install — captures the post-install state in case anything
  # weird happened (e.g. someone hand-edited bun.lock mid-install). Safe.
  if [ -f web/bun.lock ]; then
    _sha256_of_file web/bun.lock > web/node_modules/.supermux-bun-lock-hash
  fi
fi

if [ "$SKIP_VITE" = "1" ]; then
  echo "[build] frontend: web/ inputs unchanged — skipping 'bun run build' (dist cache hit)"
else
  echo "[build] frontend: bun run build (web/ inputs changed or no cache)"
  ( cd web && bun run build )
  # Stamp the new dist with the inputs hash we computed BEFORE the build
  # (inputs haven't changed during the build — hashing again is unnecessary).
  if [ -d web/dist ]; then
    if [ -z "$WEB_INPUTS_HASH" ]; then
      WEB_INPUTS_HASH="$(_sha256_of_tree "${WEB_INPUT_PATHS[@]}")"
    fi
    printf '%s' "$WEB_INPUTS_HASH" > web/dist/.supermux-web-inputs-hash
  fi
fi

# ── embed web/dist → server/static, hash-gated to avoid pointless touch ──
# Compute the NEW dist hash AFTER the (possibly skipped) vite build — vite
# changes dist/ in place, so a SKIP path leaves dist/ as-is and a RUN path
# replaces it. Recompute either way for correctness.
STATIC_HASH_NEW="$(_sha256_of_tree web/dist 2>/dev/null || printf '')"
if [ -n "$STATIC_HASH_NEW" ] && [ "$STATIC_HASH_NEW" = "$STATIC_HASH_OLD" ] && [ -d server/static ]; then
  echo "[build] embed: web/dist hash matches server/static stamp — skipping cp + touch (cargo can do a zero-recompile incremental)"
else
  echo "[build] embedding web/dist -> server/static"
  rm -rf server/static && cp -r web/dist server/static
  # Force the embed to refresh. rust-embed reads `static/` at the compile time of
  # static_assets.rs, but cargo does NOT track that directory as an input to that
  # module — build.rs's `rerun-if-changed=static` only re-runs the build script, it
  # does NOT recompile static_assets.rs. So a FRONTEND-ONLY change (no .rs edit)
  # would silently keep the previously-embedded bundle: the binary serves stale UI
  # even though web/dist is fresh. Touching the source guarantees cargo recompiles
  # it and re-reads the new static/ — the one reliable way to never ship stale UI.
  #
  # WE STILL TOUCH HERE — Win 3 just gates WHEN we run this whole branch on a
  # content hash. If we entered this branch, dist actually changed, so the touch
  # is load-bearing for correctness (do NOT remove the touch — only gate it).
  touch server/src/static_assets.rs
  # Stamp the new static hash for the next deploy's skip check.
  if [ -n "$STATIC_HASH_NEW" ]; then
    printf '%s' "$STATIC_HASH_NEW" > "$STATIC_HASH_OLD_FILE"
  fi
fi

# ── Win 4: smart -j gating on MemAvailable, not MemTotal ──
# `cargo build --release` spawns up to $(nproc) rustc workers; each peaks
# ~1 GB during heavy LLVM codegen. On a 4-vCPU / 7.5 GiB box that's ~4 GB of
# rustc on top of a running supermux + agents → swap exhaustion → load >50 →
# box unreachable (we hit this in production).
#
# The OLD check capped at -j 2 whenever MemTotal < 8 GiB. But a 7.5 GiB box
# with 6 GiB AVAILABLE has plenty of room for -j 4 — MemTotal doesn't move,
# but MemAvailable does. Read MemAvailable just before invoking cargo:
#   - MemAvailable >= 4 GiB → leave CARGO_BUILD_JOBS unset (cargo defaults to
#     the parallelism it picks for the host = fast path).
#   - MemAvailable <  4 GiB → cap to -j 2 (the wedge-prevention guard rail).
# Operator override (CARGO_BUILD_JOBS pre-set) is preserved either way.
if [ -z "${CARGO_BUILD_JOBS:-}" ]; then
  mem_avail_kib=""
  mem_total_kib=""
  if [ -r /proc/meminfo ]; then
    mem_avail_kib="$(awk '/^MemAvailable:/ {print $2; exit}' /proc/meminfo 2>/dev/null || true)"
    mem_total_kib="$(awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null || true)"
  elif command -v sysctl >/dev/null 2>&1; then
    # macOS: hw.memsize is in bytes → /1024 to compare in KiB. macOS has no
    # /proc/meminfo, so we don't have a real MemAvailable; treat MemTotal as a
    # safe upper bound (macOS dev boxes are not the wedge-prone target anyway).
    ram_bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
    [ -n "$ram_bytes" ] && mem_total_kib=$(( ram_bytes / 1024 ))
    mem_avail_kib="$mem_total_kib"
  fi
  # Thresholds: 4 GiB = 4*1024*1024 = 4194304 KiB; 8 GiB = 8388608 KiB.
  # Two-stage gate:
  #   (1) only consider capping at all if MemTotal < 8 GiB (the wedge regime);
  #   (2) within that regime, cap only if MemAvailable < 4 GiB right now.
  # This lets a small box building on an idle moment (e.g. fresh boot, agents
  # paused) use full parallelism, while still capping a small box that's
  # actually under memory pressure.
  if [ -n "$mem_total_kib" ] && [ "$mem_total_kib" -gt 0 ] && [ "$mem_total_kib" -lt 8388608 ]; then
    if [ -n "$mem_avail_kib" ] && [ "$mem_avail_kib" -gt 0 ] && [ "$mem_avail_kib" -lt 4194304 ]; then
      export CARGO_BUILD_JOBS=2
      echo "[build] small-host RAM guard: ${mem_total_kib} KiB total + ${mem_avail_kib} KiB avail (<4 GiB free) → CARGO_BUILD_JOBS=2 (halves peak rustc memory)"
    else
      echo "[build] small-host RAM check: ${mem_total_kib} KiB total + ${mem_avail_kib:-?} KiB avail (≥4 GiB free) → leaving CARGO_BUILD_JOBS unset (full parallelism)"
    fi
  fi
fi

echo "[build] backend: cargo build --release"
# Pass the opt-in env that lets the clawd-bin cargo-guard wrapper allow this
# `--release` invocation through (the wrapper otherwise refuses on hosts where
# it's installed — to stop agents from running ad-hoc compile-checks that
# OOM-thrash the live server). See etc/clawd-bin/cargo for the rationale.
( cd server && SUPERMUX_RELEASE_OK=1 cargo build --release )

BIN="server/target/release/supermux-server"
echo "binary: $BIN ($(du -h "$BIN" | cut -f1))"
