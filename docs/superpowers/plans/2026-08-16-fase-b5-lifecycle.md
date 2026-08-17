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

# Fase B5 — Lifecycle, notifications, and the consistency cleanup

*The last Track B fase. Master plan §15 + §16, ground-truthed against `origin/main` @ `a7cc52c`
(B0–B4 and A0–A5 all landed, plus holder resilience + auto-heal + the delegation fabric).*

---

## 0. Ground truth — read this first

The master plan's §15/§16 were written on 2026-08-13 against a `main` that did not yet have B0–B4, A2–A5, or the
holder auto-heal work. Roughly **half of what §15/§16 describe already exists**, and one of the two biggest pieces
(§15.4 notifications) exists **fully written and tested on an unmerged branch**. B5 is therefore mostly a
*harvest, rebase and consolidation* fase, not a build fase. This section is the audit that says which is which.

### 0.1 The audit table — §15/§16 assumptions vs. `main` @ `a7cc52c`

| § | The master plan assumes | Reality on `main` today | B5 delta |
|---|---|---|---|
| 15.1 | "`/clone` and `/duplicate` endpoints exist — unify + surface"; copy `desc/tags/provider/flags/mcp/auto_continue/schedules` into a fresh slug **+ new worktree**, named `<name> copy` | Both exist; **`clone` is a literal one-line alias of `duplicate`** (`lifecycle.rs:1766`) and is **unreachable from the web**. `duplicate` IS surfaced ("Clone agent in this directory", `session-info-panel.tsx:302`). It copies `dir, desc, provider, flags, auto_continue(+msg), rate_limit_resume_text, tags, creator, branch, worktree, worktree_repo, mcp, host_id, runtime`; resets `pinned/created_at/display_name`. It does **NOT** copy schedules (or any child row), does **NOT** create a new worktree (the columns are copied as metadata only — the copy lands in the *same directory*), and does not name it `<name> copy` (the caller supplies `new_name`). | delete the alias route, copy schedules, real worktree or honest copy, `<name> copy` default |
| 15.2 | Archive = "hide"; "archived sessions keep running schedules unless explicitly stopped — state this contract in the UI either way" | **True, and worse than implicit.** The scheduler has zero `archived` awareness (`grep archived server/src/scheduler/*.rs` → 0 hits); `enabled_with_next()` does not join `sessions`; `send_text_with_preview` checks `db::sessions::exists` (archive-blind) rather than the `exists_active` that exists beside it; and `lifecycle.rs:1185` **starts the session if it is not alive**. So an archived session is silently *resurrected* by its own schedule while staying invisible (`list` filters `archived = 0`). | this is a **bug fix + a stated contract**, not just copy |
| 15.3 | Delete honesty: enumerate what is/isn't removed, keep an undo window | **There is no user-facing Delete at all.** `DELETE /api/sessions/{name}` is referenced from exactly one place in `web/`: `lib/api/onboarding.ts:52` (demo cleanup). The destructive verbs users actually reach are **archive** (soft, fully reversible via `unarchive` — the undo already exists) and **purge** (Archived sheet only). And `delete` **orphans `schedules`** — that table has no FK (`0003_schedules.sql:7`) — so a deleted session's schedule keeps firing, fails `exists`, and **pushes an error to the phone every tick** (`runner.rs:130–141,257–262`). | respec §15.3 onto archive/purge; fix the orphan; the "undo window" is archive, named as such |
| 15.4 | Per-session notification opt-in, focus suppression, PWA badge, wired to the three tiers | **Exists, unmerged.** `origin/feat/grok-ui-integration` carries `server/src/notify.rs` (1040 lines), `server/tests/push_triggers.rs` (572), `0025_session_notif.sql`, `notif-policy-control.tsx`, `lib/push-bridge.ts`, `components/pwa/push-bridge.tsx`, `+197` lines of `push-sw.js`, and two unit suites. Every dependency it needs is on `main` today. | **Harvest + rebase**, renumber the migration, reconcile the tier vocabulary with B2's landed `use-attention.ts` |
| 15.5 | Graded, consequence-labelled recovery ladder — inline *and* canonical in Settings | The **automatic** layer is strong and landed: `native/holder.rs` supervision (`MAX_TASK_RESTARTS = 3`, exit markers), `auto_actions.rs:1147 auto_heal` with a 7-variant `Heal` outcome enum + 10-min cooldown + `recovery.auto_heal` pref, the `holder_died` → **"Terminal died"** badge (`activity-status.tsx:42,113`), `useTerminalGone`, and Claude-only Resume. The **manual ladder is entirely absent**: no `restart` route (clients compose stop+start), no manual recover-holder, no reset, **no UI or toggle for `recovery.auto_heal` anywhere in `web/src`** (0 hits), and every `Heal` outcome (`Cooldown`/`Unsupported`/`Disabled`) is a `tracing` line only. `/wake` and `/clone` are dead routes. | the whole manual ladder + surfacing the automatic one |
| 16.1 | "10 raw Vaul call sites"; zero `window.confirm()`; "three inline-confirm variants" | `ResponsiveSheet` exists and has **12 consumers**; raw Vaul is **8 sites, not 10** (`board-switcher.tsx` died with B2); `window.confirm` is **exactly 4** (matches); inline-confirm is **3 mechanisms across 6 call sites**, only 2 of them 4s-armed; **no shared `useArmedConfirm` hook exists**. Plus 3 Radix-`Dialog` confirms + 2 bespoke confirm sheets doing the same job. | see §0.6 |
| 16.2 | One empty/loading/error language; `EmptyStatePlaceholder` + `brand/copy.ts` | Both exist. `EmptyStatePlaceholder` has only **7 call sites in 4 files**; **22 hand-rolled empty states** remain; **7 distinct skeleton idioms**, no shared `<Skeleton>` primitive; `brand/copy.ts` has **only 14 importers** and several dead keys. **Board lanes are gone** — that master-plan example is stale. | see §0.6 |
| 16.3 | Teams: desktop team creation, `MemberStatusDot` merges into the mark `data-state`, teammate rows become the standard roster row | Desktop team creation **already exists** (3 paths, all *conversion* of an existing session) — that item is DONE. `MemberStatusDot` is still a parallel 4-state vocabulary used at 6 sites. Teammate rows are **3 bespoke implementations** against B2's `RosterRow`; the plan's `SessionIdentityRow` does not exist under that name. | see §0.6 |
| 16.4 | Toast/entity-chip/status vocabularies documented in `BRAND.md` | **Mostly done already.** `web/src/brand/BRAND.md` has §6 Toast, §6c.1 entity-chip navigation (B4), §6d shell/z-ladder (B1), §6e roster + the four-word attention vocabulary at line 452. | Add the **notification** vocabulary (tier × policy × push category) and the **lifecycle** vocabulary (what each destructive verb preserves) — the two that B5 introduces |

### 0.2 §15.4 — the notification work already exists, on a branch

This is the single most important finding for scoping B5.

`origin/feat/grok-ui-integration` is the original monolithic integration branch (321 files, +46k) that Track A and
Track B were carved out of. Most of it has since been superseded by the merged A0–A5/B0–B4 PRs — **except the
notification subsystem, which was never carved out**. What is on it:

```
server/migrations/0025_session_notif.sql              ALTER TABLE sessions ADD COLUMN notif TEXT NOT NULL DEFAULT 'inherit'
server/src/notify.rs                          NEW 1040 lines — NotifEvent, Tier, NotifPolicy, compose(), badge
server/src/push.rs                                 +204 — transport accepts a composed PushPayload
server/src/db/push.rs                              +102
server/tests/push_triggers.rs                 NEW  572 — trigger + suppression + copy-verbatim matrix
server/tests/push_debounce.rs                      -213 — DELETED (replaced by hook-anchored triggers)
web/public/push-sw.js                              +197 — tier-aware tag/renotify + app badge
web/src/lib/push-bridge.ts                    NEW   93 — pure "should this interrupt the user" rules
web/src/components/pwa/push-bridge.tsx        NEW  118 — the mount point
web/src/components/focus-mode/notif-policy-control.tsx  NEW 110 — the per-bot 4-state control
web/src/lib/api/push.ts / sessions.ts              +13 — NotifPolicy on the wire
web/tests/unit/push-bridge.test.ts            NEW  104
web/tests/unit/push-sw.test.ts                NEW  205
```

Its design is exactly §15.4 and it is *better specified* than the master-plan row: pushes become
**hook-anchored first-class events** (`notify_event` raised in `hooks::apply_payload`) instead of a side effect of
the status detector, with the stated consequence that only Claude/board/scheduler sessions push and codex/kimi/shell
do not. Its `Tier` enum (`Attention` > `Unread` > `Error` > `Schedule`) is the same vocabulary B2 shipped in the
roster. Its `NotifPolicy` (`inherit` / `all` / `attention` / `off`) is ANDed with the existing global category
prefs. `compose()` is a pure function so the copy is unit-assertable.

**Every dependency it needs is present on `main` today** (verified):

| `notify.rs` needs | on `main` at |
|---|---|
| `sessions::chat::store::{ChatTail, one_line_capped, TAIL_MAX_CHARS}` | `server/src/sessions/chat/store.rs:61,67,293` |
| `sessions::activity::PermissionAsk` + `permission_ask()` | `server/src/sessions/activity.rs:80,229` |
| `AppState::chat_store` / `chat_store_for` | `server/src/state.rs:669,679` |
| `AppState::subagents`, `pending_pushes` | `server/src/state.rs:984,350` |
| Hook arms `PermissionRequest`, `PostToolUseFailure`, `Stop`, `SubagentStop` | `server/src/hooks.rs:332,310,345,355` |
| `db::push::NotifCategory` + prefs | `server/src/db/push.rs:80–170` |

