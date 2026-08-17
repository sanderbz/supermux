# Harness Features → Chat Integration Plan (fase B4/B5 concretized)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make schedules, bot-to-bot delegation, groups, skills and notifications first-class citizens of the new primary chat interface — every harness event visible, attributable and navigable in the transcript, ordered by daily-driver value.

**Architecture:** Three moves. (1) A **durable per-session harness-event feed** (`GET /api/sessions/{name}/events` over `audit_log`, with an SSE `harness` echo) that the client merges into `buildTranscript` — this is the load-bearing piece every system line hangs off, because SSE has no replay and supermux cannot stamp events into Claude's JSONL. (2) **Wrapper tags on harness-authored deliveries** (`<supermux-delegation>`, `<supermux-schedule>`) so `recall.rs` classifies them as first-class kinds and the already-shipped `ArrivalDivider`/`FaceName`/`SystemLine` primitives finally get real data. (3) **Hook-token-scoped write endpoints** (schedule create, mirroring the proven board/schedule-done pattern) so agents create automation conversationally, with audit rows as the source of truth for the system lines.

**Tech Stack:** Rust (axum, sqlx/SQLite, additive migrations only), React + TanStack Query + SSE, vitest, the shipped `components/chat/ui/*` primitives.

**Repo:** All file:line anchors below are from `/opt/projects/supermux-integration` @ `1fe1853` (branch `feat/grok-ui-integration`, 91 commits ahead of `main`).

## Global Constraints

