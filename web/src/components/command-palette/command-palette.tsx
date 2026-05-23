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
import { useNavigate } from 'react-router-dom'
import { Archive, Command as CommandIcon, TerminalSquare } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { useSessions } from '@/hooks/use-sessions'
import { useSlashCommands } from '@/hooks/use-commands'
import { settingsRequest } from '@/lib/api/client'
import type { ApiSession, SlashCommand } from '@/lib/api'
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
 *  sessions". Routed to a local handler rather than a pty send. */
interface ActionRow {
  kind: 'action'
  id: string // `action:${key}`
  label: string
  keywords: string
  icon: typeof Archive
  run: () => void
}

type PaletteRow = SessionRow | CommandRow | ActionRow

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

// ── The palette ──────────────────────────────────────────────────────────────

export function CommandPalette() {
  const [open, setOpenRaw] = useGlobalCommandKey()
  const navigate = useNavigate()
  const { sessions } = useSessions()
  const { data: commands = [] } = useSlashCommands()
  const openArchived = useArchivedSheet((s) => s.openSheet)

  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)

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
        }
        return resolved
      })
    },
    [setOpenRaw],
  )

  // Wrap setQuery so the active-row reset happens from the user-input change
  // event — most-relevant match first, mirroring Spotlight / VSCode — without
  // an effect that the React rules would flag.
  const updateQuery = React.useCallback((next: string) => {
    setQuery(next)
    setActive(0)
  }, [])

  // In-app actions (not sessions, not slash commands). Hidden in slash mode
  // (a leading "/" means the user wants a command). Stable identity so arrow-key
  // state survives re-renders.
  const actions: ActionRow[] = React.useMemo(
    () => [
      {
        kind: 'action',
        id: 'action:view-archived',
        label: 'View archived sessions',
        keywords: 'archived archive restore recover trash deleted purge',
        icon: Archive,
        run: openArchived,
      },
    ],
    [openArchived],
  )

  // Build the flat row list — sessions first (when query is not slash-prefixed),
  // then in-app actions, then commands. Memoized so arrow-key state stays stable
  // across renders.
  const rows: PaletteRow[] = React.useMemo(() => {
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
  }, [sessions, actions, commands, query])

  // Clamp the highlight whenever the row list shrinks (so a narrowing filter
  // never leaves the active index past the end).
  const clampedActive = rows.length === 0 ? 0 : Math.min(active, rows.length - 1)

  // Pick + dismiss. Session picks navigate; command picks navigate to the most
  // recently active session (so the slash command actually runs against a real
  // pty) and POST it to the session's send endpoint. If no session exists, the
  // command row shows a hint and is a no-op (the palette closes).
  const pickRow = React.useCallback(
    (row: PaletteRow | undefined) => {
      if (!row) return
      if (row.kind === 'session') {
        setOpen(false)
        navigate(`/focus/${encodeURIComponent(row.name)}`)
        return
      }
      if (row.kind === 'action') {
        // In-app action (e.g. open the Archived sheet) — close the palette then
        // run the local handler.
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
    [navigate, sessions, setOpen],
  )

  // Window-level Arrow / Enter while open, so the input never has to consume
  // the events explicitly (and Enter works from the empty state too).
  React.useEffect(() => {
    if (!open) return
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
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, rows, clampedActive, pickRow])

  // Keep the active row in view as arrow-keys walk the list.
  const listRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-row="${clampedActive}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, clampedActive])

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
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <CommandIcon
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <input
            autoFocus
            value={query}
            onChange={(e) => updateQuery(e.target.value)}
            placeholder="Jump to a session or run a /command"
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
      </DialogContent>
    </Dialog>
  )
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
