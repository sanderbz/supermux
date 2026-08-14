# SUPERMUX PAGE & FLOW INVENTORY (everything outside the focus panel)

Ground truth read from `/opt/projects/supermux/web/src` on `main` @ a7a2b9b. 232 TS/TSX files, ~55.9k lines. Full report also written to `/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/supermux-page-flow-inventory.md`.

---

## 0. Route map & data plane

`/opt/projects/supermux/web/src/App.tsx:73-92` — 7 real routes, all children of one `<Layout>`:

| Route | Component | File |
|---|---|---|
| `/` | `Overview` | `web/src/routes/overview.tsx:107` |
| `/focus` | `FocusEntry` (redirect) | `web/src/routes/focus.tsx:38` |
| `/focus/:name` | `Focus` (viewport fork) | `web/src/routes/focus.tsx:16` |
| `/board` | `Board` | `web/src/routes/board.tsx:75` |
| `/files/:name?` | `Files` | `web/src/routes/files.tsx:61` |
| `/scheduler` | `Scheduler` | `web/src/routes/scheduler.tsx:35` |
| `/hosts` | `<Navigate to="/settings#hosts">` | `web/src/App.tsx:87-90` |
| `/settings` | `Settings` | `web/src/routes/settings.tsx:743` |

DEV-only, lazy, **outside `<Layout>`** (no nav chrome): `/dev/tiles`, `/dev/term/:name`, `/dev/focus/:name?`, `/dev/focus-mobile/:name?`, `/dev/teams` (`App.tsx:20-40, 93-142`).

Providers outermost→innermost (`App.tsx:57-153`): `BrowserRouter` → `ThemeProvider` → `QueryClientProvider` (staleTime 30s, `refetchOnWindowFocus`, **no polling**) → `TooltipProvider(200ms)` → `ToastProvider` → `A2HSInstructionsSheet` + `OnboardingHost` + `<Routes>`. `<ConnectionOverlay>` mounts **outside** all providers so it survives a provider crash (`App.tsx:152`).

**Data.** TanStack Query is truth; one SSE channel (`hooks/use-sse.ts`, registered once at shell level `layout.tsx:235-236`) invalidates/merges. `useSessions` (`hooks/use-sessions.ts:36`, key `['sessions']`) merges SSE `sessions`/`status` deltas key-by-key (`mergeRow` :50, `applyDelta` :76) so a status flip never blanks `preview_lines`. Endpoints in play: `/api/sessions{,/archived,/{n}/{start,stop,archive,unarchive,purge,config,mode,send,paste,keys,git,peek,recall,clone,duplicate}}`, `/api/teams`, `/api/board*`, `/api/boards`, `/api/schedules*`, `/api/hosts`, `/api/prefs/:key` (`server/src/prefs.rs`), `/api/push/*`, `/api/version`, `/api/update/*`, `/api/claude/registry`, `/api/skills`, `/api/slash-commands`, `/api/snippets`, `/api/file`, `/api/ls`, `/api/audit`.

---

## 1. App shell & navigation — `web/src/components/layout.tsx`

### Nav items (`layout.tsx:46-61`)
`/` Overview (LayoutGrid, `end:true`) · `/focus` Focus (Terminal, **`desktopOnly:true`**) · `/board` Board (SquareKanban) · `/files` Files (FolderClosed) · `/scheduler` Scheduler (CalendarClock, tour anchor) · `/settings` Settings (SettingsIcon, `badgeKind:'updates'`). **6 desktop / 5 mobile** — Focus is filtered out of `BottomNav` (`layout.tsx:171`).

### Desktop `SideNav` (`layout.tsx:86-138`)
64px icon rail (`w-16`), `border-r bg-card pt-safe`, `hidden … md:flex`. Logo `h-16` at top (`components/logo.tsx`), `<ThemeToggle/>` at the bottom (`:136`). Items are `size-11` rounded-xl wells, **icon-only**, label revealed by `TooltipContent side="right"`. Active = `motion.span layoutId="nav-active-desktop"` filled `bg-primary` rect sliding with `springs.snappy`, icon flips to `text-primary-foreground` (`:111-119`). Update badge = 8px `ring-2 ring-card` dot at icon top-right, `bg-primary` (clean) or `bg-amber-500` (blocked) — `NavBadgeDot` `:67-83`, state from `hooks/use-update-badge.ts`.

### Mobile `BottomNav` (`layout.tsx:164-211`)
`border-t bg-card pb-safe md:hidden`, 5 equal tabs, `min-h-14`, icon + 10px label. Active is a **different affordance**: a 4px×32px `bg-primary` pill at the tab's *top* (`layoutId="nav-active-mobile"`) plus `text-primary`. `MobileTopBar` (`:155-159`) **returns `null` on every route** — no mobile top chrome at all; each route self-homes its own `pt-safe`.

