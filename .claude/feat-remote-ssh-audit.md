# feat/remote-ssh — read-only audit

Scope: commits `5263413..ce66ada` merged at `ddcad2d`. Reviewed `server/src/sessions/{transport,host_pool,pty,auto_actions,lifecycle,tmux,mod}.rs`, `server/src/files/{transport,mod,path_safe}.rs`, `server/src/hosts/{mod,bootstrap}.rs`, `server/src/db/{hosts,sessions}.rs`, `server/src/claude_config.rs`, `server/src/{config,state,http,lib,main}.rs`, `server/migrations/0018_hosts.sql`, `web/src/{routes/hosts.tsx,components/host-picker.tsx,components/session-tile/new-session-sheet.tsx,lib/api/{hosts,sessions}.ts}`, plus skim of all 9 new test files.

## Verdict — HOLD on shipping until the C-1 wire-up gap is closed

The architecture is solid and the seam discipline is genuinely good — `Transport` / `FileTransport` / `PtyReader` traits are clean, the SSH ControlMaster pool is robust, atomic-rename invariants survive cleanly across local and SSH. **However, one critical bug means a user who picks a remote host in the UI will silently get a LOCAL session** (the wire field is silently dropped server-side). The whole feature is e2e-broken on the HTTP create path. The `integration_remote.rs` test masks this by constructing the `SshFileTransport` directly instead of going through session→host_id resolution, so the bug never trips CI. Once C-1 is fixed (≤20-line patch), I'd ship the remainder as-is with a couple of follow-ups.

## Findings

