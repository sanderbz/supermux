#!/usr/bin/env bash
# supermux setup wizard — a friendly, interactive way to produce a working .env.
#
# One command, a handful of questions (each with smart defaults), one file out.
# Advanced users can still hand-edit .env after — this just gets you there fast.
#
# Usage:
#   bash scripts/setup.sh           # interactive
#   bash scripts/setup.sh --yes     # accept all defaults, no prompts
#   SUPERMUX_NONINTERACTIVE=1 bash scripts/setup.sh   # same as --yes
#
# Designed to work with bash 3.x (macOS default) — no associative arrays, no
# fancy parameter expansion. Atomic .env writes: a temp file is written first
# and moved into place, so Ctrl-C never leaves a half-written .env behind.

set -u

# ---------------------------------------------------------------------------
# Paths and globals
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
ENV_TMP=""

NONINTERACTIVE=0
if [ "${SUPERMUX_NONINTERACTIVE:-0}" = "1" ]; then
  NONINTERACTIVE=1
fi
for arg in "$@"; do
  case "$arg" in
    --yes|-y) NONINTERACTIVE=1 ;;
    -h|--help)
      cat <<'EOF'
supermux setup wizard

Usage:
  bash scripts/setup.sh           Interactive — asks a few friendly questions.
  bash scripts/setup.sh --yes     Non-interactive — accepts all defaults.

After it writes .env, run `bash scripts/deploy.sh` to deploy.
EOF
      exit 0
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Color helpers (degrade gracefully if not a TTY or NO_COLOR=1)
# ---------------------------------------------------------------------------

USE_COLOR=1
if [ "${NO_COLOR:-}" = "1" ] || [ ! -t 1 ]; then
  USE_COLOR=0
fi

c_reset=""; c_dim=""; c_bold=""; c_green=""; c_yellow=""; c_red=""; c_cyan=""
if [ "$USE_COLOR" = "1" ]; then
  c_reset=$(printf '\033[0m')
  c_dim=$(printf '\033[2m')
  c_bold=$(printf '\033[1m')
  c_green=$(printf '\033[32m')
  c_yellow=$(printf '\033[33m')
  c_red=$(printf '\033[31m')
  c_cyan=$(printf '\033[36m')
fi

ok()    { printf "%s\xE2\x9C\x93%s %s\n" "$c_green" "$c_reset" "$1"; }
warn()  { printf "%s?%s %s\n" "$c_yellow" "$c_reset" "$1"; }
err()   { printf "%s\xE2\x9C\x97%s %s\n" "$c_red" "$c_reset" "$1" >&2; }
note()  { printf "%s  %s%s\n" "$c_dim" "$1" "$c_reset"; }
hdr()   { printf "\n%s%s%s\n" "$c_bold" "$1" "$c_reset"; }
step()  { printf "\n%sStep %s of %s:%s %s\n" "$c_cyan" "$1" "$2" "$c_reset" "$3"; }

# ---------------------------------------------------------------------------
# Cleanup on exit / interrupt — atomic .env writes
# ---------------------------------------------------------------------------

cleanup() {
  if [ -n "$ENV_TMP" ] && [ -f "$ENV_TMP" ]; then
    rm -f "$ENV_TMP"
  fi
}
on_interrupt() {
  cleanup
  printf "\n"
  warn "interrupted — no changes made."
  exit 130
}
trap cleanup EXIT
trap on_interrupt INT TERM

# ---------------------------------------------------------------------------
# Prompt helpers
# ---------------------------------------------------------------------------

# ask "Prompt text" "default" [varname-to-set]
# When non-interactive, returns the default.
# Sets the global ANS variable (also echoes it as return); accepts an optional
# named var for clarity at call sites.
ANS=""
ask() {
  local prompt="$1"
  local default="$2"
  local _reply=""
  if [ "$NONINTERACTIVE" = "1" ]; then
    ANS="$default"
    return 0
  fi
  if [ -n "$default" ]; then
    printf "%s? %s%s %s[%s]%s " "$c_yellow" "$c_reset" "$prompt" "$c_dim" "$default" "$c_reset"
  else
    printf "%s? %s%s " "$c_yellow" "$c_reset" "$prompt"
  fi
  IFS= read -r _reply || { on_interrupt; }
  if [ -z "$_reply" ]; then
    ANS="$default"
  else
    ANS="$_reply"
  fi
}

