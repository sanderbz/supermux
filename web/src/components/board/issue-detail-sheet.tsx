import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  CircleSlash,
  FolderOpen,
  GitCommit,
  GitPullRequest,
  Link2,
  Loader2,
  Play,
  Plus,
  Search,
  Send,
  Square,
  Trash2,
  User,
  X,
} from 'lucide-react'

import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { homeDir } from '@/env'
import { useSessions } from '@/hooks/use-sessions'
import { useStartAgent } from '@/hooks/use-send-to-agent'
import { useToast } from '@/components/ui/use-toast'
import {
  boardApi,
  focusApi,
  sessionsApi,
  type AcceptanceItem,
  type BoardIssue,
  type BoardIssuePatch,
  type BoardStatus,
  type ClaimResult,
  type IssueLink,
  type StartSpawn,
} from '@/lib/api'

export interface IssueDetailSheetProps {
  issue: BoardIssue | null
  statuses: BoardStatus[]
  onClose: () => void
  onPatch: (id: string, patch: BoardIssuePatch) => Promise<void>
  onDelete: (id: string) => Promise<void>
  /** @deprecated Back-compat with the not-yet-migrated route: the atomic CAS used
   *  by the legacy "Send to agent" block. The Agent section now starts agents
   *  through the unified `boardApi.start` (attach OR spawn) via `useStartAgent`,
   *  so the sheet no longer surfaces "claim" to the user. Kept optional so the
   *  route keeps compiling until BR4 rewires it to `startIssue`. */
  onClaim?: (
    id: string,
    session: string,
    deliver: boolean,
  ) => Promise<ClaimResult>
}

/** A startable issue is one sitting in an entry column (`todo`/`backlog`): the
 *  primary action is **Start agent** (attach a live session, or spawn a new one).
 *  Starting MAKES it agent-owned server-side — owner is NOT a precondition. */
function isStartable(issue: BoardIssue): boolean {
  return issue.status === 'todo' || issue.status === 'backlog'
}

/** A working issue is `doing` with a live linked session — show Open + Stop, no
 *  Start. (A `doing` card whose link went stale falls back to the reassign flow.) */
function isWorking(issue: BoardIssue): boolean {
  return issue.status === 'doing' && issue.session != null && issue.session_live
}

/**
 * Edit sheet for one issue (TECH_PLAN §M19, board↔agent §C.4). Beyond the basic
 * fields (title/column/due/owner/tags) it carries the live board↔agent surface:
 *
 *  • a state-aware AGENT section (the primary action is chosen by STATUS, not
 *    owner — this structurally removes the old "not claimable" 409): on
 *    `todo`/`backlog` a **Start agent** block that attaches a running session OR
 *    spawns a NEW agent in a chosen project (dir autocomplete + provider +
 *    optional worktree, name derived server-side), one tap → start+deliver +
 *    Undo toast; on `doing` an **Open** (morph to focus) + **Stop**;
 *  • a live ACTIVITY STREAM (comments + status/check/link events, newest first),
 *    fed straight off the SSE `board` payload (the relations ride in `IssueView`),
 *    with agent/system entries visually distinct from human;
 *  • an inline STYLED comment input (never window.prompt) + an optional
 *    "notify agent" toggle that steers the comment into the linked session;
 *  • an ACCEPTANCE checklist the human edits/reorders and the agent ticks live;
 *  • a LINKS section (PR/commit) with add/remove;
 *  • a stale-link banner when the linked session was archived (offer reassign).
 *
 * The form body is keyed by issue id so it remounts pristine per issue.
 */
export function IssueDetailSheet({
  issue,
  statuses,
  onClose,
  onPatch,
  onDelete,
}: IssueDetailSheetProps) {
  if (!issue) return null
  return (
    <IssueDetailForm
      key={issue.id}
      open
      issue={issue}
      statuses={statuses}
      onClose={onClose}
      onPatch={onPatch}
      onDelete={onDelete}
    />
  )
}

