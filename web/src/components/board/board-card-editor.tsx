import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  Check,
  ChevronDown,
  ChevronUp,
  GitCommit,
  GitPullRequest,
  Link2,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react'

import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useSessions } from '@/hooks/use-sessions'
import {
  boardApi,
  displayLabel,
  type AcceptanceItem,
  type BoardIssue,
  type BoardIssuePatch,
  type IssueLink,
} from '@/lib/api'

export interface BoardCardEditorProps {
  issue: BoardIssue | null
  onClose: () => void
  onPatch: (id: string, patch: BoardIssuePatch) => Promise<void>
  onDiscard: (issue: BoardIssue) => void
  /** ▶ Start the agent from inside the editor (To do cards). */
  onStart: (issue: BoardIssue) => void
}

/**
 * The card editor (BM2 §2.3) — a bottom sheet (mobile) / right popover-style
 * sheet (desktop) in the app's existing `ResponsiveSheet` style. Edits the
 * description (primary, autofocus), title, linked session, acceptance, tags and
 * due. There is NO owner selector and NO column dropdown (lane is driven by the
 * agent's state, not manual bookkeeping). For a To do card it also surfaces a
 * one-tap ▶ Start (spawn-by-default) so create→edit→start never leaves the sheet.
 *
 * Save writes the patch and closes. Discard archives the card (route shows the
 * undo toast). Keyed by issue id so it remounts pristine per card.
 */
export function BoardCardEditor({
  issue,
  onClose,
  onPatch,
  onDiscard,
  onStart,
}: BoardCardEditorProps) {
  if (!issue) return null
  return (
    <EditorForm
      key={issue.id}
      issue={issue}
      onClose={onClose}
      onPatch={onPatch}
      onDiscard={onDiscard}
      onStart={onStart}
    />
  )
}

function EditorForm({
  issue,
  onClose,
  onPatch,
  onDiscard,
  onStart,
}: {
  issue: BoardIssue
  onClose: () => void
  onPatch: (id: string, patch: BoardIssuePatch) => Promise<void>
  onDiscard: (issue: BoardIssue) => void
  onStart: (issue: BoardIssue) => void
}) {
  const [title, setTitle] = useState(issue.title)
  const [desc, setDesc] = useState(issue.desc)
  const [session, setSession] = useState(issue.session ?? '')
  const [due, setDue] = useState(issue.due ?? '')
  const [tags, setTags] = useState<string[]>(issue.tags)
  const [tagInput, setTagInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { sessions } = useSessions()

  const isTodo = issue.status === 'todo'

  function addTag(raw: string) {
    const t = raw.trim().replace(/,$/, '')
    if (t && !tags.includes(t)) setTags((prev) => [...prev, t])
    setTagInput('')
  }

  async function save() {
    if (!desc.trim() && !title.trim()) {
      setError('Add a description or a title.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onPatch(issue.id, {
        title: title.trim(),
        desc,
        session: session || null,
        due: due || null,
        tags,
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ResponsiveSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit task"
      description={<span className="font-mono text-xs">{issue.id}</span>}
      footer={
        <div className="flex flex-row items-center justify-between gap-2">
          <Button
            variant="ghost"
            onClick={() => onDiscard(issue)}
            disabled={busy}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="size-4" />
            Discard
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-1 flex-col gap-4 px-5 py-4">
        <Field label="Description">
          {/* NO autoFocus — on iOS PWA Vaul's keyboard-handler races the
              slide-in animation when an input auto-focuses DURING the open
              transition. Vaul captures the drawer's bounding rect mid-
              translate, caches it as `initialDrawerHeight`, then positions
              the drawer at half-height with cropped content. Users tap to
              focus, matching the proven New Session sheet pattern. */}
          <textarea
            value={desc}
            placeholder="Describe a task for an agent…"
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
          <Field label="Existing session">
            <select
              value={session}
              onChange={(e) => setSession(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <option value="">None — spawn on start</option>
              {sessions.map((s) => (
                <option key={s.name} value={s.name}>
                  {displayLabel(s)}
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
                      onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
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

        {/* To do → one-tap Start (spawn-by-default). Create→edit→start in one
            sheet, no picker forced. "Use an existing session" is the select
            above. */}
        {isTodo && (
          <Button
            onClick={() => onStart(issue)}
            disabled={busy}
            className="h-11 justify-center"
          >
            <Play className="size-4" />
            Start agent
          </Button>
        )}

        <AcceptanceChecklist issueId={issue.id} items={issue.acceptance} />
        <LinksSection issueId={issue.id} links={issue.links} />

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </ResponsiveSheet>
  )
}

// ── Acceptance checklist (human edits/reorders; agent ticks live over SSE) ────

export function AcceptanceChecklist({
  issueId,
  items,
}: {
  issueId: string
  items: AcceptanceItem[]
}) {
  const [adding, setAdding] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editBody, setEditBody] = useState('')
  const [pendingId, setPendingId] = useState<number | null>(null)
  const reduce = useReducedMotion()

  const sorted = useMemo(() => [...items].sort((a, b) => a.pos - b.pos), [items])
  const doneCount = sorted.filter((i) => i.done).length
  const total = sorted.length

  const run = useCallback(
    async (id: number | null, fn: () => Promise<unknown>) => {
      setPendingId(id)
      try {
        await fn()
      } catch {
        /* SSE reconciles */
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
    void run(sorted[index].id, () => boardApi.reorderAcceptance(issueId, order))
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
              <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <IconBtn label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
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

// ── small shared pieces ───────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
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
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
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

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

function prettyRef(l: IssueLink): string {
  if (l.kind === 'commit' && !isUrl(l.ref)) return l.ref.slice(0, 10)
  return l.ref
}