# ask_yn "Prompt text" "Y|N"  -> sets ANS to "y" or "n"
ask_yn() {
  local prompt="$1"
  local default="$2"   # "Y" or "N"
  local hint
  if [ "$default" = "Y" ]; then
    hint="[Y/n]"
  else
    hint="[y/N]"
  fi
  if [ "$NONINTERACTIVE" = "1" ]; then
    if [ "$default" = "Y" ]; then ANS="y"; else ANS="n"; fi
    return 0
  fi
  local _reply=""
  printf "%s? %s%s %s%s%s " "$c_yellow" "$c_reset" "$prompt" "$c_dim" "$hint" "$c_reset"
  IFS= read -r _reply || { on_interrupt; }
  case "$_reply" in
    y|Y|yes|YES|Yes) ANS="y" ;;
    n|N|no|NO|No)    ANS="n" ;;
    "")              if [ "$default" = "Y" ]; then ANS="y"; else ANS="n"; fi ;;
    *)
      warn "didn't understand '$_reply' — using default '$default'"
      if [ "$default" = "Y" ]; then ANS="y"; else ANS="n"; fi
      ;;
  esac
}

# ask_choice "Prompt" "1" "label1" "label2" "label3" -> sets ANS to "1"/"2"/"3"
ask_choice() {
  local prompt="$1"; shift
  local default="$1"; shift
  local i=1
  local labels=""
  for label in "$@"; do
    if [ -n "$labels" ]; then labels="$labels  "; fi
    labels="${labels}(${i}) ${label}"
    i=$((i + 1))
  done
  if [ "$NONINTERACTIVE" = "1" ]; then
    ANS="$default"
    return 0
  fi
  local _reply=""
  printf "%s? %s%s\n  %s\n  %s[default %s]%s " "$c_yellow" "$c_reset" "$prompt" "$labels" "$c_dim" "$default" "$c_reset"
  IFS= read -r _reply || { on_interrupt; }
  if [ -z "$_reply" ]; then
    ANS="$default"
  else
    ANS="$_reply"
  fi
}

# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

is_port() {
  # 1024..65535
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ "$1" -lt 1024 ] || [ "$1" -gt 65535 ]; then
    return 1
  fi
  return 0
}

