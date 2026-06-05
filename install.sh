#!/usr/bin/env bash
# install.sh — one-line install for supermux on a Linux VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/sanderbz/supermux/main/install.sh | sudo bash
#
# Downloads the prebuilt binary for your arch from the latest GitHub Release,
# provisions an unprivileged `supermux` service user, installs the systemd
# unit + path-unit + self-deploy runner (so 1-click in-UI updates keep
# working after this), starts the service, prints the URL.
#
# Supported: Ubuntu 22.04+ / Debian 12+ on x86_64 + aarch64 (glibc). Other
# distros fall back to a clear "unsupported" message — no surprises.
#
# Env vars (all optional, smart defaults):
#   SUPERMUX_VERSION         — pin a release tag (default: latest)
#   SUPERMUX_INTERNAL_PORT   — loopback HTTP port (default: 8824)
#   SUPERMUX_PROJECT_DIRS    — `:`-joined list of dirs agents may write to
#                              (default: $USER_HOME/projects)
#   SUPERMUX_INSTALL_CLAUDE  — `ask` | `1` | `0` (default: ask)
#   SUPERMUX_USE_TAILSCALE   — `1` | `0` (default: auto-detect tailscaled)
#   SUPERMUX_NO_START        — don't restart the service after install
#   SUPERMUX_TARBALL_FROM    — local tarball path (TEST ONLY — skips download)
#
# Flags:
#   --dry-run                — print the plan, change nothing
#   --version <tag>          — pin a release tag (same as SUPERMUX_VERSION)
#   --no-start               — install but don't enable + restart
#   --help                   — show this header
#
# Re-running is safe: an existing install is upgraded in place, the data
# directory + config are preserved, sessions survive the restart (KillMode=
# process + persistent TMUX_TMPDIR).

set -euo pipefail

# ── constants ────────────────────────────────────────────────────────────────

REPO_OWNER="sanderbz"
REPO_NAME="supermux"
RELEASES_BASE="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases"
RAW_BASE="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}"

# Optional Authorization header for the GitHub fetches. The public-repo case
# leaves this empty (no auth needed). Private repos / forks behind a private
# fork can export `SUPERMUX_GITHUB_TOKEN=ghp_…` so the same one-liner works
# without a public release. Same env var the in-app updater honours.
GH_AUTH_HEADER=()
if [ -n "${SUPERMUX_GITHUB_TOKEN:-}" ]; then
  GH_AUTH_HEADER=(-H "Authorization: Bearer ${SUPERMUX_GITHUB_TOKEN}")
fi

SUPERMUX_USER="supermux"
SUPERMUX_BIN="/usr/local/bin/supermux-server"
SUPERMUX_RUNNER="/usr/local/sbin/supermux-deploy-runner"
SUPERMUX_SHARE="/usr/local/share/supermux"
SUPERMUX_VERSION_FILE="${SUPERMUX_SHARE}/installed-version"
UNIT_DIR="/etc/systemd/system"
HEALTH_PATH="/api/health"

# ── tty colour helpers (only when stderr is a tty) ───────────────────────────

if [ -t 2 ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_OK=$'\033[32m'
  C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_RST=$'\033[0m'
else
  C_BOLD=; C_DIM=; C_OK=; C_WARN=; C_ERR=; C_RST=
fi

log()  { printf '%s[supermux]%s %s\n' "$C_BOLD" "$C_RST" "$*" >&2; }
ok()   { printf '%s[ok]%s       %s\n' "$C_OK" "$C_RST" "$*" >&2; }
warn() { printf '%s[warn]%s     %s\n' "$C_WARN" "$C_RST" "$*" >&2; }
die()  { printf '%s[error]%s    %s\n' "$C_ERR" "$C_RST" "$*" >&2; exit 1; }

run() {
  # Honour --dry-run: log the command but skip execution.
  if [ "${DRY_RUN:-0}" = "1" ]; then
    printf '%s[dry]%s      %s\n' "$C_DIM" "$C_RST" "$*" >&2
    return 0
  fi
  "$@"
}

# ── arg parsing ──────────────────────────────────────────────────────────────

DRY_RUN=0
VERSION="${SUPERMUX_VERSION:-}"
NO_START="${SUPERMUX_NO_START:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)         DRY_RUN=1 ;;
    --version)         VERSION="${2:?--version needs a value}"; shift ;;
    --version=*)       VERSION="${1#--version=}" ;;
    --no-start)        NO_START=1 ;;
    --help|-h)
      # When invoked via `curl … | sudo bash`, `$0` is `bash` — there is no
      # file to read. Print an embedded summary instead. When run as a real
      # file the comment header at the top of this script is the canonical
      # docs; honour that for `bash install.sh --help` callers.
      if [ -f "$0" ] && [ -r "$0" ]; then
        sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      else
        cat <<'HELP'
