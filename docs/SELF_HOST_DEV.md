# Develop supermux on the server, and deploy it to itself

This is the "dogfood" workflow: open a supermux session on the deployed box
whose working dir is a real git clone of supermux, run Claude there, edit the
code, and run a single command to rebuild and restart the running service — it
comes back online by itself, and the session that ran the deploy survives the
restart.

## Why this is safe

- **No bricking.** `scripts/deploy-self.sh` builds *first*. If the build fails,
  the running service is never touched and keeps serving the old binary. The
  root runner then backs up the current binary, installs the new one, restarts,
  then verifies `systemctl is-active` **and** the loopback `/api/health`. If the
  new build fails to come up, it **rolls back** to the backed-up binary and
  restarts — prod cannot be left down. The runner streams its progress to a log
  file in the data dir, which `deploy-self.sh` tails so you watch
  backup/install/restart/rollback live.
- **Session survival.** The supermux unit uses `KillMode=process` and anchors
  `TMUX_TMPDIR` in the persistent data dir (`~/.supermux/tmux`). A
  `systemctl restart supermux` therefore leaves the tmux server (and every
  session, including the one running the deploy) alive. The new server process
  reattaches to them on boot (`reconcile_on_boot`).
- **No sudo (it can't work anyway), no escalation.** The supermux unit is
  hardened with `NoNewPrivileges=true`, `RestrictSUIDSGID=true`, an empty
  `CapabilityBoundingSet`, and a `SystemCallFilter` that drops `@privileged` —
  **each** of which independently neuters setuid/`sudo`. Every child of the
  service (including the agent's tmux session) inherits this, so `sudo` can
  **never** run as root from inside supermux. Instead, `deploy-self.sh` writes a
  small request file (zero privilege) into `$SUPERMUX_DATA_DIR/deploy/request`;
  a root-side systemd **`.path`** unit (`supermux-deploy.path`) watches it and
  starts a root oneshot (`supermux-deploy.service`) that runs
  `/usr/local/sbin/supermux-deploy-runner` **outside** the sandbox. The runner
  hardcodes the install destination + unit name, only replaces the
  *unprivileged* service binary, and only restarts the *unprivileged* unit — so
  it grants the agent **no** privilege it lacks. It just bridges "the agent
  wrote a file" → "root installs + restarts". The hardening is never relaxed.

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

It will (optionally) `git pull --ff-only`, build, then write a deploy request
that the root `.path` unit picks up to install+restart+verify+rollback. The
service blips for a moment and comes back; your terminal is still attached
(`KillMode=process` + persistent `TMUX_TMPDIR`), and the script tails the
runner's log so you see the result live. If anything stalls, inspect:

```
journalctl -u supermux-deploy -n 50 --no-pager
systemctl status supermux-deploy.path --no-pager
```

### Knobs

- `SUPERMUX_SELF_NO_PULL=1` — skip the `git pull` (deploy exactly local HEAD).
- `SUPERMUX_DATA_DIR=/path` — data dir holding `deploy/request` + the runner's
  log/status (default `$HOME/.supermux`; the systemd unit exports this into the
  agent's environment, so you normally don't set it).

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