function IssueDetailForm({
  open,
  issue,
  statuses,
  onClose,
  onPatch,
  onDelete,
}: {
  open: boolean
  issue: BoardIssue
  statuses: BoardStatus[]
  onClose: () => void
  onPatch: (id: string, patch: BoardIssuePatch) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [title, setTitle] = useState(issue.title)
  const [desc, setDesc] = useState(issue.desc)
  const [status, setStatus] = useState(issue.status)
  const [session, setSession] = useState(issue.session ?? '')
  const [due, setDue] = useState(issue.due ?? '')
  const [ownerType, setOwnerType] = useState<'human' | 'agent'>(issue.owner_type)
  const [tags, setTags] = useState<string[]>(issue.tags)
  const [tagInput, setTagInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The live session list — the SAME SSE-driven source the overview reads
  // (`useSessions`), so the attach picker is never empty when a session is
  // actually running, and updates in real time.
  const { sessions } = useSessions()
  const { toast } = useToast()
  const { startAgent } = useStartAgent()
  const navigate = useNavigate()

  // The live status of the session this issue is linked to (for the stale banner
  // copy). The relations + flags ride in `issue` straight off the SSE `board`
  // payload, so the whole sheet updates live with no extra fetch.
  const linkedSession = useMemo(
    () => sessions.find((s) => s.name === issue.session) ?? null,
    [sessions, issue.session],
  )

  function addTag(raw: string) {
    const t = raw.trim().replace(/,$/, '')
    if (t && !tags.includes(t)) setTags((prev) => [...prev, t])
    setTagInput('')
  }

  async function save() {
    // Title is optional — block save only when BOTH title and description are
    // empty (an issue must carry at least one of them). An empty title is saved
    // as `''`; the card then surfaces the description (or the id) as its heading.
    const trimmed = title.trim()
    if (!trimmed && !desc.trim()) {
      setError('Add a title or description.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onPatch(issue.id, {
        title: trimmed,
        desc,
        status,
        session: session || null,
        due: due || null,
        owner_type: ownerType,
        tags,
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  // Start an agent on this issue — the ONE gesture, two ways to run:
  //   • attach: pass a live session name (auto-delivers to it),
  //   • spawn:  pass `{ dir, provider, worktree }` and the server creates+boots a
  //     new session named after the issue, then claims + delivers.
  // Both route through the unified `boardApi.start` (via `useStartAgent`), which
  // makes the issue agent-owned, atomic-claims, and delivers — plain success
  // toast with Undo. A 409 (already being worked) surfaces here, in-place.
  async function start(args: { session?: string; spawn?: StartSpawn }) {
    setBusy(true)
    setError(null)
    try {
      await startAgent({
        id: issue.id,
        session: args.session,
        spawn: args.spawn,
        isSent: (r) => r.delivered,
        sentMessage: (r) => {
          const target = r.issue.session ?? args.session
          if (!target) return 'Agent started.'
          const asleep = args.session
            ? !sessions.some((s) => s.name === args.session)
            : false
          return asleep
            ? `Sent to ${target} — it'll pick this up on wake.`
            : `Started ${target}.`
        },
        sentDuration: 6000,
        assignedMessage: (r) =>
          r.issue.session ? `Agent on ${r.issue.session}.` : 'Agent started.',
        onSuccess: () => onClose(),
        onUndone: (cleared) =>
          toast({
            message:
              cleared > 0
                ? "Undone — the agent won't see it."
                : 'The agent already picked it up.',
            tone: cleared > 0 ? 'default' : 'waiting',
          }),
        onUndoError: () =>
          toast({ message: 'Could not undo.', tone: 'error' }),
        // 409 (another session is already on this) surfaces here, in-place.
        onError: (e) =>
          setError(e instanceof Error ? e.message : "Couldn't start the agent."),
      })
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await onDelete(issue.id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete.')
      setBusy(false)
    }
  }

  // Open the working session — morph into focus mode for the linked agent.
  function openFocus() {
    if (!issue.session) return
    onClose()
    navigate(`/focus/${encodeURIComponent(issue.session)}`)
  }

  // Stop the working session (control-plane POST /stop, same as focus's ⌘W). The
  // SSE `sessions` delta flips the card's live dot; we close on success.
  async function stop() {
    if (!issue.session) return
    setBusy(true)
    setError(null)
    try {
      await focusApi.stopSession(issue.session)
      toast({ message: `Stopped ${issue.session}.`, tone: 'default' })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not stop the agent.')
    } finally {
      setBusy(false)
    }
  }

  // A dangling link: the issue points at a session, but that session is no
  // longer live (archived/deleted) — R2 `session_live` is false.
  const staleLink = issue.session != null && !issue.session_live

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Issue"
      description={<span className="font-mono text-xs">{issue.id}</span>}
      footer={
        <div className="flex flex-row items-center justify-between gap-2">
          <Button
            variant="ghost"
            onClick={() => void remove()}
            disabled={busy}
            className={cn('text-destructive hover:text-destructive')}
          >
            <Trash2 className="size-4" />
            Delete
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-1 flex-col gap-4 px-5 py-4">
        {/* Stale-link banner — the linked session was archived/deleted. */}
        {staleLink && (
          <div className="flex items-start gap-2.5 rounded-lg border border-status-waiting/40 bg-status-waiting/10 p-3 text-sm">
            <CircleSlash className="mt-0.5 size-4 shrink-0 text-status-waiting" />
            <div className="flex flex-col gap-1">
              <span className="font-medium text-foreground">
                Session archived — reassign
              </span>
              <span className="text-muted-foreground">
                {issue.session} is no longer live. Pick another session below to
                hand this off.
              </span>
            </div>
          </div>
        )}

        <Field label="Description">
          <textarea
            value={desc}
            placeholder="What needs doing?"
            onChange={(e) => setDesc(e.target.value)}
            rows={4}
            className="flex w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-base md:text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        </Field>

        <Field label="Title (optional)">
          <Input
            value={title}
            placeholder="Short summary"
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Column">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Due date">
            <Input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Session">
          <select
            value={session}
            onChange={(e) => setSession(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <option value="">Unassigned</option>
            {sessions.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Owner">
          <div className="flex gap-2">
            <OwnerOption
              active={ownerType === 'human'}
              onClick={() => setOwnerType('human')}
              icon={<User className="size-4" />}
              label="Human"
            />
            <OwnerOption
              active={ownerType === 'agent'}
              onClick={() => setOwnerType('agent')}
              icon={<Bot className="size-4" />}
              label="Agent"
            />
          </div>
        </Field>

        <Field label="Tags">
          <div className="flex flex-col gap-2">
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                  >
                    {t}
                    <button
                      type="button"
                      aria-label={`Remove ${t}`}
                      onClick={() =>
                        setTags((prev) => prev.filter((x) => x !== t))
                      }
                      className="grid size-4 place-items-center rounded-full hover:bg-foreground/10"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <Input
              value={tagInput}
              placeholder="Add a tag, press Enter"
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  addTag(tagInput)
                }
              }}
              onBlur={() => tagInput && addTag(tagInput)}
            />
          </div>
        </Field>

        {/* ── Agent (state-aware) ───────────────────────────────────────────── */}
        {/* `doing` + live link → Open / Stop. Otherwise (startable, or a stale
            link that needs reassigning) → Start agent: attach a running session
            OR spawn a new one. Terminal columns show nothing (calm). */}
        {isWorking(issue) ? (
          <WorkingAgentSection
            sessionName={issue.session as string}
            liveStatus={linkedSession?.status}
            busy={busy}
            onOpen={openFocus}
            onStop={() => void stop()}
          />
        ) : isStartable(issue) || staleLink ? (
          <StartAgentSection
            sessions={sessions}
            issueTitle={issue.title}
            reassign={staleLink}
            busy={busy}
            onAttach={(name) => void start({ session: name })}
            onSpawn={(spawn) => void start({ spawn })}
          />
        ) : null}

        {/* ── Acceptance checklist ──────────────────────────────────────────── */}
        <AcceptanceChecklist issueId={issue.id} items={issue.acceptance} />

        {/* ── Links (PR/commit) ─────────────────────────────────────────────── */}
        <LinksSection issueId={issue.id} links={issue.links} />

        {/* ── Activity stream + inline comment ──────────────────────────────── */}
        <ActivityStream
          issue={issue}
          canSteer={Boolean(issue.session) && issue.session_live}
          linkedSessionName={linkedSession?.name ?? issue.session ?? null}
        />

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </ResponsiveSheet>
  )
}

// ── Agent: working (doing + live link) → Open / Stop ──────────────────────────

function WorkingAgentSection({
  sessionName,
  liveStatus,
  busy,
  onOpen,
  onStop,
}: {
  sessionName: string
  liveStatus?: string
  busy: boolean
  onOpen: () => void
  onStop: () => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center gap-2">
        <Bot className="size-4 shrink-0 text-primary" />
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          {sessionName}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {liveStatus ?? 'working'}
        </span>
      </div>
      <div className="flex gap-2">
        {/* Primary: Open — morph into focus mode for this agent. */}
        <Button
          onClick={onOpen}
          disabled={busy}
          className="h-11 flex-1 justify-center"
        >
          <ArrowUpRight className="size-4" />
          Open
        </Button>
        {/* Secondary: Stop — control-plane stop (same as focus's ⌘W). */}
        <Button
          variant="outline"
          onClick={onStop}
          disabled={busy}
          className="h-11 justify-center"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Square className="size-4" />
          )}
          Stop
        </Button>
      </div>
    </div>
  )
}

// ── Agent: start (todo/backlog, or reassign a stale link) ─────────────────────
// Two ways to run, minimum inputs:
//   1. Attach to a running agent — pick one from the live list → Start.
//   2. New agent in a project — a compact inline form mirroring new-session-sheet
//      (dir autocomplete + provider buttons + optional worktree); the server
//      derives the session name from the issue, creates+boots it, then delivers.
// When there are no running sessions we lead with "New agent" (no dead-end).

const PROVIDERS = ['claude', 'codex', 'shell'] as const
type Provider = (typeof PROVIDERS)[number]

function StartAgentSection({
  sessions,
  issueTitle,
  reassign,
  busy,
  onAttach,
  onSpawn,
}: {
  sessions: { name: string; status: string }[]
  issueTitle: string
  reassign: boolean
  busy: boolean
  onAttach: (session: string) => void
  onSpawn: (spawn: StartSpawn) => void
}) {
  const hasSessions = sessions.length > 0
  // Default the open mode: attach when something's running, else spawn-new.
  const [mode, setMode] = useState<'attach' | 'new'>(
    hasSessions ? 'attach' : 'new',
  )

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center gap-2">
        <Play className="size-4 shrink-0 text-primary" />
        <span className="text-sm font-medium text-foreground">
          {reassign ? 'Reassign — start agent' : 'Start agent'}
        </span>
      </div>

      {/* Mode toggle — only worth showing when both paths are available. */}
      {hasSessions && (
        <div className="grid grid-cols-2 gap-1.5">
          <ModeTab
            active={mode === 'attach'}
            onClick={() => setMode('attach')}
            label="Attach to running"
          />
          <ModeTab
            active={mode === 'new'}
            onClick={() => setMode('new')}
            label="New in project"
          />
        </div>
      )}

      {mode === 'attach' && hasSessions ? (
        <AttachToRunning
          sessions={sessions}
          busy={busy}
          onAttach={onAttach}
        />
      ) : (
        <NewAgentForm
          issueTitle={issueTitle}
          busy={busy}
          onSpawn={onSpawn}
        />
      )}
    </div>
  )
}

function ModeTab({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:border-foreground/20',
      )}
    >
      {label}
    </button>
  )
}

/** Pick a live session → Start. The picker IS the action: one tap per row starts
 *  + delivers the issue to that agent (no separate confirm). */
function AttachToRunning({
  sessions,
  busy,
  onAttach,
}: {
  sessions: { name: string; status: string }[]
  busy: boolean
  onAttach: (session: string) => void
}) {
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState('')

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return [...sessions]
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [sessions, filter])

  return (
    <div className="flex flex-col gap-2">
      {/* Live-filter — only worth showing once the list is long. */}
      {sessions.length > 5 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter sessions"
            aria-label="Filter sessions"
            className="h-9 pl-8"
          />
        </div>
      )}
      <div
        role="listbox"
        aria-label="Running agents"
        className="flex max-h-48 flex-col gap-1 overflow-y-auto [scrollbar-width:thin]"
      >
        {filtered.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">
            No agents match “{filter.trim()}”.
          </p>
        ) : (
          filtered.map((s) => {
            const active = picked === s.name
            return (
              <button
                key={s.name}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => setPicked(s.name)}
                className={cn(
                  'flex h-11 items-center gap-2 rounded-md border px-3 text-left text-sm transition-colors',
                  active
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-transparent text-foreground hover:border-foreground/15 hover:bg-foreground/5',
                )}
              >
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    active ? 'bg-primary' : 'bg-muted-foreground/40',
                  )}
                />
                <span className="flex-1 truncate font-medium">{s.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {s.status}
                </span>
              </button>
            )
          })
        )}
      </div>
      <Button
        onClick={() => picked && onAttach(picked)}
        disabled={busy || !picked}
        className="h-11 justify-center"
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4" />
        )}
        {picked ? `Start ${picked}` : 'Pick an agent above'}
      </Button>
    </div>
  )
}

