// SnippetPanel — M18 (TECH_PLAN §M18, research/termius-ios-native-spec.md
// §"Snippet picker" #5).
//
// An IN-PLACE slide-up panel (never a modal sheet — that is the deliberate spec
// choice #5) that rises from above the accessory bar. Height min(320px, 50vh).
// Spring per spec: `response: 0.35, dampingFraction: 0.85` — the framer-motion
// equivalent of which is `springs.snippetSlide` (added to lib/springs.ts).
//
// Per-row interactions (spec #5):
//   • Tap          → insert the snippet body into the composer (onInsert).
//   • Long-press 500ms → run-immediately: send the body straight to the pty
//     (onRun), with a medium haptic (navigator.vibrate(15), Android-only).
//   • Swipe-left   → reveals Edit / Delete actions; a full-swipe past 50% of the
//     row width auto-deletes with a medium haptic.
//
// Snippets come from the M9 `/api/snippets` endpoint via use-commands; if the
// table is empty the panel shows three default seeds (`continue`, `/compact`,
// `/status`) as one-tap "create this" rows so the panel is never empty on a
// fresh install. A "+" header button opens the SnippetEditor for a new snippet.
//
// VISUAL (Termius #1/#5/#18/#19): .thinMaterial glass (`bg-background/70
// backdrop-blur-xl` — the `glass` utility), ≥44pt rows (h-12), sentence-case
// labels (NO uppercase), spring physics throughout, NO `transition: all`.

import * as React from 'react'
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type PanInfo,
} from 'framer-motion'
import { Plus, Pencil, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useSnippets, useCreateSnippet, useDeleteSnippet } from '@/hooks/use-commands'
import type { SnippetRow } from '@/lib/api'
import { SnippetEditor } from './snippet-editor'

/** The three default snippets seeded on a fresh install (§M18 subagent prompt).
 *  Shown as one-tap "create" rows when the table is empty so the panel is never
 *  bare; tapping one persists it via `/api/snippets`. */
const DEFAULT_SNIPPETS: ReadonlyArray<{ title: string; body: string }> = [
  { title: 'Continue', body: 'continue' },
  { title: 'Compact', body: '/compact' },
  { title: 'Status', body: '/status' },
]

export interface SnippetPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Insert a snippet body into the composer input (tap). */
  onInsert: (body: string) => void
  /** Run a snippet body immediately — send straight to the pty (long-press). */
  onRun: (body: string) => void
}

