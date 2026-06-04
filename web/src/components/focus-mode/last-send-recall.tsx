// focus-mode/last-send-recall.tsx — the "what did I just type?" recall surface.
//
// One feature cluster, three rendered shapes, glued by a tiny shared content
// piece so layout + a11y are identical across desktop and mobile:
//
//   • LastSendButton   — Lucide Quote icon, slots into BOTH focus headers.
//                        Hidden when the session has no last send.
//   • LastSendBar      — desktop-only glass strip directly under the header.
//                        Auto-shows on session mount with a non-empty last send,
//                        fades on first terminal keypress / scroll / click /
//                        8s timeout / explicit × press. Tap the bar (anywhere
//                        but the ×) → open the popover.
//   • LastSendPopover  — desktop Radix popover anchored to the icon. Shared
//                        content (heading + body + Copy).
//   • LastSendSheet    — mobile Vaul bottom sheet equivalent.
//
// SOURCE OF TRUTH. The session row (`ApiSession`) already carries
// `last_send_text` + `last_send_at` (server SessionView fields). No new fetch
// or hook; consumers read straight off the row. `useLastSend` is a thin shape
// helper that returns a typed view for the components.
//
// SCOPE. The full design lives in
// `docs/superpowers/specs/2026-06-04-last-user-prompt-design.md`. This module
// implements §4 (UX) and §6 (frontend) of that spec.

import * as React from 'react'
import { Drawer } from 'vaul'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Clipboard, Quote, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { displayLabel, type ApiSession } from '@/lib/api'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Stable shape: either both fields are present (real last send) or both null
 *  (no submission yet). The server pairs them; we mirror that contract on the
 *  read side so consumers don't have to defend against half-present pairs. */
export interface LastSend {
  text: string
  sentAt: Date
}

/** Read the last-send pair off a session row, returning `null` when there is
 *  no submission. Memoised on the two relevant fields so consumers don't
 *  rerender on unrelated session updates. */
export function useLastSend(
  session: Pick<ApiSession, 'last_send_text' | 'last_send_at'> | undefined,
): LastSend | null {
  return React.useMemo(() => {
    const text = session?.last_send_text
    const at = session?.last_send_at
    if (!text || !at) return null
    return { text, sentAt: new Date(at * 1000) }
  }, [session?.last_send_text, session?.last_send_at])
}

const ONE_SEC = 1_000
const ONE_MIN = 60 * ONE_SEC
const ONE_HOUR = 60 * ONE_MIN
const ONE_DAY = 24 * ONE_HOUR

/** Compact relative-time formatter for the recall headings ("2m ago" / "3h ago").
 *  We deliberately don't use `Intl.RelativeTimeFormat` here — the recall heading
 *  has very little horizontal real-estate and the dynamic strings ("in 2 minutes",
 *  "vorige week") wouldn't fit. */
export function formatRecallTime(sentAt: Date, now: Date = new Date()): string {
  const diff = Math.max(0, now.getTime() - sentAt.getTime())
  if (diff < 30 * ONE_SEC) return 'just now'
  if (diff < ONE_MIN) return `${Math.round(diff / ONE_SEC)}s ago`
  if (diff < ONE_HOUR) return `${Math.round(diff / ONE_MIN)}m ago`
  if (diff < ONE_DAY) return `${Math.round(diff / ONE_HOUR)}h ago`
  return `${Math.round(diff / ONE_DAY)}d ago`
}

/** "preview · 200 chars max" footer when the stored text hit the DB truncation
 *  cap. We mirror the cap rather than thread it from the server — it's a fixed
 *  property of `db::sessions::set_last_send`. */
const DB_LAST_SEND_CAP = 200

// ── shared content (used by both Popover and Sheet) ──────────────────────────

