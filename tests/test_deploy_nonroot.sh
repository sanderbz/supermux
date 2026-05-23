#!/usr/bin/env bash
# Unit tests for the non-root-install logic added to scripts/deploy.sh.
#
# Strategy:
#   - Source deploy.sh with SUPERMUX_DEPLOY_LIB_ONLY=1 so only the function
#     definitions load (no SSH, no side effects — the script `return`s at the
#     TEST HOOK before any deploy action).
#   - Test the PURE helpers (split_path_list, path_under_home) directly.
#   - Test the REMOTE helpers (ensure_project_dir_remote,
#     service_user_has_claude_creds, copy_deployer_claude_creds) by stubbing
#     `ssh`/`sudo` so "remote" commands run against a local tmp SANDBOX prefix.
#     This proves the provisioning / chown / detection LOGIC without a real host.
#
# Run:  bash tests/test_deploy_nonroot.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_SH="$REPO_ROOT/scripts/deploy.sh"

PASS=0
FAIL=0
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
pass() { printf 'ok:   %s\n' "$1"; PASS=$((PASS + 1)); }
assert_eq() {
  # assert_eq "desc" "expected" "actual"
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 — expected [$2] got [$3]"; fi
}
assert_rc() {
  # assert_rc "desc" expected_rc actual_rc
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 — expected rc $2 got $3"; fi
}

# ── sandbox + ssh/sudo stubs ────────────────────────────────────────────────
# A throwaway prefix that stands in for "the remote host's filesystem". The
# stubbed ssh executes the command string LOCALLY but rewrites absolute paths
# to live under $SANDBOX, and `sudo`/`sudo -u <user>` become no-ops (we run as
# the current local user). chown is faked into a side-channel log so we can
# assert "this dir would have been chowned to <user>".
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/supermux-test.XXXXXX")"
CHOWN_LOG="$SANDBOX/.chown.log"
: > "$CHOWN_LOG"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

# Map a "remote" absolute path into the sandbox prefix.
sbx() { printf '%s%s' "$SANDBOX" "$1"; }

