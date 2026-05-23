import { useEffect, useState } from 'react'
import { Bot, User, X } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { listBoardSessions, type BoardSession, type NewBoardIssue } from '@/lib/api'

export interface NewIssueDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The column this issue is created in (the `+` that was tapped). */
  status: string
  statusLabel: string
  onCreate: (input: NewBoardIssue) => Promise<void>
}

/**
 * Create-issue dialog (TECH_PLAN §M19): title, description, session combo, due
 * date, tag chips and an owner-type radio. iOS-native finish — Title Case copy,
 * ≥44pt targets, spring-backed dialog (the shared Dialog primitive animates).
 *
 * The form body is a separate component keyed by `open` so each open starts from
 * pristine state with NO synchronous setState-in-effect (React 19 guidance).
 */
export function NewIssueDialog({
  open,
  onOpenChange,
  status,
  statusLabel,
  onCreate,
}: NewIssueDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {open && (
          <NewIssueForm
            status={status}
            statusLabel={statusLabel}
            onCreate={onCreate}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function NewIssueForm({
  status,
  statusLabel,
  onCreate,
  onClose,
}: {
  status: string
  statusLabel: string
  onCreate: (input: NewBoardIssue) => Promise<void>
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [session, setSession] = useState('')
  const [due, setDue] = useState('')
  const [ownerType, setOwnerType] = useState<'human' | 'agent'>('human')
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [sessions, setSessions] = useState<BoardSession[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Async load — not a synchronous setState in the effect body.
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

  async function submit() {
    const trimmed = title.trim()
    if (!trimmed) {
      setError('A title is required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onCreate({
        title: trimmed,
        desc: desc.trim() || undefined,
        status,
        session: session || null,
        due: due || null,
        owner_type: ownerType,
        tags: tags.length ? tags : undefined,
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the issue.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>New issue</DialogTitle>
        <DialogDescription>Adding to {statusLabel}.</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <Field label="Title">
          <Input
            autoFocus
            value={title}
            placeholder="What needs doing?"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
          />
        </Field>

        <Field label="Description">
          <textarea
            value={desc}
            placeholder="Add detail (optional)"
            onChange={(e) => setDesc(e.target.value)}
            rows={3}
            className="flex w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-base md:text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
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

          <Field label="Due date">
            <Input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </Field>
        </div>

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

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={saving}>
          {saving ? 'Adding…' : 'Add issue'}
        </Button>
      </DialogFooter>
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
