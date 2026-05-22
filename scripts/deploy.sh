#!/usr/bin/env bash
# Deploy supermux to a host.
#
# The deploy host typically has no Rust toolchain on a dev machine and no
# Docker for cross-compilation — so we build NATIVELY on the host: ship a
# pinned source snapshot, run build.sh there, install the binary and the
# systemd unit, then optionally expose the service via `tailscale serve`.
#
# REPRODUCIBILITY: the source shipped to the host is a `git archive` of a
# single committed ref (HEAD by default). The working tree must be clean —
# uncommitted changes are refused — so the deployed artifact always
# corresponds exactly to a known commit SHA, which is recorded into
# $REMOTE_DIR/DEPLOYED_SHA on the host and echoed here.
#
# SUPPLY CHAIN: this script does NOT fetch-and-execute toolchain installers
# (no `curl|bash` rustup/bun bootstrap). `bun` and `cargo` are expected to be
# pre-provisioned on the host (one-time, out of band); the remote build
# hard-fails with a clear message if either is missing rather than
# auto-installing as root.
#
# CONFIGURATION: all settings come from environment variables. Copy
# `.env.example` to `.env` and fill in your values — this script sources
# `.env` automatically if present.
#
# Env:  SUPERMUX_DEPLOY_HOST    ssh target              (REQUIRED, no default)
#       SUPERMUX_SERVICE_USER   service account on host (default: supermux)
#       SUPERMUX_DATA_DIR       data dir on host        (default: derived from user)
#       SUPERMUX_INTERNAL_PORT  loopback bind port      (default: 8824)
#       SUPERMUX_PUBLIC_PORT    tailscale https port    (default: 8823)
#       SUPERMUX_USE_TAILSCALE  expose via tailscale    (default: 0 = off)
#       SUPERMUX_REMOTE_DIR     build dir on host       (default: /opt/supermux)
#       SUPERMUX_DEPLOY_REF     git ref to deploy       (default: HEAD)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── source local config from .env if present (gitignored; see .env.example) ─
[ -f .env ] && set -a && . ./.env && set +a

HOST="${SUPERMUX_DEPLOY_HOST:-}"
if [ -z "$HOST" ]; then
  echo "[deploy] error: SUPERMUX_DEPLOY_HOST is not set." >&2
  echo "[deploy]        set SUPERMUX_DEPLOY_HOST or create .env — see .env.example" >&2
  exit 1
fi

SERVICE_USER="${SUPERMUX_SERVICE_USER:-supermux}"
DATA_DIR="${SUPERMUX_DATA_DIR:-/home/$SERVICE_USER/.supermux}"
PUBLIC_PORT="${SUPERMUX_PUBLIC_PORT:-8823}"
INTERNAL_PORT="${SUPERMUX_INTERNAL_PORT:-8824}"
USE_TAILSCALE="${SUPERMUX_USE_TAILSCALE:-0}"
REMOTE_DIR="${SUPERMUX_REMOTE_DIR:-/opt/supermux}"
DEPLOY_REF="${SUPERMUX_DEPLOY_REF:-HEAD}"

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

echo "[deploy] target=$HOST  user=$SERVICE_USER  internal=loopback:$INTERNAL_PORT"
echo "[deploy] deploying commit $GIT_SHA_SHORT ($GIT_SHA)"

# ── 1. ship a pinned source snapshot to the host ────────────────────────────
# `git archive` emits exactly the tracked content at $GIT_SHA — no .git, no
# build artifacts, no uncommitted edits. The host build is thus reproducible
# from the recorded SHA.
echo "[deploy] shipping git archive of $GIT_SHA_SHORT -> $HOST:$REMOTE_DIR"
ssh "$HOST" "rm -rf '$REMOTE_DIR' && mkdir -p '$REMOTE_DIR'"
git archive --format=tar "$GIT_SHA" | ssh "$HOST" "tar -x -C '$REMOTE_DIR'"

# ── 2. build natively on the host (toolchains MUST be pre-provisioned) ───────
echo "[deploy] building on $HOST"
ssh "$HOST" "bash -s" <<REMOTE_BUILD
set -euo pipefail
# rustup/bun install into the user's home — make them discoverable on a
# non-login PATH. We do NOT install them: a missing toolchain is a hard error.
[ -d "\$HOME/.bun/bin" ] && export PATH="\$HOME/.bun/bin:\$PATH"
[ -f "\$HOME/.cargo/env" ] && . "\$HOME/.cargo/env"
if ! command -v bun >/dev/null; then
  echo '[host] error: bun not found — provision it once on this host' >&2
  exit 1
fi
if ! command -v cargo >/dev/null; then
  echo '[host] error: cargo not found — provision the Rust toolchain once on this host' >&2
  exit 1
