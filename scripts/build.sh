#!/usr/bin/env bash
# Production build (TECH_PLAN §8.1): bundle the web app, embed it into the
# server static dir, then build the release binary.
#
# Runs natively wherever it is invoked — on a dev box for local testing, or on
# the deploy host itself (clawd-02 is aarch64 Linux; deploy.sh builds there to
# avoid cross-compilation). Requires `bun` and `cargo` on PATH; deploy.sh
# bootstraps both on the host if missing.
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

echo "[build] backend: cargo build --release"
( cd server && cargo build --release )

BIN="server/target/release/supermux-server"
echo "binary: $BIN ($(du -h "$BIN" | cut -f1))"
