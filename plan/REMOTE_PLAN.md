# supermux — Remote SSH milestones (RT1–RT10)

This is the feature plan for adding remote-host Claude Code sessions to supermux.
The goal is **100% feature parity** with local sessions: live terminal, status
detector, files browser, git ops, hook callbacks — all working when the agent
runs on a different machine, connected via SSH.

This document follows the same §10 contract as the original
`/opt/amux-v3/plan/TECH_PLAN.md` so the supermux-build orchestration pattern
applies: parse milestones, build dep graph, dispatch in parallel waves, run
critics, serial-merge into `feat/remote-ssh`.

## Background — why this is feasible without rearchitecture

The codebase already has the right seam: every tmux operation funnels through
`server/src/sessions/tmux.rs::Tmux` (864 LOC), every file op funnels through
`server/src/files/`, every git op shells out via `tokio::process::Command`.
`Tmux` already accepts a `TmuxTarget` enum (`Session` / `Pane`) for the
agent-teams feature — we add a `Transport` enum alongside it.

## Network plane

- **Tailscale-or-direct preferred**. Server's WS origin allowlist already
  includes `*.ts.net` (ARCHITECTURE.md §1.4). When the remote host is on the
  same tailnet, the hook callback URL (`SUPERMUX_URL`) is just the supermux
  server's tailnet hostname — remote `claude` dials it directly, no tunnel.
- **SSH ControlMaster for tmux command channels** — one persistent multiplexed
  TCP per host, opened on first use, shared by every `Tmux` call for that
  host. Sub-millisecond per-call after warm-up.
- **SSH reverse-tunnel as fallback** when Tailscale isn't available:
  `ssh -R 8823:127.0.0.1:8823 host` makes the supermux server reachable on the
  remote's localhost. Less robust than Tailscale (re-tunnels on every SSH
  reconnect) but works behind NAT.

## High-level architecture

```
                      ┌─────────────────────────────┐
                      │ supermux-server (one binary) │
                      │  + HostPool                  │
                      │    └─ SSH ControlMasters     │
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
                               (HTTP to SUPERMUX_URL,
                                Tailscale or reverse-tunnel)
```

## Milestone graph

```
RT1 (Transport enum) ─┬─→ RT2 (HostPool + ControlMaster) ─┬─→ RT3 (PTY-over-SSH) ★
                      │                                   ├─→ RT5 (install_hooks SFTP)
                      │                                   └─→ RT6 (FileTransport)
                      │
                      └─→ RT7 (Reattach across hosts) ─┐
                                                       │
RT4 (DB migration) ───┴─→ RT8 (Host CRUD) ─→ RT9 (FE) ─┴─→ RT10 (Integration ★)
```

★ = bottleneck milestone (PTY-over-SSH is the hard one; RT10 gates ship).

## 10. Milestone breakdown

### RT1 — Backend: Transport enum + Tmux refactor

- **Depends on**: nothing.
- **Scope** (~300 LOC): Introduce `Transport` enum in
  `server/src/sessions/transport.rs`:
  ```rust
  pub enum Transport {
      Local,
      Ssh { host_id: HostId, ssh_target: String, control_path: PathBuf },
  }
  impl Transport {
      pub fn spawn_command(&self, program: &str, args: &[&str]) -> tokio::process::Command;
      // Local: Command::new(program).args(args)
      // Ssh:   Command::new("ssh").args(["-o","ControlPath=<path>","-o","ControlMaster=auto",
      //                                  "-o","ControlPersist=600", target, "--", program, args...])
  }
  ```
  Refactor `Tmux<'a>` to carry a `transport: &'a Transport`. Every
  `Command::new("tmux")` in `tmux.rs` becomes
  `self.transport.spawn_command("tmux", &[...])`. The `TmuxTarget` arg
  construction is unchanged.
- **Files**: `server/src/sessions/transport.rs` (NEW), `server/src/sessions/tmux.rs`
  (refactor every `Command::new` callsite), `server/src/sessions/mod.rs`
  (`pub mod transport;`).
- **Backwards compat**: all existing callers pass `&Transport::Local`. A
  helper `Tmux::new_local(name)` keeps current call sites one-line. No
  behaviour change for local sessions.
