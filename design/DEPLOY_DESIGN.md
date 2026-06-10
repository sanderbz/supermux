# Remote SSH sessions — design

This document describes the design for running Claude Code (and other shell
sessions) on a **remote host** from a single supermux server, with full
feature parity to local sessions: live terminal streaming, status detection,
file browser, git operations, and hook callbacks.

The goal: from the user's perspective, a remote session feels identical to a
local one. The only visible difference is a small host badge on the session
tile.

## Why this fits the existing architecture

The codebase has the right seams already:

- Every tmux operation funnels through a single `Tmux` type in
  `server/src/sessions/tmux.rs`.
- Every file operation funnels through `server/src/files/`.
- Every git operation shells out via `tokio::process::Command`.
- `Tmux` already accepts a target enum (`Session` / `Pane`) for the
  agent-teams feature.

This means remote support is an additive change: introduce a `Transport`
abstraction, swap `Command::new(...)` for `transport.spawn_command(...)`,
and keep every downstream consumer (the broadcast channel, replay ring,
WebSocket fan-out, status detector) byte-for-byte identical.

## Network plane

Two supported transports between the supermux server and a remote host:

1. **Tailscale (preferred).** When the remote host is on the same tailnet,
   the hook callback URL is just the supermux server's tailnet hostname —
   the remote `claude` process dials it directly with no tunnel. The
   server's WebSocket origin allowlist already includes `*.ts.net`.

2. **SSH reverse-tunnel (fallback).** `ssh -R <port>:127.0.0.1:<port> host`
   makes the supermux server reachable on the remote's localhost. Less
   robust (re-tunnels on every SSH reconnect) but works behind NAT without
   any overlay network.

For the tmux control channel, supermux uses **SSH ControlMaster**: one
persistent multiplexed TCP connection per host, opened on first use and
shared by every subsequent `Tmux` call for that host. After warm-up,
per-call overhead is sub-millisecond.

## High-level architecture

```
                  ┌─────────────────────────────┐
                  │ supermux server (one binary)│
                  │  + HostPool                 │
                  │    └─ SSH ControlMasters    │
                  └──────┬──────────┬───────────┘
                         │          │
              local      │          │   ssh ControlMaster (1 per host)
              exec       │          │
                         ▼          ▼
                   ┌──────────┐  ┌──────────┐
                   │  local   │  │  remote  │
                   │  tmux    │  │  tmux    │
                   │  + claude│  │  + claude│
                   └──────────┘  └──────────┘
                                 │
                           hook callback
                           (HTTP to supermux,
                            Tailscale or reverse-tunnel)
```

## Components

### Transport

A `Transport` enum wraps the difference between local and remote command
execution:

```rust
pub enum Transport {
    Local,
    Ssh { host_id: HostId, ssh_target: String, control_path: PathBuf },
}

impl Transport {
    pub fn spawn_command(&self, program: &str, args: &[&str])
        -> tokio::process::Command;
}
```

For `Local`, this is just `Command::new(program).args(args)`. For `Ssh`,
it wraps the command in:

```
ssh -o ControlPath=<path>
    -o ControlMaster=auto
    -o ControlPersist=600
    <target> -- <program> <args...>
```

`Tmux` carries a `&Transport` reference. Every `Command::new("tmux")`
becomes `self.transport.spawn_command("tmux", &[...])`. Argument
construction is otherwise unchanged.

### Hosts table

Persistent host records live in SQLite:

```sql
CREATE TABLE hosts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,     -- user-facing label, e.g. "ml-rig"
    ssh_target   TEXT NOT NULL,            -- e.g. "user@ml-rig.tailnet.ts.net"
    ssh_key_path TEXT,                     -- null = use ~/.ssh/config + agent
    status       TEXT NOT NULL DEFAULT 'unknown'
                 CHECK (status IN ('unknown','reachable','unreachable')),
    last_seen    INTEGER,                  -- unix seconds
    created_at   INTEGER NOT NULL,
    deleted_at   INTEGER
);
ALTER TABLE sessions ADD COLUMN host_id INTEGER REFERENCES hosts(id);
CREATE INDEX idx_sessions_host_id ON sessions(host_id);
```