export function SnippetPanel({
  open,
  onOpenChange,
  onInsert,
  onRun,
}: SnippetPanelProps) {
  const reduceMotion = useReducedMotion()
  const { data: snippets = [], isLoading } = useSnippets()
  const createSnippet = useCreateSnippet()

  // Editor sub-sheet: null target = create, a row = edit.
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [editTarget, setEditTarget] = React.useState<SnippetRow | null>(null)

  const openNew = () => {
    setEditTarget(null)
    setEditorOpen(true)
  }
  const openEdit = (s: SnippetRow) => {
    setEditTarget(s)
    setEditorOpen(true)
  }

  const isEmpty = !isLoading && snippets.length === 0

  return (
    <>
      <AnimatePresence>
        {open && (
          <>
            {/* Tap-catcher — dismisses the panel without a heavy modal overlay
                so the terminal stays visible behind the .thinMaterial panel. */}
            <motion.button
              type="button"
              aria-label="Close snippets"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => onOpenChange(false)}
              className="fixed inset-0 z-[55] bg-black/20"
            />

            <motion.div
              role="dialog"
              aria-label="Snippets"
              initial={reduceMotion ? false : { y: '100%' }}
              animate={{ y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { y: '100%' }}
              transition={reduceMotion ? { duration: 0 } : springs.snippetSlide}
              // Rises from above the accessory bar; height min(320px, 50vh).
              className={cn(
                'glass fixed inset-x-0 bottom-0 z-[56] flex flex-col',
                'rounded-t-2xl border-t border-border/60 pb-safe',
              )}
              style={{ height: 'min(320px, 50vh)' }}
            >
              {/* Header — title + new-snippet button. */}
              <div className="flex shrink-0 items-center justify-between px-4 pb-1 pt-3">
                <span className="text-[13px] font-semibold text-muted-foreground">
                  Snippets
                </span>
                <motion.button
                  type="button"
                  aria-label="New snippet"
                  onClick={openNew}
                  whileTap={{ scale: 0.94 }}
                  transition={springs.buttonPress}
                  className="flex size-9 items-center justify-center rounded-xl text-foreground/80 hover:bg-secondary"
                >
                  <Plus className="size-[18px]" />
                </motion.button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {isLoading ? (
                  <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">
                    Loading snippets…
                  </p>
                ) : isEmpty ? (
                  <DefaultSeeds
                    onCreate={(s) => createSnippet.mutate(s)}
                    creating={createSnippet.isPending}
                  />
                ) : (
                  snippets.map((s) => (
                    <SnippetRowItem
                      key={s.id}
                      snippet={s}
                      onInsert={() => {
                        onInsert(s.body)
                        onOpenChange(false)
                      }}
                      onRun={() => {
                        onRun(s.body)
                        onOpenChange(false)
                      }}
                      onEdit={() => openEdit(s)}
                    />
                  ))
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <SnippetEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        snippet={editTarget}
      />
    </>
  )
}

/** Empty-state: the three default snippets as one-tap "create" rows. */
function DefaultSeeds({
  onCreate,
  creating,
}: {
  onCreate: (s: { title: string; body: string }) => void
  creating: boolean
}) {
  return (
    <div className="px-1 pt-1">
      <p className="px-2 pb-2 text-[12px] text-muted-foreground">
        No snippets yet. Tap one to add it:
      </p>
      {DEFAULT_SNIPPETS.map((s) => (
        <motion.button
          key={s.title}
          type="button"
          disabled={creating}
          onClick={() => onCreate(s)}
          whileTap={{ scale: 0.98 }}
          transition={springs.buttonPress}
          className={cn(
            'flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left',
            'hover:bg-secondary/60',
            creating && 'opacity-50',
          )}
        >
          <Plus className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-[14px] font-medium">{s.title}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
            {s.body}
          </span>
        </motion.button>
      ))}
    </div>
  )
}

// ── one snippet row — tap insert / long-press run / swipe-left actions ────────

/** Long-press threshold (ms) for run-immediately (§M18 spec #5). */
const LONG_PRESS_MS = 500
/** Resting reveal width when a swipe-left settles open (Edit + Delete buttons). */
const ACTIONS_WIDTH = 132

function SnippetRowItem({
  snippet,
  onInsert,
  onRun,
  onEdit,
}: {
  snippet: SnippetRow
  onInsert: () => void
  onRun: () => void
  onEdit: () => void
}) {
  const reduceMotion = useReducedMotion()
  const deleteSnippet = useDeleteSnippet()

  // Horizontal drag for swipe-left → reveal actions / full-swipe → delete.
  const x = useMotionValue(0)
  const rowRef = React.useRef<HTMLDivElement | null>(null)
  // Action strip fades in as the row slides aside.
  const actionsOpacity = useTransform(x, [-ACTIONS_WIDTH, -20, 0], [1, 0.4, 0])

  // Long-press timer — armed on pointer-down, fires onRun, cancelled on a move
  // (a drag) or an early pointer-up (which is then a tap).
  const pressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const longFired = React.useRef(false)

  const clearPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }

  const armPress = () => {
    longFired.current = false
    clearPress()
    pressTimer.current = setTimeout(() => {
      longFired.current = true
      if ('vibrate' in navigator) navigator.vibrate(15) // medium haptic
      onRun()
    }, LONG_PRESS_MS)
  }

  const onTap = () => {
    // A real long-press already fired run-immediately — don't also insert.
    if (longFired.current) {
      longFired.current = false
      return
    }
    onInsert()
  }

  const onDragEnd = (_: unknown, info: PanInfo) => {
    clearPress()
    const width = rowRef.current?.clientWidth ?? 280
    // Full-swipe past 50% → auto-delete with a medium haptic (spec #5).
    if (info.offset.x <= -width * 0.5) {
      if ('vibrate' in navigator) navigator.vibrate(15)
      deleteSnippet.mutate(snippet.id)
      return
    }
    // Past the action-strip width → settle open; otherwise snap closed.
    x.set(info.offset.x <= -ACTIONS_WIDTH * 0.6 ? -ACTIONS_WIDTH : 0)
  }

  return (
    <div ref={rowRef} className="relative overflow-hidden">
      {/* Action strip beneath the row — Edit + Delete, revealed on swipe-left. */}
      <motion.div
        aria-hidden
        style={{ opacity: actionsOpacity }}
        className="absolute inset-y-0 right-0 flex items-center gap-1 pr-1"
      >
        <button
          type="button"
          aria-label={`Edit ${snippet.title}`}
          onClick={() => {
            x.set(0)
            onEdit()
          }}
          className="flex h-11 w-14 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
        >
          <Pencil className="size-4" />
        </button>
        <button
          type="button"
          aria-label={`Delete ${snippet.title}`}
          onClick={() => deleteSnippet.mutate(snippet.id)}
          className="flex h-11 w-14 items-center justify-center rounded-lg bg-destructive text-destructive-foreground"
        >
          <Trash2 className="size-4" />
        </button>
      </motion.div>

      {/* The draggable row itself. */}
      <motion.button
        type="button"
        drag="x"
        dragElastic={0.06}
        dragConstraints={{ left: -ACTIONS_WIDTH, right: 0 }}
        style={{ x }}
        transition={reduceMotion ? { duration: 0 } : springs.snappy}
        onPointerDown={armPress}
        onPointerUp={clearPress}
        onPointerCancel={clearPress}
        onDragStart={clearPress}
        onDragEnd={onDragEnd}
        onClick={onTap}
        className={cn(
          // ≥44pt row (h-12), 8px-ish continuous corner, glass card surface.
          'relative flex h-12 w-full items-center gap-3 rounded-xl bg-card px-3 text-left',
          'active:bg-secondary',
        )}
      >
        <span className="shrink-0 text-[14px] font-medium text-foreground">
          {snippet.title}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
          {snippet.body}
        </span>
      </motion.button>
    </div>
  )
}

export default SnippetPanel
