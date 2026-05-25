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
# WHY IT IS SAFE (no bricking):
#   - We build FIRST (scripts/build.sh). If the build fails, nothing is touched
#     and the running service keeps running the OLD binary.
#   - The privileged install+restart is done by a SINGLE root-owned helper
#     (/usr/local/sbin/supermux-deploy-self) invoked via a tightly-scoped
#     sudoers rule. That helper:
#       * backs up the current /usr/local/bin/supermux-server,
#       * installs the freshly-built binary,
#       * `systemctl restart supermux`,
#       * verifies `systemctl is-active` + the loopback /api/health,
#       * and ROLLS BACK to the backed-up binary (and restarts) if the new one
#         fails to come up — so a bad build can never leave prod down.
#   - The supermux service uses KillMode=process + a persistent TMUX_TMPDIR in
#     its data dir, so the tmux sessions (including THIS one) survive the
#     restart. You run deploy-self, the service blips, and your terminal is
#     still here.
#
# PRIVILEGE MODEL (least privilege):
#   The service user has NO general sudo. The ONLY thing it may run as root is
#   the fixed helper path, granted by /etc/sudoers.d/supermux-deploy-self:
#     supermux ALL=(root) NOPASSWD: /usr/local/sbin/supermux-deploy-self
#   The helper hardcodes its source (this clone's release binary) and
#   destination, so the grant cannot be repurposed to install arbitrary files
#   or restart arbitrary units. See etc/supermux-deploy-self and
#   etc/sudoers.d/supermux-deploy-self (install instructions in the header
#   there). A one-time root setup wires these; after that this script is
#   self-contained.
#
# USAGE:   cd /opt/projects/supermux && scripts/deploy-self.sh
#   Env:
#     SUPERMUX_SELF_HELPER   path to the privileged helper
#                            (default: /usr/local/sbin/supermux-deploy-self)
#     SUPERMUX_SELF_NO_PULL  set 1 to skip the `git pull` (default: pull --ff-only)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HELPER="${SUPERMUX_SELF_HELPER:-/usr/local/sbin/supermux-deploy-self}"
BIN_REL="server/target/release/supermux-server"

log() { printf '[deploy-self] %s\n' "$*"; }
die() { printf '[deploy-self] error: %s\n' "$*" >&2; exit 1; }

# ── 0. sanity: we are in a real clone, the helper exists, sudo is wired ───────
[ -d .git ] || die "must run from a git CLONE of supermux (no .git here: $ROOT).
  Clone it into a project dir the service can read+write, e.g.:
    git clone https://github.com/sanderbz/supermux.git /opt/projects/supermux"

[ -x "$HELPER" ] || die "privileged helper not found/executable: $HELPER
  One-time root setup is required (see etc/supermux-deploy-self header):
    sudo install -m 0755 -o root -g root etc/supermux-deploy-self $HELPER
    sudo install -m 0440 -o root -g root etc/sudoers.d/supermux-deploy-self \\
         /etc/sudoers.d/supermux-deploy-self"

# Confirm the NOPASSWD grant is live BEFORE we spend minutes building.
if ! sudo -n "$HELPER" --check >/dev/null 2>&1; then
  die "cannot run '$HELPER' via passwordless sudo.
  The sudoers rule is missing or wrong. As root:
    sudo install -m 0440 -o root -g root etc/sudoers.d/supermux-deploy-self \\
         /etc/sudoers.d/supermux-deploy-self
    sudo visudo -cf /etc/sudoers.d/supermux-deploy-self   # validate"
fi

GIT_SHA="$(git rev-parse HEAD)"
GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
log "clone : $ROOT"
log "branch: $GIT_BRANCH @ ${GIT_SHA:0:12}"

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

# ── 2. build in place (build.sh fails the whole script on any error) ──────────
# build.sh sources ~/.cargo/env and prepends ~/.bun/bin — so cargo+bun resolve
# even on this non-login invocation.
log "building (scripts/build.sh) — the running service is untouched until this succeeds"
bash scripts/build.sh

[ -f "$BIN_REL" ] || die "build reported success but '$BIN_REL' is missing"
log "built binary: $BIN_REL ($(du -h "$BIN_REL" | cut -f1))"

# ── 3. privileged install + restart + verify + rollback (root helper) ─────────
# Everything that needs root is INSIDE the helper. We pass the absolute path of
# the freshly-built binary and the deployed SHA; the helper validates them.
log "installing + restarting via $HELPER (sudo, scoped)"
sudo -n "$HELPER" --binary "$ROOT/$BIN_REL" --sha "$GIT_SHA"

log "done — supermux redeployed from this clone at ${GIT_SHA:0:12} and is active."
log "this tmux session survived the restart (KillMode=process + persistent TMUX_TMPDIR)."
