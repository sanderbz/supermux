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
# SUPPLY CHAIN: this script does not silently fetch-and-execute toolchain
# installers. `bun` and `cargo` must be present on the host. If they are not,
# the script refuses to proceed UNLESS the operator explicitly opts in by
# setting `SUPERMUX_INSTALL_TOOLCHAINS=1` — in which case it installs them at
# pinned versions (rustup stable + the local bun version) using their official
# installers. This keeps the "noob can clone-and-deploy" path easy without
# making toolchain bootstrap a silent side-effect of every deploy.
#
# CONFIGURATION: all settings come from environment variables. Copy
# `.env.example` to `.env` and fill in your values — this script sources
# `.env` automatically if present.
#
# Env:  SUPERMUX_DEPLOY_HOST         ssh target              (REQUIRED, no default)
#       SUPERMUX_SERVICE_USER        service account on host (default: supermux)
#       SUPERMUX_ALLOW_ROOT          opt in to User=root + relaxed hardening (default: 0)
#       SUPERMUX_DATA_DIR            data dir on host        (default: derived from user)
#       SUPERMUX_READ_WRITE_PATHS    extra writable dirs     (default: smart, see below)
#       SUPERMUX_INTERNAL_PORT       loopback bind port      (default: 8824)
#       SUPERMUX_PUBLIC_PORT         tailscale https port    (default: 8823)
#       SUPERMUX_USE_TAILSCALE       expose via tailscale    (default: auto-detected)
#       SUPERMUX_INSTALL_TOOLCHAINS  install bun+rust if missing (default: 0)
#       SUPERMUX_REMOTE_DIR          build dir on host       (default: /opt/supermux)
#       SUPERMUX_DEPLOY_REF          git ref to deploy       (default: HEAD)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── source local config from .env if present (gitignored; see .env.example) ─
[ -f .env ] && set -a && . ./.env && set +a

HOST="${SUPERMUX_DEPLOY_HOST:-}"
if [ -z "$HOST" ]; then
  echo "[deploy] error: SUPERMUX_DEPLOY_HOST is not set." >&2
  echo "[deploy]   Fix: copy .env.example to .env, set SUPERMUX_DEPLOY_HOST=<user@host>," >&2
  echo "[deploy]        then re-run scripts/deploy.sh. Everything else has sensible defaults." >&2
  exit 1
fi

SERVICE_USER="${SUPERMUX_SERVICE_USER:-supermux}"
SERVICE_USER_IS_DEFAULT=0
if [ -z "${SUPERMUX_SERVICE_USER:-}" ]; then
  SERVICE_USER_IS_DEFAULT=1
fi
ALLOW_ROOT="${SUPERMUX_ALLOW_ROOT:-0}"
PUBLIC_PORT="${SUPERMUX_PUBLIC_PORT:-8823}"
INTERNAL_PORT="${SUPERMUX_INTERNAL_PORT:-8824}"
INSTALL_TOOLCHAINS="${SUPERMUX_INSTALL_TOOLCHAINS:-0}"
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
  echo "[deploy]   Fix: pick an unprivileged user (recommended — just unset SUPERMUX_SERVICE_USER" >&2
  echo "[deploy]        to use the default 'supermux', which deploy.sh will auto-create)," >&2
  echo "[deploy]        OR set SUPERMUX_ALLOW_ROOT=1 to explicitly accept the security trade-off." >&2
  exit 1
fi

# DATA_DIR default depends on whether the service user is root.
if [ "$SERVICE_USER" = "root" ]; then
  DATA_DIR="${SUPERMUX_DATA_DIR:-/root/.supermux}"
else
  DATA_DIR="${SUPERMUX_DATA_DIR:-/home/$SERVICE_USER/.supermux}"
fi

# ── helpers ─────────────────────────────────────────────────────────────────
# Run a quiet remote check. Returns 0/1 — never prints output.
remote_check() {
  ssh "$HOST" "$@" >/dev/null 2>&1
}

# ── 0a. host preflight: SSH reachable? ──────────────────────────────────────
echo "[deploy] preflight: checking SSH reachability of $HOST"
if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null; then
  echo "[deploy] error: cannot SSH to '$HOST'." >&2
  echo "[deploy]   Fix: confirm \`ssh $HOST\` works (key-based auth, no password prompt)." >&2
  echo "[deploy]        Check ~/.ssh/config, your agent, and that the host accepts your key." >&2
  exit 1
