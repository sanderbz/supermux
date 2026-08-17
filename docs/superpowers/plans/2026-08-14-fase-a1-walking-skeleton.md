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

# Fase A1 — Walking Skeleton (chat renderer dogfood) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behind a settings flag, render a read-only chat tail + live overlay (P12 working row, hook receipts, P13 provisional pty tail) for local Claude sessions in the REAL desktop focus panel, with the terminal one tap away — the dogfood slice that answers the A1 stop/go criteria.

**Architecture:** No new server module — and the dataplane enablers ALREADY EXIST: `origin/feat/chat-dataplane-enablers` is 4 commits ahead of main (`87a3d1b`…`d4c155b`) and ships the `PermissionRequest`/`PostToolUseFailure` install + ingest, `GET /peek?ansi=1` (lenient `is_truthy_flag`: `1`/`true`/`yes`/`on`/bare `?ansi` = on), and `SessionView.permission_request` as an **object** `PermissionRequestInfo { tool, summary, kind, mode? }` riding the `sessions` delta (null clears). This slice STACKS on that branch instead of re-implementing it (Task 0 bases the worktree there; Task 2 verifies the shipped shapes). A1 adds only what is genuinely missing: the additive `/recall?chat=true` view (full assistant text + tool_use/result pairs, plus a single-slot parse cache so polling an unchanged transcript costs a stat), `activity_at` (server-clock ms) on the activity delta, and the frontend — a lazy `components/chat/` chunk switched in at ONE seam (`desktop-split.tsx`). The chat client re-pulls `/recall` on SSE `sessions`/`status` ticks for the focused session only (trailing debounce mid-turn, immediate refetch on turn end); the P13 tail IS an explicit 1s interval poll of `/peek?ansi=1`, focused session only, only while shown — a `capture-pane` subprocess per tick on the tmux runtime, a cheap grid render on native. The chat client never sends `resize` or any input (chat WS is A2, SessionInput is A4).

**Tech Stack:** Rust (axum, serde) · React 19 + Tailwind v4 (existing tokens only) · TanStack Query + the shared `useSse` singleton · `bun test` for pure frontend logic (zero new deps; bun 1.3.10 is on the host) · Playwright smoke e2e (existing harness).

## Global Constraints