- **Acceptance**:
  - `cargo build --release` succeeds in the worktree.
  - All existing `cargo test` pass — no regressions.
  - Manual smoke: create a local session, send-keys, peek output works.
  - `git diff --stat` shows changes ONLY in `server/src/sessions/`.
- **Verification**: `cd server && cargo test --release` green.
- **Subagent prompt**:
  > You are implementing RT1 of the supermux remote-ssh feature. Read
  > `/opt/projects/supermux-remote-ssh/plan/REMOTE_PLAN.md` (this file)
  > completely and `server/src/sessions/tmux.rs` end-to-end.
  >
  > Your worktree is `/opt/projects/supermux-remote-ssh-wt/RT1` on branch
  > `milestone/RT1` off `feat/remote-ssh`. cd there before any file ops.
  >
  > Create `server/src/sessions/transport.rs` with the `Transport` enum and
  > `spawn_command()` method exactly as specified above. Use a small
  > `HostId(pub i64)` newtype for now (the `hosts` table is RT4 — for now
  > just a placeholder).
  >
  > Refactor `Tmux` to take `transport: &'a Transport`. Update every
  > callsite in `tmux.rs` from `Command::new("tmux").args(...)` to
  > `self.transport.spawn_command("tmux", &[...])`. Add
  > `Tmux::new_local(name)` and `Tmux::for_pane_local(pane_id)` helpers that
  > thread in a static `&Transport::Local`. Update every existing caller of
  > `Tmux::new` and `Tmux::for_pane` in the codebase to use the new helpers.
  > Use `grep -rn "Tmux::new\|Tmux::for_pane" server/src` to find them all.
  >
  > Acceptance: `cargo build --release` succeeds; `cargo test --release`
  > passes; no behavior change for local sessions.
  >
  > When done, write `/opt/projects/supermux-remote-ssh/skill/done/RT1.done.json`:
  > ```json
  > {"milestone":"RT1","status":"done","commit":"<sha>","files_changed":<n>,
  >  "tests_run":"<output snippet>","notes":"..."}
  > ```
  > Commit with message `RT1: Transport enum + Tmux refactor`. Reply with
  > one line: `done — RT1.done.json written, commit <sha>`.

### RT4 — Backend: hosts table + sessions.host_id migration

- **Depends on**: nothing.
- **Scope** (~150 LOC + migration): New migration
  `server/migrations/0XXX_hosts.sql`:
  ```sql
  CREATE TABLE hosts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL UNIQUE,           -- user-facing label, e.g. "ml-rig"
      ssh_target   TEXT NOT NULL,                  -- e.g. "user@ml-rig.tailnet.ts.net"
      ssh_key_path TEXT,                           -- null = use ~/.ssh/config + agent
      status       TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','reachable','unreachable')),
      last_seen    INTEGER,                        -- unix seconds
      created_at   INTEGER NOT NULL,
      deleted_at   INTEGER
  );
  ALTER TABLE sessions ADD COLUMN host_id INTEGER REFERENCES hosts(id);
  CREATE INDEX idx_sessions_host_id ON sessions(host_id);
  ```
  (`host_id = NULL` means LOCAL — preserves current behavior.)
  
  Add `server/src/db/hosts.rs` with `Host` struct + queries: `list`, `get`,
  `get_by_name`, `create`, `update_status`, `soft_delete`.
- **Files**: `server/migrations/0XXX_hosts.sql` (NEW), `server/src/db/hosts.rs`
  (NEW), `server/src/db/mod.rs` (`pub mod hosts;`), `server/src/db/sessions.rs`
  (add `host_id: Option<i64>` to the `Session` struct + queries that
  read/write it).
- **Acceptance**:
  - `cargo sqlx prepare --workspace` (or equivalent) doesn't fail.
  - Migration runs cleanly on a fresh `~/.supermux/data.db`.
  - A non-empty existing db migrates (host_id null on all rows).
  - `db::hosts::create()` + `db::hosts::list()` round-trip.