fi

# ── 0b. host preflight: service user — auto-create the default, fail clearly otherwise ──
USER_EXISTS=0
if remote_check "id '$SERVICE_USER'"; then
  USER_EXISTS=1
fi

WILL_AUTO_CREATE_USER=0
if [ "$USER_EXISTS" = "0" ]; then
  if [ "$SERVICE_USER" = "root" ]; then
    # root exists everywhere — if id failed something else is very wrong.
    echo "[deploy] error: 'id root' failed on $HOST — host is in a broken state." >&2
    exit 1
  elif [ "$SERVICE_USER_IS_DEFAULT" = "1" ]; then
    # Default user 'supermux' — auto-create as a convenience for first-time deploys.
    WILL_AUTO_CREATE_USER=1
  else
    echo "[deploy] error: user '$SERVICE_USER' does not exist on $HOST." >&2
    echo "[deploy]   Fix: create it first —" >&2
    echo "[deploy]        ssh $HOST sudo useradd -m -s /bin/bash $SERVICE_USER" >&2
    echo "[deploy]        OR unset SUPERMUX_SERVICE_USER to use the default 'supermux'" >&2
    echo "[deploy]        (which deploy.sh will auto-create for you)." >&2
    exit 1
  fi
fi

# ── 0c. host preflight: smart default for ReadWritePaths ────────────────────
# Compute a sensible default that lets tmux/git/claude write where users
# realistically need them to: the data dir (always), the service user's home
# (so multi-project work under ~ works out of the box), and /opt/projects if
# present (common multi-project layout). The operator can override the whole
# thing by setting SUPERMUX_READ_WRITE_PATHS explicitly.
#
# We compute USER_HOME_FOR_RWP locally here — independent of any USER_HOME
# placeholder the systemd-template renderer may use — solely to derive the
# default for SUPERMUX_READ_WRITE_PATHS before the renderer runs.
if [ "$SERVICE_USER" = "root" ]; then
  USER_HOME_FOR_RWP="/root"
else
  USER_HOME_FOR_RWP="/home/$SERVICE_USER"
fi

if [ -z "${SUPERMUX_READ_WRITE_PATHS:-}" ] && [ "$SERVICE_USER" != "root" ]; then
  # Build the smart default — colon-separated, matches user-facing convention.
  # Always: data dir + service-user home. Optional: /opt/projects if present.
  SMART_RWP_PARTS=("$DATA_DIR" "$USER_HOME_FOR_RWP")
  if remote_check "test -d /opt/projects"; then
    SMART_RWP_PARTS+=("/opt/projects")
  fi
  # Join with ':' (existing convention; renderer translates to spaces).
  SMART_RWP=""
  for p in "${SMART_RWP_PARTS[@]}"; do
    if [ -z "$SMART_RWP" ]; then SMART_RWP="$p"; else SMART_RWP="$SMART_RWP:$p"; fi
  done
  export SUPERMUX_READ_WRITE_PATHS="$SMART_RWP"
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

# ── 0d. host preflight: Tailscale auto-detect ───────────────────────────────
# If the operator didn't set SUPERMUX_USE_TAILSCALE, sniff the host: if
# tailscale is installed AND tailscaled is running, default to exposing the
# service. Otherwise default to skipping — they can front the loopback port
# with their own reverse proxy.
if [ -z "${SUPERMUX_USE_TAILSCALE:-}" ]; then
  if remote_check 'command -v tailscale && systemctl is-active --quiet tailscaled'; then
    USE_TAILSCALE=1
    TAILSCALE_DETECTION="auto-detected (tailscaled running)"
  else
    USE_TAILSCALE=0
    TAILSCALE_DETECTION="auto-detected (not present)"
  fi
else
  USE_TAILSCALE="$SUPERMUX_USE_TAILSCALE"
  TAILSCALE_DETECTION="explicit (SUPERMUX_USE_TAILSCALE=$USE_TAILSCALE)"
fi

# ── 0e. pin the source: require a clean tree, resolve the exact commit ──────
# A non-reproducible deploy (shipping a dirty working tree) is refused here:
# the deployed artifact must always map back to a single committed SHA.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "[deploy] error: not a git repository — cannot pin a deploy ref." >&2
  echo "[deploy]   Fix: run deploy.sh from inside the supermux git checkout." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[deploy] error: working tree is dirty — refusing to deploy unpinned source." >&2
  echo "[deploy]   Fix: commit or stash your changes, then re-run." >&2
  echo "[deploy]        (Deploys always ship a pinned 'git archive', never the live tree.)" >&2
  exit 1
