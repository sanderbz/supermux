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
# NON-ROOT BY DEFAULT — EVEN FROM A ROOT SSH SESSION:
# The account you DEPLOY WITH (the SSH login, often root on a fresh VPS) is NOT
# the account the service RUNS AS. Deploying over a root SSH session is fine and
# expected — root is needed to create the service user and install the systemd
# unit. But the SERVICE itself runs as the unprivileged `supermux` user, always,
# unless the operator EXPLICITLY forces SUPERMUX_ALLOW_ROOT=1 (a loud, documented
# last resort — see the warning block below). Running the service as root would
# (a) throw away the systemd hardening sandbox and (b) trip Claude Code's refusal
# to run `--dangerously-skip-permissions` as uid 0. Non-root is the strong path.
#
# Env:  SUPERMUX_DEPLOY_HOST         ssh target              (REQUIRED, no default)
#       SUPERMUX_SERVICE_USER        service account on host (default: supermux)
#       SUPERMUX_ALLOW_ROOT          LAST RESORT: User=root + relaxed hardening (default: 0)
#       SUPERMUX_USER_HOME           service user's login home (default: derived from user)
#       SUPERMUX_DATA_DIR            data dir on host        (default: derived from user)
#       SUPERMUX_PROJECT_DIRS        where agents work       (default: <home>/projects)
#       SUPERMUX_READ_WRITE_PATHS    extra writable dirs     (default: smart, see below)
#       SUPERMUX_COPY_CLAUDE_CREDS   copy deployer's Claude login to service user (default: ask)
#       SUPERMUX_INTERNAL_PORT       loopback bind port      (default: 8824)
#       SUPERMUX_PUBLIC_PORT         tailscale https port    (default: 443)
#       SUPERMUX_USE_TAILSCALE       expose via tailscale    (default: auto-detected)
#       SUPERMUX_INSTALL_TOOLCHAINS  install bun+rust if missing (default: 0)
#       SUPERMUX_REMOTE_DIR          build dir on host       (default: /opt/supermux)
#       SUPERMUX_DEPLOY_REF          git ref to deploy       (default: HEAD)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── source local config from .env if present (gitignored; see .env.example) ─
[ -f .env ] && set -a && . ./.env && set +a

# ── operator opt-out: --no-cache forces a full rebuild on the host ──────────
# Pre-existing behaviour was "rm -rf $REMOTE_DIR every deploy → cold rebuild".
# We now preserve server/target and web/node_modules between deploys (huge win
# on small code changes), and gate bun/vite/static-touch on content hashes
# (see scripts/build.sh). --no-cache restores the old cold-build path for
# disaster-recovery situations where the cache is suspected of being poisoned.
SUPERMUX_NO_CACHE=0
_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-cache) SUPERMUX_NO_CACHE=1 ;;
    *) _ARGS+=("$arg") ;;
  esac