So B5's notification task is **rebase-and-reconcile, not build**. The reconciliation work is real, though, and is
where the risk lives (§5, R1).

### 0.3 What `main` already has for push (the plumbing §15.4 must respect)

Do not rebuild any of this; the harvest must land *on top of* it.

- **Transport**: `server/src/push.rs` — VAPID key generation/persistence (`vapid_private.key`, 0600),
  `PUSH_TTL_SECS = 4h`, an `AttemptLog` ring (`ATTEMPT_RING_CAP = 10`) surfaced in Settings as the
  "why didn't I get a notification?" answer, `send_push_for`, `send_one`, dead-endpoint pruning on 404/410.
  Routes at `router_for`: `GET key`, `POST subscribe`, `POST unsubscribe`, `POST test`, `GET/PUT prefs`,
  `GET attempts`.
- **Categories**: `server/src/db/push.rs:80` — `NotifCategory` = `AgentWaiting`, `AgentFinished`, `AgentStopped`,
  `ScheduleError`, `ScheduleFinished`. Prefs are KV rows read by `pref_enabled` (default = on).
- **Subscriptions**: `0012_push_subscriptions.sql` — one row per device keyed by endpoint; `send_push_for` fans out.
- **Trailing-coalesce debounce**: `server/src/sessions/auto_actions.rs:1653–1745`
  (`maybe_push_on_transition`). Cancels a prior pending send via `state.pending_pushes` abort handles,
  `T_DEFAULT = 2s`, `T_TEAM_FINISH = 15s` for `AgentFinished` on a team-tagged session, re-reads persisted status at
  expiry, and gates `AgentFinished` on `subagents == 0` (`push_should_fire`, unit-tested at `:1897–1903`).
  Covered by `server/tests/push_debounce.rs`.
- **Firing sites today**: `scheduler/runner.rs:142`, `scheduler/watch.rs:241,285`, `board/hook.rs:230`,
  `sessions/auto_actions.rs:1733`.
