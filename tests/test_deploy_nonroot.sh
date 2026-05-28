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
# home="/" edge (the double-slash bug): any absolute path is under root.
path_under_home "/anything" "/";                            assert_rc "home='/' — descendant under root" 0 $?
path_under_home "/" "/";                                    assert_rc "home='/' — root itself" 0 $?
path_under_home "/opt/work/sub" "/";                        assert_rc "home='/' — deep descendant under root" 0 $?

echo "── pure helper: project_dir_is_safe (chown -R blocklist) ────────────"
project_dir_is_safe "/opt/projects";  assert_rc "dedicated subdir is safe" 0 $?
project_dir_is_safe "/srv/work";      assert_rc "another dedicated subdir is safe" 0 $?
project_dir_is_safe "/home/supermux/projects"; assert_rc "under-home subdir is safe" 0 $?
project_dir_is_safe "/";              assert_rc "filesystem root is REFUSED" 1 $?
project_dir_is_safe "";              assert_rc "empty path is REFUSED" 1 $?
project_dir_is_safe "/etc";          assert_rc "/etc is REFUSED" 1 $?
project_dir_is_safe "/usr";          assert_rc "/usr is REFUSED" 1 $?
project_dir_is_safe "/home";         assert_rc "bare /home is REFUSED" 1 $?
project_dir_is_safe "/opt";          assert_rc "bare /opt is REFUSED" 1 $?
project_dir_is_safe "/etc/";         assert_rc "/etc with trailing slash is REFUSED" 1 $?

echo "── remote: ensure_project_dir_remote REFUSES a system path (no chown) ─"
: > "$CHOWN_LOG"
ensure_project_dir_remote "/etc" "supermux" "/home/supermux" "fakehost" >/dev/null 2>&1
rc=$?
assert_rc "chown -R of /etc is refused" 1 "$rc"
if [ ! -s "$CHOWN_LOG" ]; then pass "/etc was NOT chowned"; else fail "/etc must not be chowned (log: $(cat "$CHOWN_LOG"))"; fi

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

echo "── remote: service_user_has_claude_bin (binary probe) ───────────────"
# This helper is a thin wrapper: it ssh's a probe that runs `command -v claude`
# AS the service user (login shell, ~/.local/bin prepended) and passes the rc
# through. Rather than depend on whether the REAL test box has claude on PATH
# (flaky), use a capturing ssh stub that returns a controlled rc and records the
# probe string — so we assert BOTH the contract (ssh rc → return rc) and the
# probe shape (runs as the user, prepends ~/.local/bin, uses `command -v
# claude`). The copy-creds block below redefines `ssh` again for its own case.
_CAP_CMD=""
_SSH_RC=0
ssh() { shift; _CAP_CMD="$*"; return "$_SSH_RC"; }
_SSH_RC=0
service_user_has_claude_bin "supermux" "fakehost"; assert_rc "binary present (ssh rc 0) → 0" 0 $?
_SSH_RC=1
service_user_has_claude_bin "supermux" "fakehost"; assert_rc "binary missing (ssh rc 1) → 1" 1 $?
case "$_CAP_CMD" in
  *"command -v claude"*) pass "probe uses 'command -v claude'" ;;
  *) fail "probe must use 'command -v claude' (got: $_CAP_CMD)" ;;
esac
case "$_CAP_CMD" in
  *".local/bin"*) pass "probe prepends ~/.local/bin to PATH" ;;
  *) fail "probe must prepend ~/.local/bin (got: $_CAP_CMD)" ;;
esac
case "$_CAP_CMD" in
  *"sudo -u 'supermux'"*) pass "probe runs as the service user" ;;
  *) fail "probe must sudo -u the service user (got: $_CAP_CMD)" ;;
esac

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

# Creds-copy hardens destination perms regardless of source mode.
LOOSE_DEPLOYER="$SANDBOX/loose-deployer"
LOOSE_TARGET="$SANDBOX/loose-target"
mkdir -p "$LOOSE_DEPLOYER/.claude" "$LOOSE_TARGET"
printf '{"x":1}\n' > "$LOOSE_DEPLOYER/.claude/.credentials.json"
chmod 644 "$LOOSE_DEPLOYER/.claude/.credentials.json"   # deliberately loose source
chmod 755 "$LOOSE_DEPLOYER/.claude"
copy_deployer_claude_creds "$LOOSE_DEPLOYER" "$LOOSE_TARGET" "supermux" "fakehost" >/dev/null 2>&1
# Read back the destination mode (portable: stat differs across BSD/GNU, so use ls).
dst_cred_mode="$(ls -l "$LOOSE_TARGET/.claude/.credentials.json" 2>/dev/null | cut -c1-10)"
assert_eq "destination .credentials.json hardened to -rw------- regardless of loose source" "-rw-------" "$dst_cred_mode"