/** Spawn a fresh agent in a chosen project — a compact mirror of
 *  new-session-sheet.tsx: dir autocomplete (defaults to home), provider buttons
 *  (claude default), optional isolated worktree. The server derives the session
 *  name from the issue, creates + boots it, then claims + delivers. One action. */
function NewAgentForm({
  issueTitle,
  busy,
  onSpawn,
}: {
  issueTitle: string
  busy: boolean
  onSpawn: (spawn: StartSpawn) => void
}) {
  const [dir, setDir] = useState(() => homeDir())
  const [provider, setProvider] = useState<Provider>('claude')
  const [worktree, setWorktree] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Directory typeahead (debounced) against the M7 autocomplete endpoint — the
  // same source new-session-sheet uses.
  const onDirChange = (value: string) => {
    setDir(value)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      if (!value.trim()) return setSuggestions([])
      setSuggestions(await sessionsApi.autocompleteDir(value))
    }, 200)
  }

  const submit = () =>
    onSpawn({ dir: dir.trim() || undefined, provider, worktree })

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Directory
        </span>
        <div className="relative">
          <FolderOpen className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={dir}
            onChange={(e) => onDirChange(e.target.value)}
            placeholder="~/projects/app"
            aria-label="Project directory"
            autoComplete="off"
            spellCheck={false}
            list="agent-dir-suggestions"
            className="h-9 pl-8"
          />
        </div>
        {suggestions.length > 0 && (
          <datalist id="agent-dir-suggestions">
            {suggestions.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        )}
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Provider
        </span>
        <div className="flex gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setProvider(p)}
              aria-pressed={provider === p}
              className={cn(
                'h-11 flex-1 rounded-md border px-3 text-sm font-medium capitalize transition-colors',
                provider === p
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-foreground/20',
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3">
        <input
          type="checkbox"
          checked={worktree}
          onChange={(e) => setWorktree(e.target.checked)}
          className="size-4 accent-[hsl(var(--primary))]"
        />
        <span className="flex flex-col">
          <span className="text-sm font-medium">Isolated worktree</span>
          <span className="text-xs text-muted-foreground">
            Run in a fresh git worktree so it can&rsquo;t touch your tree.
          </span>
        </span>
      </label>

      <Button
        onClick={submit}
        disabled={busy}
        className="h-11 justify-center"
        title={`Start a new ${provider} agent for “${issueTitle}”`}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4" />
        )}
        Start new agent
      </Button>
    </div>
  )
}