supermux installer — usage:
  curl -fsSL https://raw.githubusercontent.com/sanderbz/supermux/main/install.sh | sudo bash

Flags:
  --dry-run         print the plan, change nothing
  --version <tag>   pin a release (default: latest)
  --no-start        install but don't enable + restart
  --help            this message

Env vars:
  SUPERMUX_VERSION         pin a tag
  SUPERMUX_INTERNAL_PORT   loopback port (default 8824)
  SUPERMUX_PROJECT_DIRS    `:`-joined dirs (default $HOME/projects)
  SUPERMUX_USE_TAILSCALE   1 | 0 (default: auto-detect)
  SUPERMUX_INSTALL_CLAUDE  ask | 1 | 0 (default: ask)
  SUPERMUX_GITHUB_TOKEN    needed only for private repos / forks
HELP
      fi
      exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

INTERNAL_PORT="${SUPERMUX_INTERNAL_PORT:-8824}"

# ── preflight ────────────────────────────────────────────────────────────────

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "must run as root. retry with: curl -fsSL ${RAW_BASE}/main/install.sh | sudo bash"
  fi
}

os_field() {
  # Extract a single field from /etc/os-release without sourcing it — sourcing
  # would clobber callers' env (e.g. our own `VERSION` for the pinned release
  # gets overwritten by os-release's `VERSION=...` line).
  awk -F= -v k="$1" '$1 == k { gsub(/^"|"$/, "", $2); print $2; exit }' /etc/os-release
}

detect_os() {
  [ "$(uname -s)" = "Linux" ] || die "only Linux is supported (got $(uname -s))."
  [ -r /etc/os-release ] || die "/etc/os-release missing; cannot identify distro."
  local id id_like pretty vid
  id="$(os_field ID)"; id_like="$(os_field ID_LIKE)"
  pretty="$(os_field PRETTY_NAME)"; vid="$(os_field VERSION_ID)"
  case "${id}:${id_like}" in
    ubuntu:*|debian:*|*:debian*|*:ubuntu*) : ;;
    *) die "unsupported distro: ${pretty:-$id}. Ubuntu 22.04+ or Debian 12+ only." ;;
  esac
  case "$id" in
    ubuntu) awk -v v="${vid:-0}" 'BEGIN{exit !(v+0 >= 22)}' || die "Ubuntu $vid is too old; need 22.04+." ;;
    debian) awk -v v="${vid:-0}" 'BEGIN{exit !(v+0 >= 12)}' || die "Debian $vid is too old; need 12+." ;;
    *) : ;;  # ID_LIKE family — best effort
  esac
  ok "host: ${pretty:-$id $vid}"
}

detect_arch() {
  local m
  m="$(uname -m)"
  case "$m" in
    x86_64|amd64)  ARCH_TARGET="x86_64-unknown-linux-gnu";  ARCH_LABEL="x86_64" ;;
    aarch64|arm64) ARCH_TARGET="aarch64-unknown-linux-gnu"; ARCH_LABEL="aarch64" ;;
    *) die "unsupported CPU architecture: $m (need x86_64 or aarch64)." ;;
  esac
  ok "arch: ${ARCH_LABEL}"
}

require_systemd() {
  command -v systemctl >/dev/null 2>&1 || die "systemd not found (no systemctl). supermux needs systemd."
  [ -d /run/systemd/system ] || die "systemd is not the active init (no /run/systemd/system). PID 1 must be systemd."
  ok "systemd: ok"
}

require_curl() {
  command -v curl >/dev/null 2>&1 || die "curl is required. install with: apt-get install -y curl"
}