- **Worktree, never the main checkout**: all work in `/opt/projects/supermux-a1` on branch `feat/a1-walking-skeleton` off `origin/feat/chat-dataplane-enablers` — the STACKED base carrying the shipped enablers (concurrent agents build in the main repo — no commits/branches/stashes there).
- **Never `cargo build/test --release`** — debug only. In-sandbox builds need `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu`.
- **Never edit `server/src/migrations/*`** (checksummed). This plan needs no migration — all new server state is in-memory (`SessionActivity`).
- **Read-only + switch only**: no send path, no `resize` from the chat client, no chat WS, no new module `sessions/chat/` (that's A2). The terminal path stays byte-identical when the flag is off.
- **Eligibility guard (client)**: `provider === 'claude' && host_id == null && !team-lead` (master plan Global Constraints, Track A v1 scope).
- **Flag discipline**: default OFF (`useUI.chatRenderer`, Settings → Experimental toggle) + hidden kill-switch `localStorage['supermux:chat-renderer'] = '0'` which force-disables regardless of the toggle. Default flip is fase A7, never here.
- **Visual bar**: neutral-minimal using EXISTING tokens (`bg-card`, `bg-muted`, `border-border`, `text-muted-foreground`, `StatusDot`) — no new visual identity, no new hues, no markdown pipeline (A1 renders plain text; markdown is A3). The A3 design direction must be able to replace this wholesale.
- **Perf budget**: chat components load via `React.lazy` (own chunk) so first paint never parses them — but note the size-budget gate (`web/scripts/size-budget.mjs`) counts ALL non-`vendor*` chunks, so the lazy chat chunk still spends from the 200 KB gz app-JS budget: lazy ≠ free, keep it small. `bun run build:perf` must pass.
- **Wire additivity**: every server change is additive (new query params, new optional/skip-serializing fields, new EVENTS entries). Existing tests must keep passing unmodified except where a struct literal gains a new `None`/`false` field.
- **The user reviews all merges**: final step opens a PR and hands off. Never auto-merge, never restart the live :8824 instance.

**Key latency facts this slice is built on (a0-findings §1):** transcript batches flush per completed message (text-only first-visible p50 31.4s), so the transcript is the *confirming* layer only; the live layer is the status flip (206ms p50) + hook activity deltas + the pty tail (first text ~3.2s). Provisional content is **discarded and replaced** on transcript confirmation, never merged. Receipts render before closing prose. The one unmeasured number — hook→UI latency — is measured by this slice (Task 6).

**A1 checkpoints (end of dogfood week, answered in writing — a0-findings §1, per the owner's decision 2026-08-14):**
(a) something session-specific changes within 1s of send; (b) mid-turn the user can tell *what* the agent is doing without the terminal; (c) provisional→confirmed supersede doesn't visibly glitch. A failed checkpoint means the *mechanism* iterates until it holds (with whatever pragmatic fix works) before A3's design spend leans on it — these findings steer the *how*, never the *whether*; the direction never reverts (master plan §7 + Global Constraints). Measurement procedure for (a) is defined in Task 9's handoff (two-window: send via the dock from a second window/phone — the API send stamps `last_send_at` — while watching the chat pane); dogfood answers land in `docs/superpowers/plans/research-2026-08-13/a1-dogfood-notes.md`.

---

### Task 0: Worktree + environment sanity

**Files:** none (setup only)

**Interfaces:**
- Produces: worktree at `/opt/projects/supermux-a1`, branch `feat/a1-walking-skeleton`, verified build env. All later tasks run inside this worktree.

- [ ] **Step 1: Create the worktree STACKED on the enablers branch**

The dataplane enablers (hook install/ingest, `/peek?ansi=1`, the `permission_request` object) already live on `origin/feat/chat-dataplane-enablers` — A1 builds on top, never re-implements:

```bash
cd /opt/projects/supermux
git fetch origin
git worktree add /opt/projects/supermux-a1 -b feat/a1-walking-skeleton origin/feat/chat-dataplane-enablers
```

- [ ] **Step 2: Verify the server compiles in-sandbox**

Run: `cd /opt/projects/supermux-a1/server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo check`
Expected: clean check (a couple of minutes cold).

- [ ] **Step 3: Install web deps + verify baseline**

Run: `cd /opt/projects/supermux-a1/web && bun install && bunx tsc -b && bun run lint`
Expected: no errors.

- [ ] **Step 4: Confirm the enabler-branch assumption**

Run: `git log origin/main..origin/feat/chat-dataplane-enablers --oneline`
Expected: 4 commits, tip `d4c155b` (docs), then `02f131a` (`/peek?ansi=1`), `dd93bed` (ingest), `87a3d1b` (install). If the branch has since MERGED into main, re-base the worktree off `origin/main` instead (same contract, already landed); if it gained commits, read the diff — the shipped shapes verified in Task 2 stay the contract.

- [ ] **Step 5: Land the a0-findings evidence file in the repo**

The stop/go criteria cite `a0-findings.md` ~20× but it only exists in an ephemeral agent scratchpad — the PR must carry its own evidence:

```bash
cp /tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/a0-findings.md \
  /opt/projects/supermux-a1/docs/superpowers/plans/research-2026-08-13/a0-findings.md
cd /opt/projects/supermux-a1
git add docs/superpowers/plans/research-2026-08-13/a0-findings.md
git commit -m "docs: land the fase-A0 findings (latency facts + A1 checkpoint evidence)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(If the scratchpad has been cleaned, recover the file from wherever the A0 session left it before proceeding — the criteria are unauditable without it.)

---

### Task 1: `/recall?chat=true` — full-fidelity chat tail (server)

**Files:**
- Modify: `server/src/sessions/recall.rs` — `RecallQuery` (:55-74), `RecallEntry` (:80-100), `Kind` (:106-139), `handler` (:165-228), `gather` (:234-255), `gather_in_proj` (:260-344), new `read_chat_turns` + helpers after `read_user_turns` (:392-517), tests (:856+)
- Test: same file, `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: existing `classify_user`, `sanitise_text`, `clamp`, `parse_ts`, `extract_message_text`, cursor helpers — all already in `recall.rs`.
- Produces (wire, additive):
  - Query param `chat=true` on `GET /api/sessions/{name}/recall`.
  - New `kind` values `"assistant"` and `"tool_use"` (serde snake_case of new `Kind::Assistant`, `Kind::ToolUse`).
  - `RecallEntry.ok: Option<bool>` (serialized only when `Some`) — success flag of a paired `tool_result`.
  - Semantics in chat view: entries are the chronological tail, newest-first, cursor-paginated exactly as today. User entries: only `prompt`/`command`/`teammate` kinds. Assistant `text` blocks are their own entries with FULL text (wire-clamped at `PROMPT_MAX_CHARS` = 8000, not the 600-char reply preview). Assistant `tool_use` blocks are `tool_use` entries: `text` = `"<Tool> <salient input>"`, `label` = tool name, `reply` = tool_result preview (≤600 chars) once paired by `tool_use_id`, `ok` = `!is_error`. Sidechains always hidden. `thinking`/image blocks skipped (A1). Multi-block assistant lines get uuid suffixes `<uuid>#<i>` for blocks past the first.
- Task 4/6 consume this via `sessionsApi.recall(name, { chat: true, limit: 30 })`.

- [ ] **Step 1: Write the failing tests** (append inside `mod tests` in `recall.rs`)

```rust
    fn assistant_tool_use_line(uuid: &str, ts: &str, id: &str, name: &str, input: serde_json::Value) -> String {
        serde_json::json!({
            "type": "assistant", "uuid": uuid, "timestamp": ts, "isSidechain": false,
            "message": { "role": "assistant", "content": [
                {"type": "tool_use", "id": id, "name": name, "input": input}
            ]},
        })
        .to_string()
    }

    fn user_tool_result_line(uuid: &str, ts: &str, id: &str, text: &str, is_error: bool) -> String {
        serde_json::json!({
            "type": "user", "uuid": uuid, "timestamp": ts, "isSidechain": false,
            "message": { "role": "user", "content": [
                {"type": "tool_result", "tool_use_id": id, "content": text, "is_error": is_error}
            ]},
        })
        .to_string()
    }

    #[test]
    fn chat_view_emits_assistant_and_tool_entries_newest_first() {
        let proj = temp_dir();
        let cc = "chat1";
        write_jsonl(
            &proj,
            cc,
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "do the thing", false),
                &assistant_tool_use_line("a1", "2026-01-01T10:00:02Z", "tu_1", "Read",
                    serde_json::json!({"file_path": "src/tile.tsx"})),
                &user_tool_result_line("r1", "2026-01-01T10:00:03Z", "tu_1", "file contents here", false),
                &assistant_line("a2", "2026-01-01T10:00:05Z", "done, looks good.", false),
            ],
        );
        let r = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        // Newest-first: text, tool_use, prompt. The tool_result is FOLDED, not its own entry.
        assert_eq!(r.entries.len(), 3);
        assert_eq!(r.entries[0].kind, Kind::Assistant);
        assert_eq!(r.entries[0].text, "done, looks good.");
        assert_eq!(r.entries[1].kind, Kind::ToolUse);
        assert_eq!(r.entries[1].text, "Read src/tile.tsx");
        assert_eq!(r.entries[1].label.as_deref(), Some("Read"));
        assert_eq!(r.entries[1].reply.as_deref(), Some("file contents here"));
        assert_eq!(r.entries[1].ok, Some(true));
        assert_eq!(r.entries[2].kind, Kind::Prompt);
        assert_eq!(r.entries[2].text, "do the thing");
    }

    #[test]
    fn chat_view_assistant_text_is_full_not_reply_preview() {
        // The legacy view clamps replies at REPLY_MAX_CHARS (600); the chat view
        // must carry the FULL text (up to the 8K wire clamp).
        let proj = temp_dir();
        let cc = "chat2";
        let long = "x".repeat(REPLY_MAX_CHARS + 500); // 1100 chars — over 600, under 8000
        write_jsonl(
            &proj,
            cc,
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "q", false),
                &assistant_line("a1", "2026-01-01T10:00:05Z", &long, false),
            ],
        );
        let r = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        let text_entry = r.entries.iter().find(|e| e.kind == Kind::Assistant).unwrap();
        assert_eq!(text_entry.text.chars().count(), REPLY_MAX_CHARS + 500);
    }

    #[test]
    fn chat_view_tool_result_error_sets_ok_false() {
        let proj = temp_dir();
        let cc = "chat3";
        write_jsonl(
            &proj,
            cc,
            &[
                &assistant_tool_use_line("a1", "2026-01-01T10:00:02Z", "tu_9", "Bash",
                    serde_json::json!({"command": "cargo test"})),
                &user_tool_result_line("r1", "2026-01-01T10:00:04Z", "tu_9", "error: test failed", true),
            ],
        );
        let r = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].ok, Some(false));
        assert_eq!(r.entries[0].reply.as_deref(), Some("error: test failed"));
    }

    #[test]
    fn chat_view_hides_sidechains_and_system_noise() {
        let proj = temp_dir();
        let cc = "chat4";
        write_jsonl(
            &proj,
            cc,
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "main q", false),
                &user_line("u2", "2026-01-01T10:00:01Z", "sub q", true),
                &assistant_line("a1", "2026-01-01T10:00:02Z", "sub r", true),
                &user_line(
                    "u3",
                    "2026-01-01T10:00:03Z",
                    "<task-notification><summary>Agent X done</summary></task-notification>",
                    false,
                ),
                &assistant_line("a2", "2026-01-01T10:00:05Z", "main r", false),
            ],
        );
        let r = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        // Only: main r (assistant), main q (prompt). Sidechains + notification hidden.
        assert_eq!(r.entries.len(), 2);
        assert_eq!(r.entries[0].text, "main r");
        assert_eq!(r.entries[1].text, "main q");
    }

    #[test]
    fn chat_view_paginates_with_cursor_across_mixed_kinds() {
        let proj = temp_dir();
        let cc = "chat5";
        write_jsonl(
            &proj,
            cc,
            &[
                &user_line("u1", "2026-01-01T10:00:00Z", "q1", false),
                &assistant_line("a1", "2026-01-01T10:00:02Z", "r1", false),
                &user_line("u2", "2026-01-01T10:01:00Z", "q2", false),
                &assistant_line("a2", "2026-01-01T10:01:02Z", "r2", false),
            ],
        );
        let p1 = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 2);
        assert_eq!(p1.entries.len(), 2);
        assert!(p1.has_more);
        assert_eq!(p1.entries[0].text, "r2");
        assert_eq!(p1.entries[1].text, "q2");
        let cur = p1.next_before.expect("cursor");
        let p2 = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, Some(&cur), 2);
        assert_eq!(p2.entries[0].text, "r1");
        assert_eq!(p2.entries[1].text, "q1");
        assert!(!p2.has_more);
    }

    #[test]
    fn chat_view_parse_cache_serves_unchanged_files_and_invalidates_on_append() {
        // The A1 client re-pulls the focused tail on every SSE tick; an
        // unchanged transcript must cost a stat, and an append must invalidate.
        let proj = temp_dir();
        let cc = "chat6";
        write_jsonl(&proj, cc, &[&user_line("u1", "2026-01-01T10:00:00Z", "q1", false)]);
        let r1 = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        assert_eq!(r1.entries.len(), 1);
        // Second read of the unchanged file: identical tail (served from cache).
        let r2 = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        assert_eq!(r2.entries.len(), 1);
        // Append (mtime/len change) → the new entry appears.
        append_jsonl(&proj, cc, &[&assistant_line("a1", "2026-01-01T10:00:05Z", "r1", false)]);
        let r3 = gather_in_proj(&proj, cc, Scope::Session, "", false, false, true, None, 10);
        assert_eq!(r3.entries.len(), 2);
        assert_eq!(r3.entries[0].text, "r1");
    }
```

(Add a tiny `append_jsonl` helper next to `write_jsonl` in the test module: `OpenOptions::new().append(true)` + write the lines.)

Note: every EXISTING `gather_in_proj(...)` call in tests gains a `false` chat argument in position 7 (before `before`) — mechanical, done in Step 3.

- [ ] **Step 2: Run to verify failure**

Run: `cd /opt/projects/supermux-a1/server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test recall`
Expected: COMPILE ERROR (`Kind::Assistant` not found, wrong arg count) — the TDD red state.

- [ ] **Step 3: Implement**

In `recall.rs`:

3a. `RecallQuery` (:55-74) gains:

```rust
    /// Chat view (fase A1): emit the full-fidelity chronological tail — user
    /// prompts + assistant `text` blocks (FULL text, not the 600-char reply
    /// preview) + `tool_use`/`tool_result` pairs — instead of the legacy
    /// prompt+reply pairing. Additive: absent/false keeps the popover shape
    /// byte-identical.
    #[serde(default)]
    pub chat: bool,
```

3b. `RecallEntry` (:80-100) gains (last field):

```rust
    /// Chat view only: success flag of the paired `tool_result` (`Some(false)`
    /// = `is_error`). `None` until the result lands / for non-tool entries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
```

Add `ok: None,` to the struct literal in `read_user_turns` (:465-475).

3c. `Kind` (:106-130) gains two variants (serde snake_case → `"assistant"` / `"tool_use"`):

```rust
    /// Chat view only: an assistant `text` block, full text (wire-clamped).
    Assistant,
    /// Chat view only: an assistant `tool_use` block; `reply`/`ok` carry the
    /// paired `tool_result` preview + success flag.
    ToolUse,
```

`is_user_initiated` (:132-139) is untouched — the new kinds are not user-initiated and the chat path bypasses that filter anyway.

3d. Thread `chat: bool` through `gather` (after `include_system_events`) and `gather_in_proj` (same position). In `gather_in_proj`:

```rust
    'files: for path in &files {
        let file_entries = if chat {
            read_chat_turns_cached(path)
        } else {
            read_user_turns(path, include_sidechains)
        };
        for entry in file_entries {
            // …cursor consumption unchanged…
            if !chat && !include_system_events && !entry.kind.is_user_initiated() {
                continue;
            }
            // …search + push unchanged…
```

`handler` (:183-220) passes `q.chat` in the claude/default branch (codex/kimi branches ignore it — chat view is Claude-only in A1).

3e. New reader + helpers, placed directly after `read_user_turns`:

```rust
/// Chat-view reader (fase A1): stream one transcript forward and emit the
/// full-fidelity chronological tail — user turns (prompt/command/teammate
/// only), assistant `text` blocks as their OWN entries (full text), and
/// assistant `tool_use` blocks paired with their `tool_result` (matched by
/// `tool_use_id`, folded into `reply`/`ok` — a result is never its own
/// entry). Sidechains are always hidden (subagent detail is a later fase);
/// `thinking` and image blocks are skipped in A1. Newest-first on return,
/// mirroring `read_user_turns`.
fn read_chat_turns(path: &Path) -> Vec<RecallEntry> {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let reader = BufReader::new(file);

    let mut entries: Vec<RecallEntry> = Vec::new();
    // tool_use id → index in `entries`, so the wrapped user-role tool_result
    // can fold into its receipt.
    let mut tool_idx: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut latest_title: Option<String> = None;

    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let is_user = line.contains("\"type\":\"user\"");
        let is_assistant = line.contains("\"type\":\"assistant\"");
        let is_title = line.contains("\"ai-title\"");
        if !is_user && !is_assistant && !is_title {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false) {
            continue;
        }
        let ts = parse_ts(v.get("timestamp").and_then(|t| t.as_str()));
        let uuid = v
            .get("uuid")
            .and_then(|u| u.as_str())
            .unwrap_or("")
            .to_string();

        match ty {
            "ai-title" => {
                if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() {
                        latest_title = Some(t.to_string());
                    }
                }
            }
            "user" => {
                // A tool_result carrier folds into its pending receipt and is
                // never its own entry.
                if let Some(blocks) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    let mut folded = false;
                    for b in blocks {
                        if b.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                            continue;
                        }
                        folded = true;
                        let id = b
                            .get("tool_use_id")
                            .and_then(|t| t.as_str())
                            .unwrap_or("");
                        if let Some(&idx) = tool_idx.get(id) {
                            let is_err =
                                b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                            entries[idx].ok = Some(!is_err);
                            let preview =
                                clamp(&sanitise_text(&tool_result_text(b)), REPLY_MAX_CHARS);
                            if !preview.is_empty() {
                                entries[idx].reply = Some(preview);
                            }
                        }
                    }
                    if folded {
                        continue;
                    }
                }
                if uuid.is_empty() {
                    continue;
                }
                let Some(c) = classify_user(&v) else { continue };
                // Chat tail shows only user-initiated turns — system noise
                // (reminders, notifications, caveats) stays out of the calm view.
                if !matches!(c.kind, Kind::Prompt | Kind::Command | Kind::Teammate) {
                    continue;
                }
                entries.push(RecallEntry {
                    uuid,
                    ts,
                    session_id: session_id.clone(),
                    session_title: None,
                    text: c.text,
                    reply: None,
                    sidechain: false,
                    kind: c.kind,
                    label: c.label,
                    ok: None,
                });
            }
            "assistant" => {
                if uuid.is_empty() {
                    continue;
                }
                let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
                    continue;
                };
                let blocks: Vec<serde_json::Value> = match content {
                    serde_json::Value::String(s) => {
                        vec![serde_json::json!({"type": "text", "text": s})]
                    }
                    serde_json::Value::Array(a) => a.clone(),
                    _ => continue,
                };
                for (i, b) in blocks.iter().enumerate() {
                    // A0 fact: one block per line is TYPICAL, not guaranteed
                    // (1 multi-block in 21,431) — suffix uuids keep cursor
                    // identity unique either way.
                    let buuid = if i == 0 { uuid.clone() } else { format!("{uuid}#{i}") };
                    match b.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            let text = sanitise_text(
                                b.get("text").and_then(|t| t.as_str()).unwrap_or("").trim(),
                            );
                            if text.is_empty() {
                                continue;
                            }
                            entries.push(RecallEntry {
                                uuid: buuid,
                                ts,
                                session_id: session_id.clone(),
                                session_title: None,
                                text,
                                reply: None,
                                sidechain: false,
                                kind: Kind::Assistant,
                                label: None,
                                ok: None,
                            });
                        }
                        Some("tool_use") => {
                            let name =
                                b.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                            if let Some(id) = b.get("id").and_then(|x| x.as_str()) {
                                tool_idx.insert(id.to_string(), entries.len());
                            }
                            entries.push(RecallEntry {
                                uuid: buuid,
                                ts,
                                session_id: session_id.clone(),
                                session_title: None,
                                text: tool_line(name, b.get("input")),
                                reply: None,
                                sidechain: false,
                                kind: Kind::ToolUse,
                                label: Some(name.to_string()),
                                ok: None,
                            });
                        }
                        // thinking / image / unknown block types: skipped in A1.
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(title) = latest_title {
        for e in &mut entries {
            e.session_title = Some(title.clone());
        }
    }
    entries.reverse();
    entries
}

/// One-line receipt label for a `tool_use` block: tool name + its most salient
/// input field, clipped. Mirrors `activity::activity_label`'s field priorities
/// WITHOUT the emoji taxonomy (chat receipts are icon-free — master plan §4.2 P3).
fn tool_line(name: &str, input: Option<&serde_json::Value>) -> String {
    let detail = input.and_then(|i| {
        for key in ["file_path", "command", "pattern", "url", "description", "prompt"] {
            if let Some(s) = i.get(key).and_then(|v| v.as_str()) {
                let s = s.trim();
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
        None
    });
    match detail {
        Some(d) => format!("{name} {}", clamp(&sanitise_text(&d), 120)),
        None => name.to_string(),
    }
}

/// Printable text of a `tool_result` block: string content verbatim, array
/// content = concatenated `text` sub-blocks. Anything else → empty.
fn tool_result_text(b: &serde_json::Value) -> String {
    match b.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Single-slot parse cache for the chat view (the A1 poll-cost guard): the A1
/// client re-pulls the FOCUSED session's tail on every SSE tick, and
/// `read_chat_turns` otherwise re-streams the entire JSONL each time (a0
/// measured 21k+ line transcripts with single lines up to ~950 KB). Keyed on
/// (path, mtime, len): an unchanged file costs one stat + a clone. One slot is
/// enough — only the focused session polls. The A2 chat WS replaces this whole
/// read path.
static CHAT_PARSE_CACHE: std::sync::Mutex<
    Option<(std::path::PathBuf, std::time::SystemTime, u64, Vec<RecallEntry>)>,
> = std::sync::Mutex::new(None);

fn read_chat_turns_cached(path: &Path) -> Vec<RecallEntry> {
    let key = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok().map(|t| (t, m.len())));
    if let Some((mtime, len)) = key {
        if let Ok(guard) = CHAT_PARSE_CACHE.lock() {
            if let Some((p, t, l, cached)) = guard.as_ref() {
                if p == path && *t == mtime && *l == len {
                    return cached.clone();
                }
            }
        }
    }
    let parsed = read_chat_turns(path);
    if let Some((mtime, len)) = key {
        if let Ok(mut guard) = CHAT_PARSE_CACHE.lock() {
            *guard = Some((path.to_path_buf(), mtime, len, parsed.clone()));
        }
    }
    parsed
}
```

3f. Mechanical: add the `chat` argument (`false`) to every existing `gather_in_proj(...)` call in tests (position 7, before `before`), and to the `gather(...)` call in `handler`.

- [ ] **Step 4: Run tests to verify pass**

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test recall`
Expected: ALL recall tests pass (old + 6 new).

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/recall.rs
git commit -m "feat(recall): chat view — full assistant text + tool_use/result pairs behind ?chat=true

Additive fase-A1 read path: new Kind::{Assistant,ToolUse}, RecallEntry.ok,
tool_result folded into its receipt by tool_use_id. Legacy popover shape
byte-identical when the param is absent.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Verify the SHIPPED enablers (peek ANSI, hook installs, permission object)

**Files:** none — verification of the stacked base (the enablers branch already implements what earlier drafts of this plan built fresh).

**Interfaces (shipped on `feat/chat-dataplane-enablers` — the contract Tasks 4/6 consume):**
- `GET /api/sessions/{name}/peek?ansi=1&lines=N` → `{ ok: true, data: "<raw capture, SGR preserved>" }`. Flag parsing is `ansi: Option<String>` + `is_truthy_flag` (`mod.rs:1190-1210`): `1`/`true`/`yes`/`on`/**bare `?ansi`** = on; unparseable values read as off (never 400). Backed by `lifecycle::peek_ansi` → `rt.capture_ansi`.
- Installed hook events: `("PermissionRequest", "permission_request")`, `("PostToolUseFailure", "post_tool_failure")` — `EVENTS` is `[(&str, &str); 12]`.
- `SessionActivity.permission: Option<PermissionAsk>` (`state.rs:65-72`, from `activity::permission_ask`), cleared on `PostToolUse*`/`Stop`/`SessionEnd`/`UserPromptSubmit`/`SessionStart`.
- `SessionView.permission_request: Option<PermissionRequestInfo>` — an **object** `{ tool, summary, kind, mode? }` (`summary` is the same secret-conscious derivation as `activity`, WITH emoji; `kind` is the activity class; `mode` the permission mode when carried). The `sessions` delta always carries `"permission_request": <object|null>` so null clears.

- [ ] **Step 1: Pin the shapes with greps** (from `/opt/projects/supermux-a1`)

```bash
grep -n "PermissionRequestInfo" server/src/sessions/mod.rs        # object {tool, summary, kind, mode}
grep -n "is_truthy_flag" server/src/sessions/mod.rs               # lenient ?ansi parse
grep -n '"PermissionRequest"' server/src/claude_config.rs          # installed event
grep -n '"permission_request": permission' server/src/hooks.rs     # rides the delta, null clears
```

Expected: all four hit. If any misses, STOP — the base moved; re-read the branch diff before continuing.

- [ ] **Step 2: Run the shipped tests**

Run: `cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test permission && cargo test ansi`
Expected: green (the branch ships its own hooks/lifecycle/peek coverage — `server/tests/lifecycle.rs` +101 lines, `native/tests.rs` +47).

No commit (no changes).

---

### Task 3: `activity_at` — server-clock ms stamp on the sessions activity delta (server)

**Files:**
- Modify: `server/src/hooks.rs` — `broadcast_activity_delta` (:328 on the enablers base)
- Test: `server/src/hooks.rs` tests mod

**Interfaces:**
- Consumes: the shipped `broadcast_activity_delta` (Task 2 verified it already carries `activity`/`activity_kind`/`error`/`permission_request`/`subagents`).
- Produces (additive): the `sessions` SSE delta gains `"activity_at": <epoch ms, server clock>` on every activity broadcast. Dual purpose, consumed by Tasks 5/6: (1) the hook→UI latency anchor (the ONE unmeasured number — a0-findings §1 item 3); (2) the chat client's clock-skew sample, so every supersede/prune comparison runs in the SERVER clock domain, never the browser's (this owner dogfoods over tailnet from other devices; a browser clock a few seconds off must not silently kill the overlay or freeze duplicates).
- NOT on `SessionView`: a point-in-time broadcast stamp is meaningless on a GET snapshot.

- [ ] **Step 1: Write the failing test** (in `hooks.rs` `mod tests`, same helpers as the existing broadcast tests)

```rust
    #[tokio::test]
    async fn activity_delta_carries_the_server_clock_stamp() {
        let (state, dir) = test_state().await;
        let s = "worker-at";
        let mut rx = state.sse_tx.subscribe();

        apply_payload(
            &state,
            s,
            "pre_tool",
            &p(r#"{"tool_name":"Bash","tool_input":{"command":"ls"}}"#),
        );
        let ev = rx.try_recv().expect("activity broadcasts");
        assert_eq!(ev.event, "sessions");
        let d = ev.payload["delta"][0].clone();
        let at = d["activity_at"].as_i64().expect("activity_at present");
        let now = chrono::Utc::now().timestamp_millis();
        assert!((now - at).abs() < 5_000, "server-clock ms stamp, fresh");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test activity_delta_carries`
Expected: FAIL — `activity_at` is null.

- [ ] **Step 3: Implement**

In `broadcast_activity_delta` (hooks.rs:328 on this base), add ONE key to the delta json:

```rust
            // Server-clock ms stamp: the fase-A1 hook→UI latency anchor AND
            // the chat client's clock-skew source — every chat supersede
            // comparison runs in this clock domain (a0-findings §1 item 3).
            "activity_at": chrono::Utc::now().timestamp_millis(),
```

(If `chrono` isn't already in scope in `hooks.rs`, use `std::time::{SystemTime, UNIX_EPOCH}`: `SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64` — and mirror in the test.)

- [ ] **Step 4: Run tests to verify pass**

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test hooks && cargo check`
Expected: ALL pass (old + 1 new), clean check.

- [ ] **Step 5: Commit**

```bash
git add server/src/hooks.rs
git commit -m "feat(hooks): activity_at server-clock stamp on the sessions activity delta

The fase-A1 hook→UI latency anchor + the chat client's clock-skew sample.
The other enablers (PermissionRequest/PostToolUseFailure install+ingest,
the permission_request object, /peek?ansi=1) ship on the underlying
feat/chat-dataplane-enablers branch this slice stacks on.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend flag + wire types (settings toggle, kill-switch, eligibility guard)

**Files:**
- Create: `web/src/components/chat/flag.ts`
- Modify: `web/src/stores/ui-store.ts` (interface :41-85, defaults+setters :87-108)
- Modify: `web/src/routes/settings.tsx` — `ExperimentalSection` (:265-289)
- Modify: `web/src/lib/api/sessions.ts` — `ApiSession` (:130-151), `RecallEntry` (:200-213), `RecallEntryKind` (:219-226), `RecallQueryParams` (:236-243), `recall`/new `peekAnsi` (:558-573)
- Modify: `web/src/components/session-tile/types.ts` — `TileSession` (:9-36)
- Create: `web/src/components/chat/use-chat-renderer.ts`
- Test: `web/tests/unit/chat-flag.test.ts`

**Interfaces:**
- Consumes: Task 1's `chat=true` param, the shipped `?ansi=1` + `permission_request` object (Task 2 verified), Task 3's `activity_at` delta key.
- Produces (used by Tasks 5-8):
  - `flag.ts`: `CHAT_KILL_SWITCH_KEY = 'supermux:chat-renderer'`; `chatEligible(s: {provider: string; host_id?: number|null}, isTeamLead: boolean): boolean`; `chatRendererOn(settingOn: boolean, killSwitch: string|null, s, isTeamLead): boolean`.
  - `use-chat-renderer.ts`: `useChatRenderer(s: {provider: string; host_id?: number|null} | null, isTeamLead: boolean): boolean`.
  - `useUI` gains `chatRenderer: boolean` (default `false`) + `setChatRenderer(v)`.
  - `sessionsApi.recall` accepts `chat?: boolean`; `sessionsApi.peekAnsi(name: string, lines?: number): Promise<string>`.
  - `RecallEntryKind` gains `'assistant' | 'tool_use'`; `RecallEntry.ok?: boolean`; `ApiSession`/`TileSession` gain `permission_request?: PermissionRequestInfo` (the shipped OBJECT `{ tool, summary, kind, mode? }` — never a string; the delta sends `null` to clear, which `mergeRow` passes through verbatim, so the type must tolerate `| null` at runtime via optional-chaining consumers) and `activity_at?: number`.

- [ ] **Step 1: Write the failing test** — `web/tests/unit/chat-flag.test.ts` (bun test; RELATIVE imports so the runner needs no alias config)

```ts
import { describe, expect, test } from 'bun:test'

import {
  chatEligible,
  chatRendererOn,
  CHAT_KILL_SWITCH_KEY,
} from '../../src/components/chat/flag'

describe('chat renderer flag', () => {
  const claude = { provider: 'claude', host_id: null }

  test('eligibility: local claude, not a team lead (master plan Track A v1 guard)', () => {
    expect(chatEligible(claude, false)).toBe(true)
    expect(chatEligible({ provider: 'shell', host_id: null }, false)).toBe(false)
    expect(chatEligible({ provider: 'codex', host_id: null }, false)).toBe(false)
    expect(chatEligible({ provider: 'claude', host_id: 3 }, false)).toBe(false)
    expect(chatEligible(claude, true)).toBe(false)
    // host_id undefined (older payloads) counts as local.
    expect(chatEligible({ provider: 'claude' }, false)).toBe(true)
  })

  test('setting off → off, regardless of eligibility', () => {
    expect(chatRendererOn(false, null, claude, false)).toBe(false)
  })

  test("kill-switch '0' force-disables even with the setting on", () => {
    expect(chatRendererOn(true, '0', claude, false)).toBe(false)
    expect(chatRendererOn(true, null, claude, false)).toBe(true)
    expect(chatRendererOn(true, '1', claude, false)).toBe(true)
  })

  test('null session → off', () => {
    expect(chatRendererOn(true, null, null, false)).toBe(false)
  })

  test('kill-switch key is the documented one', () => {
    expect(CHAT_KILL_SWITCH_KEY).toBe('supermux:chat-renderer')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /opt/projects/supermux-a1/web && bun test tests/unit/chat-flag.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

3a. `web/src/components/chat/flag.ts` (pure — no React/store imports, bun-testable):

```ts
// Chat renderer flag + eligibility (fase A1 walking skeleton).
//
// Three gates, all must pass: (1) the Settings → Experimental toggle
// (`useUI.chatRenderer`, default OFF — the default flip is fase A7);
// (2) the hidden kill-switch `localStorage['supermux:chat-renderer'] = '0'`,
// which force-disables regardless of the toggle (the PR-#27 flag pattern);
// (3) the Track A v1 eligibility guard (master plan Global Constraints):
// local Claude sessions only — `provider === 'claude' && host_id == null
// && !team`. Pure functions here; the React binding is use-chat-renderer.ts.

export const CHAT_KILL_SWITCH_KEY = 'supermux:chat-renderer'

export interface ChatEligibleSession {
  provider: string
  host_id?: number | null
}

/** Track A v1 guard: local Claude sessions only, never a team lead. */
export function chatEligible(s: ChatEligibleSession, isTeamLead: boolean): boolean {
  return s.provider === 'claude' && s.host_id == null && !isTeamLead
}

/** The full decision: settings toggle AND kill-switch AND eligibility.
 *  `killSwitch` is the raw localStorage value; exactly `'0'` forces OFF. */
export function chatRendererOn(
  settingOn: boolean,
  killSwitch: string | null,
  s: ChatEligibleSession | null,
  isTeamLead: boolean,
): boolean {
  if (!settingOn) return false
  if (killSwitch === '0') return false
  if (!s) return false
  return chatEligible(s, isTeamLead)
}
```

3b. `web/src/components/chat/use-chat-renderer.ts`:

```ts
// React binding for the chat renderer flag — reads the persisted toggle from
// the UI store and the kill-switch from localStorage at render time (cheap;
// flipping the kill-switch takes effect on the next render/navigation, which
// is fine for an emergency lever).

import { useUI } from '@/stores/ui-store'

import {
  CHAT_KILL_SWITCH_KEY,
  chatRendererOn,
  type ChatEligibleSession,
} from './flag'

export function useChatRenderer(
  s: ChatEligibleSession | null,
  isTeamLead: boolean,
): boolean {
  const settingOn = useUI((st) => st.chatRenderer)
  let kill: string | null = null
  try {
    kill = window.localStorage.getItem(CHAT_KILL_SWITCH_KEY)
  } catch {
    /* private mode / quota — treat as no kill-switch */
  }
  return chatRendererOn(settingOn, kill, s, isTeamLead)
}
```

3c. `ui-store.ts` — add to the interface (after `hideStopped`):

```ts
  /** Fase A1 chat renderer (Track A). When ON, eligible LOCAL Claude sessions
   *  default to the read-only chat renderer at the desktop focus seam, with
   *  the terminal one tap away. Kill-switch:
   *  `localStorage['supermux:chat-renderer'] = '0'` force-disables regardless
   *  of this toggle (checked in components/chat/flag.ts). Default OFF — the
   *  default flip ships in fase A7, never here. */
  chatRenderer: boolean
  setChatRenderer: (v: boolean) => void
```

and to the creator: `chatRenderer: false,` + `setChatRenderer: (chatRenderer) => set({ chatRenderer }),`.

3d. `settings.tsx` `ExperimentalSection` (:265-289) — add a second `Row` after Agent Teams (add `import { useUI } from '@/stores/ui-store'` if the route doesn't already import it):

```tsx
      <Row
        label="Chat renderer (preview)"
        control={
          <Switch
            ariaLabel="Enable the chat renderer for local Claude sessions"
            checked={chatRenderer}
            onCheckedChange={setChatRenderer}
          />
        }
      />
```

with, inside the component: `const chatRenderer = useUI((s) => s.chatRenderer)` and `const setChatRenderer = useUI((s) => s.setChatRenderer)`. Extend the non-error footnote string with: `' Chat renderer: read-only preview of Claude sessions in focus mode (terminal one tap away) — early A1 dogfood, local Claude sessions only.'`

3e. `lib/api/sessions.ts`:

- `RecallQueryParams` gains `chat?: boolean`; in `recall()` add `if (q.chat) params.set('chat', 'true')`.
- `RecallEntryKind` union gains `| 'assistant' | 'tool_use'` (with a doc line: chat-view kinds, fase A1).
- `RecallEntry` gains `ok?: boolean` (doc: success flag of the paired tool_result; chat view only).
- `ApiSession` gains (after `error`), matching the SHIPPED `PermissionRequestInfo` wire shape:

```ts
/** The live, undecided `PermissionRequest` dialog (fase A1 chat renderer).
 *  `summary` is the same secret-conscious derivation as `activity` (emoji
 *  included — strip client-side for chat); `kind` is the activity class;
 *  `mode` the permission mode when the payload carried one. */
export interface PermissionRequestInfo {
  tool: string
  summary: string
  kind: string
  mode?: string
}
```

```ts
  /** A live, undecided permission dialog is on screen for this tool call.
   *  In-memory server-side; rides the `sessions` SSE delta (`null` clears —
   *  mergeRow passes null through, so always optional-chain). Fase A1
   *  renders the "Waiting for permission" row from it. */
  permission_request?: PermissionRequestInfo | null
  /** Server-clock ms stamp on the latest activity delta — the fase-A1
   *  hook→UI latency anchor and the client's clock-skew sample. */
  activity_at?: number
```

- `sessionsApi` gains (after `recall`):

```ts
  /** `GET /api/sessions/{name}/peek?ansi=1&lines=N` — colour-true pty tail
   *  (SGR preserved), the fase-A1 P13 provisional-tail channel. Read-only. */
  peekAnsi: (name: string, lines = 30): Promise<string> =>
    sessReq<string>(
      `/api/sessions/${encodeURIComponent(name)}/peek?ansi=1&lines=${lines}`,
    ),
```

3f. `session-tile/types.ts` `TileSession` gains the same two optional fields (`permission_request?: PermissionRequestInfo | null; activity_at?: number`, importing the type from `@/lib/api/sessions`) with one-line docs mirroring 3e.

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `bun test tests/unit/chat-flag.test.ts && bunx tsc -b && bun run lint`
Expected: 5 pass, clean typecheck + lint.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/chat/flag.ts web/src/components/chat/use-chat-renderer.ts \
  web/src/stores/ui-store.ts web/src/routes/settings.tsx \
  web/src/lib/api/sessions.ts web/src/components/session-tile/types.ts \
  web/tests/unit/chat-flag.test.ts
git commit -m "feat(web): chat renderer flag — settings toggle, kill-switch, eligibility guard

Default OFF; kill-switch localStorage['supermux:chat-renderer']='0'; guard =
local Claude, not a team lead (Track A v1 scope). Wire types for the A1
enablers (chat recall view, permission_request, activity_at, peekAnsi).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Pure chat logic — entry grouping, provisional-tail extraction, latency stats

**Files:**
- Create: `web/src/components/chat/entries.ts`
- Create: `web/src/components/chat/provisional.ts`
- Create: `web/src/components/chat/latency.ts`
- Test: `web/tests/unit/chat-entries.test.ts`, `web/tests/unit/chat-provisional.test.ts`, `web/tests/unit/chat-latency.test.ts`

**Interfaces:**
- Consumes: `parseAnsiLine` from `web/src/lib/ansi.ts` (:150) — imported RELATIVELY (`../../lib/ansi`) so bun test needs no alias; its only React dependency is type-only (erased).
- Produces (consumed by Task 6):
  - `entries.ts`: `interface ChatEntry { uuid: string; ts: number; text: string; reply?: string; kind: string; label?: string; ok?: boolean }` (structural subset of the wire `RecallEntry` — kept local so the module stays dependency-free); `type ChatItem = { type:'user'; uuid; ts; text; badge?: string } | { type:'assistant'; uuid; ts; text } | { type:'receipts'; uuid; ts; lines: ReceiptLine[]; overflow: number }`; `interface ReceiptLine { uuid: string; label: string; ok?: boolean; result?: string }`; `RECEIPT_CAP = 30`; `toDisplayList(entries: ChatEntry[]): ChatItem[]` (newest-first in → oldest-first out); `formatElapsed(ms: number): string`; `stripEmojiPrefix(label: string): string` (so overlay receipts and confirmed `tool_line` receipts share ONE vocabulary — the emoji taxonomy stays terminal/tile-only per master plan §4.2 P3, and the provisional→confirmed transition never re-labels a row).
  - `provisional.ts`: `extractProvisionalTail(capture: string, max = 12): string[]` (ANSI-preserved lines).
  - `latency.ts`: `recordHookLatency(activityAtMs: number | undefined): void` (samples persist per-day to `localStorage['supermux:chat-a1-latency:<YYYY-MM-DD>']` so the dogfood week's number survives reloads); `p50(xs: number[]): number`; `latencySamples(): number[]`; `noteServerStamp(serverMs: number): void` + `serverNowMs(): number` (clock-skew estimate from server-stamped deltas — ALL chat supersede/prune comparisons run in the server clock domain); `exposeLatency(): void` (mounts the samples array on `window.__supermuxChatLatency`).

- [ ] **Step 1: Write the failing tests**

`web/tests/unit/chat-entries.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import {
  formatElapsed,
  RECEIPT_CAP,
  toDisplayList,
  type ChatEntry,
} from '../../src/components/chat/entries'

const e = (over: Partial<ChatEntry>): ChatEntry => ({
  uuid: over.uuid ?? Math.random().toString(36).slice(2),
  ts: over.ts ?? 0,
  text: over.text ?? '',
  kind: over.kind ?? 'prompt',
  ...over,
})

describe('toDisplayList', () => {
  test('reverses newest-first wire order to oldest-first display order', () => {
    const items = toDisplayList([
      e({ kind: 'assistant', text: 'reply', ts: 2 }),
      e({ kind: 'prompt', text: 'question', ts: 1 }),
    ])
    expect(items.map((i) => i.type)).toEqual(['user', 'assistant'])
  })

  test('consecutive tool_use entries collapse into ONE receipts block', () => {
    const items = toDisplayList([
      e({ kind: 'assistant', text: 'done', ts: 4 }),
      e({ kind: 'tool_use', text: 'Bash cargo test', ok: false, ts: 3 }),
      e({ kind: 'tool_use', text: 'Read a.rs', ok: true, reply: 'ok', ts: 2 }),
      e({ kind: 'prompt', text: 'go', ts: 1 }),
    ])
    expect(items.map((i) => i.type)).toEqual(['user', 'receipts', 'assistant'])
    const r = items[1]
    if (r.type !== 'receipts') throw new Error('expected receipts')
    expect(r.lines.map((l) => l.label)).toEqual(['Read a.rs', 'Bash cargo test'])
    expect(r.lines[0].ok).toBe(true)
    expect(r.lines[1].ok).toBe(false)
    expect(r.overflow).toBe(0)
  })

  test('receipt cap: past RECEIPT_CAP lines count into overflow', () => {
    const tools: ChatEntry[] = []
    for (let i = 0; i < RECEIPT_CAP + 5; i++) {
      tools.push(e({ kind: 'tool_use', text: `Read f${i}`, ts: i + 2 }))
    }
    // Wire order is newest-first.
    const items = toDisplayList([...tools].reverse())
    const r = items[0]
    if (r.type !== 'receipts') throw new Error('expected receipts')
    expect(r.lines.length).toBe(RECEIPT_CAP)
    expect(r.overflow).toBe(5)
  })

  test('command/teammate prompts keep a badge, plain prompts none', () => {
    const items = toDisplayList([
      e({ kind: 'command', text: '/compact', ts: 2 }),
      e({ kind: 'prompt', text: 'hi', ts: 1 }),
    ])
    const [plain, cmd] = items
    if (plain.type !== 'user' || cmd.type !== 'user') throw new Error('users')
    expect(plain.badge).toBeUndefined()
    expect(cmd.badge).toBe('command')
  })
})

describe('formatElapsed', () => {
  test('seconds then m ss', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(12_400)).toBe('12s')
    expect(formatElapsed(125_000)).toBe('2m 05s')
  })
})

describe('stripEmojiPrefix (overlay labels must match confirmed tool_line vocabulary)', () => {
  test('strips the activity-taxonomy glyph, keeps plain labels', () => {
    expect(stripEmojiPrefix('⚡ npm test')).toBe('npm test')
    expect(stripEmojiPrefix('✎ tile.tsx')).toBe('tile.tsx')
    expect(stripEmojiPrefix('🔌 mcp thing')).toBe('mcp thing')
    expect(stripEmojiPrefix('Read src/a.rs')).toBe('Read src/a.rs')
    expect(stripEmojiPrefix('')).toBe('')
  })
})
```

(Add `stripEmojiPrefix` to the imports at the top of the file.)

`web/tests/unit/chat-provisional.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { extractProvisionalTail } from '../../src/components/chat/provisional'

describe('extractProvisionalTail', () => {
  test('drops the composer box and status noise, keeps prose', () => {
    const capture = [
      'Some earlier output',
      '',
      'The agent is writing this paragraph of prose right now,',
      'and a second line of it.',
      '✻ Simmering… (esc to interrupt)',
      '╭──────────────────────────────╮',
      '│ ❯                            │',
      '╰──────────────────────────────╯',
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n')
    const tail = extractProvisionalTail(capture)
    expect(tail).toEqual([
      'Some earlier output',
      'The agent is writing this paragraph of prose right now,',
      'and a second line of it.',
    ])
  })

  test('caps at max lines, keeping the LAST ones', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const tail = extractProvisionalTail(lines.join('\n'), 5)
    expect(tail).toEqual(['line 25', 'line 26', 'line 27', 'line 28', 'line 29'])
  })

  test('ANSI colour is preserved on kept lines, and ANSI-only styling does not defeat the box filter', () => {
    const capture = [
      '[32msome green prose[0m',
      '[38;2;177;185;249m╭───╮[0m',
      '│ ❯ │',
    ].join('\n')
    const tail = extractProvisionalTail(capture)
    expect(tail).toEqual(['[32msome green prose[0m'])
  })

  test('empty capture → empty tail', () => {
    expect(extractProvisionalTail('')).toEqual([])
  })
})
```

`web/tests/unit/chat-latency.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { noteServerStamp, p50, serverNowMs } from '../../src/components/chat/latency'

describe('p50 (nearest-rank, matching a0-findings small-n honesty)', () => {
  test('empty → 0', () => {
    expect(p50([])).toBe(0)
  })
  test('odd + even sample counts', () => {
    expect(p50([300, 100, 200])).toBe(200)
    expect(p50([100, 400, 200, 300])).toBe(200)
  })
  test('single sample', () => {
    expect(p50([142])).toBe(142)
  })
})

describe('server clock domain', () => {
  test('serverNowMs tracks a sampled skew (server ahead of the browser)', () => {
    noteServerStamp(Date.now() + 3_000)
    expect(serverNowMs()).toBeGreaterThan(Date.now() + 2_000)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/unit/chat-entries.test.ts tests/unit/chat-provisional.test.ts tests/unit/chat-latency.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`web/src/components/chat/entries.ts`:

```ts
// Pure display-model logic for the fase-A1 chat tail. Dependency-free on
// purpose (local structural types, no store/API imports) so `bun test` runs
// it hermetically and the A3 renderer can replace the components above it
// without touching this layer.

/** Structural subset of the wire `RecallEntry` (lib/api/sessions.ts) the
 *  display model needs. Kept local: the wire type may grow; we only read. */
export interface ChatEntry {
  uuid: string
  ts: number
  text: string
  reply?: string
  kind: string
  label?: string
  ok?: boolean
}

export interface ReceiptLine {
  uuid: string
  label: string
  ok?: boolean
  result?: string
}

export type ChatItem =
  | { type: 'user'; uuid: string; ts: number; text: string; badge?: string }
  | { type: 'assistant'; uuid: string; ts: number; text: string }
  | {
      type: 'receipts'
      uuid: string
      ts: number
      lines: ReceiptLine[]
      overflow: number
    }

/** P3 volume guard (master plan §4.2): Claude runs 30–100 calls/turn; a
 *  receipts block shows at most this many lines + an overflow count. */
export const RECEIPT_CAP = 30

/** Newest-first wire entries → oldest-first display items. Consecutive
 *  `tool_use` entries collapse into ONE receipts block (cap + overflow);
 *  command/teammate prompts carry their kind as a badge. */
export function toDisplayList(entries: ChatEntry[]): ChatItem[] {
  const chrono = [...entries].reverse()
  const out: ChatItem[] = []
  for (const e of chrono) {
    if (e.kind === 'tool_use') {
      const line: ReceiptLine = {
        uuid: e.uuid,
        label: e.text,
        ok: e.ok,
        result: e.reply,
      }
      const last = out[out.length - 1]
      if (last && last.type === 'receipts') {
        if (last.lines.length >= RECEIPT_CAP) last.overflow++
        else last.lines.push(line)
      } else {
        out.push({ type: 'receipts', uuid: e.uuid, ts: e.ts, lines: [line], overflow: 0 })
      }
    } else if (e.kind === 'assistant') {
      out.push({ type: 'assistant', uuid: e.uuid, ts: e.ts, text: e.text })
    } else {
      out.push({
        type: 'user',
        uuid: e.uuid,
        ts: e.ts,
        text: e.text,
        badge: e.kind === 'prompt' ? undefined : e.kind,
      })
    }
  }
  return out
}

/** "12s" / "2m 05s" — the P12 elapsed clause. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

/** Strip the leading activity-taxonomy glyph (`⚡ npm test` → `npm test`) so
 *  the live overlay and the confirmed `tool_line` receipts are byte-close —
 *  the emoji taxonomy stays terminal/tile-only (master plan §4.2 P3), and the
 *  provisional→confirmed supersede must never visibly re-label a row. */
export function stripEmojiPrefix(label: string): string {
  return label.replace(/^[^\p{L}\p{N}]{1,3}\s+/u, '')
}
```

`web/src/components/chat/provisional.ts`:

```ts
// P13 provisional-tail extraction (fase A1 heuristic — master plan §4.2 P13).
//
// The pty capture includes the composer box, spinner, and status hints; the
// provisional block must show only the in-progress PROSE above them. This is
// deliberately a cheap heuristic (dogfood quality checkpoint (c) judges it);
// the reconciliation rule lives in the panel: provisional content is
// DISCARDED AND REPLACED by confirmed transcript entries, never merged.
//
// RELATIVE import so `bun test` runs without alias config; `lib/ansi`'s React
// dependency is type-only (erased at runtime).
import { parseAnsiLine } from '../../lib/ansi'

/** Status-bar / hint noise the tail must never show. */
const NOISE =
  /esc to interrupt|shift\+tab|\? for shortcuts|^[⏵⏸✻✽·╰│]|^\s*❯/i

function plain(line: string): string {
  return parseAnsiLine(line)
    .map((s) => s.text)
    .join('')
}

/** Filter a raw ANSI pty capture down to the lines worth showing as the
 *  provisional (unconfirmed) tail: everything from the LAST box-top `╭`
 *  onward is dropped (composer or dialog), then status noise and blanks;
 *  the last `max` surviving lines are returned ANSI-preserved. */
export function extractProvisionalTail(capture: string, max = 12): string[] {
  if (!capture) return []
  const lines = capture.split('\n')
  const stripped = lines.map(plain)
  let cut = lines.length
  for (let i = stripped.length - 1; i >= 0; i--) {
    if (stripped[i].trimStart().startsWith('╭')) {
      cut = i
      break
    }
  }
  const out: string[] = []
  for (let i = 0; i < cut; i++) {
    const t = stripped[i].trim()
    if (!t) continue
    if (NOISE.test(t)) continue
    out.push(lines[i])
  }
  return out.slice(-max)
}
```

`web/src/components/chat/latency.ts`:

```ts
// Hook→UI latency telemetry for the A1 dogfood week — the ONE unmeasured
// number the fail branch depends on (a0-findings §1 item 3, "expected ≪1s").
// The server stamps `activity_at` (its own clock, ms) on every activity
// delta (Task 3); we record `Date.now() − activity_at` on receipt.
//
// Two hard requirements from review: (1) samples PERSIST per-day in
// localStorage so a week of dogfooding survives reloads/navigation, and the
// number is surfaced in the chat panel footer (no devtools needed); (2) this
// module also owns the CLOCK-SKEW estimate: `noteServerStamp`/`serverNowMs`
// let every supersede/prune comparison run in the server clock domain (the
// owner dogfoods over tailnet from other devices). The raw lag samples still
// include true skew + transport — stated caveat: read absolute values in a
// browser on the same host; the ≪1s question survives modest skew.

const dayKey = () =>
  `supermux:chat-a1-latency:${new Date().toISOString().slice(0, 10)}`

function loadSamples(): number[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(dayKey())
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'number') : []
  } catch {
    return []
  }
}

const samples: number[] = loadSamples()

function persist(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(dayKey(), JSON.stringify(samples.slice(-500)))
  } catch {
    /* quota/private mode — console + in-memory still work */
  }
}

/** Nearest-rank p50 (matches a0-findings' small-n honesty: no interpolation). */
export function p50(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length / 2) - 1]
}

/** Today's raw samples (read-only view for the panel footer). */
export function latencySamples(): number[] {
  return samples
}

export function recordHookLatency(activityAtMs: number | undefined): void {
  if (typeof activityAtMs !== 'number') return
  const lag = Date.now() - activityAtMs
  // Clock skew / stale replays: discard absurd values instead of polluting p50.
  if (lag < -5_000 || lag > 60_000) return
  samples.push(lag)
  persist()
  console.info(
    `[chat-a1] hook→UI ${lag}ms · p50 ${p50(samples)}ms · n=${samples.length}`,
  )
}

// ---- server clock domain ---------------------------------------------------
// skew = client − server, estimated as the MIN over observed (Date.now() −
// serverStamp) so transport lag biases it as little as possible. null until
// the first server-stamped delta arrives.
let skewMs: number | null = null

/** Feed a server-clock ms stamp (e.g. `activity_at`) into the skew estimate. */
export function noteServerStamp(serverMs: number): void {
  if (!Number.isFinite(serverMs) || serverMs <= 0) return
  const d = Date.now() - serverMs
  skewMs = skewMs == null ? d : Math.min(skewMs, d)
}

/** "Now" on the SERVER's clock (best effort; Date.now() until first sample).
 *  All chat supersede/prune thresholds compare against THIS, never raw
 *  Date.now(), so a skewed browser clock can't kill the overlay or freeze
 *  duplicate receipts on screen. */
export function serverNowMs(): number {
  return Date.now() - (skewMs ?? 0)
}

/** Dogfood console access: `window.__supermuxChatLatency` is the raw array. */
export function exposeLatency(): void {
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__supermuxChatLatency = samples
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test tests/unit/` — Expected: all chat-* tests pass.
Then: add `"test:unit": "bun test tests/unit"` to `web/package.json` scripts and re-run as `bun run test:unit`.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/chat/entries.ts web/src/components/chat/provisional.ts \
  web/src/components/chat/latency.ts web/tests/unit/ web/package.json
git commit -m "feat(web): chat tail pure logic — entry grouping, provisional-tail extraction, latency stats

Dependency-free display model (bun test, zero new deps): receipts coalescing
w/ cap 30, P13 pty-tail noise filter, nearest-rank p50 for the hook→UI probe.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Chat panel components — tail hook, P12 working row, receipt overlay, P13 provisional tail

**Files:**
- Create: `web/src/components/chat/use-chat-tail.ts`
- Create: `web/src/components/chat/use-receipt-overlay.ts`
- Create: `web/src/components/chat/working-row.tsx`
- Create: `web/src/components/chat/provisional-tail.tsx`
- Create: `web/src/components/chat/renderer-switch.tsx`
- Create: `web/src/components/chat/chat-panel.tsx`
- Test: `bunx tsc -b` + `bun run lint` (component layer; behaviour is covered by Task 5's pure tests below it and Task 8's e2e above it)

**Interfaces:**
- Consumes: Task 4's api/types + flag, Task 5's pure logic, `useSse` (`web/src/hooks/use-sse.ts`), `StatusDot` (`web/src/components/session-tile/status-dot.tsx`), `parseAnsiLine`.
- Produces:
  - `use-chat-tail.ts`: `useChatTail(name: string, enabled: boolean): UseQueryResult<RecallResponse>` — fetches `sessionsApi.recall(name, { chat: true, limit: 30 })`; refetches on SSE `sessions`/`status` events for THIS session (trailing 1200ms debounce coalesces mid-turn bursts; the PANEL additionally calls `refetch()` with zero debounce on the active→idle edge so the confirming batch lands ASAP) + `onResync`. Server cost per refetch is one stat when the transcript is unchanged (Task 1's parse cache).
  - `use-receipt-overlay.ts`: `useReceiptOverlay(session: TileSession | null, turnStartMs: number | null, lastConfirmedTs: number): OverlayLine[]` with `interface OverlayLine { label: string; kind?: string; at: number /* SERVER-clock ms (activity_at) */ }`. Records hook latency + skew keyed on `activity_at` CHANGES (not label changes — consecutive same-label tools must still sample); labels pass through `stripEmojiPrefix` so overlay and confirmed receipts share one vocabulary; capped at `RECEIPT_CAP` (oldest dropped) — Claude runs 30–100 calls/turn and the DOM must not grow unboundedly.
  - `working-row.tsx`: `WorkingRow({ activity, subagents, turnStartMs })` — P12; elapsed = `serverNowMs() − turnStartMs` (server clock domain).
  - `provisional-tail.tsx`: `ProvisionalTail({ name, show })` — P13, an explicit 1s interval poll of `peekAnsi` while `show` (focused session only; a `capture-pane` subprocess per tick on tmux, cheap grid render on native).
  - `renderer-switch.tsx`: `RendererSwitch({ value, onChange })` with `data-testid="renderer-chat"` / `"renderer-terminal"`.
  - `chat-panel.tsx`: `export default function ChatPanel({ name, session }: { name: string; session: TileSession | null })` with root `data-testid="chat-panel"` — the lazy entry point Task 7 imports. Owns turn tracking (server clock domain, anchored on `last_send_at` when recent), the 1s live-layer ticker (a prose-only turn produces NO SSE traffic, so time-gated UI must self-rerender), and the supersede gate (live layer tears down only once a confirmed entry from THIS turn is in hand — never on the status flip itself).

- [ ] **Step 1: Implement `use-chat-tail.ts`**

```ts
// The A1 transcript poll: /recall?chat=true for the FOCUSED session only,
// re-pulled on the session's own SSE ticks (status flips, activity deltas)
// with a trailing debounce — never an interval, never other sessions. The
// chat WS replaces this in fase A2.

import * as React from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'

import { sessionsApi, type RecallResponse } from '@/lib/api'
import { useSse, type SseEventType } from '@/hooks/use-sse'

const DEBOUNCE_MS = 1200

export function useChatTail(
  name: string,
  enabled: boolean,
): UseQueryResult<RecallResponse> {
  const qc = useQueryClient()
  const key = React.useMemo(() => ['chat-tail', name] as const, [name])

  const query = useQuery({
    queryKey: key,
    queryFn: () => sessionsApi.recall(name, { chat: true, limit: 30 }),
    enabled,
    staleTime: 1_000,
    retry: false,
  })

  // Trailing debounce so a burst of deltas (a landing batch) costs one refetch.
  // (Turn-END confirmation is NOT debounced — ChatPanel calls query.refetch()
  // directly on the active→idle edge; a 1.2s blank gap there is the exact
  // supersede glitch checkpoint (c) forbids.)
  const timer = React.useRef<number | null>(null)
  const bump = React.useCallback(() => {
    if (timer.current != null) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      void qc.invalidateQueries({ queryKey: key })
    }, DEBOUNCE_MS)
  }, [qc, key])
  React.useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = null
    },
    [name],
  )

  const handlers = React.useMemo(
    () => ({
      onEvent: (type: SseEventType, payload: unknown) => {
        if (!enabled) return
        if (type !== 'sessions' && type !== 'status') return
        const p = payload as {
          name?: string
          delta?: { name?: string }[]
        } | null
        const hit =
          p?.name === name || p?.delta?.some((d) => d?.name === name) === true
        if (hit) bump()
      },
      onResync: () => {
        if (enabled) void qc.invalidateQueries({ queryKey: key })
      },
    }),
    [enabled, name, bump, qc, key],
  )
  useSse(handlers)

  return query
}
```

- [ ] **Step 2: Implement `use-receipt-overlay.ts`**

```ts
// Hook-driven receipt overlay (fase A1): the ≤1s live layer. Every activity
// delta on the focused session appends an overlay line while a turn is
// running; confirmed transcript entries SUPERSEDE overlay lines
// (discard-and-replace, never merge — a0-findings §1).
//
// Clock discipline: line stamps are the SERVER's `activity_at`, and the prune
// cutoff is the confirmed entry's (server-host) timestamp — the browser clock
// never participates, so tailnet dogfooding from a skewed device can neither
// silently kill the live layer nor freeze duplicate receipts on screen.
//
// Teardown discipline: the PANEL owns the turn (`turnStartMs`); lines clear
// when the panel ends the turn — which it only does once a confirmed entry
// from this turn is in hand, never on the bare status flip.

import * as React from 'react'

import type { TileSession } from '@/components/session-tile/types'

import { RECEIPT_CAP, stripEmojiPrefix } from './entries'
import { noteServerStamp, recordHookLatency } from './latency'

export interface OverlayLine {
  label: string
  kind?: string
  at: number // ms epoch, SERVER clock (activity_at)
}

export function useReceiptOverlay(
  session: TileSession | null,
  turnStartMs: number | null, // SERVER-clock ms; null = no live turn
  lastConfirmedTs: number, // epoch SECONDS (RecallEntry.ts, server host)
): OverlayLine[] {
  const [lines, setLines] = React.useState<OverlayLine[]>([])
  const activity = session?.activity
  const activityKind = session?.activity_kind
  const activityAt = session?.activity_at

  // Keyed on activity_at (every delta gets a fresh stamp): consecutive
  // same-LABEL tools still sample latency; the label dedupe below only
  // dedupes the visible line. Cap: oldest lines drop past RECEIPT_CAP.
  React.useEffect(() => {
    if (activityAt == null) return
    noteServerStamp(activityAt)
    recordHookLatency(activityAt)
    if (!activity || turnStartMs == null) return
    const label = stripEmojiPrefix(activity)
    setLines((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].label === label) return prev
      const next = [...prev, { label, kind: activityKind, at: activityAt }]
      return next.length > RECEIPT_CAP ? next.slice(-RECEIPT_CAP) : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityAt])

  // Discard-and-replace: anything at or before the newest confirmed entry is
  // now represented by real receipts — drop it (both sides server clocks).
  React.useEffect(() => {
    if (lastConfirmedTs <= 0) return
    const cutoff = lastConfirmedTs * 1000
    setLines((prev) => prev.filter((l) => l.at > cutoff))
  }, [lastConfirmedTs])

  // Turn ended (panel-gated on confirmation) → clear the remainder.
  React.useEffect(() => {
    if (turnStartMs == null) setLines([])
  }, [turnStartMs])

  return lines
}
```

- [ ] **Step 3: Implement `working-row.tsx`**

```tsx
// P12 working row (REQUIRED fail-branch primitive — master plan §4.2).
// Driven by the SSE status flip (206ms p50) + the live hook label; NEVER the
// transcript. Neutral-minimal: the A3 design addendum owns the real spec
// (states at 0s/5s/30s/>120s, motion, post-hoc collapse).

import * as React from 'react'

import { StatusDot } from '@/components/session-tile/status-dot'

import { formatElapsed, stripEmojiPrefix } from './entries'
import { serverNowMs } from './latency'

export function WorkingRow({
  activity,
  subagents,
  turnStartMs,
}: {
  activity?: string
  subagents?: number
  /** Turn anchor in SERVER-clock ms (last_send_at when recent, else the
   *  skew-corrected flip stamp) — so the elapsed clause counts from the SEND,
   *  not from whenever this component happened to mount. */
  turnStartMs: number
}) {
  // 1s tick for the elapsed clause only.
  const [, tick] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])
  const clause = subagents && subagents >= 2 ? ` · ${subagents} subagents` : ''
  return (
    <div
      data-testid="chat-working-row"
      className="flex items-center gap-2 px-1 py-1.5 text-[13px] text-muted-foreground"
    >
      <StatusDot status="active" />
      <span className="min-w-0 truncate">
        {(activity ? stripEmojiPrefix(activity) : 'Working…') + clause}
      </span>
      <span className="ml-auto shrink-0 tabular-nums">
        {formatElapsed(serverNowMs() - turnStartMs)}
      </span>
    </div>
  )
}
```

(If `StatusDot`'s props differ — check `web/src/components/session-tile/status-dot.tsx` before wiring — pass whatever its `status` prop type requires; it already renders the app's canonical per-status dot.)

- [ ] **Step 4: Implement `provisional-tail.tsx`**

```tsx
// P13 provisional tail (REQUIRED fail-branch primitive — master plan §4.2).
// Pty text appears at ~3.2s where the transcript takes ~31s (a0-findings §1);
// this block shows the pty capture, VISUALLY marked unconfirmed, and is
// discarded-and-replaced when the confirming batch lands (the parent gates
// `show`). 1s poll on the FOCUSED session only, only while shown.

import * as React from 'react'

import { sessionsApi } from '@/lib/api'
import { parseAnsiLine } from '@/lib/ansi'

import { extractProvisionalTail } from './provisional'

export function ProvisionalTail({ name, show }: { name: string; show: boolean }) {
  const [lines, setLines] = React.useState<string[]>([])

  React.useEffect(() => {
    if (!show) {
      setLines([])
      return
    }
    let dead = false
    const poll = async () => {
      try {
        const cap = await sessionsApi.peekAnsi(name, 30)
        if (!dead) setLines(extractProvisionalTail(cap))
      } catch {
        /* transient — keep the previous frame */
      }
    }
    void poll()
    const id = window.setInterval(() => void poll(), 1000)
    return () => {
      dead = true
      window.clearInterval(id)
    }
  }, [name, show])

  if (!show || lines.length === 0) return null
  return (
    <div
      data-testid="chat-provisional-tail"
      className="rounded-lg border border-dashed border-border bg-card px-3 py-2 opacity-80 transition-opacity duration-300"
    >
      <div className="pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Live terminal · unconfirmed
      </div>
      <pre className="overflow-x-auto font-mono text-[12.5px] leading-[18px]">
        {lines.map((l, i) => (
          <div key={i}>
            {parseAnsiLine(l).map((s, j) => (
              <span key={j} style={s.style}>
                {s.text}
              </span>
            ))}
          </div>
        ))}
      </pre>
    </div>
  )
}
```

- [ ] **Step 5: Implement `renderer-switch.tsx`**

```tsx
// The A1 renderer switch: chat default (flag on), terminal ONE tap away.
// Plain segmented control on existing tokens; the same-cell crossfade and
// mounted-but-hidden retention are fase A5 (§6.2) — A1 swaps components.

import { cn } from '@/lib/utils'

export function RendererSwitch({
  value,
  onChange,
}: {
  value: 'chat' | 'terminal'
  onChange: (v: 'chat' | 'terminal') => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Session renderer"
      className="inline-flex overflow-hidden rounded-md border border-border text-[12px]"
    >
      {(['chat', 'terminal'] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={value === v}
          data-testid={`renderer-${v}`}
          onClick={() => onChange(v)}
          className={cn(
            'px-2.5 py-1 capitalize transition-colors',
            value === v
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {v}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 6: Implement `chat-panel.tsx`** (the lazy chunk entry)

```tsx
// Fase A1 chat panel — read-only walking skeleton (master plan §7 Fase A1).
//
// Layer model (a0-findings §1): the TRANSCRIPT is the confirming layer
// (batch-flushed, prose p50 31s); the LIVE layer is the status flip + hook
// receipts + the provisional pty tail. Provisional content is discarded and
// replaced on confirmation, never merged. Receipts-first: overlay receipts
// and the working row render BELOW confirmed content, above the provisional
// text block.
//
// Deliberately neutral-minimal (existing tokens, no markdown, no motion):
// the A3 design direction replaces this surface wholesale.

import * as React from 'react'

import type { TileSession } from '@/components/session-tile/types'

import { stripEmojiPrefix, toDisplayList, type ChatEntry } from './entries'
import { useChatTail } from './use-chat-tail'
import { useReceiptOverlay } from './use-receipt-overlay'
import { WorkingRow } from './working-row'
import { ProvisionalTail } from './provisional-tail'
import { exposeLatency, latencySamples, p50, serverNowMs } from './latency'

const FOLLOW_THRESHOLD_PX = 48
/** Only show the provisional tail when the transcript is clearly BEHIND the
 *  live turn — right after a batch lands the pty text is confirmed content
 *  and showing it again would duplicate (the A1 anti-glitch heuristic). */
const PROVISIONAL_LAG_MS = 5_000
/** How recent `last_send_at` must be at the flip to count as THIS turn's
 *  anchor (terminal-typed sends never stamp it, so it can be stale). */
const SEND_ANCHOR_WINDOW_MS = 30_000

export default function ChatPanel({
  name,
  session,
}: {
  name: string
  session: TileSession | null
}) {
  const active = session?.status === 'active'
  const tail = useChatTail(name, true)
  const entries = (tail.data?.entries ?? []) as unknown as ChatEntry[]
  const items = React.useMemo(() => toDisplayList(entries), [entries])
  const lastConfirmedTs = entries.length > 0 ? entries[0].ts : 0
  const lastConfirmedMs = lastConfirmedTs * 1000

  // Turn tracking, SERVER clock domain. Anchor priority: the server's
  // last_send_at stamp (the dock/API send that started the turn — makes the
  // elapsed clause count from the SEND even when this panel mounts mid-turn),
  // else skew-corrected server-now at the flip. Never raw Date.now().
  const [turnStart, setTurnStart] = React.useState<number | null>(null)
  const lastSendAt = session?.last_send_at
  React.useEffect(() => {
    if (!active) return
    setTurnStart((prev) => {
      if (prev != null) return prev
      const now = serverNowMs()
      const sendMs = (lastSendAt ?? 0) * 1000
      return sendMs > 0 && now - sendMs < SEND_ANCHOR_WINDOW_MS ? sendMs : now
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Supersede gate (checkpoint (c)): the live layer tears down only once a
  // confirmed entry from THIS turn is in hand — never on the bare status
  // flip, which would leave a blank gap while the batch is still in flight.
  const confirmedCaughtUp = turnStart != null && lastConfirmedMs >= turnStart
  React.useEffect(() => {
    if (!active && confirmedCaughtUp) setTurnStart(null)
  }, [active, confirmedCaughtUp])

  // Turn end → confirm NOW (zero debounce; the mid-turn debounce only exists
  // to coalesce delta bursts).
  const refetch = tail.refetch
  React.useEffect(() => {
    if (!active && turnStart != null) void refetch()
  }, [active, turnStart, refetch])

  // 1s live-layer ticker: a prose-only turn produces NO deltas and NO
  // refetches, so every time-gated piece below (showProvisional, elapsed,
  // footer stats) must re-render on its own clock or it never appears.
  const liveLayerUp = active || turnStart != null
  const [, tick] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    if (!liveLayerUp) return
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [liveLayerUp])

  const overlay = useReceiptOverlay(session, turnStart, lastConfirmedTs)
  React.useEffect(() => exposeLatency(), [])

  // Follow-bottom pin: stick to the newest content unless the user scrolled up.
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const pinnedRef = React.useRef(true)
  const onScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX
  }, [])
  React.useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  })

  // Shown while the transcript is behind the live turn; liveLayerUp keeps it
  // (and the overlay) mounted through the post-Stop confirmation window, so
  // the answer never blanks out before its confirmed form arrives.
  const showProvisional =
    liveLayerUp &&
    turnStart != null &&
    serverNowMs() - lastConfirmedMs > PROVISIONAL_LAG_MS

  return (
    <div
      data-testid="chat-panel"
      className="flex h-full w-full flex-col bg-card"
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4"
      >
        <div className="mx-auto flex max-w-[52rem] flex-col gap-3">
          {tail.isError && (
            <p className="py-8 text-center text-[13px] text-muted-foreground">
              Couldn’t load this conversation.
            </p>
          )}
          {!tail.isError && items.length === 0 && !tail.isLoading && (
            <p className="py-8 text-center text-[13px] text-muted-foreground">
              No conversation yet.
            </p>
          )}

          {items.map((item) => {
            if (item.type === 'user') {
              return (
                <div key={item.uuid} className="flex justify-end">
                  <div className="max-w-[72%] rounded-2xl bg-muted px-3 py-2 text-[14px] leading-5">
                    {item.badge && (
                      <span className="mr-1.5 rounded bg-background px-1 py-0.5 text-[11px] text-muted-foreground">
                        {item.badge}
                      </span>
                    )}
                    <span className="whitespace-pre-wrap break-words">{item.text}</span>
                  </div>
                </div>
              )
            }
            if (item.type === 'assistant') {
              return (
                <div
                  key={item.uuid}
                  className="whitespace-pre-wrap break-words text-[14px] leading-5"
                >
                  {item.text}
                </div>
              )
            }
            // receipts
            return (
              <div
                key={item.uuid}
                className="flex flex-col gap-0.5 rounded-lg border border-border/60 px-3 py-2"
              >
                {item.lines.map((l) => (
                  <div
                    key={l.uuid}
                    className="flex items-baseline gap-2 text-[13px]"
                    title={l.result}
                  >
                    <span
                      className={
                        l.ok === false ? 'text-status-error' : 'text-muted-foreground'
                      }
                      aria-hidden
                    >
                      {l.ok === false ? '✗' : '✓'}
                    </span>
                    <span className="min-w-0 truncate font-mono text-[12.5px]">
                      {l.label}
                    </span>
                  </div>
                ))}
                {item.overflow > 0 && (
                  <div className="pt-0.5 text-[12px] text-muted-foreground">
                    +{item.overflow} more
                  </div>
                )}
              </div>
            )
          })}

          {/* Live layer — permission first (nothing silently invisible), then
              overlay receipts, then the working row, then provisional text. */}
          {session?.permission_request && (
            /* permission_request is the wire OBJECT {tool, summary, kind,
               mode?} — never render the object itself. */
            <div
              data-testid="chat-permission-row"
              className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[13px]"
            >
              <span aria-hidden>⏸</span>
              <span className="min-w-0 truncate">
                Waiting for permission:{' '}
                <span className="font-medium">{session.permission_request.tool}</span>
                {session.permission_request.summary && (
                  <span className="text-muted-foreground">
                    {' — '}
                    {stripEmojiPrefix(session.permission_request.summary)}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-muted-foreground">
                · answer in the terminal
              </span>
            </div>
          )}

          {overlay.length > 0 && (
            <div className="flex flex-col gap-0.5 px-1">
              {overlay.map((l, i) => (
                <div
                  key={`${l.at}-${i}`}
                  className="flex items-baseline gap-2 text-[13px] text-muted-foreground"
                >
                  <span aria-hidden>·</span>
                  <span className="min-w-0 truncate font-mono text-[12.5px]">
                    {l.label}
                  </span>
                </div>
              ))}
            </div>
          )}

          {active && turnStart != null && (
            <WorkingRow
              activity={session?.activity}
              subagents={session?.subagents}
              turnStartMs={turnStart}
            />
          )}

          <ProvisionalTail name={name} show={showProvisional} />
        </div>
      </div>

      <div className="shrink-0 border-t border-border/60 px-5 py-2 text-center text-[12px] text-muted-foreground">
        Read-only preview — switch to Terminal to type.
        {latencySamples().length > 0 && (
          /* The dogfood number, readable without devtools (re-renders on the
             live-layer ticker / tail refetches). */
          <span className="ml-2 tabular-nums">
            · hook→UI p50 {p50(latencySamples())} ms (n={latencySamples().length})
          </span>
        )}
      </div>
    </div>
  )
}
```

(Token check while implementing: `text-status-error` — grep `web/src/styles/globals.css` for the `status-` utility names actually defined and use the existing error/failed hue class; fall back to `text-muted-foreground` + the ✗ glyph if none fits. Do NOT invent a token.)

- [ ] **Step 7: Typecheck + lint to verify**

Run: `bunx tsc -b && bun run lint && bun run test:unit`
Expected: clean; pure tests still green.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/chat/
git commit -m "feat(web): chat panel — read-only tail, P12 working row, hook receipt overlay, P13 provisional tail

Overlay-first per the A0 fail branch: transcript confirms (discard-and-
replace), hooks + status flip + pty tail carry the live layer. Neutral
tokens only — A3 owns the design direction. Logs hook→UI latency for the
dogfood week.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: The renderer switch at the desktop focus seam (lazy chunk)

**Files:**
- Modify: `web/src/components/focus-mode/desktop-split.tsx` — imports (:17-54), body (compute flag near :425-427), render seam (:606-637), dock (:652-674)
- Test: `bunx tsc -b`, `bun run lint`, `bun run build:perf` (chunking + size budget); behaviour e2e in Task 8

**Interfaces:**
- Consumes: `useChatRenderer` (Task 4), `RendererSwitch` + lazy `ChatPanel` (Task 6), existing `teams` prop / `current` / `status` in `DesktopSplit`.
- Produces: with the flag on and the session eligible, the desktop focus main pane renders `ChatPanel` by default with a `[Chat | Terminal]` control above it; the terminal path is byte-identical when the flag is off. **Mobile is untouched** — `web/src/routes/focus/mobile.tsx:490-515` is the A5 seam (documented, not wired).

- [ ] **Step 1: Wire the seam**

In `desktop-split.tsx`:

1a. Imports (top, after existing ones):

```tsx
import { RendererSwitch } from '@/components/chat/renderer-switch'
import { useChatRenderer } from '@/components/chat/use-chat-renderer'

// Lazy: the chat renderer is its own chunk — nothing chat-related may land in
// the entry bundle (perf budget; master plan Global Constraints).
const ChatPanel = React.lazy(() => import('@/components/chat/chat-panel'))
```

1b. After `const status = current?.status ?? 'starting'` (:426), add:

```tsx
  // Fase A1 chat renderer — desktop seam only (mobile follows in A5; the
  // mobile seam is routes/focus/mobile.tsx:490-515). Guard: local Claude,
  // not a team lead (Track A v1 scope), flag + kill-switch in
  // components/chat/flag.ts.
  const isTeamLead = React.useMemo(
    () => teams.some((t) => t.lead_supermux_session === name),
    [teams, name],
  )
  const chatSetting = useUI((s) => s.chatRenderer)
  const chatOn = useChatRenderer(current ?? null, isTeamLead)
  // renderer null = undecided. With the experiment ON we wait for the
  // sessions query (`current` is null on first paint) before choosing, so the
  // terminal never mounts→attaches→unmounts on every focus load (wasted pty
  // WS + a visible flash — the focus-no-mobile-flash class of bug), and the
  // choice is made ONCE per session name, so a late flag/eligibility resolve
  // can never stomp the user's manual tap. With the experiment OFF the
  // always-terminal path below is byte-identical to today.
  const [renderer, setRenderer] = React.useState<'chat' | 'terminal' | null>(null)
  React.useEffect(() => setRenderer(null), [name])
  React.useEffect(() => {
    if (current != null) setRenderer((r) => r ?? (chatOn ? 'chat' : 'terminal'))
  }, [current, chatOn])
  const chatActive = chatSetting && chatOn && renderer === 'chat' && status !== 'stopped'
```

(`useUI` is already imported or add it; `chatSetting` also gates the undecided-skeleton branch in 1d so flag-off users keep today's immediate terminal mount.)

1c. Above the terminal pane `<div ref={termPaneRef} …>` (:606), insert the switch strip (renders only when the flag applies, so non-flag layouts are pixel-identical):

```tsx
        {chatOn && (
          <div className="flex h-8 shrink-0 items-center justify-end border-b border-border/60 px-3">
            <RendererSwitch value={renderer ?? 'chat'} onChange={setRenderer} />
          </div>
        )}
```

1d. The seam itself (:621-629) becomes:

```tsx
            {status === 'stopped' ? (
              <StoppedSession name={name} />
            ) : chatActive ? (
              /* Fase A1: read-only chat renderer. The chat client NEVER sends
                 resize or input; toggling to Terminal remounts LiveTerminal
                 (full handshake — mounted-but-hidden retention is A5 §6.2).
                 KNOWN A1 COST (accepted, documented in the dogfood handoff):
                 while chat is primary the pty keeps whatever size it last had
                 (native holders boot 80×24; only the terminal WS resizes), so
                 P13's capture is wrapped at that width and the first Terminal
                 tap reflows. Mitigation for the week: tap Terminal once early
                 per session (also needed to answer permission dialogs) — the
                 WS handshake resizes the pty to real geometry. A5's retention
                 owns the real fix. */
              <React.Suspense fallback={null}>
                <ChatPanel name={name} session={current} />
              </React.Suspense>
            ) : !chatSetting || renderer != null ? (
              <LiveTerminal name={name} onReady={handleTermReady} />
            ) : null /* experiment on, sessions query still resolving — render
                        nothing for a frame rather than flash a doomed terminal */}
```

1e. While `chatActive`, input affordances that write into the pty are hidden/disabled so nothing silently no-ops (`termRef` is null without a mounted terminal):
- `<Dropzone …>` gets `disabled={status === 'stopped' || chatActive}`.
- `onPaste` handler: first line becomes `if (chatActive) return` (image paste needs the terminal injection path). Add `chatActive` to its dep array.
- `<DesktopDock …>` render (:652-674) wraps in `{!chatActive && ( … )}` — the panel's own footer explains "switch to Terminal to type".
- `<TerminalCaptureIndicator capturing={…} />` gets `&& !chatActive`.

- [ ] **Step 2: Typecheck + lint**

Run: `bunx tsc -b && bun run lint`
Expected: clean.

- [ ] **Step 3: Build + perf gate — verify the chat chunk is lazy and budgets hold**

Run: `bun run build:perf`
Expected: build succeeds; size gate passes (app JS ≤ 200 KB gz — baseline was 154.3 KB); `dist/assets` contains a separate `chat-panel-*.js` chunk. Verify: `ls dist/assets | grep -i chat`. NOTE the honest framing: the gate sums ALL non-vendor chunks, so the lazy chat chunk still counts against the budget — laziness buys first-paint parse time, not budget headroom.

- [ ] **Step 4: Manual smoke (optional but cheap)**

Run: `bunx vite --port 5199` against a locally booted debug server (`CLAUDE_CONFIG_DIR=$(mktemp -d) SUPERMUX_DATA_DIR=$(mktemp -d) SUPERMUX_BIND=127.0.0.1:8899 SUPERMUX_AUTH_TOKEN=dev ./server/target/debug/supermux-server` — build it first with `cargo build`; `CLAUDE_CONFIG_DIR` is NOT optional: without it, creating a Claude session here silently installs the new hook events into the real `~/.claude/settings.json` before the PR is even reviewed). Flip the Settings toggle, focus a Claude session, confirm the switch renders. Never touch the live :8824 instance.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/focus-mode/desktop-split.tsx
git commit -m "feat(web): renderer switch at the desktop focus seam — chat default behind the flag, terminal one tap away

Lazy chat chunk; pty-writing affordances (dock, dropzone, image paste)
hidden while chat is active so nothing silently no-ops. Mobile seam
(focus/mobile.tsx:490-515) follows in A5.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: e2e smoke — the switch + the kill-switch

**Files:**
- Create: `web/tests/e2e/smoke/chat-renderer-switch.spec.ts`
- Test: itself (Playwright against a real booted backend via the existing harness)

**Interfaces:**
- Consumes: `startBackend`/`api`/`injectGlobals` from `web/tests/e2e/smoke/harness.ts`; the flag persistence shape (`localStorage['supermux-ui']`, zustand persist `{ state, version }`); testids from Tasks 6/7.
- Produces: the A1 regression net for the seam: flag on → chat panel; one tap → terminal; kill-switch → terminal; ineligible provider → terminal.

- [ ] **Step 1: Write the spec**

```ts
// Fase A1 — the renderer switch at the desktop focus seam.
//
// Boots the real binary (harness). This is the suite's FIRST spec that
// creates `provider: 'claude'` (all other smoke specs use 'shell'), which
// makes two things non-negotiable:
//
// 1. The backend's hook installer writes into $CLAUDE_CONFIG_DIR — so this
//    module forces an isolated dir at import time, BEFORE any backend boots
//    (spawnBackend inherits process.env). A plain `bun run test:e2e:smoke`
//    must never touch the real ~/.claude/settings.json.
// 2. The claude-provider tests skip when the CLI isn't on the runner's PATH
//    (a missing binary would stop the session and fail the seam assertion
//    for an unrelated reason). The shell-provider ineligibility test always
//    runs; the flag decision table itself is covered by bun unit tests.
//
// Needs server/target/debug/supermux-server — `cd server && cargo build`
// first (debug; never --release).

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { api, injectGlobals, startBackend, type Backend } from './harness'

// Module scope: runs before any beforeEach/startBackend in this file.
process.env.CLAUDE_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'a1-claude-cfg-'))

const hasClaudeCli = (() => {
  try {
    execSync('command -v claude', { stdio: 'ignore', shell: '/bin/bash' })
    return true
  } catch {
    return false
  }
})()

// zustand persist payload for the UI store with the A1 flag ON.
const FLAG_ON = JSON.stringify({ state: { chatRenderer: true }, version: 0 })

test.describe('chat renderer switch (fase A1)', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('flag on → chat panel default; terminal one tap away and back', async ({
    page,
  }) => {
    test.skip(!hasClaudeCli, 'claude CLI not on this runner')
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
    }, FLAG_ON)

    const res = await api(backend).createSession({
      name: 'a1-chat',
      provider: 'claude',
      dir: backend.dataDir,
    })
    expect([200, 201]).toContain(res.status)

    await page.goto(`${backend.baseUrl}/focus/a1-chat`)
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expect(page.getByText('Read-only preview', { exact: false })).toBeVisible()

    // One tap to the terminal fallback…
    await page.getByTestId('renderer-terminal').click()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)

    // …and one tap back.
    await page.getByTestId('renderer-chat').click()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
  })

  test('kill-switch forces the terminal even with the flag on', async ({
    page,
  }) => {
    test.skip(!hasClaudeCli, 'claude CLI not on this runner')
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
      window.localStorage.setItem('supermux:chat-renderer', '0')
    }, FLAG_ON)

    const res = await api(backend).createSession({
      name: 'a1-kill',
      provider: 'claude',
      dir: backend.dataDir,
    })
    expect([200, 201]).toContain(res.status)

    await page.goto(`${backend.baseUrl}/focus/a1-kill`)
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
    await expect(page.getByTestId('renderer-chat')).toHaveCount(0)
  })

  test('ineligible provider (shell) never gets the chat renderer', async ({
    page,
  }) => {
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
    }, FLAG_ON)

    const res = await api(backend).createSession({
      name: 'a1-shell',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect([200, 201]).toContain(res.status)

    await page.goto(`${backend.baseUrl}/focus/a1-shell`)
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
  })
})
```

(Before running, read `harness.ts`'s `api()` helper to confirm the `createSession` return shape — the overview smoke spec at `tests/e2e/smoke/overview-loads.spec.ts:35-40` uses `res.status === 201`; mirror whatever it actually returns. Known slow path: a fresh `CLAUDE_CONFIG_DIR` means the claude TUI sits at onboarding — the session stays *running* (the seam only needs `status !== 'stopped'`), but allow generous visibility timeouts.)

- [ ] **Step 2: Build the debug binary the harness boots**

Run: `cd /opt/projects/supermux-a1/server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo build`
Expected: `server/target/debug/supermux-server` exists.

- [ ] **Step 3: Run the spec (expect it to pass now — the implementation landed in Tasks 4-7; if it fails, that's a real seam bug)**

Run: `cd /opt/projects/supermux-a1/web && SUPERMUX_E2E_NO_SANDBOX=1 bunx playwright test tests/e2e/smoke/chat-renderer-switch.spec.ts`
Expected: 3 passed on this host (claude CLI present); 1 passed + 2 skipped on a runner without the CLI. No manual `CLAUDE_CONFIG_DIR` needed — the spec forces its own isolated dir. (If chromium is missing libs on this host, apply the known recipe from the offline-mobile-rig memory: `LD_LIBRARY_PATH` + the no-zygote flags already wired behind `SUPERMUX_E2E_NO_SANDBOX`.)

- [ ] **Step 4: Full regression sweep**

Run:
- `cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test`
- `cd ../web && bun run test:unit && bunx tsc -b && bun run lint && bun run build:perf`
Expected: everything green.

- [ ] **Step 5: Commit**

```bash
git add web/tests/e2e/smoke/chat-renderer-switch.spec.ts
git commit -m "test(e2e): chat renderer switch smoke — flag, one-tap fallback, kill-switch, eligibility

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: PR + dogfood handoff

**Files:** none (process)

- [ ] **Step 1: Push + open the PR**

```bash
cd /opt/projects/supermux-a1
git push -u origin feat/a1-walking-skeleton
# STACKED PR: base = the enablers branch this slice builds on. When
# feat/chat-dataplane-enablers merges, retarget this PR to main (gh pr edit
# --base main) — never merge the enabler commits twice.
gh pr create --base feat/chat-dataplane-enablers \
  --title "feat: fase A1 walking skeleton — chat renderer dogfood slice (flagged)" --body "$(cat <<'EOF'
## Fase A1 — walking skeleton (master plan §7, a0-findings fail branch)

Stacked on #<enablers-PR> (`feat/chat-dataplane-enablers`: PermissionRequest/PostToolUseFailure install+ingest, `permission_request` object on the delta, `/peek?ansi=1`). Behind Settings → Experimental → "Chat renderer (preview)" (default OFF; kill-switch `localStorage['supermux:chat-renderer']='0'`), the desktop focus pane renders a read-only chat view for local Claude sessions with the terminal one tap away.

**Server (all additive, on top of the enablers):**
- `/recall?chat=true` — full assistant text + tool_use/result pairs (new kinds `assistant`/`tool_use`, `ok` flag), plus a single-slot mtime/len parse cache so the A1 poll costs a stat on unchanged transcripts
- `activity_at` (server-clock ms) on the sessions activity delta — the hook→UI latency anchor + the client's clock-skew sample

**Web (lazy chunk, no new deps):**
- P12 working row (status flip; elapsed anchored on `last_send_at`), hook receipt overlay (capped, emoji-stripped to match confirmed receipts) + permission row, P13 provisional pty tail — all supersede/prune comparisons run in the SERVER clock domain, and the live layer tears down only once the confirming batch is in hand (no blank gap, no duplicate window)
- renderer switch at the desktop seam only (mobile = A5); hook→UI latency persisted per-day and shown in the panel footer (`window.__supermuxChatLatency` for the raw array)
- Evidence file landed: `docs/superpowers/plans/research-2026-08-13/a0-findings.md`

**Tests:** cargo (recall/hooks + the enabler suites), bun unit (flag/entries/provisional/latency), Playwright smoke (switch/kill-switch/eligibility; isolated CLAUDE_CONFIG_DIR forced in-spec).

**Dogfood checkpoints after a week (a0-findings §1, per the owner's decision):** (a) something session-specific within 1s of send · (b) mid-turn "what is it doing" without the terminal · (c) provisional→confirmed supersede doesn't glitch. A failed checkpoint iterates the *mechanism* before A3's design spend leans on it — these steer the *how*, never the *whether*; the direction never reverts. Answers land in `docs/superpowers/plans/research-2026-08-13/a1-dogfood-notes.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

(Fill `#<enablers-PR>` with the real PR number — `gh pr list --head feat/chat-dataplane-enablers`. If no PR exists for the enablers branch yet, say so in the body and let the owner decide the merge order.)

- [ ] **Step 2: Hand off**

Report to the owner: PR URL + the stacking note (enablers first, then retarget); that the flag is default-OFF so merging is safe; how to enable (Settings → Experimental) and the kill-switch key. Then the DOGFOOD PROCEDURE, verbatim:
- **Measuring (a) — something within 1s of send:** the chat pane has no send path in A1, so use two windows: send via the dock from a second browser window or phone (the API send stamps `last_send_at`, which anchors the elapsed clock) while watching the chat pane; the working row + first receipt should move within ~1s.
- **Geometry:** after starting a session, tap Terminal once (you'll need it for permission dialogs anyway) — that WS handshake resizes the pty from its 80×24 boot size, so P13's provisional text wraps at your real width instead of hard-wrapping at 80 cols.
- **Reading the latency number:** the chat panel footer shows `hook→UI p50 … (n=…)`, persisted per-day; `window.__supermuxChatLatency` has the raw samples; absolute values are cleanest in a browser on the same host (skew inflates them, the ≪1s question survives modest skew).
- **Writing the answers:** `docs/superpowers/plans/research-2026-08-13/a1-dogfood-notes.md` — one line per checkpoint, plus the p50.

Do NOT merge, do NOT deploy, do NOT restart :8824.

---

## Self-Review (run after writing code, before the PR)

1. **Spec coverage** — the seven A1 scope items: (1) read-only tail from extended `/recall` → Task 1+6; (2) P12 from the SSE status flip + activity label → Task 6 `WorkingRow`; (3) hook receipt overlay incl. the `permission_request` object → shipped enablers (Task 2 verified) + Task 6; (4) P13 from the shipped `/peek?ansi=1`, marked provisional, discard-and-replace → Tasks 2 (verify) + 5 + 6; (5) renderer switch, desktop seam only, chat default under the flag → Task 7; (6) hook→UI latency measurement → Task 3 (`activity_at`) + 5/6 (`latency.ts`, persisted + footer-surfaced); (7) kill-switch → Task 4. Non-goals honoured: no input, no resize, no chat WS, no new server module, no markdown, no mobile seam.
2. **Type consistency spots to re-check while executing:** `gather_in_proj`'s new arg position (`chat` before `before`) matches every call site incl. all tests; `RecallEntry.ok` added to BOTH the Rust struct literal sites and the TS type; `ChatEntry.kind` string values match the serde snake_case (`assistant`, `tool_use`); `permission_request` is the OBJECT `{ tool, summary, kind, mode? }` at every layer (never rendered directly as a React child); ALL supersede/prune/threshold comparisons run in SERVER-clock ms (`activity_at`, `last_send_at`×1000, `entry.ts`×1000, `serverNowMs()`) — a raw `Date.now()` in any of them is a bug; `lastConfirmedTs` is SECONDS everywhere it crosses into ms comparisons; `StatusDot` props verified against its real file before Task 6 Step 3.
3. **Placeholder scan:** none — every step carries runnable code or an exact command. The deliberate "verify against the real file first" notes (StatusDot props, harness `api()` shape, `text-status-*` token names, the enablers-branch tip in Task 0) are look-before-wiring instructions with stated fallbacks, not TBDs.

---

## Review responses (revision 2026-08-14)

Both review passes applied except where noted. Rejected/partial findings, with rationale:

- **F1 geometry (80×24 pty while chat-primary) — PARTIAL.** A server-side resize on chat attach is rejected for A1: "no resize from the chat client" is a hard slice constraint, and a new resize surface is exactly what A5's mounted-but-hidden retention makes unnecessary. Accepted instead: the cost is now documented at the seam (Task 7 1d) and the dogfood handoff instructs one early Terminal tap per session (needed for permission dialogs anyway), which resizes the pty via the existing WS handshake.
- **F2 status-flip latency sample — REJECTED (measurement only).** The status flip rides the same SSE transport as activity deltas, so the hook→UI p50 bounds status→UI to within broadcast overhead; the server-side flip itself is already measured (a0: 206ms p50). Adding a stamp to the separate status broadcast path is server surface the week doesn't need. The rest of that finding (persistence, `activity_at`-keyed sampling so same-label tools still sample, in-UI surfacing) is applied.
- **F3 e2e "prefer shell-only" — PARTIAL.** The positive and kill-switch specs keep `provider: 'claude'` (the seam's eligibility guard is exactly what's under test), but the spec now forces an isolated `CLAUDE_CONFIG_DIR` at module scope (no manual env, `~/.claude` can never be touched by any invocation path incl. CI) and skips when the CLI is absent; the ineligibility spec + bun unit tests carry runners without claude.
- **F4 server-fact `active_since` field — PARTIAL.** No new server field: the existing `last_send_at` (already on the wire, server clock) anchors the turn when recent, with skew-corrected `serverNowMs()` as fallback — same observable outcome (elapsed counts from the send, panel mount mid-turn doesn't re-stamp) without growing the delta. The two-window measurement procedure for checkpoint (a) is now spelled out in Task 9.
- **F5 recall poll cost — ACCEPTED as an mtime/len parse cache** (single slot, focused session only) rather than a tail-seek: a0 measured single JSONL lines up to ~950 KB, so any byte-window seek risks splitting exactly the lines that matter; the cache reduces the steady-state poll to a stat, and the A2 WS retires the whole read path.

All other findings (enablers-branch blocker → stacked worktree + object wire shape; provisional-tail ticker; supersede gap/duplicate window; clock domains; emoji vocabulary; stop/go rewording + landing a0-findings.md; terminal flash/manual-choice stomp; overlay cap; lazy-chunk budget honesty; interval-poll wording; `?ansi` flag semantics) are applied in place.
