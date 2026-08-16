// CommandPalette — global ⌘K / Ctrl+K spotlight.
//
// Mounted ONCE in the root <Layout> so the shortcut works on EVERY route — the
// previous implementation (a stubbed `console.info` inside the focus route) was
// the bug. A single document-level keydown listener with `preventDefault` opens
// a Radix Dialog containing a fuzzy filter input + these sections:
//
//   • Sessions   — `useSessions()`, sorted by recency. Pick → navigate to
//                  `/focus/{name}`.
//   • MCP        — servers from the Claude registry (`useClaudeRegistry`, scoped
//                  to the freshest session's project). Pick → open the Claude
//                  tools manager (MCP tab) where check/reconnect/add/remove live.
//   • Skills     — `~/.claude/skills/*` + project + plugin skills (sources the
//                  slash-command list does NOT cover). Pick → activate `/<name>`
//                  in the freshest session, like a command.
//   • Commands   — `useSlashCommands()` (`/api/slash-commands`) MERGED with the
//                  registry's file commands. Pick → navigate to the most-recently-
//                  active session's focus route AND POST `/api/sessions/{name}/send`
//                  `{ text: "/cmd\r" }` so the command runs in that session. If no
//                  sessions exist the row is visible but inert.
//
// Keyboard contract:
//   * ⌘K / Ctrl+K           — toggle open. Always preventDefault (some browsers
//                              steal Ctrl+K for the address bar otherwise).
//   * Escape                — close. Owned by Radix Dialog.
//   * Arrow Up / Down       — move highlight. Wraps at the ends.
//   * Enter                 — pick the highlighted row.
//   * Home / End            — first / last row (this input holds a QUERY, not
//                              prose, so the keys are the list's).
//   * PageUp / PageDown     — a coarse gear through a long list.
//   * Typing                — ranked by `lib/rank.ts`, the app's one matcher. A
//                              leading "/" hides sessions and shows only
//                              commands.
//
// FASE B3: the rows, the list and the keyboard are no longer the palette's own.
// The list is `<EntityPickerView anchor="field">` — the same component the chat
// `@`/`/` popover and the scheduler's PromptField render — and what a key means
// is `composerKeyIntent`'s decision. What is left here is what actually belongs
// to a palette: which rows exist, how they are grouped, and what picking one
// does.

import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Archive,
  Command as CommandIcon,
  FolderPlus,
  ServerCog,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
} from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { useSessions } from '@/hooks/use-sessions'
import { useSlashCommands } from '@/hooks/use-commands'
import { useClaudeRegistry } from '@/hooks/use-claude-tools'
import { settingsRequest } from '@/lib/api/client'
import { type ApiSession, type SlashCommand } from '@/lib/api'
import { SessionFace } from '@/components/roster/session-face'
import { useArchivedSheet } from '@/stores/archived-sheet-store'
import { useNewGroupAction } from '@/stores/new-group-store'
import { useAgentToolsSheet } from '@/stores/claude-tools-store'
import { AgentToolsHost } from '@/components/claude-tools/claude-tools-host'
import { SnippetsManagerHost } from '@/components/snippets/snippets-manager-host'
import { Kbd } from '@/components/ui/kbd'
import { EntityPickerView } from '@/components/ui/entity-picker'
import { resolveEntityTarget, type EntityRow } from '@/lib/entity'
import { rankEntities } from '@/lib/rank'
import { composerKeyIntent, jumpTarget } from '@/components/chat/composer-keys'

// ── Rows ─────────────────────────────────────────────────────────────────────
//
// The palette used to carry five private row interfaces and five hand-rolled
// `includes()` predicates. Fase B3 replaced both: rows are `EntityRow`s from
// `lib/entity.ts` — the same shape the chat popover and the scheduler's
// PromptField now use — and matching is `rankEntities`, the app's one ranker.
//
// THIS IS A USER-VISIBLE BEHAVIOUR CHANGE, and a deliberate one. The palette
// gains subsequence matching and score ordering: `rt` now finds
// `release-train`, and a name that starts with the query outranks one that
// merely contains it. It is called out in the PR body rather than slipped in
// as a refactor, and its ordering has its own unit test — precisely because
// both e2e specs select rows by TEXT and would stay green while the ranking
// silently regressed.
//
// Each row carries the string it is ranked on. Keeping that beside the row
// rather than deriving it inside the matcher is what lets one ranker serve
// six different shapes without knowing what any of them is.
interface Ranked {
  row: EntityRow
  /** What the query is matched against. */
  text: string
  /** Which heading it sits under. */
  group: string
}