done
# Replace positional params with the filtered set so downstream code (none today)
# never sees --no-cache as a stray arg.
if [ ${#_ARGS[@]} -gt 0 ]; then set -- "${_ARGS[@]}"; else set --; fi
export SUPERMUX_NO_CACHE

# ── helpers (defined early so the test hook below can short-circuit before any
#    config requirement runs, and so they're available to every section) ──────
# Run a quiet remote check. Returns 0/1 — never prints output. Uses $HOST,
# which is resolved below — only evaluated at call time, so defining this here
# is safe.
remote_check() {
  ssh "$HOST" "$@" >/dev/null 2>&1
}

# ── pure helper: split a colon-separated path list into newline-separated ────
# Pure (no I/O, no ssh) so it is trivially unit-testable. Empty / whitespace-
# only entries are dropped so a stray leading/trailing/double ':' is harmless.
split_path_list() {
  local raw="$1"
  # The `|| [ -n "$p" ]` guard is REQUIRED: tr leaves no trailing newline, so a
  # plain `while read` silently drops the LAST element (e.g. /a:/b:/c → /a,/b).
  # That would lose the final project dir on every multi-dir deploy.
  printf '%s' "$raw" | tr ':' '\n' | while IFS= read -r p || [ -n "$p" ]; do
    # trim surrounding whitespace
    p="${p#"${p%%[![:space:]]*}"}"
    p="${p%"${p##*[![:space:]]}"}"
    [ -n "$p" ] && printf '%s\n' "$p"
  done
}

# ── pure helper: is PATH under HOME (so the user already owns it)? ───────────
# Returns 0 if `path` is HOME itself or a descendant of it. Used to decide
# whether a project dir needs a chown/group fixup (outside home) or "just
# works" (inside home, already owned by the service user). Pure → testable.
path_under_home() {
  local path="$1" home="$2"
  # normalize: strip any trailing slash (except root "/")
  [ "$path" != "/" ] && path="${path%/}"
  [ "$home" != "/" ] && home="${home%/}"
  # Special-case home="/" (the root filesystem): everything absolute is under it.
  # Without this the prefix built below would be "//" / "//*" (a double slash),
  # which matches neither the home-itself nor the descendant pattern, so a real
  # descendant of root would be mis-classified as OUTSIDE home.
  if [ "$home" = "/" ]; then
    case "$path" in
      /*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  case "$path/" in
    "$home"/) return 0 ;;     # the home dir itself
    "$home"/*) return 0 ;;    # a descendant of home
    *) return 1 ;;
  esac
}

# ── pure helper: reject a project dir that points at a system path ──────────
# Guards the `chown -R` below: a typo / copy-paste pointing SUPERMUX_PROJECT_DIRS
# at "/" or a depth-1 system dir would recursively re-own the host (sshd keys,
# /etc, sudo, every other service) — a single misconfigured env var bricking the
# box. Reject "/" and a curated blocklist of system roots outright. Returns 0 if
# the path is SAFE to chown -R, 1 (with a reason on stderr) if it must be refused.
# Pure (lexical only) → unit-testable; no I/O.
project_dir_is_safe() {
  local dir="$1"
  # normalize trailing slash (except root)
  [ "$dir" != "/" ] && dir="${dir%/}"
  case "$dir" in
    ""|/) return 1 ;;  # empty or the filesystem root
  esac
  # Depth-1 system directories — refusing the bare dir (a child of it, e.g.
  # /opt/projects or /srv/work, is fine and the common case).
  case "$dir" in
    /etc|/usr|/bin|/sbin|/lib|/lib64|/var|/boot|/dev|/proc|/sys|/run|/root|/home|/opt|/srv|/mnt|/media)
      return 1 ;;
  esac
  return 0
}

# ── remote helper: ensure a single project dir is usable by the service user ─
# - If it is under the service user's HOME → the user already owns it; just
#   create it (mkdir -p as the user) — zero privilege fuss.
# - If it is OUTSIDE HOME (e.g. /opt/projects, /srv/...) → create it as root,
#   then chown -R it to the service user so the agent can read+write freely.
#   (chown is the cleaner of {chown, shared-group}: a single owner, no acl/
#   setgid subtlety, and it survives `git checkout` / file recreation.)
# Echoes one log line describing what it did. Returns non-zero on failure.
ensure_project_dir_remote() {
  local dir="$1" user="$2" home="$3" host="$4"
  if path_under_home "$dir" "$home"; then
    if ! ssh "$host" "sudo -u '$user' mkdir -p '$dir'"; then
      echo "[deploy] error: failed to create project dir '$dir' as user '$user' on $host." >&2
      return 1
    fi
    echo "[deploy]   project dir '$dir' — under \$HOME, owned by '$user' (no chown needed)"
  else
    # OUTSIDE home → we are about to `chown -R` this whole tree to the service
    # user. Refuse system roots so a misconfigured SUPERMUX_PROJECT_DIRS can't
    # recursively re-own the host.
    if ! project_dir_is_safe "$dir"; then
      echo "[deploy] error: refusing to chown -R the system path '$dir' to '$user'." >&2
      echo "[deploy]   This looks like '/' or a top-level system directory. Recursively" >&2
      echo "[deploy]   re-owning it would break the host (sshd keys, /etc, sudo, services)." >&2
      echo "[deploy]   Fix: point SUPERMUX_PROJECT_DIRS at a dedicated subdirectory, e.g." >&2
      echo "[deploy]        /opt/projects or /srv/work — not the bare system root." >&2
      return 1
    fi
    if ! ssh "$host" "sudo mkdir -p '$dir' && sudo chown -R '$user:$user' '$dir'"; then
      echo "[deploy] error: failed to create + chown external project dir '$dir' to '$user' on $host." >&2
      echo "[deploy]   Fix: ensure your SSH user has passwordless sudo, or pre-create + chown the dir." >&2
      return 1
    fi
    echo "[deploy]   project dir '$dir' — OUTSIDE \$HOME, chowned -R to '$user' (writable by the agent)"
  fi
  return 0
}

# ── remote helper: does the service user have usable Claude credentials? ─────
# The single biggest "it doesn't work" cause is a service user that never ran
# `claude /login`. We probe for ~user/.claude/.credentials.json (the OAuth /
# subscription credential file — NOT an API key; supermux uses the subscription,
# never API billing). Returns 0 if present, 1 if missing.
service_user_has_claude_creds() {
  local home="$1" host="$2"
  remote_check "sudo test -f '$home/.claude/.credentials.json'"
}

# ── remote helper: is the Claude Code BINARY on the service user's PATH? ──────
# Distinct from the CREDENTIALS check above: a host can be logged in conceptually
# (or not) but never have `claude` installed at all. supermux runs the bare
# `claude` command in each session's tmux pane AS the service user (its login
# shell resolves PATH), so we must probe under that exact context — a login
# shell (`bash -lc`) with ~/.local/bin prepended (where the native installer
# lands the binary, in case the user's rc files don't add it yet). Returns 0 if
# found, 1 if missing.
service_user_has_claude_bin() {
  local user="$1" host="$2"
  ssh "$host" "sudo -u '$user' -H bash -lc 'export PATH=\"\$HOME/.local/bin:\$PATH\"; command -v claude'" >/dev/null 2>&1
}

# ── pure helper: the copy-pasteable Claude Code install hint ──────────────────
# Echoed in the warning when the binary is missing and we're not installing for
# the operator. The native installer is the recommendation (no Node dependency,
# matches supermux's "no Node at runtime" stance); npm is the fallback for hosts
# that prefer it. Pure (no I/O) → unit-testable.
claude_install_hint() {
  local user="$1"
  printf 'ssh %s sudo -u %s -H bash -lc '\''curl -fsSL https://claude.ai/install.sh | bash'\''' "$HOST" "$user"
}

# ── remote helper: install Claude Code for the service user (consent required) ─
# Runs the OFFICIAL native installer AS the service user (never as root, never
# silently — the caller gates on INSTALL_CLAUDE / interactive consent). The
# installer drops the binary in ~user/.local/bin and self-updates thereafter.
# Returns the installer's exit status so the caller can re-probe + report.
install_claude_for_service_user() {
  local user="$1" host="$2"
  echo "[deploy] installing Claude Code for '$user' via the official native installer…"
  ssh "$host" "sudo -u '$user' -H bash -lc 'curl -fsSL https://claude.ai/install.sh | bash'"
}

# ── remote helper: copy the DEPLOYER's Claude login to the service user ──────
# Fast path (opt-in only): if the account we're SSHing in as (often root) has a
# valid ~/.claude/.credentials.json, copy the whole .claude dir + .claude.json
# into the service user's home and chown them. This reuses the deployer's
# existing subscription login — no API key, no second /login. Returns non-zero
# on failure. Caller decides whether to invoke this (consent required).
copy_deployer_claude_creds() {
  local deployer_home="$1" target_home="$2" user="$3" host="$4"
  # Copy .claude (dir) and .claude.json (file) if they exist, then chown.
  ssh "$host" "sudo bash -s" <<COPY_CREDS
set -euo pipefail
src_home='$deployer_home'
dst_home='$target_home'
user='$user'
copied=0
if [ -d "\$src_home/.claude" ]; then
  rm -rf "\$dst_home/.claude"
  cp -a "\$src_home/.claude" "\$dst_home/.claude"
  chown -R "\$user:\$user" "\$dst_home/.claude"
  # Harden the destination regardless of the source mode: a credential file
  # must never be group/other-readable, even if the deployer's source tree was
  # accidentally loose (sloppy umask, restored backup, …). Assert tight perms.
  chmod 700 "\$dst_home/.claude"
  [ -f "\$dst_home/.claude/.credentials.json" ] && chmod 600 "\$dst_home/.claude/.credentials.json"
  copied=1
fi
if [ -f "\$src_home/.claude.json" ]; then
  cp -a "\$src_home/.claude.json" "\$dst_home/.claude.json"
  chown "\$user:\$user" "\$dst_home/.claude.json"
  chmod 600 "\$dst_home/.claude.json"
  copied=1
fi
if [ "\$copied" = "1" ]; then
  echo "[host] copied Claude login from \$src_home to \$dst_home (chowned to \$user)"
else
  echo "[host] error: deployer home \$src_home has no .claude to copy" >&2
  exit 1
fi
COPY_CREDS
}

# ── remote helper: resolve the DEPLOYER's home + whether it has Claude creds ─
# Used for the opt-in copy. Echoes the deployer's home dir on stdout (empty if
# it can't be resolved). Returns 0 if that home has a valid .credentials.json.
deployer_claude_creds_home() {
  local host="$1"
  local dh
  dh="$(ssh "$host" 'echo "$HOME"' 2>/dev/null || true)"
  [ -z "$dh" ] && return 1
  printf '%s' "$dh"
  remote_check "sudo test -f '$dh/.claude/.credentials.json'"
}

# ── TEST HOOK ────────────────────────────────────────────────────────────────
# When sourced with SUPERMUX_DEPLOY_LIB_ONLY=1 (used by the bash unit tests in
# tests/), stop here: all the pure + remote helpers above are defined, but none
# of the deploy SIDE EFFECTS below (nor the config-requirement checks) run. This
# lets us unit-test the user-provisioning / project-dir-perms / claude-auth
# logic locally without an SSH target. Nothing else in the script consults this.
if [ "${SUPERMUX_DEPLOY_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

# ── Win 2: SSH ControlMaster — multiplex every ssh/scp through one TCP+auth
#    handshake, dropping ~5–8 s of re-handshake latency across the deploy. We
#    override `ssh` and `scp` as bash functions so EVERY existing call site
#    (including helpers like remote_check) inherits the multiplex transparently
#    — no per-call-site edit. ControlPersist=60s keeps the master alive long
#    enough to span build-time (~3–13 min); we explicitly tear it down on EXIT
#    via the trap below so a wedged master can't outlive the script.
#
#    NOTE on placement: this MUST happen AFTER the SUPERMUX_DEPLOY_LIB_ONLY
#    short-circuit above. The bash unit tests in tests/test_deploy_nonroot.sh
#    define their OWN ssh()/scp() stubs and then source deploy.sh with
#    LIB_ONLY=1 to load just the pure helpers. If we redefined ssh()/scp()
#    BEFORE the short-circuit, we'd clobber the test stubs and the tests would
#    try real SSH against the (non-existent) test host. Returning early in
#    LIB_ONLY mode keeps the stubs intact for the test path while still
#    multiplexing every ssh/scp on the real deploy path. ─────────────────────
SSH_CTRL_PATH="${SUPERMUX_SSH_CTRL_PATH:-/tmp/.supermux-ssh-$$-%r@%h:%p}"
ssh() {
  command ssh -o ControlMaster=auto \
              -o "ControlPath=$SSH_CTRL_PATH" \
              -o ControlPersist=60s \
              "$@"
}
scp() {
  command scp -o ControlMaster=auto \
              -o "ControlPath=$SSH_CTRL_PATH" \
              -o ControlPersist=60s \
              "$@"
}
# Tear down any persisted master on exit. We don't know which hosts we used,
# so glob the control-path template's literal-prefix (everything up to the
# first %) and `ssh -O exit` each one. Best-effort; silent on failure.
_supermux_ssh_cleanup() {
  local prefix="${SSH_CTRL_PATH%%%*}"
  shopt -s nullglob
  local m
  for m in "${prefix}"*; do
    # The control socket name encodes %r@%h:%p — translate back to a host arg.
    # ssh -O exit -o ControlPath=<file> doesn't need a real hostname when the
    # path uniquely identifies the master. Best-effort; silent on failure.
    command ssh -o "ControlPath=$m" -O exit dummyhost 2>/dev/null || true
    rm -f "$m" 2>/dev/null || true
  done
  shopt -u nullglob
}
trap '_supermux_ssh_cleanup' EXIT

HOST="${SUPERMUX_DEPLOY_HOST:-}"
if [ -z "$HOST" ]; then
  echo "[deploy] error: SUPERMUX_DEPLOY_HOST is not set." >&2
  echo "[deploy]   Fix: copy .env.example to .env, set SUPERMUX_DEPLOY_HOST=<user@host>," >&2
  echo "[deploy]        then re-run scripts/deploy.sh. Everything else has sensible defaults." >&2
  exit 1
fi

SERVICE_USER="${SUPERMUX_SERVICE_USER:-supermux}"
# "Is this the default user?" must key on the VALUE, not env-var presence: the
# setup wizard ALWAYS writes SUPERMUX_SERVICE_USER=supermux into .env (even when
# the operator just accepted the default), so an unset-only check would make a
# wizard-generated .env look like a deliberate non-default choice and disable
# auto-create on a fresh host — breaking the advertised one-command deploy.
# Treat the literal default 'supermux' as default-and-auto-createable however it
# was set (env, .env, or unset); any OTHER explicit user is still refused so we
# never silently provision an unexpected account.
SERVICE_USER_IS_DEFAULT=0
if [ "$SERVICE_USER" = "supermux" ]; then
  SERVICE_USER_IS_DEFAULT=1
fi
ALLOW_ROOT="${SUPERMUX_ALLOW_ROOT:-0}"
# Claude-credential copy: "ask" (default — prompt y/n interactively), "1" (copy
# without prompting, for non-interactive deploys that want the fast path), or
# "0" (never copy — just print the manual /login instructions).
COPY_CLAUDE_CREDS="${SUPERMUX_COPY_CLAUDE_CREDS:-ask}"
# Whether to install the Claude Code CLI for the service user when it's missing.
# supermux launches every (non-shell) agent by running the bare `claude` binary
# on the service user's PATH (lifecycle.rs), so a host without it can deploy +
# pass /api/health yet fail every agent. Tri-state, mirroring COPY_CLAUDE_CREDS:
#   ask (default) — offer to install interactively; warn+hint when no TTY
#   1             — install automatically (hands-off / non-interactive deploys)
#   0             — never install; just warn with the install command
# Install uses the official native installer (no Node dependency, lands in
# ~user/.local/bin) run AS the service user — never silently as root.
INSTALL_CLAUDE="${SUPERMUX_INSTALL_CLAUDE:-ask}"
PUBLIC_PORT="${SUPERMUX_PUBLIC_PORT:-443}"
INTERNAL_PORT="${SUPERMUX_INTERNAL_PORT:-8824}"
INSTALL_TOOLCHAINS="${SUPERMUX_INSTALL_TOOLCHAINS:-0}"
REMOTE_DIR="${SUPERMUX_REMOTE_DIR:-/opt/supermux}"
DEPLOY_REF="${SUPERMUX_DEPLOY_REF:-HEAD}"

# ── non-root by default: refuse User=root unless explicitly forced ──────────
# Deploying OVER a root SSH session is fine — root provisions (creates the
# service user, installs the unit). But the service must RUN AS the
# unprivileged user. The systemd unit's hardening directives are written for an
# unprivileged user — `ProtectHome=true` masks /root, so a root-owned data dir
# under /root/.supermux is unreachable and the unit refuses to start (this is
# a real bug we've hit in production, requiring a hand-edit of the installed
# unit to recover).
# Worse, running the agent stack as root trips Claude Code's hard refusal to use
# `--dangerously-skip-permissions` as uid 0 — so an "all root" deploy is broken
# on two fronts. Demand an explicit, loud opt-in to run as root.
if [ "$SERVICE_USER" = "root" ] && [ "$ALLOW_ROOT" != "1" ]; then
  echo "[deploy] error: SUPERMUX_SERVICE_USER=root is refused (non-root is the default)." >&2
  echo "[deploy]        Running the service as root throws away the systemd hardening" >&2
  echo "[deploy]        sandbox AND breaks Claude Code (it refuses --dangerously-skip-" >&2
  echo "[deploy]        permissions as uid 0). ProtectHome=true also masks /root so the" >&2
  echo "[deploy]        unit can't even chdir to its data dir." >&2
  echo "[deploy]   Fix (recommended): just unset SUPERMUX_SERVICE_USER to use the default" >&2
  echo "[deploy]        'supermux' — deploy.sh auto-creates it. Root still runs the deploy;" >&2
  echo "[deploy]        only the service drops to the unprivileged user." >&2
  echo "[deploy]   Fix (last resort): set SUPERMUX_ALLOW_ROOT=1 to explicitly accept the" >&2
  echo "[deploy]        security + Claude trade-offs (you will see a loud warning)." >&2
  exit 1
fi

# If the operator DID force ALLOW_ROOT=1 (with or without User=root), make the
# downside impossible to miss — this is a last-resort escape hatch, not a knob.
if [ "$ALLOW_ROOT" = "1" ] && [ "$SERVICE_USER" = "root" ]; then
  echo "[deploy] ╔══════════════════════════════════════════════════════════════════╗" >&2
  echo "[deploy] ║  WARNING: SUPERMUX_ALLOW_ROOT=1 — running the SERVICE as root.    ║" >&2
  echo "[deploy] ║                                                                  ║" >&2
  echo "[deploy] ║  This is a LAST RESORT. You are giving up:                        ║" >&2
  echo "[deploy] ║   • the systemd hardening sandbox (ProtectHome relaxed to false,  ║" >&2
  echo "[deploy] ║     ReadWritePaths broadened to /root) — an auth-token leak or    ║" >&2
  echo "[deploy] ║     path-jail escape becomes root-equivalent on the host;         ║" >&2
  echo "[deploy] ║   • a working Claude Code: it REFUSES --dangerously-skip-         ║" >&2
  echo "[deploy] ║     permissions as uid 0, so agents may not run at all.           ║" >&2
  echo "[deploy] ║                                                                  ║" >&2
  echo "[deploy] ║  Recommended instead: unset SUPERMUX_SERVICE_USER (default        ║" >&2
  echo "[deploy] ║  'supermux', auto-created). Root provisions; the service runs     ║" >&2
  echo "[deploy] ║  unprivileged. Continuing in 3s — Ctrl-C to abort.                ║" >&2
  echo "[deploy] ╚══════════════════════════════════════════════════════════════════╝" >&2
  sleep 3 || true
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

# ── derive PROJECT_DIRS — where agents actually do their work ───────────────
# This is the missing piece that makes agents able to read/write project files.
# The service user must own (or have group-write to) these dirs, AND they must
# be in the systemd ReadWritePaths set or the sandbox blocks every write.
#
# Smart default: <user-home>/projects (or /root/projects for root). Because the
# service user already owns its own home, the zero-config path needs no chown
# and no group juggling — it just works ("noob-proof"). Advanced users point
# elsewhere (e.g. /opt/projects:/srv/work) via SUPERMUX_PROJECT_DIRS and
# deploy.sh wires the perms + ReadWritePaths for them (see §0c-bis below).
#
# Colon-separated, matching the SUPERMUX_READ_WRITE_PATHS convention.
if [ "$SERVICE_USER" = "root" ]; then
  PROJECT_DIRS="${SUPERMUX_PROJECT_DIRS:-/root/projects}"
else
  PROJECT_DIRS="${SUPERMUX_PROJECT_DIRS:-$USER_HOME/projects}"
fi

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
# (so multi-project work under ~ works out of the box), the project dirs (where
# agents do their work), and /opt/projects if present (common multi-project
# layout). The operator can override the whole thing by setting
# SUPERMUX_READ_WRITE_PATHS explicitly.
#
# Uses the $USER_HOME derived above (which honors SUPERMUX_USER_HOME, getent,
# or /home/<user> fallback) so a non-standard layout flows through to the
# writable set without a second source of truth.
if [ -z "${SUPERMUX_READ_WRITE_PATHS:-}" ] && [ "$SERVICE_USER" != "root" ]; then
  # Build the smart default — colon-separated, matches user-facing convention.
  # Always: data dir + service-user home + the project dirs. Optional:
  # /opt/projects if present.
  SMART_RWP_PARTS=("$DATA_DIR" "$USER_HOME")
  # Fold in each project dir (split the colon-separated PROJECT_DIRS).
  while IFS= read -r pd; do
    [ -n "$pd" ] && SMART_RWP_PARTS+=("$pd")
  done <<EOF_PD
$(split_path_list "$PROJECT_DIRS")
EOF_PD
  if remote_check "test -d /opt/projects"; then
    SMART_RWP_PARTS+=("/opt/projects")
  fi
  # Join with ':' (existing convention; renderer translates to spaces).
  SMART_RWP=""
  for p in "${SMART_RWP_PARTS[@]}"; do
    if [ -z "$SMART_RWP" ]; then SMART_RWP="$p"; else SMART_RWP="$SMART_RWP:$p"; fi
  done
  export SUPERMUX_READ_WRITE_PATHS="$SMART_RWP"
elif [ -n "${SUPERMUX_READ_WRITE_PATHS:-}" ]; then
  # Operator set ReadWritePaths explicitly (root or non-root). The project dirs
  # MUST still be writable or agents can't work, so append any project dir that
  # isn't already covered. (Idempotent: skip exact duplicates.) This also covers
  # the root path so a root deploy with an explicit RWP + an external project
  # dir doesn't end up with a provisioned-but-unwritable dir.
  while IFS= read -r pd; do
    [ -z "$pd" ] && continue
    case ":$SUPERMUX_READ_WRITE_PATHS:" in
      *":$pd:"*) : ;;  # already present
      *) SUPERMUX_READ_WRITE_PATHS="$SUPERMUX_READ_WRITE_PATHS:$pd" ;;
    esac
  done <<EOF_PD2
$(split_path_list "$PROJECT_DIRS")
EOF_PD2
  export SUPERMUX_READ_WRITE_PATHS
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
  # ProtectHome=false leaves /root reachable; no BindPaths needed.
  BIND_PATHS_DEFAULT=""
  # Root's writable set is /root, but a root deploy can still point
  # SUPERMUX_PROJECT_DIRS at a dir OUTSIDE /root (e.g. /opt/work). 0g-bis
  # provisions+chowns that dir for any user including root, but with
  # ProtectSystem=strict + ReadWritePaths=/root the agent could not write
  # there. Fold any project dir not already under /root into the root RWP
  # default so provisioned dirs are actually writable. (The non-root branches
  # below handle this for the unprivileged user; mirror it here.)
  READ_WRITE_PATHS_DEFAULT="/root"
  while IFS= read -r pd; do
    [ -z "$pd" ] && continue
    case ":$READ_WRITE_PATHS_DEFAULT:" in
      *":$pd:"*) : ;;  # already present
      *)
        # Skip dirs already covered by /root (i.e. /root itself or descendants).
        if path_under_home "$pd" "/root"; then
          : ;
        else
          READ_WRITE_PATHS_DEFAULT="$READ_WRITE_PATHS_DEFAULT:$pd"
        fi
        ;;
    esac
  done <<EOF_ROOT_PD
$(split_path_list "$PROJECT_DIRS")
EOF_ROOT_PD
else
  # ProtectHome=tmpfs (NOT true): the service's own home IS the WorkingDirectory
  # and must be writable (spawned claude/codex/tmux children write dotfiles to
  # $HOME, and the data dir lives under it). ProtectHome=true masks ALL of /home
  # — including the service user's own home — so systemd can't even chdir into
  # WorkingDirectory (exit 200/CHDIR), and ReadWritePaths can't un-mask it.
  # tmpfs replaces /home with an empty mount (hiding OTHER users' homes — the
  # real isolation win) and BindPaths re-mounts ONLY this service user's home
  # read-write. Caught live: ProtectHome=true broke the first non-root deploy.
  PROTECT_HOME_DEFAULT="tmpfs"
  BIND_PATHS_DEFAULT="$USER_HOME"
  READ_WRITE_PATHS_DEFAULT="$DATA_DIR"
fi
PROTECT_HOME="${SUPERMUX_PROTECT_HOME:-$PROTECT_HOME_DEFAULT}"
# BindPaths line for the unit: re-mount the service user's home past
# ProtectHome=tmpfs (non-root). Empty for root (ProtectHome=false leaves /root
# reachable). Rendered as a full directive line or blank.
if [ -n "${BIND_PATHS_DEFAULT:-}" ]; then
  BIND_PATHS_LINE="BindPaths=$BIND_PATHS_DEFAULT"
else
  BIND_PATHS_LINE=""
fi
# Accept either colon- or whitespace-separated input; emit whitespace
# per systemd ReadWritePaths= grammar.
READ_WRITE_PATHS_RAW="${SUPERMUX_READ_WRITE_PATHS:-$READ_WRITE_PATHS_DEFAULT}"
READ_WRITE_PATHS="$(printf '%s' "$READ_WRITE_PATHS_RAW" | tr ':' ' ')"

# W^X (MemoryDenyWriteExecute) — the one hardening directive that's off by
# default. supermux hosts CODING agents: with W^X=yes the kernel rejects V8 JIT
# + WebAssembly (mprotect(PROT_EXEC) → ENOMEM), so npm/React/Vite/Next/Jest and
# anything JIT/WASM-based fail for the service AND its children (NoNewPrivileges
# makes it inherited). So default to dev-friendly (no); flip to strict (yes) only
# when the operator explicitly sets SUPERMUX_HARDENED=1. NOTHING else changes
# between modes — every other sandbox directive stays on in both.
# MemoryHigh: soft cgroup-v2 memory throttle for the whole supermux tree
# (server + tmux + agents). Default `infinity` = no cap, so the rendered unit
# is identical to today's for every operator who hasn't opted in. Operators on
# small hosts can set e.g. `6G` (for 8 GiB) or `12G` (for 16 GiB) to make the
# kernel reclaim aggressively past the threshold — it's SOFT (no OOM-kill), so
# an over-tight value just slows things down, it doesn't break the service.
MEMORY_HIGH="${SUPERMUX_MEMORY_HIGH:-infinity}"

if [ "${SUPERMUX_HARDENED:-0}" = "1" ]; then
  MEMORY_DENY_WRITE_EXECUTE=yes
  # Hardened profile assumes NO long-lived agents across restarts, so a private
  # /tmp is acceptable. (See the unit comment on PrivateTmp.)
  PRIVATE_TMP=yes
else
  MEMORY_DENY_WRITE_EXECUTE=no
  # Default: PrivateTmp OFF. supermux's long-lived tmux server + Claude agents
  # write to /tmp (/tmp/claude-<uid>); a private /tmp is destroyed on every
  # restart, breaking the surviving agents (ENOENT) + blanking fresh panes.
  PRIVATE_TMP=no
fi

# VAPID 'sub' contact (RFC-8292) for Web Push — operator-set in .env. When
# present, render `Environment=SUPERMUX_PUSH_SUB=…` into the unit so the running
# service reads it (the server otherwise falls back to the placeholder + logs a
# WARN). When unset, the placeholder LINE is DELETED entirely below (mirroring
# __BIND_PATHS__) — an empty `Environment=` directive is a systemd parse error.
# This closes the gap between .env.example documenting the var and the unit
# actually honoring it.
if [ -n "${SUPERMUX_PUSH_SUB:-}" ]; then
  PUSH_SUB_LINE="Environment=SUPERMUX_PUSH_SUB=$SUPERMUX_PUSH_SUB"
else
  PUSH_SUB_LINE=""
fi

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

# ── 0e-bis. capture version metadata from the LOCAL git context ──────────────
# Why: deploy.sh ships a `git archive` (no `.git/` on the remote), so on the
# host `git describe --tags --always --dirty` in build.rs fails and the binary
# falls back to "dev" — surfacing as "dev build" in Settings → Updates instead
# of the real tag (the v0.3.0 bug). Capture the tag + SHA HERE while we still
# have the full `.git/` and pass them through to the remote cargo build as
# explicit env vars, so the version baked into the binary always matches the
# committed ref we shipped — regardless of whether the host has `.git/`.
# Values are dash-only (no spaces); single-quoting on the remote side is safe.
VERSION_TAG="$(git describe --tags --always --dirty 2>/dev/null || echo unknown)"
VERSION_SHA="$GIT_SHA"

# ── 0f. preflight summary — show the operator what's about to happen ────────
case "$USE_TAILSCALE" in
  1) PUBLIC_EXPOSE_DESC="tailscale serve :$PUBLIC_PORT → loopback:$INTERNAL_PORT" ;;
  *) PUBLIC_EXPOSE_DESC="loopback only — front with reverse proxy → :$INTERNAL_PORT" ;;
esac
SERVICE_USER_NOTE="$SERVICE_USER"
if [ "$WILL_AUTO_CREATE_USER" = "1" ]; then
  SERVICE_USER_NOTE="$SERVICE_USER (will auto-create: home + login shell + ownership)"
fi
# Who are we deploying AS (the SSH login)? This is the privileged provisioner —
# distinct from the unprivileged user the service RUNS AS.
DEPLOY_AS_USER="$(ssh "$HOST" 'whoami' 2>/dev/null || echo '?')"
RUN_AS_NOTE="$SERVICE_USER (unprivileged)"
if [ "$SERVICE_USER" = "root" ]; then
  RUN_AS_NOTE="root (ALLOW_ROOT=1 — hardening relaxed, see warning above)"
fi
echo "[deploy] ─── plan ───────────────────────────────────────────────────"
echo "[deploy] target           : $HOST"
echo "[deploy] deploy AS (ssh)   : $DEPLOY_AS_USER  ← provisions (creates user, installs unit)"
echo "[deploy] service RUNS AS   : $RUN_AS_NOTE  ← what the daemon executes under"
echo "[deploy] service user      : $SERVICE_USER_NOTE"
echo "[deploy] user home         : $USER_HOME"
echo "[deploy] data dir          : $DATA_DIR (separate from user home)"
echo "[deploy] project dirs      : $PROJECT_DIRS (where agents work)"
echo "[deploy] internal port     : $INTERNAL_PORT"
echo "[deploy] public expose     : $PUBLIC_EXPOSE_DESC  [$TAILSCALE_DETECTION]"
echo "[deploy] commit            : $GIT_SHA ($GIT_SHA_SHORT)"
echo "[deploy] read-write paths  : $READ_WRITE_PATHS"
echo "[deploy] hardening         : ProtectHome=$PROTECT_HOME"
if [ "$MEMORY_DENY_WRITE_EXECUTE" = "yes" ]; then
  echo "[deploy] agent builds      : DISABLED (strict W^X — npm/React/Vite/Jest will fail)"
else
  echo "[deploy] agent builds      : enabled (W^X off)"
fi
case "$INSTALL_CLAUDE" in
  1) echo "[deploy] claude code       : install if missing (SUPERMUX_INSTALL_CLAUDE=1), then verify login" ;;
  0) echo "[deploy] claude code       : check only (SUPERMUX_INSTALL_CLAUDE=0), then verify login" ;;
  *) echo "[deploy] claude code       : check + offer to install if missing, then verify login" ;;
esac
echo "[deploy] ───────────────────────────────────────────────────────────"

# ── 0g. create + fully provision the default service user if it's missing ────
# "Fully set up" = home dir (-m), login shell (-s /bin/bash), and verified
# ownership of both its home and (later) its data + project dirs. This is the
# unprivileged account the SERVICE runs as — root (the deploy login) only
# provisions it here.
if [ "$WILL_AUTO_CREATE_USER" = "1" ]; then
  echo "[deploy] provisioning unprivileged service user '$SERVICE_USER' on host $HOST"
  echo "[deploy]   (root is creating it; the service will RUN AS this user, not root)"
  if ! ssh "$HOST" "sudo useradd -m -s /bin/bash '$SERVICE_USER'"; then
    echo "[deploy] error: failed to create user '$SERVICE_USER' on $HOST." >&2
    echo "[deploy]   Fix: ensure your SSH user has passwordless sudo, or create the user manually:" >&2
    echo "[deploy]        ssh $HOST sudo useradd -m -s /bin/bash $SERVICE_USER" >&2
    exit 1
  fi
  # Re-verify the home exists — useradd -m should have made it, but be explicit.
  if ! remote_check "test -d '$USER_HOME'"; then
    echo "[deploy] error: user '$SERVICE_USER' was created but home '$USER_HOME' is missing." >&2
    echo "[deploy]        This is unexpected — investigate manually on the host." >&2
    exit 1
  fi
  # Belt-and-suspenders: ensure the home is actually owned by the user (some
  # hardened images create /home/<user> root-owned if useradd -m races skel).
  if ! ssh "$HOST" "sudo chown '$SERVICE_USER:$SERVICE_USER' '$USER_HOME'"; then
    echo "[deploy] warn: could not chown '$USER_HOME' to '$SERVICE_USER' — continuing, but" >&2
    echo "[deploy]       verify the home is user-owned if the service fails to start." >&2
  fi
  echo "[deploy] service user '$SERVICE_USER' ready (home=$USER_HOME, shell=/bin/bash)"
fi

# ── 0g-bis. provision the project dirs (where agents do their work) ──────────
# This is the missing piece that makes agents able to read+write project files.
# For each colon-separated entry in PROJECT_DIRS: create it, and ensure the
# service user owns it (under-home → already owned; outside-home → chown -R).
# The dirs were already folded into READ_WRITE_PATHS above, so the systemd
# sandbox will permit the writes.
echo "[deploy] provisioning project dirs for agent work: $PROJECT_DIRS"
while IFS= read -r pd; do
  [ -z "$pd" ] && continue
  ensure_project_dir_remote "$pd" "$SERVICE_USER" "$USER_HOME" "$HOST" || exit 1
done <<EOF_PROVISION_PD
$(split_path_list "$PROJECT_DIRS")
EOF_PROVISION_PD

# ── 0g-tris. host preflight: tmux (every session needs it) ───────────────────
# tmux is a HARD runtime requirement: server/src/sessions/tmux.rs::tmux_bin()
# returns "tmux not found on PATH (install tmux)" for every create-session call
# if it's missing. The server still starts + /api/health returns 200, so a deploy
# can SUCCEED while every actual session attempt fails. Fail loudly here before
# the build phase — same shape as the bun/cargo preflight — with a per-package-
# manager install hint so the operator's next step is one copy-paste away.
#
# Detected via $HOST's package-manager binary (apt-get / dnf / apk / pacman /
# zypper / brew). Unknown distro → generic "install tmux" hint. We probe with
# `command -v tmux` only — we do NOT auto-install (matches the bun/cargo
# discipline: never silently fetch+exec system packages as root).
remote_tmux_install_hint() {
  # Echoes a single-line install command for $HOST's package manager.
  local mgr
  mgr="$(ssh "$HOST" '
    if command -v apt-get >/dev/null 2>&1; then echo apt
    elif command -v dnf     >/dev/null 2>&1; then echo dnf
    elif command -v yum     >/dev/null 2>&1; then echo yum
    elif command -v apk     >/dev/null 2>&1; then echo apk
    elif command -v pacman  >/dev/null 2>&1; then echo pacman
    elif command -v zypper  >/dev/null 2>&1; then echo zypper
    elif command -v brew    >/dev/null 2>&1; then echo brew
    else                                          echo unknown
    fi
  ' 2>/dev/null || echo unknown)"
  case "$mgr" in
    apt)     printf 'sudo apt-get update && sudo apt-get install -y tmux' ;;
    dnf)     printf 'sudo dnf install -y tmux' ;;
    yum)     printf 'sudo yum install -y tmux' ;;
    apk)     printf 'sudo apk add tmux' ;;
    pacman)  printf 'sudo pacman -S --noconfirm tmux' ;;
    zypper)  printf 'sudo zypper install -y tmux' ;;
    brew)    printf 'brew install tmux' ;;
    *)       printf '# install tmux via your distro package manager (apt/dnf/apk/pacman/zypper/brew)' ;;
  esac
}
echo "[deploy] preflight: checking tmux on $HOST (required at runtime for every session)"
if ! remote_check 'command -v tmux'; then
  echo "[deploy] error: 'tmux' is NOT installed on $HOST." >&2
  echo "[deploy]   supermux multiplexes sessions through tmux; without it every" >&2
  echo "[deploy]   create-session call fails with 'tmux not found on PATH'." >&2
  echo "[deploy]   The service would still start + /api/health = 200, but no agent" >&2
  echo "[deploy]   can be created — so fail HERE rather than after the long build." >&2
  echo "[deploy]   Fix: install tmux on $HOST, then re-run:" >&2
  echo "[deploy]        ssh $HOST '$(remote_tmux_install_hint)'" >&2
  exit 1
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
        echo "[deploy]       'curl --proto \"=https\" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable'" >&2
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
      if ! ssh "$HOST" "sudo -u '$SERVICE_USER' -H bash -lc 'curl --proto \"=https\" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile default'"; then
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

# ── 0h-pre. system build prerequisites (only when INSTALL_TOOLCHAINS=1) ───────
# The bun installer needs 'unzip', and the Rust release build of server/ needs a
# C toolchain + headers (cc/gcc, make), pkg-config, libssl-dev (openssl-sys) and
# cmake (aws-lc-sys / ring). A fresh minimal Ubuntu/VPS image ships none of them,
# so a turnkey SUPERMUX_INSTALL_TOOLCHAINS=1 must provision the SYSTEM packages
# BEFORE installing bun (needs unzip) and rust (needs cc/openssl/cmake at build).
# These are system packages, so they go in as root via sudo (same passwordless-
# sudo model as the rest of deploy.sh), distinct from the unprivileged service
# user that bun/cargo install under. When INSTALL_TOOLCHAINS=0 we never touch the
# system: this whole step is skipped. Idempotent: re-installing present packages
# is a no-op. Detection mirrors remote_tmux_install_hint() above.
install_system_build_deps() {
  local mgr
  mgr="$(ssh "$HOST" '
    if command -v apt-get >/dev/null 2>&1; then echo apt
    elif command -v dnf     >/dev/null 2>&1; then echo dnf
    elif command -v apk     >/dev/null 2>&1; then echo apk
    elif command -v pacman  >/dev/null 2>&1; then echo pacman
    else                                          echo unknown
    fi
  ' 2>/dev/null || echo unknown)"

  local install_cmd
  case "$mgr" in
    apt)
      echo "[deploy] installing system build deps on $HOST (unzip, build-essential, pkg-config, libssl-dev, cmake)"
      install_cmd='sudo apt-get update && sudo apt-get install -y unzip build-essential pkg-config libssl-dev cmake' ;;
    dnf)
      echo "[deploy] installing system build deps on $HOST (unzip, gcc, gcc-c++, make, pkgconf-pkg-config, openssl-devel, cmake)"
      install_cmd='sudo dnf install -y unzip gcc gcc-c++ make pkgconf-pkg-config openssl-devel cmake' ;;
    apk)
      echo "[deploy] installing system build deps on $HOST (unzip, build-base, pkgconf, openssl-dev, cmake)"
      install_cmd='sudo apk add unzip build-base pkgconf openssl-dev cmake' ;;
    pacman)
      echo "[deploy] installing system build deps on $HOST (unzip, base-devel, pkgconf, openssl, cmake)"
      install_cmd='sudo pacman -S --needed --noconfirm unzip base-devel pkgconf openssl cmake' ;;
    *)
      echo "[deploy] unknown package manager on $HOST - cannot auto-install system build deps." >&2
      echo "[deploy]   Install these before/alongside the toolchains (logical set):" >&2
      echo "[deploy]     unzip (for the bun installer)" >&2
      echo "[deploy]     a C toolchain: cc/gcc, make (build-essential / base-devel / build-base)" >&2
      echo "[deploy]     pkg-config, libssl-dev (openssl headers), cmake (for the rust release build)" >&2
      echo "[deploy]   Continuing. If bun or cargo install fails below, install the above first." >&2
      return 0 ;;
  esac

  if ! ssh "$HOST" "$install_cmd"; then
    echo "[deploy] error: failed to install system build deps on $HOST ($mgr)." >&2
    echo "[deploy]   Fix: install them manually on the host, then re-run:" >&2
    echo "[deploy]        ssh $HOST '$install_cmd'" >&2
    exit 1
  fi
}

# System build-deps run first (when opted in) so bun has unzip and the rust
# release build has cc / openssl / cmake. No-op when INSTALL_TOOLCHAINS=0.
if [ "$INSTALL_TOOLCHAINS" = "1" ]; then
  install_system_build_deps
fi

check_or_install_toolchain bun
check_or_install_toolchain cargo

# ── 1a. install the cargo-guard wrapper (auto-on for small hosts) ──────────
# Refuses `cargo --release` from agent ad-hoc compile-checks (release builds
# peak ~2 GB/rustc and have OOM-thrashed our small deploy host); the legit
# deploy paths set SUPERMUX_RELEASE_OK=1 and pass through.
#
# Default: AUTO-ON when the host has ≤8 GiB RAM (the wedge regime), OFF on
# bigger hosts. Operator override is preserved: explicitly setting
# SUPERMUX_INSTALL_CARGO_GUARD=0 disables it even on a small host, and =1
# enables it on any host.
INSTALL_CARGO_GUARD="${SUPERMUX_INSTALL_CARGO_GUARD:-}"
if [ -z "$INSTALL_CARGO_GUARD" ]; then
  # No explicit operator choice — probe host RAM. 8 GiB = 8*1024*1024 KiB.
  HOST_RAM_KIB="$(ssh "$HOST" "awk '/^MemTotal:/ {print \$2; exit}' /proc/meminfo" 2>/dev/null || true)"
  if [ -n "$HOST_RAM_KIB" ] && [ "$HOST_RAM_KIB" -gt 0 ] 2>/dev/null && [ "$HOST_RAM_KIB" -le 8388608 ]; then
    HOST_RAM_GIB=$(( HOST_RAM_KIB / 1024 / 1024 ))
    echo "[deploy] host has ${HOST_RAM_GIB} GiB RAM ≤ 8 GiB — enabling cargo-guard wrapper. Set SUPERMUX_INSTALL_CARGO_GUARD=0 to disable."
    INSTALL_CARGO_GUARD=1
  else
    INSTALL_CARGO_GUARD=0
  fi
fi
if [ "$INSTALL_CARGO_GUARD" = "1" ]; then
  echo "[deploy] installing cargo-guard wrapper for service user '$SERVICE_USER'"
  scp "$ROOT/etc/clawd-bin/cargo" "$HOST:/tmp/supermux-cargo-guard"
  ssh "$HOST" "sudo -u '$SERVICE_USER' -H bash -lc '
    mkdir -p \"\$HOME/.local/bin\" &&
    install -m 0755 /tmp/supermux-cargo-guard \"\$HOME/.local/bin/cargo\"
  '"
  ssh "$HOST" "rm -f /tmp/supermux-cargo-guard"
  # Interactive shells (tmux panes) need ~/.local/bin AHEAD of ~/.cargo/bin
  # after sourcing ~/.cargo/env. Idempotent via comment marker.
  ssh "$HOST" "sudo -u '$SERVICE_USER' -H bash -lc '
    RC=\"\$HOME/.bashrc\"
    touch \"\$RC\"
    if ! grep -q \"# supermux-cargo-guard PATH\" \"\$RC\"; then
      printf \"\\n# supermux-cargo-guard PATH\\nexport PATH=\\\"\\\$HOME/.local/bin:\\\$PATH\\\"\\n\" >> \"\$RC\"
    fi
  '"
fi

# ── 1. ship a pinned source snapshot to the host (Win 1: preserve build caches) ─
# `git archive` emits exactly the tracked content at $GIT_SHA — no .git, no
# build artifacts, no uncommitted edits. The host build is thus reproducible
# from the recorded SHA.
#
# CACHE PRESERVATION (the change vs the old `rm -rf $REMOTE_DIR`):
#   Old behaviour wiped $REMOTE_DIR every deploy → cargo's ~1.9 GiB target/ +
#   bun's 280 MiB node_modules/ + web/dist/ got nuked → every deploy was a
#   from-scratch 3–11 min cargo + 30–90 s bun install. ~70 % of deploy time
#   was rebuilding bit-for-bit identical artefacts.
#
#   Now we extract `git archive` into a sibling STAGING dir and rsync it into
#   $REMOTE_DIR with --delete-excluded, EXCLUDING server/target,
#   web/node_modules, and web/dist. Cargo / bun / vite then incrementally
#   reuse the previous-deploy caches — `Cargo.lock` and `bun.lock` are
#   committed (and frozen), so the caches reflect the EXACT pinned deps.
#
#   The build.sh hash-gates (Wins 3+5) need these caches to survive in order
#   to skip; without Win 1 they have nothing to skip.
#
# SAFETY:
#   - rsync --delete prunes any tracked file removed at $GIT_SHA (so stale
#     committed source can't survive). The two --exclude rules keep ONLY the
#     build caches: rsync's --delete operates on the SOURCE side, so files
#     in the excluded paths on the DEST side are left alone.
#   - server/static is intentionally NOT excluded: build.sh regenerates it
#     deterministically from web/dist (which IS excluded so vite can
#     incrementally update it). Old static/ would be wiped+recreated by
#     build.sh's `rm -rf server/static && cp -r web/dist server/static`
#     path, gated by the static-hash skip.
#   - --no-cache (operator opt-out) restores the cold-rebuild path for
#     disaster recovery: rm -rf $REMOTE_DIR before the rsync, exactly the
#     old behaviour. This deliberately re-introduces the slow rebuild cost.
if [ "$SUPERMUX_NO_CACHE" = "1" ]; then
  echo "[deploy] --no-cache: wiping $REMOTE_DIR on $HOST (forces cold rebuild — old behaviour)"
  if ! ssh "$HOST" "sudo rm -rf '$REMOTE_DIR'"; then
    echo "[deploy] error: failed to clear $REMOTE_DIR on $HOST." >&2
    exit 1
  fi
fi

echo "[deploy] shipping git archive of $GIT_SHA_SHORT -> $HOST:$REMOTE_DIR (preserving target/ + node_modules/ + web/dist for incremental build)"
# Provision $REMOTE_DIR (idempotent — no-op on subsequent deploys). Ensures the
# dir exists, owned by the service user, before we rsync into it.
if ! ssh "$HOST" "sudo mkdir -p '$REMOTE_DIR' && sudo chown '$SERVICE_USER:$SERVICE_USER' '$REMOTE_DIR'"; then
  echo "[deploy] error: failed to prepare $REMOTE_DIR on $HOST." >&2
  echo "[deploy]   Fix: ensure your SSH user has passwordless sudo on the host." >&2
  exit 1
fi

# Stage the git-archive into a sibling temp dir under the same parent as
# $REMOTE_DIR. The temp dir MUST be on the same filesystem so rsync's hard-link
# tricks (if it uses them) work, and so the staging cost is the cheap tar
# extraction rather than a cross-fs copy.
REMOTE_PARENT="$(dirname "$REMOTE_DIR")"
REMOTE_STAGE="$REMOTE_PARENT/.supermux-deploy-stage.$GIT_SHA_SHORT.$$"
# `$REMOTE_PARENT` (e.g. /opt) is root-owned on most distros so $SERVICE_USER
# can't mkdir there directly; do it as root then hand ownership to the service
# user — same idempotent pattern as $REMOTE_DIR above.
if ! ssh "$HOST" "sudo mkdir -p '$REMOTE_STAGE' && sudo chown '$SERVICE_USER:$SERVICE_USER' '$REMOTE_STAGE'"; then
  echo "[deploy] error: failed to create staging dir $REMOTE_STAGE on $HOST." >&2
  exit 1
fi
# Extract the pinned source into staging.
git archive --format=tar "$GIT_SHA" | ssh "$HOST" "sudo -u '$SERVICE_USER' tar -x -C '$REMOTE_STAGE'"
# rsync staging → $REMOTE_DIR, deleting anything tracked-removed but preserving
# the build caches that live ONLY on the dest side.
#   -a       : archive (perms/mtimes/symlinks — needed for cargo's mtime cache)
#   --delete : remove dest files not in source (drops stale committed files)
#   --exclude='/server/target' --exclude='/web/node_modules' --exclude='/web/dist'
#            : leaf rules anchored to the rsync source root; these paths on the
#              DEST are not touched by --delete.
# Trailing slash on source = "copy contents", not the dir itself.
if ! ssh "$HOST" "sudo -u '$SERVICE_USER' bash -lc 'command -v rsync >/dev/null'"; then
  echo "[deploy] error: 'rsync' not found on $HOST. The incremental-deploy path requires rsync." >&2
  echo "[deploy]   Fix: install rsync on the host (apt/dnf/apk install rsync), then retry." >&2
  echo "[deploy]   Or:  re-run with --no-cache (slower; uses the cold-rebuild path)." >&2
  ssh "$HOST" "sudo -u '$SERVICE_USER' rm -rf '$REMOTE_STAGE'" 2>/dev/null || true
  exit 1
fi
if ! ssh "$HOST" "sudo -u '$SERVICE_USER' rsync -a --delete --exclude='/server/target' --exclude='/web/node_modules' --exclude='/web/dist' '$REMOTE_STAGE/' '$REMOTE_DIR/'"; then
  echo "[deploy] error: rsync from staging dir $REMOTE_STAGE into $REMOTE_DIR failed." >&2
  ssh "$HOST" "sudo -u '$SERVICE_USER' rm -rf '$REMOTE_STAGE'" 2>/dev/null || true
  exit 1
fi
ssh "$HOST" "sudo -u '$SERVICE_USER' rm -rf '$REMOTE_STAGE'" || true

# ── 2. build natively on the host (toolchains MUST be pre-provisioned) ───────
echo "[deploy] building on $HOST (as user '$SERVICE_USER')"
ssh "$HOST" "sudo -u '$SERVICE_USER' -H bash -s" <<REMOTE_BUILD
set -euo pipefail
# Propagate the cache-bypass flag to build.sh on the host. When set, build.sh
# clears its own skip stamps so even with the rsync-preserved caches we get a
# truly cold rebuild (disaster-recovery path).
export SUPERMUX_NO_CACHE='$SUPERMUX_NO_CACHE'
# Inject version metadata from the LOCAL git context (computed in §0e-bis).
# The remote tarball has no .git/, so build.rs's git fallback would otherwise
# bake "dev" into the binary; these env vars take priority. Single-quoted on
# the remote side — VERSION_TAG/SHA contain only [A-Za-z0-9.-], never spaces.
export SUPERMUX_VERSION_TAG='$VERSION_TAG'
export SUPERMUX_VERSION_SHA='$VERSION_SHA'
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
# __SERVICE_USER__ / __USER_HOME__ / __DATA_DIR__ / __PROTECT_HOME__ /
# __READ_WRITE_PATHS__ placeholders; fill them in here and, when Tailscale is
# enabled, uncomment the optional After/Wants=tailscaled lines.
echo "[deploy] rendering systemd unit (user=$SERVICE_USER home=$USER_HOME data_dir=$DATA_DIR)"
UNIT_TMP="$(mktemp)"
trap 'rm -f "$UNIT_TMP"; _supermux_ssh_cleanup' EXIT
sed -e "s|__SERVICE_USER__|$SERVICE_USER|g" \
    -e "s|__USER_HOME__|$USER_HOME|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    -e "s|__PROJECT_DIRS__|$PROJECT_DIRS|g" \
    -e "s|__PROTECT_HOME__|$PROTECT_HOME|g" \
    -e "s|__READ_WRITE_PATHS__|$READ_WRITE_PATHS|g" \
    -e "s|__MEMORY_DENY_WRITE_EXECUTE__|$MEMORY_DENY_WRITE_EXECUTE|g" \
    -e "s|__PRIVATE_TMP__|$PRIVATE_TMP|g" \
    -e "s|__MEMORY_HIGH__|$MEMORY_HIGH|g" \
    etc/systemd/supermux.service > "$UNIT_TMP"
# __BIND_PATHS__ is its own line in the template: substitute it with the
# BindPaths directive (non-root), or delete the line entirely (root → empty).
if [ -n "$BIND_PATHS_LINE" ]; then
  sed -i.bak "s|__BIND_PATHS__|$BIND_PATHS_LINE|g" "$UNIT_TMP"
else
  sed -i.bak '/__BIND_PATHS__/d' "$UNIT_TMP"
fi
rm -f "$UNIT_TMP.bak" 2>/dev/null || true
# __PUSH_SUB_LINE__ — same pattern as __BIND_PATHS__: render the full
# `Environment=SUPERMUX_PUSH_SUB=<value>` line if SUPERMUX_PUSH_SUB is set in
# .env, or DELETE THE LINE entirely if unset (an empty `Environment=` directive
# is a systemd parse error). This is the missing wiring noted by the OSS audit
# (item 5): .env.example documents the var but without this substitution it
# never reaches the running service.
if [ -n "$PUSH_SUB_LINE" ]; then
  sed -i.bak "s|__PUSH_SUB_LINE__|$PUSH_SUB_LINE|g" "$UNIT_TMP"
else
  sed -i.bak '/__PUSH_SUB_LINE__/d' "$UNIT_TMP"
fi
rm -f "$UNIT_TMP.bak" 2>/dev/null || true
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

# ── 3b. render the self-deploy path-unit + runner (no-sudo self-deploy) ──────
# The in-service dev agent CANNOT use sudo (the supermux unit's NoNewPrivileges
# / RestrictSUIDSGID / empty CapabilityBoundingSet / SystemCallFilter all neuter
# it). Instead it writes a request file; a root-side .path unit watches it and
# starts a root oneshot that runs supermux-deploy-runner (install + restart +
# verify + rollback) OUTSIDE the sandbox. Render the two units + the runner from
# their templates with the same sed style + leak check.
#
# The request file lives under the data dir's deploy/ subdir, which the install
# step below provisions service-user-writable.
DEPLOY_REQUEST="$DATA_DIR/deploy/request"
# The agents' project dir(s) are an allowlist prefix the runner checks the
# source binary against. PROJECT_DIRS is colon-separated; the runner only needs
# one prefix, so use the FIRST entry (the primary project dir).
PRIMARY_PROJECT_DIR="$(printf '%s' "$PROJECT_DIRS" | cut -d: -f1)"

DEPLOY_PATH_TMP="$(mktemp)"
DEPLOY_SVC_TMP="$(mktemp)"
DEPLOY_RUNNER_TMP="$(mktemp)"
trap 'rm -f "$UNIT_TMP" "$DEPLOY_PATH_TMP" "$DEPLOY_SVC_TMP" "$DEPLOY_RUNNER_TMP"; _supermux_ssh_cleanup' EXIT

# supermux-deploy.path — watches the request file.
sed -e "s|__DEPLOY_REQUEST__|$DEPLOY_REQUEST|g" \
    etc/systemd/supermux-deploy.path > "$DEPLOY_PATH_TMP"

# supermux-deploy.service — root oneshot (no placeholders today, but render +
# leak-check it through the same pipeline for consistency).
sed -e "s|__DEPLOY_REQUEST__|$DEPLOY_REQUEST|g" \
    etc/systemd/supermux-deploy.service > "$DEPLOY_SVC_TMP"

# supermux-deploy-runner — the root install+restart+verify+rollback logic.
# __REMOTE_DIR__ lets the runner write the SAME canonical DEPLOYED_SHA file
# this script writes ($REMOTE_DIR/DEPLOYED_SHA) on a successful self-deploy /
# in-UI update, so it does not go stale after the workstation deploy.
sed -e "s|__DEPLOY_REQUEST__|$DEPLOY_REQUEST|g" \
    -e "s|__PROJECTS_DIR__|$PRIMARY_PROJECT_DIR|g" \
    -e "s|__USER_HOME__|$USER_HOME|g" \
    -e "s|__UNIT__|supermux|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    -e "s|__SERVICE_USER__|$SERVICE_USER|g" \
    -e "s|__INTERNAL_PORT__|$INTERNAL_PORT|g" \
    -e "s|__REMOTE_DIR__|$REMOTE_DIR|g" \
    etc/supermux-deploy-runner > "$DEPLOY_RUNNER_TMP"

for rendered in "$DEPLOY_PATH_TMP" "$DEPLOY_SVC_TMP" "$DEPLOY_RUNNER_TMP"; do
  if grep -q '__[A-Z_]\+__' "$rendered"; then
    echo "[deploy] error: rendered self-deploy file still contains unsubstituted placeholders:" >&2
    grep -nE '__[A-Z_]+__' "$rendered" >&2
    exit 1
  fi
done

# ── 4. install binary + systemd unit + config (atomic) ──────────────────────
# Runs under sudo: the build runs as the unprivileged deploy account, but
# installing into /usr/local/bin + /etc/systemd needs root. The service itself
# runs unprivileged (see etc/systemd/supermux.service).
echo "[deploy] installing binary, systemd unit and config on $HOST"
scp "$UNIT_TMP" "$HOST:/tmp/supermux.service.rendered"
scp "$DEPLOY_PATH_TMP" "$HOST:/tmp/supermux-deploy.path.rendered"
scp "$DEPLOY_SVC_TMP" "$HOST:/tmp/supermux-deploy.service.rendered"
scp "$DEPLOY_RUNNER_TMP" "$HOST:/tmp/supermux-deploy-runner.rendered"
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

# Self-deploy request dir — service-user-writable (the agent writes the request
# file here with zero privilege) AND root-writable (the runner truncates the log
# + writes the status here). 0775 owned by the service user satisfies both: the
# agent (owner) and root.
install -d -o '$SERVICE_USER' -g '$SERVICE_USER' -m 0775 '$DATA_DIR/deploy'

# binary
install -m 0755 -o root -g root \
  '$REMOTE_DIR/server/target/release/supermux-server' /usr/local/bin/supermux-server

# record the deployed commit so 'what is running on this host' is answerable
printf '%s\n' '$GIT_SHA' > '$REMOTE_DIR/DEPLOYED_SHA'
echo '[host] deployed commit: $GIT_SHA_SHORT ($GIT_SHA)'

# self-deploy root runner (root-owned, 0755) — the privileged install logic the
# in-service agent triggers via the path unit. MUST be root:root + not
# group/world-writable: the .service runs it as root, so a writable runner would
# be a root escalation. install(1) sets owner+mode atomically.
install -m 0755 -o root -g root \
  /tmp/supermux-deploy-runner.rendered /usr/local/sbin/supermux-deploy-runner
rm -f /tmp/supermux-deploy-runner.rendered

# systemd unit (rendered from the template by deploy.sh)
install -m 0644 -o root -g root \
  /tmp/supermux.service.rendered /etc/systemd/system/supermux.service
rm -f /tmp/supermux.service.rendered

# self-deploy path + service units (rendered by deploy.sh)
install -m 0644 -o root -g root \
  /tmp/supermux-deploy.path.rendered /etc/systemd/system/supermux-deploy.path
install -m 0644 -o root -g root \
  /tmp/supermux-deploy.service.rendered /etc/systemd/system/supermux-deploy.service
rm -f /tmp/supermux-deploy.path.rendered /tmp/supermux-deploy.service.rendered

# Clean up the OLD sudo-based self-deploy approach if a previous deploy left it
# behind. The path-unit trigger replaces it; a stale NOPASSWD sudoers rule +
# setuid-reachable helper is needless attack surface.
rm -f /etc/sudoers.d/supermux-deploy-self /usr/local/sbin/supermux-deploy-self

systemctl daemon-reload
systemctl enable supermux
systemctl restart supermux
# Enable + start the self-deploy watcher (idempotent). --now starts the .path so
# it begins watching immediately; the .service is started BY the path on demand.
systemctl enable --now supermux-deploy.path
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
# The URL/address the operator should open at the end (filled in per path).
SERVE_URL=""
if [ "$USE_TAILSCALE" = "1" ]; then
  echo "[deploy] exposing :$PUBLIC_PORT via tailscale serve → loopback:$INTERNAL_PORT"
  # Quote the ports (operator-controlled but a raw env-set value could be
  # non-numeric — keep the quoting discipline consistent with the rest of the
  # script).
  if ! ssh "$HOST" "sudo tailscale serve --bg --https='$PUBLIC_PORT' 'http://localhost:$INTERNAL_PORT'"; then
    echo "[deploy] error: 'tailscale serve' failed on $HOST." >&2
    echo "[deploy]   Fix: confirm 'tailscale status' is healthy on the host, then re-run." >&2
    echo "[deploy]        OR set SUPERMUX_USE_TAILSCALE=0 to skip Tailscale and front the" >&2
    echo "[deploy]        loopback port with your own reverse proxy." >&2
    exit 1
  fi
  # Best-effort: resolve the device's MagicDNS name so we can print a clickable
  # URL. `tailscale status --json` exposes Self.DNSName (FQDN with a trailing
  # dot). Falls back gracefully to a generic hint if anything is unavailable.
  TS_DNSNAME="$(ssh "$HOST" "sudo tailscale status --json 2>/dev/null | tr ',' '\n' | grep -m1 '\"DNSName\"' | sed -E 's/.*\"DNSName\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/'" 2>/dev/null || true)"
  TS_DNSNAME="${TS_DNSNAME%.}"  # strip the trailing dot if present
  if [ -n "$TS_DNSNAME" ]; then
    if [ "$PUBLIC_PORT" = "443" ]; then
      SERVE_URL="https://$TS_DNSNAME/"
    else
      SERVE_URL="https://$TS_DNSNAME:$PUBLIC_PORT/"
    fi
  fi
  # ── pre-provision the Let's Encrypt HTTPS cert NOW (avoid first-visit error) ─
  # 'tailscale serve' only registers the proxy; it fetches the LE cert LAZILY on
  # the FIRST https hit. The browser races ahead of the cert being issued + CT-
  # logged, so the very first visitor sees ERR_CERTIFICATE_TRANSPARENCY_REQUIRED.
  # 'tailscale cert <host>' provisions it explicitly (a real CT-logged cert), so
  # the first visit is clean. Conditional: ONLY on the Tailscale-expose path
  # (this whole branch is gated on USE_TAILSCALE=1 — a reverse-proxy operator
  # never reaches here). Best-effort: a failure here does NOT fail the deploy —
  # the cert still provisions lazily (just with the possible first-visit hiccup).
  if [ -n "$TS_DNSNAME" ]; then
    echo "[deploy] pre-provisioning Tailscale HTTPS cert for $TS_DNSNAME (can take a few seconds) ..."
    if ! timeout 60 ssh "$HOST" "sudo tailscale cert '$TS_DNSNAME'" >/dev/null 2>&1; then
      echo "[deploy] warn: could not pre-provision the Tailscale cert for $TS_DNSNAME." >&2
      echo "[deploy]       Continuing: the cert will still be issued lazily on the first" >&2
      echo "[deploy]       https visit (that first hit may briefly show a cert error)." >&2
    else
      echo "[deploy] Tailscale HTTPS cert ready for $TS_DNSNAME"
    fi
  else
    echo "[deploy] warn: could not resolve the Tailscale hostname to pre-provision the cert." >&2
    echo "[deploy]       Continuing: the cert will be issued lazily on the first https visit." >&2
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

# ── 7. service-user Claude auth — detect, optionally copy, then VERIFY ───────
# This is the #1 "it doesn't work" cause: the service user never ran
# `claude /login`. supermux uses the Claude SUBSCRIPTION (OAuth) — NEVER an API
# key, never ANTHROPIC_API_KEY, never API billing. We:
#   1. detect ~user/.claude/.credentials.json;
#   2. if missing, OFFER (opt-in, with consent) to copy the deployer's existing
#      login — the fast path that reuses the subscription;
#   3. VERIFY before declaring success and WARN loudly with the exact /login
#      command if creds are still absent.
echo "[deploy] checking Claude Code for service user '$SERVICE_USER'"
LOGIN_CMD="sudo -u $SERVICE_USER -i claude   # then run: /login   (uses your Claude subscription, no API key)"
CLAUDE_AUTH_OK=0

# ── 7a. Claude Code BINARY presence (must come before the login check) ────────
# Every non-shell session launches the bare `claude` binary on the service
# user's PATH (lifecycle.rs); without it the service starts + /api/health = 200
# but every agent dies with "claude: command not found" — and the /login command
# we'd otherwise print can't even run. Probe first; install per INSTALL_CLAUDE.
CLAUDE_BIN_OK=0
if service_user_has_claude_bin "$SERVICE_USER" "$HOST"; then
  echo "[deploy] claude binary: ✓ '$SERVICE_USER' has claude on PATH"
  CLAUDE_BIN_OK=1
else
  echo "[deploy] claude binary: '$SERVICE_USER' does NOT have claude installed."
  DO_INSTALL=0
  case "$INSTALL_CLAUDE" in
    0)
      echo "[deploy]   (SUPERMUX_INSTALL_CLAUDE=0 — not installing Claude Code)"
      ;;
    1)
      echo "[deploy]   SUPERMUX_INSTALL_CLAUDE=1 — installing Claude Code (official native installer)."
      DO_INSTALL=1
      ;;
    *)
      # "ask" — interactive consent. No TTY → warn only (never silently
      # fetch+exec; matches the bun/cargo/tmux discipline).
      if [ -t 0 ]; then
        echo "[deploy]   I can install it now for '$SERVICE_USER' via the official native"
        echo "[deploy]   installer (no Node needed; lands in ~$SERVICE_USER/.local/bin)."
        printf "[deploy]   Install Claude Code for '%s' now? [y/N] " "$SERVICE_USER"
        read -r _reply || _reply=""
        case "$_reply" in
          y|Y|yes|YES|Yes) DO_INSTALL=1 ;;
          *) echo "[deploy]   (skipped — install it yourself, see the command below)" ;;
        esac
      else
        echo "[deploy]   (non-interactive + SUPERMUX_INSTALL_CLAUDE unset — not installing."
        echo "[deploy]    Set SUPERMUX_INSTALL_CLAUDE=1 to install automatically.)"
      fi
      ;;
  esac

  if [ "$DO_INSTALL" = "1" ]; then
    if install_claude_for_service_user "$SERVICE_USER" "$HOST"; then
      if service_user_has_claude_bin "$SERVICE_USER" "$HOST"; then
        echo "[deploy] claude binary: ✓ installed — '$SERVICE_USER' now has claude on PATH."
        CLAUDE_BIN_OK=1
      else
        echo "[deploy] warn: installer ran but 'claude' still isn't on PATH — check ~$SERVICE_USER/.local/bin." >&2
      fi
    else
      echo "[deploy] warn: installing Claude Code failed — see the manual command below." >&2
    fi
  fi
fi

# ── 7b. service-user Claude auth — detect, optionally copy, then VERIFY ───────
# The #1 "it doesn't work" cause once the binary IS present: the service user
# never ran `claude /login`. supermux uses the Claude SUBSCRIPTION (OAuth) —
# NEVER an API key, never ANTHROPIC_API_KEY, never API billing. Only meaningful
# when the binary exists — you can't /login a CLI that isn't installed — so this
# whole block is gated on CLAUDE_BIN_OK.
if [ "$CLAUDE_BIN_OK" = "1" ]; then
  if service_user_has_claude_creds "$USER_HOME" "$HOST"; then
    echo "[deploy] claude auth: ✓ '$SERVICE_USER' has $USER_HOME/.claude/.credentials.json"
    CLAUDE_AUTH_OK=1
  else
    echo "[deploy] claude auth: '$SERVICE_USER' has NO Claude credentials yet."
    # Can we offer the fast path — copy the deployer's existing login?
    DEPLOYER_HOME="$(deployer_claude_creds_home "$HOST" 2>/dev/null || true)"
    DEPLOYER_HAS_CREDS=0
    if [ -n "$DEPLOYER_HOME" ] && remote_check "sudo test -f '$DEPLOYER_HOME/.claude/.credentials.json'"; then
      DEPLOYER_HAS_CREDS=1
    fi

    DO_COPY=0
    if [ "$DEPLOYER_HAS_CREDS" = "1" ]; then
      case "$COPY_CLAUDE_CREDS" in
        0)
          echo "[deploy]   (SUPERMUX_COPY_CLAUDE_CREDS=0 — not copying the deployer's login)"
          ;;
        1)
          echo "[deploy]   SUPERMUX_COPY_CLAUDE_CREDS=1 — copying the deployer's Claude login (subscription)."
          DO_COPY=1
          ;;
        *)
          # "ask" — interactive consent. If not a TTY, fall back to "don't copy".
          if [ -t 0 ]; then
            echo "[deploy]   The account you deployed AS ($DEPLOYER_HOME) has a valid Claude login."
            echo "[deploy]   I can copy it to '$SERVICE_USER' (reuses your subscription — NO API key)."
            printf "[deploy]   Copy the deployer's Claude login to '%s'? [y/N] " "$SERVICE_USER"
            read -r _reply || _reply=""
            case "$_reply" in
              y|Y|yes|YES|Yes) DO_COPY=1 ;;
              *) echo "[deploy]   (skipped — you can copy later or run /login as the service user)" ;;
            esac
          else
            echo "[deploy]   (non-interactive + SUPERMUX_COPY_CLAUDE_CREDS unset — not copying."
            echo "[deploy]    Set SUPERMUX_COPY_CLAUDE_CREDS=1 to copy automatically.)"
          fi
          ;;
      esac
    fi

    if [ "$DO_COPY" = "1" ]; then
      if copy_deployer_claude_creds "$DEPLOYER_HOME" "$USER_HOME" "$SERVICE_USER" "$HOST"; then
        if service_user_has_claude_creds "$USER_HOME" "$HOST"; then
          echo "[deploy] claude auth: ✓ copied — '$SERVICE_USER' now has valid Claude credentials."
          CLAUDE_AUTH_OK=1
        fi
      else
        echo "[deploy] warn: copying the deployer's Claude login failed — falling back to manual /login." >&2
      fi
    fi
  fi
fi

# ── 7c. report what (if anything) still needs the operator's hands ────────────
# Left-bar-only style: the variable-length lines can be any length, so a
# fixed-width right border would render ragged. A single left rule stays tidy
# regardless of content width, and commands get their own indented lines so
# they're easy to copy. Two distinct stop-states:
#   • binary missing  → install Claude Code first (the /login command can't run)
#   • binary present, not logged in → run /login
if [ "$CLAUDE_BIN_OK" != "1" ]; then
  echo "[deploy] ┌─ ACTION REQUIRED ──────────────────────────────────────────────" >&2
  echo "[deploy] │  Claude Code is NOT installed for service user '$SERVICE_USER'." >&2
  echo "[deploy] │  Every agent will fail with 'claude: command not found' until it is." >&2
  echo "[deploy] │  Install it on the host (no Node needed):" >&2
  echo "[deploy] │" >&2
  echo "[deploy] │      $(claude_install_hint "$SERVICE_USER")" >&2
  echo "[deploy] │" >&2
  echo "[deploy] │  …then log in (uses your Claude subscription, NO API key):" >&2
  echo "[deploy] │" >&2
  echo "[deploy] │      $LOGIN_CMD" >&2
  echo "[deploy] │" >&2
  echo "[deploy] │  Tip: re-run deploy with SUPERMUX_INSTALL_CLAUDE=1 to install it for you." >&2
  echo "[deploy] └────────────────────────────────────────────────────────────────" >&2
elif [ "$CLAUDE_AUTH_OK" != "1" ]; then
  echo "[deploy] ┌─ ACTION REQUIRED ──────────────────────────────────────────────" >&2
  echo "[deploy] │  service user '$SERVICE_USER' is NOT logged in to Claude." >&2
  echo "[deploy] │  Agents will fail until you log in (subscription, NO API key)." >&2
  echo "[deploy] │  On the host, run:" >&2
  echo "[deploy] │" >&2
  echo "[deploy] │      $LOGIN_CMD" >&2
  echo "[deploy] │" >&2
  echo "[deploy] │  This opens an interactive Claude session as the service user;" >&2
  echo "[deploy] │  the /login command authenticates against your Claude subscription." >&2
  echo "[deploy] └────────────────────────────────────────────────────────────────" >&2
fi

echo "[deploy] done — supermux (commit $GIT_SHA_SHORT) live on $HOST loopback:$INTERNAL_PORT"
if [ "$CLAUDE_BIN_OK" != "1" ]; then
  echo "[deploy]   service runs as unprivileged '$SERVICE_USER'; FINISH SETUP by installing Claude Code, then logging in (see above)."
elif [ "$CLAUDE_AUTH_OK" = "1" ]; then
  echo "[deploy]   service runs as unprivileged '$SERVICE_USER'; Claude Code installed + login verified."
else
  echo "[deploy]   service runs as unprivileged '$SERVICE_USER'; FINISH SETUP by logging in to Claude (see above)."
fi

# ── 8. tell the operator WHERE to open it — the payoff ───────────────────────
# The auth token auto-injects into the served HTML, so reaching the page = logged
# in. Print the concrete address so the operator doesn't have to guess.
if [ "$USE_TAILSCALE" = "1" ]; then
  if [ -n "$SERVE_URL" ]; then
    echo "[deploy] open: $SERVE_URL"
  else
    echo "[deploy] open: https://<this-host>.<your-tailnet>.ts.net/  (Tailscale MagicDNS)"
    echo "[deploy]   tip: 'tailscale status' on the host shows the device's DNS name;"
    echo "[deploy]        'sudo tailscale set --hostname=supermux' gives it a clean name."
  fi
else
  echo "[deploy] open: front loopback:$INTERNAL_PORT with your reverse proxy, OR tunnel from your laptop:"
  echo "[deploy]   ssh -L $INTERNAL_PORT:127.0.0.1:$INTERNAL_PORT $HOST   # then open http://127.0.0.1:$INTERNAL_PORT/"
fi