require_tmux() {
  if command -v tmux >/dev/null 2>&1; then
    ok "tmux: $(tmux -V)"
    return 0
  fi
  if [ "${DRY_RUN:-0}" = "1" ]; then
    # Dry-run: `run apt-get install` would skip; don't enforce the post-check.
    printf '%s[dry]%s      tmux missing — would install via apt\n' "$C_DIM" "$C_RST" >&2
    return 0
  fi
  log "tmux missing — installing via apt..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq tmux
  command -v tmux >/dev/null 2>&1 || die "tmux install failed."
  ok "tmux installed: $(tmux -V)"
}

port_busy() {
  # Returns 0 (true) when SOMETHING is listening on $INTERNAL_PORT, 1 (false)
  # otherwise. Anchor the awk pattern with `==` on the listen-address column
  # rather than a shell-escaped regex tail (`\$` in a double-quoted string is
  # literal, not the end-of-line anchor it was meant to be).
  if command -v ss >/dev/null 2>&1; then
    ss -lntH "( sport = :${INTERNAL_PORT} )" 2>/dev/null | grep -q .
  elif command -v netstat >/dev/null 2>&1; then
    netstat -lntp 2>/dev/null \
      | awk -v p=":${INTERNAL_PORT}" '{ split($4, a, ":"); if (a[length(a)] == p+0) found=1 } END { exit !found }'
  else
    return 1  # can't tell → assume free; install attempts and surfaces the conflict at start
  fi
}

preflight_port() {
  # Existing supermux install on this port is fine — we'll restart it. Only
  # bail when a DIFFERENT process holds the port.
  if port_busy; then
    if systemctl is-active --quiet supermux 2>/dev/null; then
      ok "port ${INTERNAL_PORT}: held by existing supermux service (will upgrade)"
    else
      die "port ${INTERNAL_PORT} is in use by another process. Free it or set SUPERMUX_INTERNAL_PORT."
    fi
  else
    ok "port ${INTERNAL_PORT}: free"
  fi
}

# ── version resolution ──────────────────────────────────────────────────────

resolve_version() {
  if [ -n "$VERSION" ]; then
    case "$VERSION" in v*) : ;; *) VERSION="v${VERSION}" ;; esac
    ok "version: ${VERSION} (pinned)"
    return 0
  fi
  if [ -n "${SUPERMUX_TARBALL_FROM:-}" ]; then
    # Local-tarball test mode: read the version label out of the tarball
    # itself so we don't make a network call (and so we don't fail on
    # private repos where /releases/latest 404s without a token). The
    # tarball ships a top-level VERSION file by convention.
    local tv
    tv="$(tar -xzOf "$SUPERMUX_TARBALL_FROM" ./VERSION 2>/dev/null | head -1 | tr -d '\r\n')"
    [ -n "$tv" ] || die "SUPERMUX_TARBALL_FROM tarball has no VERSION file."
    VERSION="$tv"
    ok "version: ${VERSION} (from local tarball)"
    return 0
  fi
  log "resolving latest release..."
  # GitHub redirects /releases/latest → /releases/tag/<tag>. Pull the tag
  # from the Location header — no API call, no jq. Private repos / forks
  # need SUPERMUX_GITHUB_TOKEN; the public-repo case sends no auth header.
  local loc
  loc="$(curl -fsS --proto '=https' --tlsv1.2 -o /dev/null -w '%{redirect_url}' \
         "${GH_AUTH_HEADER[@]}" "${RELEASES_BASE}/latest" || true)"
  VERSION="${loc##*/}"
  [ -n "$VERSION" ] || die "could not resolve latest release tag. Private repo? Set SUPERMUX_GITHUB_TOKEN."
  case "$VERSION" in v*) : ;; *) die "unexpected tag format: ${VERSION}" ;; esac
  ok "version: ${VERSION} (latest)"
}

# ── existing-install detection ──────────────────────────────────────────────

