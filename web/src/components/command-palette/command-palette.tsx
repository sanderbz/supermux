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
//   * Typing                — filters by case-insensitive substring. A leading
//                              "/" hides sessions and shows only commands.
//
// VISUAL: ≥44pt rows (h-11), sentence-case labels (NO uppercase), mono command
// text, spring transitions (no `transition: all`).

import * as React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Archive,
  Bot,
  CheckCircle2,
  ChevronLeft,
  Command as CommandIcon,
  FolderPlus,
  MessageSquare,
  Play,
  Send,
  ServerCog,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  User,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { useSessions } from '@/hooks/use-sessions'
import { useSlashCommands } from '@/hooks/use-commands'
import { useClaudeRegistry } from '@/hooks/use-claude-tools'
import { useBoard } from '@/hooks/use-board'
import { useStartAgent, useSendToAgent, claimErrorMessage } from '@/hooks/use-send-to-agent'
import { useToast } from '@/components/ui/use-toast'
import { settingsRequest } from '@/lib/api/client'
import {
  boardApi,
  type ApiSession,
  type BoardIssue,
  type McpEntry,
  type SkillEntry,
  type SlashCommand,
} from '@/lib/api'
import { StatusDot } from '@/components/session-tile/status-dot'
import { useArchivedSheet } from '@/stores/archived-sheet-store'
import { useNewGroupAction } from '@/stores/new-group-store'
import { useClaudeToolsSheet } from '@/stores/claude-tools-store'
import { ClaudeToolsHost } from '@/components/claude-tools/claude-tools-host'
import { Kbd } from '@/components/ui/kbd'

// ── Row shape: one normalized item the palette can render & invoke ────────────

interface SessionRow {
  kind: 'session'
  id: string // `session:${name}`
  name: string
  session: ApiSession
}

interface CommandRow {
  kind: 'command'
  id: string // `command:${cmd}`
  cmd: SlashCommand
}

/** A skill from the Claude registry (`~/.claude/skills/*`, project, plugin —
 *  sources the slash-command list does NOT cover). Picking activates `/<name>` in
 *  the freshest session's terminal, exactly like a command. */
interface SkillRow {
  kind: 'skill'
  id: string // `skill:${name}`
  skill: SkillEntry
}

/** An MCP server from the Claude registry. Picking opens the Claude tools manager
 *  (scoped to the freshest session) on the MCP tab — MCP is managed, not "run". */
interface McpRow {
  kind: 'mcp'
  id: string // `mcp:${scope}:${name}`
  mcp: McpEntry
}

/** An in-app action (not a session, not a slash command) — e.g. "View archived
 *  sessions", or a board verb that opens a sub-flow. Routed to a local handler
 *  rather than a pty send. `group` lets the palette scope a row to a route. */
interface ActionRow {
  kind: 'action'
  id: string // `action:${key}`
  label: string
  keywords: string
  icon: typeof Archive
  run: () => void
}

/** A board issue offered as a pick target inside a board sub-flow (pick the
 *  issue to send / comment on / mark done). */
interface IssueRow {
  kind: 'issue'
  id: string // `issue:${issue.id}`
  issue: BoardIssue
}

type PaletteRow = SessionRow | CommandRow | SkillRow | McpRow | ActionRow | IssueRow

/** Board ⌘K verbs run as small step-machines inside the palette so the keyboard
 *  flow matches the overview's jump-session muscle memory (no new surface):
 *    root → pick-issue → (send: pick-session | comment: type | done: act)
 *  `null` is the normal palette (sessions + commands + actions). */
type PaletteMode =
  | { step: 'root' }
  | { step: 'send-pick-issue' }
  | { step: 'send-pick-session'; issue: BoardIssue }
  | { step: 'start-pick-issue' }
  | { step: 'start-pick-session'; issue: BoardIssue }
  | { step: 'comment-pick-issue' }
  | { step: 'comment-type'; issue: BoardIssue }
  | { step: 'done-pick-issue' }