# ── command stubs (function-based, not sed-based, so they're robust) ─────────
# The tested deploy.sh helpers invoke `ssh "$host" "<cmd>"`. We stub `ssh` to
# run <cmd> locally inside a subshell where the following commands are wrapped:
#   sudo   — drop "-u <user>" / "-H" / "-i", run the rest;
#   mkdir  — rewrite absolute path args to live under $SANDBOX;
#   _t (a test wrapper invoked via the rewritten "test") — rewrite paths;
#   chown  — record the would-be-chowned target into $CHOWN_LOG instead of
#            actually chowning (the test user can't chown to 'supermux').
# Absolute path args are rewritten to $SANDBOX/<path> by each wrapper.
_rw() { case "$1" in /*) printf '%s%s' "$SANDBOX" "$1" ;; *) printf '%s' "$1" ;; esac; }

_stub_env() {
  # Emits function definitions to inject into the remote subshell.
  cat <<'STUBS'
sudo() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -u) shift 2 ;;     # drop "-u <user>"
      -H|-i) shift ;;    # drop login/home flags
      *) break ;;
    esac
  done
  "$@"
}
mkdir() {
  local a args=()
  for a in "$@"; do args+=("$(_rw "$a")"); done
  command mkdir "${args[@]}"
}
test() {
  local a args=()
  for a in "$@"; do args+=("$(_rw "$a")"); done
  command test "${args[@]}"
}
chown() {
  # last arg is the target path; record it (rewritten) and succeed.
  local target; eval "target=\${$#}"
  printf '%s\n' "$(_rw "$target")" >> "$CHOWN_LOG"
}
STUBS
}

remote_exec() {
  # remote_exec "<command string>" — run it in a subshell with the stubs above.
  local cmd="$1"
  (
    set +e
    eval "$(_stub_env)"
    eval "$cmd"
  )
}

# Stub `ssh`: ssh HOST "cmd" → remote_exec "cmd". The host arg is discarded —
# everything runs locally against the sandbox.
ssh() {
  shift  # drop the host argument
  remote_exec "$*"
}

# Stub `scp` (unused by the tested fns, but define for safety).
scp() { :; }

export SANDBOX CHOWN_LOG
export -f _rw _stub_env remote_exec sbx ssh scp 2>/dev/null || true

# ── load the deploy.sh function library only ────────────────────────────────
# shellcheck disable=SC1090
SUPERMUX_DEPLOY_LIB_ONLY=1 . "$DEPLOY_SH"
# deploy.sh sets `set -euo pipefail`, which PERSISTS into this shell after
# sourcing. The tests deliberately call helpers that return non-zero (e.g.
# path_under_home on an outside-home path, service_user_has_claude_creds when
# creds are absent), so we must turn OFF errexit here or the first expected
# failure would abort the whole test run. (We keep nounset off too for the
# stub machinery.)
set +e +u +o pipefail

echo "── pure helper: split_path_list ─────────────────────────────────────"
out="$(split_path_list "/a:/b:/c" | tr '\n' ',')"
assert_eq "splits colon list" "/a,/b,/c," "$out"
out="$(split_path_list "/a::/b:" | tr '\n' ',')"
assert_eq "drops empty entries" "/a,/b," "$out"
out="$(split_path_list "  /a : /b  " | tr '\n' ',')"
assert_eq "trims whitespace" "/a,/b," "$out"
out="$(split_path_list "/only" | tr '\n' ',')"
assert_eq "single entry" "/only," "$out"

echo "── pure helper: path_under_home ─────────────────────────────────────"
path_under_home "/home/supermux/projects" "/home/supermux"; assert_rc "descendant of home" 0 $?
path_under_home "/home/supermux" "/home/supermux";          assert_rc "home itself" 0 $?
path_under_home "/home/supermux/" "/home/supermux";         assert_rc "home with trailing slash" 0 $?
path_under_home "/opt/projects" "/home/supermux";           assert_rc "outside home" 1 $?
path_under_home "/home/supermuxer/x" "/home/supermux";      assert_rc "sibling prefix is NOT under home" 1 $?

echo "── remote: ensure_project_dir_remote (under home → no chown) ─────────"
: > "$CHOWN_LOG"
ensure_project_dir_remote "/home/supermux/projects" "supermux" "/home/supermux" "fakehost" >/dev/null 2>&1
rc=$?
assert_rc "under-home dir provisions ok" 0 "$rc"
if [ -d "$(sbx /home/supermux/projects)" ]; then pass "under-home dir created"; else fail "under-home dir not created"; fi
if [ ! -s "$CHOWN_LOG" ]; then pass "under-home dir NOT chowned (user already owns it)"; else fail "under-home dir should not be chowned (log: $(cat "$CHOWN_LOG"))"; fi

echo "── remote: ensure_project_dir_remote (outside home → chown -R) ───────"
: > "$CHOWN_LOG"
ensure_project_dir_remote "/opt/projects" "supermux" "/home/supermux" "fakehost" >/dev/null 2>&1
rc=$?
assert_rc "outside-home dir provisions ok" 0 "$rc"
if [ -d "$(sbx /opt/projects)" ]; then pass "outside-home dir created"; else fail "outside-home dir not created"; fi
if grep -q "${SANDBOX}/opt/projects" "$CHOWN_LOG"; then pass "outside-home dir chowned to service user"; else fail "outside-home dir should be chowned (log: $(cat "$CHOWN_LOG"))"; fi

echo "── remote: service_user_has_claude_creds ────────────────────────────"
# No creds yet → must return 1.
service_user_has_claude_creds "/home/supermux" "fakehost"; assert_rc "missing creds → 1" 1 $?
# Plant a creds file in the sandbox, then it must return 0.
mkdir -p "$(sbx /home/supermux/.claude)"
printf '{"fake":true}\n' > "$(sbx /home/supermux/.claude/.credentials.json)"
service_user_has_claude_creds "/home/supermux" "fakehost"; assert_rc "present creds → 0" 0 $?

echo "── remote: copy_deployer_claude_creds (fast path) ───────────────────"
# This helper runs `ssh host "sudo bash -s" <<HEREDOC`, i.e. a REAL inner bash
# reading the script from stdin. So we exercise it against REAL sandbox paths
# (not the $SANDBOX-rewriting stubs) plus a PATH shim that makes `sudo` a no-op
# and `chown` a no-op (the test user can't chown). We use a dedicated ssh stub
# that forwards stdin to a sandboxed bash.
SHIM_BIN="$SANDBOX/shim-bin"
mkdir -p "$SHIM_BIN"
printf '#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do case "$1" in -u) shift 2;; -H|-i) shift;; *) break;; esac; done\nexec "$@"\n' > "$SHIM_BIN/sudo"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SHIM_BIN/chown"
chmod +x "$SHIM_BIN/sudo" "$SHIM_BIN/chown"

# Dedicated ssh stub for the heredoc case: run a real bash with the shim on PATH
# and stdin (the heredoc) forwarded.
ssh() {
  shift  # drop host
  # "$@" is e.g. `sudo bash -s`; run it with shim PATH + forwarded stdin.
  PATH="$SHIM_BIN:$PATH" bash -c 'eval "$*"' _ "$@"
}

# Set up a deployer home WITH creds and an empty target home, both real dirs.
DEPLOYER_HOME="$SANDBOX/deployer"
TARGET_HOME="$SANDBOX/target"
mkdir -p "$DEPLOYER_HOME/.claude" "$TARGET_HOME"
printf '{"deployer":"creds"}\n' > "$DEPLOYER_HOME/.claude/.credentials.json"
printf '{"projects":{}}\n' > "$DEPLOYER_HOME/.claude.json"

copy_deployer_claude_creds "$DEPLOYER_HOME" "$TARGET_HOME" "supermux" "fakehost" >/dev/null 2>&1
assert_rc "copy succeeds when deployer has creds" 0 $?
if [ -f "$TARGET_HOME/.claude/.credentials.json" ]; then pass "copied .credentials.json to target"; else fail "did not copy .credentials.json"; fi
if [ -f "$TARGET_HOME/.claude.json" ]; then pass "copied .claude.json to target"; else fail "did not copy .claude.json"; fi

# Negative: a deployer home with NO .claude must fail (nothing to copy).
EMPTY_DEPLOYER="$SANDBOX/empty-deployer"
mkdir -p "$EMPTY_DEPLOYER"
copy_deployer_claude_creds "$EMPTY_DEPLOYER" "$TARGET_HOME" "supermux" "fakehost" >/dev/null 2>&1
assert_rc "copy fails when deployer has no .claude" 1 $?

echo "── summary ──────────────────────────────────────────────────────────"
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