current_version() {
  # The installer writes the version tag to a marker file beside the binary on
  # every successful install — we read it back to decide upgrade vs noop.
  # NOT derived from `supermux-server --version`: that flag doesn't exist on
  # the server binary (it would start the service instead).
  if [ -r "$SUPERMUX_VERSION_FILE" ]; then
    head -1 "$SUPERMUX_VERSION_FILE"
  elif [ -x "$SUPERMUX_BIN" ]; then
    # Binary exists but no marker — older install (pre-installer) or
    # tampered. Treat as unknown so we upgrade safely.
    printf 'unknown\n'
  else
    printf 'none\n'
  fi
}

# ── tarball download + verify ───────────────────────────────────────────────

fetch_tarball() {
  if [ -n "${SUPERMUX_TARBALL_FROM:-}" ]; then
    [ -r "$SUPERMUX_TARBALL_FROM" ] || die "SUPERMUX_TARBALL_FROM=${SUPERMUX_TARBALL_FROM} not readable."
    TARBALL="$SUPERMUX_TARBALL_FROM"
    warn "using local tarball: ${TARBALL} (SKIPPING checksum verification)"
    return 0
  fi
  local name url sums_url stage
  name="supermux-${ARCH_TARGET}.tar.gz"
  url="${RELEASES_BASE}/download/${VERSION}/${name}"
  sums_url="${RELEASES_BASE}/download/${VERSION}/checksums.txt"
  stage="$(mktemp -d -t supermux-install.XXXXXX)"
  TARBALL="${stage}/${name}"

  log "downloading ${name}..."
  curl -fSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 \
       "${GH_AUTH_HEADER[@]}" \
       -o "$TARBALL" "$url" \
    || die "download failed: ${url}"

  log "downloading checksums.txt..."
  curl -fSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 \
       "${GH_AUTH_HEADER[@]}" \
       -o "${stage}/checksums.txt" "$sums_url" \
    || die "download failed: ${sums_url}"

  log "verifying sha256..."
  # checksums.txt has one entry per asset: `<sha>  <name>`. Anchor with awk
  # (regex-safe: `==` exact match on the filename column, no backslash-escape
  # surprises in BRE — the earlier `grep "  …\$"` form silently matched zero
  # lines because `\$` in a double-quoted string is literal `\$`, not the
  # end-of-line anchor it was meant to be).
  ( cd "$stage" \
    && awk -v n="$name" '$2 == n' checksums.txt | sha256sum -c - ) \
    || die "sha256 verification FAILED for ${name}. Refusing to install."
  ok "checksum verified"
}

extract_tarball() {
  EXTRACT_DIR="$(mktemp -d -t supermux-extract.XXXXXX)"
  log "extracting..."
  tar -xzf "$TARBALL" -C "$EXTRACT_DIR"
  [ -x "${EXTRACT_DIR}/supermux-server" ] \
    || die "tarball is malformed: supermux-server binary missing or not executable."
  [ -d "${EXTRACT_DIR}/etc" ] \
    || die "tarball is malformed: etc/ templates missing."
  ok "extracted to ${EXTRACT_DIR}"
}

# ── user + dirs ──────────────────────────────────────────────────────────────

ensure_user() {
  if id "$SUPERMUX_USER" >/dev/null 2>&1; then
    ok "service user: ${SUPERMUX_USER} (already exists)"
    USER_HOME="$(getent passwd "$SUPERMUX_USER" | awk -F: '{print $6}')"
    [ -n "$USER_HOME" ] && [ -d "$USER_HOME" ] \
      || die "could not resolve home directory for ${SUPERMUX_USER}."
  else
    if [ "${DRY_RUN:-0}" = "1" ]; then
      # Dry-run: useradd is skipped (wrapped in `run`), so getent would
      # return empty and break every downstream step. Predict the home
      # `useradd --create-home` would land on (matches Debian/Ubuntu
      # defaults: /home/<name>) so the rest of the dry-run can produce
      # a meaningful plan.
      USER_HOME="/home/${SUPERMUX_USER}"
      printf '%s[dry]%s      would create service user %s with home %s\n' \
        "$C_DIM" "$C_RST" "$SUPERMUX_USER" "$USER_HOME" >&2
    else
      log "creating service user '${SUPERMUX_USER}'..."
      useradd --create-home --shell /bin/bash --comment "supermux service user" "$SUPERMUX_USER"
      USER_HOME="$(getent passwd "$SUPERMUX_USER" | awk -F: '{print $6}')"
      [ -n "$USER_HOME" ] && [ -d "$USER_HOME" ] \
        || die "could not resolve home directory for ${SUPERMUX_USER} after useradd."
      ok "service user: ${SUPERMUX_USER} (created)"
    fi
  fi
  DATA_DIR="${USER_HOME}/.supermux"
  PROJECTS_RAW="${SUPERMUX_PROJECT_DIRS:-${USER_HOME}/projects}"
}

