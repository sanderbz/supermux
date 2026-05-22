#!/usr/bin/env bash
# Deploy amux v3 to clawd-02 (TECH_PLAN §8.2, §8.4 coexistence).
#
# clawd-02 is aarch64 Linux with no Rust toolchain, and no Docker is available
# on dev machines for cross-compilation — so we build NATIVELY on the host:
# rsync the source, bootstrap bun + rustup if missing, run build.sh there,
# install the binary and the systemd unit, then expose v3 via tailscale serve.
#
# Coexistence guarantees (§8.4):
#   - v2 (amux.service)   : public port 8822, data dir ~/.amux        — UNTOUCHED
#   - v3 (amux-v3.service): public port 8823, data dir ~/.amux-v3
#   v2's cert helper already binds loopback :8823, so v3 binds an internal
#   loopback port (AMUX3_INTERNAL_PORT, default 8824) and `tailscale serve`
#   terminates TLS on the documented public port 8823 -> internal port.
#   Distinct data dir + distinct internal port => zero conflict.
#
# Usage:  scripts/deploy.sh
# Env:    AMUX_DEPLOY_HOST     ssh target            (default: clawd-02)
#         AMUX3_PUBLIC_PORT    tailscale https port  (default: 8823)
#         AMUX3_INTERNAL_PORT  loopback bind port    (default: 8824)
#         AMUX_REMOTE_DIR      build dir on host     (default: /opt/amux-v3)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="${AMUX_DEPLOY_HOST:-clawd-02}"
PUBLIC_PORT="${AMUX3_PUBLIC_PORT:-8823}"
INTERNAL_PORT="${AMUX3_INTERNAL_PORT:-8824}"
REMOTE_DIR="${AMUX_REMOTE_DIR:-/opt/amux-v3}"

echo "[deploy] target=$HOST  public=:$PUBLIC_PORT  internal=loopback:$INTERNAL_PORT"

# ── 1. ship source to the host (no build artifacts, no .git) ────────────────
echo "[deploy] syncing source -> $HOST:$REMOTE_DIR"
ssh "$HOST" "mkdir -p '$REMOTE_DIR'"
rsync -az --delete \
  --exclude '.git' --exclude 'target' --exclude 'node_modules' \
  --exclude 'web/dist' --exclude 'server/static' \
  ./ "$HOST:$REMOTE_DIR/"

# ── 2. build natively on the host (bootstrap toolchains if missing) ─────────
echo "[deploy] building on $HOST (native aarch64)"
ssh "$HOST" "bash -s" <<REMOTE_BUILD
set -euo pipefail
export HOME=/root
# bun
if ! command -v bun >/dev/null && [ ! -x "\$HOME/.bun/bin/bun" ]; then
  echo '[host] installing bun'
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="\$HOME/.bun/bin:\$PATH"
# rust
if ! command -v cargo >/dev/null && [ ! -x "\$HOME/.cargo/bin/cargo" ]; then
  echo '[host] installing rust via rustup'
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
[ -f "\$HOME/.cargo/env" ] && . "\$HOME/.cargo/env"
cd '$REMOTE_DIR'
bash scripts/build.sh
REMOTE_BUILD

# ── 3. install binary + systemd unit + config (atomic) ──────────────────────
echo "[deploy] installing binary, systemd unit and config on $HOST"
ssh "$HOST" "bash -s" <<REMOTE_INSTALL
set -euo pipefail
export HOME=/root

# v3 data dir + config: pin the loopback bind to the internal port so it does
# NOT collide with v2's cert helper on :8823. Generated only if absent so a
# redeploy never rotates the auth token.
mkdir -p /root/.amux-v3
if [ ! -f /root/.amux-v3/config.toml ]; then
  printf 'bind = "127.0.0.1:%s"\n' '$INTERNAL_PORT' > /root/.amux-v3/config.toml
  echo '[host] wrote /root/.amux-v3/config.toml (bind 127.0.0.1:$INTERNAL_PORT)'
fi

# binary
install -m 0755 -o root -g root \
  '$REMOTE_DIR/server/target/release/amux-server' /usr/local/bin/amux-v3-server

# systemd unit
install -m 0644 -o root -g root \
  '$REMOTE_DIR/etc/systemd/amux-v3.service' /etc/systemd/system/amux-v3.service
systemctl daemon-reload
systemctl enable amux-v3
systemctl restart amux-v3
sleep 2
systemctl is-active amux-v3
REMOTE_INSTALL

# ── 4. expose v3 on the documented public port via Tailscale ────────────────
# Tailscale terminates TLS on :$PUBLIC_PORT and proxies to the v3 backend.
# The backend speaks plain HTTP on the internal loopback port, so the proxy
# target is `http://` (NOT `https+insecure://` — that would 502).
echo "[deploy] configuring 'tailscale serve' :$PUBLIC_PORT -> localhost:$INTERNAL_PORT"
ssh "$HOST" "tailscale serve --bg --https=$PUBLIC_PORT http://localhost:$INTERNAL_PORT"

# ── 5. verify (health is #[public], no token needed) ────────────────────────
echo "[deploy] verifying v3 health on :$INTERNAL_PORT"
ssh "$HOST" "curl -sf -o /dev/null -w 'v3 /api/health -> %{http_code}\n' http://127.0.0.1:$INTERNAL_PORT/api/health"
echo "[deploy] verifying v2 still serves on :8822"
ssh "$HOST" "curl -sk -o /dev/null -w 'v2 :8822 -> %{http_code}\n' https://127.0.0.1:8822/"

echo "[deploy] done — v3 live on :$PUBLIC_PORT (Tailscale), v2 intact on :8822"