echo "── orchestration: SERVICE_USER_IS_DEFAULT keys on VALUE not env presence (P0) ─"
# The P0 was: SERVICE_USER_IS_DEFAULT keyed on env-var PRESENCE, but setup.sh
# ALWAYS writes SUPERMUX_SERVICE_USER=supermux → wizard .env disabled auto-create.
# Verify deploy.sh source keys on the VALUE 'supermux' (no presence-only check).
# 1) Structural: the code must compare SERVICE_USER to "supermux".
if grep -Eq '\[ "\$SERVICE_USER" = "supermux" \].*SERVICE_USER_IS_DEFAULT=1|SERVICE_USER_IS_DEFAULT=1' "$DEPLOY_SH" \
   && grep -q '\[ "\$SERVICE_USER" = "supermux" \]' "$DEPLOY_SH"; then
  pass "deploy.sh keys SERVICE_USER_IS_DEFAULT on value 'supermux'"
else
  fail "deploy.sh should key SERVICE_USER_IS_DEFAULT on the value 'supermux'"
fi
# 2) The old presence-only check (-z on the env var setting the flag) must be gone.
if grep -Eq '\[ -z "\$\{?SUPERMUX_SERVICE_USER:?-?\}?" \]' "$DEPLOY_SH" \
   && grep -A1 -E '\[ -z "\$\{?SUPERMUX_SERVICE_USER' "$DEPLOY_SH" | grep -q 'SERVICE_USER_IS_DEFAULT=1'; then
  fail "deploy.sh still keys IS_DEFAULT on env-var presence (the P0)"
else
  pass "deploy.sh no longer keys IS_DEFAULT on env-var presence"
fi
# 3) Behavioural: replicate the exact derivation for the two key cases.
is_default_for() { local SERVICE_USER="$1" SERVICE_USER_IS_DEFAULT=0
  [ "$SERVICE_USER" = "supermux" ] && SERVICE_USER_IS_DEFAULT=1
  printf '%s' "$SERVICE_USER_IS_DEFAULT"; }
assert_eq "explicit SERVICE_USER=supermux is treated as DEFAULT (auto-createable)" "1" "$(is_default_for supermux)"
assert_eq "a non-default user is NOT auto-createable (refused)"                     "0" "$(is_default_for alice)"

echo "── orchestration: root RWP fold-in includes external project dirs (P1) ─"
# Replicate the root READ_WRITE_PATHS_DEFAULT fold-in (uses the REAL helpers
# split_path_list + path_under_home loaded above). External dirs must be added;
# dirs already under /root must be skipped.
root_rwp_default_for() {
  local PROJECT_DIRS="$1"
  local READ_WRITE_PATHS_DEFAULT="/root"
  local pd
  while IFS= read -r pd; do
    [ -z "$pd" ] && continue
    case ":$READ_WRITE_PATHS_DEFAULT:" in
      *":$pd:"*) : ;;
      *)
        if path_under_home "$pd" "/root"; then :; else
          READ_WRITE_PATHS_DEFAULT="$READ_WRITE_PATHS_DEFAULT:$pd"
        fi
        ;;
    esac
  done <<EOF_RPD
$(split_path_list "$PROJECT_DIRS")
EOF_RPD
  printf '%s' "$READ_WRITE_PATHS_DEFAULT"
}
assert_eq "root: external project dir folded into RWP" "/root:/opt/work" "$(root_rwp_default_for /opt/work)"
assert_eq "root: project dir under /root is NOT duplicated" "/root" "$(root_rwp_default_for /root/projects)"
assert_eq "root: mixed dirs — only external one added" "/root:/srv/x" "$(root_rwp_default_for "/root/projects:/srv/x")"

echo "── orchestration: setup.sh public-port accepts 443 (no infinite loop) ─"
# Regression: the P1-a fix changed D_PUBLIC_PORT 8823→443, but setup.sh validated
# the public port with is_port (min 1024), which REJECTS 443 — so the prompt loop
# spun forever in non-interactive mode (ask returns the default → fails validation
# → loops). The fix splits out is_public_port (full 1..65535) for the TLS port.
SETUP_SH="$REPO_ROOT/scripts/setup.sh"
# Replicate the two validators verbatim from setup.sh.
_is_port() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -lt 1024 ] || [ "$1" -gt 65535 ] && return 1; return 0; }
_is_public_port() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -lt 1 ] || [ "$1" -gt 65535 ] && return 1; return 0; }
_is_public_port 443;   assert_rc "public-port validator ACCEPTS 443 (the default)" 0 $?
_is_public_port 8823;  assert_rc "public-port validator accepts 8823"             0 $?
_is_public_port 0;     assert_rc "public-port validator rejects 0"                1 $?
_is_public_port 70000; assert_rc "public-port validator rejects >65535"           1 $?
_is_port 443;          assert_rc "internal-port validator still rejects 443 (privileged)" 1 $?
_is_port 8824;         assert_rc "internal-port validator accepts 8824"           0 $?
# Structural: D_PUBLIC_PORT must default to 443, and the public-port loop must use
# is_public_port (NOT is_port) so accepting the default can't loop forever.
if grep -Eq '^D_PUBLIC_PORT="443"' "$SETUP_SH"; then pass "setup.sh D_PUBLIC_PORT defaults to 443"; else fail "setup.sh D_PUBLIC_PORT should default to 443"; fi
if grep -A3 'public port (TLS)' "$SETUP_SH" | grep -q 'is_public_port'; then pass "public-port prompt validates with is_public_port"; else fail "public-port prompt must use is_public_port (else 443 default loops)"; fi

echo "── summary ──────────────────────────────────────────────────────────"
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