ensure_dirs() {
  local IFS=':'
  local d
  log "ensuring data dir + project dirs..."
  run install -d -m 0700 -o "$SUPERMUX_USER" -g "$SUPERMUX_USER" "$DATA_DIR"
  run install -d -m 0775 -o "$SUPERMUX_USER" -g "$SUPERMUX_USER" "${DATA_DIR}/deploy"
  for d in $PROJECTS_RAW; do
    [ -n "$d" ] || continue
    if [ -d "$d" ]; then
      run chown -R "${SUPERMUX_USER}:${SUPERMUX_USER}" "$d"
    else
      run install -d -m 0755 -o "$SUPERMUX_USER" -g "$SUPERMUX_USER" "$d"
    fi
  done

  # Write config.toml with the configured bind address. Only when absent so
  # re-runs don't rotate the auth token (server seeds it on first launch only
  # if no token file exists). Without this file supermux-server falls back to
  # its built-in default (127.0.0.1:8823), the unit then can't be reached on
  # our configured port, and health-check times out — same shape as the
  # CI-matrix "did not become healthy" failure.
  local cfg="${DATA_DIR}/config.toml"
  if [ ! -f "$cfg" ] && [ "${DRY_RUN:-0}" != "1" ]; then
    printf 'bind = "127.0.0.1:%s"\n' "$INTERNAL_PORT" > "$cfg"
    chown "${SUPERMUX_USER}:${SUPERMUX_USER}" "$cfg"
    chmod 0600 "$cfg"
    ok "wrote ${cfg} (bind 127.0.0.1:${INTERNAL_PORT})"
  elif [ "${DRY_RUN:-0}" = "1" ] && [ ! -f "$cfg" ]; then
    printf '%s[dry]%s      write %s ← bind = "127.0.0.1:%s"\n' \
      "$C_DIM" "$C_RST" "$cfg" "$INTERNAL_PORT" >&2
  else
    ok "config: ${cfg} (preserved)"
  fi

  ok "data dir: ${DATA_DIR}"
  ok "project dirs: ${PROJECTS_RAW}"
}

# ── render templates ────────────────────────────────────────────────────────

# Build the two placeholder values for the systemd unit. systemd accepts
# whitespace-separated paths on a single directive line — matches what
# `deploy.sh` writes and keeps comment-block references readable.
#
# The two placeholders have asymmetric conventions in the template:
#   __READ_WRITE_PATHS__  appears as the VALUE of an existing
#                         `ReadWritePaths=` directive → emit paths only.
#   __BIND_PATHS__        replaces a WHOLE LINE → emit the full
#                         `BindPaths=...` directive.
build_paths() {
  local IFS=':' paths
  paths="$DATA_DIR $USER_HOME"
  local d
  for d in $PROJECTS_RAW; do
    [ -n "$d" ] || continue
    paths+=" $d"
  done
  RWP="$paths"
  # __BIND_PATHS__ replaces a whole line — must stay single-line so it
  # doesn't split comment blocks elsewhere in the template. systemd accepts
  # space-separated paths on a single BindPaths= directive.
  local bp_list="$USER_HOME"
  for d in $PROJECTS_RAW; do
    [ -n "$d" ] || continue
    bp_list+=" $d"
  done
  BP="BindPaths=$bp_list"
}

# Pick the FIRST project dir as the "projects root" the deploy-runner uses to
# locate the supermux clone for self-deploys. (Same convention as deploy.sh.)
projects_root() {
  printf '%s' "$PROJECTS_RAW" | cut -d: -f1
}