// ── Hook: the global ⌘K / Ctrl+K listener ────────────────────────────────────
//
// The listener intercepts ⌘/Ctrl+K AT THE WINDOW LEVEL with `preventDefault` so
// the browser's "focus address bar" gesture doesn't swallow it on Chrome/Edge.
// Stored on `window` (not document) with capture=true so we beat any per-route
// or per-component listeners. The hook returns `[open, setOpen]`.

function useGlobalCommandKey(): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // macOS = metaKey, others = ctrlKey. Reject if Shift/Alt are also held so
      // we never collide with browser dev shortcuts.
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      e.stopPropagation()
      setOpen((v) => !v)
    }
    // Capture phase so we run before any sub-tree keydown handlers — the focus
    // route's `useKeyboardCapture` also wants ⌘K, but only delegates to a stub;
    // we own the real palette now, so winning the race is correct.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
  return [open, setOpen]
}

// ── Filtering: case-insensitive substring on session name / task / command ───

function matchesSession(s: ApiSession, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  if (s.name.toLowerCase().includes(needle)) return true
  if (s.task_summary?.toLowerCase().includes(needle)) return true
  return false
}

function matchesCommand(c: SlashCommand, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  if (c.cmd.toLowerCase().includes(needle)) return true
  if (c.desc?.toLowerCase().includes(needle)) return true
  return false
}

function matchesSkill(s: SkillEntry, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    s.name.toLowerCase().includes(needle) ||
    s.description.toLowerCase().includes(needle)
  )
}

function matchesMcp(m: McpEntry, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    m.name.toLowerCase().includes(needle) ||
    m.transport.toLowerCase().includes(needle) ||
    m.provenance.toLowerCase().includes(needle)
  )
}

function matchesAction(a: ActionRow, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    a.label.toLowerCase().includes(needle) ||
    a.keywords.toLowerCase().includes(needle)
  )
}

function matchesIssue(i: BoardIssue, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    i.title.toLowerCase().includes(needle) ||
    i.id.toLowerCase().includes(needle)
  )
}

// ── The palette ──────────────────────────────────────────────────────────────