fi
cd '$REMOTE_DIR'
bash scripts/build.sh
REMOTE_BUILD

# ── 3. render the systemd unit template from env ────────────────────────────
# The committed unit (etc/systemd/supermux.service) is a template with
# __SERVICE_USER__ / __DATA_DIR__ placeholders; fill them in here and, when
# Tailscale is enabled, uncomment the optional After/Wants=tailscaled lines.
echo "[deploy] rendering systemd unit (user=$SERVICE_USER data_dir=$DATA_DIR)"
UNIT_TMP="$(mktemp)"
trap 'rm -f "$UNIT_TMP"' EXIT
sed -e "s|__SERVICE_USER__|$SERVICE_USER|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    etc/systemd/supermux.service > "$UNIT_TMP"
if [ "$USE_TAILSCALE" = "1" ]; then
  sed -i.bak \
    -e 's|^# After=tailscaled.service|After=tailscaled.service|' \
    -e 's|^# Wants=tailscaled.service|Wants=tailscaled.service|' \
    "$UNIT_TMP" && rm -f "$UNIT_TMP.bak"
fi

# ── 4. install binary + systemd unit + config (atomic) ──────────────────────
# Runs under sudo: the build runs as the unprivileged deploy account, but
# installing into /usr/local/bin + /etc/systemd needs root. The service itself
# runs unprivileged (see etc/systemd/supermux.service).
echo "[deploy] installing binary, systemd unit and config on $HOST"
scp "$UNIT_TMP" "$HOST:/tmp/supermux.service.rendered"
ssh "$HOST" "sudo bash -s" <<REMOTE_INSTALL
set -euo pipefail

# Data dir + config, owned by the unprivileged service account. Pin the
# loopback bind to the internal port. config.toml is generated only if absent
# so a redeploy never rotates the auth token.
install -d -o '$SERVICE_USER' -g '$SERVICE_USER' -m 0700 '$DATA_DIR'
if [ ! -f '$DATA_DIR/config.toml' ]; then
  printf 'bind = "127.0.0.1:%s"\n' '$INTERNAL_PORT' > '$DATA_DIR/config.toml'
  chown '$SERVICE_USER:$SERVICE_USER' '$DATA_DIR/config.toml'
  chmod 0600 '$DATA_DIR/config.toml'
  echo '[host] wrote $DATA_DIR/config.toml (bind 127.0.0.1:$INTERNAL_PORT)'
fi

# binary
install -m 0755 -o root -g root \
  '$REMOTE_DIR/server/target/release/supermux-server' /usr/local/bin/supermux-server

# record the deployed commit so 'what is running on this host' is answerable
printf '%s\n' '$GIT_SHA' > '$REMOTE_DIR/DEPLOYED_SHA'
echo '[host] deployed commit: $GIT_SHA_SHORT ($GIT_SHA)'

# systemd unit (rendered from the template by deploy.sh)
install -m 0644 -o root -g root \
  /tmp/supermux.service.rendered /etc/systemd/system/supermux.service
rm -f /tmp/supermux.service.rendered
systemctl daemon-reload
systemctl enable supermux
systemctl restart supermux
sleep 2
systemctl is-active supermux
REMOTE_INSTALL

# ── 5. expose the service (TLS) ─────────────────────────────────────────────
# The backend speaks plain HTTP on the internal loopback port. Terminate TLS
# either via `tailscale serve` (set SUPERMUX_USE_TAILSCALE=1) or with your own
# reverse proxy (nginx/Caddy) pointed at http://localhost:$INTERNAL_PORT.
if [ "$USE_TAILSCALE" = "1" ]; then
  echo "[deploy] configuring 'tailscale serve' :$PUBLIC_PORT -> localhost:$INTERNAL_PORT"
  ssh "$HOST" "sudo tailscale serve --bg --https=$PUBLIC_PORT http://localhost:$INTERNAL_PORT"
else
  echo "[deploy] SUPERMUX_USE_TAILSCALE not set — skipping 'tailscale serve'."
  echo "[deploy] front the loopback port with a reverse proxy (nginx/Caddy):"
  echo "[deploy]   proxy https://<your-domain> -> http://localhost:$INTERNAL_PORT"
fi

# ── 6. verify (health is public, no token needed) ───────────────────────────
echo "[deploy] verifying health on loopback:$INTERNAL_PORT"
ssh "$HOST" "curl -sf -o /dev/null -w '/api/health -> %{http_code}\n' http://127.0.0.1:$INTERNAL_PORT/api/health"

echo "[deploy] done — supermux (commit $GIT_SHA_SHORT) live on $HOST loopback:$INTERNAL_PORT"
