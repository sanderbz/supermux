#!/usr/bin/env bash
# Install once, capture the auth token + data dir; re-run the installer; the
# binary should be replaced + service restart cleanly + auth token preserved.
set -euo pipefail

apt-get update -qq
apt-get install -y -qq curl ca-certificates

SUPERMUX_INSTALL_CLAUDE=0 bash /src/install.sh
AUTH_BEFORE=$(find /home -name auth_token -path '*.supermux*' | head -1)
TOK_BEFORE=$(cat "$AUTH_BEFORE")

# Second run: same tarball/version → installer must short-circuit with "noop".
out=$(SUPERMUX_INSTALL_CLAUDE=0 bash /src/install.sh 2>&1)
echo "$out" | grep -qiE 'already at|nothing to do' \
  || { echo "[scenario] expected noop on re-run; got:"; echo "$out"; exit 1; }

# Data + auth token must be untouched.
TOK_AFTER=$(cat "$AUTH_BEFORE")
[ "$TOK_BEFORE" = "$TOK_AFTER" ] \
  || { echo "[scenario] auth_token rotated unexpectedly"; exit 1; }

bash /src/tests/install/verify.sh