// ── Acceptance checklist ──────────────────────────────────────────────────────

function AcceptanceChecklist({
  issueId,
  items,
}: {
  issueId: string
  items: AcceptanceItem[]
}) {
  const [adding, setAdding] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editBody, setEditBody] = useState('')
  // A short-lived per-item busy latch so the row that's mutating disables; the
  // SSE `board` push confirms the result, so we don't need optimistic state.
  const [pendingId, setPendingId] = useState<number | null>(null)
  const reduce = useReducedMotion()

  const sorted = useMemo(
    () => [...items].sort((a, b) => a.pos - b.pos),
    [items],
  )
  const doneCount = sorted.filter((i) => i.done).length
  const total = sorted.length

  const run = useCallback(
    async (id: number | null, fn: () => Promise<unknown>) => {
      setPendingId(id)
      try {
        await fn()
      } catch {
        /* SSE will reconcile; the mutation just no-ops visually on failure */
      } finally {
        setPendingId(null)
      }
    },
    [],
  )

  const toggle = (item: AcceptanceItem) =>
    void run(item.id, () =>
      boardApi.patchAcceptance(issueId, item.id, { done: !item.done }),
    )
  const removeItem = (id: number) =>
    void run(id, () => boardApi.removeAcceptance(issueId, id))
  const addItem = () => {
    const body = adding.trim()
    if (!body) return
    setAdding('')
    void run(null, () => boardApi.addAcceptance(issueId, body))
  }
  const saveEdit = (id: number) => {
    const body = editBody.trim()
    setEditingId(null)
    if (!body) return
    void run(id, () => boardApi.patchAcceptance(issueId, id, { body }))
  }
  const move = (index: number, dir: -1 | 1) => {
    const next = index + dir
    if (next < 0 || next >= sorted.length) return
    const order = sorted.map((i) => i.id)
    ;[order[index], order[next]] = [order[next], order[index]]
    void run(sorted[index].id, () =>
      boardApi.reorderAcceptance(issueId, order),
    )
  }

  return (
    <Section
      label="Acceptance"
      trailing={
        total > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium tabular-nums text-muted-foreground">
            <span className="text-foreground">{doneCount}</span>/{total}
          </span>
        ) : null
      }
    >
      <div className="flex flex-col gap-1.5">
        {total > 0 && (
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <motion.div
              className="h-full rounded-full bg-status-ready"
              initial={false}
              animate={{ width: `${(doneCount / total) * 100}%` }}
              transition={reduce ? { duration: 0 } : springs.smooth}
            />
          </div>
        )}
        <AnimatePresence initial={false}>
          {sorted.map((item, index) => (
            <motion.div
              key={item.id}
              layout
              initial={reduce ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={springs.snappy}
              className="group flex items-center gap-2"
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={Boolean(item.done)}
                aria-label={`Mark "${item.body}" ${item.done ? 'incomplete' : 'complete'}`}
                disabled={pendingId === item.id}
                onClick={() => toggle(item)}
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded-[5px] border transition-colors',
                  item.done
                    ? 'border-status-ready bg-status-ready text-background'
                    : 'border-input hover:border-foreground/40',
                )}
              >
                {item.done && <Check className="size-3.5" strokeWidth={3} />}
              </button>
              {editingId === item.id ? (
                <Input
                  autoFocus
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  onBlur={() => saveEdit(item.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      saveEdit(item.id)
                    } else if (e.key === 'Escape') {
                      setEditingId(null)
                    }
                  }}
                  className="h-8 flex-1"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(item.id)
                    setEditBody(item.body)
                  }}
                  className={cn(
                    'flex-1 truncate text-left text-sm',
                    item.done
                      ? 'text-muted-foreground line-through'
                      : 'text-foreground',
                  )}
                >
                  {item.body}
                </button>
              )}
              {/* Reorder + remove — revealed on hover (desktop), always tappable. */}
              <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <IconBtn
                  label="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ChevronUp className="size-3.5" />
                </IconBtn>
                <IconBtn
                  label="Move down"
                  disabled={index === sorted.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ChevronDown className="size-3.5" />
                </IconBtn>
                <IconBtn label="Remove item" onClick={() => removeItem(item.id)}>
                  <X className="size-3.5" />
                </IconBtn>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {/* Add a new item. */}
        <div className="flex items-center gap-2">
          <Plus className="size-4 shrink-0 text-muted-foreground" />
          <Input
            value={adding}
            placeholder="Add an acceptance item"
            aria-label="Add an acceptance item"
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addItem()
              }
            }}
            onBlur={addItem}
            className="h-8 flex-1"
          />
        </div>
      </div>
    </Section>
  )
}