substitute() {
  # $1 = template path, $2 = output path. Replaces __PLACEHOLDERS__ with the
  # corresponding shell variables; refuses to write if any __FOO__ slips
  # through (would silently break the unit at runtime).
  local in="$1" out="$2" tmp
  tmp="$(mktemp)"
  PROJECTS_ROOT="$(projects_root)"
  DEPLOY_REQUEST="${DATA_DIR}/deploy/request"
  REMOTE_DIR="$PROJECTS_ROOT/supermux"  # convention; used by self-deploy
  UNIT_NAME="supermux.service"
  # supermux.service-specific extras
  PUSH_SUB_LINE=""
  [ -n "${SUPERMUX_PUSH_SUB:-}" ] && PUSH_SUB_LINE="Environment=SUPERMUX_PUSH_SUB=${SUPERMUX_PUSH_SUB}"
  MEMORY_HIGH="${SUPERMUX_MEMORY_HIGH:-infinity}"
  PROTECT_HOME="tmpfs"
  PRIVATE_TMP="true"
  MEMORY_DENY_WRITE_EXECUTE="false"  # npm/Vite need W^X off; matches deploy.sh default

  sed \
    -e "s|__SERVICE_USER__|${SUPERMUX_USER}|g" \
    -e "s|__USER_HOME__|${USER_HOME}|g" \
    -e "s|__DATA_DIR__|${DATA_DIR}|g" \
    -e "s|__PROJECT_DIRS__|${PROJECTS_RAW}|g" \
    -e "s|__INTERNAL_PORT__|${INTERNAL_PORT}|g" \
    -e "s|__PROTECT_HOME__|${PROTECT_HOME}|g" \
    -e "s|__PRIVATE_TMP__|${PRIVATE_TMP}|g" \
    -e "s|__MEMORY_HIGH__|${MEMORY_HIGH}|g" \
    -e "s|__MEMORY_DENY_WRITE_EXECUTE__|${MEMORY_DENY_WRITE_EXECUTE}|g" \
    -e "s|__PROJECTS_DIR__|${PROJECTS_ROOT}|g" \
    -e "s|__REMOTE_DIR__|${REMOTE_DIR}|g" \
    -e "s|__DEPLOY_REQUEST__|${DEPLOY_REQUEST}|g" \
    -e "s|__UNIT__|${UNIT_NAME}|g" \
    "$in" > "$tmp"
  # Multi-line blocks (RWP / BP / PUSH_SUB_LINE) need a different substitutor
  # because sed's `s|...|...|` doesn't like newlines in the replacement.
  awk -v rwp="$RWP" -v bp="$BP" -v psl="$PUSH_SUB_LINE" '
    { gsub(/__READ_WRITE_PATHS__/, rwp);
      gsub(/__BIND_PATHS__/,       bp);
      gsub(/__PUSH_SUB_LINE__/,    psl);
      print }
  ' "$tmp" > "$out"
  rm -f "$tmp"

  if grep -q '__[A-Z_]\+__' "$out"; then
    grep -o '__[A-Z_]\+__' "$out" | sort -u >&2
    die "rendered template still has unsubstituted placeholders (above) — installer bug."
  fi
}

render_units() {
  log "rendering systemd units..."
  build_paths
  RENDER_DIR="$(mktemp -d -t supermux-render.XXXXXX)"
  local etc="${EXTRACT_DIR}/etc"
  substitute "${etc}/systemd/supermux.service"        "${RENDER_DIR}/supermux.service"
  substitute "${etc}/systemd/supermux-deploy.path"    "${RENDER_DIR}/supermux-deploy.path"
  substitute "${etc}/systemd/supermux-deploy.service" "${RENDER_DIR}/supermux-deploy.service"
  substitute "${etc}/supermux-deploy-runner"          "${RENDER_DIR}/supermux-deploy-runner"
  ok "units rendered"
}

# ── install ──────────────────────────────────────────────────────────────────

install_binary() {
  log "installing binary → ${SUPERMUX_BIN}"
  # Atomic-ish: write next to dest, mv. Backup the existing binary so the
  # path-unit's rollback path keeps working on subsequent self-deploys.
  if [ -x "$SUPERMUX_BIN" ]; then
    run cp -p "$SUPERMUX_BIN" "${SUPERMUX_BIN}.prev"
  fi
  run install -m 0755 -o root -g root "${EXTRACT_DIR}/supermux-server" "${SUPERMUX_BIN}.new"
  run mv -f "${SUPERMUX_BIN}.new" "$SUPERMUX_BIN"
}

