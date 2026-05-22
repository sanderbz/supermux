import { useEffect, useState } from 'react'
import { Bot, Trash2, User, X, Zap } from 'lucide-react'

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
import {
  listBoardSessions,
  type BoardIssue,
  type BoardIssuePatch,
  type BoardSession,
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
  const [sessions, setSessions] = useState<BoardSession[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void listBoardSessions().then((s) => {
      if (alive) setSessions(s)
    })
    return () => {
      alive = false
    }
  }, [])

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
            className="flex w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Column">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
          <Button
            variant="secondary"
            onClick={() => void claim()}
            disabled={busy}
            className="justify-center"
          >
            <Zap className="size-4" />
            Claim for session
          </Button>
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
