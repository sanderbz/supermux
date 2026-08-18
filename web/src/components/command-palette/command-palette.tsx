// CommandPalette — global ⌘K / Ctrl+K spotlight.
//
// Mounted ONCE in the root <Layout> so the shortcut works on EVERY route — the
// previous implementation (a stubbed `console.info` inside the focus route) was
// the bug. A single document-level keydown listener with `preventDefault` opens
// a Radix Dialog containing a fuzzy filter input + these sections:
//
//   • Sessions   — `useSessions()`, sorted by recency. Pick → navigate to
//                  `/focus/{name}`.
//   • Go to      — the app's four routes, the two Settings anchors (/scheduler
//                  and /hosts are already redirects onto them) and the theme
//                  flip. Added because the palette reached NONE of them: an
//                  empty query offered four headings and `settings` returned
//                  zero rows, so the discovery spine could not discover a page.
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
  Bot,
  CalendarClock,
  Command as CommandIcon,
  FolderClosed,
  FolderPlus,
  LayoutGrid,
  Moon,
  Plug,
  ServerCog,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Terminal,
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
import { useNewSessionAction } from '@/stores/new-session-store'
import { useAgentToolsSheet } from '@/stores/claude-tools-store'
import { useOverlayGate } from '@/stores/overlay-gate-store'
import { AgentToolsHost } from '@/components/claude-tools/claude-tools-host'
import { SnippetsManagerHost } from '@/components/snippets/snippets-manager-host'
import { Kbd } from '@/components/ui/kbd'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { EntityPickerView } from '@/components/ui/entity-picker'
import { resolveEntityTarget, type EntityRow } from '@/lib/entity'
import { rankEntities, type RankText } from '@/lib/rank'
import { composerKeyIntent, jumpTarget } from '@/components/chat/composer-keys'
import { useTheme } from '@/components/theme-provider'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useUI } from '@/stores/ui-store'
import { botModeOn, BOT_KILL_SWITCH_KEY } from '@/lib/bot-mode-flag'
import { GROK_KILL_SWITCH_KEY } from '@/lib/grok-mode-flag'

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
/** The combobox relationship, as two ids. Module constants rather than
 *  `useId`: they are referenced from an `aria-controls` on one element and an
 *  `id` on another, and a stable literal is what makes both greppable in an
 *  ax-tree dump. */
const LISTBOX_ID = 'command-palette-listbox'
const optionId = (index: number) => `command-palette-option-${index}`

interface Ranked {
  row: EntityRow
  /**
   * What the query is matched against.
   *
   * A `{ label, extra }` pair rather than one joined sentence (blocker fix):
   * ranking a command on `"/cmd <its whole description>"` let a subsequence
   * walk the description and win the row — `dark` offered `/supermux-schedule`
   * as its only result, and Enter on that row POSTs the command into a live
   * agent. The name is what a query must match; the description can only ever
   * find its row as a substring, below every name hit.
   */
  text: RankText
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
  const newSessionAction = useNewSessionAction((s) => s.action)

  const { toast } = useToast()
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  // TOUCH IS A DIFFERENT SURFACE, and the palette was the one picker that never
  // learned it: rows measured 38px against the primitive's documented 44pt
  // phone rung (the chat picker, which passes surface="phone", measures 47px on
  // the same viewport), and the box was pinned at top-[20%] with no safe-area
  // inset and no allowance for a soft keyboard. Same fork every other sheet in
  // the app uses.
  const coarse = useMediaQuery('(pointer: coarse)')

  // GROK MODE — the palette is a Radix Dialog PORTALLED to <body>, a sibling of
  // the shell root, so the `data-grok` attribute layout puts on that root cannot
  // reach it (styles/grok-mode.css WS7). Read the flag once at mount — the same
  // decision (`grokModeOn`) and the same "read once, don't re-render on toggle"
  // discipline layout.tsx uses — and stamp `data-grok` on the Content ITSELF
  // below, so the picker's glass rules apply to the portalled box. Absent when
  // off, so the default palette's DOM is byte-identical.
  const [grok] = React.useState(() =>
    botModeOn(
      useUI.getState().botMode,
      typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem(BOT_KILL_SWITCH_KEY),
      typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem(GROK_KILL_SWITCH_KEY),
    ),
  )

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
  //
  // The same transition is also where we remember the OPENER. `onOpenAutoFocus`
  // is prevented below (the input takes focus instead), and Radix only restores
  // focus on close for the element it moved focus away from itself — so without
  // this, Escape dropped focus to <body> and the next Tab landed on "Skip to
  // content", i.e. a keyboard user got thrown back to the top of the document
  // (WCAG 2.4.3). A ref, not state: nothing renders from it.
  const opener = React.useRef<HTMLElement | null>(null)
  const setOpen = React.useCallback<
    React.Dispatch<React.SetStateAction<boolean>>
  >(
    (next) => {
      setOpenRaw((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next
        if (resolved && !prev) {
          const el = document.activeElement
          opener.current = el instanceof HTMLElement && el !== document.body ? el : null
          setQuery('')
          setActive({ i: 0, viaKey: false })
        }
        return resolved
      })
    },
    [setOpenRaw],
  )

