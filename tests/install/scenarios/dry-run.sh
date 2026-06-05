#!/usr/bin/env bash
# --dry-run must print [dry] lines and change NOTHING on disk.
set -euo pipefail

apt-get update -qq
apt-get install -y -qq curl ca-certificates

SUPERMUX_INSTALL_CLAUDE=0 bash /src/install.sh --dry-run

# Post-conditions: no binary, no units, no service user.
test ! -x /usr/local/bin/supermux-server \
  || { echo "[scenario] binary appeared despite --dry-run — FAIL"; exit 1; }
test ! -e /etc/systemd/system/supermux.service \
  || { echo "[scenario] unit appeared despite --dry-run — FAIL"; exit 1; }
echo "  dry-run scenario: PASS"