- **Verification**: `cargo test db::hosts` green.
- **Subagent prompt**:
  > You are implementing RT4 of the supermux remote-ssh feature. Read
  > `/opt/projects/supermux-remote-ssh/plan/REMOTE_PLAN.md` (this file)
  > and `server/migrations/*.sql` for naming conventions and
  > `server/src/db/sessions.rs` for the model pattern.
  >
  > Worktree: `/opt/projects/supermux-remote-ssh-wt/RT4` on
  > `milestone/RT4`. cd there before any file ops.
  >
  > Number the migration ONE higher than the highest existing migration in
  > `server/migrations/`. Write the schema exactly as specified. Write
  > `server/src/db/hosts.rs` with the `Host` struct (sqlx FromRow + Serialize)
  > and the five queries. Update `db::sessions::Session` to include
  > `host_id: Option<i64>` and update every query (INSERT, SELECT, UPDATE) to
  > read/write the column. Use `sqlx::query_as!` where possible.
  >
  > Write `server/tests/hosts_db.rs` covering: create + get_by_name round-trip,
  > duplicate name returns Conflict, update_status changes status + last_seen,
  > soft_delete sets deleted_at but get_by_name still finds it (filter out
  > in `list`).
  >
  > Acceptance: migrations run on fresh db; cargo test green.
  >
  > When done write `skill/done/RT4.done.json`, commit
  > `RT4: hosts table + sessions.host_id migration`, reply one line.

### RT2 — Backend: HostPool + persistent SSH ControlMaster

- **Depends on**: RT1, RT4.
- **Scope** (~350 LOC): `server/src/sessions/host_pool.rs` —
  `HostPool` lives in `AppState`. Per-host: a `Mutex<HostState>` with
  `control_path: PathBuf`, `master_pid: Option<u32>`, `last_used: Instant`.
  
  `HostPool::transport_for(host_id) -> Result<Arc<Transport>>`:
  1. Look up host row in DB.
  2. Ensure ControlMaster is up: spawn
     `ssh -o ControlMaster=yes -o ControlPath=<path> -o ControlPersist=600 -fN <target>`
     if not already running (test with `ssh -o ControlPath=<path> -O check <target>`).
  3. Return `Arc<Transport::Ssh { host_id, ssh_target, control_path }>`.
  
  Auto-recover on broken master: detect via `-O check`, tear down with
  `-O exit`, respawn. Exponential backoff on repeated failures
  (100ms, 500ms, 2s, 10s, give up → mark host `unreachable`).
  
  Background reaper task: every 60s, mark hosts with `last_used > 10min` as
  candidates for ControlMaster teardown (don't tear down if any session on
  that host is `running`).
- **Files**: `server/src/sessions/host_pool.rs` (NEW),
  `server/src/state.rs` (add `host_pool: Arc<HostPool>`),
  `server/src/main.rs` (spawn reaper task).
- **Acceptance**:
  - On a host registered in DB, `transport_for(id)` returns a Transport
    that successfully runs `ssh ... true` in <1s after the first warm-up.
  - Second call same host: no new SSH process spawned (ControlMaster reuse).
  - Kill the master process externally → next call detects + respawns.
  - Mark host unreachable after 4 consecutive failures.
- **Verification**: `cargo test host_pool` green + manual: register a host
  pointing at `localhost` via ssh, call `transport_for` 10× in a loop,
  observe one ssh-master process via `ps`.
- **Subagent prompt**:
  > Implementing RT2: HostPool with persistent SSH ControlMaster.
  > Read REMOTE_PLAN.md (this file), `server/src/sessions/transport.rs`
  > (from RT1, already merged into `feat/remote-ssh`), and
  > `server/src/db/hosts.rs` (from RT4, already merged).
  >
  > Worktree: `/opt/projects/supermux-remote-ssh-wt/RT2` on `milestone/RT2`.
  > Branch is OFF `feat/remote-ssh` so RT1 + RT4 are already present.
  >
  > Implement `HostPool` per the spec. Use `tokio::sync::Mutex` (NOT std)
  > on `HostState`. ControlPath should be
  > `~/.supermux/ssh-control/cm-<host_id>` (mkdir 0700 the parent dir).
  > Use `tokio::process::Command` for ssh invocations. Add a `verify(id)`
  > method that runs `ssh -O check`; expose as `GET /api/hosts/{id}/check`
  > later (RT8).
  >
  > Add `host_pool: Arc<HostPool>` to `AppState`. Spawn the reaper task
  > in `main.rs` alongside the other background tasks.
  >
  > Test: `server/tests/host_pool.rs` with a localhost ssh fixture
  > (skip the test with `#[ignore]` if `ssh -o BatchMode=yes -o ConnectTimeout=1 localhost true`
  > fails — CI may not have it).
  >
  > Acceptance: cargo test green; manual ControlMaster reuse verified.
  >
  > done.json, commit `RT2: HostPool + SSH ControlMaster`, one-line reply.