// ── Links (PR/commit) ─────────────────────────────────────────────────────────

function LinksSection({
  issueId,
  links,
}: {
  issueId: string
  links: IssueLink[]
}) {
  const [kind, setKind] = useState<'pr' | 'commit'>('pr')
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async () => {
    const value = ref.trim()
    if (!value) return
    setBusy(true)
    setRef('')
    try {
      await boardApi.addLink(issueId, { kind, ref: value })
    } catch {
      /* SSE reconciles */
    } finally {
      setBusy(false)
    }
  }
  const removeLink = (id: number) => {
    void boardApi.removeLink(issueId, id).catch(() => {})
  }

  return (
    <Section label="Links">
      <div className="flex flex-col gap-1.5">
        {links.map((l) => (
          <div
            key={l.id}
            className="group flex items-center gap-2 rounded-md border border-border bg-muted/20 px-2.5 py-1.5"
          >
            {l.kind === 'pr' ? (
              <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <GitCommit className="size-4 shrink-0 text-muted-foreground" />
            )}
            <a
              href={isUrl(l.ref) ? l.ref : undefined}
              target="_blank"
              rel="noreferrer"
              className={cn(
                'flex-1 truncate text-sm',
                isUrl(l.ref)
                  ? 'text-primary underline-offset-2 hover:underline'
                  : 'font-mono text-foreground',
              )}
            >
              {l.label || prettyRef(l)}
            </a>
            <IconBtn label="Remove link" onClick={() => removeLink(l.id)}>
              <X className="size-3.5" />
            </IconBtn>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'pr' | 'commit')}
            aria-label="Link kind"
            className="h-8 shrink-0 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <option value="pr">PR</option>
            <option value="commit">Commit</option>
          </select>
          <Input
            value={ref}
            placeholder={kind === 'pr' ? 'PR url' : 'commit sha or url'}
            aria-label="Link reference"
            onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void add()
              }
            }}
            className="h-8 flex-1"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void add()}
            disabled={busy || !ref.trim()}
            className="h-8 shrink-0"
          >
            <Link2 className="size-3.5" />
            Add
          </Button>
        </div>
      </div>
    </Section>
  )
}

