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
# Env:  SUPERMUX_DEPLOY_HOST       ssh target              (REQUIRED, no default)
#       SUPERMUX_SERVICE_USER      service account on host (default: supermux)
#       SUPERMUX_ALLOW_ROOT        opt in to User=root + relaxed hardening (default: 0)
#       SUPERMUX_USER_HOME         service user's login home (default: derived from user)
#       SUPERMUX_DATA_DIR          data dir on host        (default: derived from user)
#       SUPERMUX_READ_WRITE_PATHS  extra writable dirs     (default: derived from user)
#       SUPERMUX_INTERNAL_PORT     loopback bind port      (default: 8824)
#       SUPERMUX_PUBLIC_PORT       tailscale https port    (default: 8823)
#       SUPERMUX_USE_TAILSCALE     expose via tailscale    (default: 0 = off)
#       SUPERMUX_REMOTE_DIR        build dir on host       (default: /opt/supermux)
#       SUPERMUX_DEPLOY_REF        git ref to deploy       (default: HEAD)
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
ALLOW_ROOT="${SUPERMUX_ALLOW_ROOT:-0}"
PUBLIC_PORT="${SUPERMUX_PUBLIC_PORT:-8823}"
INTERNAL_PORT="${SUPERMUX_INTERNAL_PORT:-8824}"
USE_TAILSCALE="${SUPERMUX_USE_TAILSCALE:-0}"
REMOTE_DIR="${SUPERMUX_REMOTE_DIR:-/opt/supermux}"
DEPLOY_REF="${SUPERMUX_DEPLOY_REF:-HEAD}"

# ── refuse User=root unless explicitly opted in ─────────────────────────────
# The systemd unit's hardening directives are written for an unprivileged
# user — `ProtectHome=true` masks /root, so a root-owned data dir under
# /root/.supermux is unreachable and the unit refuses to start (this is the
# bug that broke clawd-02 and required a hand-edit of the installed unit).
# Demand an explicit opt-in: SUPERMUX_ALLOW_ROOT=1 trades the user-level
# isolation away in exchange for ProtectHome=false + ReadWritePaths=/root.
if [ "$SERVICE_USER" = "root" ] && [ "$ALLOW_ROOT" != "1" ]; then
  echo "[deploy] error: SUPERMUX_SERVICE_USER=root is incoherent with the hardening directives" >&2
  echo "[deploy]        (ProtectHome=true blocks /root; the unit won't start)." >&2
  echo "[deploy]        Pick an unprivileged user (recommended), OR set SUPERMUX_ALLOW_ROOT=1 to" >&2
  echo "[deploy]        explicitly opt out of hardening and accept the security trade-off." >&2
  exit 1
fi

# ── derive the service user's login HOME (separate from the data dir) ───────
# The systemd unit's WorkingDirectory + $HOME point at USER_HOME (the actual
# login home), not the supermux data dir. This keeps spawned shells/agents
# (claude, codex, tmux children) writing their dotfiles (.bash_history,
# .claude/, .claude.json, .cache/, .local/, …) into the conventional place
# instead of polluting $SUPERMUX_DATA_DIR.
#
# Resolution order:
#   1. SUPERMUX_USER_HOME if set (operator override for non-standard layouts).
#   2. /root if the service user is root.
#   3. The home field from `getent passwd` on the LOCAL deploy host if the
#      account happens to exist here too (common dev setup: same username on
#      laptop and server). This is a local-only convenience; the host's own
#      passwd database is what actually matters at runtime, but the systemd
#      unit just embeds an absolute path so a local lookup is fine for the
#      vast majority of standard Linux layouts.
#   4. /home/<user> as the Linux-convention fallback. Warn so the operator
#      knows we guessed (the account may not even exist on the host yet).
if [ -n "${SUPERMUX_USER_HOME:-}" ]; then
  USER_HOME="$SUPERMUX_USER_HOME"
elif [ "$SERVICE_USER" = "root" ]; then
  USER_HOME="/root"
elif command -v getent >/dev/null 2>&1 && getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
  USER_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
else
  USER_HOME="/home/$SERVICE_USER"
  echo "[deploy] warn: could not resolve home for '$SERVICE_USER' locally;" >&2
  echo "[deploy]       defaulting to $USER_HOME (override via SUPERMUX_USER_HOME)." >&2
fi

# DATA_DIR default depends on whether the service user is root. This is
# DELIBERATELY a sibling of USER_HOME — not equal to it — so the data dir is
# its own scoped tree (easy to back up, easy to wipe without nuking the
# user's shell history or agent caches).
if [ "$SERVICE_USER" = "root" ]; then
  DATA_DIR="${SUPERMUX_DATA_DIR:-/root/.supermux}"
