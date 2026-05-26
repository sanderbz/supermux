#!/usr/bin/env bash
# Production build: bundle the web app, embed it into the server static dir,
# then build the release binary.
#
# Runs natively wherever it is invoked — on a dev box for local testing, or on
# the deploy host itself (deploy.sh builds there to avoid cross-compilation).
# Requires `bun` and `cargo` on PATH (provision them once on the host).
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

echo "[build] frontend: bun install + bun run build"
( cd web && bun install --frozen-lockfile && bun run build )

echo "[build] embedding web/dist -> server/static"
rm -rf server/static && cp -r web/dist server/static
# Force the embed to refresh. rust-embed reads `static/` at the compile time of
# static_assets.rs, but cargo does NOT track that directory as an input to that
# module — build.rs's `rerun-if-changed=static` only re-runs the build script, it
# does NOT recompile static_assets.rs. So a FRONTEND-ONLY change (no .rs edit)
# would silently keep the previously-embedded bundle: the binary serves stale UI
# even though web/dist is fresh. Touching the source guarantees cargo recompiles
# it and re-reads the new static/ — the one reliable way to never ship stale UI.
touch server/src/static_assets.rs

# Small-host RAM guard: cap concurrent rustc to halve peak memory on hosts with
# <8 GiB RAM. `cargo build --release` spawns up to $(nproc) rustc workers; each
# peaks ~1 GB during heavy LLVM codegen. On a 4-vCPU / 7.5 GiB box that's ~4 GB
# of rustc on top of a running supermux + agents → swap exhaustion → load >50 →
# box unreachable (we hit this in production). Halving the job count roughly
# halves the peak at ~25–35% wall-time cost and produces a BIT-FOR-BIT identical
# artefact. Operator override (CARGO_BUILD_JOBS already set) is preserved.
if [ -z "${CARGO_BUILD_JOBS:-}" ]; then
  ram_kib=""
  if [ -r /proc/meminfo ]; then
    ram_kib="$(awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null || true)"
  elif command -v sysctl >/dev/null 2>&1; then
    # macOS: hw.memsize is in bytes → /1024 to compare in KiB.
    ram_bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
    [ -n "$ram_bytes" ] && ram_kib=$(( ram_bytes / 1024 ))
  fi
  # Threshold: 8 GiB = 8 * 1024 * 1024 KiB = 8388608 KiB.
  if [ -n "$ram_kib" ] && [ "$ram_kib" -gt 0 ] && [ "$ram_kib" -lt 8388608 ]; then
    export CARGO_BUILD_JOBS=2
    echo "[build] small-host RAM guard: ${ram_kib} KiB total (<8 GiB) → CARGO_BUILD_JOBS=2 (halves peak rustc memory)"
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