// The palette used to run BOARD verbs as step-machines (root → pick-issue →
// send/comment/done). Fase B2 T11 removed the Board page and with it the four
// verbs, their seven steps, the issue rows, the sub-flow breadcrumb and the
// back-out machine: ~250 lines whose only reason to exist was a page that no
// longer does. Issues now live where the work does — session detail and the
// team card — and B3 owns the palette's navigation-to-an-issue result kind.

// ── Hook: the global ⌘K / Ctrl+K listener ────────────────────────────────────
//
// The listener intercepts ⌘/Ctrl+K AT THE WINDOW LEVEL with `preventDefault` so
// the browser's "focus address bar" gesture doesn't swallow it on Chrome/Edge.
// Registered on `window` with capture=true so we beat any per-route or
// per-component listeners.
//
// @param toggle what ⌘K means. A CALLBACK rather than a `setState` the hook
//   owns, because the palette's reset-on-open lives in a wrapper around the
//   setter — and a hook that held the state itself would flip it directly and
//   sail straight past that wrapper (fase B3 T1.4: the palette reopened with
//   the previous search still in the box, contradicting the comment beside the
//   wrapper that says it cannot).
function useGlobalCommandKey(toggle: () => void): void {
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // macOS = metaKey, others = ctrlKey. Reject if Shift/Alt are also held so
      // we never collide with browser dev shortcuts.
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      e.stopPropagation()
      toggle()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [toggle])
}

// ── The palette ──────────────────────────────────────────────────────────────

