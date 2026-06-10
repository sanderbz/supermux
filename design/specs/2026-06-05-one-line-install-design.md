# Design: One-line install on a VPS

**Status**: Built · **Date**: 2026-06-05

## 1. Problem

The current install path is `scripts/setup.sh` + `scripts/deploy.sh` — a deploy
*from your workstation* over SSH. That's a power-user model. The dominant
self-hosting flow is "SSH into my VPS and run a command on the box", and we
weren't supporting it.

## 2. Goal

A README one-liner that drops supermux on a fresh Ubuntu 22.04+ / Debian 12+
VPS in ~10 seconds, end-to-end. Matches the UX of Tailscale / k3s / Docker
installers. Existing data + sessions are preserved on re-run.

```bash
curl -fsSL https://raw.githubusercontent.com/sanderbz/supermux/main/install.sh | sudo bash
```

## 3. Architecture (Approach 3 — Hybrid)

Prebuilt-binary install (k3s pattern), mirror of `deploy.sh`'s feature set
minus the SSH-specific bits. Reuses the existing systemd unit + path-unit +
self-deploy runner templates verbatim, so in-UI 1-click updates keep
working after install.

```
README                          GitHub
──────                          ──────
curl … install.sh | sudo bash  releases/vX.Y.Z/
                                 supermux-<arch>.tar.gz   (binary + etc/ + VERSION)
        │                        checksums.txt
        ▼
   install.sh on box
       ├── preflight: root? Ubuntu/Debian? arch? systemd? tmux? port free?
       ├── resolve target version (env $SUPERMUX_VERSION or /releases/latest redirect)
       ├── download tarball + checksums.txt → sha256sum -c
       ├── extract → temp dir
       ├── existing-install check via /usr/local/share/supermux/installed-version
       │   → fresh | upgrade | noop (already on this version → exit 0)
       ├── ensure_user (supermux) + project dirs + data dir
       ├── render systemd unit + path-unit + deploy-runner from templates
       ├── install binary + units + version marker
       ├── daemon-reload + restart + verify /api/health (30s budget)
       ├── maybe_tailscale: auto-detect tailscaled → tailscale serve --bg --https=443
       └── maybe_claude:    check `claude` for supermux user → offer install
```

## 4. Decisions

| Question | Choice |
|---|---|
| Distro coverage v1 | Ubuntu 22.04+ / Debian 12+ only. apt-only. |
| Sudo model | `curl … \| sudo bash` (root required). |
| Tailscale + Claude | Auto-detect + offer (mirror deploy.sh). |
| Script hosting | GitHub raw URL on `main`. |
| Re-run behavior | Idempotent: detect existing version, upgrade or noop. |
| Build targets | `x86_64-unknown-linux-gnu` + `aarch64-unknown-linux-gnu` (glibc). |
| Signing | SHA256 in checksums.txt (cosign sigs deferred to v2). |

## 5. Components

| File | Role |
|---|---|
| `install.sh` (596 LOC) | The installer — all logic in named functions: `preflight`, `resolve_version`, `fetch_tarball`, `extract_tarball`, `ensure_user`, `render_units`, `install_binary`, `install_units`, `verify_health`, `maybe_tailscale`, `maybe_claude`. Functions guarded with `run()` so `--dry-run` works end-to-end. |
| `.github/workflows/release.yml` | Tag-push triggered. Native x86_64 + aarch64 matrix on `ubuntu-22.04` / `ubuntu-22.04-arm` runners. Builds frontend, embeds, cargo release, stages tarball (binary + etc/ + VERSION), sha256, uploads to the release with `gh release upload --clobber`. |
| `tests/install/` | Test harness — `run-in-docker.sh` spins up `jrei/systemd-*` images bind-mounting the repo + a locally-built tarball via `SUPERMUX_TARBALL_FROM`. `verify.sh` is shared post-install assertions (systemctl, /api/health, restart persistence, auth token, self-deploy path-unit). `scenarios/{fresh,upgrade,port-conflict,dry-run}.sh` — distinct test cases. |
| `tests/install/build-local-tarball.sh` | Builds a tarball matching the release layout from the local checkout, for the test harness. |
| Templates | `etc/systemd/supermux.service`, `etc/systemd/supermux-deploy.{path,service}`, `etc/supermux-deploy-runner` — UNCHANGED. install.sh substitutes the same `__PLACEHOLDER__`s `deploy.sh` does. |

## 6. Wire format

Tarball layout (matches what install.sh extracts):

```
supermux-<target>.tar.gz
├── supermux-server           (release binary, stripped)
├── etc/
│   ├── systemd/
│   │   ├── supermux.service
│   │   ├── supermux-deploy.path
│   │   └── supermux-deploy.service
│   └── supermux-deploy-runner
└── VERSION                   (the tag, e.g. v0.4.22)
```

`checksums.txt` aggregates one `<sha>  <name>` line per tarball — fed
directly to `sha256sum -c -`.