export function CommandPalette() {
  const [open, setOpenRaw] = useGlobalCommandKey()
  const navigate = useNavigate()
  const location = useLocation()
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
  const openClaudeTools = useClaudeToolsSheet((s) => s.openSheet)
  // The Overview installs its handler while mounted; absent on every other
  // route, so the "New group" row is conditionally surfaced below.
  const newGroupAction = useNewGroupAction((s) => s.action)
  const board = useBoard()
  const { toast } = useToast()
  const { sendToAgent } = useSendToAgent()
  const { startAgent } = useStartAgent()

  // Board verbs only surface on the board route (so they don't clutter the
  // palette elsewhere). `useLocation` keeps it reactive to client-side nav.
  const onBoard = location.pathname.startsWith('/board')

  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)
  // The board sub-flow step machine (root = normal palette).
  const [mode, setMode] = React.useState<PaletteMode>({ step: 'root' })
  const [comment, setComment] = React.useState('')
  const [busy, setBusy] = React.useState(false)

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
          setActive(0)
          setMode({ step: 'root' })
          setComment('')
          setBusy(false)
        }
        return resolved
      })
    },
    [setOpenRaw],
  )

  // Enter a board sub-flow: clear the filter + highlight so the picker starts
  // fresh (mirrors the open-transition reset, from a user-input handler).
  const enterMode = React.useCallback((next: PaletteMode) => {
    setMode(next)
    setQuery('')
    setActive(0)
    setComment('')
  }, [])

  // Wrap setQuery so the active-row reset happens from the user-input change
  // event — most-relevant match first, mirroring Spotlight / VSCode — without
  // an effect that the React rules would flag.
  const updateQuery = React.useCallback((next: string) => {
    setQuery(next)
    setActive(0)
  }, [])

  // In-app actions (not sessions, not slash commands). Hidden in slash mode
  // (a leading "/" means the user wants a command). Stable identity so arrow-key
  // state survives re-renders. Board verbs are appended only on the board route
  // and open a sub-flow (pick issue → …) rather than running immediately.
  const actions: ActionRow[] = React.useMemo(() => {
    const base: ActionRow[] = [
      {
        kind: 'action',
        id: 'action:view-archived',
        label: 'View archived sessions',
        keywords: 'archived archive restore recover trash deleted purge',
        icon: Archive,
        run: openArchived,
      },
      {
        kind: 'action',
        id: 'action:claude-tools',
        label: 'Manage MCP / skills / commands…',
        keywords: 'mcp skills commands tools claude manage servers plugins config',
        icon: SlidersHorizontal,
        // Scope to the freshest session's project (if any) so the project-scoped
        // reads resolve; falls back to global-only when there are no sessions.
        run: () => openClaudeTools(pickFreshestSession(sessions)?.name ?? null),
      },
    ]
    // "New group" is only meaningful on the Overview (which installs its
    // handler via `new-group-store`); on every other route the action is null
    // and we hide the row so the palette doesn't surface a no-op.
    if (newGroupAction) {
      base.push({
        kind: 'action',
        id: 'action:new-group',
        label: 'New group',
        keywords: 'group new section divider organize overview folder',
        icon: FolderPlus,
        run: newGroupAction,
      })
    }
    if (!onBoard) return base
    return [
      ...base,
      {
        kind: 'action',
        id: 'action:board-start',
        label: 'Start agent on issue…',
        keywords: 'board issue start agent run begin work attach spawn session',
        icon: Play,
        run: () => enterMode({ step: 'start-pick-issue' }),
      },
      {
        kind: 'action',
        id: 'action:board-send',
        label: 'Send issue to session…',
        keywords: 'board issue send deliver agent claim dispatch session',
        icon: Send,
        run: () => enterMode({ step: 'send-pick-issue' }),
      },
      {
        kind: 'action',
        id: 'action:board-comment',
        label: 'Comment on issue…',
        keywords: 'board issue comment note reply message',
        icon: MessageSquare,
        run: () => enterMode({ step: 'comment-pick-issue' }),
      },
      {
        kind: 'action',
        id: 'action:board-done',
        label: 'Mark issue done',
        keywords: 'board issue done complete finish close mark',
        icon: CheckCircle2,
        run: () => enterMode({ step: 'done-pick-issue' }),
      },
    ]
  }, [openArchived, openClaudeTools, sessions, onBoard, enterMode, newGroupAction])

  // The board's issues, hardened to an array at the consumption boundary too.
  // `useBoard` already guarantees an array, but a malformed / 404 board payload
  // must never make these `.filter` calls throw and blank the whole palette —
  // belt-and-braces against the data source ever regressing. Memoized so the
  // identity stays stable for the dependent `useMemo`s below.
  const boardIssues = React.useMemo(
    () => (Array.isArray(board.issues) ? board.issues : []),
    [board.issues],
  )
  // Issues a board verb can target. "Send" only offers agent-owned issues (a
  // human-owned card can't be claimed/dispatched); comment + done offer any
  // non-done issue.
  const sendableIssues = React.useMemo(
    () => boardIssues.filter((i) => i.owner_type === 'agent'),
    [boardIssues],
  )
  const openIssues = React.useMemo(
    () => boardIssues.filter((i) => i.status !== 'done'),
    [boardIssues],
  )
  // "Start agent" targets the entry columns (`todo`/`backlog`) — the only place
  // an agent gets started. Owner is NOT a precondition (starting MAKES the issue
  // agent-owned), so this offers every startable card, human- or agent-owned.
  const startableIssues = React.useMemo(
    () =>
      boardIssues.filter(
        (i) => i.status === 'todo' || i.status === 'backlog',
      ),
    [boardIssues],
  )

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

  // Build the flat row list. In a board sub-flow the list is the step's pick
  // targets (issues / sessions); otherwise it's the normal palette — sessions
  // first (when query is not slash-prefixed), then in-app actions, then MCP
  // servers, then skills, then commands. Memoized so arrow-key state stays stable.
  const rows: PaletteRow[] = React.useMemo(() => {
    if (mode.step === 'send-pick-issue' || mode.step === 'comment-pick-issue') {
      const pool = mode.step === 'send-pick-issue' ? sendableIssues : openIssues
      return pool
        .filter((i) => matchesIssue(i, query))
        .map<IssueRow>((i) => ({ kind: 'issue', id: `issue:${i.id}`, issue: i }))
    }
    if (mode.step === 'start-pick-issue') {
      return startableIssues
        .filter((i) => matchesIssue(i, query))
        .map<IssueRow>((i) => ({ kind: 'issue', id: `issue:${i.id}`, issue: i }))
    }
    if (mode.step === 'done-pick-issue') {
      return openIssues
        .filter((i) => matchesIssue(i, query))
        .map<IssueRow>((i) => ({ kind: 'issue', id: `issue:${i.id}`, issue: i }))
    }
    if (mode.step === 'send-pick-session' || mode.step === 'start-pick-session') {
      return sessions
        .filter((s) => matchesSession(s, query))
        .map<SessionRow>((s) => ({
          kind: 'session',
          id: `session:${s.name}`,
          name: s.name,
          session: s,
        }))
    }
    if (mode.step === 'comment-type') {
      // No rows — the body renders a comment textarea instead.
      return []
    }
    const slashMode = query.startsWith('/')
    const cmdQ = slashMode ? query.slice(1) : query
    const sessionRows: PaletteRow[] = slashMode
      ? []
      : sessions
          .filter((s) => matchesSession(s, query))
          .map<SessionRow>((s) => ({
            kind: 'session',
            id: `session:${s.name}`,
            name: s.name,
            session: s,
          }))
    const actionRows: PaletteRow[] = slashMode
      ? []
      : actions.filter((a) => matchesAction(a, query))
    // MCP servers — not slash commands, so hidden in slash ("/") mode.
    const mcpRows: PaletteRow[] = slashMode
      ? []
      : regMcp
          .filter((m) => matchesMcp(m, query))
          .map<McpRow>((m) => ({ kind: 'mcp', id: `mcp:${m.scope}:${m.name}`, mcp: m }))
    // Skills — slash-invokable (`/<name>`), so they filter on the command query
    // and show in slash mode too; skip any already listed as a command.
    const skillRows: PaletteRow[] = regSkills
      .filter((s) => !commandNames.has(s.name) && matchesSkill(s, cmdQ))
      .map<SkillRow>((s) => ({ kind: 'skill', id: `skill:${s.name}`, skill: s }))
    const commandRows: PaletteRow[] = mergedCommands
      .filter((c) => matchesCommand(c, cmdQ))
      .map<CommandRow>((c) => ({ kind: 'command', id: `command:${c.cmd}`, cmd: c }))
    return [...sessionRows, ...actionRows, ...mcpRows, ...skillRows, ...commandRows]
  }, [
    mode,
    sessions,
    actions,
    mergedCommands,
    commandNames,
    regMcp,
    regSkills,
    query,
    sendableIssues,
    openIssues,
    startableIssues,
  ])

  // Clamp the highlight whenever the row list shrinks (so a narrowing filter
  // never leaves the active index past the end).
  const clampedActive = rows.length === 0 ? 0 : Math.min(active, rows.length - 1)

  // ── board verb effects (claim+deliver / comment / mark done) ───────────────
  // Each closes the palette, runs the board mutation, and surfaces the outcome
  // via the shared toast. Errors (incl. the atomic-claim 409) are non-fatal.

  const sendIssueToSession = React.useCallback(
    async (issue: BoardIssue, session: string) => {
      setOpen(false)
      // The shared send-to-agent flow (claim→toast→Undo) through the board's
      // optimistic mutation. Undo failures are swallowed silently here, as before.
      await sendToAgent({
        id: issue.id,
        session,
        claim: (a) => board.claimIssue(a),
        // Match the palette toast's prior styling: default tone + default duration.
        sentTone: 'default',
        onError: (e) => toast({ message: claimErrorMessage(e), tone: 'error' }),
      })
    },
    [board, setOpen, sendToAgent, toast],
  )

  // ── Start agent on an issue (the unified BR1 flow) ─────────────────────────
  // Calm + state-aware: when the issue already has a live linked session, one
  // pick starts + delivers right away (toast + Undo, shared toast system). With
  // no live session, advance to a pick-a-running-agent step so the start can
  // attach to one — never the internal "claim" verb, never a dead-end. (Spawning
  // a brand-new agent in a project lives in the board's detail-sheet picker,
  // which has the dir/provider/worktree inputs ⌘K shouldn't reproduce.)
  const startAgentOnIssue = React.useCallback(
    async (issue: BoardIssue, session: string) => {
      setOpen(false)
      await startAgent({
        id: issue.id,
        session,
        start: (a) => board.startIssue(a),
        sentMessage: () => `Sent to ${session}`,
        sentDuration: 6000,
        assignedMessage: () => `Agent started on ${session}`,
        onError: (e) => toast({ message: claimErrorMessage(e), tone: 'error' }),
      })
    },
    [board, setOpen, startAgent, toast],
  )

  const markIssueDone = React.useCallback(
    async (issue: BoardIssue) => {
      setOpen(false)
      try {
        await board.patchIssue(issue.id, { status: 'done' })
        toast({ message: `Marked ${issue.id} done` })
      } catch (e) {
        toast({
          message: e instanceof Error ? e.message : 'Could not mark done.',
          tone: 'error',
        })
      }
    },
    [board, setOpen, toast],
  )

  const submitComment = React.useCallback(async () => {
    if (mode.step !== 'comment-type') return
    const body = comment.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await boardApi.comment(mode.issue.id, body)
      setOpen(false)
      toast({ message: `Commented on ${mode.issue.id}` })
    } catch (e) {
      toast({
        message: e instanceof Error ? e.message : 'Could not post comment.',
        tone: 'error',
      })
      setBusy(false)
    }
  }, [mode, comment, busy, setOpen, toast])

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

  // Pick + dismiss. Session picks navigate; command/skill picks run in the most
  // recently active session (so the slash command actually runs against a real
  // pty); MCP picks open the Claude tools manager. If no session exists, a
  // command/skill row is a no-op (the palette closes). Inside a board sub-flow,
  // an issue/session pick advances the step machine or runs the verb.
  const pickRow = React.useCallback(
    (row: PaletteRow | undefined) => {
      if (!row) return
      // ── board sub-flow picks ──────────────────────────────────────────────
      if (row.kind === 'issue') {
        if (mode.step === 'send-pick-issue') {
          enterMode({ step: 'send-pick-session', issue: row.issue })
        } else if (mode.step === 'start-pick-issue') {
          // Confidently-live linked session → start + deliver in one pick;
          // otherwise advance to "pick a running agent" to attach to.
          if (row.issue.session && row.issue.session_live) {
            void startAgentOnIssue(row.issue, row.issue.session)
          } else {
            enterMode({ step: 'start-pick-session', issue: row.issue })
          }
        } else if (mode.step === 'comment-pick-issue') {
          enterMode({ step: 'comment-type', issue: row.issue })
        } else if (mode.step === 'done-pick-issue') {
          void markIssueDone(row.issue)
        }
        return
      }
      if (row.kind === 'session' && mode.step === 'send-pick-session') {
        void sendIssueToSession(mode.issue, row.name)
        return
      }
      if (row.kind === 'session' && mode.step === 'start-pick-session') {
        void startAgentOnIssue(mode.issue, row.name)
        return
      }
      if (row.kind === 'session') {
        setOpen(false)
        navigate(`/focus/${encodeURIComponent(row.name)}`)
        return
      }
      if (row.kind === 'action') {
        // In-app action (e.g. open the Archived sheet, or open a board verb's
        // sub-flow) — run the handler. Board verbs switch `mode` and KEEP the
        // palette open; the archived action opens a sheet so it closes first.
        if (row.id.startsWith('action:board-')) {
          row.run()
          return
        }
        setOpen(false)
        row.run()
        return
      }
      if (row.kind === 'mcp') {
        // MCP isn't "run" — open the Claude tools manager (MCP tab) scoped to the
        // freshest session's project, where check / reconnect / add / remove live.
        setOpen(false)
        openClaudeTools(freshest?.name ?? null)
        return
      }
      if (row.kind === 'skill') {
        // Skills are slash-invokable — activate `/<name>` in the freshest session.
        runSlash(`/${row.skill.name}\r`)
        return
      }
      // Command row — run it in the freshest session.
      runSlash(`${row.cmd.cmd}\r`)
    },
    [
      navigate,
      setOpen,
      mode,
      enterMode,
      markIssueDone,
      sendIssueToSession,
      startAgentOnIssue,
      runSlash,
      openClaudeTools,
      freshest,
    ],
  )

  // Step back out of a board sub-flow to the previous step (or to root). Used by
  // the back button and by Escape inside a sub-flow (Escape at root closes).
  const stepBack = React.useCallback(() => {
    setMode((m) => {
      switch (m.step) {
        case 'send-pick-session':
          return { step: 'send-pick-issue' }
        case 'start-pick-session':
          return { step: 'start-pick-issue' }
        case 'comment-type':
          return { step: 'comment-pick-issue' }
        case 'send-pick-issue':
        case 'start-pick-issue':
        case 'comment-pick-issue':
        case 'done-pick-issue':
          return { step: 'root' }
        default:
          return m
      }
    })
    setQuery('')
    setActive(0)
    setComment('')
  }, [])

  // Window-level Arrow / Enter while open, so the input never has to consume
  // the events explicitly (and Enter works from the empty state too). In the
  // comment-type step the textarea owns the keys (Enter submits there), so the
  // list keyboard is suspended.
  const inSubFlow = mode.step !== 'root'
  React.useEffect(() => {
    if (!open) return
    if (mode.step === 'comment-type') return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) =>
          rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length,
        )
      } else if (e.key === 'Enter') {
        e.preventDefault()
        pickRow(rows[clampedActive])
      } else if (e.key === 'Escape' && inSubFlow) {
        // In a sub-flow, Escape steps back one level instead of closing — the
        // Radix Dialog's own Escape-to-close still fires at root.
        e.preventDefault()
        e.stopPropagation()
        stepBack()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, rows, clampedActive, pickRow, mode.step, inSubFlow, stepBack])

  // Keep the active row in view as arrow-keys walk the list.
  const listRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-row="${clampedActive}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, clampedActive])

  // Mode-aware chrome: a breadcrumb (what verb you're in) + a filter placeholder.
  const breadcrumb = subFlowBreadcrumb(mode)
  const placeholder = subFlowPlaceholder(mode)

  return (
    <>
    {/* The Claude tools manager (skills/MCP/commands) — mounted here, alongside
     *  the palette, so it shares the shell-level mount the palette already has in
     *  <Layout>. The ⌘K "Manage MCP / skills / commands…" action, the focus
     *  title-bar icon, and the Settings section all open this ONE instance via
     *  the claude-tools store. Opt-in — only in the DOM as an overlay while
     *  open. */}
    <ClaudeToolsHost />
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className={cn(
          // Override the default Dialog padding — we want a flush input + list.
          'top-[20%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0',
        )}
        // Don't auto-focus the close button; let the input take focus.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        {breadcrumb && (
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <button
              type="button"
              onClick={stepBack}
              aria-label="Back"
              className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="truncate text-[13px] font-medium text-foreground">
              {breadcrumb}
            </span>
          </div>
        )}
        {mode.step === 'comment-type' ? (
          // Comment composer step — a styled textarea (no window.prompt). Enter
          // submits, Shift+Enter inserts a newline, Escape steps back.
          <div className="flex flex-col gap-3 p-4">
            <textarea
              autoFocus
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void submitComment()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  stepBack()
                }
              }}
              rows={4}
              placeholder={`Comment on ${mode.issue.id}…`}
              aria-label="Comment"
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-muted-foreground">
                Enter to post · Shift+Enter for a new line
              </span>
              <button
                type="button"
                onClick={() => void submitComment()}
                disabled={!comment.trim() || busy}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? 'Posting…' : 'Post comment'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <CommandIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
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
            <div
              ref={listRef}
              className="max-h-[min(60vh,420px)] overflow-y-auto py-1"
              role="listbox"
              aria-label="Palette results"
            >
              {rows.length === 0 ? (
                <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">
                  {query
                    ? `No match for “${query}”.`
                    : inSubFlow
                      ? 'No issues here yet.'
                      : 'Type to filter, or pick a row.'}
                </p>
              ) : (
                rows.map((row, i) => (
                  <PaletteRowView
                    key={row.id}
                    index={i}
                    row={row}
                    active={i === clampedActive}
                    onHover={() => setActive(i)}
                    onPick={() => pickRow(row)}
                  />
                ))
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
    </>
  )
}