A `NULL` `host_id` means **local** — preserving the current behavior for
every existing session and every new session that doesn't pick a host.

### HostPool

`HostPool` lives in `AppState` and manages SSH ControlMasters:

- Per-host `Mutex<HostState>` tracks the control socket path, master PID,
  and last-used timestamp.
- `transport_for(host_id)` ensures a master is running (spawning one with
  `ssh -o ControlMaster=yes -o ControlPersist=600 -fN <target>` if not),
  then returns an `Arc<Transport::Ssh { ... }>`.
- Liveness checks use `ssh -O check`. Broken masters are torn down with
  `-O exit` and respawned.
- Failure handling: exponential backoff on repeated failures
  (100ms, 500ms, 2s, 10s) then mark host `unreachable`.
- A background reaper task tears down idle ControlMasters after ~10
  minutes of inactivity, but never while any session on that host is
  `running`.

### File transport

A `FileTransport` trait abstracts file operations:

```rust
#[async_trait]
pub trait FileTransport: Send + Sync {
    async fn read(&self, path: &Path) -> Result<Vec<u8>>;
    async fn write(&self, path: &Path, content: &[u8]) -> Result<()>;
    async fn list_dir(&self, path: &Path) -> Result<Vec<DirEntry>>;
    async fn stat(&self, path: &Path) -> Result<Stat>;
    async fn delete(&self, path: &Path) -> Result<()>;
    async fn rename(&self, from: &Path, to: &Path) -> Result<()>;
}
```

Two implementations:

- `LocalFileTransport` — wraps `tokio::fs`.
- `SshFileTransport` — SFTP over the host's existing ControlMaster TCP
  channel (multiplexed, not a new connection).

The file browser handlers resolve `FileTransport` from the session's
`host_id`. Path-safety blocklists become transport-aware: the rules are
unchanged, but `canonicalize` is performed via the transport's `stat`.

### Hook installation

`install_hooks()` takes `&dyn FileTransport` instead of using `std::fs`
directly. The atomic temp-file-plus-rename dance is preserved on both
sides: POSIX rename is atomic within a filesystem, and SFTP's `RENAME` is
required to be atomic by RFC 4253.

The hook callback URL needs special handling for remote sessions. Today,
the local hook posts to `http://127.0.0.1:<port>`. For a remote session,
the hook must reach the supermux server from the remote machine:

- Default: server's first non-loopback bind address.
- Override: a `remote_callback_url` config field (typically the tailnet
  hostname or the reverse-tunnel localhost address).

The environment variable injected into the remote tmux pane uses this
URL instead of `127.0.0.1`.

### PTY-over-SSH stream (the hard one)

Local sessions stream tmux output via `mkfifo` + `O_NONBLOCK` + `AsyncFd`
with a long-lived keep-alive write fd to prevent spurious EOFs when
tmux's `tee` momentarily closes the pipe.

The remote path mirrors this idea over SSH:

1. On `ensure_started`: `ssh host -- mkfifo /tmp/supermux-pty-<name>.fifo`
   (idempotent; ignore `EEXIST`).
2. `ssh host -- tmux pipe-pane -O -t supermux-<name> 'tee -a <log> > <fifo>'`
   (over the ControlMaster, so the round-trip is cheap).
3. Spawn two long-lived child processes through the ControlMaster:
   - **Reader**: `ssh -o ControlPath=<cp> host -- cat <fifo>`. Its stdout
     feeds the existing per-session broadcast channel: 8 KB chunks, push
     into `replay`, `broadcast.send(chunk)`.
   - **Keep-alive writer**: `ssh -o ControlPath=<cp> host -- sh -c
     'exec 9> <fifo>; sleep infinity'`. Holds a writer fd open so the
     reader doesn't EOF when tmux's `tee` closes mid-flight.
4. On reader EOF or non-zero exit: check whether tmux still exists via
   the transport. If gone → stream-dead. Otherwise → exponential backoff
   re-spawn (the master may have reconnected; the reader re-attaches to
   the same FIFO instantly because the keep-alive writer still holds it).
