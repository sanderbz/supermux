# Develop supermux on the server, and deploy it to itself

This is the "dogfood" workflow: open a supermux session on the deployed box
whose working dir is a real git clone of supermux, run Claude there, edit the
code, and run a single command to rebuild and restart the running service — it
comes back online by itself, and the session that ran the deploy survives the
restart.

## Why this is safe

- **No bricking.** The root runner builds *first* — as the service user via
  `runuser`, in the agent's clone. If the build fails the runner exits before
  any install step, and the running service keeps serving the old binary. On
  build success, the runner backs up the current binary, installs the new one,
  restarts, then verifies `systemctl is-active` **and** the loopback
  `/api/health`. If the new build fails to come up, it **rolls back** to the
  backed-up binary and restarts — prod cannot be left down. The runner streams
  its progress to a log file in the data dir, which `deploy-self.sh` tails so
  you watch build/backup/install/restart/rollback live.
- **Session survival.** The supermux unit uses `KillMode=process` and anchors
  `TMUX_TMPDIR` in the persistent data dir (`~/.supermux/tmux`). A
  `systemctl restart supermux` therefore leaves the tmux server (and every
  session, including the one running the deploy) alive. The new server process
  reattaches to them on boot (`reconcile_on_boot`).
- **No sudo (it can't work anyway), no escalation, no sandboxed build.** The
  supermux unit is hardened with `NoNewPrivileges=true`, `RestrictSUIDSGID=true`,
  an empty `CapabilityBoundingSet`, and a `SystemCallFilter` that drops
  `@privileged` — **each** of which independently neuters setuid/`sudo`, and
  the syscall filter also blocks `make` from spawning `/bin/sh`, so a
  vendored-OpenSSL release build from inside this sandbox can hit a hard wall
  when cargo's openssl-sys cache is cold. Every child of the service (including
  the agent's tmux session) inherits all of that, so neither sudo nor a
  release-build from inside supermux is reliable. Instead, `deploy-self.sh`
  writes a small request file (zero privilege) into
  `$SUPERMUX_DATA_DIR/deploy/request` carrying `source_dir=<the clone>`. A
  root-side systemd **`.path`** unit (`supermux-deploy.path`) watches it and
  starts a root oneshot (`supermux-deploy.service`) that runs
  `/usr/local/sbin/supermux-deploy-runner` **outside** the supermux.service
  sandbox. The runner builds as the service user via `runuser` (so cargo+bun
  resolve from that user's home and the cache stays consistent with normal use,
  but no SystemCallFilter applies — make works normally), then installs +
  restarts. It hardcodes the install destination + unit name, only replaces the
  *unprivileged* service binary, and only restarts the *unprivileged* unit — so
  it grants the agent **no** privilege it lacks. It just bridges "the agent
  wrote a file" → "root builds (as service user) + installs + restarts". The
  hardening is never relaxed.

## One-time setup on the host

Step 2 (the runner + the two systemd units) is now wired **automatically** by a
normal `scripts/deploy.sh` run — there is nothing to install by hand.

1. **Clone the repo** into a project dir the service can read+write (one inside
   the unit's `ReadWritePaths`, e.g. `/opt/projects`), as the service user:

   ```
   sudo -u supermux -H git clone https://github.com/sanderbz/supermux.git \
     /opt/projects/supermux
   ```

2. **Self-deploy wiring is automatic.** A normal deploy from your workstation
   (`scripts/deploy.sh`) renders + installs the root runner
   (`/usr/local/sbin/supermux-deploy-runner`, `0755 root:root`) and the two
   systemd units (`supermux-deploy.path` + `supermux-deploy.service`), enables
   the `.path` watcher, provisions `$SUPERMUX_DATA_DIR/deploy/` (service-user
   writable), and removes any stale `etc/sudoers.d/supermux-deploy-self` +
   `/usr/local/sbin/supermux-deploy-self` from the old sudo approach. The runner
   **must** stay root-owned and not group/world-writable (`0755 root:root`),
   which `deploy.sh` enforces via `install -m 0755 -o root -g root`.

3. **Verify the dev toolchain** is present for the service user (`bun`, `cargo`,
   `node`, `git`, `gh`, `claude`, `tmux`). `scripts/deploy-self.sh` sources
   `~/.cargo/env` and prepends `~/.bun/bin`, so user-local installs resolve.

## Daily use

From inside the supermux panel, open (or create) a session whose dir is the
clone, run Claude, edit code, then:

```
cd /opt/projects/supermux
scripts/deploy-self.sh
```

It will (optionally) `git pull --ff-only`, then write a deploy request that the
root `.path` unit picks up. The runner then builds (as the service user, via
`runuser`), backs up, installs, restarts, verifies, and rolls back if anything
fails. The service blips for a moment and comes back; your terminal is still
attached (`KillMode=process` + persistent `TMUX_TMPDIR`), and the script tails
the runner's log so you see the result live. If anything stalls, inspect:

```
journalctl -u supermux-deploy -n 50 --no-pager
systemctl status supermux-deploy.path --no-pager
```

### Knobs

- `SUPERMUX_SELF_NO_PULL=1` — skip the `git pull` (deploy exactly local HEAD).
- `SUPERMUX_DATA_DIR=/path` — data dir holding `deploy/request` + the runner's
  log/status (default `$HOME/.supermux`; the systemd unit exports this into the
  agent's environment, so you normally don't set it).
- `SUPERMUX_REPO_DIR=/path` — override the auto-detected repo dir (the in-UI
  updater looks at `/opt/projects/supermux` then walks up from CWD). Useful
  for non-standard layouts.

## In-UI updater (v0.3.0+)

Settings → Updates is the UI for the same pipeline. It polls
`/api/version` every 30 seconds while the page is open, compares the
running binary's tag against the latest GitHub release, and offers a
**Update now** button when an upgrade is safe to apply. Click → confirm
the rendered release notes → live SSE progress (fetching / building /
installing / verifying / done) → "Reload" to load the new bundle. On a
build failure the runner rolls back (`/usr/local/bin/supermux-server.prev`
restored, service restarted) and the modal shows the rollback step plus
the exact `journalctl -u supermux-deploy -n 100` command to dig deeper.

The preflight refuses unsafe upgrades — surfacing actionable English copy
for each case — instead of hiding the button silently:

| Scenario | UI shows |
|---|---|
| Dirty working tree | "The clone has N uncommitted changes. Commit or stash them before updating." |
| Local commits ahead of origin | "The clone has N unpushed commits ahead of origin. Push or reset before updating." |
| Branch ≠ main | "The clone is on `feat/foo`, not `main`. Switch with `git checkout main`." |
| Detached HEAD | "You're on a detached HEAD — typically a pinned version. Run `git checkout main`." |
| cargo / bun / git missing | "`<tool>` isn't on PATH. Install it for the supermux service user." |
| < 2 GB free | "Only N MB free on /opt/projects/supermux. The release build needs ~2 GB." |
| Bare binary / dev install | "Auto-update is only available on systemd installs. Run `cd <repo> && bash scripts/update.sh`." |
| Docker | "supermux is running in a Docker container. Pull the latest image and recreate." |

The 1-click button is bearer-gated by the same AUTH_TOKEN as the rest of
`/api`. There is no auto-update — the upgrade only ever runs after an
explicit click.

### Advanced — private repos / rate limits

The updater fetches `releases/latest` from GitHub anonymously by default. This
works for every user on the public `sanderbz/supermux` repo. Set a token only
if you hit one of these:

- **You self-host a PRIVATE fork.** GitHub returns 404 to anonymous requests
  against private repos, which the UI surfaces as *"Couldn't reach GitHub"*.
- **You're behind a shared NAT** (office IP, CGNAT, big cloud egress) and
  share the 60-req/hour unauthenticated quota with other callers.

Mint a PAT at <https://github.com/settings/tokens> with scope `public_repo`
(public fork) or `repo` (private fork), then either set the env var in the
systemd unit (preferred — never lands on disk in your config):

```
sudo systemctl edit supermux
# add under [Service]:
#   Environment=SUPERMUX_GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
sudo systemctl restart supermux
```

…or add `github_token = "ghp_…"` to `$SUPERMUX_DATA_DIR/config.toml`. The env
var wins if both are set. There is no UI surface — the value is read once at
startup and sent as an `Authorization: Bearer <token>` header on every release
fetch. Unset: anonymous fetch (the default). Wrong value: GitHub returns 401
and the UI falls back to its existing *"Couldn't reach GitHub"* state.

## Troubleshooting: "Claude won't render in the dev session"

Two distinct failure modes can leave the dev session showing only the shell
prompt (no Claude UI). They look identical in the panel but have different
causes and fixes.

### 1. First-launch workspace-trust dialog (FIXED in code)

The **first** time Claude is launched in a directory it has never seen, it
shows a blocking *"Do you trust the files in this folder?"* prompt. This is a
SEPARATE gate from permission prompts — `--dangerously-skip-permissions` does
**not** skip it. A freshly-cloned project dir (like the supermux source on the
box) hits this on its very first session and hangs there forever, never
reaching the `❯` prompt.

`wait_for_agent_ready` (server/src/sessions/lifecycle.rs) now detects this
dialog and auto-accepts it (Enter on the default "Yes, I trust this folder"),
which also records the dir as trusted in `~/.claude.json` so it never reappears.
You can also pre-trust a dir without launching by adding it to
`~/.claude.json`'s `projects` map with `"hasTrustDialogAccepted": true`.

### 2. A degraded long-lived tmux server

Independently, a tmux **server** process that has been running for a very long
time can reach a state where it can no longer spawn panes that render a native
TUI like Claude's (plain stdout still works, but Claude's full-screen UI paints
nothing). This is a property of the specific tmux *server* instance, not the
directory, the user, the seccomp sandbox, or Claude itself — verified by
launching the identical `claude` binary, as the same service user, in the same
dir, under the same systemd `SystemCallFilter`: a **fresh** tmux server renders
perfectly while the old one does not.

`systemctl restart supermux` does NOT cure this — `KillMode=process` keeps the
tmux server (and all sessions) alive across the restart by design. Recreating
the tmux server is what fixes it, which happens on the next machine reboot (or
by deliberately killing the tmux server, which also ends every running
session — only do that when those sessions are expendable). New tmux servers
spawn rendering panes correctly.
