// CommandPalette — global ⌘K / Ctrl+K spotlight (TECH_PLAN §4.4, §M9, §M50).
//
// Mounted ONCE in the root <Layout> so the shortcut works on EVERY route — the
// previous implementation (a stubbed `console.info` inside the focus route) was
// the bug. A single document-level keydown listener with `preventDefault` opens
// a Radix Dialog containing a fuzzy filter input + two sections:
//
//   • Sessions   — `useSessions()`, sorted by recency. Pick → navigate to
//                  `/focus/{name}`.
//   • Commands   — `useSlashCommands()` (M9 `/api/slash-commands`). Pick →
//                  navigate to the most-recently-active session's focus route AND
//                  POST `/api/sessions/{name}/send` `{ text: "/cmd\r" }` so the
//                  command runs in that session. If no sessions exist the row is
//                  visible but inert (with a hint to boot one first).
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
  MessageSquare,
  Send,
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
import { useBoard } from '@/hooks/use-board'
import { useToast } from '@/components/ui/use-toast'
import { settingsRequest } from '@/lib/api/client'
import { BoardError, boardApi, type ApiSession, type BoardIssue, type SlashCommand } from '@/lib/api'
import { StatusDot } from '@/components/session-tile/status-dot'
import { useArchivedSheet } from '@/stores/archived-sheet-store'

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

type PaletteRow = SessionRow | CommandRow | ActionRow | IssueRow

/** Board ⌘K verbs run as small step-machines inside the palette so the keyboard
 *  flow matches the overview's jump-session muscle memory (no new surface):
 *    root → pick-issue → (send: pick-session | comment: type | done: act)
 *  `null` is the normal palette (sessions + commands + actions). */
