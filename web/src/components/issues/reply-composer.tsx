/**
 * `<ReplyComposer>` — the field that talks back to an agent.
 * ─────────────────────────────────────────────────────────────────────────────
 * EXTRACTED, behaviour unchanged, from `components/board/board-card.tsx` (fase
 * B2 T10). It was one export inside a 780-line page-only host, and the detail
 * pane imported the whole card to reach it.
 *
 * It is also the reason the board API is NOT deprecated with the page (§12.8):
 * this posts a DURABLE comment on an issue, which reaches an agent whose session
 * is stopped, gone or was never live. Chat structurally cannot do that — there
 * is no pty to type into — so replying to a dead session is a capability the
 * issue surface keeps and the chat surface will never have.
 *
 * The `onPointerDown`/`onClick` stopPropagation calls look defensive because
 * they are: the composer used to live inside a dnd-kit draggable card, and
 * typing in it must never start a drag. They are kept so the component can be
 * dropped into any host, including one that drags.
 */
import * as React from 'react'
import { CornerDownLeft, Loader2, Send } from 'lucide-react'
import { motion, useReducedMotion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { type BoardIssue } from '@/lib/api'
import { useMediaQuery } from '@/hooks/use-media-query'

/** The compact inline reply field on a Doing card. Collapsed to a single
 *  "Reply" chip until tapped (or auto-expanded on needs-input). Type → Send →
 *  delivers straight into the agent's session via the board /reply endpoint;
 *  sending clears the needs-input state (handled by the mutation). Exported so
 *  the desktop detail pane reuses the exact same drag-safe composer. */
export function ReplyComposer({
  issue,
  expanded,
  emphasized,
  onRequestOpen,
  onReply,
  placeholder,
}: {
  issue: BoardIssue
  expanded: boolean
  emphasized: boolean
  onRequestOpen: () => void
  onReply: (issue: BoardIssue, text: string) => Promise<void>
  /** Override the textarea placeholder. The detail pane sets this to a
   *  "leave a comment" prompt when the agent session is no longer live, so the
   *  field reads honestly as a durable note rather than a message to a dead PTY. */
  placeholder?: string
}) {
  const reduce = useReducedMotion()
  const fine = useMediaQuery('(pointer: fine)')
  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)

  // Autofocus when it expands on a needs-input card (desktop only — avoid
  // forcing the mobile keyboard open until the human taps in).
  React.useEffect(() => {
    if (expanded && emphasized && fine) inputRef.current?.focus()
  }, [expanded, emphasized, fine])

  async function send() {
    const t = text.trim()
    if (!t || sending) return
    setSending(true)
    try {
      await onReply(issue, t)
      setText('')
    } catch {
      /* the route surfaces a toast; keep the text so it can be retried */
    } finally {
      setSending(false)
    }
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRequestOpen()
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="inline-flex h-11 items-center gap-1.5 self-start rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Send className="size-3.5" />
        Reply to agent
      </button>
    )
  }

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : springs.snappy}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="flex items-end gap-1.5"
    >
      <textarea
        ref={inputRef}
        value={text}
        rows={1}
        placeholder={
          placeholder ?? (emphasized ? 'Answer the agent…' : 'Reply to the agent…')
        }
        aria-label={placeholder ?? 'Reply to the agent'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
          }
        }}
        className={cn(
          // text-[16px] on mobile keeps iOS Safari from auto-zooming on focus
          // (it zooms any focused field under 16px); md:text-[13px] restores the
          // compact desktop sizing where there is no focus-zoom behaviour.
          'min-h-[36px] flex-1 resize-none rounded-md border bg-background px-2.5 py-2 text-[16px] leading-snug shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-[13px]',
          emphasized ? 'border-warning/50' : 'border-input',
        )}
      />
      <button
        type="button"
        aria-label="Send reply"
        disabled={!text.trim() || sending}
        onClick={() => void send()}
        className="grid size-11 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&_svg]:size-4"
      >
        {sending ? (
          <Loader2 className="animate-spin" />
        ) : (
          <CornerDownLeft aria-hidden />
        )}
      </button>
    </motion.div>
  )
}