- **Never `cargo build/test --release`** — `cargo check` / debug `cargo test` only (`OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu` in-sandbox).
- **Never edit an existing migration** (`server/migrations/*` are sqlx-checksummed; a `VersionMismatch` bricks deployed installs). New migrations start at `0025`.
- **No provenance from prose.** Every attribution (delegation, schedule fire, rename) must be hook/ledger/wrapper-tag anchored, never a byte heuristic over activity strings (risk class #41/#43). The one existing heuristic (`delegationTarget` in `live-layer.tsx:496`) is *demoted to fallback*, never extended.
- **SSE is the echo, the ledger is the truth.** Anything rendered in the transcript must survive reload — sourced from `audit_log`, `delegations`, the runs ledger, or a wrapper tag in the JSONL. SSE frames only invalidate queries.
- **User reviews all merges** — every task lands as PR-sized commits on a branch; Claude never auto-merges. The deployed instance on 8824 is never restarted without explicit OK.
- Copy is English, sentence case, no emojis in UI copy (glyphs come from the mark/chip system, `⏱` in schedule chips is the one sanctioned glyph, matching `dev-chat-ui.tsx:226-230`).

## Landing strategy: deployed branch vs PR-stack

`main` has only A0/A1. `feat/grok-ui-integration` (deployed for dogfood) has A2–A5 + B0 + the chat surface. Two lanes:

| Lane | Tasks | Rationale |
|---|---|---|
| **Cherry-pickable to `main` now** (touch pre-stack files) | 1, 2 (+wire-kind client lines), 4, 8, 9, 10 (+wire-kind client lines), 12, 14/15 (text-only form; carries `throwaway.ts`/`attention-tiers.ts`), 16, 18 (server half) | `delegate.rs`, `scheduler/*`, `db/*`, `recall.rs`, `api/sessions.ts`, `entries.ts` all exist on `main`; these are standalone reviewable PRs that also de-risk the stack merge. |
| **Waits for the PR-stack merge** (chat surface) | 3, 5, 6, 7, 10 (divider renderer), 11, 13, 17, 18 (client half), 19 | Depend on `components/chat/*`, `entity-picker`, `use-composer`, B0 primitives — none of which exist on `main`. |

**Wire-kind rule (review fix):** on `main` the chat allow-list is a *copy* (`recall.rs:644`), `RecallEntryKind` (`web/src/lib/api/sessions.ts:241`) lacks the new kinds, and `entries.ts` sets `badge = e.kind` unconditionally — so a server-only cherry-pick of Task 2 or 10 would make delegated/scheduled prompts render as the **owner's own bubbles** with an unknown badge, strictly worse than today. Every `main` PR that adds a wire kind therefore bundles its few-line client half (kind union + `speakerOf` branch) — those files exist on `main`.

**Build order** (daily-driver value first; task numbers group by theme, not order): 1 → 2 → 10 → 3 → 4 → 5 → 6 → 13 → 14 → 15 → 7 → 8 → 9 → 11 → 12 → 16 → 17 → 18 → 19. Rationale (review): the curl-footer defect visible on today's deployed dogfood branch (Task 10) is fixed immediately after its wrapper machinery lands (Task 2); spike hygiene (13) and the needs-you rollup + app badge (14/15) are what the owner feels hourly and are stack-light; conversational schedules (8/9) and fan-out (16/17) come after fix-what's-broken.

Development order: all tasks build and dogfood on `feat/grok-ui-integration` (it contains `main`); the server-lane commits are kept mechanically separable (no imports from chat-surface code) so they can be cherry-picked into `main`-based PRs at any time.

---

## §0 Verdicts and decisions (read before any task)

### 0.1 Group chats — the deep-3 "skip" re-examined (owner asked)

deep-3 §11 rows 2 and 35 ruled **skip**: no peer-routed 2–6-bot room, teams stay Claude-native. That verdict was about *Grok's mechanism* — peer self-routing, bots deciding who answers, `@everyone` — and it stands: supermux sessions are independent CLI agents with their own cwd/worktree/context; peer routing would mean unmediated agent↔agent fan-out (token cost, loop hazard: A delegates to B, B "replies" to A, forever) on a system with no session cap. **Do not build a room.**

The *owner-facing* half of group chat — **"ask several sessions one thing and read the answers in one place"** — needs a separate answer, and deep-3 did address it: **row 31** skipped `@everyone` as dangerous fan-out at supermux's session counts (an earlier draft of this section wrongly implied the verdict never considered the owner-facing case). Row 31 is honored, not overturned: the v1 below has no `@everyone`, a hard recipient cap (6) and a confirm step at 4+ (Task 7). Within those bounds the mechanism is free — a fan-out of the existing delegate primitive with the **sender's own transcript** as the merged read view: `POST /api/agents/delegate` (`agents/delegate.rs:35`), the `delegations` edge table (`0005`), and `ArrivalDivider` for each reply coming back (recipients answer by delegating back, per the fleet protocol in the global CLAUDE.md).

**Revised verdict — three-way split:**

| Candidate | Verdict | Why |
|---|---|---|
| Peer-routed room (Grok model) | **Skip, confirmed** | Routing semantics don't exist and shouldn't: unmediated agent fan-out is a cost/loop hazard; "who answers" has no honest answer among independent CLIs. |
| Claude-native agent teams | **Keep as the deep-collaboration model** — and *unblock it*: lift the team-lead chat exclusion (`chat/flag.ts:23`) once the A5 surface is stable, because the lead's transcript is where `Kind::Teammate` envelopes actually occur and `ArrivalDivider` is dead code without it. That lift is fase-A work (its own eligibility/risk review), tracked in the A-series, not here. |
| **Fan-out compose, replies in the sender's transcript** | **Adopt — minimal v1 in this plan (Tasks 16–17)** | One composer draft `@a @b prompt` (≤6 recipients, confirm at 4+) → N delegate edges sharing a `batch` id; the sender's transcript gets **one** collapsed system line with N chips out, and each recipient's reply lands back in that same transcript under its sender's `ArrivalDivider` (Tasks 2–3 make that free). No room, no shared context, no new routing, **no new surface**. |

The v1 deliberately adds no new surface: the earlier draft's Delegations sheet is **cut** (review: it delivered recipient status + a preview behind tap-through — "see who you asked", not "read the answers" — a second inbox for less, while the transcript already does the real thing). If dogfood shows the transcript view isn't enough, the v2 candidate is a batch filter over the transcript or reply-to-all — not now (YAGNI).

### 0.2 Delegation arrival: wrapper tag over client-side join

The surfacing map (§1.2) offered three routes. **Chosen: the wrapper tag** — `delegate.rs` wraps the delivered prompt in `<supermux-delegation from="…">…</supermux-delegation>`; `recall.rs` gains `Kind::Delegation` (same parse shape as the existing `teammate-message` branch at `recall.rs:1159`). Reasons: durable across reloads with zero join heuristics; the *receiving agent* also gains provenance (it currently can't tell a colleague's request from its owner's — Claude's own fleet protocol wraps for exactly this reason); the ts±window join was the #41/#43 class in disguise. Cost accepted: delivered text changes (agents see the tag — that's a feature), and pre-existing delegations in scrollback stay unattributed (acceptable; the events feed still shows the outbound line). Two costs surfaced in review are handled in-task: the wrapped string must never become the session's `last_send_text` preview (Task 2 threads an unwrapped preview through `send_text`), and the wrapper is only delivered to targets whose transcript pipeline can parse it (Task 2 gates on the target's provider being `claude`).

### 0.3 Scheduled prompts: wrap the prompt line only

`execute_tmux` sends `command` and `prompt` as separate submissions (`runner.rs:205-213`, `delivery_lines` at `:225`) — a schedule's `/command` line must stay its own submission or Claude stops executing it as a slash command. So: wrap **only the free-text prompt line** in `<supermux-schedule id="…" title="…">…</supermux-schedule>`; the `confirm_finish` footer (appended to the last line, `runner.rs:227-238`) lands *inside* the wrapper and `recall.rs` strips it for display via a shared sentinel const. Command-only schedules need no wrapper (`Kind::Command` already renders as a distinct chip).

### 0.4 Attention vocabulary — two words, kept apart

`chat/attention.ts:29-34` (`AttentionCause`) is **renderer honesty** ("chat can't model this") and stays untouched. The roster's **needs-you tier** (Tasks 12, 14, 15) is a different concept with a different module (`web/src/lib/attention-tiers.ts`). Full three-tier unread (seen-cursors, `entry_count` deltas) remains B2 scope — this plan ships only the `needs-you` tier, which needs no seen state.

---

### Task 1: Delegate API gains `actor` + honest audit attribution

**Files:**
- Modify: `server/src/agents/delegate.rs:25-73`
- Test: same file, new `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `db::audit::log` (`db/audit.rs:18`), `db::audit::record_delegation` (`db/audit.rs:52`).
- Produces: `DelegateInput { from, to, prompt, actor: Option<String>, batch: Option<String> }` (`batch` is stored by Task 16's migration; accepted-and-ignored until then is wrong — add the field in Task 16, NOT here; this task adds only `actor`). Pure fn `audit_actor(actor: Option<&str>, from: &str) -> String` used by Task 2's event payload too.

Today a composer-initiated delegate would be recorded as `actor: "agent:<from>"` — wrong; the human asked (`delegate.rs:63-70`, master plan §13.2).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actor_human_audits_as_user() {
        assert_eq!(audit_actor(Some("human"), "web-ui"), "user");
    }

    #[test]
    fn actor_absent_audits_as_agent_from() {
        assert_eq!(audit_actor(None, "git-stacker"), "agent:git-stacker");
    }

    #[test]
    fn unknown_actor_falls_back_to_agent_from() {
        // Forward-compat: an unrecognised actor string never impersonates the user.
        assert_eq!(audit_actor(Some("robot"), "x"), "agent:x");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /opt/projects/supermux-integration/server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test agents::delegate -- --nocapture`
Expected: FAIL — `audit_actor` not found.

- [ ] **Step 3: Implement**

In `delegate.rs`: add to `DelegateInput`:

```rust
    /// Who initiated this: `"human"` (composer @-send) or absent (agent curl).
    /// Anything unrecognised is treated as the agent — never impersonates the user.
    #[serde(default)]
    pub actor: Option<String>,
```

Add the pure helper + use it in the handler's `db::audit::log` call (replacing the hardcoded `format!("agent:{from}")`):

```rust
/// Audit-log actor string for a delegation. `"human"` is the composer path.
pub(crate) fn audit_actor(actor: Option<&str>, from: &str) -> String {
    match actor {
        Some("human") => "user".to_string(),
        _ => format!("agent:{from}"),
    }
}
```

The `detail` JSON stays `{"from": from}` — the events feed (Task 4) needs it to resolve the sender for outbound lines.

- [ ] **Step 4: Run tests**

Run: `cargo test agents::delegate` — Expected: PASS. Also `cargo check`.

- [ ] **Step 5: Commit**

```bash
git add server/src/agents/delegate.rs
git commit -m "feat(delegate): explicit actor — a composer delegate audits as the user, not as the agent"
```

---

### Task 2: `<supermux-delegation>` wrapper + `Kind::Delegation` in recall

**Files:**
- Modify: `server/src/agents/delegate.rs` (wrap on delivery, provider-gated)
- Modify: `server/src/sessions/lifecycle.rs:1131-1161` (`send_text` gains an unwrapped-preview parameter for `last_send_text`)
- Modify: `server/src/sessions/recall.rs` — `Kind` enum (`:134`), `classify_user`'s wrapper dispatch (`:1159` region), chat allow-list (`:168` + `:672`)
- Test: `server/src/sessions/recall.rs` tests (the `teammate-message` test at `:1740` is the model)

**Interfaces:**
- Consumes: `tag_inner(body, "supermux-delegation")` (same helper the teammate branch uses), attribute parse identical to `teammate_id`.
- Produces: `Kind::Delegation` with `label = Some(<from-slug>)`, serialized on the wire as `"delegation"` (serde rename mirrors the existing kinds mirrored in `web/src/lib/api/sessions.ts:266`). Wrapper format (delegate.rs writes, recall.rs reads — one const, exported):

```rust
/// What a delegated prompt looks like on the receiver's pty/JSONL. The tag is
/// deliberately visible to the receiving agent: provenance is for it too.
pub fn wrap_delegation(from: &str, prompt: &str) -> String {
    format!("<supermux-delegation from=\"{from}\">\n{prompt}\n</supermux-delegation>")
}
```

Two review-mandated delivery constraints:
- **Provider gate:** wrap only when the *target* session's provider is `claude` — `recall.rs`'s JSONL classification and the chat renderer are Claude-only (`web/src/components/chat/flag.ts:19-24`); a `codex`/`kimi` target gets the raw prompt, since literal XML in their TUI is pure noise (and kimi rides the paste-timing path at `lifecycle.rs:1136-1146`).
- **Preview honesty:** `send_text` ends by writing the sent string to `last_send_text` (`lifecycle.rs:1160-1161`), rendered by `last-send-recall.tsx:88-95` and fed to `receiptClaims` (`pending.ts:234-243`) — the wrapper must not leak there. `send_text` gains an optional unwrapped-preview parameter (e.g. `send_text_with_preview(state, to, wrapped, Some(&prompt))`); `set_last_send` stores the preview, never the wrapper. Task 10's schedule wrapper reuses the same parameter.

- [ ] **Step 1: Write the failing recall test**

```rust
#[test]
fn delegation_wrapper_classifies_with_sender_label() {
    let body = "<supermux-delegation from=\"git-stacker\">\nPlease rebase the stack.\n</supermux-delegation>";
    let c = classify_body(body); // same entry the teammate test at :1740 uses
    assert_eq!(c.kind, Kind::Delegation);
    assert_eq!(c.label.as_deref(), Some("git-stacker"));
    assert_eq!(c.text, "Please rebase the stack.");
}

#[test]
fn delegation_kind_passes_the_chat_allowlist() {
    assert!(Kind::Delegation.chat_visible()); // the :168 matches! helper
}
```

(Adjust `classify_body` to the actual test-side entry point the `:1740` test uses.)

- [ ] **Step 2: Run to verify it fails** — `cargo test sessions::recall` → FAIL (`Delegation` variant missing).

- [ ] **Step 3: Implement**

1. `Kind::Delegation` variant, serde `"delegation"`, doc: "supermux delegate delivery — `<supermux-delegation from>` wrapper".
2. Wrapper branch beside `"teammate-message"` at `recall.rs:1159`: parse `from` attr → `label`, `tag_inner` → text. An absent `from` degrades to `Kind::System` (never a bare prompt).
3. Extend the allow-list helper `Kind::is_user_initiated` (`recall.rs:167`) — and **make it the single site**: review found the chat-tail path at `recall.rs:672` is a second, copy-pasted `matches!` list, not a caller of the helper. Change `:672` to call the helper as part of this task, so Task 10's kind can't half-land.
4. `delegate.rs`: when the target's provider is `claude`, deliver `send_text_with_preview(&state, to, &wrap_delegation(from, &input.prompt), Some(&input.prompt))`; other providers get the raw prompt unchanged (`delegate.rs:57`). `record_delegation` still stores the *unwrapped* prompt.

- [ ] **Step 4: Run** — `cargo test sessions::recall agents::delegate` → PASS; `cargo check`.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/recall.rs server/src/sessions/lifecycle.rs server/src/agents/delegate.rs
git commit -m "feat(delegate): wrap delivery in <supermux-delegation> so the receiver's transcript knows its sender"
```

---

### Task 3: Arrival divider for delegations (client)

**Files:**
- Modify: `web/src/lib/api/sessions.ts:266` (kind union gains `'delegation'`)
- Modify: `web/src/components/chat/grouping.ts:56-65` (`speakerOf`)
- Test: `web/src/components/chat/grouping.test.ts` (extend the existing teammate grouping cases)

**Interfaces:**
- Consumes: `entries.ts:85` already maps any non-`prompt` kind to `badge: e.kind` — `'delegation'` flows with zero change; `entryLabels(entries)` (`chat-panel.tsx:111`) already carries `RecallEntry.label` per uuid — verify it includes delegation entries (it keys off `label` presence, same as teammate).
- Produces: `speakerOf(item)` returns `` `teammate:${label}` `` for `badge === 'delegation'` → `groupItems` emits the run-start divider exactly as for `Kind::Teammate` (`transcript-item.tsx:247-289` renders `ArrivalDivider` + `FaceName` untouched).
- Landing note: the kind-union + `speakerOf` lines developed here are cherry-picked into Task 2's `main` PR (wire-kind rule in the landing strategy); the divider rendering itself rides the stack.

- [ ] **Step 1: Write the failing test**

```ts
it('a delegation item speaks as its sender and opens with an arrival divider', () => {
  const labels = new Map([['u1', 'git-stacker']])
  const items: ChatItem[] = [
    { uuid: 'u1', ts: 1000, type: 'user', text: 'Please rebase.', badge: 'delegation' },
    { uuid: 'u2', ts: 1001, type: 'assistant', text: 'On it.' },
  ]
  const nodes = buildTranscript(items, { nowMs: 2000, labels })
  const row = nodes.find((n) => n.kind === 'message' && n.item.uuid === 'u1')!
  expect(row.speaker).toBe('teammate:git-stacker')
  expect(row.showDivider).toBe(true) // whatever the teammate run-start flag is named
})
```

(Mirror field names from the existing teammate test in `grouping.test.ts` — the flag the divider path reads, not a guess.)

- [ ] **Step 2: Run** — `cd web && npx vitest run src/components/chat/grouping.test.ts` → FAIL (speaker is `'me'`).

- [ ] **Step 3: Implement** — in `speakerOf` (`grouping.ts:58`):

```ts
if (item.badge === 'teammate' || item.badge === 'delegation')
  return `teammate:${labels?.get(item.uuid) ?? ''}`
```

Add `'delegation'` to the `RecallEntry`/`ChatEntry` kind unions (`api/sessions.ts:266`, `entries.ts`).

- [ ] **Step 4: Run** — vitest PASS; `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api/sessions.ts web/src/components/chat/grouping.ts web/src/components/chat/grouping.test.ts
git commit -m "feat(chat): a delegated prompt arrives under its sender's divider, not as the owner's bubble"
```

---

### Task 4: The harness-event feed (server) — the load-bearing piece

**Files:**
- Create: `server/migrations/0025_audit_target_idx.sql`
- Modify: `server/src/db/audit.rs` (per-session query), `server/src/sessions/mod.rs` (route + rename audit), `server/src/agents/delegate.rs` + `server/src/scheduler/mod.rs` + `server/src/scheduler/runner.rs` (SSE `harness` echo after their audit writes)
- Test: `server/src/db/audit.rs` tests (`test_pool()` pattern from `db/prefs.rs:269`)

**Interfaces:**
- Produces:
  - `GET /api/sessions/{name}/events?since_id=<i64>&limit=<n≤200>` → `{ events: [AuditEntry] }`, ascending id; `AuditEntry { id, ts, actor, action, target, detail }` (existing struct — it lives in `db/runtime_state.rs:10-18`, not `db/audit.rs`; `detail` is a JSON **string** on the wire, parsed once client-side in `harness.ts`).
  - `db::audit::events_for_session(pool, session, since_id: i64, limit: i64) -> sqlx::Result<Vec<AuditEntry>>` — rows where the session is the *subject*: `target = ?` OR `json_extract(detail,'$.from') = ?` OR `json_extract(detail,'$.session') = ?` OR `actor = 'agent:' || ?`, filtered to the surfaced action set `('session.delegate','session.rename','schedule.create','schedule.run')`. The `'$.session'` arm is load-bearing (review blocker): `schedule.create`/`schedule.run` rows have `target = <schedule id>`, never the session — without this arm the feed can never return a schedule event and Tasks 5/10/11 have no data source.
  - `runner.rs`'s existing `schedule.run` audit write (`scheduler/runner.rs:92-99`, detail today `{kind,status,manual}`) gains `"session": sched.session` and `"title": sched.title` — new keys on an existing action; pre-existing rows simply stay invisible to the feed (accepted). Task 8's `schedule.create` detail carries `session`+`title` from birth.
  - New audit action **`session.rename`**: logged in the sessions PATCH handler (`sessions/mod.rs:578-698` region, where `display_name` is applied) — `actor: "user"`, `target: <slug>`, `detail: {"from": old, "to": new}` — only when the value actually changed.
  - SSE event type **`harness`**, payload `{ "sessions": [<slug>…], "entry": AuditEntry }`, sent on `state.sse_tx` (`state.rs:287`) immediately after each surfaced audit write (delegate: `[from, to]`; rename: `[slug]`; schedule create/run: `[schedule.session]`). SSE is the *invalidation tick only* — the feed is the truth.
- Consumes: `SseEvent { event, payload }` (`state.rs:93`).

- [ ] **Step 1: Migration** — `0025_audit_target_idx.sql`:

```sql
-- Per-session harness-event reads (GET /api/sessions/{name}/events).
CREATE INDEX idx_audit_target ON audit_log(target, id);
```

(The index serves only the `target = ?` arm; the `json_extract`/`actor` arms scan the action-filtered subset — accepted at `audit_log`'s size, with a `UNION ALL` of indexed arms as the named escape hatch if it ever shows in traces.)

- [ ] **Step 2: Write the failing db test**

```rust
#[tokio::test]
async fn events_for_session_sees_all_subject_arms_and_only_surfaced_actions() {
    let (pool, _dir) = test_pool().await;
    log(&pool, "user", "session.delegate", "deploy-fix", json!({"from":"web-ui"})).await.unwrap();
    log(&pool, "user", "session.rename", "web-ui", json!({"from":"a","to":"b"})).await.unwrap();
    // schedule rows target the SCHEDULE id — only detail.session ties them to the session:
    log(&pool, "system", "schedule.run", "sched-1", json!({"session":"web-ui","title":"Nightly","status":"ok"})).await.unwrap();
    log(&pool, "user", "session.delete", "web-ui", json!({})).await.unwrap(); // not surfaced
    let out = events_for_session(&pool, "web-ui", 0, 50).await.unwrap();
    assert_eq!(out.len(), 3); // outbound delegate (detail.from) + rename (target) + schedule fire (detail.session)
    let inbound = events_for_session(&pool, "deploy-fix", 0, 50).await.unwrap();
    assert_eq!(inbound.len(), 1);
    // since_id is exclusive and ascending:
    let after = events_for_session(&pool, "web-ui", out[0].id, 50).await.unwrap();
    assert_eq!(after.len(), 2);
}
```

- [ ] **Step 3: Run** — `cargo test db::audit` → FAIL. Implement `events_for_session` per the interface above (one SQL statement, `ORDER BY id ASC LIMIT ?`).

- [ ] **Step 4: Route + emitters** — add the axum handler in `sessions/mod.rs` (bearer-layered, 404 on unknown session); add the `session.rename` audit call; add a small helper in `sessions/mod.rs` or `state.rs`:

```rust
/// Fire the `harness` SSE tick for a surfaced audit entry.
pub fn emit_harness(state: &AppState, sessions: &[&str], entry: &db::audit::AuditEntry) {
    let _ = state.sse_tx.send(SseEvent {
        event: "harness".into(),
        payload: json!({ "sessions": sessions, "entry": entry }),
    });
}
```

Call it after the audit writes in `delegate.rs`, the rename path, `scheduler::create` and `runner.rs`'s `schedule.run` log. (Where the audit write returns no entry, re-read is overkill — construct the entry inline from the same values before `log`, or have `log` return the inserted row's id; extend `log` to return `i64` if it doesn't.)

- [ ] **Step 5: Run** — `cargo test db::audit sessions:: scheduler::` → PASS; `cargo check`.

- [ ] **Step 6: Commit**

```bash
git add server/migrations/0025_audit_target_idx.sql server/src/db/audit.rs server/src/sessions/mod.rs server/src/agents/delegate.rs server/src/scheduler
git commit -m "feat(events): replayable per-session harness-event feed over the audit ledger, SSE as its echo"
```

---

### Task 5: Merge harness events into the transcript (client) + system lines

**Files:**
- Create: `web/src/lib/api/harness.ts` (`harnessApi.events(name, sinceId)` + `HarnessEvent` type; `AuditEntry.detail` arrives as a JSON *string* and is `JSON.parse`d here, once), `web/src/components/chat/use-harness-events.ts`
- Modify: `web/src/hooks/use-sse.ts:50` (`SseEventType` gains `'harness'`), `web/src/components/chat/grouping.ts:268` (`buildTranscript`), `web/src/components/chat/transcript-item.tsx` (harness node renderer), `web/src/components/chat/conversation.tsx:199` + `chat-panel.tsx` (pass events through)
- Test: `web/src/components/chat/grouping.test.ts`, `web/src/components/chat/harness-line.test.tsx` (new)

**Interfaces:**
- Consumes: Task 4's feed; `SystemLine`/`SystemSep`/`SystemEntity` (`chat/ui/system-line.tsx:33/48/63`), `MentionChip` (`:94`).
- Produces:
  - `buildTranscript(items, opts)` where `opts` gains `events?: readonly HarnessEvent[]` and `self?: string`; new node `{ kind: 'harness'; ev: HarnessEvent }` merged into the ts-ordered stream (before `dayDividers` so date breaks stay correct).
  - Suppression rules: inbound `session.delegate` (where `target === self`) is dropped — the `ArrivalDivider` (Task 3) is its rendering; a second line would say it twice. `session.rename` with `actor === 'user'` is also dropped — a line telling the owner what they typed two seconds ago is ceremony (review); the ledger row stays, the line ships dark until agent self-rename exists (appendix).
  - Copy map (renderer):
    - `session.delegate` outbound → `Delegated to ●<to>` (MentionChip, seed = target slug, onClick navigates to that session — chips finally get their destination here; pass `onClick` through `SystemEntity`/`MentionChip`, which accept it today and are never handed one, `system-line.tsx:54`).
    - `session.rename` (only when `actor` starts with `agent:` — i.e. a future self-rename) → `Renamed itself to <b>{detail.to}</b>`; user renames render nothing (suppressed above).
    - `schedule.create` → `Created schedule · ⏱ <detail.title>` — chip opens the session-info-panel Schedules section (Task 11); until that lands, no `onClick` → `SystemEntity` degrades to `<b>` by design.
    - `schedule.run` `status==="ok"` → `Ran schedule · ⏱ <detail.title>`; error status → same line in the error tone (a failed schedule is management log, not a toast).
- `useHarnessEvents(name, enabled)` mirrors `use-chat-tail.ts`: TanStack query `['harness-events', name]`, refetched when an SSE `harness` frame's `sessions` includes `name` (same 1.2s trailing debounce).

- [ ] **Step 1: Write the failing merge test**

```ts
it('merges harness events into the stream by ts and suppresses inbound delegate + user rename', () => {
  const events: HarnessEvent[] = [
    { id: 1, ts: 1500, actor: 'user', action: 'session.delegate', target: 'deploy-fix', detail: { from: 'web-ui' } },
    { id: 2, ts: 1600, actor: 'user', action: 'session.delegate', target: 'web-ui', detail: { from: 'deploy-fix' } },
    { id: 3, ts: 1700, actor: 'user', action: 'session.rename', target: 'web-ui', detail: { from: 'a', to: 'b' } },
  ]
  const nodes = buildTranscript(items(/* prompt@1000, assistant@2000 */), { nowMs: 3000, events, self: 'web-ui' })
  const harness = nodes.filter((n) => n.kind === 'harness')
  expect(harness.map((h) => h.ev.id)).toEqual([1]) // inbound (id 2) and user-actor rename (id 3) suppressed
  const idx = nodes.findIndex((n) => n.kind === 'harness')
  expect(nodes[idx - 1]).toMatchObject({ kind: 'message' }) // sits between the turns, ts-ordered
})
```

- [ ] **Step 2: Run** — FAIL (`events` unknown option). Implement the merge in `grouping.ts` (harness events are ts-epoch-seconds like `ChatItem.ts` — verify units against `AuditEntry.ts`, which is `Utc::now().timestamp()` seconds).

- [ ] **Step 3: Renderer test** (`harness-line.test.tsx`, RTL): render the harness node for each action; assert the copy above; assert *clicking* the delegate chip fires the navigate callback (`MentionChip` renders a `<button>` unconditionally, `system-line.tsx:94-113` — asserting the tag proves nothing, review) and the schedule entity renders as `<b>` (`SystemEntity` degrades without `onClick`).

- [ ] **Step 4: Wire** — `chat-panel.tsx` calls `useHarnessEvents(name, enabled)` and passes `events`+`self` through `conversation.tsx:199` into `buildTranscript`. Add `'harness'` to `SseEventType`.

- [ ] **Step 5: Run all** — `npx vitest run src/components/chat` PASS; `npx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api/harness.ts web/src/components/chat web/src/hooks/use-sse.ts
git commit -m "feat(chat): the transcript becomes the management log — durable system lines for delegate, rename, schedules"
```

---

### Task 6: Record-driven delegation pill (heuristic demoted to fallback)

**Files:**
- Create: `web/src/components/chat/delegation-live.ts` (pure selector + module store fed by the SSE `harness` handler)
- Modify: `web/src/components/chat/live-layer.tsx:150,193-205,496-508`
- Test: `web/src/components/chat/delegation-live.test.ts`

**Interfaces:**
- Produces: `pillTarget(records: readonly OutboundDelegation[], statuses: ReadonlyMap<string, SessionStatus>, self: string, nowMs: number): { seed: string; label: string } | undefined` where `OutboundDelegation { to: string; ts: number }` is captured from `harness` SSE frames with `action === 'session.delegate' && detail.from === self`. Rules: newest record wins; shown while `nowMs - ts*1000 < 30_000` **or** the target's status is `'active'` (whichever holds longer); otherwise `undefined`.
- `live-layer.tsx:150` becomes `pillTarget(...) ?? delegationTarget(session.activity, mentions, name)` — the activity-string heuristic survives only as the fallback for pre-event scrollback moments, per the Global Constraint.

- [ ] **Step 1: Failing test**

```ts
it('prefers the delegation record over the activity heuristic and expires it', () => {
  const statuses = new Map([['deploy-fix', 'active' as const]])
  expect(pillTarget([{ to: 'deploy-fix', ts: 100 }], statuses, 'web-ui', 100_500)).toEqual(
    { seed: 'deploy-fix', label: 'deploy-fix' })
  // target went idle AND 30s passed → gone
  expect(pillTarget([{ to: 'deploy-fix', ts: 100 }], new Map([['deploy-fix', 'idle' as const]]), 'web-ui', 140_000))
    .toBeUndefined()
})
```

- [ ] **Step 2: Run** → FAIL. Implement; label resolves display name via the same sessions index the chips use (pass a `names: ReadonlyMap<slug, display>` param if cleaner — keep the fn pure).

- [ ] **Step 3: Wire into `live-layer.tsx`**; delete nothing (fallback stays). Run vitest + tsc.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/chat/delegation-live.ts web/src/components/chat/delegation-live.test.ts web/src/components/chat/live-layer.tsx
git commit -m "fix(chat): the delegation pill is driven by the delegation record; the activity match is only its fallback"
```

---

### Task 7: `@session` in the composer dispatches (single + multi)

**Files:**
- Create: `web/src/components/chat/delegate-draft.ts`, `web/src/lib/api/agents.ts` (`agentsApi.delegate(input)` — the endpoint's first web caller)
- Modify: `web/src/components/chat/use-composer.ts:342+` (submit path), `web/src/components/chat/composer-shell.tsx` (delegate-mode chip row), `web/src/components/chat/slash.ts:334-337` (drop the "v1 inserts only" comment)
- Test: `web/src/components/chat/delegate-draft.test.ts`

**Interfaces:**
- Produces: `parseDelegateDraft(draft: string, sessions: ReadonlySet<string>, self: string): { to: string[]; prompt: string } | null` — a leading run of `@<slug>` tokens, each a known session ≠ self, then a non-empty prompt. Any unknown token or empty remainder → `null` (the draft sends normally; a typo'd @name must never silently delegate).
- Consumes: Task 1's `actor: "human"`; `FaceName` (`chat/ui/facepile.tsx:129`) for the chip row.
- Submit semantics: when the parse matches, `submit()` (`use-composer.ts:390+`) sends `agentsApi.delegate({ from: name, to, prompt, actor: 'human' })` per recipient **instead of** the session send; success clears the draft and shows notice `Handed off to ●<to>` (existing `ComposerNotice` channel); failure keeps the draft (same contract as a failed send). While the parse matches, `composer-shell.tsx` renders a chip row above the textarea: `To ●deploy-fix` (FaceName per recipient) — the honest, cheap alternative to styling tokens inside a `<textarea>` (overlay-mirror is out of scope, surfacing map §3c).
- Guardrails (review-mandated):
  1. **Cap:** more than 6 recipients → submit refuses (draft kept, notice `Too many recipients (max 6)`). deep-3 row 31 skipped `@everyone` for exactly this fan-out hazard; the cap is how the v1 honors that verdict (§0.1).
  2. **Confirm:** 4–6 recipients → the first Enter arms a confirm state (chip row shows `Send to N sessions — Enter again to confirm`); the second Enter sends.
  3. **Wake honesty:** `send_text` auto-starts a stopped target before delivering (`lifecycle.rs:1131-1134`) — `@deploy-fix ship it` can silently boot an agent, and a fan-out can boot N from one Enter. The chip row annotates every non-running recipient `will wake ●x` (status from the sessions store) — including throwaways, which Task 13 deliberately keeps mentionable, so `@spike-vt` visibly says it will boot the spike.

- [ ] **Step 1: Failing tests**

```ts
const known = new Set(['deploy-fix', 'git-stacker'])
it('parses a single leading mention', () => {
  expect(parseDelegateDraft('@deploy-fix ship it', known, 'web-ui'))
    .toEqual({ to: ['deploy-fix'], prompt: 'ship it' })
})
it('parses a fan-out', () => {
  expect(parseDelegateDraft('@deploy-fix @git-stacker status?', known, 'web-ui'))
    .toEqual({ to: ['deploy-fix', 'git-stacker'], prompt: 'status?' })
})
it('refuses unknown names, self, mid-text mentions, and empty prompts', () => {
  expect(parseDelegateDraft('@nobody hi', known, 'web-ui')).toBeNull()
  expect(parseDelegateDraft('@web-ui hi', known, 'web-ui')).toBeNull()
  expect(parseDelegateDraft('ship @deploy-fix it', known, 'web-ui')).toBeNull()
  expect(parseDelegateDraft('@deploy-fix', known, 'web-ui')).toBeNull()
})
```

- [ ] **Step 2: Run** → FAIL. Implement the parser (token split on whitespace; no regex over arbitrary words — membership in `sessions` is the only promotion, same doctrine as `mentionSegments`).

- [ ] **Step 3: Wire submit + chip row + guardrails.** The slash gate (`use-composer.ts:397+`) runs first and still wins — `/model` etc. can't be smuggled via `@x /model`. Extract the wake annotation as a pure helper `wakeTargets(to, statuses)` with its own test; extend the use-composer suite with the cap-refusal and confirm-arm cases. Update the `slash.ts:334-337` comment to name this task as the dispatch it promised.

- [ ] **Step 4: Run** — vitest + tsc + `npx vitest run src/components/chat/use-composer` (existing suite must stay green).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/chat/delegate-draft.ts web/src/components/chat/delegate-draft.test.ts web/src/lib/api/agents.ts web/src/components/chat/use-composer.ts web/src/components/chat/composer-shell.tsx web/src/components/chat/slash.ts
git commit -m "feat(chat): @session in the composer delegates for real — one or many recipients, human-attributed"
```

---

### Task 8: Hook-token schedule creation (agents can now make automation)

**Files:**
- Modify: `server/src/scheduler/hook.rs:39-42` (router gains the route), `server/src/scheduler/mod.rs` (`create` gains an audit row for both paths)
- Test: `server/src/scheduler/hook.rs` tests (model: the existing `done_handler` tests; `test_state()` pattern from `sessions/mod.rs:1564`)

**Interfaces:**
- Produces: `POST /api/hook/schedule/create` — headers `X-Supermux-Hook-Token`; body `{ session, title, prompt?, command?, schedule_expr, confirm_finish?, watch? }` (a strict subset of `CreateScheduleInput`, `scheduler/mod.rs:201`). Rules:
  1. `authenticate(state, headers, session)` (`hook.rs:46`) — the proven constant-time compare.
  2. The created schedule's `session` **is** the authenticated session — a token can only automate its own pane (scope rule identical to the done-hook's).
  3. `kind` is forced to `"tmux"` — **boot jobs are refused** (an agent spawning worktree sessions unattended is the deep-3 row-40 hazard; same refusal the test-fire path already makes at `mod.rs:435-441`).
  4. Reuses `create(&state, input)` (`scheduler/mod.rs:252` — review corrected the anchor) → cadence parse errors return 400 with the parser's message, so the skill can self-correct.
  5. Response: the schedule JSON + **`next_runs`** — reuse `preview_runs`, the engine behind `POST /api/schedules/preview` (`mod.rs:459-469`), whose response key is `next_runs`. (There is no `next_fires` anywhere in the tree — review; the skill echoes `next_runs`.)
- Both create paths (bearer + hook) write audit `schedule.create` — `actor` `"user"` / `"agent:<session>"`, `target` = schedule id, `detail {"title", "session"}` — and fire `emit_harness` (Task 4).

- [ ] **Step 1: Failing tests**

```rust
#[tokio::test]
async fn hook_create_is_scoped_to_the_authenticated_session() {
    let (state, _dir) = test_state().await; // seeded session "alpha" with a hook token
    // valid token, session=alpha → 201, schedule.session == "alpha"
    // valid token for alpha, body says session="beta" → 401/403 (never created)
    // kind="boot" → 400 "boot schedules cannot be created by an agent"
    // schedule_expr="every blorp" → 400 containing the parser's message
}
```

(Flesh each arm with the same request-building helpers the done-hook tests use; four asserts, one test fn per arm if the file's style prefers.)

- [ ] **Step 2: Run** → FAIL (404 route). Implement handler + audit rows.

- [ ] **Step 3: Run** — `cargo test scheduler::` PASS; `cargo check`.

- [ ] **Step 4: Commit**

```bash
git add server/src/scheduler/hook.rs server/src/scheduler/mod.rs
git commit -m "feat(scheduler): hook-token create endpoint — an agent can automate its own session, and only its own"
```

---

### Task 9: The `supermux-schedule` managed skill (model-invocable)

**Files:**
- Create: `server/src/agents/supermux-schedule.md`
- Modify: `server/src/agents/skills.rs:91-120` region (seed consts + a `seed_managed_skills` sibling of `seed_managed_commands`)
- Test: `server/src/agents/skills.rs:412` tests (extend the existing seeding tests)

**Interfaces:**
- Consumes: Task 8's endpoint; the managed-seed machinery (`MANAGED_MARKER` at `skills.rs:102`, `include_str!` pattern at `:111`, idempotent non-clobbering seeder at `:218`).
- Produces: `SUPERMUX_SCHEDULE_NAME: &str = "supermux-schedule"`, `SUPERMUX_SCHEDULE_SKILL: &str = include_str!("supermux-schedule.md")`, seeded to **`~/.claude/skills/supermux-schedule/SKILL.md`** — a model-invocable *skill*, not a `~/.claude/commands` slash command. Review blocker: `seed_managed_commands` writes human-typed slash commands; nothing ever puts `/supermux-schedule` in an agent's head (`/supermux-task` only reaches agents because schedules send the literal line, `runner.rs:208`), so "schedule this every morning" in chat would never trigger a commands file. A skill's `description` **is** the trigger surface — write it to fire on scheduling/automation requests. No commands twin is seeded: the human-typed path is Task 11's sheet (appendix).

Skill file content (complete):

```markdown
---
name: supermux-schedule
description: Use when the user asks to schedule, automate, remind, or run something later or on a recurring basis (e.g. "every morning", "at 9am", "check this nightly"). Creates a schedule for THIS session via the supermux hook API.
supermux-managed: true
---
Turn the user's request into a concrete schedule for your OWN session and create it
via the supermux hook API. Steps:

1. Derive a cron/interval expression yourself. Accepted forms (server-validated):
   5-field cron (`30 9 * * 1-5`), `every 15m`, `every weekday at 9:30`,
   `every morning`, or a one-shot `at 2026-08-17 09:00`.
2. Compose a short imperative `title` and the `prompt` the schedule should send
   to this session on each fire. Never schedule destructive commands.
3. Create it:
   curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
     "$SUPERMUX_URL/api/hook/schedule/create" \
     -H 'Content-Type: application/json' \
     -d '{"session":"'$SUPERMUX_SESSION'","title":"<title>","prompt":"<prompt>","schedule_expr":"<expr>","confirm_finish":true}'
4. On 400, the body contains the parser's complaint — fix the expression and retry once.
5. Reply to the user with the title and the returned `next_runs` so they can
   confirm the cadence reads as intended. Do not create duplicates: if they
   rephrase, edit via the UI is the answer, not a second schedule.
```

- [ ] **Step 1: Failing test** — extend the seeder tests: after seeding, `~/.claude/skills/supermux-schedule/SKILL.md` exists, contains `MANAGED_MARKER`, and a pre-existing *user* file at that path is preserved (non-clobber branch, same shape as the supermux-task cases).

- [ ] **Step 2: Run** → FAIL. Implement (consts + the skills-dir seeder).

- [ ] **Step 3: Run** — `cargo test agents::skills` PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/agents/supermux-schedule.md server/src/agents/skills.rs
git commit -m "feat(skills): supermux-schedule skill — 'schedule this every morning' in chat becomes a real schedule"
```

---

### Task 10: Scheduled fires stop impersonating the owner

**Files:**
- Modify: `server/src/scheduler/runner.rs:210-244` (`execute_tmux`), `server/src/sessions/recall.rs` (`Kind::Schedule` + footer strip)
- Test: `server/src/sessions/recall.rs` tests; `server/src/scheduler/runner.rs` tests

**Interfaces:**
- Produces: shared consts in `runner.rs` (re-used by recall):

```rust
/// Sentinel opening the agent-confirm footer (recall strips from display).
pub const CONFIRM_FOOTER_SENTINEL: &str = "— — —";

/// Wrap the free-text prompt line of a scheduled delivery.
pub fn wrap_schedule(id: &str, title: &str, prompt: &str) -> String {
    format!("<supermux-schedule id=\"{id}\" title=\"{title}\">\n{prompt}\n</supermux-schedule>")
}
```

  - `execute_tmux`: the `prompt` element of `delivery_lines` is wrapped (title attr XML-escaped — reuse whatever escaping the teammate/delegation writer settled on; quotes and `<>` at minimum); the `command` line is **left untouched** (§0.3 — it must stay a real slash submission). The `confirm_footer` still appends to the last line, i.e. lands inside the wrapper when a prompt exists; when the schedule is command-only the footer attaches to the command line unwrapped (unchanged behavior — accepted residual, rare and visible-in-terminal-only). Delivery uses Task 2's unwrapped-preview parameter so `last_send_text` shows the plain prompt — never the wrapper or the footer (review: `last_send_text` is user-visible via `last-send-recall.tsx` and `receiptClaims`).
  - `recall.rs`: `Kind::Schedule` (wire `"schedule"`, `label = title`), wrapper branch beside Task 2's; the extracted text drops everything from the first line equal to `CONFIRM_FOOTER_SENTINEL` onward (exact machine-generated block, not a heuristic — the const is the contract). Allow-list gains `Kind::Schedule`.
- Client (small, same task): the schedule becomes a **speaker** — the third option the earlier draft never considered (review: an owner-styled bubble with a hat above it is still the owner's voice; §0.3's reasoning rejected `'system'` and stopped there). `speakerOf` maps `badge === 'schedule'` → `` `schedule:${label}` `` (label = title via `entryLabels`), so the **run breaks** — a 03:00 fire must not group into the human's last run (`SYSTEM_BADGES` at `grouping.ts:56` would otherwise return `'me'`) — and the group opens through the same `ArrivalDivider`/`FaceName` path teammates use, rendered with the `⏱` mark + schedule title instead of an avatar seed. The prompt bubble below belongs to that speaker, not the owner. Add `'schedule'` to the kind unions (`api/sessions.ts:266`, `entries.ts`) — these lines ride Task 10's `main` PR (wire-kind rule). `grouping.test.ts` asserts speaker + run break; `harness-line.test.tsx` covers the divider copy.

- [ ] **Step 1: Failing recall test**

```rust
#[test]
fn schedule_wrapper_classifies_and_strips_the_confirm_footer() {
    let body = "<supermux-schedule id=\"s1\" title=\"Nightly release watch\">\ncheck the release\n\n— — —\nWhen this scheduled task is FULLY complete… curl…\n</supermux-schedule>";
    let c = classify_body(body);
    assert_eq!(c.kind, Kind::Schedule);
    assert_eq!(c.label.as_deref(), Some("Nightly release watch"));
    assert_eq!(c.text, "check the release");
}
```

- [ ] **Step 2: Run** → FAIL. Implement recall side.

- [ ] **Step 3: Runner test** — `wrap_schedule` escaping + `delivery_lines`-with-wrapper integration (prompt wrapped, command not).

- [ ] **Step 4: Client render + tests** (schedule speaker with `⏱` arrival divider + run break; the multi-line `curl` block is gone from chat — the visible quality bug on today's deployed surface, surfacing map §1.4).

- [ ] **Step 5: Run all** — `cargo test scheduler:: sessions::recall`, `npx vitest run src/components/chat` → PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/scheduler/runner.rs server/src/sessions/recall.rs web/src/lib/api/sessions.ts web/src/components/chat
git commit -m "feat(chat): a scheduled fire says which schedule ran it — and the curl footer leaves the chat"
```

---

### Task 11: Per-session Schedules sheet (chip destination + daily management)

**Files:**
- Modify: `web/src/components/focus-mode/session-info-panel.tsx:500-560` (`SchedulesList`), `web/src/components/chat/transcript-item.tsx` (schedule chips gain `onClick`)
- Test: `web/src/components/focus-mode/session-info-panel.test.tsx` (or the panel's existing test file)

**Interfaces:**
- Consumes: `ScheduleDetailSheet` (`web/src/components/scheduler/schedule-detail-sheet.tsx` — run history + status pills already built), `POST /api/schedules/{id}/run` (run-now, `scheduler/mod.rs:182`), the existing `ScheduleForm`.
- Produces:
  1. `SchedulesList` rows become buttons opening `ScheduleDetailSheet` (pause/enable, run-now, last-20 history — all existing plumbing, `mod.rs:533-654`).
  2. A `New schedule` button opening `ScheduleForm` prefilled with `session: name` — the trivial human path of master plan §13.3(b).
  3. An exported opener (`openSchedulesPanel(name)` or an equivalent route/query-param hook the panel already supports) that Task 5's `Created schedule` / `Ran schedule` chips call — chips upgrade from `<b>` to `<button>` here.
- [ ] **Step 1: Failing render test** — RTL: `SchedulesList` with one schedule renders a button; clicking opens the sheet (assert by sheet title); `New schedule` button present.
- [ ] **Step 2: Implement.** Keep the sheet as the single detail surface — no inline editing in the list (Settings stays the global admin per §12.8; this panel is the per-session IA Grok got right, deep-3 row 28).
- [ ] **Step 3: Wire the chip `onClick` in `transcript-item.tsx`'s harness renderer; update `harness-line.test.tsx`: the schedule chip is now a `<button>`.**
- [ ] **Step 4: Run** — vitest + tsc → PASS.
- [ ] **Step 5: Commit**

```bash
git add web/src/components/focus-mode/session-info-panel.tsx web/src/components/chat
git commit -m "feat(schedules): the session's own Schedules sheet — list, run-now, history — and the chips now go there"
```

---

### Task 12: Run-record pruning (keep last 20 per schedule)

**Files:**
- Modify: `server/src/db/schedules.rs` (`insert_run` region, read cap at `:385`)
- Test: same file

**Interfaces:** after every `insert_run`, delete rows beyond the newest 20 for that schedule id (one `DELETE … WHERE schedule_id = ? AND id NOT IN (SELECT id … ORDER BY id DESC LIMIT 20)`). Grok's one sensible cap (deep-3 row 36); the table currently grows unbounded.

- [ ] **Step 1: Failing test**

```rust
#[tokio::test]
async fn run_records_prune_to_twenty_per_schedule() {
    let (pool, _d) = test_pool().await;
    for i in 0..25 { insert_run(&pool, "s1", /* status */ "ok", &format!("run {i}")).await.unwrap(); }
    insert_run(&pool, "s2", "ok", "other schedule untouched").await.unwrap();
    assert_eq!(count_runs(&pool, "s1").await.unwrap(), 20);
    assert_eq!(count_runs(&pool, "s2").await.unwrap(), 1);
    // the survivors are the NEWEST 20:
    let runs = runs_for(&pool, "s1", 50).await.unwrap();
    assert!(runs.iter().all(|r| !r.note.contains("run 0")));
}
```

(Match `insert_run`'s real signature; add a test-only `count_runs` if none exists.)

- [ ] **Step 2: Run** → FAIL (25). Implement. Run → PASS.
- [ ] **Step 3: Commit**

```bash
git add server/src/db/schedules.rs
git commit -m "feat(scheduler): run-record retention — keep the last 20 per schedule, matching what the UI shows"
```

---

### Task 13: Spike/test-session hygiene (the owner answered a spike's dialog)

**Files:**
- Create: `web/src/lib/throwaway.ts`
- Modify: `web/src/lib/overview-layout.ts:291` (`smartSort`), `web/src/components/chat/slash.ts:318` (`atRows` ranking), the tile + `SessionIdentityRow`-equivalent row components (muted treatment), `web/src/lib/attention-tiers.ts` (Task 14 consumes)
- Test: `web/src/lib/throwaway.test.ts`, `web/src/lib/overview-layout.test.ts`

**Interfaces:**
- Produces:

```ts
/** A throwaway session: named like a spike/scratch bench. Slug-anchored —
 *  never inferred from activity or content (Global Constraint). */
const THROWAWAY = /^(spike|test|tmp|scratch)([-_]|\d|$)/
export function isThrowaway(slugOrSession: string | { name: string }): boolean
```

  (No `tags` column exists on `ApiSession` — slug prefix is the only honest signal today; when B2's tags UI lands, `tags.includes('test')` joins the predicate.)
- Behavior:
  1. `smartSort` (`overview-layout.ts:291`): throwaways sort **after** everything else regardless of pin/status (a fourth, leading comparator: `Number(isThrowaway(a)) - Number(isThrowaway(b))`).
  2. `atRows` (`slash.ts:318`): throwaway sessions rank after non-throwaways at equal match quality (post-rank stable partition — never excluded; you may genuinely want to @ a spike).
  3. Visual: tile/roster row for a throwaway renders muted (55% ink on the title, dashed identity-ring on the mark, a small `spike` badge in the meta slot) — distinct enough that a dialog popping from `spike-*` reads as *not one of your real agents* before you type into it.
  4. Excluded from the needs-you rollup and app badge (Tasks 14/15) — the *ambient* tiers only. `waiting`/`error` push stays **on** for throwaways unless the owner explicitly mutes (Task 15, review): silencing by filename is the expensive direction of the name heuristic — a genuine `test-harness` session going dark is a miss the owner discovers by missing something.

- [ ] **Step 1: Failing tests**

```ts
it('classifies throwaways by slug prefix only', () => {
  for (const s of ['spike-vt', 'test_x', 'tmp-1', 'scratch', 'test9']) expect(isThrowaway(s)).toBe(true)
  for (const s of ['testament', 'spiker', 'web-ui', 'contest']) expect(isThrowaway(s)).toBe(false)
})
it('smartSort puts throwaways last, even pinned/waiting ones', () => {
  const out = smartSort([sess('spike-a', { pinned: true, status: 'waiting' }), sess('real-b', { status: 'idle' })])
  expect(out.map((s) => s.name)).toEqual(['real-b', 'spike-a'])
})
```

Note `testament`/`spiker`/`contest`: the regex requires a separator, digit or end after the keyword — encode that.

- [ ] **Step 2: Run** → FAIL. Implement predicate + sort + ranking partition.
- [ ] **Step 3: Visual treatment** on tile + row components (locate the mark-bearing row/tile components B0 shipped; apply `data-throwaway` + the muted classes; screenshot via the existing `/dev` bench recipe if in doubt).
- [ ] **Step 4: Run** — vitest + tsc → PASS.
- [ ] **Step 5: Commit**

```bash
git add web/src/lib/throwaway.ts web/src/lib/throwaway.test.ts web/src/lib/overview-layout.ts web/src/components/chat/slash.ts web/src/components
git commit -m "feat(overview): spike/test sessions look like spikes — muted, sorted last, never paging you"
```

---

### Task 14: The needs-you rollup (overview header facepile)

**Files:**
- Create: `web/src/lib/attention-tiers.ts`, `web/src/components/overview/needs-you.tsx`
- Modify: `web/src/routes/overview.tsx:520` (the `<header className="mb-4 flex flex-wrap items-center …">`)
- Test: `web/src/lib/attention-tiers.test.ts`, `web/src/components/overview/needs-you.test.tsx`

**Interfaces:**
- Produces:

```ts
/** Roster tier 1 — the session is asking for a human. Status-anchored:
 *  'waiting' (question/permission) and 'error' promote; throwaways never do.
 *  NOT chat/attention.ts's AttentionCause — that is renderer honesty (§0.4). */
export function needsYou(s: Pick<ApiSession, 'name' | 'status'>): boolean {
  return (s.status === 'waiting' || s.status === 'error') && !isThrowaway(s.name)
}
export function needsYouList(sessions: readonly ApiSession[]): ApiSession[]  // stable, smartSort order
```

  (Verify `'error'` against the full `SessionStatus` union at `api/sessions.ts:18` — if the wire says `'stopped'`/`'unknown'` only, error surfaces via the alerts path and the predicate is `'waiting'`-only in v1; write the test against the real union.)
- `<NeedsYou sessions={…} />`: renders nothing when empty; else a **text pill** `needs you · N`. The cluster facepile is dropped from v1 (review): it is `aria-hidden`, so the count text carries the whole signal anyway, and `Facepile variant="cluster"` is deep-3 row 34's *team* mark — spending it first on an arbitrary set of waiting sessions overloads the mark before teams get it. Click opens a popover list of plain session-name rows (master-plan §12.3 tap-target: navigate to the session — the chat scrolled to its pending card is the A-series' job once mounted; navigation is the v1 contract). Text-only also makes the component `main`-eligible — no B0 imports; a FaceName-row upgrade can follow on the stack lane.
- [ ] **Step 1: Failing tests** — predicate cases (waiting yes, active no, waiting spike no); RTL: 0 sessions → null; 4 needing → `needs you · 4`; click → list; row click → `navigate('/focus/<name>')` (or the app's real route helper — copy from an existing tile's click handler).
- [ ] **Step 2: Run** → FAIL. Implement.
- [ ] **Step 3: Mount in `overview.tsx:520`'s header** (right-aligned, before the New group button).
- [ ] **Step 4: Run** — vitest + tsc → PASS.
- [ ] **Step 5: Commit**

```bash
git add web/src/lib/attention-tiers.ts web/src/components/overview/needs-you.tsx web/src/routes/overview.tsx
git commit -m "feat(overview): needs-you rollup — the header count that ends permission-prompt blindness"
```

---

### Task 15: Notifications wired to the tier (per-session mute + app badge)

**Files:**
- Modify: `server/src/db/push.rs:126-160` (session-scoped check), the push dispatch sites (`db/push.rs:80-121` callers), `web/src/components/focus-mode/session-info-panel.tsx` (mute toggle), `web/src/routes/settings.tsx:440-467` (copy note: per-session mute exists)
- Create: `web/src/lib/app-badge.ts`
- Test: `server/src/db/push.rs` tests (extend the `:205+` suite), `web/src/lib/app-badge.test.ts`

**Interfaces:**
- Server: `pub async fn enabled_for(pool, cat: NotifCategory, session: &str) -> bool` = `pref_enabled(pool, cat) && !muted(pool, session)` where `muted` reads prefs key `notif.mute.<session>` (`"1"` = muted; key deleted on unmute). Every category dispatch that has a session in hand switches from `pref_enabled` to `enabled_for`. **No name-based default-mute on the server** (review): the throwaway rule silences only the ambient tiers client-side (Tasks 13/14 exclude spikes from rollup + badge); `waiting`/`error` push stays on for every session until the owner explicitly mutes — silencing by filename is the Global Constraint's inference-from-bytes in its most expensive direction. This also removes any Rust/TS regex duplication.
- Client: session-info-panel gains a `Notifications` row showing the **effective** state and its reason (`on` / `muted by you`; a throwaway additionally notes `excluded from badge — spike naming`, so nothing is ever silently dark) with the mute toggle writing the pref via the existing prefs API; `app-badge.ts` exports `syncAppBadge(count: number)` — `navigator.setAppBadge(count)` / `clearAppBadge()` behind feature-detection, called from the overview's sessions subscription with `needsYouList(sessions).length` (Task 14's function — the badge and the rollup can never disagree).
- [ ] **Step 1: Failing server test** — set `notif.mute.web-ui = "1"` → `enabled_for(AgentWaiting, "web-ui")` false while `pref_enabled(AgentWaiting)` true; `enabled_for(AgentWaiting, "spike-x")` **true** with no pref set (no name-based server mute).
- [ ] **Step 2: Run** → FAIL. Implement; sweep dispatch call sites.
- [ ] **Step 3: Client** — badge fn test (mock `navigator`), toggle row, wire `syncAppBadge`.
- [ ] **Step 4: Run** — `cargo test db::push`, vitest, tsc → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/src/db/push.rs server/src/push.rs web/src/lib/app-badge.ts web/src/components/focus-mode/session-info-panel.tsx web/src/routes/settings.tsx
git commit -m "feat(push): per-session mute and an app badge that counts who needs you"
```

---

### Task 16: Fan-out batches on the wire (group v1, server)

**Files:**
- Create: `server/migrations/0026_delegation_batch.sql`
- Modify: `server/src/agents/delegate.rs` (accept + store `batch`), `server/src/db/audit.rs` (`Delegation` struct + queries carry `batch`)
- Test: `server/src/db/audit.rs` tests

**Interfaces:**
- Migration:

```sql
-- Fan-out compose: delegate calls sharing one composer submission share a batch.
ALTER TABLE delegations ADD COLUMN batch TEXT;
CREATE INDEX idx_delegations_batch ON delegations(batch) WHERE batch IS NOT NULL;
```

- `DelegateInput` gains `#[serde(default)] pub batch: Option<String>` (client-generated uuid, opaque); `record_delegation(pool, from, to, prompt, batch: Option<&str>)`; `delegations_out`/`delegations_in` (`db/audit.rs:73/85`) select it. The Task 4 `harness` payload's delegate entries carry `detail.batch` when present, so the client can render one line per batch instead of N.
- [ ] **Step 1: Failing test** — record two edges with the same batch, one without; `delegations_out` returns batch values; a filtered `delegations_batch(pool, batch)` returns exactly the pair in insert order.
- [ ] **Step 2: Run** → FAIL. Implement (migration + plumbing).
- [ ] **Step 3: Run** — `cargo test db::audit agents::delegate` → PASS.
- [ ] **Step 4: Commit**

```bash
git add server/migrations/0026_delegation_batch.sql server/src/db/audit.rs server/src/agents/delegate.rs
git commit -m "feat(delegate): fan-out batches — N edges from one composer submission share an id"
```

---

### Task 17: The fan-out line (group v1, client)

**Files:**
- Modify: `web/src/components/chat/use-composer.ts` (Task 7's submit passes one generated `batch` uuid to all recipients), `web/src/components/chat/grouping.ts` (`collapseBatches`), `web/src/components/chat/transcript-item.tsx` (batched harness line)
- Test: `web/src/components/chat/grouping.test.ts`, `web/src/components/chat/harness-line.test.tsx`

**Interfaces:**
- Transcript: harness delegate events sharing `detail.batch` collapse to **one** system line — `Delegated to ●a, ●b and ●c` (chips per recipient; the `and`-joining copy matches `ArrivalDivider`'s existing list grammar). Pure helper `collapseBatches(events: HarnessEvent[]): HarnessEvent[][]` in `grouping.ts`, tested.
- The read view **is the sender's transcript** (§0.1 revised): each recipient's reply arrives as a delegation under its own `ArrivalDivider` (Tasks 2–3; recipients answer by delegating back per the fleet protocol), so "read the answers in one place" is already true where the question was asked. The earlier draft's `delegations-sheet.tsx` + session-info-panel Delegations section are **cut from v1** (review: recipient status + a preview behind tap-through is "see who you asked", not "read the answers" — a second inbox delivering less than the transcript). V2 candidate, only if dogfood demands it: a batch filter over the transcript — not a new surface.
- [ ] **Step 1: Failing tests** — `collapseBatches` (two batched + one solo → 2 groups, order preserved); `harness-line.test.tsx`: a batch of three renders one line with three chips, and clicking each chip fires navigation to that recipient.
- [ ] **Step 2: Run** → FAIL. Implement.
- [ ] **Step 3: Wire** — Task 7's submit generates `crypto.randomUUID()` once per submission and passes it as `batch` on every recipient's delegate call.
- [ ] **Step 4: Run** — vitest + tsc → PASS.
- [ ] **Step 5: Commit**

```bash
git add web/src/components/chat
git commit -m "feat(chat): the fan-out line — one collapsed line out, every reply back under its sender's divider"
```

---

### Task 18: Skills polish — argument hints at the point of pick

**Files:**
- Modify: `server/src/agents/skills.rs` (`/api/slash-commands` rows gain `argument_hint`), `web/src/components/chat/slash.ts` (`SlashCommandRow` + `slashRows` meta), `web/src/components/chat/entity-picker.tsx` (render the hint dimmed after the label)
- Test: `server/src/agents/skills.rs` tests, `web/src/components/chat/slash.test.ts`

**Interfaces:** the frontmatter parser already reads `argument-hint` (`skills.rs:9-11`) but `/api/slash-commands` returns only `{cmd, desc}` — add `argument_hint: Option<String>`; `slashRows` (`slash.ts:358`) surfaces it as the row's trailing dim text and, on pick, inserts `/cmd ` (existing `insertAtCaret` behavior unchanged — the hint is shown, never inserted). The audit found skills already ahead of Grok (refusal badges, `slash.ts:105-192`); this is the one visible gap worth a task. Per-session skill enable stays **deferred, on its own merits** — the earlier draft cited deep-3 row 27 for this, inverted (review: row 27's verdict is global *storage* with *per-session enable* in the same sentence — it asks for the thing being deferred). The honest rationale: there is no Library surface yet to hang an enable toggle on, and every seeded skill today is either universally applicable or self-scoping; revisit when B2's Library work builds that surface.

- [ ] **Step 1: Failing tests** — server: a skill with `argument-hint: <pr-number>` appears in `/api/slash-commands` with the hint; client: `slashRows` carries it into `EntityRow.meta` (desc and hint joined `desc · hint` when both).
- [ ] **Step 2: Run** → FAIL. Implement both halves.
- [ ] **Step 3: Run** — `cargo test agents::skills`, vitest → PASS.
- [ ] **Step 4: Commit**

```bash
git add server/src/agents/skills.rs web/src/components/chat/slash.ts web/src/components/chat/entity-picker.tsx
git commit -m "feat(skills): the slash picker says what a skill wants before you pick it"
```

---

### Task 19: Dogfood gate + landing PRs

**Files:** none new — verification + PR assembly.

- [ ] **Step 1: Full suites** — `cargo test` (debug), `npx vitest run`, `npx tsc --noEmit`, lint. All green before any PR.
- [ ] **Step 2: Live dogfood on the deployed instance** (deploy only with the owner's explicit OK, per standing rule): delegate from the composer of one session to another → sender shows the pill + `Delegated to ●x` line, the chip row said `will wake` if the target was stopped, and `last_send_text` shows the plain prompt (no wrapper); receiver shows the arrival divider; reload both — everything survives (the replay property, the whole point). Ask a session **in plain language** "schedule this every morning" → the seeded skill triggers (its `description` is the mechanism, Task 9) → `Created schedule · ⏱ …` line + chip opens the sheet, and the agent's reply echoes `next_runs`. Let one schedule fire → the schedule's own `⏱` arrival divider, run break from the owner's messages, no curl footer. Re-verify against **real** captures, not the bench (standing rule: re-verify subagent "live" claims).
- [ ] **Step 3: Assemble PRs** — server lane (Tasks 1, 2, 4, 8, 9, 10, 12, 14/15 text-only, 16 — with Tasks 2 and 10 bundling their wire-kind client lines per the landing strategy) as `main`-targeted cherry-pick PRs; chat lane rides `feat/grok-ui-integration`'s existing stack. Hand every PR to the owner; never auto-merge.

---

## Self-review checklist (ran at write time)

- **Spec coverage:** delegation (Tasks 1–3, 6–7), conversational schedules + system lines + sheet (8–11), attention rollup (14), skills (9, 18), notifications→tiers (15), group verdict + v1 (§0.1, 16–17), spike hygiene (13), events spine (4–5), pruning (12), landing split (§ Landing strategy + Task 19). Deep-3 rows 2/35 skip **partially overturned** with argument (§0.1); row 31 honored via the recipient cap + confirm (Task 7); rows 36/40 honored (pruning adopted, agent-boot refused); row 27 no longer cited for the per-session-enable deferral (Task 18 carries its own rationale).
- **Known deferrals (explicit, not gaps):** three-tier *unread* + seen-cursors (B2), team-lead chat exclusion lift (A-series), delegate rate-limiting/per-session token for the *bearer* path (tracked in the OSS-audit security list — the new hook create endpoint is per-session-token by construction), `Kind::CompactBoundary`/`Mode` un-starving (A2 client work, listed in the surfacing map §5.1 — not harness-features scope).
- **Type consistency:** `HarnessEvent` == serialized `AuditEntry` everywhere (`detail` parsed from its wire string exactly once, in `harness.ts`); `Kind::Delegation`→`'delegation'`→`badge:'delegation'`→`teammate:<label>`; `Kind::Schedule`→`'schedule'`→`schedule:<title>` (run-breaking speaker); `batch` optional end-to-end; `needsYou`/`isThrowaway` shared by rollup, badge and sort (client-side only — no server mirror).

---

## Appendix: review dispositions (2026-08-16)

**Applied** — every blocker/major from both reviews plus all cheap minors: schedule rows made reachable by the events feed (`'$.session'` predicate arm + `session`/`title` keys in `runner.rs`'s detail, Task 4 — feasibility blocker #1); `last_send_text` preview honesty (Tasks 2/10 — feas. #2); wire-kind client lines bundled into the `main` PRs (landing strategy — feas. #3); wake-honesty annotation + recipient cap 6 + confirm at 4 (Task 7 — feas. #4, product #5); provider-gated wrapper (Task 2 — feas. #5); `mod.rs:252` / `next_runs` anchor fixes (Tasks 8/9 — feas. #6); allow-list made one site via `:672` calling the helper (Task 2 — feas. #7); schedule-as-speaker with run break (Task 10 — feas. #8, product #3); model-invocable skill seeding replaces the unreachable commands file (Task 9 — product #1); fan-out sheet cut, transcript is the read view (Task 17/§0.1 — product #2); build order re-ranked daily-driver-first (landing strategy — product #4); text-only needs-you pill, cluster facepile reserved for teams (Task 14 — product #4); no server-side name-mute + effective-state Notifications row (Tasks 13/15 — product #8); row 27 and row 31 citations corrected (Tasks 18/§0.1 — product #6, #5); `AuditEntry` anchor + detail-is-a-string, chip-click assertion, index-coverage note (Tasks 4/5 — feas. spot-checks/#8).

**Decisions between offered alternatives, and rejections (one line each):**
- Rename line (product #7): chose "ledger row stays, line ships dark" over building hook-token self-rename now — self-rename is real scope (endpoint + agent guidance on when to fire) deserving its own task; Task 5's renderer already keys on `actor: agent:*` so the line lights up the day it lands.
- Task renumbering (product #4): applied as an explicit build-order override instead of renumbering nineteen tasks — same execution order, zero churn in cross-references.
- "Ships on `main` this week" for 14/15 (product #4b): adopted as lane eligibility, not a schedule commitment — landing still goes through owner-reviewed PRs (standing rule).
- Task 4 index (feas. #8 note): kept the single `idx_audit_target`; non-target arms scan the action-filtered subset, accepted at `audit_log` size with `UNION ALL` named as the escape hatch.
- Commands twin for `supermux-schedule` (product #1's "restate honestly" option): not seeded — the human-typed path is Task 11's sheet; two entry points to one create call is redundancy, not value.
