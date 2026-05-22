#!/usr/bin/env bash
# Dev loop: run the Rust backend and the Vite dev server concurrently.
# Backend hot-reloads via cargo-watch when installed; Vite hot-reloads the
# frontend on every src edit. Ctrl-C stops both. (TECH_PLAN §M0)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# rustup installs cargo to ~/.cargo/bin, which may not be on a non-login PATH.
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

pids=()
cleanup() {
  trap - INT TERM EXIT
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup INT TERM EXIT

# ── backend ── (exec so $! is the cargo/cargo-watch process itself)
(
  cd "$ROOT/server"
  if command -v cargo-watch >/dev/null 2>&1; then
    exec cargo watch -x run
  else
    echo "[dev] cargo-watch not found — running 'cargo run' (no backend hot-reload)."
    echo "[dev] for hot-reload: cargo install cargo-watch"
    exec cargo run
  fi
) &
pids+=($!)

# ── frontend ──
(
  cd "$ROOT/web"
  exec bun run dev
) &
pids+=($!)

wait
