// MobileDock — M15 bottom dock (TECH_PLAN §4.4.1).
//
// The 56pt (+ safe-area-bottom) bar pinned below the terminal inside the Vaul
// sheet. Layout: [session-pill ▾] [⌨ toggle] [···] [input ──→ send].
//
//   • Session pill   — capsule with status dot + name + chevron. Tap opens the
//     SessionPickerSheet. Horizontal swipe switches prev/next session with a
//     peek-of-next preview during the drag (Framer Motion drag="x"), springing
//     back below the 40% threshold and snapping with `springs.sheetDetent` past
//     it (CEO M15 amplification).
//   • Keyboard toggle — focuses/blurs the hidden input to show/hide the keyboard.
//   • Specials (···)  — opens the SpecialsSheet (kbd-groups 2×2 pager).
//   • Input field     — grows 32→80px (≤3 lines); Enter (no shift) sends. A
//     leading "/" surfaces a slash hint (the full slash menu lands in M18).
//   • Send button     — 32px circular; 40% opacity + disabled when empty
//     (Linear/ChatGPT composer spec).
//
// iOS haptics caveat (§4.4): chip presses use a 0.96 scale (CSS-only feedback);
// navigator.vibrate(8) is gated by `'vibrate' in navigator` (Android only).

import * as React from 'react'
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type PanInfo,
} from 'framer-motion'
import { ChevronRight, Keyboard, MoreHorizontal, ArrowUp } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { SessionSummary } from '@/lib/api'
import { StatusDot } from '@/components/session-tile/status-dot'

export interface MobileDockProps {
  current: SessionSummary
  /** Peek-of-next preview targets for the session-pill swipe. */
  prevSession: SessionSummary | null
  nextSession: SessionSummary | null
  onOpenPicker: () => void
  onOpenSpecials: () => void
  /** Switch focus to a neighbour session (committed pill swipe). */
  onSwitchSession: (name: string) => void
  /** Send literal text (the composed input) to the pty. */
  onSend: (text: string) => void
  className?: string
}

export function MobileDock({
  current,
  prevSession,
  nextSession,
  onOpenPicker,
  onOpenSpecials,
  onSwitchSession,
  onSend,
  className,
}: MobileDockProps) {
  const [value, setValue] = React.useState('')
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)
  const canSend = value.trim().length > 0

  const submit = () => {
    const text = value.trim()
    if (!text) return
    onSend(text + '\r')
    setValue('')
    // Keep the keyboard up for the next line (composer convention).
    inputRef.current?.focus()
  }

  // Auto-grow the textarea 32→80px (≤3 lines), then scroll internally.
  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 80)}px`
  }

  return (
    <div
      className={cn(
        'glass flex shrink-0 items-end gap-1.5 border-t border-border/60 px-2 pb-safe pt-2',
        className,
      )}
    >
      <SessionPill
        current={current}
        prevSession={prevSession}
        nextSession={nextSession}
        onTap={onOpenPicker}
        onSwitch={onSwitchSession}
      />

      <DockIcon
        label="Toggle keyboard"
        onClick={() => {
          const el = inputRef.current
          if (!el) return
          if (document.activeElement === el) el.blur()
          else el.focus()
        }}
      >
        <Keyboard className="size-5" />
      </DockIcon>

      <DockIcon label="Specials" onClick={onOpenSpecials}>
        <MoreHorizontal className="size-5" />
      </DockIcon>

      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        onChange={onInput}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={value.startsWith('/') ? 'Slash command…' : 'Message…'}
        className={cn(
          'mb-0.5 min-h-8 min-w-0 flex-1 resize-none rounded-2xl border border-border bg-background',
          'px-3 py-1.5 text-[15px] leading-5 outline-none focus:ring-2 focus:ring-ring',
        )}
      />

      <motion.button
        type="button"
        aria-label="Send"
        disabled={!canSend}
        whileTap={canSend ? { scale: 0.92 } : undefined}
        transition={springs.buttonPress}
        onClick={submit}
        className={cn(
          'mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground',
          !canSend && 'opacity-40',
        )}
      >
        <ArrowUp className="size-4" />
      </motion.button>
    </div>
  )
}

// ── Session pill with swipe-to-switch + peek-of-next ──────────────────────────

function SessionPill({
  current,
  prevSession,
  nextSession,
  onTap,
  onSwitch,
}: {
  current: SessionSummary
  prevSession: SessionSummary | null
  nextSession: SessionSummary | null
  onTap: () => void
  onSwitch: (name: string) => void
}) {
  const reduceMotion = useReducedMotion()
  const x = useMotionValue(0)
  const [width, setWidth] = React.useState(140)
  const ref = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const measure = () => setWidth(ref.current?.clientWidth ?? 140)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // The peek-of-next sits beneath, revealed as the pill drags aside.
  const peekOpacity = useTransform(x, [-width * 0.4, 0, width * 0.4], [1, 0, 1])
  const peek = useTransform(x, (v) => (v < 0 ? nextSession : v > 0 ? prevSession : null))
  const [peekSession, setPeekSession] = React.useState<SessionSummary | null>(null)
  React.useEffect(() => peek.on('change', setPeekSession), [peek])

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const threshold = width * 0.4
    if (info.offset.x <= -threshold && nextSession) {
      onSwitch(nextSession.name)
    } else if (info.offset.x >= threshold && prevSession) {
      onSwitch(prevSession.name)
    }
    // Either way snap the pill back to centre; the new current re-renders.
    x.set(0)
  }

  const swipeable = Boolean(prevSession || nextSession)

  return (
    <div ref={ref} className="relative h-9 shrink-0" style={{ maxWidth: '46%' }}>
      {/* Peek-of-next, revealed beneath the dragging pill. */}
      <motion.div
        aria-hidden
        style={{ opacity: peekOpacity }}
        className="pointer-events-none absolute inset-0 flex items-center gap-1.5 rounded-full bg-secondary/60 px-3"
      >
        {peekSession && (
          <>
            <StatusDot status={peekSession.status} />
            <span className="min-w-0 truncate text-[13px] font-medium text-muted-foreground">
              {peekSession.name}
            </span>
          </>
        )}
      </motion.div>

      <motion.button
        type="button"
        drag={swipeable ? 'x' : false}
        dragElastic={0.2}
        dragConstraints={{ left: 0, right: 0 }}
        style={{ x }}
        whileTap={{ scale: 0.97 }}
        transition={reduceMotion ? { duration: 0 } : springs.sheetDetent}
        onDragEnd={onDragEnd}
        onClick={onTap}
        className={cn(
          'relative flex h-9 w-full items-center gap-1.5 rounded-full border border-border bg-card px-3',
          'text-[13px] font-medium',
        )}
      >
        <StatusDot status={current.status} />
        <span className="min-w-0 flex-1 truncate text-left">{current.name}</span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      </motion.button>
    </div>
  )
}

function DockIcon({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      whileTap={{ scale: 0.92 }}
      transition={springs.buttonPress}
      onClick={() => {
        if ('vibrate' in navigator) navigator.vibrate(8)
        onClick()
      }}
      // ≥44pt hit target via min-w/h-11 while the glyph stays compact.
      className="mb-0.5 flex size-8 min-h-8 min-w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground active:bg-secondary"
    >
      {children}
    </motion.button>
  )
}