/** Breadcrumb label for the active board sub-flow step (null = root). */
function subFlowBreadcrumb(mode: PaletteMode): string | null {
  switch (mode.step) {
    case 'start-pick-issue':
      return 'Start agent on issue — pick an issue'
    case 'start-pick-session':
      return `Start ${mode.issue.id} — pick an agent`
    case 'send-pick-issue':
      return 'Send issue to session — pick an issue'
    case 'send-pick-session':
      return `Send ${mode.issue.id} — pick a session`
    case 'comment-pick-issue':
      return 'Comment on issue — pick an issue'
    case 'comment-type':
      return `Comment on ${mode.issue.id}`
    case 'done-pick-issue':
      return 'Mark issue done — pick an issue'
    default:
      return null
  }
}

/** Filter-input placeholder per step. */
function subFlowPlaceholder(mode: PaletteMode): string {
  switch (mode.step) {
    case 'start-pick-issue':
    case 'send-pick-issue':
    case 'comment-pick-issue':
    case 'done-pick-issue':
      return 'Filter issues by title or id'
    case 'send-pick-session':
    case 'start-pick-session':
      return 'Filter sessions'
    default:
      return 'Jump to a session or run a /command'
  }
}

/** A single ≥44pt row — session pill or mono command. */
function PaletteRowView({
  index,
  row,
  active,
  onHover,
  onPick,
}: {
  index: number
  row: PaletteRow
  active: boolean
  onHover: () => void
  onPick: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-palette-row={index}
      onMouseEnter={onHover}
      onClick={onPick}
      className={cn(
        'flex h-11 w-full items-center gap-3 px-4 text-left',
        active ? 'bg-secondary' : 'hover:bg-secondary/60',
      )}
    >
      {row.kind === 'session' ? (
        <>
          <StatusDot status={row.session.status} />
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground">
            {row.session.name}
          </span>
          {row.session.task_summary && (
            <span className="min-w-0 max-w-[55%] shrink truncate text-[12px] text-muted-foreground">
              {row.session.task_summary}
            </span>
          )}
        </>
      ) : row.kind === 'issue' ? (
        <>
          {row.issue.owner_type === 'agent' ? (
            <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <User className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground">
            {row.issue.title}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {row.issue.id}
          </span>
        </>
      ) : row.kind === 'action' ? (
        <>
          <row.icon
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground">
            {row.label}
          </span>
        </>
      ) : row.kind === 'mcp' ? (
        <>
          <ServerCog className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground">
            {row.mcp.name}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {row.mcp.provenance === 'cloud' ? 'cloud · manage' : 'MCP · manage'}
          </span>
        </>
      ) : row.kind === 'skill' ? (
        <>
          <Sparkles className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="shrink-0 font-mono text-[14px] font-semibold text-foreground">
            /{row.skill.name}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
            {row.skill.description || 'skill'}
          </span>
        </>
      ) : (
        <>
          <TerminalSquare
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="shrink-0 font-mono text-[14px] font-semibold text-foreground">
            {row.cmd.cmd}
          </span>
          {row.cmd.desc && (
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
              {row.cmd.desc}
            </span>
          )}
        </>
      )}
    </button>
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