type PaletteMode =
  | { step: 'root' }
  | { step: 'send-pick-issue' }
  | { step: 'send-pick-session'; issue: BoardIssue }
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
  const openArchived = useArchivedSheet((s) => s.openSheet)
  const board = useBoard()
  const { toast } = useToast()

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
    ]
    if (!onBoard) return base
    return [
      ...base,
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
  }, [openArchived, onBoard, enterMode])

  // Issues a board verb can target. "Send" only offers agent-owned issues (a
  // human-owned card can't be claimed/dispatched); comment + done offer any
  // non-done issue.
  const sendableIssues = React.useMemo(
    () => board.issues.filter((i) => i.owner_type === 'agent'),
    [board.issues],
  )
  const openIssues = React.useMemo(
    () => board.issues.filter((i) => i.status !== 'done'),
    [board.issues],
  )

  // Build the flat row list. In a board sub-flow the list is the step's pick
  // targets (issues / sessions); otherwise it's the normal palette — sessions
  // first (when query is not slash-prefixed), then in-app actions, then commands.
  // Memoized so arrow-key state stays stable across renders.
  const rows: PaletteRow[] = React.useMemo(() => {
    if (mode.step === 'send-pick-issue' || mode.step === 'comment-pick-issue') {
      const pool = mode.step === 'send-pick-issue' ? sendableIssues : openIssues
      return pool
        .filter((i) => matchesIssue(i, query))
        .map<IssueRow>((i) => ({ kind: 'issue', id: `issue:${i.id}`, issue: i }))
    }
    if (mode.step === 'done-pick-issue') {
      return openIssues
        .filter((i) => matchesIssue(i, query))
        .map<IssueRow>((i) => ({ kind: 'issue', id: `issue:${i.id}`, issue: i }))
    }
    if (mode.step === 'send-pick-session') {
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
    const commandRows: PaletteRow[] = commands
      .filter((c) => matchesCommand(c, cmdQ))
      .map<CommandRow>((c) => ({ kind: 'command', id: `command:${c.cmd}`, cmd: c }))
    return [...sessionRows, ...actionRows, ...commandRows]
  }, [mode, sessions, actions, commands, query, sendableIssues, openIssues])

  // Clamp the highlight whenever the row list shrinks (so a narrowing filter
  // never leaves the active index past the end).
  const clampedActive = rows.length === 0 ? 0 : Math.min(active, rows.length - 1)

  // ── board verb effects (claim+deliver / comment / mark done) ───────────────
  // Each closes the palette, runs the board mutation, and surfaces the outcome
  // via the shared toast. Errors (incl. the atomic-claim 409) are non-fatal.

  const sendIssueToSession = React.useCallback(
    async (issue: BoardIssue, session: string) => {
      setOpen(false)
      try {
        const result = await board.claimIssue({
          id: issue.id,
          session,
          deliver: true,
        })
        if (result.delivered && result.steer_id != null) {
          const steerId = result.steer_id
          toast({
            message: `Sent to ${session}`,
            action: {
              label: 'Undo',
              onClick: () => {
                void boardApi.unsend(session, steerId).catch(() => {})
              },
            },
          })
        } else {
          toast({ message: `Claimed for ${session}` })
        }
      } catch (e) {
        const msg =
          e instanceof BoardError && e.status === 409
            ? e.message || 'Claim lost — another session took it.'
            : e instanceof Error
              ? e.message
              : 'Send failed.'
        toast({ message: msg, tone: 'error' })
      }
    },
    [board, setOpen, toast],
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

  // Pick + dismiss. Session picks navigate; command picks navigate to the most
  // recently active session (so the slash command actually runs against a real
  // pty) and POST it to the session's send endpoint. If no session exists, the
  // command row shows a hint and is a no-op (the palette closes). Inside a board
  // sub-flow, an issue/session pick advances the step machine or runs the verb.
  const pickRow = React.useCallback(
    (row: PaletteRow | undefined) => {
      if (!row) return
      // ── board sub-flow picks ──────────────────────────────────────────────
      if (row.kind === 'issue') {
        if (mode.step === 'send-pick-issue') {
          enterMode({ step: 'send-pick-session', issue: row.issue })
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
      // Command row — pick the freshest session by `last_activity` (falling back
      // to the first row), navigate to it, then send the command + carriage
      // return so the agent actually runs it.
      const target = pickFreshestSession(sessions)
      if (!target) {
        // No session to run against — just close, the empty-state CTA on the
        // overview teaches the user to boot one.
        setOpen(false)
        return
      }
      setOpen(false)
      navigate(`/focus/${encodeURIComponent(target.name)}`)
      // Fire-and-forget. The shared `settingsRequest` helper picks up the auth
      // token from `window._SUPERMUX_AUTH_TOKEN` (env.ts).
      void settingsRequest(`/api/sessions/${encodeURIComponent(target.name)}/send`, {
        method: 'POST',
        body: JSON.stringify({ text: `${row.cmd.cmd}\r` }),
      }).catch((e) => console.warn('command-palette: send failed', e))
    },
    [
      navigate,
      sessions,
      setOpen,
      mode,
      enterMode,
      markIssueDone,
      sendIssueToSession,
    ],
  )

  // Step back out of a board sub-flow to the previous step (or to root). Used by
  // the back button and by Escape inside a sub-flow (Escape at root closes).
  const stepBack = React.useCallback(() => {
    setMode((m) => {
      switch (m.step) {
        case 'send-pick-session':
          return { step: 'send-pick-issue' }
        case 'comment-type':
          return { step: 'comment-pick-issue' }
        case 'send-pick-issue':
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
              <kbd className="hidden shrink-0 rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline">
                Esc
              </kbd>
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
  )
}

/** Breadcrumb label for the active board sub-flow step (null = root). */
function subFlowBreadcrumb(mode: PaletteMode): string | null {
  switch (mode.step) {
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
    case 'send-pick-issue':
    case 'comment-pick-issue':
    case 'done-pick-issue':
      return 'Filter issues by title or id'
    case 'send-pick-session':
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
