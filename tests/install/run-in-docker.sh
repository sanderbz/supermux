#!/usr/bin/env bash
# Run an install-test scenario inside a systemd-in-docker container.
#
#   tests/install/run-in-docker.sh <distro> <scenario>
#
# distro:    ubuntu-24.04 | ubuntu-22.04 | debian-12
# scenario:  any file under tests/install/scenarios/<scenario>.sh
#
# Uses the `jrei/systemd-*` images (full systemd, no kernel-level changes
# needed). The repo is bind-mounted read-only; the local prebuilt tarball is
# bind-mounted read-only and exposed to the scenario via SUPERMUX_TARBALL_FROM.
# A fresh container per run — no state leaks.

set -euo pipefail

DISTRO="${1:?usage: $0 <distro> <scenario>}"
SCENARIO="${2:?usage: $0 <distro> <scenario>}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCEN="${ROOT}/tests/install/scenarios/${SCENARIO}.sh"
[ -r "$SCEN" ] || { echo "scenario not found: $SCEN" >&2; exit 1; }

case "$DISTRO" in
  ubuntu-24.04) IMG="jrei/systemd-ubuntu:24.04" ;;
  ubuntu-22.04) IMG="jrei/systemd-ubuntu:22.04" ;;
  debian-12)    IMG="jrei/systemd-debian:12" ;;
  *) echo "unsupported distro: $DISTRO" >&2; exit 1 ;;
esac

# Local tarball for SUPERMUX_TARBALL_FROM (built by tests/install/build-local-tarball.sh).
TARBALL="${SUPERMUX_TARBALL_FROM:-${ROOT}/tests/install/.cache/supermux-local.tar.gz}"
[ -r "$TARBALL" ] || {
  echo "tarball not found: $TARBALL" >&2
  echo "build one with: bash tests/install/build-local-tarball.sh" >&2
  exit 1
}

NAME="smtest-${DISTRO//./}-${SCENARIO}-$$"
echo "[harness] image=${IMG} scenario=${SCENARIO} container=${NAME}"

# systemd needs cgroup v2 + tmpfs mounts. --privileged is the documented path
# for the jrei/* images; we tear the container down on exit either way.
docker run -d --rm \
  --name "$NAME" \
  --privileged \
  --cgroupns=host \
  --tmpfs /tmp \
  --tmpfs /run \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "${ROOT}:/src:ro" \
  -v "${TARBALL}:/cache/supermux.tar.gz:ro" \
  -e SUPERMUX_TARBALL_FROM=/cache/supermux.tar.gz \
  "$IMG" \
  >/dev/null

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# Wait for systemd to be up — the container's PID 1 needs a few hundred ms.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if docker exec "$NAME" systemctl is-system-running --wait --quiet 2>/dev/null \
     || docker exec "$NAME" systemctl is-system-running 2>/dev/null \
        | grep -qE 'running|degraded|starting'; then
    break
  fi
  sleep 0.3
done

# Run scenario. Scenarios must exit non-zero on failure; harness propagates.
echo "[harness] running scenario..."
if docker exec -e SUPERMUX_TARBALL_FROM=/cache/supermux.tar.gz "$NAME" \
     bash /src/tests/install/scenarios/"${SCENARIO}".sh; then
  echo "[harness] PASS  ${DISTRO}/${SCENARIO}"
else
  rc=$?
  echo "[harness] FAIL  ${DISTRO}/${SCENARIO} (exit ${rc})"
  echo "[harness] -- journal tail --"
  docker exec "$NAME" journalctl -u supermux -n 50 --no-pager 2>&1 || true
  exit "$rc"
fi
