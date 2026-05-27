#!/usr/bin/env bash
# deploy-self.sh — deploy supermux TO ITSELF, from the box it runs on.
#
# WHO RUNS THIS: the unprivileged supermux SERVICE USER, from inside a real git
# clone of this repo that lives in a project dir the service can read+write
# (e.g. /opt/projects/supermux). The whole point is "develop supermux on the
# server while using supermux there": edit code in the clone, run this, and the
# running service rebuilds from the clone and restarts — coming back online by
# itself, with the tmux session that ran it surviving the restart.
#
# WHY NO SUDO + WHY BUILD-IN-RUNNER (the two bugs this design fixes):
#   The supermux systemd unit is hardened with NoNewPrivileges=true,
#   RestrictSUIDSGID=true, an empty CapabilityBoundingSet, and a
#   SystemCallFilter that drops @privileged — EACH of which independently
#   neuters setuid/sudo. Every child of the service (including THIS tmux
#   session) inherits that, so `sudo` can NEVER run as root from inside
#   supermux ("the 'no new privileges' flag is set"). On TOP of that, the
#   SystemCallFilter blocks `make` from spawning `/bin/sh` (the syscall it
#   uses to fork its recipe shell is denied) — so a vendored-OpenSSL release
#   build from inside this sandbox is also impossible whenever cargo's
#   openssl-sys cache is cold. Relaxing the hardening to permit either would
#   gut the sandbox, so instead we use a systemd PATH-UNIT TRIGGER:
#     - this script atomically WRITES a small request file
#       ($DATA_DIR/deploy/request) carrying `source_dir=<our clone>` — an
#       operation that needs ZERO privilege;
#     - a root-side .path unit (supermux-deploy.path) watches that file and,
#       on change, starts a root oneshot (supermux-deploy.service) that runs
#       /usr/local/sbin/supermux-deploy-runner — which BUILDS the binary as
#       the service user via `runuser` (outside the supermux.service cgroup,
#       so no SystemCallFilter — make + openssl-src work normally), then does
#       backup → install → restart → verify → rollback.
#   This adds NO privilege the agent lacks: the runner builds as the SAME uid
#   the agent already runs as, then replaces the UNPRIVILEGED service binary
#   and restarts the UNPRIVILEGED unit. It just bridges "write file" → "root
#   builds (as service user) + installs + restarts".
#
# WHY IT IS SAFE (no bricking):
#   - The root runner builds first; on build failure, nothing is touched and
#     the running service keeps the OLD binary (the runner exits before any
#     install step).
#   - It then backs up the current binary, installs the new one, restarts,
#     verifies `systemctl is-active` + the loopback /api/health, and
#     ROLLS BACK to the backup (and restarts) if the new one fails to come up —
#     so a bad build can never leave prod down.
#   - The supermux service uses KillMode=process + a persistent TMUX_TMPDIR in
#     its data dir, so the tmux sessions (including THIS one) survive the
#     restart. You run deploy-self, the service blips mid-run, and your terminal
#     is still here. The runner's log file also persists across the restart, so
#     this script can still read the final result afterwards.
#
# ONE-TIME ROOT SETUP IS AUTOMATIC: scripts/deploy.sh installs the runner + the
# two systemd units and enables supermux-deploy.path as part of a normal deploy.
# There is nothing to wire by hand on the host.
#
# USAGE:   cd /opt/projects/supermux && scripts/deploy-self.sh
#   Env:
#     SUPERMUX_DATA_DIR      supermux data dir (default: $HOME/.supermux; the
#                            unit exports this into the agent's environment).
#     SUPERMUX_SELF_NO_PULL  set 1 to skip the `git pull` (default: pull --ff-only)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DATA_DIR="${SUPERMUX_DATA_DIR:-$HOME/.supermux}"
REQ_DIR="$DATA_DIR/deploy"

log() { printf '[deploy-self] %s\n' "$*"; }
die() { printf '[deploy-self] error: %s\n' "$*" >&2; exit 1; }

# ── 0. sanity: we are in a real clone ─────────────────────────────────────────
[ -d .git ] || die "must run from a git CLONE of supermux (no .git here: $ROOT).
  Clone it into a project dir the service can read+write, e.g.:
    git clone https://github.com/sanderbz/supermux.git /opt/projects/supermux"

GIT_SHA="$(git rev-parse HEAD)"
GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
log "clone : $ROOT"
log "branch: $GIT_BRANCH @ ${GIT_SHA:0:12}"
log "data  : $DATA_DIR"