| Sev | File:line | What's wrong | Fix |
|---|---|---|---|
| **CRITICAL** | `server/src/sessions/mod.rs:414-435` (`CreateInput`) and `:463-475` (`NewSession` build) | `CreateInput` has **no `host_id` field** — frontend sends it (`web/src/lib/api/sessions.ts:331+`, `new-session-sheet.tsx:217`), JSON deserializer silently drops unknown fields → every "remote" session created via the UI is persisted with `host_id = NULL` → LOCAL. `db::sessions::NewSession` also lacks a `host_id` field, and `db::sessions::create()` SQL does not insert it. The whole remote-execution wiring on the create path is dead. | Add `pub host_id: Option<i64>` to `CreateInput`, thread into `NewSession`, add the column to `db::sessions::create()` INSERT, and add an integration test that creates via the HTTP endpoint and asserts `session.host_id == Some(id)`. |
| **CRITICAL** | `server/tests/integration_remote.rs:509` | RT10's "end-to-end" test constructs `SshFileTransport::new(state.host_pool.clone(), HostId(host_id))` DIRECTLY instead of dispatching via `session.host_id`. So even when the test posts `host_id` in `POST /api/sessions`, the file-API assertion bypasses the resolver — it would pass for a session created with `host_id = NULL`. This is why C-1 above slipped through the milestone gate. | Replace the direct construction with a call through the HTTP `/api/file?session=…` handler so the resolver is actually exercised. |
| **IMPORTANT** | `server/src/sessions/auto_actions.rs:272-291` (`adhoc_ssh_transport`) | RT7 carries a `TODO(RT2): replace with state.host_pool.transport_for(host.id) once HostPool is in tree — this function should disappear.` RT2 has been merged for weeks. The boot-time reconciler now bypasses `HostPool`, so it doesn't share the warmed master, doesn't bump failure counters, and a hung ssh on reattach leaves a stale unmanaged control socket. | Switch `reconcile_host` to `state.host_pool.transport_for(host.id)`; delete `adhoc_ssh_transport`. |
| **IMPORTANT** | `server/src/sessions/host_pool.rs:280` (backoff index) | `BACKOFFS.get((failures as usize).min(BACKOFFS.len()) - 1)` — when `failures=0` this is `(0).min(4) - 1 = -1` (panics via underflow) IF the warm-up returns Err without `failures` having been pre-incremented. Today it IS pre-incremented to ≥1 (line 277), so the call site is safe — but it's brittle: any refactor that changes the order is a panic. | Saturate: `BACKOFFS.get((failures.saturating_sub(1) as usize).min(BACKOFFS.len()-1))`. |
| **IMPORTANT** | `server/src/files/transport.rs:393-407` (`SshFileTransport::delete`) | A pre-`stat` is done to decide whether to refuse a directory delete; then `rm -f <path>`. Between the `stat` and the `rm`, a remote attacker who can race the path could swap a file for a symlink to `/etc/shadow` and delete it. The local path uses `O_NOFOLLOW`/no-symlink; the remote path has no equivalent. Not a *new* attack surface (the SSH user already has shell), but documented as "RT6 MVP" — should be flagged. | Either accept the trade-off (already noted in code), or do the stat+delete atomically in one `bash -c` script with `[ ! -L "$1" ]` guard. |
| **IMPORTANT** | `server/src/files/transport.rs:300-312` (`list_dir`) | Hard-codes GNU `find -printf` format. macOS / BSD `find` does NOT support `-printf` and exits non-zero with a confusing error. The doc comment acknowledges this ("we target GNU here"), but a user adding a macOS remote will get a generic 500 with stderr noise. | Either fall back to `ls -la` parsing on EOPNOTSUPP, or surface a friendlier error mentioning GNU coreutils requirement. |
| **IMPORTANT** | `server/src/hosts/bootstrap.rs:88` (`PUBKEY_ALGOS`) | Only accepts `ssh-rsa`, `ssh-ed25519`, `ecdsa-sha2-nistp256`. Missing the common `ecdsa-sha2-nistp384`, `ecdsa-sha2-nistp521`, `sk-ssh-ed25519@openssh.com` (FIDO2 hardware keys), and `sk-ecdsa-sha2-nistp256@openssh.com`. A user with a YubiKey will hit "invalid public_key" with no explanation. | Add the four missing algorithm tokens. |
| **IMPORTANT** | `server/src/files/path_safe.rs:225-237` (`resolve_safe_remote` HOME_BLOCKED check) | Doc comment is honest: "over-blocks slightly (any directory named `.ssh` anywhere)". A legitimate remote path like `/home/alice/projects/myapp/.ssh-helpers/config.toml` would be refused (contains `.ssh` segment). | Tighten the heuristic — only check the final two path segments. |
| **IMPORTANT** | `server/src/sessions/host_pool.rs:294` (drop state, then sleep) | The mutex is dropped before `sleep(backoff)`. Good — but the caller then returns `Err` without re-checking whether ANOTHER concurrent caller succeeded in warming the master during our sleep. That second caller still re-walks the same backoff. Not catastrophic (eventually one of them warms), but on a burst of concurrent attaches against a cold host the first 3-4 callers all return Err with `unreachable` flag-flipping racing against each other. | After sleep, retry the `check_master`+slot acquire once before returning Err. Or hold the mutex across the sleep (simpler; only blocks same-host callers). |
| **IMPORTANT** | `server/src/files/mod.rs:1048-1066` (`map_transport`) | Maps a stringly-typed `anyhow::Error` to HTTP status via substring search ("no such file", "permission denied", etc.). The SSH layer captures localized stderr — a non-English remote (`Aucun fichier ou répertoire`) would always map to 500. | Inspect transport call site exit codes / errno where possible; otherwise document the EN-only assumption. |
| NICE-TO-HAVE | `server/src/sessions/host_pool.rs:121` (`REAPER_IDLE = 600s`) | 10-minute idle eviction interacts badly with the master's own `ControlPersist=600`: both sides try to tear down around the same time, leading to occasional log noise. | Bump `REAPER_IDLE` to 700s so we never race ControlPersist's natural expiry. |
| NICE-TO-HAVE | `server/src/sessions/pty.rs:97` (`SSH_LIVENESS_POLL = 3s`) | A WS-attached but bytes-quiet remote session takes up to 3s to detect a remote tmux death. Local path uses pipe EOF (instant). Documented trade-off; could be reduced to 1s without measurable overhead. | Lower to 1s; sub-ms ControlMaster check makes 3s overkill. |
| NICE-TO-HAVE | `server/src/sessions/auto_actions.rs:267` | "Also bump `last_seen` so the UI clock advances" — fires `update_status(Reachable)` even when already Reachable, on every boot. Cheap but slightly noisy in audit logs. | Conditional bump or a dedicated `touch_last_seen`. |
| NICE-TO-HAVE | `server/src/hosts/mod.rs:298` (`COALESCE(r.last_status, 'unknown') NOT IN ('stopped','dead')`) | `'dead'` is not in the `last_status` CHECK constraint (`active/waiting/idle/stopped/unknown`); the doc comment acknowledges it's there for forward-compat. Harmless but dead code today. | Drop or wait for a future migration. |
| NICE-TO-HAVE | `server/src/files/mod.rs:387-414` (`get_raw` range over remote) | A remote 100 MB video with a Range request materializes 100 MB in server RAM, slices the requested window, drops the rest. Documented as a known limitation. | Future: russh-sftp swap for native partial reads. |
| NICE-TO-HAVE | `server/src/db/hosts.rs:181` (`soft_delete`) | The `update` query is idempotent (`WHERE id = ? AND deleted_at IS NULL`) but does not return `rows_affected` — the caller can't tell whether the soft-delete actually happened or was a no-op. | Return `u64`; let HTTP layer 404 on 0 rows. |