### Shell composition (`layout.tsx:228-277`)
`SideNav` | column of [`MobileTopBar`(null) → `ReconnectBanner` (**in-flow row**, pushes content down, never an overlay) → `<main overflow-auto><Outlet/></main>` → `BottomNav`] | `CommandPalette` (once) | `ArchivedSheet` (once, opened via zustand). `/focus/*` strips **both** mobile bars (`:244,258,263`); desktop SideNav stays.

### Route transitions — the big gap
`components/view-transitions/morph.tsx` implements `withViewTransition()` (:53), `useNavigateMorph()` (:74), `<MorphLink>` (:103), `vtSessionName()` (:65); reduced-motion → plain navigate; CSS physics `styles/globals.css:363-382` (0.28s groups, 0.26s root, `cubic-bezier(.4,0,.2,1)`).
- **Used by:** tile→focus (`session-tile/tile.tsx:266-269` + `viewTransitionName` :773-777), row→focus (`session-row.tsx:19-34`, a *local duplicate* that ignores reduced motion), board card→focus (`routes/board.tsx:131,382`).
- **Not used by:** any nav link. Both rails use raw `<NavLink>` (`layout.tsx:102,174`) → Overview↔Board↔Files↔Scheduler↔Settings are **hard cuts**. `<MorphLink>` has **zero call sites**. No page-level enter/exit choreography exists.

### Theme
`components/theme-provider.tsx` — `system|light|dark`, key `supermux-theme`, **default dark** (:36), applied at module-eval before React mounts (:50-52). Two divergent entry points: desktop `<ThemeToggle/>` dropdown at the SideNav bottom; mobile **only** Settings → Appearance (`settings.tsx:825-835`) — the floating mobile toggle was deliberately removed (`layout.tsx:141-153`). Tokens `globals.css:46-99`/`:102-135` (iOS palette, `--brand: 38 92% 58%`, five status tokens, radius `.75rem`), TS mirror `brand/tokens.ts`.

---

## 2. Overview — `web/src/routes/overview.tsx` (953 lines)

### Header (`:520-607`)
`<h1>Overview</h1>` (text-2xl) · search · display controls · Archived · `+`.
- **Search** (:523-543): 200ms debounce (:158-161), matches `name | task_summary | desc | tags` (`matches()` :91-99); teams filtered separately by `team_name | member names | lead` (:399-408). Wraps to `order-last w-full` on mobile.
- **Display controls fork by pointer** (:548-575): mobile → one `<OverviewDisplayMenu>` Vaul glass sheet (`session-tile/overview-display-menu.tsx:180`, sections View/Sort/Size/Hide-stopped). Desktop → four chips: `<ViewToggle>` (:912), `<SortControl>` (`sort-control.tsx:30`), `<OverviewSizeControl>` (:857, tile mode only), `<HideStoppedChip>` (`overview-display-menu.tsx:303`).
- **Archived** (:577-593): ghost button, `Archived (N)` ≥sm, icon-only below → shell-mounted sheet via `archived-sheet-store`.
- **`+`** (:598-606): `size-9` primary square → `<NewSessionSheet>`. **Team creation is not here.**

### View modes & density
`viewMode: 'tile'|'list'` persisted in `stores/ui-store.ts:90`, also in Settings→Appearance. Density tiers 1–4 (`lib/overview-size.ts`): Compact/Roomy/Wide/Spacious; 1→2 = height only (`idleLines` 6→12, +20px), 3/4 = column drops (lg 4→4→3→2) + container max-width 82/82/86/90rem (**duplicated** in `overview.tsx:419-424`). Desktop and mobile densities are **separate persisted keys** (`overviewSize` / `overviewSizeMobile`), mobile capped at tier 2. Keyboard `[`/`]` steps tiers (:164-193) — **advertised nowhere**.

### Sorting / grouping — what it CAN do today
**Global mode** — server pref `overview_layout` via `/api/prefs/:key` (`hooks/use-overview-layout.ts`, optimistic + rollback, SSE `prefs` syncs peers). Three values only (`lib/overview-layout.ts:42-47`): `smart` (pinned→running→status rank→last_activity, `smartSort` :291), `alpha` (locale A→Z on the **slug**, :302), `custom`.
**Per-group mode** — 6 modes (`smart|custom|name|status|recent|age`, :60) but **only inside custom mode**, persisted to **localStorage** not the server (`groupSortKey` :392). Ungrouped defaults `smart`, user groups default `custom` (:400).
→ **No top-level sort by recency, status or age. No group-by project/dir/provider/host/status.** Grouping = manual drag + named dividers only.

Custom mode renders `<GroupGrid>` (`components/session-tile/group-grid.tsx`, 2240 lines): dnd-kit, whole-row group reorder, cross-group tile drag, destination-sort-dependent drop indication (smart → tinted container + cursor caption; custom → insertion line), full-grid-width drop line with terminal dot, 700ms drop flash, hover-gap "+ Add group here", per-group collapse, Announcements a11y, `data-vr-*` VR hooks. `<GroupHeader>` (`group-header.tsx`): inline rename, delete, kebab Move top/up/down/bottom, collapse chevron, `<GroupSortChip>`. Group creation has **three** entry points → same state: bottom dashed "New group" (`overview.tsx:730-744`, visible in *all* modes, flips to custom), `g n` chord (:342-382, 1.2s strict-consecutive), and a palette action via `stores/new-group-store.ts` (:389-396).

