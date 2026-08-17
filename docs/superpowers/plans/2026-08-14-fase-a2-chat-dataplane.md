## Status (2026-08-17) — SHIPPED; the checkboxes below are history

> **The whole Grok-UI program shipped.** Track A (A1–A6) and Track B (B0–B5) are on
> `main`, together with the wave-1 follow-ups (#79–#85) and the session-state series
> (#86–#89). Landing PRs: **A1 #57 · A5 #72 · A6 #76 · B1 #69 (+ #70 perf gate) ·
> B2 #74 · B3 #75 · B4 #73 · B5 #78**. (A2–A4 landed earlier in the A-track sequence;
> their PR numbers are deliberately not guessed here.)
>
> **The checkbox state below is historical, not authoritative.** These plans were
> execution documents: boxes were ticked opportunistically while work was in flight,
> so an unticked box does *not* mean unshipped, and a ticked box is not evidence that
> the code exists (see the register's "finding 23 rule"). Nothing below has been
> back-edited to match reality — this note is the only reconciliation.
>
> **The authority on what is actually done and what is still owed** is the debt
> register snapshot committed alongside these plans:
> [`debt-register-2026-08-17.md`](./debt-register-2026-08-17.md), which was verified
> row-by-row against code on `origin/main`. That snapshot was generated at `6caafdf`
> (#87), i.e. just before #88 and #89 merged, and it is the reason this banner exists:
> the ledger and the code had drifted apart.

---

# Fase A2 — Chat Data Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> This plan was written against the REAL repo at `168b303` (fase A1 merged) and hardened by a verification pass that checked every named API, column, harness and invariant against source. The audit table in "Ground truth" below records what exists, what does NOT, and what the master plan gets wrong — read it before Task 1.

**Goal:** Replace A1's poll-and-guess data path with the real chat data plane: a per-session transcript **tailer** with a byte cursor and a provable **staleness guard**, a full-fidelity **parser** pinned by the A0 fixture corpus, a **chat WebSocket** whose seed→live boundary provably has neither gap nor overlap, **wire caps that cannot be bypassed by construction**, `chat_tail` on the existing sessions SSE delta, an **opt-in** statusline tap with an exact uninstall, and the server-side **pty geometry policy**. No new renderer, no input path, no visual work.

**Architecture:** New module `server/src/sessions/chat/` = `model.rs` (typed entries + the sealed wire type) · `parser.rs` (streaming JSONL → entries, fixture-pinned) · `store.rs` (per-session ring + monotonic `seq` + snapshot-and-subscribe under ONE lock — the gap/overlap proof) · `tailer.rs` (notify watcher + byte cursor + subagents scope + pointer re-resolution + staleness classification) · `ws.rs` (the socket, registered in `ws::router_for`, NOT `protected_router`) · `statusline.rs` (opt-in wrap-don't-clobber installer). The tailer is the **only** reader of a transcript file, so byte offsets and `seq` are consistent by construction; the WS and the SSE `chat_tail` are pure consumers of the store.

**Tech Stack:** Rust (axum 0.8, `notify` 7.0 — already a dependency, `tokio::sync::broadcast`, `std::sync::Mutex` deliberately) · React 19 + TanStack Query (client transport swap only) · `cargo test` (debug, in-sandbox) · `bun test tests/unit` · Playwright smoke (existing harness).

---

## Ground truth — verified against the repo at `168b303` (2026-08-14)

Every name this plan uses was checked. **Do not "fix" these back to the master plan's wording.**

| Master-plan / A0 claim | Reality in the repo | Consequence for A2 |
|---|---|---|
| `resumable::project_dir_for` | **EXISTS** — `server/src/sessions/resumable.rs:94`, `pub(crate) fn project_dir_for(dir: &str) -> PathBuf`, canonicalizes the cwd first | Use it verbatim; `sessions::chat` is inside the crate so `pub(crate)` is fine |
| `recall.rs` streaming parser to extend | `server/src/sessions/recall.rs` (1900+ lines) with `read_user_turns` + A1's `read_chat_turns` (:552) and the `read_chat_turns_cached` single-slot cache (:794) | A2 does **not** rewrite recall. `chat/parser.rs` is a NEW parser; `/recall?chat=true` stays as the fallback path (Task 9) |
| `ws::router_for` exists and is outside the bearer middleware | **CONFIRMED** — `server/src/ws/mod.rs:85`, merged at `server/src/http.rs:46`; first-frame auth (`AUTH_TIMEOUT` 2s), `origin_allowed`, 33rd subscriber → 1013 | Register `/ws/sessions/{name}/chat` there, reusing `verify_auth_frame` + `origin_allowed` |
| `GET /peek?ansi=1` | **ALREADY SHIPPED** (PR #56) — `lifecycle.rs:1227 peek_ansi`, lenient `is_truthy_flag`, `rt.capture_ansi` on both runtimes (`runtime.rs:121/300/424`) | A2 does NOT build it. Task 8 only hardens (clamp + doc) |
| `PermissionRequest` / `PostToolUseFailure` hook events | **ALREADY SHIPPED** — `claude_config.rs:68 EVENTS: [(&str,&str); 12]` incl. both; ingest in `hooks.rs`; `permission_request` object rides the sessions delta (`hooks.rs:331`) | A2 consumes; no re-install work |
| `activity_at` server-clock stamp | **SHIPPED in A1** — `hooks.rs:351` | The chat clock domain is already server-ms; keep it |
| statusline tap / `statusLine` handling | **DOES NOT EXIST** — `grep statusLine server/src/claude_config.rs` → no hits. This host's `~/.claude/settings.json` has **no `statusLine` key at all** | Task 6 builds it from zero AND must handle the no-original case as the *primary* case on this host |
| `preview_lines` pattern on the sessions SSE delta | **CONFIRMED** — built in `auto_actions.rs:743-775`, broadcast via `fn broadcast` (`auto_actions.rs:1089`) → `state.sse_tx` | `chat_tail` rides the same delta item, same change-gated shape |
| `hooks.rs:130-136` "compaction forks a fresh jsonl" comment | Still wrong in source (A0 re-verified). The pointer IS refreshed on `SessionStart`/`UserPromptSubmit` (`hooks.rs:141-150` → `db::sessions::track_cc_conversation_id`) | Task 3 corrects the comment and adds the pointer-change notification the tailer needs |
| "hooks are live" signal for the staleness guard | **EXISTS** — `state.rs:237 hooks_live: Arc<DashMap<String, ()>>`, plus `last_hook: DashMap<String, TurnState>` (:227) | Staleness guard reads these; no new plumbing |
| pty geometry columns on the session row | **DO NOT EXIST** — `sessions` table (`0001_init.sql:5-33`) has no `cols`/`rows`; native holder hardcodes `(80, 24)` (`native/holder.rs:101`) and respawn re-reads the live VT size (`native/runtime.rs:268-284`) | Task 7 needs a migration (numbering below) |
| Migration number for A2 | Main's highest is `0024_session_runtime.sql`. **`0025_archive_on_stop.sql` is already claimed** by the in-flight branch `feat/archive-delete-all-sd9` (worktree `/opt/projects/supermux-archive-deleteall`). 0024's own header documents the precedent: *"0023 is reserved by an in-flight branch; sqlx tolerates gaps"* | A2's migration is **`0026_session_geometry.sql`**, and Task 0 re-verifies the claim before writing it. **Never** renumber or edit a migration after it merges (`sqlx` checksums → `VersionMismatch` bricks deployed installs) |
| `KEY_ALLOWLIST` has no digits | **CONFIRMED** — `lifecycle.rs:1696-1702` | Not A2's problem (A4). Do not widen it here |
| A0 fixture corpus | 9 `.jsonl` + `subagents/` pair + README, 41 anonymized lines, at `<scratchpad>/a0-fixtures/` | Task 1 Step 1 lands them in the repo; if the scratchpad is gone, the task is BLOCKED, not improvised |
| Worktree | `/opt/projects/supermux-a2` already exists on `feat/a2-chat-dataplane`, currently **identical to main** (no commits) | Task 0 reuses it; do not create a second one |

**A0 facts this plan is built on** (`docs/superpowers/plans/research-2026-08-13/a0-findings.md`): transcript entries batch-flush per completed message (text-only first-visible p50 **31.4 s**), so the tail is the *confirming* layer only; single lines up to **950 KB** exist; `content` is a list of N blocks (one multi-block in 21,431 lines); `session_id`/`sessionId` and `toolUseID` casing both occur; top-level types include `agent-name`, `agent-setting`, `bridge-session`, `ai-title`; 13 attachment subtypes are located but unfixtured; compaction stays inline (`compact_boundary`, `sessionId` unchanged) and `compactMetadata` internals drift; subagents live in `<conv-id>/subagents/agent-<id>.jsonl` + `.meta.json` whose `model` key is **optional**.

## Global Constraints

- **Worktree, never the main checkout**: all work in `/opt/projects/supermux-a2` on `feat/a2-chat-dataplane`, rebased on `origin/main` in Task 0 (concurrent agents build in the main repo — no commits/branches/stashes there).
- **Never `cargo build/test --release`** — debug only. In-sandbox builds need `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu`.
- **Never edit an existing `server/migrations/*` file** (checksummed). Task 7 ADDS one new file.
- **Read-only data plane.** No send path, no `SessionInput`, no P5 cards, no modal registry, no digits in `KEY_ALLOWLIST` (all A4). The only write A2 performs outside the DB is the **opt-in** statusline install (Task 6) and the geometry `resize` (Task 7).
- **Wire additivity**: new module, new route, new optional delta field, new query params. Every existing test must pass unmodified except where a struct literal gains a field.
- **Eligibility**: chat WS accepts `provider == "claude" && host_id IS NULL && not a team lead` — server-side, 404 otherwise (the client guard already exists from A1; the server one is new and is what makes it a *guard*).
- **The flag stays default-OFF.** A2 changes transport, not defaults. Default flip is A7.
- **The user reviews all merges.** Final step opens a PR and hands off. Never auto-merge, never deploy, never restart :8824 (this instance hosts the owner's chat).
- **Owner gates (must be cleared before the named task runs):**
  - **G1 — statusline consent (Task 6).** A0 §8 item 3: A2 writes the owner's live `~/.claude/settings.json`. Task 6 is written so the *code* ships without ever touching the live file (default OFF + an explicit endpoint); the **install on this host** is a separate, owner-triggered action. Do not run it without written consent in the conversation.
  - **G2 — migration number (Task 0/7).** Confirm `0026` is still free at execution time.

---

### Task 0: Worktree, environment, and the two owner gates

**Files:** none (setup only)

**Interfaces:** produces a verified worktree at `/opt/projects/supermux-a2` on `feat/a2-chat-dataplane` rebased onto `origin/main`, plus a recorded migration number.

- [ ] **Step 1: Refresh the worktree onto current main**

```bash
cd /opt/projects/supermux
git fetch origin
cd /opt/projects/supermux-a2
git status --porcelain          # MUST be empty; if not, stop and report
git rebase origin/main
git log --oneline -1            # expect origin/main's tip (168b303 or later)
```

If the worktree is missing: `git worktree add /opt/projects/supermux-a2 -b feat/a2-chat-dataplane origin/main`.

- [ ] **Step 2: Verify the build environment (in-sandbox)**

```bash
cd /opt/projects/supermux-a2/server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo check
cd /opt/projects/supermux-a2/web && bun install && bunx tsc -b && bun run lint
```
Expected: clean. (Cold `cargo check` takes a few minutes.)

- [ ] **Step 3: G2 — claim the migration number**

```bash
cd /opt/projects/supermux
git fetch --all
git log --all --name-only --pretty=format: -- 'server/migrations/*' | sort -u | tail -5
ls /opt/projects/supermux-a2/server/migrations | tail -3
```
Expected today: `0025_archive_on_stop.sql` appears (in-flight branch), main tops out at `0024`. **Use the lowest number strictly greater than every number seen in any branch** — `0026` unless something changed. Record the chosen number here before Task 7. Gaps are fine (`0006`, `0023` already skipped); collisions are not.

- [ ] **Step 4: Land the A0 fixture corpus in the repo**

```bash
S=/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad
test -d $S/a0-fixtures || { echo "BLOCKED: fixture corpus gone — recover it before continuing"; exit 1; }
mkdir -p /opt/projects/supermux-a2/server/tests/fixtures/chat
cp -r $S/a0-fixtures/* /opt/projects/supermux-a2/server/tests/fixtures/chat/
cd /opt/projects/supermux-a2
# PRIVACY: the source mapping must NEVER be copied.
test ! -e server/tests/fixtures/chat/a0-fixture-sources.json || { echo "PRIVATE FILE LEAKED"; exit 1; }
grep -RIl "$HOME" server/tests/fixtures/chat && echo "WARN: host paths in fixtures — re-check the anonymizer" || true
git add server/tests/fixtures/chat && git commit -m "test(chat): land the A0 anonymized transcript fixture corpus

41 lines across 9 top-level shapes plus a live 2.1.231 subagent pair; the
structure-preserving anonymizer's own checker verified 41/41. Source mapping
(a0-fixture-sources.json) is deliberately NOT checked in.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Expected: 9 `.jsonl` + `subagents/agent-*.jsonl` + `.meta.json` + `README.md`, 41 total JSONL lines.

- [ ] **Step 5: G1 — record the statusline consent state**

Ask the owner, in writing, before Task 6 runs its install step: *"May A2 install the statusline tap into your live `~/.claude/settings.json`, and should it be opt-in per host (default) or automatic?"* Record the answer in the PR body. **Task 6's code and tests do not need consent** (they run against a throwaway `CLAUDE_CONFIG_DIR`); only the live install does.

---

### Task 1: `chat/model.rs` + `chat/parser.rs` — typed entries, fixture-pinned, caps by construction

**Files:**
- Create: `server/src/sessions/chat/mod.rs`, `server/src/sessions/chat/model.rs`, `server/src/sessions/chat/parser.rs`
- Modify: `server/src/sessions/mod.rs` (add `pub mod chat;`)
- Test: `server/src/sessions/chat/parser.rs` `#[cfg(test)] mod tests` (fixture-driven, reads `server/tests/fixtures/chat/`)

**Interfaces:**
- Produces `ChatEntry` (typed, internal) and **`WireEntry` (sealed)** — the ONLY type the WS/SSE layers can serialize.
- Produces `parse_line(&str, offset: u64) -> ParsedLine` and `parse_stream(reader, from_offset) -> (Vec<ChatEntry>, u64 /*new offset*/)`.
- Consumed by: Task 2 (store), Task 3 (tailer), Task 4 (ws), Task 5 (chat_tail).

**The cap-by-construction rule (this is the load-bearing design decision):** `WireEntry` has private fields and no public constructor other than `WireEntry::seal(seq: u64, e: &ChatEntry) -> WireEntry`, which applies the per-entry cap. The store's publisher and the seed builder both take `WireEntry`. It is therefore **impossible** to put an uncapped entry on either the live or the seed path without editing `model.rs` — the caps are not a discipline, they are a type.

- [ ] **Step 1: Write the failing tests**

```rust
// server/src/sessions/chat/parser.rs — #[cfg(test)] mod tests
use super::*;
use std::path::PathBuf;

fn fixture(name: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/chat").join(name);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("fixture {}: {e}", p.display()))
}

#[test]
fn every_fixture_line_parses_and_never_panics() {
    // The tolerance pin: 41 real anonymized lines across 2.1.211→2.1.231,
    // including 13 attachment subtypes we do NOT model. Nothing may panic and
    // nothing may be dropped — unmodelled shapes become Kind::Unknown.
    let mut total = 0;
    for f in ["assistant.jsonl","user.jsonl","tool-results.jsonl","system.jsonl",
              "attachment.jsonl","queue-operation.jsonl","mode.jsonl",
              "meta-entries.jsonl","file-history.jsonl"] {
        for line in fixture(f).lines().filter(|l| !l.trim().is_empty()) {
            total += 1;
            match parse_line(line, 0) {
                ParsedLine::Entry(_) | ParsedLine::Skip => {}
                ParsedLine::Malformed(m) => panic!("fixture {f} line failed: {m}"),
            }
        }
    }
    assert_eq!(total, 32, "top-level fixture line count changed — re-verify the corpus");
}

#[test]
fn multi_block_assistant_yields_one_entry_per_block_with_suffixed_uuids() {
    // a0-findings §2: `content` is a list of N blocks; 1 multi-block
    // [thinking, text] in 21,431 lines. Blocks past the first get `<uuid>#<i>`.
    let line = fixture("assistant.jsonl").lines().nth(3).unwrap().to_string();
    let ParsedLine::Entry(entries) = parse_line(&line, 0) else { panic!("expected entries") };
    assert!(entries.len() >= 2, "the fixtured multi-block line must fan out");
    assert_eq!(entries[0].uuid, entries[1].uuid.split('#').next().unwrap());
    assert!(entries[1].uuid.ends_with("#1"));
}

#[test]
fn tolerates_both_key_casings() {
    // a0-findings §2: session_id/sessionId co-occur; toolUseID inside hook attachments.
    let snake = r#"{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00Z","session_id":"s1","message":{"role":"user","content":"hi"}}"#;
    let camel = r#"{"type":"user","uuid":"u2","timestamp":"2026-01-01T00:00:00Z","sessionId":"s1","message":{"role":"user","content":"hi"}}"#;
    for l in [snake, camel] {
        let ParsedLine::Entry(e) = parse_line(l, 0) else { panic!() };
        assert_eq!(e[0].session_id.as_deref(), Some("s1"));
    }
}

#[test]
fn unknown_top_level_types_are_kept_as_unknown_not_dropped() {
    // agent-name / agent-setting / bridge-session / ai-title are REAL (corpus-counted).
    for t in ["agent-name","agent-setting","bridge-session","ai-title","some-future-type"] {
        let l = format!(r#"{{"type":"{t}","uuid":"x","timestamp":"2026-01-01T00:00:00Z"}}"#);
        let ParsedLine::Entry(e) = parse_line(&l, 0) else { panic!("{t} dropped") };
        assert_eq!(e[0].kind, Kind::Unknown);
    }
}

#[test]
fn compact_boundary_is_inline_and_does_not_reset_the_cursor() {
    let l = r#"{"type":"system","subtype":"compact_boundary","uuid":"c1","timestamp":"2026-01-01T00:00:00Z","sessionId":"s1","compactMetadata":{"whatever":[1,2,3]}}"#;
    let ParsedLine::Entry(e) = parse_line(l, 4096) else { panic!() };
    assert_eq!(e[0].kind, Kind::CompactBoundary);
    assert_eq!(e[0].offset, 4096, "offset is the LINE START — the cursor never rewinds");
    // compactMetadata internals drift across versions: we must not read into them.
}

#[test]
fn oversize_line_is_refused_without_allocating_it_as_an_entry() {
    // a0: real lines up to 950 KB (482 KB image, 104 KB tool_result).
    let huge = format!(r#"{{"type":"user","uuid":"big","timestamp":"2026-01-01T00:00:00Z","message":{{"role":"user","content":"{}"}}}}"#, "x".repeat(2 * 1024 * 1024));
    match parse_line(&huge, 0) {
        ParsedLine::Entry(e) => {
            assert_eq!(e.len(), 1);
            assert!(e[0].oversize, "an over-MAX_LINE_BYTES line must be flagged, not parsed in full");
        }
        other => panic!("oversize line must still produce a placeholder entry, got {other:?}"),
    }
}

#[test]
fn wire_seal_caps_the_payload_and_marks_it_truncated() {
    let e = ChatEntry::test_text("u1", &"y".repeat(64 * 1024));
    let w = WireEntry::seal(7, &e);
    let json = serde_json::to_vec(&w).unwrap();
    assert!(json.len() <= MAX_ENTRY_BYTES + 512, "sealed entry over the cap: {}", json.len());
    assert!(w.truncated());
    assert_eq!(w.seq(), 7);
    assert_eq!(w.uuid(), "u1", "the uuid must survive so fetch-full can resolve it");
}

#[test]
fn wire_seal_is_the_only_constructor() {
    // Compile-time pin: if someone adds a public constructor or makes fields pub,
    // this test's module-level `assert_impl` breaks. See model.rs's private mod.
    assert!(!WireEntry::seal(0, &ChatEntry::test_text("u", "hi")).truncated());
}

#[test]
fn subagent_meta_model_key_is_optional() {
    // a0: absent on 2.1.231, present on some 2.1.221.
    let meta = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/chat/subagents")
    ).ok();
    let _ = meta; // directory listing in the real test; see Step 2
    let m: SubagentMeta = serde_json::from_str(r#"{"agentType":"explore","description":"d","toolUseId":"t1","spawnDepth":1}"#).unwrap();
    assert!(m.model.is_none());
}
```

Run: `cd /opt/projects/supermux-a2/server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test chat::parser`
Expected: compile failure (nothing exists yet) — that is the RED state.

- [ ] **Step 2: Implement `model.rs`**

```rust
//! Typed chat entries + the SEALED wire type.
//!
//! `WireEntry` is the only thing the WS/SSE layers may serialize, and its
//! single constructor applies the per-entry cap. An uncapped entry therefore
//! cannot reach the wire without editing this file (a0-findings §2: real
//! transcript lines reach 950 KB).

/// Per-entry wire cap. Chosen to match the hook pipe's own 16 KB `head -c`
/// truncation so both live layers clip at the same size.
pub const MAX_ENTRY_BYTES: usize = 16 * 1024;
/// A single JSONL line larger than this is never parsed into content — the
/// entry becomes an `oversize` placeholder (fetch-full can still stream it).
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
/// Seed page byte budget (see Task 4).
pub const SEED_MAX_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind { Prompt, Assistant, Thinking, ToolUse, ToolResult, Queue, Mode,
                CompactBoundary, System, Attachment, Subagent, Unknown }

#[derive(Debug, Clone)]
pub struct ChatEntry {
    pub uuid: String,
    pub kind: Kind,
    pub ts_ms: i64,          // CC's own clock (entry `timestamp`)
    pub offset: u64,         // byte offset of the LINE START in its file
    pub session_id: Option<String>,
    pub oversize: bool,
    pub body: serde_json::Value,   // kind-specific payload, pre-cap
    // …tool_use_id, label, ok, is_sidechain, agent_id — see the full struct
}

mod sealed {
    /// Private field carrier: `WireEntry`'s fields live here so no other module
    /// can construct one field-by-field.
    #[derive(Debug, Clone, serde::Serialize)]
    pub struct Inner { pub(super) seq: u64, pub(super) uuid: String, /* … */
                       pub(super) truncated: bool, pub(super) body: serde_json::Value }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(transparent)]
pub struct WireEntry(sealed::Inner);

impl WireEntry {
    /// THE constructor. Applies `MAX_ENTRY_BYTES` and stamps `truncated`.
    pub fn seal(seq: u64, e: &ChatEntry) -> Self { /* serialize body, clip, set flags */ }
    pub fn seq(&self) -> u64 { self.0.seq }
    pub fn uuid(&self) -> &str { &self.0.uuid }
    pub fn truncated(&self) -> bool { self.0.truncated }
}
```

- [ ] **Step 3: Implement `parser.rs`**

Requirements pinned by the tests: line-start offsets (never mid-line); `content` parsed as a list of N blocks with `#i` uuid suffixes past the first; `#[serde(alias = "sessionId")]` / `alias = "toolUseID"` on every dual-cased field; unknown `type` → `Kind::Unknown` (never dropped, never a panic); `compact_boundary` inline, `compactMetadata` never read into; lines > `MAX_LINE_BYTES` → `oversize` placeholder read with a bounded reader (`BufReader::take(MAX_LINE_BYTES + 1)`) so a 950 KB line never doubles into memory twice; sidechain entries skipped in the main file (they live in `subagents/`).

- [ ] **Step 4: Green**

Run: `cargo test chat::` → all Step 1 tests pass. Then `cargo clippy --all-targets -- -D warnings` on the new module.

---

### Task 2: `chat/store.rs` — the ring, `seq`, and the snapshot-and-subscribe proof

**Files:** Create `server/src/sessions/chat/store.rs`; modify `server/src/state.rs` (one `DashMap<String, Arc<ChatStore>>` field + accessor).

**Interfaces:**
- `ChatStore::publish(&self, entries: Vec<ChatEntry>)` — called ONLY by the tailer.
- `ChatStore::attach(&self) -> Attachment { ring: Vec<WireEntry>, high_water: u64, rx: broadcast::Receiver<WireEntry>, oldest_offset: Option<u64> }`
- `ChatStore::tail_summary(&self) -> Option<ChatTail>` — Task 5's source.

**THE INVARIANT (no gap, no overlap) — and why it holds:**

```rust
pub struct ChatStore {
    inner: std::sync::Mutex<Inner>,          // std, NOT tokio: no await inside
    tx: tokio::sync::broadcast::Sender<WireEntry>,
}
struct Inner { ring: VecDeque<WireEntry>, next_seq: u64, state: TailState }

impl ChatStore {
    pub fn publish(&self, entries: Vec<ChatEntry>) {
        let mut g = self.inner.lock().unwrap();
        for e in &entries {
            let w = WireEntry::seal(g.next_seq, e);
            g.next_seq += 1;
            g.ring.push_back(w.clone());
            while g.ring.len() > RING_CAP { g.ring.pop_front(); }
            let _ = self.tx.send(w);      // ← SEND HAPPENS UNDER THE LOCK
        }
    }

    pub fn attach(&self) -> Attachment {
        let g = self.inner.lock().unwrap();
        let rx = self.tx.subscribe();     // ← SUBSCRIBE HAPPENS UNDER THE SAME LOCK
        Attachment { ring: g.ring.iter().cloned().collect(), high_water: g.next_seq, rx, .. }
    }
}
```

*No gap:* `push_back` and `send` are in one critical section. Any entry whose `send` happened before `attach` took the lock is already in the ring snapshot; any entry sent after `attach` released the lock was necessarily produced after `subscribe`, so the receiver has it. There is no window in which an entry is neither in the snapshot nor in the receiver.
*No overlap:* every entry carries a globally monotonic `seq`. The WS forwards a live frame only when `seq >= high_water`; the ring snapshot contains only `seq < high_water`. Dedupe is exact and needs no uuid/text matching.
*Why `std::sync::Mutex`:* holding a `tokio::sync::Mutex` across `subscribe()` would be fine, but any future `.await` inside the critical section would break the atomicity the proof depends on — a std mutex makes that a compile error.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn attach_snapshot_and_live_stream_are_strictly_consecutive_with_no_gap_or_overlap() {
    let store = Arc::new(ChatStore::new());
    for i in 0..50 { store.publish(vec![entry(i)]); }
    let att = store.attach();
    for i in 50..120 { store.publish(vec![entry(i)]); }
    let mut seen: Vec<u64> = att.ring.iter().map(|w| w.seq()).collect();
    let mut rx = att.rx;
    while let Ok(w) = rx.try_recv() { if w.seq() >= att.high_water { seen.push(w.seq()); } }
    // consecutive, no dupes, ends at the last published seq
    assert_eq!(seen, (seen[0]..=119).collect::<Vec<_>>());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn firehose_concurrent_attach_never_gaps_or_duplicates() {
    // The master-plan §2.1 "firehose mid-stream attach test", as a race, 200×.
    let store = Arc::new(ChatStore::new());
    let s = store.clone();
    let writer = tokio::task::spawn_blocking(move || { for i in 0..5000 { s.publish(vec![entry(i)]); } });
    for _ in 0..200 {
        let att = store.attach();
        let mut seqs: Vec<u64> = att.ring.iter().map(|w| w.seq()).collect();
        let mut rx = att.rx;
        for _ in 0..50 { match rx.try_recv() { Ok(w) if w.seq() >= att.high_water => seqs.push(w.seq()), _ => break } }
        for pair in seqs.windows(2) { assert_eq!(pair[1], pair[0] + 1, "gap/dupe at {pair:?}"); }
        tokio::task::yield_now().await;
    }
    writer.await.unwrap();
}

#[test]
fn lagged_receiver_is_reported_not_silently_skipped() {
    let store = ChatStore::with_capacity(4);
    let att = store.attach();
    for i in 0..64 { store.publish(vec![entry(i)]); }
    let mut rx = att.rx;
    assert!(matches!(rx.try_recv(), Err(broadcast::error::TryRecvError::Lagged(_))),
            "a slow subscriber MUST surface Lagged so the WS can force a resync");
}

#[test]
fn ring_is_bounded_and_keeps_the_newest() { /* RING_CAP entries, newest retained */ }
```

- [ ] **Step 2: Implement, then green.** `cargo test chat::store` (include the multi-thread test; it is the firehose gate).

---

### Task 3: `chat/tailer.rs` — watcher, byte cursor, subagents, and the staleness guard

**Files:** Create `server/src/sessions/chat/tailer.rs`; modify `server/src/hooks.rs` (pointer-change notify + fix the stale compaction comment); modify `server/src/state.rs` (a `chat_pointer_wake: DashMap<String, Arc<Notify>>`, mirroring `detector_wake` at `state.rs:244`).

**Interfaces:**
- `spawn_tailer(state, name)` — idempotent; one task per session, started on first chat attach, stopped when the last subscriber leaves + a grace period.
- Pure, unit-testable core: `classify_pointer(inputs: PointerInputs) -> TailState`.

**Watcher shape (precedents: `teams/watcher.rs`, `scheduler/watch.rs`):** a `notify` watcher on the **project directory** (not just the file — a `--resume` writes a *different* file, and the dir event is the only way to see it) plus the `subagents/` subdir when it exists, PLUS an unconditional slow safety poll (2 s) because FSEvents get dropped — verbatim the rationale `teams/watcher.rs:1-16` already documents. Debounce 150 ms (much tighter than teams' 400 ms: a landing batch is the thing we want to be fast on).

**Cursor:** per-file byte offset. Compaction is inline (`compact_boundary`), so the cursor survives it — never reset on compaction. Reset ONLY when the resolved path changes, or when the file's length went *backwards* (truncation/rotation) — in which case re-seed from the top and emit `resync`.

**The staleness guard — the four inputs and the three failure modes it must cover:**

```rust
pub struct PointerInputs {
    pub pointer_path_exists: bool,
    pub pointer_mtime_ms: Option<i64>,       // our resolved <cc_id>.jsonl
    pub newest_sibling_mtime_ms: Option<i64>,// newest OTHER *.jsonl in the project dir
    pub hooks_live: bool,                    // state.hooks_live has this session
    pub last_hook_ms: Option<i64>,           // state.last_hook turn-state stamp
    pub session_running: bool,               // status != stopped
    pub session_last_started_ms: i64,
    pub now_ms: i64,
}
pub enum TailState {
    Live,
    Reconnecting { reason: &'static str },   // pointer suspect — never render as truth
    NoHooks,                                 // pointer can NEVER self-heal
}
```

| failure mode | detection | why it works |
|---|---|---|
| **server restart** (DB pointer days stale — the c31518e bug class) | `session_running && !hooks_live && pointer_mtime < session_last_started` → `Reconnecting{"no hook since start"}` | After a restart no hook has fired yet, so `hooks_live` is empty; the pointer is unproven until the next `SessionStart`/`UserPromptSubmit` refreshes it (`hooks.rs:141-150`) |
| **terminal-side `--resume`** (human types `/resume`; CC switches file) | primary: the `SessionStart` hook fires → `track_cc_conversation_id` writes the new id → **Task 3 Step 3's notify wakes the tailer**, which re-resolves and re-seeds. Backstop when the hook is late/lost: `session_running && hook_activity_within(10s) && newest_sibling_mtime > pointer_mtime + 5s` → `Reconnecting{"newer conversation in this project"}` | The backstop keys on *our* file being cold **while the session is provably active**, so a second supermux session sharing the cwd cannot false-positive: another session's writes only matter if ours is simultaneously silent under our own hook activity |
| **hook install failure** (hooks never installed / token wrong) | `session_running && !hooks_live && now - session_last_started > 60s` → `NoHooks` | The pointer's only self-heal path is a hook. Without hooks the tail can silently be another conversation forever — this state must be visible, not guessed |

**Never auto-adopt.** A suspect pointer is *reported*, never swapped for a guessed file: adopting the newest sibling would be wrong exactly when two sessions share a cwd. Adoption happens only via the hook-carried `session_id` (the authoritative signal).

- [ ] **Step 1: Write the failing tests (pure — no live Claude needed)**

```rust
#[test] fn live_when_hooks_are_flowing_and_our_file_is_the_hot_one() { … assert_eq!(classify_pointer(base()), TailState::Live) }

#[test]
fn server_restart_with_stale_pointer_is_reconnecting_not_live() {
    let i = PointerInputs { hooks_live: false, pointer_mtime_ms: Some(1_000), session_last_started_ms: 5_000, session_running: true, now_ms: 6_000, ..base() };
    assert!(matches!(classify_pointer(i), TailState::Reconnecting { .. }));
}

#[test]
fn terminal_side_resume_is_caught_by_the_cold_pointer_backstop() {
    let i = PointerInputs { hooks_live: true, last_hook_ms: Some(99_000), pointer_mtime_ms: Some(50_000),
                            newest_sibling_mtime_ms: Some(99_500), session_running: true, now_ms: 100_000, ..base() };
    assert!(matches!(classify_pointer(i), TailState::Reconnecting { .. }));
}

#[test]
fn a_second_session_sharing_the_cwd_does_not_false_positive() {
    // Sibling is newer, but OUR pointer is equally hot → the other file is
    // someone else's session, not our resume.
    let i = PointerInputs { hooks_live: true, last_hook_ms: Some(99_000), pointer_mtime_ms: Some(99_400),
                            newest_sibling_mtime_ms: Some(99_500), session_running: true, now_ms: 100_000, ..base() };
    assert_eq!(classify_pointer(i), TailState::Live);
}

#[test]
fn hook_install_failure_is_its_own_terminal_state() {
    let i = PointerInputs { hooks_live: false, session_running: true, session_last_started_ms: 0, now_ms: 120_000, ..base() };
    assert_eq!(classify_pointer(i), TailState::NoHooks);
}

#[test] fn a_stopped_session_is_never_flagged_stale() { /* historical tail is legitimate */ }
#[test] fn missing_pointer_file_is_reconnecting_not_empty_chat() { /* an empty-but-composable chat is the lie we are preventing */ }
```

Plus two integration tests with a real temp project dir:

```rust
#[tokio::test] async fn cursor_survives_an_inline_compact_boundary() { /* append; assert no re-emit of pre-boundary entries */ }
#[tokio::test] async fn pointer_change_reseeds_from_the_new_file_and_emits_resync() { /* write file B, bump the notify, assert resync + B's entries */ }
#[tokio::test] async fn truncated_file_reseeds_instead_of_reading_garbage() { /* len went backwards */ }
#[tokio::test] async fn subagent_files_are_watched_and_tagged_with_agent_id() { /* subagents/agent-*.jsonl */ }
```

- [ ] **Step 2: Implement the tailer.**

- [ ] **Step 3: Wake the tailer on a pointer change (server)**

In `server/src/hooks.rs`, at the `track_cc_conversation_id` site (`:141-150`): when the DB write reports a CHANGED id, `state.chat_pointer_wake(session).notify_one()`. Also correct the stale comment at `hooks.rs:133-136` ("compaction forks a fresh jsonl") — A0 re-verified compaction stays inline; the real reasons the id changes are restart, `/clear`, and `--resume`.

- [ ] **Step 4: Green.** `cargo test chat::tailer`.

---

### Task 4: `chat/ws.rs` — the socket, the seed/live boundary, and caps on BOTH paths

**Files:** Create `server/src/sessions/chat/ws.rs`; modify `server/src/ws/mod.rs` (route registration + reuse `verify_auth_frame`/`origin_allowed`), `server/src/sessions/mod.rs` (two REST routes in `protected_router`).

**Interfaces (wire):**
- `GET /ws/sessions/{name}/chat` — registered in `ws::router_for` (NOT `protected_router`: its bearer middleware cannot be satisfied by a browser WS — that is exactly why the terminal WS lives outside it, `http.rs:46`).
- Frames, server→client: `seed` (page of `WireEntry` + `has_more` + `next_before`) → `seed_done` (`high_water`, `state`) → `entry` (live, `seq >= high_water` only) → `state` (staleness transitions) → `resync` (after `Lagged` or a pointer change).
- Client→server: `{"type":"auth","token":…}` only. **Nothing else** — A2 has no input path; unknown frames are ignored.
- `GET /api/sessions/{name}/chat/history?before=<cursor>&limit=N` (protected) — backlog older than the ring; cursor = `"<cc_id>:<offset>"`, and a cursor whose `cc_id` no longer matches returns `409` so the client re-seeds instead of splicing two conversations.
- `GET /api/sessions/{name}/chat/entry/{uuid}` (protected) — fetch-full for `truncated` entries (master plan §2.1).

**Seed composition:** ring first (`attach()`'s snapshot, already sealed), then, if the client wants more, older pages come from disk **strictly below the ring's oldest offset** — the two ranges cannot overlap because the ring's oldest offset is the boundary and the tailer is the file's only reader.

**Caps on BOTH paths — the explicit test matrix:**

| path | cap | test |
|---|---|---|
| live `entry` | `MAX_ENTRY_BYTES` via `WireEntry::seal` | `live_entry_over_cap_is_truncated_with_uuid_intact` |
| `seed` page entries | same `seal` (identical code path — seed reads produce `ChatEntry` → `seal`) | `seed_entry_over_cap_is_truncated_with_uuid_intact` |
| `seed` page total | `SEED_MAX_BYTES` → stop early, `has_more:true` | `seed_page_stops_at_the_byte_budget_not_the_entry_count` |
| history REST page | same two caps | `history_page_applies_both_caps` |
| `chat_tail` (Task 5) | 200 chars/field | Task 5's test |

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test] async fn rejects_bad_origin_and_missing_auth_exactly_like_the_terminal_ws() { … }
#[tokio::test] async fn ineligible_session_is_refused(/* codex, remote host_id, team lead */) { … }

#[tokio::test]
async fn seed_then_live_is_strictly_consecutive_under_a_firehose() {
    // The master-plan §2.1 acceptance test, end-to-end over a real socket:
    // attach mid-stream while a writer appends 2000 entries; assert the client's
    // observed seq sequence is consecutive with no duplicates across seed_done.
}

#[tokio::test] async fn live_entry_over_cap_is_truncated_with_uuid_intact() { … }
#[tokio::test] async fn seed_entry_over_cap_is_truncated_with_uuid_intact() { … }
#[tokio::test] async fn seed_page_stops_at_the_byte_budget_not_the_entry_count() { … }
#[tokio::test] async fn fetch_full_returns_the_untruncated_entry_for_a_truncated_uuid() { … }
#[tokio::test] async fn history_cursor_from_a_different_conversation_is_409_not_spliced() { … }
#[tokio::test] async fn lagged_subscriber_gets_resync_then_a_fresh_seed_never_a_silent_hole() { … }
#[tokio::test] async fn staleness_state_is_sent_on_seed_done_and_on_every_transition() { … }
#[tokio::test] async fn unknown_client_frame_is_ignored_not_fatal() { … }
```

- [ ] **Step 2: Implement.** Reuse the terminal WS's handshake constants (`AUTH_TIMEOUT`, `close_code::POLICY`, the 33rd-subscriber 1013 convention) so the two sockets fail identically. Per-session subscriber cap: same 32.

- [ ] **Step 3: Green + clippy.**

---

### Task 5: `chat_tail` on the existing sessions SSE delta (zero new requests)

**Files:** Modify `server/src/sessions/chat/store.rs` (`tail_summary`), `server/src/sessions/auto_actions.rs` (delta item), `web/src/components/session-tile/types.ts` + `web/src/lib/api/sessions.ts` (type only).

**Interfaces:** delta item gains `chat_tail: { user: String, agent: String, ts: i64 } | null` — built from the in-memory ring, **never** from a file read (a full-file recall scan per tile would kill the `spawn_blocking` pool — the live corpus is 8.9 MB, master plan §2.5).

- [ ] **Step 1: Failing tests**

```rust
#[test] fn tail_summary_is_last_user_oneliner_plus_last_agent_line_capped_at_200_chars() { … }
#[test] fn tail_summary_is_none_when_the_ring_is_empty_so_the_delta_field_is_omitted() { … }
#[test] fn delta_carries_chat_tail_only_when_it_CHANGED(/* mirrors the preview_lines gate */) { … }
#[test] fn chat_tail_publication_is_debounced_to_at_most_one_per_second_per_session() {
    // A landing batch is 30-100 entries (a0: tool-heavy turns); one SSE
    // broadcast per entry would be a fan-out storm on every connected client.
}
```

- [ ] **Step 2: Implement** in the existing `if committed.is_some() || tail_changed` block (`auto_actions.rs:743`), as an additional change-gated key — same shape as `preview_lines`/`preview_ansi`.

- [ ] **Step 3: Green.** `cargo test auto_actions` + `cargo test chat::store`.

---

### Task 6: `chat/statusline.rs` — opt-in tap, wrap-don't-clobber, exact uninstall

**Files:** Create `server/src/sessions/chat/statusline.rs`; modify `server/src/sessions/mod.rs` (two admin routes), `server/src/config.rs` (one setting).

**Owner gate G1 applies to the live install only.** Everything below runs against a throwaway `CLAUDE_CONFIG_DIR`.

**Opt-in, enforced by tests, not by intent:**
- Default `statusline_tap = false`. Nothing in the session create/start path may call the installer.
- Install happens ONLY via `POST /api/claude/statusline/install` (protected) — an explicit, human/agent-triggered action; `DELETE /api/claude/statusline` uninstalls.
- Regression pin: a test that boots the create+start path with a fake `CLAUDE_CONFIG_DIR` and asserts the settings file **never grows a `statusLine` key**. That test is what makes "opt-in" a property of the build rather than a promise.

**The wrap contract (A0 §4, live-verified shape):** `statusLine` is a single global object slot `{"type":"command","command":…,"padding":…}` — no array, no chaining. Therefore: recognize only `type == "command"` (anything else → refuse with a clear error, never overwrite); mutate only `command`; preserve `padding` and unknown keys verbatim; the wrapper tees stdin to the supermux tap, pipes the SAME stdin to the original, and passes the original's stdout through unchanged (first line = the rendered status, ANSI ok) **and its exit code** (a nonzero exit hides the line — the tap must never change that).

**This host has no `statusLine` at all** (verified: `~/.claude/settings.json` keys contain no `statusLine`). That makes "no original" the primary case, and A0 never tested whether an empty stdout costs a blank row. So:
- default `--mode wrap` → **refuses** when no original exists (never silently invents a status line);
- `--mode tap-only` exists but is gated on Step 1's empirical answer.

- [ ] **Step 1: Empirically settle the no-original question (throwaway config dir, runnable)**

```bash
export CLAUDE_CONFIG_DIR=$(mktemp -d)
cp ~/.claude/settings.json "$CLAUDE_CONFIG_DIR/settings.json" 2>/dev/null || echo '{}' > "$CLAUDE_CONFIG_DIR/settings.json"
python3 - <<'PY'
import json,os
p=os.path.join(os.environ["CLAUDE_CONFIG_DIR"],"settings.json"); d=json.load(open(p))
d["statusLine"]={"type":"command","command":"exit 0","padding":0}   # prints nothing, exits 0
json.dump(d,open(p,"w"),indent=2)
PY
# Boot a throwaway session in that config dir and peek the TUI:
#   does a blank status row appear above the composer? does the composer shift?
```
Record the answer in the PR body. Empty stdout costs a blank row → `tap-only` stays refused by default and the owner is told the tap needs an existing statusline (or accepts a supermux-rendered line, which is A3 design work, not A2). Also assert in the same probe that the statusline process sees `SUPERMUX_SESSION` and `SUPERMUX_HOOK_TOKEN` in its env (it inherits the pane env exactly as the hook commands do — `command: env | grep SUPERMUX`), because the tap's auth depends on it.

- [ ] **Step 2: Write the failing tests**

```rust
fn settings_with(v: serde_json::Value) -> serde_json::Value { … }

#[tokio::test]
async fn install_then_uninstall_round_trips_the_settings_value_exactly() {
    // "Exact" = parsed-Value equality, not byte equality: the merge rewrites the
    // whole file through serde_json (already true of install_hooks), so key
    // ORDER normalizes. Everything else — padding, unknown keys, the original
    // command string, sibling top-level keys — must survive verbatim.
    for original in [
        json!({"type":"command","command":"~/bin/mystatus.sh","padding":0}),
        json!({"type":"command","command":"echo hi","padding":2,"futureKey":{"a":[1,2]}}),
    ] {
        let before = settings_with(json!({"statusLine": original, "theme":"dark"}));
        let after_install = install(&before, Mode::Wrap).unwrap();
        assert_ne!(after_install["statusLine"]["command"], before["statusLine"]["command"]);
        assert_eq!(after_install["statusLine"]["padding"], before["statusLine"]["padding"]);
        assert_eq!(after_install["theme"], before["theme"]);
        let after_uninstall = uninstall(&after_install).unwrap();
        assert_eq!(after_uninstall, before, "uninstall must be EXACT");
    }
}

#[tokio::test] async fn install_is_idempotent_and_never_double_wraps() {
    let a = install(&base, Mode::Wrap).unwrap();
    let b = install(&a, Mode::Wrap).unwrap();
    assert_eq!(a, b);
    assert_eq!(uninstall(&b).unwrap(), base);
}

#[tokio::test] async fn refuses_a_non_command_statusline_instead_of_clobbering_it() {
    let weird = settings_with(json!({"statusLine": {"type":"future_kind","spec":{}}}));
    assert!(install(&weird, Mode::Wrap).is_err());
    assert_eq!(weird, settings_with(json!({"statusLine": {"type":"future_kind","spec":{}}})));
}

#[tokio::test] async fn wrap_mode_refuses_when_there_is_no_original_statusline() {
    assert!(install(&settings_with(json!({})), Mode::Wrap).is_err());   // this host's case
}

#[tokio::test] async fn uninstall_of_a_foreign_wrapper_is_a_no_op_not_a_clobber() {
    // Someone else's tool wrapped OUR wrapper: the marker is no longer outermost.
    // We must leave their command alone and report, never "restore" over it.
}

#[tokio::test] async fn uninstall_without_the_embedded_original_falls_back_to_the_sidecar() {
    // Belt+braces: the original command is stored BOTH inside the wrapper
    // command string (marker-delimited) and in ~/.claude/supermux-statusline.json.
}

#[test] fn the_wrapper_passes_stdout_and_exit_code_through_unchanged() {
    // Actually RUN the generated command in `sh` (the shape used by
    // permission_request_command_is_inert_emits_no_stdout in claude_config.rs):
    // stdin JSON in → original's stdout out, byte-identical; exit 3 stays 3;
    // and with the supermux URL unreachable the wrapper still exits 0/3 fast
    // (`curl --max-time 1 … || true`, backgrounded).
}

#[tokio::test] async fn session_create_and_start_never_install_the_statusline() {
    // The opt-in pin. Boot create+start against a temp CLAUDE_CONFIG_DIR;
    // assert the settings file has no `statusLine` key afterwards.
}
```

- [ ] **Step 3: Implement.** Command shape mirrors the shipped hook command (`claude_config.rs`, verified live on this host):

```sh
: supermux-statusline; D=$(head -c 16384); \
  [ -n "$SUPERMUX_SESSION" ] && printf '%s' "$D" | curl -fsS -o /dev/null --max-time 1 -X POST \
    -H "Content-Type: application/json" -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
    "$SUPERMUX_URL/api/_internal/statusline?session=$SUPERMUX_SESSION" --data-binary @- >/dev/null 2>&1 & \
  printf '%s' "$D" | ( <ORIGINAL_COMMAND> ); exit $?
```
Server side: `POST /api/_internal/statusline` (hook-token auth, same middleware as `/api/_internal/hook`) parses the A0-verified fields — `context_window.used_percentage` (int), `cost.total_cost_usd`, `model` as an **object** `{id, display_name}` (NOT a string), `version`, `rate_limits.*`, `session_name`, `exceeds_200k_tokens` — into an in-memory per-session struct surfaced on the sessions delta. **`permission_mode` is absent from the statusline payload on 2.1.227/231** (A0 §4) — do not read it; mode comes from hook payloads + `SessionView.mode`. Statusline cadence is per-turn and event-driven; it is **never** a liveness signal.

- [ ] **Step 4: Green.** `cargo test statusline`. Live install stays gated on G1.

---

### Task 7: Pty geometry policy (migration + create + chat attach + detach restore)

**Files:** Create `server/migrations/0026_session_geometry.sql` (number re-verified in Task 0 Step 3); modify `server/src/db/sessions.rs`, `server/src/sessions/mod.rs` (create), `server/src/sessions/native/runtime.rs` (holder spawn args), `server/src/sessions/chat/ws.rs` (attach/detach hooks).

```sql
-- server/migrations/0026_session_geometry.sql
-- Persisted pty geometry (master plan §2.6). 0 = unset → the policy default.
-- Numbering: 0025 is claimed by an in-flight branch (`0025_archive_on_stop.sql`);
-- sqlx orders by version and tolerates gaps (0006, 0023 already skipped).
-- NEVER edit this file after it merges — migrations are checksummed.
ALTER TABLE sessions ADD COLUMN cols INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN rows INTEGER NOT NULL DEFAULT 0;
```

**Policy:** default **120×40**; floor **40 cols** for server-applied geometry (A0: at 52 cols dialog option lines wrap — a fingerprint hazard for the A4 registry, not just cosmetics); geometry applied at create (holder spawn args instead of the hardcoded 80×24 at `native/holder.rs:101`), re-applied on holder respawn, and applied on first chat attach when unset/below floor; **terminal clients keep last-write-wins and are never clamped** (a real phone viewport is the truth for a human looking at it); when the last terminal client detaches while a chat client is attached, the policy geometry is re-applied. **The chat client never sends resize** — the server owns this entirely.

- [ ] **Step 1: Failing tests**

```rust
#[tokio::test] async fn a_new_session_boots_at_the_policy_geometry_not_80x24() { … }
#[tokio::test] async fn chat_attach_applies_the_policy_when_geometry_is_unset() { … }
#[tokio::test] async fn chat_attach_does_not_shrink_a_terminal_client_s_geometry() { … }
#[tokio::test] async fn terminal_resize_persists_verbatim_even_below_the_floor() { … }
#[tokio::test] async fn last_terminal_detach_with_chat_attached_restores_the_policy_geometry() { … }
#[tokio::test] async fn holder_respawn_restores_the_persisted_geometry() { … }
#[test] fn policy_never_returns_fewer_than_40_cols() { … }
```

- [ ] **Step 2: Implement + green.** Also run the existing suites that touch create/duplicate (`SELECT *`-based `FromRow` mappings tolerate the new columns, but `sessions::create`'s explicit column list and `duplicate`'s SELECT-INSERT must be checked): `cargo test sessions::`.

---

### Task 8: `/peek?ansi=1` hardening (small — it already shipped)

**Files:** Modify `server/src/sessions/lifecycle.rs` (clamp + doc).

A1 shipped `peek_ansi` (`lifecycle.rs:1227`) and the A1 client polls it once a second for the P13 provisional tail. A2 hardens what A1 left open:

- [ ] **Step 1: Failing tests**
```rust
#[tokio::test] async fn peek_ansi_lines_are_clamped_to_the_documented_maximum() { /* a 1e9 request must not capture the whole scrollback */ }
#[tokio::test] async fn peek_ansi_on_a_dead_session_is_404_not_a_panic() { … }
#[test] fn is_truthy_flag_accepts_1_true_yes_on_and_bare_flag_only() { /* pin the A1 semantics */ }
```
- [ ] **Step 2: Implement + green.** Document in the module header that `preview_ansi` (20 lines/detector tick, `mod.rs:376`) remains the zero-cost interim colour channel for tiles; `?ansi=1` is the focused-session channel.

---

### Task 9: Client transport swap — WS replaces the A1 poll (minimal, no visual change)

**Files:** Modify `web/src/components/chat/use-chat-tail.ts` (poll → WS with poll fallback); create `web/src/components/chat/use-chat-socket.ts` + `web/src/components/chat/merge.ts` (pure); modify `web/src/lib/api/sessions.ts` (types); tests in `web/tests/unit/`.

**Scope discipline:** identical rendered output to A1 — this task swaps the transport and proves the WS end-to-end. Zero new visual work (that is A3). If the WS fails to open, or the session is ineligible, the A1 `/recall?chat=true` poll remains as the fallback path — so a WS regression degrades to A1 behaviour rather than an empty panel.

**Pure logic goes in `merge.ts`** so it is `bun test`-able without a browser:

- [ ] **Step 1: Failing bun tests**
```ts
test('live entries below the seed high-water are dropped (no duplicate render)', …)
test('live entries at or above the high-water append in seq order', …)
test('resync clears the buffer and re-seeds — never splices two conversations', …)
test('a truncated entry renders its clipped body and flags fetch-full', …)
test('reconnecting/no_hooks state suppresses "looks like a complete transcript"', …)
```
Run: `cd /opt/projects/supermux-a2/web && bun test tests/unit`

- [ ] **Step 2: Implement the socket hook** — first-frame auth (same token source the terminal WS uses), visibility-gated redial, exponential backoff, and **focused session only** (never N sockets for N tiles; tiles use `chat_tail` from Task 5).

- [ ] **Step 3: e2e smoke** — extend `web/tests/e2e/smoke/chat-renderer-switch.spec.ts`: with the flag on, the panel populates over the WS (assert no `/recall?chat=true` request once the socket is open), and killing the backend mid-session shows the reconnect state rather than a stale-looking transcript.
Run: `bun run test:e2e:smoke` (set `SUPERMUX_E2E_NO_SANDBOX=1` on this host — `playwright.config.ts` documents why).

- [ ] **Step 4: Perf gate.** `bun run build:perf` must pass (the lazy chat chunk still spends from the 200 KB gz app-JS budget — `scripts/size-budget.mjs` counts all non-`vendor*` chunks).

---

### Task 10: PR + handoff

- [ ] **Step 1: Full verification sweep (evidence before assertions)**

```bash
cd /opt/projects/supermux-a2/server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test
cd /opt/projects/supermux-a2/server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo clippy --all-targets -- -D warnings
cd /opt/projects/supermux-a2/web && bunx tsc -b && bun run lint && bun test tests/unit && bun run build:perf
cd /opt/projects/supermux-a2/web && SUPERMUX_E2E_NO_SANDBOX=1 bun run test:e2e:smoke
```
Paste the real output into the PR. No success claim without it.

- [ ] **Step 2: Open the PR**

```bash
cd /opt/projects/supermux-a2
git push -u origin feat/a2-chat-dataplane
gh pr create --base main --title "feat: fase A2 chat data plane — tailer, parser, chat WS, statusline tap (flagged)" --body "…"
```

PR body must state: the flag is still default-OFF; the migration number and why (0025 is claimed by an in-flight branch); **whether the statusline tap was installed on this host and under which consent**; the Task 6 Step 1 empirical answer about the no-original statusline; and the seed/live no-gap/no-overlap proof with the firehose test name.

- [ ] **Step 3: Hand off.** Do NOT merge, do NOT deploy, do NOT restart :8824.

---

## Self-Review (run after writing code, before the PR)

1. **Spec coverage** — master plan §7's A2 line item by item: tailer + subagents scope + staleness guard + in-memory tail → Task 3 (+2); parser + fixtures → Task 1; chat WS (seed/entry/overlay, caps, firehose) → Task 4; `chat_tail` on the sessions delta → Task 5; statusline tap (owner consent) → Task 6; `?ansi=1` hardened → Task 8; geometry policy → Task 7. Non-goals honoured: no input path, no P5/registry, no `KEY_ALLOWLIST` digits, no design work, no default flip.
2. **Invariants to re-check while executing:** `publish` sends *inside* the lock and `attach` subscribes *inside* the same lock (Task 2 — the whole no-gap proof is those two lines); `WireEntry` fields stay private and `seal` stays the only constructor (Task 1); every seed/live/history/tail path goes through `seal` (Task 4's matrix); the staleness guard never auto-adopts a sibling file (Task 3); the statusline installer is unreachable from create/start (Task 6's pin); the migration file is never edited after it merges (Task 7).
3. **Clock domains:** entry `ts_ms` is CC's clock and is *not* arrival time (A0: up to 27 s apart) — never use it for liveness, ordering across sources, or the supersede window. `activity_at`/`serverNowMs()` remain the only comparison domain, exactly as A1 established.
4. **Placeholder scan:** every step carries a runnable command or real code. The three "verify against the real thing first" instructions (fixture presence in Task 0, the migration number in Task 0/7, the empirical statusline probe in Task 6) are look-before-wiring steps with stated fallbacks, not TBDs.

---

## Verification pass — findings applied to this plan (2026-08-14)

The plan was checked against the repo at `168b303`, `a0-findings.md`, and the master plan. Applied:

1. **`resumable::project_dir_for` confirmed to exist** (`pub(crate)`, `resumable.rs:94`) — an earlier draft's note that it was missing was wrong; the audit table now records the exact signature. `encode_project_dir` is the lower-level helper, not the entry point.
2. **`/peek?ansi=1`, both new hook events, and `activity_at` already shipped** (PRs #56/#57) — A2's scope was cut accordingly (Task 8 is now hardening, not construction), so the plan cannot spend a week rebuilding merged code.
3. **The statusline tap has no existing code AND this host has no `statusLine` key** — the plan's primary case is therefore "no original", which A0 never tested. Added the empirical probe (Task 6 Step 1) and made `wrap` mode refuse rather than silently invent a status line.
4. **Migration numbering corrected to 0026**: `0025_archive_on_stop.sql` is already claimed by an in-flight branch, and 0024's own header documents the reserve-a-number precedent. Task 0 Step 3 re-verifies at execution time; the sqlx-checksum warning is stated where the file is written.
5. **The seed/live boundary was upgraded from a description to a proof**: monotonic `seq` + send-under-lock/subscribe-under-lock + `seq >= high_water` filtering, with a multi-threaded 200-attach firehose test and an explicit `Lagged` → `resync` path (a silent hole was previously possible).
6. **Wire caps made unbypassable by construction** (`WireEntry::seal`, private fields) and tested on *both* the seed and live paths plus history and fetch-full — the master plan only asserted caps existed.
7. **The staleness guard was made a pure, table-tested function** covering all three required failure modes (server restart, terminal-side `--resume`, hook-install failure) plus the false-positive case the naive "newer sibling" rule would hit when two sessions share a cwd; the hook-side pointer-change notification the guard depends on was added explicitly (`hooks.rs`), since without it a `--resume` would only be caught by the slow backstop.
8. **Opt-in made structural**: a test that the create/start path never writes `statusLine`, and install only via an explicit endpoint — "opt-in" is now a build property rather than a convention.
9. **`chat_tail` debounce added** — 30–100 receipts per tool-heavy turn would otherwise mean 30–100 SSE broadcasts to every connected client.
10. **Geometry policy given a detach rule and a no-clamp rule for terminal clients** — the master plan's bare "≥40 cols" would otherwise fight a real mobile viewport, and a phone-sized pty left behind after detach is exactly the fingerprint hazard A4's registry cannot tolerate.