### RT8 — Backend: Host CRUD + bootstrap endpoints

- **Depends on**: RT4.
- **Scope** (~250 LOC): HTTP handlers in `server/src/hosts/mod.rs`:
  - `GET /api/hosts` — list all (filter deleted).
  - `POST /api/hosts` — create `{name, ssh_target, ssh_key_path?}`.
  - `GET /api/hosts/{id}` — details + last status.
  - `DELETE /api/hosts/{id}` — soft delete; refuse if sessions are
    referencing it that are not stopped.
  - `POST /api/hosts/{id}/check` — runs `ssh <target> -- echo ok`,
    updates status + last_seen.
  - `POST /api/hosts/{id}/bootstrap` — sshs in, runs the small
    bootstrap script: verifies `tmux` is installed, creates
    `~/.supermux-remote/` dir, optionally `ssh-copy-id` if pubkey
    provided in body. Returns a checklist of what's installed / missing.
  
  Mount via `hosts::router_for(state)` pattern (matches M2 from §10).
- **Files**: `server/src/hosts/mod.rs` (NEW),
  `server/src/hosts/bootstrap.rs` (the per-host setup logic),
  `server/src/http.rs` (one-line merge of `hosts::router_for`).
- **Acceptance**:
  - All 5 endpoints respond per spec.
  - DELETE refuses (409) when an active remote session references it.
  - Bootstrap detects missing tmux and returns it in the checklist (no 500).
- **Verification**: `cargo test --test hosts_http` green.
- **Subagent prompt**:
  > Implementing RT8: Host CRUD + bootstrap endpoints. Read REMOTE_PLAN.md
  > and `server/src/sessions/mod.rs` for the `router_for` pattern.
  >
  > Worktree: `/opt/projects/supermux-remote-ssh-wt/RT8` on `milestone/RT8`.
  > RT4 (hosts table) is already in the base branch.
  >
  > Implement the 5 endpoints exactly per spec. Use the M2 `router_for`
  > registry pattern so `http.rs` gets ONE line of merge. For the bootstrap
  > endpoint, return a JSON checklist:
  > `{"tmux_installed": true, "tmux_version": "3.4", "supermux_dir": "created",
  >   "claude_installed": true, "warnings": [...]}`.
  >
  > Test in `server/tests/hosts_http.rs` covering happy paths + the 409
  > delete-with-active-session case.
  >
  > done.json, commit `RT8: hosts CRUD + bootstrap`, one-line reply.

### RT6 — Backend: FileTransport trait + SFTP impl

- **Depends on**: RT2.
- **Scope** (~400 LOC): Add `russh-sftp = "0.5"` and `russh = "0.45"` deps.
  Define a `FileTransport` trait:
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
  Implement `LocalFileTransport` (just `tokio::fs`) and
  `SshFileTransport` (russh-sftp client on top of the ControlMaster TCP
  channel — multiplexed via the existing ssh master, NOT a new TCP).
  
  Refactor `server/src/files/mod.rs` handlers to take a
  `&dyn FileTransport` resolved from `session.host_id`:
  - `host_id = None` → `LocalFileTransport`
  - `host_id = Some(id)` → `host_pool.file_transport(id)`
  
  Path-safety (`path_safe.rs`) becomes transport-aware — the blocklist still
  applies but `canonicalize` is done via the transport (`stat`).
- **Files**: `server/src/files/transport.rs` (NEW),
  `server/src/files/mod.rs` (refactor handlers),
  `server/src/files/path_safe.rs` (transport-aware),
  `server/Cargo.toml` (add russh + russh-sftp).
- **Acceptance**:
  - All existing local file tests pass (no regression).
  - New tests with a localhost SFTP fixture (or mocked transport) round-trip
    read/write/list/stat/rename/delete.
  - Path-safety blocks `/etc/shadow` over SFTP same as over local.