fi
GIT_SHA="$(git rev-parse "$DEPLOY_REF")"
GIT_SHA_SHORT="$(git rev-parse --short "$DEPLOY_REF")"

# ── 0f. preflight summary — show the operator what's about to happen ────────
case "$USE_TAILSCALE" in
  1) PUBLIC_EXPOSE_DESC="tailscale serve :$PUBLIC_PORT → loopback:$INTERNAL_PORT" ;;
  *) PUBLIC_EXPOSE_DESC="loopback only — front with reverse proxy → :$INTERNAL_PORT" ;;
esac
SERVICE_USER_NOTE="$SERVICE_USER"
if [ "$WILL_AUTO_CREATE_USER" = "1" ]; then
  SERVICE_USER_NOTE="$SERVICE_USER (will auto-create)"
fi
echo "[deploy] ─── plan ───────────────────────────────────────────────────"
echo "[deploy] target           : $HOST"
echo "[deploy] service user     : $SERVICE_USER_NOTE"
echo "[deploy] data dir         : $DATA_DIR"
echo "[deploy] internal port    : $INTERNAL_PORT"
echo "[deploy] public expose    : $PUBLIC_EXPOSE_DESC  [$TAILSCALE_DETECTION]"
echo "[deploy] commit           : $GIT_SHA ($GIT_SHA_SHORT)"
echo "[deploy] read-write paths : $READ_WRITE_PATHS"
echo "[deploy] hardening        : ProtectHome=$PROTECT_HOME"
echo "[deploy] ───────────────────────────────────────────────────────────"

# ── 0g. create the default service user if it's missing ─────────────────────
if [ "$WILL_AUTO_CREATE_USER" = "1" ]; then
  echo "[deploy] creating service user '$SERVICE_USER' on host $HOST"
  if ! ssh "$HOST" "sudo useradd -m -s /bin/bash '$SERVICE_USER'"; then
    echo "[deploy] error: failed to create user '$SERVICE_USER' on $HOST." >&2
    echo "[deploy]   Fix: ensure your SSH user has passwordless sudo, or create the user manually:" >&2
    echo "[deploy]        ssh $HOST sudo useradd -m -s /bin/bash $SERVICE_USER" >&2
    exit 1
  fi
  # Re-verify the home exists — useradd -m should have made it, but be explicit.
  if ! remote_check "test -d '$USER_HOME_FOR_RWP'"; then
    echo "[deploy] error: user '$SERVICE_USER' was created but home '$USER_HOME_FOR_RWP' is missing." >&2
    echo "[deploy]        This is unexpected — investigate manually on the host." >&2
    exit 1
  fi
fi

# ── 0h. host preflight: bun + cargo toolchain (check, then optionally install) ─
# The build runs as the service user. Check bun + cargo under THAT user's
# environment (login shell + standard rc files). If missing:
#   - SUPERMUX_INSTALL_TOOLCHAINS=1 → install them with pinned versions
#     (official installers, never silently as root).
#   - else → fail with a clear actionable message.
echo "[deploy] preflight: checking toolchain on $HOST (as user '$SERVICE_USER')"

# Local bun version to pin to — if 'bun' isn't on the operator's PATH locally,
# fall back to 'latest' (the bun installer accepts both).
LOCAL_BUN_VERSION=""
if command -v bun >/dev/null 2>&1; then
  LOCAL_BUN_VERSION="$(bun --version 2>/dev/null || true)"
fi