### Tile anatomy — `components/session-tile/tile.tsx` (1139 lines)
Slot reserves `IDLE_H`; card floats inside (`rounded-xl border bg-card`, hover `scale 1.06` + shadow, tap `.96`).
- `<StatusBorder>` (:107-159) card-level inset pulse: waiting→blue 2.2s; idle→green 2.8s subtle "ready"; error→static orange; **active/starting/stopped→none**.
- **Title row (h-8)**: title (`sessionTitle()` = display_name if user-set → `task_summary` → slug, `lib/api/sessions.ts:182-189`), then right cluster: `<Kbd combo="mod+N">` (desktop, fades on hover) → `<HostBadge>` (globe, only when `host_id`) → `<ErrorBadge>` (amber) → "Needs input" pill → "Stopped" pill (translates −36px + fades on hover) → `<StatusDot>` **which swaps to the archive icon on hover** (`AnimatePresence mode="wait"` :872-935).
- **Meta row (h-4)**: working+activity → `<ActivityLine>` (emoji tool label + `· N subagents` at ≥2); else `N tokens` + `⎇ branch`.
- **Preview**: `<TailPreview>` (real ANSI `preview_ansi`) at rest; desktop hover → scaled live xterm (`LivePeekLayer`→`TileLiveTerminal`, one WS, crossfade on `onSettled`, pre-warmed by `usePeekPrewarm`, cap 12) or ~20 expanded text lines per Settings. Stopped tiles instead mount `<StoppedSessionActions>` over a frosted scrim (:995-1014).
- **Type-on-hover** (`usePeekType`) forwards keystrokes into the peeked pty + "Typing → name · Esc to close" pill (:1019-1037); two separate timers (`PEEK_STICKY_MS` hovering, `PEEK_LEAVE_GRACE_MS` after leave).
- **Archive**: hover icon on every non-stopped tile → inline confirm pair, 4s auto-cancel → self-collapsing exit spring → cache removal + Undo toast (:449-473).
- Stopped tiles at `opacity-60`, restored on hover. Mobile: `useLongPress` → `<QuickPeekModal>` (:379-382, 1041-1047). `session.missing` → `<TileError>`.

**`<SessionRow>`** (`session-row.tsx:58`): `min-h-12` row — dot · title · (status **word** + branch) · jump chip · host badge · needs-input pill · **relative timestamp**. Shows a status label and time the tile doesn't; omits tokens, activity, preview, error badge and archive that the tile has.

### Team cards (`components/team/team-card.tsx`, 427 lines)
Rendered **above** the grid in every mode (`overview.tsx:611-622`); leads excluded from the grid via `splitTeamLeads`. Tile-identical chrome. Header: team name · muted "Lead" pill · `<TeamRollupBadges>` (loud blue `needs you · N` else calm green "done" + muted `N agents · X/Y tasks`) · `<TeamWidthToggle>` (4 desktop tiers, per-team localStorage) · `<DensityToggle>` (Chips↔Cards, per-team localStorage). Lead = a **full `<SessionTile>`** or a dashed placeholder ("Lead session starting…" / "Lead not mapped… [Dismiss]"). Teammates = `<TeammateChip>` (h-11 glass row, **2px left colour rail = `member.color`**, `<MemberStatusDot>`, name, activity, `needs you` pill or `2/3`) or `<TeammateCard>` in a 2-col grid. Footnote: "Stopping the lead ends the whole team…". Teammate tap → `/focus/<lead>?teammate=<agent_id>` (:106-115) — **plain navigate, no morph**.

### New-session flow — `components/session-tile/new-session-sheet.tsx` (388 lines)
`<ResponsiveSheet title="New session" description="Boot an agent in tmux. It survives restarts.">`; inner panel only mounts while open.
- `KindToggle` 3-up segmented **Claude | Codex | Kimi** with shared-layoutId thumb (:104-148) — **text labels only, no provider marks anywhere in the app**.
- **Name** (:243-270): free text; slug derived live (`toSlug` :23 — whitespace→`-`, strip outside `[A-Za-z0-9_.-]`, cap 100) and shown inline "Creates a new folder `<slug>`. [choose your own folder →]". `display_name` = typed text, `name` = slug.
- **Folder** (opt-in, :276-286) → `<WherePicker>` (811 lines: projects list + create-folder, `showSessions={false}`, `gitHint="info"`).
- **Run on** (:288-299) → `<HostPicker>` (Local or registered remote).
- **Isolated worktree** `CheckCard` (:301-306); **Bypass permissions** Claude-only (:308-315).
- Submit → `createProjectFolder(slug)` → `sessionsApi.create` → `sessionsApi.start` (non-fatal) → `navigate('/focus/'+name)` **without morph** (`overview.tsx:415-417`). Inline `role="alert"` errors for 409 / status 0.
- **Not offered**: description, tags, model, initial prompt, provider flags.

