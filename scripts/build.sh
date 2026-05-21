#!/usr/bin/env bash
# Production build: bundle the web app, embed it into the server static dir, then
# build the release binary. (TECH_PLAN §8.1)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

cd web && bun install && bun run build && cd ..
rm -rf server/static && cp -r web/dist server/static
cd server && cargo build --release
echo "binary: server/target/release/amux-server ($(du -h server/target/release/amux-server | cut -f1))"