Installed-version marker: `/usr/local/share/supermux/installed-version`
(root:root, 0644, one tag per line). Sole source of truth for re-run
detection — NOT derived from the binary (which has no `--version` flag).

## 7. Env vars + flags

```
SUPERMUX_VERSION         pin a tag (default: latest via /releases/latest redirect)
SUPERMUX_INTERNAL_PORT   loopback port (default: 8824)
SUPERMUX_PROJECT_DIRS    `:`-joined dirs agents may write to (default: $HOME/projects)
SUPERMUX_USE_TAILSCALE   1 | 0 (default: auto-detect)
SUPERMUX_INSTALL_CLAUDE  ask | 1 | 0 (default: ask if interactive, else 0)
SUPERMUX_NO_START        don't enable + restart after install
SUPERMUX_TARBALL_FROM    local tarball path — TEST ONLY, skips download

--dry-run        print plan, change nothing
--version <tag>  pin (same as SUPERMUX_VERSION)
--no-start       install but don't restart
--help           show header
```

## 8. Error handling

- `set -euo pipefail` at top, `main "$@"` at EOF — rustup pattern, prevents
  partial-download execution.
- Hard refusals (exit non-zero, no side effects): not root; non-Linux;
  unsupported distro/version; unsupported arch; missing curl/systemd;
  port conflict held by foreign process.
- Soft refusals (warn + continue): Claude install declined, Tailscale
  unavailable, journal noise.
- Verify gate: `verify_health` polls `/api/health` for 30s. On failure,
  print last 30 journal lines and die.
- The path-unit's self-deploy runner does its own rollback on health
  failure (unchanged from deploy.sh's behavior).

## 9. Testing strategy

### 9.1 Per PR — fast smoke matrix (≤ 12 min wall-clock)

`jrei/systemd-*` containers with `--privileged --cgroupns=host`. 3 distros × 4
scenarios = 12 cells:

| Distro             | Scenarios                                  |
|--------------------|--------------------------------------------|
| ubuntu-22.04       | fresh, upgrade, port-conflict, dry-run     |
| ubuntu-24.04       | fresh, upgrade, port-conflict, dry-run     |
| debian-12          | fresh, upgrade, port-conflict, dry-run     |

Each cell loads a tarball built once via `tests/install/build-local-tarball.sh`
and exposes it to the scenario via `SUPERMUX_TARBALL_FROM`. (CI will pre-build
the tarball as a job step before the matrix fans out.)

### 9.2 Per release — full e2e on a real GitHub Release

After the tag is pushed and the release.yml workflow uploads assets:
1. Fresh Ubuntu 22.04 cloud VM (Hetzner CX11 or a GitHub-hosted runner).
2. Run the README one-liner against the real GitHub Releases asset URL.
3. Verify `/api/health` + PWA shell + auth token + path-unit + self-deploy.

### 9.3 Verification (shared `verify.sh`)

| Check | Assertion |
|---|---|
| `systemctl is-active supermux` | active |
| `systemctl is-enabled supermux` | enabled |
| `journalctl -u supermux -n 200` | no `ERROR\|panic\|fatal` (filter out the agent-state push categories) |
| `curl /api/health` | 200 |
| `curl /` | contains `<title>` |
| `auth_token` file | exists, mode 0600 |
| `/api/sessions` without token | 401 |
| `/api/sessions` with token | 200 |
| Restart persistence | service still active + /api/health 200 after `systemctl restart` |
| Self-deploy path-unit | `supermux-deploy.path` is enabled |

## 10. Acceptance

A reviewer should be able to verify these on a build:

1. On a fresh Ubuntu 22.04 VM, the README one-liner installs supermux in
   < 30s wall-clock (post-download).
2. Re-running the same one-liner prints `already at vX.Y.Z; nothing to do`
   and exits 0 with no system changes.
3. `--dry-run` produces only `[dry]` lines; no service / binary / user / units appear.
4. A different process holding port 8824 causes an early-fail with a clear
   "port 8824 is in use" message and no binary / unit / data dir mutations.
5. Tailscale-up box: installer prints a `https://<host>.ts.net/` URL and
   that URL serves the PWA.
6. The in-UI updater on a v1-installed box can pull a future release via
   the path-unit chain (unchanged from the SSH-deploy install path).
7. The CI smoke matrix is green for every PR; the per-release e2e test
   passes before a tag is announced.

## 11. Out of scope

- Fedora / RHEL / Arch — apt-only in v1; demand-driven later.
- macOS install — `tmux` available but the user model is "develop", covered by
  `scripts/dev.sh`.
- Windows — relies on Unix primitives, unsupported. WSL2 works as a Linux host.
- Cosign / sigstore signing — SHA256 in v1; cosign keyless when we adopt
  the rest of the sigstore stack.
- A custom `get.supermux.io` redirect — GitHub raw URL is fine for v1; can be
  proxied later without a script-level change.
- Auto-installing missing `curl` (chicken-and-egg).
