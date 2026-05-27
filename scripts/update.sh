#!/usr/bin/env bash
# update.sh — pull origin/main + redeploy supermux on the local host (v0.3.0).
#
# WHO RUNS THIS:
#   * The in-UI "Update now" button (via the supermux-deploy.path systemd
#     trigger — same pipeline as scripts/deploy-self.sh).
#   * Operators by hand on a bare-binary or dev install:
#       cd <supermux-clone> && bash scripts/update.sh
#
# WHAT IT DOES:
#   1. Fetch origin/main, verify the working tree is clean, fast-forward to
#      origin/main (HARD requirement: refuses to clobber local commits or
#      uncommitted changes — those are surfaced by the preflight upstream).
#   2. Hand off to scripts/deploy-self.sh, which writes the deploy request
#      that the root-side runner picks up. The runner builds + installs +
#      restarts + verifies + auto-rolls-back on failure.
#
# WHY STRUCTURED LOG LINES:
#   The supermux server's `updates::exec` tail subscribes to the runner log
#   (which captures our stdout). Each phase emits `[update] step=<name>` so
#   the SSE progress endpoint can re-emit clean step events without trying
#   to parse cargo / bun chatter. UI-facing copy ships in `msg=`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() {
  # `[update] step=<name> msg="<text>"` — consumed by the SSE tail in the server.
  local name="$1"; shift
  local msg="${*:-}"
  if [ -n "$msg" ]; then
    printf '[update] step=%s msg="%s"\n' "$name" "$msg"
  else
    printf '[update] step=%s\n' "$name"
  fi
}

die() {
  step failed "$*"
  printf '[update] error: %s\n' "$*" >&2
  exit 1
}

# ── 0. sanity: a real clone ──────────────────────────────────────────────────
[ -d .git ] || die "must run from a git clone (no .git in $ROOT)"

# ── 1. fetch + safety checks ────────────────────────────────────────────────
step fetching "Fetching the latest changes from GitHub …"
git fetch --quiet origin || die "git fetch failed"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "must be on branch 'main' (currently '$BRANCH')"

DIRTY="$(git status --porcelain | wc -l | tr -d ' ')"
[ "$DIRTY" = "0" ] || die "$DIRTY uncommitted change(s) — commit/stash before updating"

AHEAD="$(git rev-list --count origin/main..HEAD)"
[ "$AHEAD" = "0" ] || die "$AHEAD unpushed local commit(s) ahead of origin — push/reset first"

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"
if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  step done "Already on the latest commit (${LOCAL_SHA:0:12}) — nothing to do."
  exit 0
fi

# Fast-forward to origin/main. This is `reset --hard`-equivalent ONLY because
# we have proven the tree is clean AND there are no local commits to lose.
git merge --ff-only origin/main >/dev/null || die "fast-forward to origin/main failed (diverged?)"

NEW_SHA="$(git rev-parse HEAD)"
step fetching "Updated working tree to ${NEW_SHA:0:12}."

# ── 2. hand off to deploy-self.sh ───────────────────────────────────────────
step building "Building the new binary (this usually takes about a minute) …"
# deploy-self.sh writes the request file the root path-unit watches; the
# runner builds + installs + restarts + verifies + rolls back. We surface the
# install + verify phases via step lines so the UI's progress bar advances.
# SUPERMUX_SELF_NO_PULL=1: we already pulled above; deploy-self.sh should not
# re-pull (idempotent, but skipping the extra round-trip is tidier).
if ! SUPERMUX_SELF_NO_PULL=1 bash scripts/deploy-self.sh; then
  die "deploy-self.sh failed — see the log above. The previous version is restored."
fi

# scripts/deploy-self.sh blocks until DEPLOY_RESULT=ok or fails; on success
# the server has already restarted on the new binary.
step done "Update complete — supermux is running ${NEW_SHA:0:12}."
exit 0