export function CommandPalette() {
  const [open, setOpenRaw] = React.useState(false)
  const navigate = useNavigate()
  const { sessions } = useSessions()
  const { data: commands = [] } = useSlashCommands()
  // Scope the Claude registry to the freshest session's project (when any), so ⌘K
  // surfaces project skills/MCP too — not just global ones. Resolved once here and
  // reused for both the registry read and command/skill picks (run in this same
  // session). Only fetched while the palette is open (opt-in, no always-on read).
  const freshest = React.useMemo(() => pickFreshestSession(sessions), [sessions])
  const registry = useClaudeRegistry(freshest?.dir?.trim() || undefined, open)
  // Stable identities so the row/command memos don't re-run every render (the
  // `?? []` fallback would otherwise allocate a fresh array each time).
  const regData = registry.data
  const regSkills = React.useMemo(() => regData?.skills ?? [], [regData])
  const regMcp = React.useMemo(() => regData?.mcp ?? [], [regData])
  const regCommands = React.useMemo(() => regData?.commands ?? [], [regData])
  const openArchived = useArchivedSheet((s) => s.openSheet)
  const openClaudeTools = useAgentToolsSheet((s) => s.openSheet)
  // The Overview installs its handler while mounted; absent on every other
  // route, so the "New group" row is conditionally surfaced below.
  const newGroupAction = useNewGroupAction((s) => s.action)

  const [query, setQuery] = React.useState('')
  // `viaKey` rides with the index because the picker scrolls the active row
  // into view for KEYBOARD moves only (fase B3 T2.6). The effect this replaced
  // keyed off the index alone, so a HOVER scrolled the list under the cursor.
  const [active, setActive] = React.useState({ i: 0, viaKey: false })

  // Wrap setOpen so the reset always fires from a user-input handler (Cmd+K
  // toggle, Dialog onOpenChange, pickRow close) rather than from an effect —
  // this keeps `react-hooks/set-state-in-effect` clean. We reset on the
  // open=true transition so the palette never reopens mid-search from a stale
  // filter + highlight.
  const setOpen = React.useCallback<
    React.Dispatch<React.SetStateAction<boolean>>
  >(
    (next) => {
      setOpenRaw((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next
        if (resolved && !prev) {
          setQuery('')
          setActive({ i: 0, viaKey: false })
        }
        return resolved
      })
    },
    [setOpenRaw],
  )

  // ⌘K toggles THROUGH the wrapper, so the reset-on-open above is the one and
  // only definition of "the palette opened" (fase B3 T1.4).
  useGlobalCommandKey(React.useCallback(() => setOpen((v) => !v), [setOpen]))

  // Wrap setQuery so the active-row reset happens from the user-input change
  // event — most-relevant match first, mirroring Spotlight / VSCode — without
  // an effect that the React rules would flag.
  const updateQuery = React.useCallback((next: string) => {
    setQuery(next)
    setActive({ i: 0, viaKey: false })
  }, [])

  // In-app actions (not sessions, not slash commands). Hidden in slash mode
  // (a leading "/" means the user wants a command). Stable identity so arrow-key
  // state survives re-renders.
  const actions: Ranked[] = React.useMemo(() => {
    const mk = (
      id: string,
      label: string,
      keywords: string,
      icon: EntityRow['icon'],
      run: () => void,
    ): Ranked => ({
      row: { id, kind: 'action', label, icon, run },
      // Keywords are ranked on but never shown. A user who types "trash"
      // should find "View archived sessions"; a user reading the list should
      // not see a bag of synonyms under it.
      text: `${label} ${keywords}`,
      group: 'Actions',
    })
    const base = [
      mk(
        'action:view-archived',
        'View archived sessions',
        'archived archive restore recover trash deleted purge',
        Archive,
        openArchived,
      ),
      mk(
        'action:claude-tools',
        'Manage MCP / skills / commands…',
        'mcp skills commands tools claude manage servers plugins config',
        SlidersHorizontal,
        // Scope to the freshest session's project (if any) so the project-scoped
        // reads resolve; falls back to global-only when there are no sessions.
        () => openClaudeTools(pickFreshestSession(sessions)?.name ?? null),
      ),
    ]
    // "New group" is only meaningful on the Overview (which installs its
    // handler via `new-group-store`); on every other route the action is null
    // and we hide the row so the palette doesn't surface a no-op.
    if (newGroupAction) {
      base.push(
        mk(
          'action:new-group',
          'New group',
          'group new section divider organize overview folder',
          FolderPlus,
          newGroupAction,
        ),
      )
    }
    return base
  }, [openArchived, openClaudeTools, sessions, newGroupAction])

  // Merge the slash-command list (built-ins + supermux skills) with the registry's
  // file commands (e.g. ~/.claude/commands/*.md, project commands) — deduped by
  // name, built-ins skipped (already in the slash list). This is what makes ⌘K
  // complete: a `/command` that lives only as a file now shows up too.
  const mergedCommands = React.useMemo<SlashCommand[]>(() => {
    const byName = new Map<string, SlashCommand>()
    for (const c of commands) byName.set(c.cmd.replace(/^\//, ''), c)
    for (const c of regCommands) {
      if (c.scope === 'builtin') continue
      if (!byName.has(c.name)) {
        byName.set(c.name, { cmd: `/${c.name}`, desc: c.description })
      }
    }
    return [...byName.values()]
  }, [commands, regCommands])

  // Skill names already shown as commands (rare, but a DB skill + a same-named
  // file skill could collide) — skip those so a `/name` never appears twice.
  const commandNames = React.useMemo(
    () => new Set(mergedCommands.map((c) => c.cmd.replace(/^\//, ''))),
    [mergedCommands],
  )

  // Run a slash command / skill in the freshest session: navigate to it, then
  // POST the text + carriage return to its send endpoint so the agent runs it.
  // No session → close (the overview empty-state teaches booting one). Shared by
  // command AND skill picks (skills are `/<name>` slash-invokable). Fire-and-
  // forget; `settingsRequest` reads the bearer off env.ts.
  const runSlash = React.useCallback(
    (text: string) => {
      const target = pickFreshestSession(sessions)
      if (!target) {
        setOpen(false)
        return
      }
      setOpen(false)
      navigate(`/focus/${encodeURIComponent(target.name)}`)
      void settingsRequest(`/api/sessions/${encodeURIComponent(target.name)}/send`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      }).catch((e) => console.warn('command-palette: send failed', e))
    },
    [sessions, navigate, setOpen],
  )

  // ONE RANKER, SIX SHAPES (fase B3 T4.2). Every candidate is turned into a
  // `{ row, text, group }` and handed to `rankEntities` — the same function the
  // chat popover and the scheduler's PromptField use. The five `includes()`
  // predicates this replaced are gone, and with them the possibility of six
  // surfaces disagreeing about what "matches" means.
  //
  // GROUPING IS ORDERING, and ordering is the group's, not the ranker's. Rows
  // are ranked WITHIN a group and the groups keep a fixed order, so a fuzzy
  // score can never float a `/command` above the session the user is looking
  // at. That is the one thing a global sort would get wrong here.
  const groups: { label: string; rows: EntityRow[] }[] = React.useMemo(() => {
    const slashMode = query.startsWith('/')
    const cmdQ = slashMode ? query.slice(1) : query
    const rank = (items: Ranked[], q: string) =>
      rankEntities(items, q, (r) => r.text).map((r) => r.row)

    const sessionRows: Ranked[] = slashMode
      ? []
      : sessions.map((s) => ({
          row: {
            id: `session:${s.name}`,
            kind: 'session',
            label: s.name,
            meta: s.task_summary ?? undefined,
            slug: s.name,
            // The session's own face (fase B2 T2). 24px is the picker rung, and
            // the row is deliberately STATIC: a mark that blinks under the
            // keyboard cursor is motion the user did not ask for.
            leading: (
              <SessionFace
                name={s.name}
                status={s.status}
                size={24}
                animate={false}
                className="shrink-0"
              />
            ),
          },
          text: `${s.name} ${s.task_summary ?? ''}`,
          group: 'Sessions',
        }))

    // MCP servers — not slash commands, so hidden in slash ("/") mode. Picking
    // one does not RUN it: MCP is managed, so the row opens the Claude tools
    // manager on the MCP tab, where check / reconnect / add / remove live.
    const mcpRows: Ranked[] = slashMode
      ? []
      : regMcp.map((m) => ({
          row: {
            id: `mcp:${m.scope}:${m.name}`,
            kind: 'action',
            label: m.name,
            meta: m.provenance === 'cloud' ? 'cloud · manage' : 'MCP · manage',
            icon: ServerCog,
            run: () => openClaudeTools(freshest?.name ?? null),
          },
          text: `${m.name} ${m.transport} ${m.provenance}`,
          group: 'MCP',
        }))

    // Skills — slash-invokable (`/<name>`), so they filter on the command query
    // and show in slash mode too; skip any already listed as a command.
    const skillRows: Ranked[] = regSkills
      .filter((s) => !commandNames.has(s.name))
      .map((s) => ({
        row: {
          id: `skill:${s.name}`,
          kind: 'skill',
          label: `/${s.name}`,
          meta: s.description || 'skill',
          icon: Sparkles,
          run: () => runSlash(`/${s.name}\r`),
        },
        text: `${s.name} ${s.description}`,
        group: 'Skills',
      }))

    const commandRows: Ranked[] = mergedCommands.map((c) => ({
      row: {
        id: `command:${c.cmd}`,
        kind: 'command',
        label: c.cmd,
        meta: c.desc,
        icon: TerminalSquare,
        run: () => runSlash(`${c.cmd}\r`),
      },
      text: `${c.cmd} ${c.desc ?? ''}`,
      group: 'Commands',
    }))

    return [
      { label: 'Sessions', rows: rank(sessionRows, query) },
      { label: 'Actions', rows: rank(slashMode ? [] : actions, query) },
      { label: 'MCP', rows: rank(mcpRows, query) },
      { label: 'Skills', rows: rank(skillRows, cmdQ) },
      { label: 'Commands', rows: rank(commandRows, cmdQ) },
    ].filter((g) => g.rows.length > 0)
  }, [
    sessions,
    actions,
    mergedCommands,
    commandNames,
    regMcp,
    regSkills,
    query,
    freshest,
    openClaudeTools,
    runSlash,
  ])

  // The flat list the keyboard walks. Headings are not in it — they are not
  // focusable and the arrows skip them, which is the whole reason grouping is
  // rendered rather than interleaved.
  const rows = React.useMemo(() => groups.flatMap((g) => g.rows), [groups])

  // Which flat index each heading opens at. A lookup rather than a nested
  // render, so the list stays ONE listbox with one contiguous run of options —
  // "how many results are there" has to stay answerable.
  const headingAt = React.useMemo(() => {
    const at = new Map<number, string>()
    let i = 0
    for (const g of groups) {
      at.set(i, g.label)
      i += g.rows.length
    }
    return (index: number) => at.get(index)
  }, [groups])

  // Clamp the highlight whenever the row list shrinks (so a narrowing filter
  // never leaves the active index past the end).
  const clampedActive = rows.length === 0 ? 0 : Math.min(active.i, rows.length - 1)

  // Pick + dismiss. ONE INDIRECTION (fase B3 T2.1): the row either carries a
  // `run` or names an entity, and `resolveEntityTarget` decides which route
  // that entity lives at. When B2's successor gives an issue a surface of its
  // own, it changes in that function — not here, and not in the chat picker,
  // and not in the chip renderer.
  const pickRow = React.useCallback(
    (row: EntityRow | undefined) => {
      if (!row) return
      const target = resolveEntityTarget(row)
      if (!target) return
      setOpen(false)
      if ('run' in target) target.run()
      else navigate(target.to)
    },
    [navigate, setOpen],
  )

  // THE THIRD KEYBOARD ENGINE, DELETED (fase B3 T4.1). What a key means is
  // `composerKeyIntent`'s decision and where a coarse jump lands is
  // `jumpTarget`'s — both pure, both truth-tabled in
  // `tests/unit/entity-picker-keys.test.ts`, and both now shared with the chat
  // popover and the scheduler's PromptField.
  //
  // `caret: false` — this input holds a QUERY, not prose, so Home/End address
  // the list rather than the line. That is the one cell where the two anchors
  // disagree, and it is a parameter rather than a second reducer.
  //
  // Still a WINDOW-level listener: the input must not have to consume the
  // events explicitly, and Enter has to work from the empty state too.
  //
  // T4.5: the palette's own `scrollIntoView` effect is gone. The picker owns
  // it now, and it only fires for keyboard moves — which is the behaviour this
  // effect had by accident (it keyed off the index, so a HOVER scrolled too).
  React.useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      const intent = composerKeyIntent(e, {
        draft: query,
        active: false,
        picker: true,
        caret: false,
      })
      switch (intent) {
        case 'picker-down':
          e.preventDefault()
          setActive((a) => ({ i: rows.length === 0 ? 0 : (a.i + 1) % rows.length, viaKey: true }))
          break
        case 'picker-up':
          e.preventDefault()
          setActive((a) => ({
            i: rows.length === 0 ? 0 : (a.i - 1 + rows.length) % rows.length,
            viaKey: true,
          }))
          break
        case 'picker-first':
        case 'picker-last':
        case 'picker-page-up':
        case 'picker-page-down':
          e.preventDefault()
          setActive((a) => ({
            i: jumpTarget(
              intent.replace('picker-', '') as 'first' | 'last' | 'page-up' | 'page-down',
              a.i,
              rows.length,
            ),
            viaKey: true,
          }))
          break
        case 'picker-accept':
          // Enter picks. Tab does NOT: in a dialog it is the browser's, and a
          // palette that swallowed it would be a focus trap.
          if (e.key !== 'Enter') return
          e.preventDefault()
          pickRow(rows[clampedActive])
          break
      }
      // `picker-close` (Escape) is deliberately unhandled — Radix's Dialog owns
      // dismissal, and taking it here would close the palette twice.
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, rows, clampedActive, pickRow, query])

  const placeholder = 'Jump to a session or run a /command'

  return (
    <>
    {/* The Claude tools manager (skills/MCP/commands) — mounted here, alongside
     *  the palette, so it shares the shell-level mount the palette already has in
     *  <Layout>. The ⌘K "Manage MCP / skills / commands…" action, the focus
     *  title-bar icon, and the Settings section all open this ONE instance via
     *  the claude-tools store. Opt-in — only in the DOM as an overlay while
     *  open. */}
    <AgentToolsHost />
    <SnippetsManagerHost />
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        // Override the default Dialog padding — we want a flush input + list.
        className="top-[20%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0"
        // Don't auto-focus the close button; let the input take focus.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <CommandIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => updateQuery(e.target.value)}
            placeholder={placeholder}
            aria-label="Command palette"
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
          <Kbd className="hidden sm:inline-flex">Esc</Kbd>
        </div>
        {/* THE LIST IS NOT THE PALETTE'S ANY MORE (fase B3 T4.1). `PaletteRowView`
            and the hand-rolled listbox are gone; this is the same component the
            chat `@`/`/` popover and the scheduler's PromptField render. The
            `aria-label` is preserved verbatim because both e2e specs select the
            list by it — a correct rebuild leaves them untouched. */}
        <EntityPickerView
          anchor="field"
          rows={rows}
          activeIndex={clampedActive}
          ariaLabel="Palette results"
          headingAt={headingAt}
          emptyLabel={
            query ? `No match for “${query}”.` : 'Type to filter, or pick a row.'
          }
          scrollOnActive={active.viaKey}
          onHover={(i) => setActive({ i, viaKey: false })}
          onPick={pickRow}
          testId="command-palette"
          rowTestId="command-palette-row"
        />
      </DialogContent>
    </Dialog>
    </>
  )
}

/** Most recently active session (the same notion the overview's sort uses) so
 *  command picks land in the session the user most likely cares about. */
function pickFreshestSession(sessions: ApiSession[]): ApiSession | null {
  if (sessions.length === 0) return null
  // Prefer running sessions; within that, prefer the most recent activity.
  const running = sessions.filter((s) => s.status !== 'stopped')
  const pool = running.length > 0 ? running : sessions
  return [...pool].sort((a, b) => {
    const aAct = a.last_activity ?? 0
    const bAct = b.last_activity ?? 0
    if (bAct !== aAct) return bAct - aAct
    return a.name.localeCompare(b.name)
  })[0]
}

export default CommandPalette
