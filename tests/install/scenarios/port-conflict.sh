#!/usr/bin/env bash
# Bind port 8824 with a sleeper BEFORE running the installer. Expect a clean
# refusal with a clear error, NOT a half-finished install.
set -euo pipefail

apt-get update -qq
apt-get install -y -qq curl ca-certificates iproute2 ncat

# Hold port 8824 from a foreign process so the installer can't claim it.
nohup ncat -k -l 8824 >/dev/null 2>&1 &
SQUATTER=$!
sleep 0.5

# Sanity: confirm the port is held.
ss -lntH "( sport = :8824 )" | grep -q . \
  || { echo "[scenario] couldn't establish port squatter"; exit 1; }

# Expect a non-zero exit AND a clear error message.
if SUPERMUX_INSTALL_CLAUDE=0 bash /src/install.sh 2>install.err; then
  echo "[scenario] installer succeeded but a foreign process holds 8824 — FAIL"
  cat install.err
  exit 1
fi
grep -qE 'port 8824 is in use' install.err \
  || { echo "[scenario] expected 'port 8824 is in use' in stderr; got:"; cat install.err; exit 1; }

# And the system should NOT have been mutated.
test ! -x /usr/local/bin/supermux-server \
  || { echo "[scenario] binary was installed despite port conflict — FAIL"; exit 1; }
test ! -e /etc/systemd/system/supermux.service \
  || { echo "[scenario] unit was installed despite port conflict — FAIL"; exit 1; }
id supermux >/dev/null 2>&1 \
  && echo "[scenario] note: supermux user exists (created during preflight is allowed)"

kill "$SQUATTER" 2>/dev/null || true
echo "  port-conflict scenario: PASS"