is_hostname() {
  # No whitespace, no shell metachars likely to break ssh.
  case "$1" in
    ''|*' '*|*$'\t'*) return 1 ;;
    *\;*|*\&*|*\|*|*\<*|*\>*|*\`*|*\$\(*) return 1 ;;
    *) return 0 ;;
  esac
}

is_username() {
  # POSIX-ish: start with letter or _, then letters/digits/_/-
  case "$1" in
    ''|*' '*) return 1 ;;
    [a-zA-Z_]*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *[!a-zA-Z0-9_-]*) return 1 ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------
# Existing-value reader (so re-runs default to whatever was last in .env)
# ---------------------------------------------------------------------------

read_env_value() {
  # read_env_value KEY FILE -> echoes value (no quotes), empty if absent
  local key="$1"; local file="$2"
  [ -f "$file" ] || return 0
  # grep last assignment of KEY=, strip leading KEY=, strip surrounding quotes.
  local line
  line=$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)
  [ -z "$line" ] && return 0
  local val="${line#*=}"
  # Strip leading/trailing whitespace
  val=$(printf "%s" "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  # Strip surrounding single or double quotes
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  printf "%s" "$val"
}

# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------

ssh_works() {
  # ssh_works HOST -> 0 if a non-interactive ssh handshake succeeds in <=5s
  local host="$1"
  command -v ssh >/dev/null 2>&1 || return 1
  ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
      "$host" true >/dev/null 2>&1
}

detect_remote_user() {
  # Best-effort: ssh and ask whoami. Returns empty on failure.
  local host="$1"
  command -v ssh >/dev/null 2>&1 || return 0
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" "whoami" 2>/dev/null || true
}

detect_tailscale() {
  # detect_tailscale HOST -> 0 if `tailscale` is on PATH on the host AND the
  # `tailscaled` service is active. Mirrors deploy.sh's check so the wizard
  # doesn't default to Y when the daemon is dead/masked (which would fail
  # late at `tailscale serve` after the unit was already installed).
  local host="$1"
  command -v ssh >/dev/null 2>&1 || return 1
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$host" \
      'command -v tailscale >/dev/null 2>&1 && systemctl is-active --quiet tailscaled' \
      >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

print_banner() {
  hdr "supermux setup"
  note "this writes a .env in the repo root with smart defaults so the"
  note "deploy step is one command. You can re-run this any time — or"
  note "hand-edit .env directly if you prefer."
  if [ "$NONINTERACTIVE" = "1" ]; then
    note "running non-interactively — accepting all defaults."
  fi
}

# ---------------------------------------------------------------------------
# Existing .env disposition
# ---------------------------------------------------------------------------

DISPOSITION="new"   # new | keep | edit | overwrite

handle_existing_env() {
  if [ ! -f "$ENV_FILE" ]; then
    DISPOSITION="new"
    return 0
  fi
  hdr "existing .env detected"
  note "found: $ENV_FILE"
  if [ "$NONINTERACTIVE" = "1" ]; then
    DISPOSITION="keep"
    ok "non-interactive — keeping existing .env unchanged."
    return 0
  fi
  ask_choice "what would you like to do?" "1" \
    "keep it (no changes)" \
    "edit specific values (defaults pre-filled from current .env)" \
    "start over (regenerate from scratch)"
  case "$ANS" in
    1) DISPOSITION="keep" ;;
    2) DISPOSITION="edit" ;;
    3) DISPOSITION="overwrite" ;;
    *) DISPOSITION="keep" ;;
  esac
}

# ---------------------------------------------------------------------------
# Defaults — when editing, prefill from existing .env
# ---------------------------------------------------------------------------

# Collected answers (plain vars — no associative arrays for bash 3.x)
V_HOST=""
V_USER=""
V_USER_HOME=""
V_DATA_DIR=""
V_PROJECT_DIRS=""
V_READ_WRITE_PATHS=""
V_REMOTE_DIR=""
V_DEPLOY_REF=""
V_INTERNAL_PORT=""
V_PUBLIC_PORT=""
V_USE_TAILSCALE=""
V_ALLOW_ROOT=""
V_AUTO_INSTALL=""

# "Did the operator explicitly customize this via the advanced step (or carry
# it over from an existing .env)?" — controls whether we write the var into
# .env at all. When unset, deploy.sh's smarter resolution (getent for HOME,
# DATA_DIR:HOME[:/opt/projects] for RW paths) is the source of truth.
V_USER_HOME_CUSTOMIZED=0
V_READ_WRITE_PATHS_CUSTOMIZED=0

# Defaults
D_HOST=""
D_USER="supermux"
D_INTERNAL_PORT="8824"
D_PUBLIC_PORT="8823"
D_USE_TAILSCALE="0"
D_DEPLOY_REF="HEAD"
D_AUTO_INSTALL="Y"

derive_defaults_from_existing() {
  if [ "$DISPOSITION" = "edit" ] && [ -f "$ENV_FILE" ]; then
    local v
    v=$(read_env_value SUPERMUX_DEPLOY_HOST "$ENV_FILE");    [ -n "$v" ] && D_HOST="$v"
    v=$(read_env_value SUPERMUX_SERVICE_USER "$ENV_FILE");   [ -n "$v" ] && D_USER="$v"
    v=$(read_env_value SUPERMUX_INTERNAL_PORT "$ENV_FILE");  [ -n "$v" ] && D_INTERNAL_PORT="$v"
    v=$(read_env_value SUPERMUX_PUBLIC_PORT "$ENV_FILE");    [ -n "$v" ] && D_PUBLIC_PORT="$v"
    v=$(read_env_value SUPERMUX_USE_TAILSCALE "$ENV_FILE");  [ -n "$v" ] && D_USE_TAILSCALE="$v"
    v=$(read_env_value SUPERMUX_DEPLOY_REF "$ENV_FILE");     [ -n "$v" ] && D_DEPLOY_REF="$v"
    # Carry forward operator-customized path overrides if present in the
    # existing .env, and mark them as customized so write_env preserves them.
    # Absent = let deploy.sh's smart defaults (getent USER_HOME, smart
    # DATA_DIR:HOME[:/opt/projects] for RW paths) fire on re-deploy.
    v=$(read_env_value SUPERMUX_USER_HOME "$ENV_FILE")
    if [ -n "$v" ]; then V_USER_HOME="$v"; V_USER_HOME_CUSTOMIZED=1; fi
    v=$(read_env_value SUPERMUX_READ_WRITE_PATHS "$ENV_FILE")
    if [ -n "$v" ]; then V_READ_WRITE_PATHS="$v"; V_READ_WRITE_PATHS_CUSTOMIZED=1; fi
    v=$(read_env_value SUPERMUX_DATA_DIR "$ENV_FILE");       [ -n "$v" ] && V_DATA_DIR="$v"
    v=$(read_env_value SUPERMUX_PROJECT_DIRS "$ENV_FILE");   [ -n "$v" ] && V_PROJECT_DIRS="$v"
    v=$(read_env_value SUPERMUX_REMOTE_DIR "$ENV_FILE");     [ -n "$v" ] && V_REMOTE_DIR="$v"
  fi
}

derive_user_paths() {
  # Given V_USER, derive default home/data/projects/readwrite/remote-dir paths.
  local user="$V_USER"
  local home
  if [ "$user" = "root" ]; then
    home="/root"
  else
    home="/home/$user"
  fi
  if [ -z "$V_USER_HOME" ]; then V_USER_HOME="$home"; fi
  if [ -z "$V_DATA_DIR" ]; then V_DATA_DIR="$home/.supermux"; fi
  # Smart default for the project dirs (where agents work): under the user's
  # home so the user already owns it — zero chown fuss, noob-proof.
  if [ -z "$V_PROJECT_DIRS" ]; then V_PROJECT_DIRS="$home/projects"; fi
  if [ -z "$V_READ_WRITE_PATHS" ]; then V_READ_WRITE_PATHS="$V_DATA_DIR"; fi
  if [ -z "$V_REMOTE_DIR" ]; then V_REMOTE_DIR="/opt/supermux"; fi
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

TOTAL_STEPS=8

step_host() {
  step 1 "$TOTAL_STEPS" "deploy target (SSH host)"
  note "this is the host you're deploying to — a hostname, a"
  note "user@host string, or an alias from your ~/.ssh/config."

  # Non-interactive: the host MUST come in via env var (or existing .env). We
  # cannot prompt for a required field — so fail clearly instead of looping.
  if [ "$NONINTERACTIVE" = "1" ]; then
    local env_host="${SUPERMUX_DEPLOY_HOST:-$D_HOST}"
    if [ -z "$env_host" ]; then
      err "non-interactive mode but no deploy host provided."
      note "set SUPERMUX_DEPLOY_HOST=your.host before re-running, or run"
      note "without --yes to enter one interactively."
      exit 1
    fi
    if ! is_hostname "$env_host"; then
      err "SUPERMUX_DEPLOY_HOST='$env_host' is not a valid hostname."
      exit 1
    fi
    V_HOST="$env_host"
    ok "using SUPERMUX_DEPLOY_HOST=$V_HOST"
    return 0
  fi

  while :; do
    ask "SSH host" "$D_HOST"
    if [ -z "$ANS" ]; then
      err "a deploy host is required — please enter one."
      continue
    fi
    if ! is_hostname "$ANS"; then
      err "that doesn't look like a valid hostname (no spaces or shell metachars)."
      continue
    fi
    V_HOST="$ANS"
    break
  done

  if [ "$NONINTERACTIVE" = "0" ]; then
    printf "  %schecking SSH connection…%s " "$c_dim" "$c_reset"
    if ssh_works "$V_HOST"; then
      local remote
      remote=$(detect_remote_user "$V_HOST")
      if [ -n "$remote" ]; then
        printf "\n"
        ok "SSH works — connected as $remote on $V_HOST."
      else
        printf "\n"
        ok "SSH works — handshake succeeded with $V_HOST."
      fi
    else
      printf "\n"
      warn "couldn't reach $V_HOST via SSH non-interactively. Common fixes:"
      note "  - add a Host alias in ~/.ssh/config with User + IdentityFile"
      note "  - copy your public key into the host's ~/.ssh/authorized_keys"
      note "  - if the host needs a password, use ssh-copy-id first"
      note "(continuing — deploy.sh will give a clearer error if SSH is broken)"
    fi
  fi
}

step_user() {
  step 2 "$TOTAL_STEPS" "service user on the host"
  note "this is the UNPRIVILEGED Unix account the service RUNS AS on the host."
  note "it is NOT the account you SSH in as to deploy — deploying over a root"
  note "SSH session is fine; root just provisions, the service drops to this user."
  note "if 'supermux' doesn't exist yet, deploy.sh creates it automatically."
  note "non-root is strongly recommended (running as root breaks Claude Code's"
  note "--dangerously-skip-permissions and throws away the systemd sandbox)."
  while :; do
    ask "service user" "$D_USER"
    if [ -z "$ANS" ]; then
      err "a service user is required."
      continue
    fi
    if ! is_username "$ANS"; then
      err "'$ANS' is not a valid Unix username (letters, digits, _, -; must not start with a digit)."
      continue
    fi
    V_USER="$ANS"
    break
  done
  if [ "$V_USER" = "root" ]; then
    warn "LAST RESORT: you chose to run the SERVICE as root."
    note "this is a security + functionality trade-off, not just a hardening knob:"
    note "  - deploy.sh renders ProtectHome=false + ReadWritePaths=/root (the"
    note "    systemd isolation sandbox is largely given up);"
    note "  - Claude Code REFUSES --dangerously-skip-permissions as uid 0, so"
    note "    your agents may not run at all."
    note "strongly recommended instead: use the default 'supermux' (re-run and"
    note "accept the default). Root still runs the deploy; only the service drops"
    note "to the unprivileged user."
    ask_yn "are you sure you want to run the service as ROOT?" "N"
    if [ "$ANS" != "y" ]; then
      note "good call — switching the service user back to the default '$D_USER'."
      V_USER="$D_USER"
      V_ALLOW_ROOT="0"
    else
      V_ALLOW_ROOT="1"
      warn "proceeding with the service running as root (SUPERMUX_ALLOW_ROOT=1)."
    fi
  else
    V_ALLOW_ROOT="0"
  fi
}

step_project_dirs() {
  step 3 "$TOTAL_STEPS" "where will your agents work?"
  note "the service user needs read+write access to the directories where your"
  note "agents do their work (clone repos, edit files, run builds)."
  note "the smart default is under the service user's home, so it's already"
  note "owned by that user — zero permission fuss. Point elsewhere (e.g."
  note "/opt/projects:/srv/work, colon-separated) and deploy.sh wires the"
  note "ownership + systemd ReadWritePaths for you."
  # Pre-derive so the default is a sensible <home>/projects.
  derive_user_paths
  ask "project directories (colon-separated)" "$V_PROJECT_DIRS"
  V_PROJECT_DIRS="$ANS"
  case "$V_PROJECT_DIRS" in
    "$V_USER_HOME"/*|"$V_USER_HOME")
      ok "under the service user's home — owned by '$V_USER', no chown needed." ;;
    /*)
      note "outside the user's home — deploy.sh will chown these to '$V_USER' so"
      note "the agent can write, and add them to ReadWritePaths." ;;
    *)
      warn "'$V_PROJECT_DIRS' is not an absolute path — deploy.sh expects /-rooted dirs." ;;
  esac
}

step_ports() {
  step 4 "$TOTAL_STEPS" "ports"
  note "internal = where the binary binds on the host's loopback."
  note "public  = where you reach it from outside (Tailscale or your proxy)."
  while :; do
    ask "internal port (loopback)" "$D_INTERNAL_PORT"
    if is_port "$ANS"; then
      V_INTERNAL_PORT="$ANS"; break
    fi
    err "port must be a number between 1024 and 65535."
  done
  while :; do
    ask "public port (TLS)" "$D_PUBLIC_PORT"
    if is_port "$ANS"; then
      V_PUBLIC_PORT="$ANS"; break
    fi
    err "port must be a number between 1024 and 65535."
  done
  if [ "$V_INTERNAL_PORT" = "$V_PUBLIC_PORT" ]; then
    warn "internal and public ports are identical ($V_INTERNAL_PORT) — that's"
    note "unusual but not invalid. Tailscale serve will refuse to bind both."
  fi
}

step_tailscale() {
  step 5 "$TOTAL_STEPS" "expose via Tailscale?"
  local default_ts="N"
  if [ -n "$V_HOST" ] && [ "$NONINTERACTIVE" = "0" ]; then
    printf "  %schecking for tailscale on %s…%s " "$c_dim" "$V_HOST" "$c_reset"
    if detect_tailscale "$V_HOST"; then
      printf "\n"
      ok "tailscale found on $V_HOST."
      default_ts="Y"
    else
      printf "\n"
      note "tailscale not detected on $V_HOST — you can front the loopback"
      note "port with your own reverse proxy (nginx/caddy) instead."
      default_ts="N"
    fi
  fi
  # If editing, honor existing value as default.
  if [ "$D_USE_TAILSCALE" = "1" ]; then default_ts="Y"; fi
  if [ "$D_USE_TAILSCALE" = "0" ] && [ "$DISPOSITION" = "edit" ]; then default_ts="N"; fi

  ask_yn "expose via tailscale serve?" "$default_ts"
  if [ "$ANS" = "y" ]; then
    V_USE_TAILSCALE="1"
    note "tip: for a clean URL like 'https://supermux.<your-tailnet>.ts.net/'"
    note "     rename the device once on the host:"
    note "       sudo tailscale set --hostname=supermux"
    note "default port is 443 (no port suffix in the URL)."
  else
    V_USE_TAILSCALE="0"
  fi
}

step_advanced() {
  step 6 "$TOTAL_STEPS" "advanced (skippable)"
  note "customize data dir / read-write paths / remote build dir / deploy ref?"
  note "say N to use sensible defaults — you can always edit .env later."
  ask_yn "customize advanced settings?" "N"
  if [ "$ANS" != "y" ]; then
    derive_user_paths
    ok "using defaults derived from service user '$V_USER'."
    return 0
  fi

  # Pre-derive so the prompt defaults are pre-filled with sensible paths.
  # Snapshot the derived defaults so we can tell whether the operator actually
  # changed anything — if they just Enter through, we keep CUSTOMIZED=0 and
  # let deploy.sh's smarter resolution (getent / smart RW default) win.
  derive_user_paths
  local derived_user_home="$V_USER_HOME"
  local derived_rw_paths="$V_READ_WRITE_PATHS"

  ask "service user's HOME on the host" "$V_USER_HOME"
  V_USER_HOME="$ANS"
  if [ "$V_USER_HOME" != "$derived_user_home" ]; then
    V_USER_HOME_CUSTOMIZED=1
  fi

  ask "data directory (SQLite, auth token, config.toml, uploads)" "$V_DATA_DIR"
  V_DATA_DIR="$ANS"

  ask "extra writable roots (colon-separated, for ReadWritePaths)" "$V_READ_WRITE_PATHS"
  V_READ_WRITE_PATHS="$ANS"
  if [ "$V_READ_WRITE_PATHS" != "$derived_rw_paths" ]; then
    V_READ_WRITE_PATHS_CUSTOMIZED=1
  fi

  ask "remote build/source directory on the host" "$V_REMOTE_DIR"
  V_REMOTE_DIR="$ANS"

  ask "git ref to deploy (working tree must be clean)" "$D_DEPLOY_REF"
  V_DEPLOY_REF="$ANS"
}

step_toolchain() {
  step 7 "$TOTAL_STEPS" "toolchain auto-install"
  note "if bun or cargo is missing on the host, install them automatically"
  note "(pinned versions). Trade-off: the install fetches an upstream installer"
  note "over HTTPS — convenient, but you're trusting that supply chain. Say N"
  note "to pre-provision them yourself out of band."
  ask_yn "auto-install bun/cargo if missing?" "$D_AUTO_INSTALL"
  if [ "$ANS" = "y" ]; then
    V_AUTO_INSTALL="1"
  else
    V_AUTO_INSTALL="0"
  fi
}

step_deploy_ref_default() {
  # Default deploy ref only set if not already collected via advanced step.
  if [ -z "$V_DEPLOY_REF" ]; then
    V_DEPLOY_REF="$D_DEPLOY_REF"
  fi
}

step_summary_and_confirm() {
  derive_user_paths
  step_deploy_ref_default
  step 8 "$TOTAL_STEPS" "summary"
  printf "  %sdeploy target          %s%s\n" "$c_dim" "$c_reset" "$V_HOST"
  if [ "$V_ALLOW_ROOT" = "1" ]; then
    printf "  %sservice RUNS AS        %s%sroot — LAST RESORT (hardening relaxed, Claude may refuse)%s\n" "$c_dim" "$c_reset" "$c_red" "$c_reset"
  else
    printf "  %sservice RUNS AS        %s%s (unprivileged — recommended)\n" "$c_dim" "$c_reset" "$V_USER"
  fi
  if [ "$V_USER_HOME_CUSTOMIZED" = "1" ]; then
    printf "  %sservice user HOME      %s%s\n" "$c_dim" "$c_reset" "$V_USER_HOME"
  else
    printf "  %sservice user HOME      %s(deploy.sh resolves via getent)\n" "$c_dim" "$c_reset"
  fi
  printf "  %sproject dirs (agents)  %s%s\n" "$c_dim" "$c_reset" "$V_PROJECT_DIRS"
  printf "  %sdata directory         %s%s\n" "$c_dim" "$c_reset" "$V_DATA_DIR"
  if [ "$V_READ_WRITE_PATHS_CUSTOMIZED" = "1" ]; then
    printf "  %sextra writable roots   %s%s\n" "$c_dim" "$c_reset" "$V_READ_WRITE_PATHS"
  else
    printf "  %sextra writable roots   %s(deploy.sh smart default: DATA_DIR:HOME[:/opt/projects])\n" "$c_dim" "$c_reset"
  fi
  printf "  %sremote build dir       %s%s\n" "$c_dim" "$c_reset" "$V_REMOTE_DIR"
  printf "  %sinternal port          %s%s\n" "$c_dim" "$c_reset" "$V_INTERNAL_PORT"
  printf "  %spublic port            %s%s\n" "$c_dim" "$c_reset" "$V_PUBLIC_PORT"
  printf "  %sexpose via tailscale   %s%s\n" "$c_dim" "$c_reset" "$V_USE_TAILSCALE"
  printf "  %sgit ref to deploy      %s%s\n" "$c_dim" "$c_reset" "$V_DEPLOY_REF"
  printf "  %sauto-install toolchain %s%s\n" "$c_dim" "$c_reset" "$V_AUTO_INSTALL"
  printf "\n"
  ask_yn "write .env and continue?" "Y"
  if [ "$ANS" != "y" ]; then
    warn "aborted — no changes made."
    exit 0
  fi
}

# ---------------------------------------------------------------------------
# Atomic .env writer
# ---------------------------------------------------------------------------

write_env() {
  ENV_TMP="${ENV_FILE}.tmp.$$"
  # Build the file in the temp location, then mv.
  {
    printf "# Generated by scripts/setup.sh on %s\n" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    printf "# Edit freely; re-run setup.sh to regenerate.\n"
    printf "\n"
    printf "SUPERMUX_DEPLOY_HOST=%s\n" "$V_HOST"
    printf "SUPERMUX_SERVICE_USER=%s\n" "$V_USER"
    if [ "$V_ALLOW_ROOT" = "1" ]; then
      printf "SUPERMUX_ALLOW_ROOT=1\n"
    fi
    # Only pin USER_HOME / READ_WRITE_PATHS when the operator explicitly
    # customized them (advanced step) or carried them forward from an
    # existing .env. Otherwise omit and let deploy.sh's smarter resolution
    # win: getent passwd $SERVICE_USER for HOME, and
    # DATA_DIR:USER_HOME[:/opt/projects] for ReadWritePaths.
    if [ "$V_USER_HOME_CUSTOMIZED" = "1" ]; then
      printf "SUPERMUX_USER_HOME=%s\n" "$V_USER_HOME"
    fi
    printf "SUPERMUX_DATA_DIR=%s\n" "$V_DATA_DIR"
    # Where agents do their work. deploy.sh provisions these (creates them,
    # chowns external ones to the service user) and folds them into
    # ReadWritePaths so the systemd sandbox permits the writes.
    printf "SUPERMUX_PROJECT_DIRS=%s\n" "$V_PROJECT_DIRS"
    if [ "$V_READ_WRITE_PATHS_CUSTOMIZED" = "1" ]; then
      printf "SUPERMUX_READ_WRITE_PATHS=%s\n" "$V_READ_WRITE_PATHS"
    fi
    printf "SUPERMUX_INTERNAL_PORT=%s\n" "$V_INTERNAL_PORT"
    printf "SUPERMUX_PUBLIC_PORT=%s\n" "$V_PUBLIC_PORT"
    printf "SUPERMUX_USE_TAILSCALE=%s\n" "$V_USE_TAILSCALE"
    printf "SUPERMUX_REMOTE_DIR=%s\n" "$V_REMOTE_DIR"
    printf "SUPERMUX_DEPLOY_REF=%s\n" "$V_DEPLOY_REF"
    # NOTE: the var is SUPERMUX_INSTALL_TOOLCHAINS (plural, no AUTO_ prefix)
    # — must match what deploy.sh reads. .env.example documents it the same.
    if [ "$V_AUTO_INSTALL" = "1" ]; then
      printf "SUPERMUX_INSTALL_TOOLCHAINS=1\n"
    else
      printf "SUPERMUX_INSTALL_TOOLCHAINS=0\n"
    fi
  } > "$ENV_TMP"
  chmod 600 "$ENV_TMP" 2>/dev/null || true
  mv "$ENV_TMP" "$ENV_FILE"
  ENV_TMP=""
  ok ".env written to $ENV_FILE"
}

# ---------------------------------------------------------------------------
# Offer to run deploy.sh
# ---------------------------------------------------------------------------

offer_deploy() {
  printf "\n"
  printf "%snext: %sbash scripts/deploy.sh%s\n" "$c_bold" "$c_cyan" "$c_reset"
  if [ "$NONINTERACTIVE" = "1" ]; then
    return 0
  fi
  ask_yn "run deploy.sh now?" "N"
  if [ "$ANS" = "y" ]; then
    ok "handing off to deploy.sh."
    exec bash "$SCRIPT_DIR/deploy.sh"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  print_banner
  handle_existing_env

  if [ "$DISPOSITION" = "keep" ]; then
    ok "keeping existing .env unchanged."
    printf "\n"
    printf "%snext: %sbash scripts/deploy.sh%s\n" "$c_bold" "$c_cyan" "$c_reset"
    exit 0
  fi

  derive_defaults_from_existing

  step_host
  step_user
  step_project_dirs
  step_ports
  step_tailscale
  step_advanced
  step_toolchain
  step_summary_and_confirm
  write_env
  offer_deploy
  printf "\n"
  ok "all set."
}

main "$@"