check_or_install_toolchain() {
  local tool="$1"
  # Probe under the service user's login shell so user-local installs are seen.
  if ssh "$HOST" "sudo -u '$SERVICE_USER' -H bash -lc '[ -d \"\$HOME/.bun/bin\" ] && export PATH=\"\$HOME/.bun/bin:\$PATH\"; [ -f \"\$HOME/.cargo/env\" ] && . \"\$HOME/.cargo/env\"; command -v $tool'" >/dev/null 2>&1; then
    return 0
  fi

  if [ "$INSTALL_TOOLCHAINS" != "1" ]; then
    echo "[deploy] error: '$tool' not found on $HOST as user '$SERVICE_USER'." >&2
    echo "[deploy]   Fix (recommended): re-run with SUPERMUX_INSTALL_TOOLCHAINS=1 to install" >&2
    echo "[deploy]                      pinned versions automatically:" >&2
    echo "[deploy]                          SUPERMUX_INSTALL_TOOLCHAINS=1 bash scripts/deploy.sh" >&2
    echo "[deploy]   Fix (manual): install on the host as user '$SERVICE_USER':" >&2
    case "$tool" in
      bun)
        if [ -n "$LOCAL_BUN_VERSION" ]; then
          echo "[deploy]     ssh $HOST sudo -u $SERVICE_USER -H bash -c \\" >&2
          echo "[deploy]       'curl -fsSL https://bun.sh/install | bash -s -- bun-v$LOCAL_BUN_VERSION'" >&2
        else
          echo "[deploy]     ssh $HOST sudo -u $SERVICE_USER -H bash -c \\" >&2
          echo "[deploy]       'curl -fsSL https://bun.sh/install | bash'" >&2
        fi
        ;;
      cargo)
        echo "[deploy]     ssh $HOST sudo -u $SERVICE_USER -H bash -c \\" >&2
        echo "[deploy]       'curl --proto=https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable'" >&2
        ;;
    esac
    exit 1
  fi

  # SUPERMUX_INSTALL_TOOLCHAINS=1 — install with pinned versions.
  echo "[deploy] installing '$tool' on $HOST as user '$SERVICE_USER' (SUPERMUX_INSTALL_TOOLCHAINS=1)"
  case "$tool" in
    bun)
      local bun_install_cmd
      if [ -n "$LOCAL_BUN_VERSION" ]; then
        bun_install_cmd="curl -fsSL https://bun.sh/install | bash -s -- bun-v$LOCAL_BUN_VERSION"
        echo "[deploy]   pinning bun to v$LOCAL_BUN_VERSION (matches local toolchain)"
      else
        bun_install_cmd="curl -fsSL https://bun.sh/install | bash"
        echo "[deploy]   local 'bun' not found — installing latest stable bun on host"
      fi
      if ! ssh "$HOST" "sudo -u '$SERVICE_USER' -H bash -lc \"$bun_install_cmd\""; then
        echo "[deploy] error: bun install failed on $HOST." >&2
        echo "[deploy]   Fix: install bun manually on the host as user '$SERVICE_USER', then retry." >&2
        exit 1
      fi
      ;;
    cargo)
      echo "[deploy]   installing rustup (stable toolchain, non-interactive, profile=default)"
      if ! ssh "$HOST" "sudo -u '$SERVICE_USER' -H bash -lc 'curl --proto=\"=https\" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile default'"; then
        echo "[deploy] error: rustup install failed on $HOST." >&2
        echo "[deploy]   Fix: install rust manually on the host as user '$SERVICE_USER', then retry." >&2
        exit 1
      fi
      ;;
  esac

  # Re-verify the install worked.
  if ! ssh "$HOST" "sudo -u '$SERVICE_USER' -H bash -lc '[ -d \"\$HOME/.bun/bin\" ] && export PATH=\"\$HOME/.bun/bin:\$PATH\"; [ -f \"\$HOME/.cargo/env\" ] && . \"\$HOME/.cargo/env\"; command -v $tool'" >/dev/null 2>&1; then
    echo "[deploy] error: installed '$tool' but it's still not on PATH for user '$SERVICE_USER'." >&2
    echo "[deploy]        This is unexpected — investigate manually on the host." >&2
    exit 1
  fi
}

check_or_install_toolchain bun
check_or_install_toolchain cargo

# ── 1. ship a pinned source snapshot to the host ────────────────────────────
# `git archive` emits exactly the tracked content at $GIT_SHA — no .git, no
# build artifacts, no uncommitted edits. The host build is thus reproducible
# from the recorded SHA.
echo "[deploy] shipping git archive of $GIT_SHA_SHORT -> $HOST:$REMOTE_DIR"
if ! ssh "$HOST" "sudo rm -rf '$REMOTE_DIR' && sudo mkdir -p '$REMOTE_DIR' && sudo chown '$SERVICE_USER:$SERVICE_USER' '$REMOTE_DIR'"; then
  echo "[deploy] error: failed to prepare $REMOTE_DIR on $HOST." >&2
  echo "[deploy]   Fix: ensure your SSH user has passwordless sudo on the host." >&2
  exit 1
fi
git archive --format=tar "$GIT_SHA" | ssh "$HOST" "sudo -u '$SERVICE_USER' tar -x -C '$REMOTE_DIR'"