## Things done well — keep / replicate

- **Seam discipline.** `Transport`, `FileTransport`, `PtyReader` are minimal, focused trait surfaces. Every existing local call site stays one line (static `&LOCAL`, zero allocation). This is the gold standard for "add remote support without rebuilding the local path."
- **Default transport encoding.** `pub static LOCAL: Transport = Transport::Local;` + `&LOCAL` references everywhere keeps the hot local path zero-cost.
- **Shell escaping discipline.** `Transport::spawn_command` shell-escapes every argv token via `shell_escape::unix::escape` so callers never have to think about quoting. The unit tests (`ssh_escapes_shell_metas_in_args`, `ssh_escapes_single_quotes`) actively probe the dangerous cases. Excellent.
- **Pipe keep-alive ported faithfully.** `SshPtyReader`'s `sh -c 'exec 9>"$FIFO"; while sleep 60; do :; done'` is a faithful SSH translation of the Linux pipe trick. The `$HOME` vs `~` quoting rationale (`pty.rs:760-782`) is one of the best comments in the patch — would have been easy to ship buggy.
- **Self-healing on ControlMaster bounce.** `SshPtyReader::run_inner` distinguishes EOF-because-master-died from EOF-because-tmux-died via a second `probe_tmux_alive` with a fresh transport. The 30s `SSH_RESPAWN_BUDGET` is generous but bounded.
- **Validation at the HTTP edge.** `NAME_RE`, `SSH_TARGET_RE`, `valid_public_key` are strict allow-lists. The bootstrap script base64-encodes the public key to defeat OpenSSH's argv-flatten — defense in depth.
- **Atomic-write invariant survives the transport switch.** Both `LocalFileTransport` and `SshFileTransport` implement `write` as "temp sibling, then rename" — same crash-safety story as v1's `~/.claude/settings.json` writer.
- **Reaper guard.** The reaper skips hosts with live sessions even when idle — preserves the warm-attach experience.
- **Backwards compatibility.** `Tmux::new(name)`, `Tmux::for_pane(name, id)`, `install_hooks(name, token)` signatures preserved via `_on` companions; zero churn in the local fleet.
- **Test gating.** `#[ignore = "requires localhost-ssh"]` on the heavy tests, with explicit skip if ssh-localhost is unavailable. CI stays green on hosts without sshd.

## Scope check

Mostly tight against the plan; two items that go slightly beyond:

- `Transport::is_local()` (helper) and `FileTransport::is_local()` (trait method) — both added as fast-path predicates. Cleanly motivated: the file handlers still take the local hot-path (`O_NOFOLLOW`, seek) when possible. Justified.
- `HostPool::tear_down` is exposed `pub` but I found no caller in `server/src/` outside tests. The reaper calls it via `reap_once`. Either delete the explicit shutdown surface or wire a `DELETE /api/hosts/{id}` cleanup call.
- The `Transport::is_local` predicate + the `LocalFileTransport::is_local` override + the `is_local_transport(transport)` helper in `files/mod.rs` are three layers of the same predicate. Could collapse to one.