### Archived surface — `components/archived/archived-sheet.tsx` (335 lines)
`<ResponsiveSheet>` with `descriptionTrailing={<DeleteAllAction/>}`. Row = status dot + `displayLabel` + "Archived Xm ago" (derived from `updated_at`; **there is no `archived_at` column**) + Restore + "Delete forever" behind an inline confirm. Opened from the overview header **or** ⌘K; one shared instance.

### Pin / tags / description — the phantom features
`ApiSession` carries `pinned`, `tags[]`, `desc` (`lib/api/sessions.ts:114-118`); the server accepts `toggle_pin`, `tags`, `desc` on `PATCH /api/sessions/{name}/config` (`server/src/sessions/mod.rs:760-778`); `smartSort` sorts on `pinned` (:293); search matches `desc`/`tags` (`overview.tsx:96-97`). **No UI exists to set or display any of the three.** Board *issues* render tags (`board-card.tsx:539-547`); sessions never do.

### Empty / error states (`components/empty-state.tsx`)
skeleton grid · "Can't reach supermux-server. Retrying…" + Retry now · "No agents yet. Boot your first one." + Boot first agent · "No matches for "q"." + Clear search · "Every session is stopped — they're hidden." + Show stopped. Note `brand/copy.ts:36-46` defines `EMPTY.sessions/board/files` copy the overview **doesn't use** — only `/scheduler` consumes its entry.

### Overview keyboard
`[` `]` density · `g`→`n` new group · `⌘/Ctrl 1..9` jump (:488-513; slot map teams-first then render order :456-479, surfaced as `<Kbd>` chips via `JumpIndexProvider`) · global `⌘K`.

---

## 3. Board — `web/src/routes/board.tsx` (1035 lines)

