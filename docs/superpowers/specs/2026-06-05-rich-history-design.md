# Design: Rich Prompt History

**Status**: Draft for build · **Date**: 2026-06-05 · **Owner**: tbd
**Builds on**: [`2026-06-04-last-user-prompt-design.md`](./2026-06-04-last-user-prompt-design.md)

## 1. Problem

The existing single-prompt recall (the glass bar + popover showing "your last
send") answers "what did I just ask?" but not "what did I ask earlier today?"
or "did I already ask this in another session for this project?". Users have
to leave focus mode and use `claude --resume` to dig further.

Meanwhile every prompt is already persisted by Claude Code itself, line-by-line
in `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. supermux already
parses these files for the Resume picker (`server/src/sessions/resumable.rs`).
The data is on disk; only the surface is missing.

## 2. Goal

Turn the existing recall popover/sheet into a **rich, searchable history of
your prompts and Claude's replies** — for the current session by default, with
a one-tap switch to the project-wide view — without leaving focus mode and
without growing screen real estate.

Stay lean: zero new frontend files, one new server module, reuse every
utility (`ANSI_RE`, `formatRecallTime`, `Envelope<T>`, `AppError`,
`resumable.rs` helpers, `Springs` presets, existing copy pattern).

## 3. Out of scope

- Full transcript viewer (tool calls, thinking blocks, raw JSON). Out of scope
  for v1 — overlaps `claude --resume` and grows the surface beyond focus mode.
- Global search across projects. Project-scoped covers the asked use case.
- Editing or re-sending from the list. Copy is enough; the user can paste
  back into the terminal.
- Persistent expand state across navigations. Each popover-open starts fresh.
- Indexing / SQLite FTS. Substring scan is sub-second on real transcripts
  (resumable.rs proved this); adding an index is a v2 problem.

## 4. UX

The bar (`LastSendBar`) and its auto-show behavior are unchanged — it still
shows just the most recent prompt as a teaser. The popover/sheet that opens
from the bar or the `Quote` icon is what gets the upgrade.

### 4.1 Popover / sheet layout

```
┌─ popover  (≤ 380px wide, max 480px tall) ───────────────────┐
│  [ This session │ Project ]                              ⓘ  │   ← tabs
│  ────────────────────────────────────────────────────────── │
│  🔍  Search…                                                │   ← search row
│  ────────────────────────────────────────────────────────── │
│  ▼  You · 2m ago                                      📋   │   ← entry, expanded
│     refactor the auth middleware to use the new token shape │      (first item only)
│     ↳ Done — diff is on `feature/auth-refactor`.            │      reply, line-clamp-3
│  ─────                                                       │
│  ▸  You · 12m ago                                     📋   │   ← entry, collapsed
│     fix the typo in the footer                              │      (prompt line-clamp-3)
│     ↳ Done — commit b3f7e21.                                │      reply, line-clamp-1
│  ─────                                                       │
│  …                                                           │
│  ─────────────────────────────────────────────────────────── │
│           [ Load 20 more ]      ☐ Include sub-agents         │   ← footer
└───────────────────────────────────────────────────────────────┘
```

- **Tabs** (Radix `Tabs`): `This session` (default) / `Project`. In Project
  mode, entries from different sessions are visually separated by a tiny
  header line (`— <aiTitle of that session> · 3h ago —`) above the first
  entry of each session-group.
- **Search** (plain `<input>` with `Search` icon, debounced 150 ms):
  case-insensitive substring over the user prompt text. Empty = no filter.
- **Entry**: prompt always visible (`line-clamp-3`); reply preview default
  `line-clamp-1`; expand chevron rotates 90° → `line-clamp-3` on the reply.
  Newest entry expanded by default; rest collapsed.
- **Per-entry copy** copies the prompt text only.
- **Sub-agents toggle**: footer checkbox, off by default. When on, sidechain
  prompts appear with a subtle `Bot` badge.
- **Load more**: cursor-paginated; 20 entries per page. Button disabled when
  `hasMore` is false.
- **Empty state**: "No prompts yet" / "No matches for …"

### 4.2 Micro-animations (framer-motion, gated on `useReducedMotion`)

| Surface | Animation | Spring |
|---|---|---|
| Popover open | Fade + 4px lift | `springs.popover` if exists, else default tween |
| Tab switch | Cross-fade content (200 ms) | tween |
| Entry list initial render | Stagger 25 ms per row, 8 px slide-up | `springs.listItem` if exists |
| Entry expand chevron | Rotate 0 → 90° | `springs.buttonPress` |
| Reply expand | `motion.div` `height: auto` | tween 180 ms |
| Search debounce | Skeleton row briefly while loading | n/a |

Under `prefers-reduced-motion: reduce`: all animations resolve instantly.

### 4.3 Icons (Lucide, matching existing app style)

| Element | Icon |
|---|---|
| Header trigger (unchanged) | `Quote` |
| Search input | `Search` |
| Expand reply | `ChevronRight` (rotates) |
| Copy prompt | `Copy` (matches existing copy pattern) |
| Sub-agent badge | `Bot` |
| Project-scope session group header | `MessageSquareText` |
| Loading | `Loader2` (animate-spin) |

## 5. API

### 5.1 New endpoint

```
GET /api/sessions/{name}/recall
    ?scope=session | project        (default: session)
    &q=<substring>                  (optional; case-insensitive on prompt text)
    &include_sidechains=true|false  (default: false)
    &before=<uuid>                  (optional cursor: last entry's uuid)
    &limit=<1..=100>                (default: 20)
```

**Response** (`Envelope<RecallResponse>`):

```jsonc
{
  "ok": true,
  "data": {
    "entries": [
      {
        "uuid": "42f93248-83ce-4270-b158-397c1922b665",
        "ts": 1748278675,
        "sessionId": "abf2f6fd-...",
        "sessionTitle": "Auth middleware refactor",  // optional
        "text": "refactor the auth middleware to use the new token shape",
        "reply": "Done — diff is on `feature/auth-refactor`.",  // optional
        "sidechain": false
      }
    ],
    "hasMore": true,
    "nextBefore": "42f93248-83ce-4270-b158-397c1922b665"
  }
}
```

`RecallEntry.text` capped at 8 000 chars (mirrors `LAST_SEND_TEXT_MAX_CHARS`).
`reply` capped at 600 chars (enough for the line-clamp-3 expansion).

### 5.2 Server module

New file `server/src/sessions/recall.rs`:

```
pub mod recall;

pub fn router_for(...) {
    .route("/api/sessions/{name}/recall", get(recall::handler))
}
```

Inside `recall.rs`:

- `pub async fn handler(State, Path(name), Query(RecallQuery))` →
  `Result<Json<Envelope<RecallResponse>>, AppError>`
- Looks up the session row (`db::sessions::get`) for `dir` + `cc_conversation_id`.
- Delegates the disk work to `tokio::task::spawn_blocking` (matches the
  resumable-list pattern in `sessions/mod.rs:1112`).
- Reuses `resumable::encode_project_dir()` and a new pub helper
  `resumable::project_dir_for()` (exposed for cross-module reuse).
- `scope=session`: opens exactly one file
  (`<project_dir>/<cc_conversation_id>.jsonl`).
- `scope=project`: globs `<project_dir>/*.jsonl`, sorts by mtime desc,
  walks files in order, accumulating entries until `limit` is reached
  (lazy — stops opening files once we have enough). Each file's entries
  carry its `sessionId` so the frontend can render session groupings.
- Per file: stream `BufReader::lines()` with the same substring-gate-then-
  serde pattern as `parse_transcript`. Walk forward to pair each user turn
  with the next assistant turn's first text block (the "reply preview").
  Reverse to newest-first at the end.
- Filter sidechain unless `include_sidechains=true`.
- Substring filter on prompt text when `q` is non-empty.
- Cursor: scan-then-skip-until-uuid; take next `limit`.

`RecallQuery` struct uses `#[serde(default)]` and a `default_limit() = 20`
helper, mirroring `PeekQuery`.

## 6. Frontend

### 6.1 Files touched (no new files)

- `web/src/components/focus-mode/last-send-recall.tsx` — extended:
  - New types: `RecallEntry`, `RecallResponse`, `RecallScope`.
  - New hook: `useRecall(name, scope, q, includeSidechains)` using
    `useInfiniteQuery`.
  - `LastSendPopover` body replaced by `<RecallPanel/>` (internal subcomponent
    in the same file, ~120 LOC).
  - `LastSendSheet` body replaced by the same `<RecallPanel/>` (mobile
    surface), so logic is shared.
  - `LastSendBar` unchanged.
- `web/src/lib/api.ts` (or `web/src/lib/api/sessions.ts`) — one new API call
  `sessionsApi.recall(name, query)`.

### 6.2 Component sketch

```tsx
function RecallPanel({ sessionName }: { sessionName: string }) {
  const [scope, setScope] = useState<RecallScope>('session')
  const [search, setSearch] = useState('')
  const [includeSidechains, setIncludeSidechains] = useState(false)
  const debouncedSearch = useDebouncedValue(search, 150)
  const { entries, hasMore, fetchNextPage, isFetching } =
    useRecall(sessionName, scope, debouncedSearch, includeSidechains)
  // ... Tabs + search input + scroll area + entries + footer
}
```

`RecallEntry` is its own internal component: handles its own expanded state
(default `true` for the first item, `false` for the rest), copy handler, etc.

### 6.3 Reuse

| Need | Source |
|---|---|
| Relative-time format | `formatRecallTime` (already in this file) |
| Copy with toast | existing copy pattern at L104–108 (already in this file) |
| Empty state styling | match `session-picker-sheet.tsx` "no sessions" block |
| Tab styling | `ui/tabs.tsx` (Radix) |
| Spring presets | `lib/springs.ts` |

## 7. Edge cases

| Case | Behavior |
|---|---|
| Session has no `cc_conversation_id` | Both tabs return empty; show empty state. |
| Transcript file gone (cleaned up) | Empty page, no error. Same fallback as `resumable.rs`. |
| Project dir has 0 files | Project tab empty; This-session tab also empty. |
| Very long prompt or reply | Server caps; frontend `line-clamp` handles overflow. |
| Search matches 0 entries on this page but matches on the next | Cursor walks the disk lazily — page may "look small" but `hasMore` remains true. Acceptable; matches typical search UX. |
| Sub-agent on, then off | Refetches with the toggle; list resets. |
| Tab switch mid-fetch | Cancel previous, refetch. TanStack handles this. |
| Concurrent recall fetches for two visible sessions | Distinct queryKeys; no contention. |
| Prompt contains ANSI escapes that slipped past `sanitise_prompt` | Server strips again via shared `ANSI_RE` before returning, defense in depth. |

## 8. Testing

### 8.1 Server (inline `#[cfg(test)] mod tests`)

- `read_user_turns` reads a one-file transcript and pairs prompts with the
  next assistant text.
- `read_user_turns` skips sidechain turns by default, includes them on flag.
- Cursor pagination: `before=<uuid>` skips until found, returns the next
  `limit`.
- Substring search is case-insensitive on prompt text only (not reply).
- Project scope: 3 JSONL files with different mtimes are walked newest-first,
  entries merged in chronological order per file.
- Missing project dir → empty list, no error.
- Missing transcript file (session has no `cc_conversation_id`) → empty.

### 8.2 Frontend

Manual + Playwright e2e (matches repo convention — no component unit tests).
Smoke scenario added to existing focus-mode e2e if it exists; otherwise
manual verification per acceptance criteria below.

## 9. Acceptance criteria

1. Open the recall icon in a session with several past prompts → popover
   opens with tabs, the first entry expanded showing prompt + reply preview.
2. Click chevron on a collapsed entry → reply expands inline.
3. Click copy → prompt text on clipboard; toast / icon flip confirms.
4. Switch to Project tab → entries from other session UUIDs in the same cwd
   appear, grouped by session with a small header.
5. Type in the search box → after ~150 ms the list filters to entries whose
   prompt contains the query (case-insensitive).
6. Toggle "Include sub-agents" → sidechain entries appear with a Bot badge.
7. Scroll to bottom and click "Load 20 more" → next page appended.
8. Reduced motion preference set → animations resolve instantly.
9. Mobile: same flow inside the Vaul bottom-sheet; drag-to-dismiss works.
10. No regressions on the existing `LastSendBar` auto-show or single-prompt
    behavior.

## 10. Out of scope (for the record)

- Server-side full-text index (substring is fast enough).
- Globally scoped search (project covers it).
- Tool-call / thinking-block rendering.
- Inline re-send (`copy` covers it).
