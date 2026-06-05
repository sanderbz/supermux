#!/usr/bin/env bash
# Build a local tarball with the same layout install.sh expects, so the test
# scenarios can run with `SUPERMUX_TARBALL_FROM=<path>` and exercise the
# installer end-to-end without depending on a published GitHub Release.
#
# Layout (matches what release CI uploads):
#   supermux-<target>.tar.gz
#   ├── supermux-server          (the binary)
#   ├── etc/
#   │   ├── systemd/
#   │   │   ├── supermux.service
#   │   │   ├── supermux-deploy.path
#   │   │   └── supermux-deploy.service
#   │   └── supermux-deploy-runner
#   └── VERSION                  (commit SHA on dev, tag on release)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CACHE="${ROOT}/tests/install/.cache"
mkdir -p "$CACHE"

# Native target.
case "$(uname -m)" in
  x86_64|amd64)  TARGET="x86_64-unknown-linux-gnu" ;;
  aarch64|arm64) TARGET="aarch64-unknown-linux-gnu" ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

OUT="${CACHE}/supermux-local.tar.gz"
echo "[build] target=${TARGET}"

# Build frontend (bun install + vite) and embed into server/static so the
# binary serves the PWA. The release.yml workflow does the same thing — this
# mirrors it byte-for-byte so the local tarball is functionally identical to
# what a real release ships.
echo "[build] bun install + vite build (frontend)..."
(
  cd "${ROOT}/web"
  bun install --frozen-lockfile --silent
  bun run build >/dev/null
)
echo "[build] embedding frontend → server/static..."
rm -rf "${ROOT}/server/static"
cp -r "${ROOT}/web/dist" "${ROOT}/server/static"
# Force a rebuild of the rust-embed include so the new bundle is part of the
# binary on every invocation (matches the workflow's `touch server/src/main.rs`).
touch "${ROOT}/server/src/main.rs"

# Build (release mode, no `--release` flag override needed: the host's cargo
# wrapper allows release when SUPERMUX_RELEASE_OK=1).
echo "[build] cargo build --release (this can take a few minutes on a cold cache)..."
(
  cd "${ROOT}/server"
  SUPERMUX_RELEASE_OK=1 cargo build --release --quiet
)

BIN="${ROOT}/server/target/release/supermux-server"
[ -x "$BIN" ] || { echo "binary missing: $BIN" >&2; exit 1; }

# Stage tarball contents in a temp dir.
STAGE="$(mktemp -d)"
cp "$BIN" "${STAGE}/supermux-server"
strip "${STAGE}/supermux-server" 2>/dev/null || true
mkdir -p "${STAGE}/etc/systemd"
cp "${ROOT}/etc/systemd/supermux.service"        "${STAGE}/etc/systemd/"
cp "${ROOT}/etc/systemd/supermux-deploy.path"    "${STAGE}/etc/systemd/"
cp "${ROOT}/etc/systemd/supermux-deploy.service" "${STAGE}/etc/systemd/"
cp "${ROOT}/etc/supermux-deploy-runner"          "${STAGE}/etc/"

# Version label = commit SHA on dev (release CI overrides to the tag).
SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || printf 'dev')"
printf 'v0.0.0-dev-%s\n' "$SHA" > "${STAGE}/VERSION"

tar -czf "$OUT" -C "$STAGE" .
rm -rf "$STAGE"

size="$(du -h "$OUT" | cut -f1)"
echo "[build] wrote ${OUT}  (${size})"