# Commit the version marker. Called AFTER `verify_health` succeeds — if the
# service fails to come up we leave the previous version recorded so a re-run
# correctly retries the install instead of short-circuiting to noop.
stamp_version() {
  run install -d -m 0755 -o root -g root "$SUPERMUX_SHARE"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    printf '%s[dry]%s      write %s ← %s\n' "$C_DIM" "$C_RST" "$SUPERMUX_VERSION_FILE" "$VERSION" >&2
  else
    printf '%s\n' "$VERSION" > "$SUPERMUX_VERSION_FILE"
    chmod 0644 "$SUPERMUX_VERSION_FILE"
  fi
}

install_units() {
  log "installing systemd units → ${UNIT_DIR}"
  run install -m 0644 -o root -g root "${RENDER_DIR}/supermux.service"        "${UNIT_DIR}/supermux.service"
  run install -m 0644 -o root -g root "${RENDER_DIR}/supermux-deploy.path"    "${UNIT_DIR}/supermux-deploy.path"
  run install -m 0644 -o root -g root "${RENDER_DIR}/supermux-deploy.service" "${UNIT_DIR}/supermux-deploy.service"
  run install -m 0755 -o root -g root "${RENDER_DIR}/supermux-deploy-runner"  "$SUPERMUX_RUNNER"
}

start_service() {
  if [ "$NO_START" = "1" ]; then
    warn "--no-start set: NOT enabling or restarting the service."
    return 0
  fi
  log "daemon-reload + enable + restart..."
  run systemctl daemon-reload
  run systemctl enable supermux.service
  run systemctl restart supermux.service
  run systemctl enable --now supermux-deploy.path
}

verify_health() {
  if [ "$NO_START" = "1" ]; then
    return 0
  fi
  log "verifying health on http://127.0.0.1:${INTERNAL_PORT}${HEALTH_PATH} ..."
  local i=0
  while [ $i -lt 60 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:${INTERNAL_PORT}${HEALTH_PATH}" >/dev/null 2>&1; then
      ok "service is healthy"
      return 0
    fi
    sleep 0.5; i=$((i+1))
  done
  log "health check timed out; last 30 lines of journal:"
  run journalctl -u supermux -n 30 --no-pager >&2 || true
  die "supermux did not become healthy within 30s. Check 'journalctl -u supermux'."
}

# ── Tailscale + Claude (optional, mirrors deploy.sh) ────────────────────────

maybe_tailscale() {
  local want="${SUPERMUX_USE_TAILSCALE:-}"
  if [ -z "$want" ]; then
    if command -v tailscale >/dev/null 2>&1 && systemctl is-active --quiet tailscaled 2>/dev/null; then
      want=1
    else
      want=0
    fi
  fi
  [ "$want" = "1" ] || { ok "Tailscale: skipped (not detected / disabled)"; return 0; }

  log "Tailscale detected — exposing supermux via 'tailscale serve' ..."
  local public_port="${SUPERMUX_PUBLIC_PORT:-443}"
  run tailscale serve --bg --https="$public_port" "http://localhost:${INTERNAL_PORT}" \
    || warn "tailscale serve failed — fix with: tailscale up && tailscale set --hostname=supermux"

  local host
  host="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 | sed 's/\.$//')"
  if [ -n "$host" ]; then
    TAILSCALE_URL="https://${host}/"
    ok "Tailscale URL: ${TAILSCALE_URL}"
  fi
}

maybe_claude() {
  if sudo -u "$SUPERMUX_USER" -H bash -lc 'command -v claude >/dev/null 2>&1'; then
    ok "Claude Code: already installed for ${SUPERMUX_USER}"
    return 0
  fi
  local mode="${SUPERMUX_INSTALL_CLAUDE:-ask}"
  if [ "$mode" = "0" ]; then
    warn "Claude Code not installed (SUPERMUX_INSTALL_CLAUDE=0). Sessions will fail to start until you install it."
    return 0
  fi
  if [ "$mode" = "ask" ] && [ -t 0 ]; then
    printf '%sInstall Claude Code now for %s? [Y/n] %s' "$C_BOLD" "$SUPERMUX_USER" "$C_RST" >&2
    # `local ans=""` (not `local ans`) — `set -u` would otherwise fire on the
    # `case "$ans"` if the user hits Ctrl-D and `read` returns with `ans`
    # never initialised.
    local ans=""
    read -r ans || true
    case "$ans" in n|N|no|NO) mode=0 ;; *) mode=1 ;; esac
  elif [ "$mode" = "ask" ]; then
    mode=0  # non-interactive: don't auto-install
  fi
  if [ "$mode" = "1" ]; then
    log "installing Claude Code for ${SUPERMUX_USER} (official native installer)..."
    run sudo -u "$SUPERMUX_USER" -H bash -lc \
      'curl -fsSL https://claude.ai/install.sh | bash' \
      || warn "Claude installer failed. Install manually: sudo -u ${SUPERMUX_USER} -i bash -c 'curl -fsSL https://claude.ai/install.sh | bash'"
  fi
  warn "after install, log in once with: ${C_BOLD}sudo -u ${SUPERMUX_USER} -i claude${C_RST} → /login"
}

