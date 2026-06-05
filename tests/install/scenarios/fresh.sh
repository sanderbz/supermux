#!/usr/bin/env bash
# Happy-path: fresh container, no supermux, no tmux, no tailscale, no claude.
# Runs the installer end-to-end and the shared verifier.
set -euo pipefail

apt-get update -qq
apt-get install -y -qq curl ca-certificates

# install.sh + tarball are bind-mounted via the harness:
#   /src/install.sh
#   $SUPERMUX_TARBALL_FROM
# Claude install would hit the network from a non-existent home dir — skip.
SUPERMUX_INSTALL_CLAUDE=0 bash /src/install.sh

bash /src/tests/install/verify.sh