- **Verification**: `cargo test files` green.
- **Subagent prompt**:
  > Implementing RT6: FileTransport trait + SFTP. Read REMOTE_PLAN.md and
  > `server/src/files/mod.rs` end-to-end (877 LOC). Read RT2's
  > `host_pool.rs` (already in base branch) to understand how to share the
  > ControlMaster's session for SFTP.
  >
  > Worktree: `/opt/projects/supermux-remote-ssh-wt/RT6` on `milestone/RT6`.
  >
  > Implement the trait + both impls. For SFTP over the ControlMaster:
  > use russh-sftp's `SftpSession` opened on a russh `Channel` requested
  > from the existing SSH connection. (If russh-sftp doesn't multiplex via
  > ControlMaster cleanly, fall back to `ssh -S <control_path> -s sftp host`
  > with sftp-server over stdin/stdout — that's the "official" way.) Document
  > whichever path you picked.
  >
  > Refactor every handler in `files/mod.rs` to dispatch via the session's
  > `host_id`. Tests in `server/tests/files_transport.rs`.
  >
  > done.json, commit `RT6: FileTransport + SFTP`, one-line reply.

### RT5 — Backend: install_hooks via SFTP

- **Depends on**: RT2, RT6.
- **Scope** (~150 LOC): Refactor
  `server/src/claude_config.rs::install_hooks()` to take an
  `&dyn FileTransport` (instead of always using `std::fs`). The atomic
  temp-file + rename dance is preserved — both `LocalFileTransport` and
  `SshFileTransport` implement `rename` atomically (POSIX rename is atomic
  on the same filesystem; SFTP RENAME is required to be atomic per RFC 5).
  
  Callers: `sessions/lifecycle.rs::start()` looks up the session's host's
  FileTransport via the host_pool and passes it to `install_hooks`.
  
  Hook command also needs adjustment: today
  `$SUPERMUX_URL=http://127.0.0.1:8823` — for remote it must be the URL
  the remote can reach. Add a config field `remote_callback_url` (defaults
  to the server's first non-loopback bind, falls back to env override
  `SUPERMUX_REMOTE_URL`). Document the Tailscale-or-reverse-tunnel
  alternatives in the plan.
- **Files**: `server/src/claude_config.rs` (refactor),
  `server/src/sessions/lifecycle.rs` (callsite update),
  `server/src/config.rs` (new field).
- **Acceptance**:
  - Local sessions: hooks install in `~/.claude/settings.json` exactly as
    before (golden snapshot test).
  - Remote sessions (mocked or real): hooks installed in the REMOTE
    `~/.claude/settings.json`; the marker (`supermux-hook`) is intact;
    atomicity preserved (no partial writes on simulated failure).
  - `SUPERMUX_URL` injected into the remote tmux pane env is the
    callback URL, not `127.0.0.1`.
- **Verification**: `cargo test install_hooks_remote install_hooks_local`
  green.
- **Subagent prompt**:
  > Implementing RT5: install_hooks via FileTransport. Read REMOTE_PLAN.md
  > and `server/src/claude_config.rs` end-to-end. RT2 + RT6 are in the
  > base branch — `FileTransport` exists.
  >
  > Worktree: `/opt/projects/supermux-remote-ssh-wt/RT5` on `milestone/RT5`.
  >
  > Refactor `install_hooks(session_name, hook_token, transport: &dyn FileTransport)`.
  > Preserve the atomic-rename + marker-based idempotent merge invariants
  > exactly. Add a `remote_callback_url` to `Config`. In
  > `sessions/lifecycle.rs::start()`, when session has `host_id`, use the
  > remote transport AND set `SUPERMUX_URL` env to `remote_callback_url`.
  >
  > Tests: golden snapshot for local (unchanged output);
  > snapshot for remote (URL differs). Tests in
  > `server/tests/install_hooks_remote.rs`.
  >
  > done.json, commit `RT5: install_hooks via FileTransport`, one-line reply.

### RT3 — Backend: PTY-over-SSH stream (★ the hard one)

- **Depends on**: RT2.
- **Scope** (~500 LOC): Replace the local-FIFO reader in
  `server/src/sessions/pty.rs` with a transport-aware reader. Two paths:
  
  **Local path (unchanged)**: today's `mkfifo` +
  `O_NONBLOCK + AsyncFd` + keep-alive write fd. Already works.
  
  **SSH path**:
  1. On `ensure_started`, `ssh host -- mkfifo /tmp/supermux-pty-<name>.fifo`
     (idempotent; ignore EEXIST).
  2. `ssh host -- tmux pipe-pane -O -t supermux-<name> 'tee -a <log> > <fifo>'`
     (via the ControlMaster, so it's fast).
  3. Spawn TWO long-lived `tokio::process::Child` over the ControlMaster:
     - **Reader**: `ssh -o ControlPath=<cp> host -- cat <fifo>`. Pipe its
       stdout into the existing per-session broadcast channel (chunks
       of 8 KB, push to `replay`, `broadcast.send(chunk)`).
     - **Keep-alive writer**: `ssh -o ControlPath=<cp> host -- sh -c
       'exec 9> <fifo>; sleep infinity'` — keeps a writer fd open so the
       reader doesn't EOF when tmux's tee momentarily closes.
  4. On reader EOF or non-zero exit: check `tmux exists` via the
     transport; if gone, stream-dead. Otherwise, exponential backoff
     re-spawn reader (master may have reconnected; readers re-attach
     to the same FIFO instantly because the keep-alive writer is still
     holding it).
  5. ControlMaster failure → HostPool detects, respawns master, our
     reader child exits → we re-spawn it. Replay buffer preserved.
  
  The downstream `broadcast` channel, `replay` ring buffer, WS
  fan-out, status-detector wake-on-edge — all UNCHANGED.
- **Files**: `server/src/sessions/pty.rs` (major refactor — extract reader
  into a `PtyReader` trait with `Local` and `Ssh` impls), 
  `server/src/sessions/tmux.rs` (capture-pane via transport already from
  RT1).
- **Acceptance**:
  - Local sessions: zero regression on the 30-fixture status snapshot
    tests + the live ws_pty tests.
  - Remote session: send keystroke → byte appears in WS within 100ms
    (allow ~50ms RTT slack for SSH).
  - Kill the SSH ControlMaster mid-stream → reader respawns; WS clients
    see no disconnect (replay buffer remains warm).
  - Lag-drop on slow subscriber unchanged (1013 close).
  - 32 subscribers limit unchanged.
- **Verification**:
  - `cargo test pty ws_pty` green.
  - New test `server/tests/pty_ssh.rs`: real localhost SSH, kill master
    mid-stream, assert client sees uninterrupted byte stream
    (modulo 1-2s pause for respawn).
  - Manual: connect from browser, type, observe live.
- **Subagent prompt**:
  > Implementing RT3: PTY-over-SSH. **This is the hardest milestone.** Read
  > REMOTE_PLAN.md and `server/src/sessions/pty.rs` end-to-end (662 LOC)
  > — understand the existing FIFO + O_NONBLOCK + AsyncFd + keep-alive
  > write fd pattern, the broadcast + replay invariants, the wake-on-edge
  > signal for the status detector. RT2's HostPool is in the base.
  >
  > Worktree: `/opt/projects/supermux-remote-ssh-wt/RT3` on `milestone/RT3`.
  >
  > Extract the reader into a trait:
  > ```rust
  > #[async_trait]
  > pub trait PtyReader: Send + 'static {
  >     async fn start(&mut self, sink: PtySink) -> Result<()>;
  >     async fn stop(&mut self);
  > }
  > ```
  > Where `PtySink` wraps the existing `broadcast::Sender<Bytes>` +
  > `Replay` + wake signal. Implement `LocalPtyReader` (today's logic,
  > moved verbatim) and `SshPtyReader` (per spec above).
  >
  > `PtyStream::ensure_started` picks the impl based on
  > `session.host_id`. Everything DOWNSTREAM of the sink stays
  > byte-for-byte identical — the broadcast, the WS fan-out, the
  > status detector wake, replay buffer.
  >
  > Critical invariants to preserve:
  > 1. The Linux pipe keep-alive trick (no spurious EOF) — translate to
  >    SSH: a long-lived `sleep infinity` holder of the remote write fd.
  > 2. Backpressure: if a subscriber lags, we DROP (close 1013) — NOT
  >    block the reader.
  > 3. ControlMaster respawn: reader's ssh child exits when the master
  >    dies; on exit, wait for HostPool to respawn the master (poll
  >    every 200ms up to 30s), then re-spawn the reader child. Replay
  >    survives across respawns.
  > 4. Stream-dead on real tmux death: distinguish "ssh master gone"
  >    from "remote tmux session gone" via `Tmux::exists()` over the
  >    transport.
  >
  > Tests must cover: (a) local regression — no fixture changes
  > (b) remote happy path — bytes flow (c) ControlMaster kill →
  > respawn → stream resumes (d) remote tmux killed → stream-dead
  > marked.
  >
  > **You will get a Principle critic that yanks the SSH connection
  > mid-stream. Test that case yourself before writing done.json.**
  >
  > done.json, commit `RT3: PTY-over-SSH stream`, one-line reply.

### RT7 — Backend: Reattach across hosts on startup

- **Depends on**: RT1, RT4.
- **Scope** (~200 LOC): Today `sessions::reattach_existing` (called from
  `main.rs`) scans local tmux sessions and rehydrates. Extend to:
  1. Iterate `hosts` table (status != deleted).
  2. For each host: get a Transport from HostPool (best-effort; if SSH
     fails, log warning and mark host unreachable but don't fail boot).
  3. Run `tmux ls` via the transport; pattern-match `supermux-*` names.
  4. For each session row with host_id matching, ensure its tmux session
     is still alive on the remote; if not, mark stopped; if alive but
     supermux row is stopped, mark unknown.
- **Files**: `server/src/sessions/lifecycle.rs` (or wherever
  reattach lives — find it via grep) — extend.
- **Acceptance**:
  - Server starts cleanly when no hosts are registered (local-only path
    unchanged).
  - With one reachable host registered + one unreachable: boot completes,
    unreachable marked, sessions on unreachable marked unknown.
  - Sessions reconcile correctly (no false "running" claims).
- **Verification**: `cargo test reattach` green; manual: register a host,
  ssh-kill a tmux session out-of-band, restart server, observe session
  marked stopped.
- **Subagent prompt**:
  > Implementing RT7: cross-host reattach. Read REMOTE_PLAN.md and find
  > the existing `reattach_existing` (or equivalent) by grepping
  > `server/src/sessions/`. RT1 + RT4 are in the base.
  >
  > Worktree: `/opt/projects/supermux-remote-ssh-wt/RT7` on `milestone/RT7`.
  >
  > Extend per spec. Best-effort iteration — unreachable hosts must not
  > block boot. Use `tokio::time::timeout(5s, ...)` around each
  > `tmux ls` call.
  >
  > Tests: `server/tests/reattach_multi_host.rs`.
  >
  > done.json, commit `RT7: cross-host reattach`, one-line reply.

### RT9 — Frontend: host picker + remote badge

- **Depends on**: RT4, RT8.
- **Scope** (~250 LOC TS/TSX): 
  - New screen `web/src/routes/hosts.tsx` — list/add/check/delete hosts.
  - In session-create flow (`web/src/routes/overview.tsx` or wherever):
    add a host dropdown (default "Local"). Pass `host_id` in the
    POST body.
  - In `web/src/components/session-tile/`: render a small host badge
    (e.g. globe icon + host name) when `session.host_id != null`.
  - Add a settings sub-section: SSH onboarding instructions (Tailscale
    setup, SSH key copy).
  - API types: extend `web/src/lib/api.ts` with `listHosts`, `createHost`,
    `checkHost`, `deleteHost`, `bootstrapHost`.
- **Files**: `web/src/routes/hosts.tsx` (NEW),
  `web/src/components/host-picker.tsx` (NEW),
  `web/src/components/session-tile/host-badge.tsx` (NEW),
  `web/src/lib/api.ts` (extend),
  `web/src/App.tsx` (register `/hosts` route).
- **Acceptance**:
  - Add a host via UI, see it in the dropdown when creating a new session.
  - Tile shows the badge when host is remote, no badge when local.
  - Hosts route lists, checks status, deletes.
  - Visual critic passes: light + dark mode, mobile + desktop, no layout
    regressions vs main.
- **Verification**: `bun run build` green; manual UI smoke; Visual critic
  PASS.
- **Subagent prompt**:
  > Implementing RT9: host picker UI. Read REMOTE_PLAN.md and skim
  > `web/src/routes/overview.tsx`, `web/src/lib/api.ts`,
  > `web/src/components/session-tile/`.
  >
  > Worktree: `/opt/projects/supermux-remote-ssh-wt/RT9` on `milestone/RT9`.
  > RT4 + RT8 (backend hosts) are in the base.
  >
  > Implement per spec. Match the existing visual language — Tailwind v4
  > tokens, Framer Motion springs from `lib/springs.ts`, shadcn primitives.
  > The host badge should be unobtrusive — small globe icon + truncated
  > hostname, max width ~80px, appears top-right of the tile.
  >
  > Onboarding flow: "Add host" sheet with name + ssh_target + optional
  > public key paste; submit → POST /api/hosts then POST /api/hosts/{id}/check;
  > if check fails, show the bootstrap checklist + a "Bootstrap" button
  > that POSTs to /bootstrap.
  >
  > Test: bun run build green; manual click-through.
  >
  > done.json, commit `RT9: host picker UI + badge`, one-line reply.

### RT10 — Integration: end-to-end remote session

- **Depends on**: RT1, RT2, RT3, RT4, RT5, RT6, RT7, RT8, RT9.
- **Scope** (~100 LOC test + manual): A full integration test that:
  1. Registers a host pointing at `127.0.0.1` (or `localhost`) via SSH.
  2. Creates a session with `host_id` set, `provider="shell"` running
     `bash`.
  3. Asserts: live WS bytes flow; `send_text "echo remote-hello"`;
     `peek` shows `remote-hello`; status flips Active → Idle within
     5s of `echo` finishing.
  4. Browses files via `/api/file?session=...&path=/etc/hostname`;
     reads back the remote hostname.
  5. Installs hooks; verifies remote `~/.claude/settings.json` contains
     the supermux-hook marker pointing at `remote_callback_url`.
  6. Tears down: stops session, deletes host, asserts cleanup.
  
  Plus: full `cargo build --release` green, `bun run build` green, no
  new clippy warnings, all existing tests still green.
- **Files**: `server/tests/integration_remote.rs` (NEW).
- **Acceptance**: all of the above; release build artifact runs.
- **Verification**: `cargo test --test integration_remote --release` green;
  manual click-through in browser.
- **Subagent prompt**:
  > Implementing RT10: full integration test. Read REMOTE_PLAN.md.
  > Worktree: `/opt/projects/supermux-remote-ssh-wt/RT10` on `milestone/RT10`.
  > ALL prior milestones (RT1..RT9) are in the base.
  >
  > Write `server/tests/integration_remote.rs` per spec. The test must be
  > self-contained: it sets up a localhost ssh fixture, registers a host,
  > creates a session, exercises send + peek + files + hooks, tears down.
  > Use `#[ignore]` if ssh-localhost is not available, so CI without
  > localhost-ssh skips cleanly.
  >
  > After tests pass, run a final `cargo clippy --release -- -D warnings`
  > and `cd web && bun run build` — both must be green.
  >
  > done.json, commit `RT10: end-to-end remote integration`, one-line
  > reply.

## Critics

After each milestone is merged into `feat/remote-ssh`:

- **Acceptance critic** (background, Opus): re-reads REMOTE_PLAN.md for the
  milestone, checks every bullet in the Acceptance section against the
  merged code. Writes
  `skill/critic/<RT_ID>.<attempt>.acceptance.json` with PASS/FAIL + notes.

- **Principle critic** (background, Opus): for backend milestones, audits
  for Rust idioms (no `.unwrap()` outside tests, proper error context,
  `Send + Sync` bounds on shared state, no blocking-in-async). For RT3
  specifically: actively yanks the SSH ControlMaster mid-stream in a test
  harness and verifies the stream resumes. Writes
  `skill/critic/<RT_ID>.<attempt>.principle.json`.

- **Visual critic** (RT9 only): boots `bun run dev` on port `5183` from
  the RT9 worktree, takes screenshots of hosts route + new-session sheet
  + tile with badge, compares against main-branch screenshots. Writes
  `skill/critic/RT9.<attempt>.visual.json` + screenshots in
  `skill/critic/screenshots/`.

## Done definition

The feature ships when:
1. RT1..RT10 all merged into `feat/remote-ssh`.
2. All critics PASS.
3. Release binary built, no clippy warnings, frontend bundled.
4. Manual dogfood: a real Claude session on a real remote (e.g. a
   Tailscale peer) functions identically to a local one.
5. PR opened from `feat/remote-ssh` → `main` with the milestone summary.
