# Develop supermux on the server, and deploy it to itself

This is the "dogfood" workflow: open a supermux session on the deployed box
whose working dir is a real git clone of supermux, run Claude there, edit the
code, and run a single command to rebuild and restart the running service — it
comes back online by itself, and the session that ran the deploy survives the
restart.

## Why this is safe

- **No bricking.** `scripts/deploy-self.sh` builds *first*. If the build fails,
  the running service is never touched and keeps serving the old binary. The
  privileged install+restart step backs up the current binary, installs the new
  one, restarts, then verifies `systemctl is-active` **and** the loopback
  `/api/health`. If the new build fails to come up, it **rolls back** to the
  backed-up binary and restarts — prod cannot be left down.
- **Session survival.** The supermux unit uses `KillMode=process` and anchors
  `TMUX_TMPDIR` in the persistent data dir (`~/.supermux/tmux`). A
  `systemctl restart supermux` therefore leaves the tmux server (and every
  session, including the one running the deploy) alive. The new server process
  reattaches to them on boot (`reconcile_on_boot`).
- **Least privilege.** The service user has no general sudo. The only privileged
  action it can take is one fixed, root-owned helper
  (`/usr/local/sbin/supermux-deploy-self`), granted by a scoped sudoers rule.
  The helper hardcodes the install destination and the unit name, so the grant
  cannot be repurposed.

## One-time setup on the host

1. **Clone the repo** into a project dir the service can read+write (one inside
   the unit's `ReadWritePaths`, e.g. `/opt/projects`), as the service user:

   ```
   sudo -u supermux -H git clone https://github.com/sanderbz/supermux.git \
     /opt/projects/supermux
   ```

2. **Install the privileged helper + sudoers rule** (run once, as root, from the
   clone):

   ```
   cd /opt/projects/supermux
   sudo install -m 0755 -o root -g root etc/supermux-deploy-self \
        /usr/local/sbin/supermux-deploy-self
   sudo install -m 0440 -o root -g root etc/sudoers.d/supermux-deploy-self \
        /etc/sudoers.d/supermux-deploy-self
   sudo visudo -cf /etc/sudoers.d/supermux-deploy-self   # validate
   ```

   The helper **must** be root-owned and not group/world-writable (`0755
   root:root`) — otherwise the NOPASSWD grant would be a root escalation.

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

It will (optionally) `git pull --ff-only`, build, then install+restart+verify
via the helper. The service blips for a moment and comes back; your terminal is
still attached.

### Knobs

- `SUPERMUX_SELF_NO_PULL=1` — skip the `git pull` (deploy exactly local HEAD).
- `SUPERMUX_SELF_HELPER=/path` — override the helper path (default
  `/usr/local/sbin/supermux-deploy-self`).

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