else
  DATA_DIR="${SUPERMUX_DATA_DIR:-$USER_HOME/.supermux}"
fi

# Hardening knobs rendered into the template. Defaults match the unprivileged
# baseline (ProtectHome=true, ReadWritePaths=$DATA_DIR). For root deploys we
# relax ProtectHome to false (so /root is reachable) and broaden the writable
# set to /root (so tmux/git/claude can operate in arbitrary subdirs).
# SUPERMUX_READ_WRITE_PATHS lets non-root operators broaden the set too — pass
# a colon-separated list (converted to spaces for the unit), e.g.
# "/home/supermux:/opt/projects".
if [ "$SERVICE_USER" = "root" ]; then
  PROTECT_HOME_DEFAULT="false"
  READ_WRITE_PATHS_DEFAULT="/root"
else
  PROTECT_HOME_DEFAULT="true"
  READ_WRITE_PATHS_DEFAULT="$DATA_DIR"
fi
PROTECT_HOME="${SUPERMUX_PROTECT_HOME:-$PROTECT_HOME_DEFAULT}"
# Accept either colon- or whitespace-separated input; emit whitespace
# per systemd ReadWritePaths= grammar.
READ_WRITE_PATHS_RAW="${SUPERMUX_READ_WRITE_PATHS:-$READ_WRITE_PATHS_DEFAULT}"
READ_WRITE_PATHS="$(printf '%s' "$READ_WRITE_PATHS_RAW" | tr ':' ' ')"

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
echo "[deploy] paths:     user_home=$USER_HOME  data_dir=$DATA_DIR (separate)"
echo "[deploy] hardening: ProtectHome=$PROTECT_HOME  ReadWritePaths=$READ_WRITE_PATHS"

# ── 0b. host preflight: bun + cargo must be provisioned before we ship ──────
# The remote build step (§2 below) ALSO checks bun/cargo as a belt-and-braces
# guard, but doing the check up here saves the cost of shipping a git archive
# (a few MB over a high-latency link) to a host that we already know cannot
# build it. Both errors are explicit pointers, not auto-installers.
echo "[deploy] preflight: checking host toolchain on $HOST"
if ! ssh "$HOST" 'bash -lc "[ -d \$HOME/.bun/bin ] && export PATH=\$HOME/.bun/bin:\$PATH; [ -f \$HOME/.cargo/env ] && . \$HOME/.cargo/env; command -v bun >/dev/null && command -v cargo >/dev/null"'; then
  echo "[deploy] error: $HOST is missing bun and/or cargo." >&2
  echo "[deploy]        Provision them once on the host (out of band — this script never" >&2
  echo "[deploy]        runs curl|bash toolchain installers as root). See README §Deploy." >&2
  exit 1
fi

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
# __SERVICE_USER__ / __USER_HOME__ / __DATA_DIR__ / __PROTECT_HOME__ /
# __READ_WRITE_PATHS__ placeholders; fill them in here and, when Tailscale is
# enabled, uncomment the optional After/Wants=tailscaled lines.
echo "[deploy] rendering systemd unit (user=$SERVICE_USER home=$USER_HOME data_dir=$DATA_DIR)"
UNIT_TMP="$(mktemp)"
trap 'rm -f "$UNIT_TMP"' EXIT
sed -e "s|__SERVICE_USER__|$SERVICE_USER|g" \
    -e "s|__USER_HOME__|$USER_HOME|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    -e "s|__PROTECT_HOME__|$PROTECT_HOME|g" \
    -e "s|__READ_WRITE_PATHS__|$READ_WRITE_PATHS|g" \
    etc/systemd/supermux.service > "$UNIT_TMP"
if [ "$USE_TAILSCALE" = "1" ]; then
  sed -i.bak \
    -e 's|^# After=tailscaled.service|After=tailscaled.service|' \
    -e 's|^# Wants=tailscaled.service|Wants=tailscaled.service|' \
    "$UNIT_TMP" && rm -f "$UNIT_TMP.bak"
fi

# Fail loudly if any placeholder leaked through — catches a typo in the
# template or a future placeholder added without a deploy.sh substitution.
if grep -q '__[A-Z_]\+__' "$UNIT_TMP"; then
  echo "[deploy] error: rendered unit still contains unsubstituted placeholders:" >&2
  grep -nE '__[A-Z_]+__' "$UNIT_TMP" >&2
  exit 1
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
