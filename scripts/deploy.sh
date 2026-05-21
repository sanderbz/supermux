#!/usr/bin/env bash
# Deploy: ship the release binary and restart the systemd service.
# Placeholder wired per TECH_PLAN §8.2 — fleshed out / verified in M25.
# Assumes scripts/build.sh has produced server/target/release/amux-server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="${AMUX_DEPLOY_HOST:-clawd-02}"

scp server/target/release/amux-server "$HOST":/tmp/amux-server-new
ssh "$HOST" 'sudo install -m 0755 -o root -g root /tmp/amux-server-new /usr/local/bin/amux-v3-server
             sudo systemctl restart amux-v3
             sleep 2 && sudo systemctl is-active amux-v3'