// ── Activity stream + inline comment ──────────────────────────────────────────

interface StreamEntry {
  key: string
  ts: number
  author: 'user' | 'agent' | 'system'
  authorLabel: string
  body: string
}

/** Build the newest-first timeline from the issue's relations. Comments carry
 *  their own author/timestamp; acceptance check-offs and link additions are
 *  surfaced as system/agent-style entries so the stream reads as a single
 *  log of everything that happened to the card. */
function buildStream(issue: BoardIssue): StreamEntry[] {
  const entries: StreamEntry[] = []

  for (const c of issue.comments) {
    const kind = classifyAuthor(c.author)
    entries.push({
      key: `c-${c.id}`,
      ts: c.created,
      author: kind,
      authorLabel: authorLabel(c.author, kind),
      body: c.body,
    })
  }

  // Link additions read as activity too (kept after comments; both sorted below).
  for (const l of issue.links) {
    entries.push({
      key: `l-${l.id}`,
      ts: l.created,
      author: 'system',
      authorLabel: 'Link',
      body: `Added ${l.kind === 'pr' ? 'PR' : 'commit'} ${l.label || prettyRef(l)}`,
    })
  }

  return entries.sort((a, b) => b.ts - a.ts)
}

function classifyAuthor(author: string): 'user' | 'agent' | 'system' {
  if (author === 'user' || author.startsWith('human')) return 'user'
  if (author.startsWith('agent')) return 'agent'
  return 'system'
}