# ── 2. build natively on the host (toolchains MUST be pre-provisioned) ───────
echo "[deploy] building on $HOST (as user '$SERVICE_USER')"
ssh "$HOST" "sudo -u '$SERVICE_USER' -H bash -s" <<REMOTE_BUILD
set -euo pipefail
# rustup/bun install into the user's home — make them discoverable on a
# non-login PATH. The preflight already verified these (or installed them).
[ -d "\$HOME/.bun/bin" ] && export PATH="\$HOME/.bun/bin:\$PATH"
[ -f "\$HOME/.cargo/env" ] && . "\$HOME/.cargo/env"
if ! command -v bun >/dev/null; then
  echo '[host] error: bun not found at build time — preflight should have caught this.' >&2
  echo '[host]        Re-run deploy with SUPERMUX_INSTALL_TOOLCHAINS=1.' >&2
  exit 1
fi
if ! command -v cargo >/dev/null; then
  echo '[host] error: cargo not found at build time — preflight should have caught this.' >&2
  echo '[host]        Re-run deploy with SUPERMUX_INSTALL_TOOLCHAINS=1.' >&2
  exit 1
fi
cd '$REMOTE_DIR'
bash scripts/build.sh
REMOTE_BUILD

# ── 3. render the systemd unit template from env ────────────────────────────
# The committed unit (etc/systemd/supermux.service) is a template with
# __SERVICE_USER__ / __DATA_DIR__ / __PROTECT_HOME__ / __READ_WRITE_PATHS__
# placeholders; fill them in here and, when Tailscale is enabled, uncomment
# the optional After/Wants=tailscaled lines.
echo "[deploy] rendering systemd unit (user=$SERVICE_USER data_dir=$DATA_DIR)"
UNIT_TMP="$(mktemp)"
trap 'rm -f "$UNIT_TMP"' EXIT
sed -e "s|__SERVICE_USER__|$SERVICE_USER|g" \
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
if ! systemctl is-active --quiet supermux; then
  echo '[host] error: supermux failed to start — see logs:' >&2
  echo '[host]   journalctl -u supermux -n 100 --no-pager' >&2
  systemctl status supermux --no-pager || true
  exit 1
fi
systemctl is-active supermux
REMOTE_INSTALL

# ── 5. expose the service (TLS) ─────────────────────────────────────────────
# The backend speaks plain HTTP on the internal loopback port. Terminate TLS
# either via `tailscale serve` (set SUPERMUX_USE_TAILSCALE=1 or let the
# preflight auto-detect a running tailscaled) or with your own reverse proxy.
if [ "$USE_TAILSCALE" = "1" ]; then
  echo "[deploy] exposing :$PUBLIC_PORT via tailscale serve → loopback:$INTERNAL_PORT"
  if ! ssh "$HOST" "sudo tailscale serve --bg --https=$PUBLIC_PORT http://localhost:$INTERNAL_PORT"; then
    echo "[deploy] error: 'tailscale serve' failed on $HOST." >&2
    echo "[deploy]   Fix: confirm 'tailscale status' is healthy on the host, then re-run." >&2
    echo "[deploy]        OR set SUPERMUX_USE_TAILSCALE=0 to skip Tailscale and front the" >&2
    echo "[deploy]        loopback port with your own reverse proxy." >&2
    exit 1
  fi
else
  echo "[deploy] skipping 'tailscale serve' — front loopback:$INTERNAL_PORT with your own reverse proxy"
  echo "[deploy]   example: nginx/Caddy → proxy https://<your-domain> → http://localhost:$INTERNAL_PORT"
fi

# ── 6. verify (health is public, no token needed) ───────────────────────────
echo "[deploy] verifying health on loopback:$INTERNAL_PORT"
if ! ssh "$HOST" "curl -sf -o /dev/null -w '/api/health -> %{http_code}\n' http://127.0.0.1:$INTERNAL_PORT/api/health"; then
  echo "[deploy] error: health check failed on $HOST loopback:$INTERNAL_PORT." >&2
  echo "[deploy]   Fix: inspect logs on the host —" >&2
  echo "[deploy]        ssh $HOST sudo journalctl -u supermux -n 100 --no-pager" >&2
  exit 1
fi

echo "[deploy] done — supermux (commit $GIT_SHA_SHORT) live on $HOST loopback:$INTERNAL_PORT"