5. If the ControlMaster itself dies, the `HostPool` detects it and
   respawns the master; our reader child exits and we re-spawn it. The
   replay buffer is preserved across respawns, so reconnecting WebSocket
   clients see no gap.

Everything **downstream** of the per-session sink — the broadcast
channel, replay ring buffer, WebSocket fan-out, status-detector
wake-on-edge — is unchanged. The reader is abstracted behind a `PtyReader`
trait with `Local` and `Ssh` implementations; `PtyStream::ensure_started`
picks one based on `session.host_id`.

Invariants the remote reader must preserve:

1. **No spurious EOF.** The keep-alive writer is non-negotiable — without
   it, every momentary close of tmux's tee would close the pipe.
2. **Backpressure.** A lagging subscriber gets dropped (WebSocket close
   1013); we never block the reader.
3. **ControlMaster respawn.** Reader survives a master restart by waiting
   (poll every ~200ms, up to 30s) for the pool to bring the master back,
   then re-spawning its `cat` child.
4. **Stream-dead vs. transport-dead.** Distinguish "ssh master gone" from
   "remote tmux session gone" via `Tmux::exists()` over the transport.

### Cross-host reattach on startup

On server boot, supermux scans local tmux for `supermux-*` sessions and
rehydrates them. With remote hosts, this extends to:

1. Iterate every non-deleted host.
2. For each host, get a `Transport` from the pool (best-effort; if SSH
   fails, log a warning and mark the host `unreachable` but **don't
   block boot**). Wrap each call in a 5s timeout.
3. Run `tmux ls` via the transport; pattern-match `supermux-*` names.
4. For each session row whose `host_id` matches: if the remote tmux
   session is still alive, keep it running; if not, mark stopped; if
   alive but the supermux row says stopped, mark unknown for review.

### Host management API

REST endpoints under `/api/hosts`:

- `GET /api/hosts` — list (filters out soft-deleted).
- `POST /api/hosts` — create `{name, ssh_target, ssh_key_path?}`.
- `GET /api/hosts/{id}` — details + last status.
- `DELETE /api/hosts/{id}` — soft delete; refuses (409) when active
  sessions still reference the host.
- `POST /api/hosts/{id}/check` — runs `ssh <target> -- echo ok`, updates
  status and last-seen.
- `POST /api/hosts/{id}/bootstrap` — sshs in and runs a small setup
  script: verifies tmux is installed, creates the per-user state
  directory, optionally `ssh-copy-id` if a public key is provided.
  Returns a checklist: `{tmux_installed, tmux_version, state_dir,
  claude_installed, warnings: [...]}`.

### Frontend

- A **Hosts** screen lists, adds, checks, and deletes hosts.
- The session-create flow gains a **host picker** dropdown (default
  "Local"). The selected host is sent as `host_id` in the POST body.
- The session tile shows a small **host badge** (globe icon + truncated
  hostname) when `session.host_id != null`. Local sessions are
  unchanged.
- An onboarding sheet walks the user through SSH key setup, Tailscale
  setup, or whichever transport they prefer.

## What stays the same

Everything downstream of the sink and transport seams:

- Per-session broadcast channel with replay buffer.
- WebSocket fan-out with backpressure (1013 close on lag, subscriber cap).
- Status detector and wake-on-edge signal.
- Hook callback HTTP handlers.
- Git operation handlers (they shell out through `Command`, which becomes
  `transport.spawn_command`).
- Path-safety blocklists for the file browser.

## Acceptance — what "done" looks like

A remote session must be functionally indistinguishable from a local one:

- A keystroke sent over the WebSocket appears in the live byte stream
  within ~100 ms (plus SSH RTT).
- The status detector flips Active → Idle within 5 s of a remote shell
  going quiet.
- The file browser reads, writes, lists, renames, and deletes on the
  remote filesystem, with path-safety enforced identically.
- Hooks installed on the remote write to the remote's
  `~/.claude/settings.json`, atomically merged with the marker preserved,
  and the injected callback URL is reachable from the remote.
- Killing the SSH ControlMaster mid-stream causes no WebSocket
  disconnect — the replay buffer stays warm and the reader respawns.
- The server boots cleanly when some hosts are unreachable; unreachable
  hosts are surfaced in the UI but do not block startup.
