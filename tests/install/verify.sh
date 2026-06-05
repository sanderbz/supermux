#!/usr/bin/env bash
# Post-install assertions, shared by every scenario. Returns 0 when supermux
# is genuinely running + reachable + persists across a restart.

set -euo pipefail

PORT="${SUPERMUX_INTERNAL_PORT:-8824}"

step() { printf '  • %s ... ' "$*" >&2; }
pass() { printf 'OK\n' >&2; }
fail() { printf 'FAIL\n' >&2; printf '    %s\n' "$*" >&2; exit 1; }

step "systemctl is-active supermux"
systemctl is-active --quiet supermux && pass || fail "supermux is not active"

step "systemctl is-enabled supermux"
systemctl is-enabled --quiet supermux && pass || fail "supermux is not enabled"

step "no errors in journal (last 200 lines)"
if journalctl -u supermux -n 200 --no-pager 2>/dev/null \
   | grep -iE 'ERROR|panic|fatal' \
   | grep -viE 'agent_(stopped|finished|waiting)' >/dev/null; then
  fail "journal has unexpected error lines"
fi
pass

step "GET /api/health on 127.0.0.1:${PORT}"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    pass; break
  fi
  [ "$i" = "10" ] && fail "health endpoint never returned 200"
  sleep 1
done

step "PWA shell loads (HTML title)"
curl -fsS "http://127.0.0.1:${PORT}/" | grep -q '<title>' && pass || fail "no <title> in index"

step "auth token file exists (mode 0600)"
AUTH=$(find /home -name auth_token -path '*.supermux*' 2>/dev/null | head -1)
[ -r "$AUTH" ] || fail "no auth_token file under /home/*/.supermux/"
mode=$(stat -c '%a' "$AUTH" 2>/dev/null)
[ "$mode" = "600" ] || fail "auth_token mode is ${mode}, want 600"
pass

step "auth-protected endpoint refuses without token"
status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/sessions")
[ "$status" = "401" ] || fail "expected 401, got ${status}"
pass

step "auth-protected endpoint accepts the token"
TOKEN=$(cat "$AUTH")
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:${PORT}/api/sessions")
[ "$status" = "200" ] || fail "expected 200 with token, got ${status}"
pass

step "service survives a restart"
systemctl restart supermux
sleep 2
systemctl is-active --quiet supermux || fail "supermux died after restart"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    pass; break
  fi
  [ "$i" = "10" ] && fail "health never returned 200 after restart"
  sleep 1
done

step "self-deploy path-unit is enabled"
systemctl is-enabled --quiet supermux-deploy.path && pass \
  || fail "supermux-deploy.path is not enabled"

echo "  all verifications passed." >&2
