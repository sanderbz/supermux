/**
 * `<AcceptanceChecklist>` — an issue's acceptance items, ticked by either side.
 * ─────────────────────────────────────────────────────────────────────────────
 * EXTRACTED, behaviour unchanged, from `components/board/board-card-editor.tsx`
 * (fase B2 T10). It was one export inside a 600-line page-only host, and the
 * issue detail pane imported the whole host to get at it. The Board PAGE goes
 * away in T11; this does not — it is the read/edit surface an issue keeps
 * wherever it is shown, and dragging its host along would have meant either
 * keeping the page or rewriting the checklist.
 *
 * The human edits, reorders and ticks; the AGENT ticks too, over the `board`
 * SSE event — which is why every mutation is fire-and-forget with "SSE
 * reconciles" as the error path: the server is the truth and a failed optimistic
 * tick is corrected within a tick rather than argued about in a toast.
 */
import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check, ChevronDown, ChevronUp, Plus, X } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { boardApi, type AcceptanceItem } from '@/lib/api'

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

/* ── the two shapes it is made of, extracted with it ─────────────────────── */

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