Not in scope creep but worth noting: RT5's `effective_remote_callback_url` resolver has FOUR fallback sources (env, config, extra_binds non-loopback, bind). That's two more than the plan asked for — but each one is well-motivated in the doc comment and the always-run unit test covers all four.

## DRY check

1. **`adhoc_ssh_transport` in `auto_actions.rs` duplicates `HostPool::transport_for`.** See IMPORTANT finding above — the TODO is stale; this function should be deleted in favor of the pool.
2. **`is_local` predicate triplicated** (`Transport::is_local`, `FileTransport::is_local`, `files::mod::is_local_transport`). Collapse to the trait method; route the rest through it.
3. **`run_ssh` in `hosts/bootstrap.rs` vs `Transport::spawn_command`.** The bootstrap probe deliberately bypasses `HostPool` (master not warm yet at first registration), but it duplicates ~15 lines of "BatchMode, ConnectTimeout, StrictHostKeyChecking" boilerplate that also lives in `host_pool::warm_up`, `host_pool::check_master`, `hosts::mod::run_reachability_check`. Four near-identical builders. Could extract a `ssh_cmd_builder(target, key_path)` helper to one place.
4. **Path validation rules duplicated between `valid_ssh_target` and the regex `SSH_TARGET_RE`.** The port-range guard is a separate function on top of the regex. Two-step validation is fine but only one place documents the "regex caps `[0-9]{1,5}`" trick — make sure both stay in sync.
5. **`dedupe_path_local` vs `dedupe_path_remote` in `files/mod.rs`** are line-for-line identical except for the existence-probe call. Could parameterize over a closure `async |path| -> bool`.
6. **JSON envelope helper `ok(data)` in `hosts/mod.rs:67-69`** is the same pattern used in `sessions/mod.rs`, `board/mod.rs`, `files/mod.rs`. Each module has its own copy. Pre-existing, not new — but the new module adds one more.

## Migration sanity

- `0018_hosts.sql` is well-formed. `id INTEGER PRIMARY KEY AUTOINCREMENT`, `name UNIQUE`, `CHECK (status IN (...))`, `created_at NOT NULL`, soft-delete via `deleted_at` nullable. Index on `sessions(host_id)` so the per-host SELECT in the reaper / reattach is O(log n).
- `ALTER TABLE sessions ADD COLUMN host_id INTEGER REFERENCES hosts(id)` backfills existing rows to NULL — correct semantic ("NULL = local"). SQLite tolerates the missing FK constraint enforcement (it just defines the reference).
- The migration number collision with main (mentioned in `b0cd423`) was already fixed.
- No data backfill is needed; the local fleet is correctly typed as `host_id IS NULL`.
- No CASCADE / SET NULL on the `host_id` FK. If a host is soft-deleted (live row still present), no action. If a host is hard-deleted (no current code path), the `sessions.host_id` FK silently dangles. The soft-delete-only contract is fine — but the FK should still spell out `ON DELETE SET NULL` for safety against a future hard-delete bug.

## Frontend sanity

- `web/src/routes/hosts.tsx` (796 lines) is comprehensive: list + add + check + bootstrap + delete, with Vaul-on-mobile / Sheet-on-desktop, status pills, relative times, per-row pending. Reuses existing `Button`, `Input`, `ResponsiveSheet`, `Tooltip`, `EmptyStatePlaceholder`. No new external deps; only adds Lucide icons.
- `HostPicker` reuses `DropdownMenu` instead of inventing a new Select (consistent with existing `ModelPicker`).
- `use-hosts.ts` follows the existing TanStack Query pattern (queryKey, invalidations). No SSE channel for hosts — defensible, the spec acknowledged it.
- `host-badge.tsx` + the tile integration is small and visually consistent with other badges.
- Routes registered in `App.tsx`; layout shows the link in `layout.tsx`. Standard pattern.

No new web deps. No SSR / loader pattern violations.