# ── 1. (optional) fast-forward pull so 'deploy what's on the remote' is easy ──
if [ "${SUPERMUX_SELF_NO_PULL:-0}" != "1" ]; then
  if git remote get-url origin >/dev/null 2>&1; then
    log "git pull --ff-only origin $GIT_BRANCH"
    if git pull --ff-only origin "$GIT_BRANCH" 2>&1 | sed 's/^/[deploy-self]   /'; then
      GIT_SHA="$(git rev-parse HEAD)"
      log "after pull: ${GIT_SHA:0:12}"
    else
      log "pull skipped/failed (continuing with local HEAD ${GIT_SHA:0:12})"
    fi
  fi
fi

# ── 2. write the deploy request (zero privilege) → triggers the root runner ──
# The root-side supermux-deploy.path unit watches $REQ_DIR/request; the mv below
# (a rename) fires PathChanged and starts the root oneshot that builds + installs
# + restarts + verifies + rolls back. The BUILD runs there too (as the service
# user via runuser, OUTSIDE the supermux.service sandbox) so the supermux unit's
# SystemCallFilter cannot block vendored-openssl's `make` (the on-server build
# trap before this fix). deploy.sh provisioned $REQ_DIR owned by the service
# user (mode 0775), so this write needs no privilege.
mkdir -p "$REQ_DIR" 2>/dev/null || die "cannot create request dir: $REQ_DIR
  This should have been provisioned by scripts/deploy.sh (install -d ... $REQ_DIR).
  Re-run a full deploy from your workstation, or create+chown it as root."

# Clear the previous run's status/log so we don't read a stale result while
# waiting (best-effort; the runner truncates+recreates them at start anyway).
: > "$REQ_DIR/status" 2>/dev/null || true
: > "$REQ_DIR/log" 2>/dev/null || true

NONCE="$(date +%s%N)"
log "writing deploy request -> $REQ_DIR/request (triggers root runner: build + install + restart)"
printf 'source_dir=%s\nsha=%s\nnonce=%s\n' "$ROOT" "$GIT_SHA" "$NONCE" \
  > "$REQ_DIR/request.tmp" \
  && mv "$REQ_DIR/request.tmp" "$REQ_DIR/request" \
  || die "failed to write deploy request into $REQ_DIR (not writable?)"

# ── 4. wait for + STREAM the runner's progress, then read the final result ────
# The runner truncates $REQ_DIR/log at start and writes a final machine-readable
# `DEPLOY_RESULT=ok|failed` line (plus a one-word $REQ_DIR/status file). We tail
# the log so the user watches backup/install/restart/rollback live, and poll for
# the terminal line. NOTE: supermux restarts mid-run; this script + the tmux
# session survive (KillMode=process + persistent TMUX_TMPDIR), and the log file
# lives in the persistent data dir, so the final result is still readable after.
LOG="$REQ_DIR/log"
STATUS="$REQ_DIR/status"
DEADLINE=$(( $(date +%s) + 180 ))

log "waiting for the root runner (streaming $LOG; up to 180s) …"

# Wait for the runner to (re)create the log after it starts.
while [ ! -s "$LOG" ]; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    die "timed out waiting for the deploy runner to start (no $LOG after 180s).
  Is supermux-deploy.path enabled on this host? Check:
    journalctl -u supermux-deploy -n 50 --no-pager
    systemctl status supermux-deploy.path --no-pager"
  fi
  sleep 1
done

# Stream the log live in the background; stop it once we have a verdict.
tail -n +1 -f "$LOG" 2>/dev/null &
TAIL_PID=$!
cleanup_tail() { kill "$TAIL_PID" 2>/dev/null || true; wait "$TAIL_PID" 2>/dev/null || true; }
trap cleanup_tail EXIT

RESULT=""
while [ -z "$RESULT" ]; do
  # Prefer the explicit final line in the log; fall back to the status file.
  if grep -q '^DEPLOY_RESULT=' "$LOG" 2>/dev/null; then
    RESULT="$(grep '^DEPLOY_RESULT=' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2)"
  elif [ -s "$STATUS" ]; then
    RESULT="$(tr -d '[:space:]' < "$STATUS" 2>/dev/null)"
  fi
  [ -n "$RESULT" ] && break
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then break; fi
  sleep 1
done

cleanup_tail
trap - EXIT

case "$RESULT" in
  ok)
    log "✓ supermux redeployed from this clone at ${GIT_SHA:0:12} and is active + healthy."
    log "  this tmux session survived the restart (KillMode=process + persistent TMUX_TMPDIR)."
    exit 0
    ;;
  failed)
    log "✗ deploy FAILED — the runner rolled back to the previous binary (prod not bricked)."
    log "  inspect: journalctl -u supermux-deploy -n 50 --no-pager   (full log: $LOG)"
    exit 1
    ;;
  *)
    die "no result from the runner after 180s (last seen log: $LOG).
  Inspect: journalctl -u supermux-deploy -n 50 --no-pager
           systemctl status supermux-deploy.service --no-pager"
    ;;
esac
