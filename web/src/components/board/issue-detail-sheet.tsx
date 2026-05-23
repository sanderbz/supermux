import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bot, Search, Trash2, User, X, Zap } from 'lucide-react'

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useSessions } from '@/hooks/use-sessions'
import {
  type BoardIssue,
  type BoardIssuePatch,
  type BoardStatus,
} from '@/lib/api'

export interface IssueDetailSheetProps {
  issue: BoardIssue | null
  statuses: BoardStatus[]
  onClose: () => void
  onPatch: (id: string, patch: BoardIssuePatch) => Promise<void>
  onDelete: (id: string) => Promise<void>
  /** Claim the issue for `session` (atomic CAS). Rejects on a 409. */
  onClaim: (id: string, session: string) => Promise<void>
}

/** A claimable agent task sitting in todo/backlog can be CAS-claimed. */
function isClaimable(issue: BoardIssue): boolean {
  return (
    issue.owner_type === 'agent' &&
    (issue.status === 'todo' || issue.status === 'backlog')
  )
}

/**
 * Edit sheet for one issue (TECH_PLAN §M19). Lets the user retitle, move column,
 * reassign, set a due date + tags, claim it (atomic), or delete it. The claim
 * button surfaces a 409 visibly (atomic CAS — §3.2.10). The form body is keyed by
 * issue id so it remounts with pristine state per issue (no sync setState-in-effect).
 */
export function IssueDetailSheet({
  issue,
  statuses,
  onClose,
  onPatch,
  onDelete,
  onClaim,
}: IssueDetailSheetProps) {
  return (
    <Sheet open={!!issue} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md"
      >
        {issue && (
          <IssueDetailForm
            key={issue.id}
            issue={issue}
            statuses={statuses}
            onClose={onClose}
            onPatch={onPatch}
            onDelete={onDelete}
            onClaim={onClaim}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function IssueDetailForm({
  issue,
  statuses,
  onClose,
  onPatch,
  onDelete,
  onClaim,
}: {
  issue: BoardIssue
  statuses: BoardStatus[]
  onClose: () => void
  onPatch: (id: string, patch: BoardIssuePatch) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onClaim: (id: string, session: string) => Promise<void>
}) {
  const [title, setTitle] = useState(issue.title)
  const [desc, setDesc] = useState(issue.desc)
  const [status, setStatus] = useState(issue.status)
  const [session, setSession] = useState(issue.session ?? '')
  const [due, setDue] = useState(issue.due ?? '')
  const [ownerType, setOwnerType] = useState<'human' | 'agent'>(issue.owner_type)
  const [tags, setTags] = useState<string[]>(issue.tags)
  const [tagInput, setTagInput] = useState('')
  const [sessionFilter, setSessionFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The live session list — the SAME SSE-driven source the overview reads
  // (`useSessions` / `SESSIONS_KEY`), so the claim picker is never empty when a
  // session is actually running, and updates in real time.
  const { sessions } = useSessions()

  // Sessions filtered by the inline live-filter, sorted by name for a stable
  // list. Used by both the generic "Session" field and the claim combobox.
  const filteredSessions = useMemo(() => {
    const q = sessionFilter.trim().toLowerCase()
    return sessions
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [sessions, sessionFilter])

  function addTag(raw: string) {
    const t = raw.trim().replace(/,$/, '')
    if (t && !tags.includes(t)) setTags((prev) => [...prev, t])
    setTagInput('')
  }

  async function save() {
    const trimmed = title.trim()
    if (!trimmed) {
      setError('A title is required.')
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

  async function claim() {
    if (!session) {
      setError('Pick a session to claim this for.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onClaim(issue.id, session)
      onClose()
    } catch (e) {
      // 409 from the atomic claim surfaces here, in-place.
      setError(e instanceof Error ? e.message : 'Claim failed.')
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

  return (
    <>
      <SheetHeader>
        <SheetTitle className="pr-8">Issue</SheetTitle>
        <SheetDescription className="font-mono text-xs">
          {issue.id}
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-1 flex-col gap-4 py-4">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>

        <Field label="Description">
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={4}
            className="flex w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-base md:text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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

        {isClaimable(issue) && (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
            <span className="text-xs font-medium text-muted-foreground">
              Claim for session
            </span>
            {sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No active sessions —{' '}
                <Link
                  to="/"
                  onClick={onClose}
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  start one from the overview
                </Link>{' '}
                first.
              </p>
            ) : (
              <>
                {/* Live-filter — only worth showing once the list is long. */}
                {sessions.length > 5 && (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={sessionFilter}
                      onChange={(e) => setSessionFilter(e.target.value)}
                      placeholder="Filter sessions"
                      aria-label="Filter sessions"
                      className="h-9 pl-8"
                    />
                  </div>
                )}
                {/* The picker IS the claim affordance — pick a session here, then
                    the button enables. */}
                <div
                  role="listbox"
                  aria-label="Sessions"
                  className="flex max-h-48 flex-col gap-1 overflow-y-auto [scrollbar-width:thin]"
                >
                  {filteredSessions.length === 0 ? (
                    <p className="px-1 py-2 text-sm text-muted-foreground">
                      No sessions match “{sessionFilter.trim()}”.
                    </p>
                  ) : (
                    filteredSessions.map((s) => {
                      const active = session === s.name
                      return (
                        <button
                          key={s.name}
                          type="button"
                          role="option"
                          aria-selected={active}
                          onClick={() => setSession(s.name)}
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
                          <span className="flex-1 truncate font-medium">
                            {s.name}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {s.status}
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>
                <Button
                  variant="secondary"
                  onClick={() => void claim()}
                  disabled={busy || !session}
                  className="justify-center"
                >
                  <Zap className="size-4" />
                  {session ? `Claim for ${session}` : 'Pick a session above'}
                </Button>
              </>
            )}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <SheetFooter className="flex-row items-center justify-between gap-2">
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
      </SheetFooter>
    </>
  )
}

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
