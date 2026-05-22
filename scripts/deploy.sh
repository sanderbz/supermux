#!/usr/bin/env bash
# Deploy amux v3 to clawd-02 (TECH_PLAN §8.2, §8.4 coexistence).
#
# clawd-02 is aarch64 Linux with no Rust toolchain on a dev machine, and no
# Docker for cross-compilation — so we build NATIVELY on the host: ship a
# pinned source snapshot, run build.sh there, install the binary and the
# systemd unit, then expose v3 via tailscale serve.
#
# REPRODUCIBILITY (review R4-04): the source shipped to the host is a
# `git archive` of a single committed ref (HEAD by default). The working tree
# must be clean — uncommitted changes are refused — so the deployed artifact
# always corresponds exactly to a known commit SHA, which is recorded into
# /opt/amux-v3/DEPLOYED_SHA on the host and echoed here.
#
# SUPPLY CHAIN (review R4-05): this script does NOT fetch-and-execute toolchain
# installers (no `curl|bash` rustup/bun bootstrap). `bun` and `cargo` are
# expected to be pre-provisioned on clawd-02 (one-time, out of band); the
# remote build hard-fails with a clear message if either is missing rather
# than auto-installing as root.
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
#         AMUX_DEPLOY_REF      git ref to deploy     (default: HEAD)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="${AMUX_DEPLOY_HOST:-clawd-02}"
PUBLIC_PORT="${AMUX3_PUBLIC_PORT:-8823}"
INTERNAL_PORT="${AMUX3_INTERNAL_PORT:-8824}"
REMOTE_DIR="${AMUX_REMOTE_DIR:-/opt/amux-v3}"
DEPLOY_REF="${AMUX_DEPLOY_REF:-HEAD}"

# ── 0. pin the source: require a clean tree, resolve the exact commit ───────
# A non-reproducible deploy (shipping a dirty working tree) is refused here:
# the deployed artifact must always map back to a single committed SHA.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "[deploy] error: not a git repository — cannot pin a deploy ref" >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[deploy] error: working tree is dirty — commit or stash before deploying" >&2
  echo "[deploy]        (deploys ship a pinned 'git archive', never the live tree)" >&2
  exit 1
fi
GIT_SHA="$(git rev-parse "$DEPLOY_REF")"
GIT_SHA_SHORT="$(git rev-parse --short "$DEPLOY_REF")"

echo "[deploy] target=$HOST  public=:$PUBLIC_PORT  internal=loopback:$INTERNAL_PORT"
echo "[deploy] deploying commit $GIT_SHA_SHORT ($GIT_SHA)"

# ── 1. ship a pinned source snapshot to the host ────────────────────────────
# `git archive` emits exactly the tracked content at $GIT_SHA — no .git, no
# build artifacts, no uncommitted edits. The host build is thus reproducible
# from the recorded SHA.
echo "[deploy] shipping git archive of $GIT_SHA_SHORT -> $HOST:$REMOTE_DIR"
ssh "$HOST" "rm -rf '$REMOTE_DIR' && mkdir -p '$REMOTE_DIR'"
git archive --format=tar "$GIT_SHA" | ssh "$HOST" "tar -x -C '$REMOTE_DIR'"

# ── 2. build natively on the host (toolchains MUST be pre-provisioned) ───────
echo "[deploy] building on $HOST (native aarch64)"
ssh "$HOST" "bash -s" <<REMOTE_BUILD
set -euo pipefail
export HOME=/home/sander
# rustup/bun install into the user's home — make them discoverable on a
# non-login PATH. We do NOT install them: a missing toolchain is a hard error.
[ -d "\$HOME/.bun/bin" ] && export PATH="\$HOME/.bun/bin:\$PATH"
[ -f "\$HOME/.cargo/env" ] && . "\$HOME/.cargo/env"
if ! command -v bun >/dev/null; then
  echo '[host] error: bun not found — provision it once on this host (see TECH_PLAN §8.2)' >&2
  exit 1
fi
if ! command -v cargo >/dev/null; then
  echo '[host] error: cargo not found — provision the Rust toolchain once on this host' >&2
  exit 1
fi
cd '$REMOTE_DIR'
bash scripts/build.sh
REMOTE_BUILD

# ── 3. install binary + systemd unit + config (atomic) ──────────────────────
# Runs under sudo: the build runs as the unprivileged deploy account, but
# installing into /usr/local/bin + /etc/systemd needs root. The service itself
# runs unprivileged (review R4-02 — see etc/systemd/amux-v3.service).
echo "[deploy] installing binary, systemd unit and config on $HOST"
ssh "$HOST" "sudo bash -s" <<REMOTE_INSTALL
set -euo pipefail

# v3 data dir + config, owned by the unprivileged service account. Pin the
# loopback bind to the internal port so it does NOT collide with v2's cert
# helper on :8823. config.toml is generated only if absent so a redeploy never
# rotates the auth token.
install -d -o sander -g sander -m 0700 /home/sander/.amux-v3
if [ ! -f /home/sander/.amux-v3/config.toml ]; then
  printf 'bind = "127.0.0.1:%s"\n' '$INTERNAL_PORT' > /home/sander/.amux-v3/config.toml
  chown sander:sander /home/sander/.amux-v3/config.toml
  chmod 0600 /home/sander/.amux-v3/config.toml
  echo '[host] wrote /home/sander/.amux-v3/config.toml (bind 127.0.0.1:$INTERNAL_PORT)'
fi

# binary
install -m 0755 -o root -g root \
  '$REMOTE_DIR/server/target/release/amux-server' /usr/local/bin/amux-v3-server

# record the deployed commit so 'what is running on clawd-02' is answerable
printf '%s\n' '$GIT_SHA' > '$REMOTE_DIR/DEPLOYED_SHA'
echo '[host] deployed commit: $GIT_SHA_SHORT ($GIT_SHA)'

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
ssh "$HOST" "sudo tailscale serve --bg --https=$PUBLIC_PORT http://localhost:$INTERNAL_PORT"

# ── 5. verify (health is #[public], no token needed) ────────────────────────
echo "[deploy] verifying v3 health on :$INTERNAL_PORT"
ssh "$HOST" "curl -sf -o /dev/null -w 'v3 /api/health -> %{http_code}\n' http://127.0.0.1:$INTERNAL_PORT/api/health"
echo "[deploy] verifying v2 still serves on :8822"
ssh "$HOST" "curl -sk -o /dev/null -w 'v2 :8822 -> %{http_code}\n' https://127.0.0.1:8822/"

echo "[deploy] done — v3 (commit $GIT_SHA_SHORT) live on :$PUBLIC_PORT (Tailscale), v2 intact on :8822"