function authorLabel(author: string, kind: 'user' | 'agent' | 'system'): string {
  if (kind === 'agent') return author.replace(/^agent:/, '') || 'agent'
  if (kind === 'user') return author.replace(/^human:/, '') || 'You'
  return author || 'system'
}

function ActivityStream({
  issue,
  canSteer,
  linkedSessionName,
}: {
  issue: BoardIssue
  canSteer: boolean
  linkedSessionName: string | null
}) {
  const [body, setBody] = useState('')
  const [notify, setNotify] = useState(false)
  const [posting, setPosting] = useState(false)
  const { toast } = useToast()
  const reduce = useReducedMotion()

  const stream = useMemo(() => buildStream(issue), [issue])

  const post = async () => {
    const text = body.trim()
    if (!text || posting) return
    setPosting(true)
    try {
      await boardApi.comment(issue.id, text)
      // Optional: also steer the comment into the linked session as a nudge.
      if (notify && canSteer && linkedSessionName) {
        await boardApi.nudge(linkedSessionName, text).catch(() => {
          toast({
            message: 'Comment posted, but couldn’t notify the agent.',
            tone: 'waiting',
          })
        })
      }
      setBody('')
    } catch (e) {
      toast({
        message: e instanceof Error ? e.message : 'Could not post comment.',
        tone: 'error',
      })
    } finally {
      setPosting(false)
    }
  }

  return (
    <Section label="Activity">
      {/* Inline styled comment input (NOT window.prompt). 44pt send target. */}
      <div className="flex flex-col gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void post()
            }
          }}
          rows={2}
          placeholder="Write a comment…"
          aria-label="Write a comment"
          className="flex w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-base md:text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
        <div className="flex items-center justify-between gap-2">
          {/* Notify-agent toggle (off by default; only when the link is live). */}
          {canSteer ? (
            <button
              type="button"
              role="switch"
              aria-checked={notify}
              onClick={() => setNotify((v) => !v)}
              className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground"
            >
              <span
                className={cn(
                  'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
                  notify ? 'bg-primary' : 'bg-muted-foreground/30',
                )}
              >
                <motion.span
                  layout
                  transition={reduce ? { duration: 0 } : springs.toggleSnap}
                  className={cn(
                    'absolute size-3 rounded-full bg-background shadow-sm',
                    notify ? 'right-0.5' : 'left-0.5',
                  )}
                />
              </span>
              Notify agent
            </button>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            onClick={() => void post()}
            disabled={posting || !body.trim()}
            className="h-11 px-4"
          >
            <Send className="size-3.5" />
            {posting ? 'Posting…' : 'Comment'}
          </Button>
        </div>
      </div>

      {/* The live timeline, newest first. */}
      <div className="mt-3 flex flex-col gap-2.5">
        {stream.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No activity yet. Comments, check-offs and links show up here.
          </p>
        ) : (
          <AnimatePresence initial={false}>
            {stream.map((e) => (
              <motion.div
                key={e.key}
                layout
                initial={reduce ? false : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={springs.snappy}
                className={cn(
                  'flex flex-col gap-1 rounded-lg border px-3 py-2',
                  e.author === 'user'
                    ? 'border-border bg-muted/30'
                    : e.author === 'agent'
                      ? 'border-primary/30 bg-primary/5'
                      : 'border-dashed border-border bg-transparent',
                )}
              >
                <div className="flex items-center gap-1.5 text-xs">
                  {e.author === 'agent' ? (
                    <Bot className="size-3.5 text-primary" />
                  ) : e.author === 'user' ? (
                    <User className="size-3.5 text-muted-foreground" />
                  ) : (
                    <CircleSlash className="size-3 text-muted-foreground" />
                  )}
                  <span
                    className={cn(
                      'font-medium',
                      e.author === 'agent'
                        ? 'text-primary'
                        : 'text-foreground',
                    )}
                  >
                    {e.authorLabel}
                  </span>
                  <span className="text-muted-foreground">
                    · {relativeTime(e.ts)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                  {e.body}
                </p>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
    </Section>
  )
}

// ── small shared pieces ───────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function Section({
  label,
  trailing,
  children,
}: {
  label: string
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        {trailing}
      </div>
      {children}
    </div>
  )
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  )
}

function OwnerOption({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex h-11 flex-1 items-center justify-center gap-2 rounded-md border text-sm font-medium transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:border-foreground/20',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

function prettyRef(l: IssueLink): string {
  if (l.kind === 'commit' && !isUrl(l.ref)) return l.ref.slice(0, 10)
  return l.ref
}

/** Compact relative time off a unix-seconds timestamp (sentence case). */
function relativeTime(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds
  if (diff < 45) return 'just now'
  if (diff < 90) return '1 min ago'
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`
  if (diff < 5400) return '1 hr ago'
  if (diff < 86400) return `${Math.round(diff / 3600)} hr ago`
  if (diff < 172800) return 'yesterday'
  return `${Math.round(diff / 86400)} d ago`
}