function LastSendBody({
  recall,
  sessionLabel,
}: {
  recall: LastSend
  sessionLabel: string
}) {
  const [copied, setCopied] = React.useState(false)
  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(recall.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_400)
    } catch {
      // Clipboard can fail under permission-denied / non-secure contexts.
      // We don't surface an error — the body is still selectable text.
    }
  }, [recall.text])

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-[12px]">
        <span className="font-medium text-foreground">
          You · {formatRecallTime(recall.sentAt)}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy prompt to clipboard"
          className="flex h-7 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Clipboard className="size-3.5" />
          <span className="text-[11px]">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <p
        className="whitespace-pre-wrap break-words text-[13px] leading-snug text-foreground"
        // Length above DB cap means upstream truncation already happened — the
        // text we render IS the preview. The footer below makes that visible.
      >
        {recall.text}
      </p>
      {recall.text.length >= DB_LAST_SEND_CAP && (
        <p className="text-[10.5px] uppercase tracking-wide text-muted-foreground/70">
          preview · {DB_LAST_SEND_CAP} chars max
        </p>
      )}
      {/* Session label as a calm subscript so the popover/sheet self-identifies
          if the user double-checks which session they're recalling. */}
      <p className="text-[10.5px] text-muted-foreground/60">{sessionLabel}</p>
    </div>
  )
}

// ── LastSendButton (used in both headers) ────────────────────────────────────

export interface LastSendButtonProps {
  /** Toggled by the parent — the parent owns the popover/sheet open state so
   *  the bar (desktop) and the keyboard shortcut can drive it too. */
  onToggle: () => void
  /** Whether the recall surface is currently open (for `aria-expanded`). */
  open: boolean
  /** Forwarded to the button so the desktop popover can anchor here. */
  buttonRef?: React.Ref<HTMLButtonElement>
  /** Shortcut hint shown in the tooltip (desktop only; pass `undefined` on
   *  mobile to drop the suffix). */
  shortcutHint?: string
}

export function LastSendButton({
  onToggle,
  open,
  buttonRef,
  shortcutHint,
}: LastSendButtonProps) {
  const label = shortcutHint
    ? `Show last prompt sent (${shortcutHint})`
    : 'Show last prompt sent'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          ref={buttonRef}
          type="button"
          onClick={onToggle}
          whileTap={{ scale: 0.96 }}
          transition={springs.buttonPress}
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-foreground/80 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Quote className="size-4" />
        </motion.button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// ── LastSendPopover (desktop) ────────────────────────────────────────────────

export interface LastSendPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  recall: LastSend
  session: Pick<ApiSession, 'name' | 'display_name'>
  /** The icon button — anchor for the popover. */
  anchorRef: React.RefObject<HTMLElement | null>
}

export function LastSendPopover({
  open,
  onOpenChange,
  recall,
  session,
  anchorRef,
}: LastSendPopoverProps) {
  // Radix Popover is anchored via `<PopoverTrigger>`; we use the anchor-only API
  // by rendering an invisible trigger that mirrors the icon button's geometry,
  // so the popover lands at the icon without us needing to embed it INSIDE the
  // header (which would couple the header to the popover state).
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <span
          // Position the invisible trigger over the real button via the anchorRef.
          // The popover content positions itself relative to this trigger.
          ref={(el) => {
            // Mirror the anchor's bounding box. Cheap (one ref read per render);
            // refreshed on open by Radix's collision logic.
            if (el && anchorRef.current) {
              const r = anchorRef.current.getBoundingClientRect()
              el.style.position = 'fixed'
              el.style.left = `${r.left}px`
              el.style.top = `${r.top}px`
              el.style.width = `${r.width}px`
              el.style.height = `${r.height}px`
              el.style.pointerEvents = 'none'
            }
          }}
          aria-hidden
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="glass w-[320px] max-w-[calc(100vw-1rem)] rounded-xl border border-border/60 p-3"
        role="dialog"
        aria-label="Last prompt"
      >
        <LastSendBody recall={recall} sessionLabel={displayLabel(session)} />
      </PopoverContent>
    </Popover>
  )
}

// ── LastSendSheet (mobile) ───────────────────────────────────────────────────

export interface LastSendSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  recall: LastSend
  session: Pick<ApiSession, 'name' | 'display_name'>
}