# ── summary ──────────────────────────────────────────────────────────────────

print_summary() {
  echo >&2
  printf '%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$C_BOLD" "$C_RST" >&2
  printf '  %ssupermux %s is running on %s%s\n' "$C_BOLD" "$VERSION" "$(hostname -f 2>/dev/null || hostname)" "$C_RST" >&2
  printf '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' >&2
  if [ -n "${TAILSCALE_URL:-}" ]; then
    printf '\n  %sOpen:%s   %s\n' "$C_BOLD" "$C_RST" "$TAILSCALE_URL" >&2
  else
    printf '\n  %sOpen:%s   http://127.0.0.1:%s\n' "$C_BOLD" "$C_RST" "$INTERNAL_PORT" >&2
    printf '  %sTip:%s    bind to a hostname via tailscale or your own reverse proxy.\n' "$C_DIM" "$C_RST" >&2
  fi
  printf '\n  %sAuth token:%s   sudo cat %s/auth_token\n' "$C_BOLD" "$C_RST" "$DATA_DIR" >&2
  printf '  %sLogs:%s         sudo journalctl -u supermux -f\n' "$C_BOLD" "$C_RST" >&2
  printf '  %sService:%s      sudo systemctl status supermux\n' "$C_BOLD" "$C_RST" >&2
  echo >&2
}

# ── upgrade-or-fresh control flow ───────────────────────────────────────────

decide_action() {
  CUR="$(current_version)"
  case "$CUR" in
    none)
      log "fresh install: ${VERSION}"
      ACTION="fresh" ;;
    "$VERSION")
      ok "already at ${VERSION}; nothing to do."
      ACTION="noop" ;;
    *)
      log "upgrading: ${CUR} → ${VERSION}"
      ACTION="upgrade" ;;
  esac
}

# ── cleanup ──────────────────────────────────────────────────────────────────

cleanup() {
  # Best-effort cleanup of temp dirs; never block exit.
  [ -n "${RENDER_DIR:-}" ] && [ -d "$RENDER_DIR" ] && rm -rf "$RENDER_DIR" 2>/dev/null || true
  [ -n "${EXTRACT_DIR:-}" ] && [ -d "$EXTRACT_DIR" ] && rm -rf "$EXTRACT_DIR" 2>/dev/null || true
  if [ -z "${SUPERMUX_TARBALL_FROM:-}" ] && [ -n "${TARBALL:-}" ]; then
    rm -rf "$(dirname "$TARBALL")" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ── main ────────────────────────────────────────────────────────────────────

main() {
  log "supermux installer"

  require_root
  require_curl
  detect_os
  detect_arch
  require_systemd
  require_tmux
  preflight_port

  resolve_version
  decide_action
  [ "$ACTION" = "noop" ] && exit 0

  fetch_tarball
  extract_tarball

  ensure_user
  ensure_dirs
  render_units

  install_binary
  install_units
  start_service
  verify_health
  stamp_version  # AFTER health: a failed start leaves the marker untouched,
                 # so a re-run retries the install instead of short-circuiting.

  maybe_tailscale
  maybe_claude

  print_summary
}

main "$@"