  // Restore focus to whatever the user was on when the palette opened —
  // Escape, a second ⌘K, an outside click and a pick all funnel through
  // Radix's close, so this is the single restore point.
  const restoreFocus = React.useCallback((e: Event) => {
    const el = opener.current
    opener.current = null
    // Still in the document? A pick that navigated away may have unmounted it;
    // in that case let Radix do its default thing.
    if (!el || !el.isConnected) return
    e.preventDefault()
    el.focus()
  }, [])

  // Raise the shared overlay gate while the palette is open, so top-anchored
  // coachmarks (the onboarding WelcomeBanner) suppress themselves instead of
  // rendering over the palette's search input + first rows. The cleanup lowers
  // the gate on close (open→false) AND on unmount, and the store is a counter so
  // a second overlay can't let this one's close prematurely re-show the banner.
  React.useEffect(() => {
    if (!open) return
    return useOverlayGate.getState().openOverlay()
  }, [open])

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

  // WHERE THE APP'S FOUR DESTINATIONS LIVE (fase B3 T4.3 / deliverable 5,
  // shipped late). The palette reached NONE of them: an empty query offered
  // SESSIONS / ACTIONS / MCP / COMMANDS and nothing else, `settings` returned
  // zero rows, and `files` returned only an unrelated slash command. A
  // discovery spine that cannot reach Settings is a session switcher.
  //
  // Deep links rather than a second route table: /scheduler and /hosts are
  // already redirects onto these two Settings anchors (App.tsx), so the hash IS
  // the address — the same fact `lib/entity.ts` writes down for schedule and
  // host rows.
  const goRows: Ranked[] = React.useMemo(() => {
    const go = (
      to: string,
      label: string,
      keywords: string,
      icon: EntityRow['icon'],
    ): Ranked => ({
      row: { id: `go:${to}`, kind: 'action', label, icon, run: () => navigate(to) },
      text: { label, extra: keywords },
      group: 'Go to',
    })
    return [
      go('/', 'Overview', 'home sessions roster tiles dashboard start', LayoutGrid),
      go('/focus', 'Focus', 'terminal session pane current agent', Terminal),
      go('/files', 'Files', 'file tree browse edit diff working directory', FolderClosed),
      go('/store', 'Connectors', 'connector store mcp integrations add tools plugins connect catalog', Plug),
      go('/settings', 'Settings', 'preferences config options update theme', SettingsIcon),
      go(
        '/settings#schedules',
        'Schedules',
        'scheduler cron recurring timer prompt later',
        CalendarClock,
      ),
      go('/settings#hosts', 'Remote hosts', 'ssh host remote machine registry', ServerCog),
      {
        row: {
          id: 'go:theme',
          kind: 'action',
          label: dark ? 'Switch to light theme' : 'Switch to dark theme',
          icon: dark ? Sun : Moon,
          run: () => setTheme(dark ? 'light' : 'dark'),
        },
        text: {
          label: 'theme',
          extra: 'dark light appearance colour color mode switch toggle',
        },
        group: 'Go to',
      },
    ]
  }, [navigate, dark, setTheme])

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
      // not see a bag of synonyms under it. They live in `extra`, so they can
      // only match as a SUBSTRING — a synonym bag is exactly the string a
      // scattered subsequence used to walk.
      text: { label, extra: keywords },
      group: 'Actions',
    })
    const base = [
      // The create verb — FIRST, so ⌘K has an obvious way to start a bot. Only
      // present while a surface (roster/overview) has installed the opener.
      ...(newSessionAction
        ? [
            mk(
              'action:new-bot',
              'New bot',
              'new bot session create hire agent start spawn',
              Bot,
              newSessionAction,
            ),
          ]
        : []),
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
  }, [openArchived, openClaudeTools, sessions, newGroupAction, newSessionAction])

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
  //
  // IT NAMES ITS TARGET, BEFORE AND AFTER (blocker fix). A slash row is the one
  // palette row that WRITES — it POSTs into a live agent chosen by recency, not
  // by the user — so which session that is has to be on the row before Enter
  // (the `warn` badge below carries `freshest.name`) and has to be said again
  // after it fires. A fire-and-forget write with no receipt is how a mistyped
  // query became a message in somebody's session.
  const runSlash = React.useCallback(
    (text: string) => {
      const target = pickFreshestSession(sessions)
      const label = text.replace(/\r$/, '')
      if (!target) {
        setOpen(false)
        toast({ message: `No running session to run ${label} in`, tone: 'error' })
        return
      }
      setOpen(false)
      navigate(`/focus/${encodeURIComponent(target.name)}`)
      toast({ message: `Ran ${label} in ${target.name}`, tone: 'active' })
      void settingsRequest(`/api/sessions/${encodeURIComponent(target.name)}/send`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      }).catch((e) => {
        console.warn('command-palette: send failed', e)
        toast({ message: `Couldn’t run ${label} in ${target.name}`, tone: 'error' })
      })
    },
    [sessions, navigate, setOpen, toast],
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
    // The session a slash row would write to, said on the row itself.
    const sendTarget = freshest ? `runs in ${freshest.name}` : 'no session'
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
          text: { label: s.name, extra: s.task_summary ?? undefined },
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
          text: { label: m.name, extra: `${m.transport} ${m.provenance}` },
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
          // WHERE IT WILL RUN, ON THE ROW. `runSlash` picks the freshest
          // session; a row that fires a write on one keystroke has to say
          // which session that is before the keystroke, not after.
          warn: sendTarget,
          run: () => runSlash(`/${s.name}\r`),
        },
        text: { label: s.name, extra: s.description },
        group: 'Skills',
      }))

    const commandRows: Ranked[] = mergedCommands.map((c) => ({
      row: {
        id: `command:${c.cmd}`,
        kind: 'command',
        label: c.cmd,
        meta: c.desc,
        icon: TerminalSquare,
        warn: sendTarget,
        run: () => runSlash(`${c.cmd}\r`),
      },
      text: { label: c.cmd.replace(/^\//, ''), extra: c.desc ?? undefined },
      group: 'Commands',
    }))

    return [
      { label: 'Sessions', rows: rank(sessionRows, query) },
      // Destinations before verbs: "where do I want to be" is the commoner
      // question, and it is the one the palette could not answer at all.
      { label: 'Go to', rows: rank(slashMode ? [] : goRows, query) },
      { label: 'Actions', rows: rank(slashMode ? [] : actions, query) },
      { label: 'MCP', rows: rank(mcpRows, query) },
      { label: 'Skills', rows: rank(skillRows, cmdQ) },
      { label: 'Commands', rows: rank(commandRows, cmdQ) },
    ].filter((g) => g.rows.length > 0)
  }, [
    sessions,
    goRows,
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
        //
        // On a coarse pointer the box moves to the TOP of the safe area rather
        // than 20% down: the palette has to stay above the soft keyboard, and
        // the keyboard is the whole bottom of the screen. Width goes
        // edge-to-edge minus a gutter, because 36rem on a 390px viewport is
        // just "the screen with a stripe missing".
        className={cn(
          'max-w-xl translate-y-0 gap-0 overflow-hidden p-0',
          coarse
            ? 'top-[max(env(safe-area-inset-top),0.5rem)] w-[calc(100vw-1rem)] max-w-none'
            : 'top-[20%]',
        )}
        // Don't auto-focus the close button; let the input take focus.
        onOpenAutoFocus={(e) => e.preventDefault()}
        // …and hand focus back to the opener on the way out.
        onCloseAutoFocus={restoreFocus}
        // WS7 — the grok gate on the portalled box. Only present when grok is on,
        // so the default palette's DOM is unchanged.
        data-grok={grok ? '' : undefined}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        {/* pr-11 on the row, not on the chip: the dialog's own close ✕ is
            `absolute right-4 top-4` and was overlapping the "Esc" Kbd by 16px
            at every desktop width, so the chip rendered as "Es✕". The row has
            to reserve the corner the ✕ occupies. */}
        <div
          className="flex items-center gap-3 border-b border-border py-3 pl-4 pr-11"
          // WS7 hook — under grok the seam becomes a 0.5px hairline. Marker only
          // present when grok is on, so the default DOM is untouched.
          data-grok-search={grok ? '' : undefined}
        >
          <CommandIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => updateQuery(e.target.value)}
            placeholder={placeholder}
            aria-label="Command palette"
            // THE FOUR ATTRIBUTES THAT MAKE IT A COMBOBOX. Focus never leaves
            // this input — the arrows move `aria-selected` on a row the input
            // has to POINT AT, or a screen reader is told nothing at all as the
            // highlight travels. The primitive has exposed `listboxId` /
            // `optionId` for exactly this since B3 and the palette passed
            // neither, while `chat/composer.tsx` sets the same four correctly on
            // the same component. This is that, verbatim.
            role="combobox"
            aria-autocomplete="list"
            aria-expanded
            aria-controls={LISTBOX_ID}
            aria-activedescendant={rows.length > 0 ? optionId(clampedActive) : undefined}
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
          // 44pt rows on touch (the primitive's own rung) and a list short
          // enough to clear a raised keyboard.
          surface={coarse ? 'phone' : 'desktop'}
          maxHeight={coarse ? 'max-h-[min(360px,42dvh)]' : undefined}
          rows={rows}
          activeIndex={clampedActive}
          listboxId={LISTBOX_ID}
          optionId={optionId}
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