- **Service worker**: `web/public/push-sw.js` (120 lines) — already suppresses the banner when a same-origin window
  is focused/visible (§15.4's "suppressed while the app is focused" is **already done** for the banner), already
  does `tag`/`renotify`, already focuses-or-opens on `notificationclick`. **No `navigator.setAppBadge` anywhere in
  `web/` — the PWA badge is a genuine gap.**
- **Settings UI**: `web/src/routes/settings.tsx:428–730` — the per-category toggle list, the enable switch, the
  bypass-everything test push, and the recent-attempts table.

The branch **deletes `push_debounce.rs`** because hook anchors make the detector-side debounce moot. That deletion
is the sharpest edge in the harvest: `main` has since *grown* the debounce (team-finish window, subagent gating) and
those behaviours are load-bearing. See T4 and R1.

### 0.3b The four concrete reconciliation deltas (measured, not guessed)

These are the only places where the harvest and today's `main` actually conflict. Everything else in
`notify.rs` applies cleanly.

1. **`state.pending_pushes` is the same slot.** `notify_event` (`notify.rs:462`) does
   `pending_pushes.remove(session)` + `abort()` + `insert(...)` — *exactly* what
   `auto_actions::maybe_push_on_transition` (`:1653`) does. If both paths stay live they cancel each other's
   timers non-deterministically. **This is THE merge hazard of the fase** (R1): the fase must decide, in code and
   in a test, that there is one writer of that map.
2. **`send_push_for`'s signature changes** from `(state, cat, &title, &body, &url) -> usize` to
   `(state, category, &payload: &PushPayload, Some(session))`. All five existing call sites must be updated:
   `scheduler/runner.rs:142`, `scheduler/watch.rs:241,285`, `board/hook.rs:230`,
   `sessions/auto_actions.rs:1733`.
3. **`NotifCategory` gains `AgentError`, and `AgentFinished`'s DEFAULT flips from on to off**
   (`default_on()`, new on the branch: `!matches!(self, Self::AgentFinished)`). That is a user-visible reduction
   in notifications for anyone who has never touched the toggle — the branch's own comment says an explicit stored
   pref still wins. Needs **G2**. It also means `settings.tsx`'s category list grows a sixth row and
   `db::push::list_prefs`'s default changes.
4. **`SessionActivity` has no `notice` field on `main`.** `build_payload` (`notify.rs:514`) reads
   `act.notice.is_some()`; `main`'s struct (`state.rs:49–73`) has `activity`, `activity_kind`, `error`,
   `subagents`, `permission` and no `notice`. Either add the field (fed from the `Notification` hook arm, which
   `main` already parses at `status.rs:264`) or drop that term from the badge predicate. Small, but it will not
   compile until it is decided.

Everything else the harvest touches in `push.rs` is **purely additive** (`get_preview`, `tier_for_category`,
`mute_reason`, `send_encoded`) — it layers on the existing transport rather than replacing it. And the hook arms it
anchors to all exist on `main` today: `permission_request` (`hooks.rs:332`), `post_tool_failure` (`:310`),
`stop` (`:345`), `subagent_stop` (`:355`), `session_end` (`:384`), `stop_failure` (`:397`).

**The harvest even names T9 as its own upgrade point.** `deliver()`'s server-side unread-suppression comment reads:
*"UPGRADE POINT: when the cross-device seen-cursor (`PATCH /api/sessions/{name}/seen`) ships, 'viewed within 30 s'
replaces this WS proxy."* v1 suppression uses "a chat store is attached" as the proxy. That is the exact seam T9
plugs into, which is why T9 is sequenced after T4 and not before it.

### 0.4 Migration numbering

`main`'s highest applied is **`0027_session_mark_pin.sql`** (B2). `0026_audit_target_idx.sql` is merged.
**`0025` is still an unfilled gap and stays that way** — `0025_session_notif.sql` (integration branch) and
`0025_archive_on_stop.sql` (`feat/schedule-archive-on-stop`, `worktree-on-demand-spawn`) both claim it, and filling
a gap *below* an already-applied version makes a deployed install's migration state ambiguous. B2 already set this
precedent in `0027`'s header comment; B5 follows it.

**B5's migrations take the next free numbers after the highest applied at land time.** Today that is `0028` and
`0029`. Task 0 re-verifies across every branch (`git branch -r` + `git ls-tree`) before writing a file, because
another fase may land first.

- `0028_session_notif.sql` — the harvested per-session `notif` column, **renumbered** from `0025`, comment text
  preserved and a numbering note appended.
- `0029_session_seen.sql` — only if G3 says yes to cross-device seen cursors (T9).

**Never edit or renumber a merged migration.** `sqlx` checksums them; a `VersionMismatch` bricks deployed installs.

### 0.5 Facts the tasks depend on

- Both `POST /api/sessions/{name}/duplicate` (`sessions/mod.rs:75`) and `POST /api/sessions/{name}/clone`
  (`:120`) exist as separate routes. `PATCH /api/sessions/{name}/config` (`:76`) is the write path the
  per-session `notif` policy rides.
- Lifecycle routes already on `main`: `start`, `stop`, `wake`, `resume`, `mode`, `archive`, `unarchive`, `purge`,
  plus `DELETE`. Existing tests: `server/tests/lifecycle.rs`, `archive_recover.rs`, `archive_removes.rs`,
  `resume_picker.rs`.
- `web/src/brand/copy.ts` and `web/src/brand/BRAND.md` exist; `BRAND.md` already carries the attention vocabulary
  (line 452), the toast section (§6), the entity-chip vocabulary (§6c.1) and the shell/z-ladder (§6d).
- Test surfaces: `web/tests/unit` (71 files, `bun test tests/unit`), `web/tests/e2e/{smoke,mobile,screens}`
  (Playwright), `server/tests` (44 files). There is **no dedicated VR snapshot suite** — "VR" in this repo means
  Playwright screenshots of a `/dev-*` route (`web/src/routes/dev-{roster,shell,teams,tiles,marks,focus,...}.tsx`)
  captured in both themes and eyeballed. B5 adds bench states to the existing dev routes rather than a new harness.
- Relevant existing hooks: `use-attention.ts`, `use-terminal-gone.ts`, `use-session-actions.ts`,
  `use-archived-sessions.ts`, `use-push.ts`, `use-update-badge.ts`.

### 0.6 The §16 consolidation inventory (measured on `a7cc52c`)

The master plan's §16 counts are from 2026-08-13 and three of them are now wrong. These are the real ones.
Paths are relative to `web/src/`.

**Modal shells — five systems coexist.**

| system | sites |
|---|---|
| `ResponsiveSheet` (`components/ui/responsive-sheet.tsx:58`) — coarse-pointer forks to Vaul, else shadcn `Sheet side="right"` | 14 usages in 12 files (claude-tools, session-info-panel, schedule-detail ×2, session-schedules, new-session, start-team, hosts ×2, updates ×2, snippets-manager, resume-picker) |
| `ShellOverlay` (`components/shell/shell-overlay.tsx:58`) — B1's desktop overlay, wraps `ResponsiveSheet` on mobile | first consumer is **`archived-sheet.tsx:75`, not the Attention card** (the file says so at `:20–24`); second is `issues/issue-surface.tsx:98` (`variant="pane"`) |
| **raw Vaul** `Drawer.Root` | **8**: `focus-mode/last-send-recall.tsx:770`, `focus-mode/mobile-action-sheet.tsx:46`, `focus-mode/session-picker-sheet.tsx:62`, `pwa/a2hs-sheet.tsx:102`, `session-tile/overview-display-menu.tsx:82`, **`session-tile/quick-peek-modal.tsx:120`**, `session/session-picker.tsx:246`, `snippets/snippet-editor.tsx:38` |
| Radix `Dialog`/`Sheet` (no `AlertDialog` in the repo) | `command-palette.tsx:473`, `schedule-detail-sheet.tsx:248` (delete confirm), `routes/files.tsx:367` (delete confirm), `routes/settings.tsx:211,223` (regen-token confirm), `session-tile/tile-error.tsx:64`, and `focus-mode/desktop-compose-panel.tsx:103–215` which bypasses `ui/dialog.tsx` and uses `DialogPrimitive.*` raw |
| bespoke fixed/absolute overlays | `chat/attention-card.tsx:344/452` (in-pane, hand-rolled Tab trap ~410–439), `focus-mode/mobile-compose-sheet.tsx:873–960` ("Discard changes?"), `focus-mode/mobile-sheet.tsx`, `connection/connection-overlay.tsx:122`, `team/teammate-focus.tsx:59`, `onboarding/tour-overlay.tsx:67`, `onboarding/floating-tip.tsx:164`, `session-tile/tile.tsx:1076` |

**Quick-peek** (`session-tile/quick-peek-modal.tsx:44`) is raw Vaul: `Drawer.Root:120`, own overlay/content
(`h-[78vh] z-50`), hand-rolled drag handle at `:125`, own `Drawer.Title/Description`. Opened **only** by long-press
(`session-tile/tile.tsx:414–416`, state `:253`, render `:1115–1118`, coarse-pointer-gated `:768`). It renders
`StartTeamSheet` and `SessionInfoPanel` **outside** `Drawer.Portal` — a nesting hazard the migration must preserve
or fix deliberately.

**The confirm asymmetry — the actual §16.1 problem.** The same class of destructive action is guarded three
different ways today:

- `window.confirm` (4): `hooks/use-session-actions.ts:66` (kill session / `killTeamLeadConfirm`),
  `hooks/use-session-actions.ts:91` (archive a running session — an inline string, *not* in `brand/copy.ts`),
  `routes/focus/desktop.tsx:125` (stop from focus — **a duplicate of the hook's logic, not routed through it**),
  `claude-tools/claude-tools-sheet.tsx:482` (switch to Bypass).
- Radix `Dialog` (3): delete schedule, delete file, regenerate token.
- Bespoke sheet (2): mobile compose "Discard changes?", plus the tile busy scrim.

**Inline-confirm — 3 mechanisms, 6 call sites, no shared hook** (`useArmedConfirm` has zero hits repo-wide):

| variant | mechanism | sites |
|---|---|---|
| A | 4 s timer + icon→confirm/cancel morph | `session-tile/tile.tsx:513–543` render `:894–925` (archive tile) |
| B | 4 s timer, same button, label/colour change | `settings/hosts-section.tsx:260–266` (delete host) — **timer never cleared on unmount, latent setState-after-unmount** |
| C | **untimed** morph into a `Cancel / <verb>` pair | `archived/archived-sheet.tsx:128` (purge all), `archived/archived-sheet.tsx:235` (delete one forever), `team/kill-teammate-button.tsx:57`, `claude-tools/claude-tools-sheet.tsx:848` (remove MCP server) |

Also inconsistent: `team/team-card.tsx:190–196` dismisses a team with **no confirm at all**, sitting directly
above a `KillTeammateButton` that uses variant C.

**Empty/loading.** `components/empty-state.tsx:32` is used at only 7 sites in 4 files
(`routes/overview.tsx:741,749,758,767`, `routes/files.tsx:313`, `issues/issue-list.tsx:70,85`,
`settings/audit-log.tsx:117`). **22 surfaces hand-roll one** (archived, claude-tools ×3, issue-detail ×2, team-card,
focus-strip-section, last-send-recall, session-info-panel, session-picker-sheet ×2, schedule-detail-sheet,
session-schedules-sheet, snippet-panel ×2, snippets-manager, hosts-section, schedules-section, resume-picker,
host-picker, entity-picker, command-palette, routes/settings.tsx:735). **7 skeleton idioms**:
`session-tile/tile-skeleton.tsx:6` (the only exported one), local `Skeleton()` in `settings/audit-log.tsx:52`,
`RunsSkeleton` in `schedule-detail-sheet.tsx:300`, `ListSkeleton` in `routes/files.tsx:432`, inline `LoadingRows`
in `claude-tools-sheet.tsx:604`, four separate inline `animate-pulse` blocks, and two *shimmer* variants
(`mobile-compose-sheet.tsx:526`, `status-banner/reconnect-banner.tsx:104`).
`brand/copy.ts` exports 11 groups but has **only 14 importers**; `CONNECTION` has zero, and
`CONFIRM.deleteIssue/discardEdits/overwriteFile` + `ERROR.generic/network/notFound/unauthorized/fileTooLarge` +
`EMPTY.sessions/files/search` are dead keys whose surfaces inline their own strings.
It is CI-gated by `scripts/lint-microcopy.sh` — that gate is the lever for T7.

**Teams.** Desktop team creation is **already reachable** (three paths, all *converting an existing session*:
`routes/focus/desktop.tsx:156→174` via `focus-header.tsx:220–234`, `terminal/stopped-session.tsx:272–280`, and the
long-press peek at `quick-peek-modal.tsx:156` — all mounting `StartTeamSheet`, itself already a `ResponsiveSheet`).
**That §16.3 item is DONE; do not re-do it.** What is genuinely open: `team/member-status-dot.tsx:34` encodes 4
states (`working`/`needs_you`/`idle`/`offline`) in a vocabulary parallel to `session-tile/status-dot.tsx`, used at 6
sites; and teammate rows are **3 bespoke implementations** (`team/teammate-chip.tsx:40–110`,
`team/teammate-card.tsx:31`, `focus-mode/team-strip-group.tsx:211`) that share nothing with B2's
`chat/ui/roster-row.tsx:109` (`RosterRow`, densities `list`/`strip`/`picker`) or `roster/session-face.tsx:60`
(`SessionFace`) — no mark, no fact ladder. There are also **three separate team roll-up headers**
(`team/team-rollup-badges.tsx:18`, `focus-mode/team-strip-group.tsx:128`, `focus-mode/session-picker-sheet.tsx:144`).
Team boards already read through `IssueSurface` in a `ShellOverlay variant="pane"` (`team/team-card.tsx:152`), so
that half of §16.3 is done too.

### 0.7 Seen cursors — what B2 landed and what the `PATCH /seen` delta actually is

B2's attention model is **entirely client-side and pure**. The server computes no tier.

- `web/src/lib/attention-tiers.ts:48` — `TIERS = ['needs', 'unread', 'working', 'quiet']`. `tierFor()` at `:117`,
  `needsYou()` at `:104`, `unreadCount()` at `:150`, `rollup()` at `:197`, `cursorFor()` at `:230`.
- **The cursor store**: `web/src/hooks/use-attention.ts:36` — `STORAGE_KEY = 'supermux:seen'`, **one key holding
  the whole map** (`Record<sessionName, SeenCursor>`, `:41`). `readSeen()` `:43`, `writeSeen()` `:69`,
  `markRead()` `:135`, `markUnread()` `:144`, roster-prune `:112–133`.
- **Cursor shape** (`attention-tiers.ts:52–62`): `{ ts: number; count?: number; epoch?: number }` — `ts` is
  server-clock ms, `count` is `chat_tail.entry_count` at that moment, `epoch` is the chat-store epoch it was
  recorded under. `unreadCount()` returns `null` (render a dot, not a number) unless both epochs match.
- **`entry_count` provenance**: `server/src/sessions/chat/store.rs:89` (`entry_count = g.next_seq`, a *seq* domain
  that survives `reset()`), `:94 last_entry_ts`, `:98 epoch`; emitted onto the SSE `sessions` delta at exactly one
  site, `server/src/sessions/auto_actions.rs:858,901–908`.
- Written from only two places — `routes/focus/desktop.tsx:78` and `routes/focus/mobile.tsx:203` — plus
  `markUnread` from the tile kebab (`session-tile/group-grid.tsx:2140`).
- Rollup rendered at `routes/overview.tsx:621` via `components/roster/attention-rollup.tsx:75` (copy:
  `needs you: {N}`).
- Kill switch: `web/src/lib/attention-flag.ts:20` (`supermux:attention`, default on).

**Server-side seen persistence: definitively none.** No `seen_at` column, no `/seen` route, and `prefs.rs:76`'s
allowlist (`overview_layout | quick_keys | session_renderer | recovery.auto_heal`) is closed — seen state is not a
pref and cannot ride one. `use-attention.ts:9–14` already says in a comment that
`PATCH /api/sessions/{name}/seen` **is deferred to B5**.

So the T4 delta is narrow and well-defined: a `seen_ts`/`seen_count`/`seen_epoch` triple on `sessions`, a
`PATCH /sessions/{name}/seen` write, the cursor merged newest-wins with localStorage (localStorage stays as the
offline/optimistic layer — it is not deleted), and the harvested `deliver()`'s "a chat store is attached" proxy
replaced by "viewed within 30 s" (§0.3b).

**Naming hazard for whoever executes this:** there are two unrelated `attention` modules —
`web/src/lib/attention-tiers.ts` (B2 roster tiers) and `web/src/components/chat/attention.ts` (A4 renderer-honesty
copy: `AttentionCause`, `topAttention`). `BRAND.md:463` documents the split. Do not merge them.

---

## 1. Files

```
── notifications (T1–T3) ────────────────────────────────────────────────────
server/migrations/0028_session_notif.sql   NEW — harvested from 0025, RENUMBERED (§0.4)
server/src/notify.rs                       NEW — harvested (1040 lines), rebased on today's state.rs
server/src/lib.rs                          + mod notify
server/src/push.rs                         additive: get_preview, tier_for_category, mute_reason,
                                           send_encoded; send_push_for takes a PushPayload
server/src/db/push.rs                      + AgentError variant, + default_on(), ALL 5→6
server/src/db/sessions.rs                  + notif column read/write; duplicate() copies it
server/src/hooks.rs                        raise notify_event at permission_request / post_tool_failure /
                                           stop / stop_failure / session_end
server/src/state.rs                        + SessionActivity.notice (or drop the term — §0.3b #4)
server/src/sessions/auto_actions.rs        T2: one writer of pending_pushes; call-site signature update
server/src/scheduler/runner.rs             call-site signature update (:142)
server/src/scheduler/watch.rs              call-site signature update (:241, :285)
server/src/board/hook.rs                   call-site signature update (:230)
server/tests/push_triggers.rs              NEW — harvested (572 lines)
server/tests/push_debounce.rs              KEPT and extended — NOT deleted (R1)
server/tests/notify_one_writer.rs          NEW — T2's contract test

web/public/push-sw.js                      + tier-aware tag/renotify + navigator.setAppBadge
web/src/lib/push-bridge.ts                 NEW — harvested (pure rules)
web/src/components/pwa/push-bridge.tsx     NEW — harvested (mount point)
web/src/components/focus-mode/notif-policy-control.tsx  NEW — harvested (4-state per-bot control)
web/src/components/focus-mode/session-info-panel.tsx    + the policy control row
web/src/lib/api/sessions.ts                + NotifPolicy on the wire
web/src/lib/api/push.ts                    + preview / mute-reason
web/src/routes/settings.tsx                + the 6th category row; default-off note
web/tests/unit/push-bridge.test.ts         NEW — harvested
web/tests/unit/push-sw.test.ts             NEW — harvested
web/tests/unit/notif-policy.test.tsx       NEW

── cross-device seen (T4, needs G3) ─────────────────────────────────────────
server/migrations/0029_session_seen.sql    NEW — seen_ts / seen_count / seen_epoch
server/src/sessions/mod.rs                 + PATCH /api/sessions/{name}/seen
server/src/db/sessions.rs                  + set_seen / seen columns on the row
server/src/notify.rs                       deliver(): "viewed within 30s" replaces the chat-store proxy
server/tests/seen_cursor.rs                NEW — auth scoping + monotonicity + 404
web/src/hooks/use-attention.ts             merge server cursor newest-wins with localStorage
web/src/lib/api/sessions.ts                + markSeen
web/tests/unit/seen-cursor-merge.test.ts   NEW

── lifecycle (T5–T8) ────────────────────────────────────────────────────────
server/src/db/schedules.rs                 archive-aware tick; orphan cleanup on delete
server/src/scheduler/runner.rs             the archived-session guard (T5)
server/src/sessions/lifecycle.rs           send_text_with_preview: exists → exists_active (T5);
                                           archive/unarchive contract; restart(); recover_holder(); reset()
server/src/sessions/mod.rs                 delete(): schedule disposition; + /restart, /recover, /reset;
                                           DELETE the /clone alias route; decide /wake
server/src/db/sessions.rs                  duplicate(): copy schedules + mark_pin; `<name> copy` default
server/src/sessions/auto_actions.rs        surface Heal outcomes on the delta (T8)
server/src/db/prefs.rs                     (verify) recovery.auto_heal reachable from the UI
server/tests/archive_schedule_contract.rs  NEW — T5's regression
server/tests/delete_disposition.rs         NEW — T7's enumeration, asserted
server/tests/recovery_ladder.rs            NEW — T8, incl. auth scoping on the 3 new routes
server/tests/lifecycle.rs                  extended (duplicate copies schedules)

web/src/hooks/use-session-actions.ts       zero window.confirm; restart/recover/reset
web/src/hooks/use-recovery.ts              NEW — the ladder's client half
web/src/components/recovery/recovery-ladder.tsx  NEW — inline least-destructive + canonical list
web/src/components/session-tile/activity-status.tsx   ErrorBadge gains the inline action
web/src/routes/settings.tsx                + Recovery section (ladder + auto-heal toggle)
web/src/components/focus-mode/use-clone-session.ts    honest copy semantics + `<name> copy`
web/src/components/archived/archived-sheet.tsx        purge honesty + the armed idiom
web/tests/unit/recovery-ladder.test.tsx    NEW
web/tests/unit/delete-honesty.test.tsx     NEW
web/tests/e2e/smoke/recovery-ladder.spec.ts NEW

── consolidation (T9–T12) ───────────────────────────────────────────────────
web/src/hooks/use-armed-confirm.ts         NEW — the ONE 4s-armed idiom (replaces 3 mechanisms / 6 sites)
web/src/components/ui/armed-button.tsx     NEW — its render half
web/src/components/session-tile/tile.tsx              variant A → the hook
web/src/components/settings/hosts-section.tsx         variant B → the hook (fixes the unmount leak)
web/src/components/archived/archived-sheet.tsx        variant C ×2 → the hook
web/src/components/team/kill-teammate-button.tsx      variant C → the hook
web/src/components/claude-tools/claude-tools-sheet.tsx variant C + the bypass confirm
web/src/routes/focus/desktop.tsx           confirm dedup — route through use-session-actions
web/src/components/session-tile/quick-peek-modal.tsx  raw Vaul → ResponsiveSheet (portal nesting!)
web/src/components/focus-mode/{last-send-recall,mobile-action-sheet,session-picker-sheet}.tsx  → ResponsiveSheet
web/src/components/session-tile/overview-display-menu.tsx  → ResponsiveSheet
web/src/components/session/session-picker.tsx         → ResponsiveSheet
web/src/components/snippets/snippet-editor.tsx        → ResponsiveSheet
web/src/components/pwa/a2hs-sheet.tsx                 (keep raw — modal={false}, document why)
web/src/components/focus-mode/desktop-compose-panel.tsx  DialogPrimitive.* → ui/dialog.tsx
web/src/components/ui/skeleton.tsx         NEW — the ONE skeleton primitive (7 idioms collapse in)
web/src/components/empty-state.tsx         (unchanged) — 22 hand-rolled sites migrate to it
web/src/brand/copy.ts                      the sweep: dead keys removed, inline strings folded in
scripts/lint-microcopy.sh                  + a gate for raw window.confirm and inline empty-state strings
web/src/components/team/teammate-chip.tsx  → RosterRow density="list"
web/src/components/team/teammate-card.tsx  → RosterRow
web/src/components/focus-mode/team-strip-group.tsx  → RosterRow density="strip"
web/src/components/team/member-status-dot.tsx  → mapped onto SessionFace / mark data-state
web/src/components/team/team-card.tsx      dismiss gets the armed idiom
web/tests/unit/armed-confirm.test.tsx      NEW
web/tests/unit/sheet-inventory.test.ts     NEW — the "no raw Vaul outside the allowlist" guard
web/tests/unit/teammate-row.test.tsx       NEW

── the record (T13) ─────────────────────────────────────────────────────────
web/src/brand/BRAND.md                     + §6f notification vocabulary, + §6g lifecycle vocabulary
web/src/routes/dev-roster.tsx              bench states for the ladder + armed confirm (VR)
web/src/routes/dev-shell.tsx               bench states for the migrated sheets (VR)
```

---

## 2. Global constraints

- **Worktree, never the main checkout.** Other agents build in `/opt/projects/supermux` — no commits, branches or
  stashes there.
- **Never `cargo build/test --release`.** Debug only; in-sandbox needs `OPENSSL_NO_VENDOR=1
  OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu`.
- **Never edit an existing `server/migrations/*` file**, and never fill the `0025` gap (§0.4).
- **Never restart the instance on :8824** — it hosts the owner's chat. Live testing happens side-by-side on
  another port.
- **The user reviews all merges.** The final task opens a PR and hands off. Never auto-merge, never deploy.
- **No removal without its replacement in the same PR** (Track B risk row). Every `window.confirm()` deleted in
  T6 is replaced in the same commit.
- **Additive wire.** New columns are nullable or defaulted; new endpoints are new routes; every existing test
  passes unmodified except where a struct literal gains a field.
- **Push copy is asserted verbatim.** `compose()` stays pure; a copy change is a test change.

## 3. Owner gates

- **G1 — the harvest base (blocks T1).** The §15.4 notification subsystem lives on an unmerged 321-file branch
  (`origin/feat/grok-ui-integration`). The owner decides whether B5 cherry-picks the ~13 notification files onto a
  fresh branch off `main` (**recommended** — it keeps the PR reviewable as one idea, and the rest of that branch
  has already been superseded by the merged A0–A5/B0–B4 PRs) or merges the branch and reverts the rest.
- **G2 — the push-model inversion + the default flip (blocks T2, T3.4).** Two coupled behaviour changes the owner
  must accept explicitly, because both make the user's phone quieter and neither is discoverable:
  (a) hook-anchored push means **codex / kimi / shell sessions stop pushing** (their roster tier still works — the
  phone just stays silent); (b) `agent_finished` ships **default off** (`default_on()`), so anyone who has never
  touched the toggle stops getting "turn done" pings. An explicit stored pref still wins in both cases.
  T2.2's fallback design is the escape hatch if the owner rejects (a).
- **G3 — cross-device seen cursors (blocks T4).** `PATCH /sessions/{name}/seen` + migration `0029` is marked
  optional in the master plan ("if wanted"). It is also the thing that upgrades the harvest's unread-suppression
  proxy from "a chat WS is attached" to "actually seen" (§0.3b), so a *no* leaves that proxy in place rather than
  leaving a hole. The owner says yes/no before T4 starts.
- **G4 — the archive-schedule contract (blocks T5.2).** T5 found a real bug, and fixing it forces a product
  decision between "archiving disables schedules" and "an archived session that fires unarchives itself". The
  owner picks. Do not pick for them — both are defensible and the master plan only says the contract must be
  *stated*.

---

## 4. Tasks

Fifteen entries: **T0** is setup, **T1–T13** are the work, **T14** is the hand-off. TDD wherever there is anything
to assert. Every task ends green on `cargo test` (debug), `bun run test:unit`, `bun run lint` and
`bash scripts/lint-microcopy.sh`.

**Ordering rule:** T2 lands before T3 (the client half must not ship against a server that double-fires), and T4
lands after T2 (it replaces a suppression proxy T2 installs). T5–T8 are independent of T1–T4 and may run in
parallel. T9–T12 are independent of everything and are the natural place to split the PR if the owner wants two.

### T0 — Base, worktree, gates, migration re-verify

**Files:** none (setup only)

- [x] **T0.1** Clear **G1**, **G2**, **G3**, **G4** in writing. Record the answers at the top of the PR body.
- [x] **T0.2** Create the worktree (never the main checkout — other agents build there):
  ```bash
  cd /opt/projects/supermux && git fetch origin
  git worktree add /opt/projects/supermux-b5 -b feat/b5-lifecycle origin/main
  cd /opt/projects/supermux-b5 && git log --oneline -1   # expect a7cc52c or later
  ```
- [x] **T0.3** Prove `main` is green *before* adding anything. Anything red here is pre-existing and must be
      reported, not silently fixed inside a B5 task.
  ```bash
  OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server
  cd web && bun run test:unit && bun run lint && cd .. && bash scripts/lint-microcopy.sh
  ```
- [x] **T0.4** Re-verify the migration claim at execution time — the numbers in §0.4 are from 2026-08-16 and
      another fase may have landed since:
  ```bash
  for b in $(git branch -r | grep -v HEAD); do
    git ls-tree --name-only $b server/migrations/ | grep -E '00(2[5-9]|[3-9][0-9])' | sed "s|^|$b |"
  done | sort -k2
  ```
      Record the highest number seen. B5's migrations take the next free numbers **after the highest applied on
      `main`**; the `0025` gap stays unfilled.
- [ ] **T0.5** Stand up a side-by-side instance on a spare port for the live checks in T3/T8/T14.
      **Never restart :8824.**

**Verification:** worktree on `feat/b5-lifecycle`, all four suites green, four gates answered in the PR draft.

---

### T1 — Harvest the notification subsystem (server half)

The §15.4 work already exists on `origin/feat/grok-ui-integration` (§0.2). This task moves it, it does not rewrite
it. Cherry-pick the files, then fix exactly the four deltas in §0.3b.

**Files:** `server/src/notify.rs`, `server/src/lib.rs`, `server/src/push.rs`, `server/src/db/push.rs`,
`server/src/db/sessions.rs`, `server/src/state.rs`, `server/src/hooks.rs`,
`server/migrations/0028_session_notif.sql`, `server/tests/push_triggers.rs`

- [x] **T1.1** Extract the branch's notification files without dragging the other 300:
  ```bash
  B=origin/feat/grok-ui-integration
  git checkout $B -- server/src/notify.rs server/tests/push_triggers.rs
  git show $B:server/migrations/0025_session_notif.sql > server/migrations/0028_session_notif.sql
  git diff $(git merge-base origin/main $B) $B -- server/src/push.rs server/src/db/push.rs > /tmp/push.patch
  ```
      Apply the `push.rs`/`db/push.rs` diffs **by hand** — they were written against an older `push.rs` and the
      hunks around `send_push_for` will not apply cleanly.
- [x] **T1.2** Append a numbering note to `0028_session_notif.sql`'s header comment, in the style of
      `0027_session_mark_pin.sql`: renumbered from `0025`, why the gap stays.
- [x] **T1.3** Resolve §0.3b delta #4: either add `notice: Option<String>` to `SessionActivity`
      (`state.rs:49–73`), fed from the `Notification` hook arm that `status.rs:264` already parses, or drop the
      `act.notice.is_some()` term from `build_payload`'s badge predicate. **Write down which and why** — it
      changes whether an agent notice counts toward the home-screen badge.
- [x] **T1.4** Resolve §0.3b delta #2: update all five `send_push_for` call sites
      (`scheduler/runner.rs:142`, `scheduler/watch.rs:241,285`, `board/hook.rs:230`,
      `sessions/auto_actions.rs:1733`) to the `PushPayload` signature.
- [x] **T1.5** Raise `notify_event` at the hook arms in `hooks::apply_payload`: `permission_request` (`:332`),
      `post_tool_failure` (`:310`), `stop` (`:345`), `stop_failure` (`:397`), `session_end` (`:384`).
- [x] **T1.6** `db::sessions::duplicate()` copies the new `notif` column (the branch's migration comment claims
      this is free — verify it, because the column list at `db/sessions.rs:348–358` is explicit, not `SELECT *`).

**Verification:** `cargo test -p supermux-server push_triggers` green with the harvested 572-line matrix;
`cargo test -p supermux-server push_debounce` **still green, unmodified**; `cargo check --all-targets` clean;
the migration file is `0028` and no existing migration file has been touched
(`git diff --name-only origin/main -- server/migrations/` shows exactly one added path).

---

### T2 — One writer of `pending_pushes` (**the riskiest task in the fase**)

`notify_event` (`notify.rs:462`) and `auto_actions::maybe_push_on_transition` (`:1653`) both do
`pending_pushes.remove(name).abort()` + `insert(...)` on the **same** `DashMap`. Left as-is they cancel each
other's timers non-deterministically, and the failure is silent — a dropped push looks exactly like a muted one.
Nothing in either language errors. This is the merge hazard of B5 (R1).

The harvest's answer was to delete `push_debounce.rs` and the detector path entirely. **That is not acceptable
here**: `main` has since grown two load-bearing behaviours that live in the detector path and have no equivalent
in `notify.rs` — the 15 s `T_TEAM_FINISH` window for a team lead bouncing through Idle, and the
`push_should_fire` subagent gate that stops a multi-agent turn crying "finished" between dispatches
(`auto_actions.rs:1640–1650`, unit-tested at `:1897–1903`).

**Files:** `server/src/sessions/auto_actions.rs`, `server/src/notify.rs`, `server/src/state.rs`,
`server/tests/notify_one_writer.rs` (new), `server/tests/push_debounce.rs` (extended)

- [x] **T2.1** Write the failing test first (`notify_one_writer.rs`): drive a `Stop` hook and a detector
      `Idle` transition for the same session within the quiet window and assert **exactly one** push is
      delivered, for a deterministic category, with a deterministic body. Then the same for
      `Stop` → `PermissionRequest` 200 ms later (expect the dialog's banner, not two).
- [x] **T2.2** Make the hook path the **only** writer of `pending_pushes`, and reduce the detector path to a
      *fallback for providers that do not emit hooks*. Concretely: `maybe_push_on_transition` returns early when
      the session's provider is hook-capable (Claude / board / scheduler); it stays live for
      codex / kimi / shell. Gate the whole choice on **G2** — this is exactly the coverage reduction the owner
      must sign off.
- [x] **T2.3** Move `T_TEAM_FINISH` and `push_should_fire`'s subagent gate **into** the hook path so they are not
      lost with the fallback. `NotifEvent::TurnFinished` must respect both.
- [x] **T2.4** Add a debug assertion / test that the map has one logical owner per session at a time, so a future
      third writer fails loudly instead of silently.

**Verification:** `notify_one_writer.rs` green; **`push_debounce.rs` green with its existing assertions plus new
ones for the hook path** — the union of both files, never one replacing the other; a manual two-terminal check on
the T0.5 instance: a real Claude turn ending produces exactly one banner, and a team lead dispatching three
teammates produces exactly one "finished" after it settles.

---

### T3 — The notification client half: per-session policy, badge, in-app bridge

**Files:** `web/public/push-sw.js`, `web/src/lib/push-bridge.ts`, `web/src/components/pwa/push-bridge.tsx`,
`web/src/components/focus-mode/notif-policy-control.tsx`,
`web/src/components/focus-mode/session-info-panel.tsx`, `web/src/lib/api/{sessions,push}.ts`,
`web/src/routes/settings.tsx`, `web/tests/unit/{push-bridge,push-sw,notif-policy}.test.*`

- [x] **T3.1** Harvest `push-bridge.ts`, `push-bridge.tsx`, `notif-policy-control.tsx` and the two unit suites
      from the branch. They are self-contained and depend on nothing B0–B4 changed.
- [x] **T3.2** Merge the branch's `push-sw.js` additions into today's 120-line file **without losing what is
      already there** — the focused-window banner suppression (`:53–61`), the `tag`/`renotify` pair (`:46–47`)
      and the focus-or-open `notificationclick` handler (`:85`) all stay. What is genuinely new:
      **`navigator.setAppBadge` / `clearAppBadge`** (zero occurrences in `web/` today) and tier-aware
      `tag`/`renotify`.
- [x] **T3.3** Mount `NotifPolicyControl` in `session-info-panel.tsx` (the per-session settings section at
      `:244`), writing through the existing `PATCH /api/sessions/{name}/config`.
- [x] **T3.4** `settings.tsx`: add the sixth category row (`agent_error`) and state the new default in the hint —
      `agent_finished` now ships **off** (§0.3b #3, gated on G2). An explicit stored pref still wins; say so in
      the copy.
- [x] **T3.5** Reconcile the tier vocabularies (R2): the server `Tier` (`attention|unread|error|schedule`) and
      B2's client `TIERS` (`needs|unread|working|quiet`) are **different sets with one overlapping word**. Pick
      one mapping, write it in `BRAND.md` (T13), and assert it from both sides — a Rust test over
      `Tier::as_str` and an addition to the existing `web/tests/unit/attention-tiers.test.ts`.

**Verification:** `bun run test:unit` green incl. the two harvested suites; on the T0.5 instance from a real
phone: a permission dialog buzzes, the home-screen badge shows the needs-you count, backgrounding and returning
clears it, and setting a session to `off` silences it while the roster tier still shows. VR the policy control
and the Settings row in **both themes** on the `dev-*` bench.

---

### T4 — Cross-device seen cursors: `PATCH /api/sessions/{name}/seen` (**needs G3**)

**Files:** `server/migrations/0029_session_seen.sql`, `server/src/sessions/mod.rs`,
`server/src/db/sessions.rs`, `server/src/notify.rs`, `server/tests/seen_cursor.rs` (new),
`web/src/hooks/use-attention.ts`, `web/src/lib/api/sessions.ts`,
`web/tests/unit/seen-cursor-merge.test.ts` (new)

- [x] **T4.1** `0029_session_seen.sql`: `seen_ts INTEGER`, `seen_count INTEGER`, `seen_epoch INTEGER`, all
      nullable — the exact triple `SeenCursor` already carries (`attention-tiers.ts:52–62`). Nullable, so every
      existing row backfills to "never seen", which is what `tierFor` already treats as *not unread*
      (`:135–139`) — the migration changes nobody's tiers on upgrade.
- [x] **T4.2** `PATCH /api/sessions/{name}/seen` accepting `{ts, count?, epoch?}`. **Monotonic**: a cursor older
      than the stored one is a no-op, not a write, so a stale tab cannot un-read a session on the phone.
- [x] **T4.3** Emit the stored cursor on the sessions row / delta so a fresh device starts correct.
- [x] **T4.4** `use-attention.ts`: merge server cursor and localStorage **newest-wins**. localStorage is NOT
      deleted — it stays as the offline/optimistic layer, and it is what makes `markRead` instant. The two write
      sites (`focus/desktop.tsx:78`, `focus/mobile.tsx:203`) and `markUnread`
      (`session-tile/group-grid.tsx:2140`) each gain the network write, fire-and-forget.
- [x] **T4.5** In `notify.rs::deliver`, replace the "a chat store is attached" unread-suppression proxy with
      "seen within 30 s" — the branch's own comment names this as the upgrade point (§0.3b).

**Verification:** `cargo test -p supermux-server seen_cursor` green, **including the auth-scoping matrix**: an
unauthenticated PATCH is 401, a hook-token-scoped caller cannot write another session's cursor, an unknown
session is 404, and a regressive `ts` is a no-op with a 200. Unit: newest-wins merge, epoch mismatch → dot not
number. Manual: mark read on desktop, the phone's roster loses the unread dot without a reload.

---

### T5 — The archive contract: stop archived sessions being silently resurrected

§15.2 asks for the contract to be *stated*. The audit found the contract is worse than implicit: the scheduler is
entirely archive-blind and `send_text_with_preview` **starts** a dead session (`lifecycle.rs:1185–1187`), so an
archived session runs its schedule and comes back to life while `list` keeps hiding it (`archived = 0`).

**Files:** `server/src/scheduler/runner.rs`, `server/src/sessions/lifecycle.rs`, `server/src/db/schedules.rs`,
`server/tests/archive_schedule_contract.rs` (new), `web/src/components/archived/archived-sheet.tsx`,
`web/src/hooks/use-session-actions.ts`

- [x] **T5.1** Failing test first: archive a session with an enabled schedule, advance the tick, assert the
      session is **not** started and the run is recorded with an explicit, readable status — not a generic error.
- [x] **T5.2** Decide and implement the contract. Two honest options; **(b) is recommended** because it matches
      the master plan's "keep running unless explicitly stopped" while removing the invisibility:
      **(a)** archiving disables its schedules (reversible on unarchive), or
      **(b)** schedules keep running but an archived session that fires **unarchives itself** and says so on the
      transcript, so it is never running-but-hidden.
      Whichever is chosen, `send_text_with_preview`'s existence check moves from `db::sessions::exists` to the
      archive-aware `exists_active` that already sits beside it (`db/sessions.rs:245`).
- [x] **T5.3** State the contract in the UI in one sentence, in `brand/copy.ts`, used by **both** the archive
      confirm and the Archived sheet — the same sentence in both places (§15.5's "blocked things state why with
      the same sentence everywhere" applies to lifecycle too).
- [x] **T5.4** Note in the PR that `origin/feat/schedule-archive-on-stop` (`0025_archive_on_stop`) is an
      independent, unmerged attempt at this same gap — the owner decides whether it is superseded.

**Verification:** `cargo test -p supermux-server archive_schedule_contract` green; `scheduler.rs` and
`schedule_missed_tick.rs` still green unmodified; manual: archive a session with a 1-minute schedule on the T0.5
instance and watch a full tick go by.

---

### T6 — Duplicate becomes an honest template copy

**Files:** `server/src/db/sessions.rs`, `server/src/sessions/mod.rs`, `server/src/sessions/lifecycle.rs`,
`web/src/components/focus-mode/use-clone-session.ts`,
`web/src/components/focus-mode/session-info-panel.tsx`, `server/tests/lifecycle.rs`

- [x] **T6.1** Delete the `/clone` route (`sessions/mod.rs:120` → `lifecycle.rs:1766`, a literal one-line alias
      of `duplicate` with zero web callers). §15.1's "unify" is a *deletion*, not a merge. Keep `duplicate` as
      the name — it is the one that is wired.
- [x] **T6.2** Copy **schedules** into the copy (currently no child row is cloned at all). Disabled by default:
      a duplicated agent that immediately starts firing cron jobs is a surprise, and the master plan's own
      framing is "a bot is its own template", not "its own daemon". State it in the UI.
- [x] **T6.3** Copy `mark_pin` (0027) so the copy carries the avatar — §10 says explicitly that duplicate
      ("copy carries the avatar") is one of the reasons the column is persisted, and today's column list
      (`db/sessions.rs:348–358`) omits it.
- [x] **T6.4** Default the new name to `<name> copy` (§15.1) with the usual collision suffix, instead of
      requiring the caller to invent one.
- [x] **T6.5** **Be honest about the worktree.** `duplicate` copies `worktree`/`worktree_repo` as *strings* and
      creates no git worktree — the copy lands in the source's directory. Either create a real worktree, or keep
      today's behaviour and make the UI say "in this directory" (which `use-clone-session.ts` already hints at).
      Do **not** leave the columns implying a worktree that does not exist.
- [x] **T6.6** Decide `/wake` (`sessions/mod.rs:119`, zero web callers): wire it into T8's ladder or delete it.
      A dead route is a maintenance liability and a small attack surface.

**Verification:** `cargo test -p supermux-server lifecycle` green with new assertions naming **every** column and
child table copied vs. not; unit test on the `<name> copy` collision suffix; manual duplicate from the info panel.

---

### T7 — Delete/purge honesty + the orphan fix

Respec §15.3 against reality: there is no user-facing Delete, the reversible verb is **archive** (which *is* the
undo window the master plan asks for — it just is not named as one), and the irreversible verb is **purge**.

**Files:** `server/src/sessions/mod.rs`, `server/src/db/schedules.rs`, `web/src/brand/copy.ts`,
`web/src/components/archived/archived-sheet.tsx`, `server/tests/delete_disposition.rs` (new),
`web/tests/unit/delete-honesty.test.tsx` (new)

- [x] **T7.1** **Fix the orphan.** `schedules.session` has no FK (`0003_schedules.sql:7`), so `delete`/`purge`
      leave schedules pointing at a gone name. Every tick then errors *and pushes to the phone*
      (`runner.rs:130–141,257–262`). Delete or disable them in the same transaction, and log the disposition.
      A failing test that asserts "no schedule survives its session" comes first.
- [x] **T7.2** Write the disposition table **as a test** (`delete_disposition.rs`), then as copy. What the audit
      found today, which the dialog must enumerate:
      | thing | archive | purge |
      |---|---|---|
      | DB row | kept (`archived=1`) | deleted |
      | `session_runtime`, `tracked_files`, `steering_queue`, `share_tokens`, `delegations` | kept | CASCADE-deleted |
      | board issues | kept | kept, `session` SET NULL (orphaned card) |
      | schedules | per T5's contract | **T7.1 fixes this** |
      | scrollback dump `<data>/archives/<name>-*.log` | **written** | deleted |
      | native spool `<data>/native/<name>/` | killed | deleted |
      | git worktree | untouched | **untouched** |
      | git branch | untouched | **untouched** |
      | working directory | untouched | **untouched** |
      | audit log | kept | kept |
      The "git worktree / branch / directory are never touched" row is the one users will be most surprised by
      and is the single most important sentence in the dialog.
- [x] **T7.3** Name archive as the undo: the archive confirm says what comes back and how (`unarchive`), and the
      Archived sheet's purge confirm says what does not.
- [x] **T7.4** Route both through T9's armed idiom; no `window.confirm`, no bespoke sheet.

**Verification:** `cargo test -p supermux-server delete_disposition archive_removes archive_recover` green — the
two existing suites must pass unmodified; a unit test asserting the dialog renders every row of the table above,
so a future change to the handler that forgets the copy fails CI.

---

### T8 — The graded recovery ladder (§15.5)

The automatic layer exists and is good (§0.1 row 15.5). What is missing is every manual rung, plus any surfacing
of the automatic one — including the fact that `recovery.auto_heal` is a real pref with **zero UI**.

**Files:** `server/src/sessions/{mod,lifecycle,auto_actions}.rs`, `server/tests/recovery_ladder.rs` (new),
`web/src/hooks/use-recovery.ts` (new), `web/src/components/recovery/recovery-ladder.tsx` (new),
`web/src/components/session-tile/activity-status.tsx`, `web/src/routes/settings.tsx`,
`web/tests/unit/recovery-ladder.test.tsx`, `web/tests/e2e/smoke/recovery-ladder.spec.ts`

- [x] **T8.1** Three server rungs, each labelled by **what it preserves**:
      | rung | endpoint | preserves | destroys |
      |---|---|---|---|
      | Restart | `POST /api/sessions/{name}/restart` (atomic stop→start; today the client composes it, and `focus/desktop.tsx` composes it *differently* from `use-session-actions.ts`) | conversation, worktree, schedules | live pty + in-memory scrollback |
      | Recover holder | `POST /api/sessions/{name}/recover` — the manual trigger for `auto_heal`, **bypassing the 10-min cooldown** | scrollback | nothing else |
      | Reset | `POST /api/sessions/{name}/reset` — fresh runtime row, new hook token, cleared chat ring | worktree, schedules, config | conversation + scrollback + activity |
- [x] **T8.2** Surface the `Heal` outcomes. `Heal::{Cooldown, Unsupported, Disabled, Superseded, Failed}`
      (`auto_actions.rs:1080`) are `tracing` lines today, so a user looking at "Terminal died" cannot tell
      "we tried and it is on cooldown" from "auto-heal is off" from "this session type cannot be healed". Put
      the reason on the sessions delta beside the `holder_died` badge.
- [x] **T8.3** **Inline, least-destructive first**: the `ErrorBadge` (`activity-status.tsx:113`) gains an action
      that offers the *lowest* rung that can help, labelled with what it keeps — "Recover holder — keeps
      scrollback". Not a menu; one button plus a link to the canonical list.
- [x] **T8.4** **Canonical**: a Recovery section in Settings listing all three rungs with the same labels, plus
      the `recovery.auto_heal` toggle (`db/prefs.rs:91`) — the pref is already allowlisted (`prefs.rs:76`) and
      reachable only by hand-crafting a `PUT /api/prefs` today.
- [x] **T8.5** Blocked rungs state *why* with the same sentence in both places: Recover holder is native+local
      only (`auto_actions.rs:1157`), Resume is Claude-only with recorded conversations
      (`stopped-session.tsx:182`). One string in `brand/copy.ts`, two call sites.

**Verification:** `cargo test -p supermux-server recovery_ladder` green **including auth scoping on all three new
routes** (unauthenticated → 401; a session-scoped hook token cannot restart/reset a *different* session; unknown
name → 404; reset on a running session is either refused or documented as stop-first). E2E: kill a holder on the
T0.5 instance, see the badge, press the inline action, see it come back. VR the badge + inline action + the
Settings section in **both themes**.

---

### T9 — One confirm idiom, zero `window.confirm`

**Files:** `web/src/hooks/use-armed-confirm.ts` (new), `web/src/components/ui/armed-button.tsx` (new), the 6
inline-confirm sites, the 4 `window.confirm` sites, `web/src/routes/focus/desktop.tsx`,
`scripts/lint-microcopy.sh`, `web/tests/unit/armed-confirm.test.tsx` (new)

- [x] **T9.1** `useArmedConfirm({ window: 4000 })` + `<ArmedButton>` — the ONE idiom. It must clear its timer on
      unmount; variant B (`hosts-section.tsx:260–266`) currently does not, which is a live
      setState-after-unmount.
- [x] **T9.2** Migrate all six sites: `tile.tsx:513–543` (A), `hosts-section.tsx:260–266` (B),
      `archived-sheet.tsx:128` and `:235` (C), `kill-teammate-button.tsx:57` (C),
      `claude-tools-sheet.tsx:848` (C). The four untimed C sites **gain** the 4 s window — call that out in the
      PR, it is a behaviour change.
- [x] **T9.3** Kill all four `window.confirm`: `use-session-actions.ts:66` (kill session),
      `use-session-actions.ts:91` (archive running — its string is inline, move it into `brand/copy.ts`),
      `routes/focus/desktop.tsx:125`, `claude-tools-sheet.tsx:482` (bypass). Destructive-and-cheap →
      `ArmedButton`; destructive-and-consequential (kill a team lead, switch to Bypass) → a shadcn `Dialog` that
      **enumerates the consequence**, matching T7's language.
- [x] **T9.4** Deduplicate the confirm logic: `routes/focus/desktop.tsx:124–125` reimplements
      `use-session-actions.ts:63–66`'s team-lead branch. Route the route through the hook.
- [x] **T9.5** Give `team-card.tsx:190–196` (dismiss team) a confirm — it has none today, directly above a
      `KillTeammateButton` that does.
- [x] **T9.6** Extend `scripts/lint-microcopy.sh` with a grep gate: `window.confirm|window.alert|window.prompt`
      in `web/src` fails CI. This is what stops the regression.

**Verification:** `bun run test:unit` green; the new lint gate fails on a deliberately re-added `window.confirm`
and passes after removing it; VR the armed state in **both themes** on the `dev-*` bench; manual: every one of
the 10 migrated sites still performs its action and still cancels.

---

### T10 — One sheet system (quick-peek migrates here, per the master plan)

**Files:** `web/src/components/session-tile/quick-peek-modal.tsx` and the 6 other raw-Vaul sites,
`web/src/components/focus-mode/desktop-compose-panel.tsx`, `web/tests/unit/sheet-inventory.test.ts` (new)

- [ ] **T10.1** **Quick-peek → `ResponsiveSheet`.** The hazard: it mounts `StartTeamSheet` (`:236`) and
      `SessionInfoPanel` (`:250`) **outside** `Drawer.Portal` today, and both are themselves `ResponsiveSheet`s.
      A naive migration nests a sheet inside a sheet. Decide the nesting explicitly (portal to the shell, or
      replace-in-place) and test it on a real touch device.
- [ ] **T10.2** Migrate `last-send-recall.tsx:770`, `mobile-action-sheet.tsx:46`,
      `session-picker-sheet.tsx:62`, `overview-display-menu.tsx:82` (note: has a `Drawer.Trigger`),
      `session-picker.tsx:246`, `snippet-editor.tsx:38`.
- [x] **T10.3** **Keep `pwa/a2hs-sheet.tsx:102` raw** — it is `modal={false}` on purpose. Document the exception
      in a header comment and in the T10.5 allowlist rather than forcing it.
- [ ] **T10.4** `desktop-compose-panel.tsx:103–215` uses `DialogPrimitive.*` directly, bypassing
      `ui/dialog.tsx`. Route it through the wrapper or document why not.
- [x] **T10.5** `sheet-inventory.test.ts`: assert `import { Drawer } from 'vaul'` appears **only** in
      `ui/responsive-sheet.tsx` and the documented allowlist. This is what makes the consolidation stick.
- [x] **T10.6** The bespoke overlays stay for now — `chat/attention-card.tsx` is in-pane by A4's design,
      `connection-overlay`, `tour-overlay`, `floating-tip` are not sheets. **Say so in the PR** so the next
      reader does not re-litigate it. The one worth fixing: `mobile-compose-sheet.tsx:873–960`'s bespoke
      "Discard changes?" — it is a confirm, so it belongs to T9.

**Verification:** `bun run test:unit` green incl. the inventory guard; VR every migrated sheet on desktop **and**
iPhone viewport, **both themes**; `web/tests/e2e/mobile/action-panels.spec.ts` still green; manual long-press
peek on a real phone (the drag handle and 78vh height must survive).

---

### T11 — One empty / loading language

**Files:** `web/src/components/ui/skeleton.tsx` (new), `web/src/brand/copy.ts`, the 22 hand-rolled empty states,
the 7 skeleton idioms, `scripts/lint-microcopy.sh`

- [x] **T11.1** A single `<Skeleton>` primitive; collapse the 7 idioms into it
      (`tile-skeleton.tsx:6`, `audit-log.tsx:52`, `schedule-detail-sheet.tsx:300`, `files.tsx:432`,
      `claude-tools-sheet.tsx:604`, the four inline `animate-pulse` blocks, and the two shimmer variants —
      shimmer vs pulse becomes a documented prop, not two implementations).
- [ ] **T11.2** Migrate the 22 hand-rolled empty states to `EmptyStatePlaceholder`. Where a surface genuinely
      needs a one-line inline empty (pickers, `entity-picker.tsx:252`), define that as a **second sanctioned
      form** in `BRAND.md` rather than pretending it does not exist — otherwise it grows back.
- [x] **T11.3** `brand/copy.ts` sweep: fold the inline strings in, delete the dead keys (`CONNECTION` has zero
      importers; `CONFIRM.deleteIssue/discardEdits/overwriteFile`,
      `ERROR.generic/network/notFound/unauthorized/fileTooLarge`, `EMPTY.sessions/files/search` are unused while
      their surfaces inline their own text). Importers go from 14 up.
- [x] **T11.4** Extend `scripts/lint-microcopy.sh` to flag new inline empty-state strings in the surfaces that
      have been migrated (a path allowlist, not a global ban — a global ban is unmaintainable).

**Verification:** `bun run test:unit` + `bun run lint` + `bash scripts/lint-microcopy.sh` green; VR the overview,
files, issues, archived, claude-tools and settings empty + loading states in **both themes**; `bun run build:perf`
still inside the size budget (this task deletes more than it adds — confirm it).

---

### T12 — Teams consolidation

Two of §16.3's four items are already done (§0.6): desktop team creation exists via three paths, and team boards
already read through `IssueSurface` in a `ShellOverlay variant="pane"`. **Do not re-do them.**

**Files:** `web/src/components/team/{teammate-chip,teammate-card,member-status-dot,team-card}.tsx`,
`web/src/components/focus-mode/team-strip-group.tsx`, `web/tests/unit/teammate-row.test.tsx` (new)

- [ ] **T12.1** Teammate rows → B2's `RosterRow` (`chat/ui/roster-row.tsx:109`). Three bespoke implementations
      collapse: `teammate-chip.tsx:40–110` → `density="list"`, `teammate-card.tsx:31` → `list`,
      `team-strip-group.tsx:211` → `density="strip"`. They gain the mark and the fact ladder for free.
- [x] **T12.2** `MemberStatusDot`'s four states (`working`/`needs_you`/`idle`/`offline`,
      `member-status-dot.tsx:20–32`) map onto the mark `data-state` / `SessionFace` vocabulary. Keep the
      component as a thin adapter at its 6 call sites rather than a 6-site edit, and delete the parallel colour
      table. Note `working` spins even under Reduce Motion (`:41–54`) — `SessionFace` must preserve or
      deliberately change that.
- [x] **T12.3** The three parallel team roll-up headers (`team-rollup-badges.tsx:18`,
      `team-strip-group.tsx:128`, `session-picker-sheet.tsx:144`) collapse to one — the third one's own comment
      says it "mirrors the overview TeamCard language", which is the definition of drift.
- [ ] **T12.4** `fact-ladder.test.ts`'s monotonic rules must hold for teammate rows too; extend the table rather
      than exempting teams.

**Verification:** `bun run test:unit` green incl. `fact-ladder.test.ts` extended; VR `dev-teams.tsx` and the
overview team card in **both themes**, desktop + mobile; `server/tests/teams_dismiss.rs` and `teams_start.rs`
still green.

---

### T13 — The record: two new vocabularies in `BRAND.md`

§16.4 is largely done — `BRAND.md` already carries Toast (§6), marks (§6b), chat primitives (§6c), entity chips
(§6c.1), shell/z-ladder (§6d), roster + the four-word attention vocabulary (§6e, line 452). B5 introduces exactly
two vocabularies that are not yet written down.

**Files:** `web/src/brand/BRAND.md`, `web/src/routes/dev-{roster,shell}.tsx`

- [x] **T13.1** **§6f — the notification vocabulary.** One table: server `Tier` × `NotifPolicy` ×
      `NotifCategory` × client `TIERS` × what buzzes vs. what only dots. This is R2's mitigation and T3.5's
      artifact; it ships **with** the code, not after.
- [x] **T13.2** **§6g — the lifecycle vocabulary.** Every destructive verb (stop / archive / purge / restart /
      recover / reset / duplicate) with the one sentence that says what it preserves and what it destroys —
      the same sentences T7 and T8 use in the UI, so drift is a diff.
- [x] **T13.3** Add the bench states T9/T10/T8 need to `dev-roster.tsx` and `dev-shell.tsx` so the VR passes in
      T8–T12 have somewhere to run offline.

**Verification:** every sentence in §6f/§6g appears verbatim in a shipped string or a test; no orphan copy.

---

### T14 — PR and hand-off

- [x] **T14.1** Both suites green from clean; `bun run build`; `cargo fmt --all -- --check`;
      `bash scripts/lint-microcopy.sh`.
- [x] **T14.2** PR body: the four gate answers, the §0.1 audit table, the T7.2 disposition table, the T8.1 rung
      table, and an explicit list of behaviour changes the owner is accepting — `agent_finished` default flips
      off, the four untimed confirms gain a 4 s window, hook-anchored push means non-Claude providers stop
      pushing (G2), and the archive-schedule contract chosen in T5.2.
- [x] **T14.3** Open the PR and hand off. **Never auto-merge, never deploy.**

---

## 5. Risks

| risk | mitigation |
|---|---|
| **R1 — two writers of `state.pending_pushes`** (§0.3b #1). `notify_event` and `maybe_push_on_transition` abort each other's timers non-deterministically, and a dropped push is indistinguishable from a muted one. The harvest's own answer — delete `push_debounce.rs` and the detector path — would also delete the `T_TEAM_FINISH` window and the subagent gate that `main` grew afterwards. **This is the riskiest task in the fase (T2).** | T2.1 writes the failing interleaving test *first*. `push_debounce.rs` is **kept and extended**, never replaced: the suite must be green as the *union* of both files. The team-finish window and `push_should_fire`'s subagent gate move into the hook path (T2.3) before the detector path is demoted, not after. The detector survives as an explicit fallback for non-hook providers, so a wrong call on G2 is reversible with a flag rather than a revert. T2.4 makes a future third writer fail loudly. |
| **R2 — tier vocabulary drift.** The server `Tier` (`attention/unread/error/schedule`) and B2's client `TIERS` (`needs/unread/working/quiet`) are different sets sharing exactly one word, and there is already a second unrelated `chat/attention.ts` module. | one mapping table in `BRAND.md` §6f, shipped **with** the code (T13.1), asserted from both sides — a Rust test over `Tier::as_str` plus an addition to the existing `attention-tiers.test.ts` (T3.5) |
| **R3 — the delete dialog becomes a lie the moment the handler changes.** The most surprising facts (worktree, branch and directory are *never* touched; board issues survive orphaned) live in copy, not in code. | T7.2 writes the disposition as `delete_disposition.rs` **first**, then as copy, and a unit test asserts the dialog renders every row — so a handler change that forgets the copy fails CI |
| **R4 — T5's archive fix changes when agents run.** Making the scheduler archive-aware can silently stop a job the user relies on (option a) or resurrect a session they meant to hide (option b). | **G4**: the owner picks; the contract is stated in one sentence from `brand/copy.ts` used in both the archive confirm and the Archived sheet; `scheduler.rs` + `schedule_missed_tick.rs` must pass unmodified |
| **R5 — quick-peek's sheet-inside-a-sheet.** It mounts two `ResponsiveSheet`s outside its own `Drawer.Portal`; migrating it naively nests sheets and breaks on touch. | T10.1 decides the nesting explicitly before editing, and the migration is verified on a real phone, not an emulator |
| **R6 — consolidation churn breaks muscle memory**, and T9 silently adds a 4 s arm to four buttons that were instant. | per-surface commits; no removal without its replacement in the same commit; the behaviour changes are listed explicitly in the PR body (T14.2); the owner reviews every merge |
| **R7 — scope.** B5 is the last Track B fase and is a natural dumping ground; T1–T4 and T5–T8 and T9–T12 are three separable bodies of work. | the three groups are independent by design (§4 ordering rule) — if the PR gets too large to review, split at those seams, not inside them |

## 6. Out of scope

- Deprecating the board API (open question 4 in the master plan).
- Mark expressiveness / eye-states (cut to backlog in B0 round 2).
- Landing `feat/schedule-archive-on-stop` or `worktree-on-demand-spawn`. T5.4 only *notes* that the former is an
  independent attempt at the same gap and that both claim `0025`.
- Merging the two `attention` modules (`lib/attention-tiers.ts` vs `components/chat/attention.ts`) — they are
  deliberately separate and `BRAND.md:463` says so (§0.7).
- The bespoke non-sheet overlays (`connection-overlay`, `tour-overlay`, `floating-tip`,
  `chat/attention-card.tsx`'s in-pane overlay) — T10.6 documents why they stay.
- Filling the `0025` migration gap, ever (§0.4).

---

*Written 2026-08-16 against `origin/main` @ `a7cc52c`. Every file:line in §0 was read at that commit — re-verify
before executing if `main` has moved, especially §0.4's migration numbers and §0.6's call-site counts.*