- **Chrome** (`BoardPage` :1004-1021): `<h1>Board</h1>` + `<BoardSwitcher>` inline, `max-w-none`. **No search, no filter, no sort, no header `+`.**
- **Fixed 3 lanes** (:61-65) To do / Doing / Done — no column CRUD. Done condensed to 6 + "Show all N".
- **Boards**: Main + per-team + synthetic `session:<name>` filters + synthetic "All". Picking a `session:` board also writes the app-wide `lastActiveSession` (:88-95), which `/files` reads. Team boards are **read-through** mirrors: non-draggable, no composer, no write affordances (:105-111).
- **Lane** (`LaneColumn` :669): `w-[300px]` mobile / `lg:flex-1 min-w-[300px] max-w-[360px]`; header = label + optional `<ClearLaneAction>` (Done only, inline Cancel/Clear-N) + count pill.
- **Card** (`components/board/board-card.tsx`, 782 lines) — affordances by lane: To do → ▶ Start; Doing → live face (status dot from the shared `['sessions']` cache, hover tail-peek, acceptance pill, amber "Needs your input" / softer "Review?", the agent's verbatim question, inline reply composer auto-revealed on needs-input, "Agent still running" on a Done-but-busy card); Done → check + PR/commit link. Meta row: assignee pill (from `team:` tag), session chip (dot + `displayLabel`, struck-through when stale), tag chips, due pill. Swipe-left discard on touch (undo toast, no confirm); ⋯ menu on desktop.
- **Session↔issue**: `issue.session` + `session_live`. `startIssue` (:241-263) spawns by default; drag To-do→Doing **runs Start** (:446-450). `replyIssue` → pty; detail pane's `replyOrCommentIssue` falls back to a durable board comment when the session is dead (:287-305).
- **Open forks by pointer** (:599): fine → desktop `<BoardDetailPane>` (`hidden lg:flex lg:w-[460px] xl:w-[540px]`); coarse → `<BoardCardEditor>` sheet. Card→focus uses `navigateMorph` (:375-385).
- DnD `@dnd-kit` + `closestCorners`; `DragOverlay` = rotated −1.5°, scale 1.04; `<DropIndicator>` 2px primary line.
- Lane empties are **bare** `text-xs text-muted-foreground/60` strings, not `<EmptyStatePlaceholder>`; the error state is hand-rolled (:517-530).
- Composer `<BoardComposer>` (415 lines): description-first, collapsible advanced (title, session, acceptance, tags, due), "Add" / "Add & start".

---

## 4. Files — `web/src/routes/files.tsx` (469 lines) + `components/files/*`

- **Toolbar** (:190-286): the app's **only `.glass safe-header`** bar, hidden on mobile while a file is open. `<SessionPicker>` · `<Breadcrumb>` · show-hidden eye (persisted, default **on**) · sort dropdown (Name/Size/Last modified with ↑↓ *inside the label text*) · upload + hidden input.
- **Session resolution** (:61-90): `:name` wins → else app-wide `lastActiveSession` if it still exists → else `$HOME`. Deep links mirror back into the shared cell.
- **Layout**: list `w-full` mobile / `md:w-80 lg:w-96` sidebar desktop inside `<Dropzone>`; viewer fills the rest; mobile is a two-screen push.
- **Sorting is route-local React state** (:97-98), not persisted; dirs always first.
- **Viewer** `file-viewer.tsx` (421) → `markdown-viewer.tsx` (react-markdown + remark-gfm + rehype-highlight, palette mapped to app tokens in `globals.css:436-484`) or `code-editor.tsx` (CodeMirror).
- **Delete** = the app's only shadcn `<Dialog>` destructive confirm (:367-395).
- Empty/error: shared `<EmptyStatePlaceholder icon={FolderOpen}>` for an empty dir; a **hand-rolled** red-circle `<ListError>` (:442-460); a bare "Select a file to view or edit it." for the idle viewer. `<ListSkeleton>` uses pulse bars — a third loading idiom.

---

## 5. Scheduler & Settings

### Scheduler — `web/src/routes/scheduler.tsx` (284 lines)
`max-w-5xl`, `<h1>` + `hidden sm:block` prose + **two different primary-action treatments** (`+` icon button on mobile, full "New schedule" `<Button>` on desktop, :89-103). List: desktop-only 5-column header (`Title | Schedule | Next fire | Last fired | On`), then `motion.div role="button"` rows with a **staggered mount** (`delay: i*0.03`, :190-192) unique in the app; row = title + mono target + (mobile) inline human schedule/next/last; disabled rows `opacity-60`; trailing `<EnableToggle>`. Create and edit share one `<ScheduleDetailSheet>` (→ `ResponsiveSheet`) hosting `<ScheduleForm>` (923 lines: combined prompt field with inline `/` autocomplete, recurrence composer, live next-5-runs preview, test-fire) + `<FireLog>`. Live via SSE (`useSchedulerStream`). Empty uses `EMPTY.scheduler`; error is hand-rolled (:270-284).

### Settings — `web/src/routes/settings.tsx` (922 lines)
Own scroll container; **sticky glass bar with scroll-driven opacity** (`useScroll`/`useTransform` :753-756, :796-805) over a `text-[34px]` iOS large title that fades out — an interaction model unique to this route. `max-w-2xl`, `gap-7`, sections stagger via `listContainer` (`components/settings/primitives.tsx:14-22`). Section kit (`primitives.tsx`): 13px sentence-case `h2`, opaque `rounded-2xl border bg-card` with `divide-y` rows, muted footnote; `<Row label hint control|stacked>`, `<SegmentedControl>`, `<Switch>` — **a separate control kit from the rest of the app**.

Sections (:821-917): **Appearance** (Theme · Default view · Overview preview live|text · Overview hover preview live|expanded · sound cue) → **Notifications** (master push toggle, transport test, 5 per-category toggles, "Recent activity" ring of the last 10 attempts + manual Refresh) → **Updates** (`settings/updates-panel.tsx`, 697 lines; 4 states — up-to-date / available (green badge + markdown notes + "Update now") / blocked (amber + server-authored `blocked_reasons`) / in-progress (ResponsiveSheet, live SSE steps); clears the nav badge) → **Model** (fixed 4-entry list, localStorage truth + best-effort server sync) → **Remote hosts** (`hosts-section.tsx`, 839 lines: add/recheck/bootstrap/delete with a 4s armed confirm, all in `ResponsiveSheet`s; `id="hosts"` is the `/hosts` redirect target, scrolled manually because the route owns its scroll container :764-778) → **Claude tools** (one button → shared `<AgentToolsSheet>`) → **Onboarding** (replay demo: deletes the demo session, clears the flag, navigates `/`, then **hard `window.location.reload()`**) → **API keys** (masked Anthropic/OpenAI) → **Connection** (origin, version, revealable token, rotate-token dialog) → **Experimental** (Agent Teams switch; degrades to disabled + calm footnote on old servers) → **Snippets** → **Audit log** (last 200).

---

## 6. Command palette & Claude-tools

### `components/command-palette/command-palette.tsx` (1061 lines)
Global `⌘K`/`Ctrl+K` on `window` in **capture phase** with `preventDefault`+`stopPropagation` to beat the focus route's own capture (:145-171). Escape closes; ↑/↓ wrap; Enter picks; substring filter; a leading `/` hides sessions. Row kinds (:84-133): `session` (→ `/focus/{name}`, with `<StatusDot>`), `command` (slash commands merged from `/api/slash-commands` + registry; navigates to the freshest session AND POSTs `/send "/cmd\r"`), `skill` (activates `/<name>`), `mcp` (opens the tools sheet), `action`, `issue`. Actions (:324-390): "View archived sessions", "Manage MCP / skills / commands…", "New group" (only when the overview registered a handler), and four board verbs implemented as in-palette step machines (`PaletteMode` :137-146).
**Absent**: navigate to Board/Files/Scheduler/Settings, new session, start a team, toggle theme, change sort/density/view, open a file, create a schedule. Nothing in the shell advertises ⌘K.

### `components/claude-tools/claude-tools-sheet.tsx` (1354 lines) + `claude-tools-host.tsx` + `stores/claude-tools-store.ts`
One `<ResponsiveSheet>` with MCP · Skills · Commands, grouped by scope with provenance badges. MCP rows expand to transport/command/url + env KEY names with masked `••• set`; opt-in per-row "Check", disable/enable, remove, "Reconnect" (opens Claude's `/mcp` panel in the focused terminal), guided/raw add form (`add-mcp-form.tsx`, 534 lines) requiring an explicit choice + loud warning to write `.mcp.json`. Skills/Commands are tap-to-run in the focused session. Three entry points → one instance: ⌘K, focus title-bar icon, Settings → Claude tools.

---

## 7. Teams UI

`components/team/`: `team-card.tsx` (427), `teammate-chip.tsx`, `teammate-card.tsx`, `team-rollup-badges.tsx`, `member-status-dot.tsx`, `kill-teammate-button.tsx`, `team-width-toggle.tsx`, `teammate-focus.tsx`. Data `hooks/use-teams.ts` → `/api/teams`; per-team density/width in `stores/team-density-store.ts` / `team-width-store.ts`.

Three surfaces: overview `<TeamCard>` (§2) · focus desktop strip (`focus-mode/team-strip-group.tsx` + `teammate-pane.tsx`, sharing `<TeamRollupBadges>` so the roll-up can't drift) · one read-through board per registered team.

**Creation: only from the mobile long-press quick-peek → `<StartTeamSheet>`** (`session-tile/start-team-sheet.tsx`, 307 lines: goal textarea, 1–8 stepper, optional model, fixed dir, cost/restart warning). The from-scratch flow and the overview "+" team option were removed. **Desktop has no path to create a team.**

`<MemberStatusDot>` is a **second** status-dot vocabulary (working / needs_you / idle / offline) beside `<StatusDot>`'s six session statuses. Teammates are the **only** entities with an identity colour (`member.color`).

---

## 8. Session identity today

| Field | Meaning | Where shown | Where set |
|---|---|---|---|
| `name` (slug) | immutable identity: URL, tmux, hooks, SSE key, board link, `$SUPERMUX_SESSION` | info-panel "Name"; fallback label | derived at create (`toSlug`), never editable in UI |
| `display_name` | mutable human label | `displayLabel()` in pickers/chips/dock/archived; `sessionTitle()` on tiles + focus header | new-session sheet + `<NameEditor>` (`session-info-panel.tsx:332`) |
| `task_summary` | Claude's live auto chat title | `sessionTitle()` fallback | server-derived only |
| `desc` | free text, searchable | **nowhere** | **nowhere** |
| `tags[]` | searchable | **nowhere** | **nowhere** |
| `pinned` | first key of smart sort | **nowhere** | **nowhere** |

**Rename**: `components/focus-mode/use-rename-session.ts` → `PATCH /config {display_name}` → invalidate `['sessions']` (the PATCH emits no SSE, so the refetch propagates it). Reachable **only** from `<SessionInfoPanel>` (opened from the focus header, the group-grid tile kebab, or quick-peek's Info). Not from the overview header, not from ⌘K.

**Colour / avatar: confirmed absent for sessions.** Nothing derives a colour, glyph, monogram or avatar. The only per-entity colour is `TeamMember.color`. Providers have no visual mark anywhere — `provider` is plain text in the info panel (`SettingsRows`, :250-307: Provider / Mode / Flags / MCP / Worktree). Two sessions in the same directory are visually identical apart from title text.

---

## 9. Cross-cutting

**Toasts** `components/ui/toast.tsx`: top-centre, `z-9999`, glass capsule, max 3, 2.5s, 4 tones tinting only a leading dot, one optional action (Undo on archive / discard / clear-done). `TOAST_SPRING` from `brand/tokens.ts`.

**Modal inventory — three unrelated shells + native alerts:**
- `ResponsiveSheet` (`components/ui/responsive-sheet.tsx`) forks on `pointer: coarse` (Vaul detent drawer vs shadcn side-Sheet) — **13 consumers**: new-session, start-team, archived, board-card-editor, claude-tools, session-info-panel, updates-panel, hosts-section, snippets-manager, schedule-detail, resume-picker, mobile-compose, tile.
- Raw Vaul `Drawer.Root` — **10 consumers bypassing it**: overview-display-menu, board-switcher, a2hs, session-picker, quick-peek-modal, mobile-action-sheet, snippet-editor, session-picker-sheet, last-send-recall.
- shadcn `<Dialog>` — command palette, settings (rotate token), files (delete), schedule-detail, desktop-compose.
- **4 native `window.confirm()`** for destructive actions: `hooks/use-session-actions.ts:66` (kill session), `:91` (archive running), `claude-tools-sheet.tsx:482`, `routes/focus/desktop.tsx:115`.
- **3 distinct inline-confirm idioms**: tile archive (icon pair, 4s auto-cancel), board `ClearLaneAction` (Cancel + destructive), hosts delete (4s armed), archived delete-forever.

**Connection — two surfaces:** `<ReconnectBanner>` (`components/status-banner/reconnect-banner.tsx`, 275) glass pill, in-flow row, states reconnecting (amber + spinner) / offline (destructive + WifiOff + tap-to-retry) / connected (green flash, 1.2s linger); aggregates SSE + every live terminal. `<ConnectionOverlay>` (224) full-bleed `z-[60]` takeover for offline / server_unreachable / auth_invalid with logo, headline, 44pt CTA and a live "Next try in Ns" countdown. State machine: `stores/api-status-store.ts` + `connection-store.ts` + `hooks/use-connection-status.ts` + `lib/api/fetch-wrap.ts` (installed in `main.tsx:10` before first render).

**Onboarding** `components/onboarding/onboarding-host.tsx`: mounted at root, gated to `/`, eligibility decided once at mount from `lib/onboarding.ts` + the shared `['sessions']` cache (no extra fetch). Sessions exist → `<WelcomeBanner>` → optional 4-step `<TourOverlay>` anchored to `data-tour` (`tile`, `new-session` in `overview.tsx:601,697`; `scheduler` in `layout.tsx:56`). Zero sessions → renders nothing, silently seals the flag. `<FloatingTip>` is a third onboarding primitive. Replay from Settings does a hard reload.

**A2HS** `components/pwa/a2hs-sheet.tsx`: self-gating Vaul sheet, `modal={false}` (a modal drawer causes dead taps under iOS WebKit transformed/backdrop-filter ancestors), once per first non-standalone iOS-Safari load, dismissal in `supermux-a2hs-dismissed`, two illustrated steps + "Got it".

**PWA/platform**: `lib/pwa.ts`, `lib/ios-splash.ts` (~14 media-queried splash links), `hooks/use-standalone-mode.ts` (`data-standalone` on the shell root), `100dvh` + standalone-gated `min-height:100vh` (`globals.css:271-307`), horizontal-only body safe-area padding with every route owning its own top/bottom inset (`:318-327`), and the `safe-header` utility documenting the additive-inset contract (`:203-221`).

---

## 10. Mobile vs desktop divergences, per surface

| Surface | Fork | Where |
|---|---|---|
| Shell | 6-item icon rail + tooltips + theme toggle vs 5 bottom tabs, icon+label, no theme | `layout.tsx:86/164` |
| Active-nav mark | filled pill behind icon vs 4px bar above it | `layout.tsx:114/187` |
| Overview controls | 4 chips vs one "Display" Vaul sheet | `overview.tsx:548-575` |
| Overview density | tiers 1-4 (cols+height) vs tiers 1-2 (height only), separate keys | `lib/overview-size.ts:39`, `ui-store.ts:59-65` |
| Tile interaction | hover peek + hover archive + type-on-hover vs long-press `<QuickPeekModal>` | `tile.tsx:519-554, 1041` |
| Jump chips | visible (`hidden md:inline-flex`) vs hidden | `tile.tsx:814`, `session-row.tsx:108` |
| Session actions | group-grid hover kebab + stopped-peek vs quick-peek Restart/Stop/Archive/Info/Make-it-a-team | `group-grid.tsx:1930`, `quick-peek-modal.tsx` |
| Team creation | **none** vs quick-peek → `<StartTeamSheet>` | `quick-peek-modal.tsx` |
| Board open | master-detail pane vs `<BoardCardEditor>` sheet | `board.tsx:599, 609` |
| Board discard | ⋯ menu vs swipe-left | `board-card.tsx` |
| Board switcher | Radix DropdownMenu vs Vaul half-sheet | `board-switcher.tsx` |
| Files | sidebar + viewer side-by-side vs two-screen push, header hidden while a file is open | `files.tsx:190-364` |
| Scheduler | 5-column grid + labelled button vs stacked meta + `+` icon | `scheduler.tsx:89-103, 154-252` |
| Settings | identical apart from the glass bar's `pt-safe` | `settings.tsx:796-805` |
| Focus | `<DesktopSplit>` (320px strip + pane + dock) vs `<MobileFocus>` (full-bleed, KeyBar, MobileBottomPanel, edge gestures) | `routes/focus.tsx:16-24` |
| Focus nav entry | SideNav item → `<FocusEntry>` redirect | desktop only (`layout.tsx:53`) |
| Every sheet | side-Sheet vs Vaul drag-detent | `responsive-sheet.tsx` |
| Theme control | SideNav dropdown vs Settings only | `layout.tsx:136` / `settings.tsx:825` |

---

# THE 10 BIGGEST ROUGHNESSES

Ranked by how badly each breaks the "one integrated Grok-class product" feel once the focus panel becomes a polished chat renderer.

**1. Sessions have no identity — no colour, no avatar, no provider mark.** Grok's model is "a Bot is a named, coloured, avatared teammate you message" (the purple orb + `Account Manager` pill recurs across chat, list, receipts, memory lines). supermux has *three competing text labels* for the same object (`name` / `display_name` / `task_summary`, resolved differently by `sessionTitle` vs `displayLabel`) and **zero** visual identity. `TeamMember.color` proves the concept exists in-repo — it is simply never applied to sessions. Once the focus panel renders bubbles and receipts, the absence of a stable "who is this agent" token in the header, tile, strip, board chip and palette row will read as unfinished.

**2. `pinned`, `tags` and `desc` are wired end-to-end in API, sort and search — and unreachable from the UI.** `smartSort` sorts by `pinned` first; search matches `desc` and `tags`; the server accepts all three on `PATCH /config`. Not one control exists. Users can *search for* what they can never *set*. A Grok-class overview needs pinning and lightweight categorisation to keep 20 agents legible; this foundation is half-built in a way that looks like a bug.

**3. Route navigation is a hard cut; only tile→focus morphs.** `morph.tsx` is a good implementation with tuned CSS physics and exactly three call sites. Both nav rails use plain `<NavLink>`. Worse, `session-row.tsx:19-34` is a *duplicate, inferior* copy that ignores `prefers-reduced-motion`, and `<MorphLink>` has zero consumers. After the focus panel gets shared-element morphs and spring-choreographed message entry, everything around it will feel like an older application.

**4. The overview sorts three ways at top level; the other four sorts and *all* grouping are trapped inside a drag-and-drop mode.** `smart|alpha|custom` globally; `name|status|recent|age` only per-group, only in custom mode, persisted to localStorage while the global mode is server-persisted (so they don't follow you across devices). No group-by project/dir/provider/host/status — grouping means dragging tiles under hand-named dividers, supported by 2,240 lines of DnD machinery. The largest complexity-to-value inversion in the product.

**5. Tile and row are two different products for the same object.** Tile: title, jump chip, host badge, error badge, needs-input pill, stopped pill, dot↔archive swap, tokens/branch **or** live activity+subagents, ANSI tail, hover live terminal, type-on-hover, inline archive confirm. Row: dot, title, status *word*, branch, jump chip, host badge, needs-input pill, relative timestamp — no activity, tokens, preview, error badge or archive, plus a timestamp the tile never shows. Flipping view mode silently changes which facts about your agents exist.

**6. Four modal shells, three inline-confirm idioms, four raw `window.confirm()`s.** `ResponsiveSheet` (13) / raw Vaul `Drawer.Root` (10 that bypass it) / shadcn `Dialog` (5) / native `confirm()` (4, including "kill this session"). An unstyled OS alert for the most destructive action is the single most jarring artifact on the road to Grok-class polish.

**7. Every route invents its own header and no two agree.** Overview: flex-wrap `h1` + search + 4 chips + 2 buttons, no glass. Board: `h1` + switcher, no actions, no search. Files: the only `.glass safe-header`. Scheduler: `h1` + prose + *two different* primary-action treatments by breakpoint. Settings: scroll-driven fading glass bar over a 34px large title in its own scroll container. Focus: a 44px minimal bar. Six routes, six header languages, title scales 34/24/17. Grok's replica reads continuous precisely because the chrome never restyles between contexts.

**8. Loading, error and empty states are inconsistent, and the shared components are partially bypassed.** Loading: `<TileSkeleton>` grid / `<BoardSkeleton>` / two pulse-bar variants. Errors: shared `<EmptyStatePlaceholder>` (overview) vs a red-circle block (`files.tsx:442`) vs an amber-circle block (`scheduler.tsx:270`) vs bare text + outline button (`board.tsx:517`). Empties: shared in 3 places, bare `text-muted-foreground/60` strings in the board lanes. `brand/copy.ts` defines `EMPTY.sessions/board/files` that only the scheduler consumes.

**9. Discovery is broken: the power features are invisible and the palette cannot navigate.** `[`/`]` density, `g n`, `⌘1..9`, `⌘K` itself, long-press quick-peek, type-on-hover, swipe-to-discard, edge-swipe session switching — none advertised in the shell (the desktop-only `<Kbd>` jump chip is the lone exception). And ⌘K, the one place a user would look, **cannot navigate to Board/Files/Scheduler/Settings, create a session, start a team, change the theme, or change sort/density** — it's a session/slash launcher with four bolted-on board verbs. In the Grok paradigm the command surface *is* the spine.

**10. Team creation is mobile-only, and teams are a bolt-on everywhere else.** `<StartTeamSheet>` is reachable exclusively from the mobile long-press quick-peek; desktop has no path at all. Teams then render through a *parallel* vocabulary: a second status-dot component (working/needs_you/idle/offline) beside `StatusDot`'s six statuses, per-team density and width toggles that exist nowhere else, their own rollup badge language, their own colour rail, read-through boards whose cards silently drop every write affordance, and `?teammate=` as a URL contract. The most Grok-like capability supermux already has is its least integrated UI.

**Honourable mentions:** the new-session sheet can't set description, tags, model or an initial prompt, so a fresh agent has no identity until Claude invents a `task_summary`; the mobile shell has no top chrome at all, so phones get no persistent app identity or global action; overview display prefs are split across header chips, a mobile "Display" sheet and three Settings→Appearance rows with no cross-reference; and `desc`/`tags` search hits are unhighlighted and unexplainable because the matched field is never rendered.