export function LastSendSheet({
  open,
  onOpenChange,
  recall,
  session,
}: LastSendSheetProps) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[60] bg-black/40" />
        <Drawer.Content
          aria-describedby={undefined}
          className={cn(
            'glass fixed inset-x-0 bottom-0 z-[60] flex flex-col',
            'rounded-t-[10px] border-t border-border/60 pb-safe outline-none',
          )}
        >
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />
          <Drawer.Title className="px-4 pb-1 pt-3 text-[13px] font-semibold text-muted-foreground">
            Last prompt
          </Drawer.Title>
          <div className="px-4 pb-4 pt-1">
            <LastSendBody
              recall={recall}
              sessionLabel={displayLabel(session)}
            />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

// ── LastSendBar (desktop) — the auto-show glass strip ────────────────────────

export interface LastSendBarProps {
  recall: LastSend | null
  /** Resets the bar's auto-show effect when the user switches sessions. */
  sessionName: string
  /** Click on the bar (anywhere but ×) opens the popover. */
  onOpenRecall: () => void
}

const AUTO_SHOW_TIMEOUT_MS = 8_000

/**
 * Glass strip rendered directly below the focus header (desktop only).
 *
 * VISIBILITY MODEL.
 *   Mount with a non-null `recall` AND it differs from the last shown → show.
 *   Hide on: × press, 8s timer, terminal keypress, terminal click/scroll.
 *   We listen for the terminal-engagement events via document-level capture so
 *   we don't have to thread refs through the whole split — the bar fades on
 *   ANY pointerdown / wheel / keydown after it appears, and unsubscribes on
 *   hide. That matches "the user is engaged with their session now" without
 *   coupling to the xterm internals.
 *
 *   The auto-show is REPLAYED on session change (sessionName prop): switching
 *   to a different session is a fresh recall opportunity. Switching back to a
 *   session whose recall hasn't changed since last dismissal also replays —
 *   you want the context every time you re-arrive at a session, not just the
 *   first time you ever opened it.
 */
export function LastSendBar({ recall, sessionName, onOpenRecall }: LastSendBarProps) {
  const reduceMotion = useReducedMotion()
  const [visible, setVisible] = React.useState(false)

  // (Re-)trigger on session change OR when a recall appears for a session
  // that didn't have one. Hidden when there's no recall to show.
  React.useEffect(() => {
    if (recall) {
      setVisible(true)
    } else {
      setVisible(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionName, !!recall])

  // While visible: arm the 8s timeout AND the engagement listeners. Each
  // listener clears the bar; ALL of them are torn down on hide.
  React.useEffect(() => {
    if (!visible) return
    const hide = () => setVisible(false)
    const timer = window.setTimeout(hide, AUTO_SHOW_TIMEOUT_MS)
    const opts = { capture: true } as const
    document.addEventListener('keydown', hide, opts)
    document.addEventListener('pointerdown', hide, opts)
    document.addEventListener('wheel', hide, opts)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', hide, opts)
      document.removeEventListener('pointerdown', hide, opts)
      document.removeEventListener('wheel', hide, opts)
    }
  }, [visible])

  // Live announce when the bar appears — once per appearance. The label is the
  // body itself so screen-reader users get the recall context too.
  const ariaLive = visible ? 'polite' : 'off'

  if (!recall) return null

  const enter = reduceMotion
    ? { opacity: 1, height: 32 }
    : { opacity: 1, height: 32, transition: { duration: 0.22 } }
  const exit = reduceMotion
    ? { opacity: 0, height: 0 }
    : { opacity: 0, height: 0, transition: { duration: 0.18 } }

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          layout="position"
          initial={{ opacity: 0, height: 0 }}
          animate={enter}
          exit={exit}
          aria-live={ariaLive}
          role="status"
          className="glass shrink-0 overflow-hidden border-b border-border/50 backdrop-blur-md"
        >
          <div className="flex h-8 items-center gap-2 px-3 text-[12px]">
            <button
              type="button"
              onClick={onOpenRecall}
              className="flex min-w-0 flex-1 items-center gap-2 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`You said ${formatRecallTime(recall.sentAt)}: ${recall.text}`}
            >
              <span className="shrink-0 font-medium text-foreground">
                You · {formatRecallTime(recall.sentAt)}
              </span>
              <span className="min-w-0 truncate italic text-foreground/85">
                “{recall.text}”
              </span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setVisible(false)
              }}
              aria-label="Dismiss last prompt"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
