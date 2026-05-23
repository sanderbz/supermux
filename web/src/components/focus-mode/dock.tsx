// focus-mode/dock.tsx — the focus-mode docks for BOTH viewports.
//
//   • DesktopDock — M14 (TECH_PLAN §4.4.3): the full desktop dock (left cluster /
//     editable 4-chip send-row / right cluster). Imported by DesktopSplit.
//   • MobileDock  — M15 (TECH_PLAN §4.4.1): the 56pt bottom dock inside the Vaul
//     sheet (session-pill / keyboard toggle / specials / composer). Imported by
//     focus/mobile.tsx.
//
// The two are disjoint surfaces co-located here; the merge keeps both.

import * as React from 'react'
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type PanInfo,
} from 'framer-motion'
import {
  Command,
  Slash,
  Plus,
  Minimize2,
  Square,
  Settings2,
  ChevronRight,
  Keyboard,
  MoreHorizontal,
  ArrowUp,
  Mic,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { ApiSession } from '@/lib/api'
import { StatusDot } from '@/components/session-tile/status-dot'
import { SlashMenu } from '@/components/focus-mode/slash-menu'
import { useDictation } from '@/components/focus-mode/use-dictation'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// ── DesktopDock (M14, TECH_PLAN §4.4.3 — full desktop dock, pixel spec) ────────
//
//   ┌─[⌘K]─[/]─[+]─┃─[Esc][Tab][^C][^U]⚙─┃─[Detach ⌘D]─[Stop ⌘W]─┐
//   │  left cluster   editable 4-chip send-row    right cluster     │
//   └────────────────────────────────────────────────────────────────┘
//
// 56px tall (mirrors the mobile dock for muscle-memory), bg-card + 1px top
// border. The send-row chips call `sendKey(label)`; they are editable via a gear
// icon. The "/" slash button surfaces the M18 slash menu (stubbed to a callback
// here so M18 plugs in WITHOUT editing this file — §29 dep-graph fix). The "+"
// snippet button + ⌘K palette button take callbacks too.
//
// VISUAL: iOS-native — SF Mono chips, 8px continuous corners, ≥44pt hit targets,
// Title-Case tooltips, spring button-press, no `transition: all`.

/** Default send-row chips — Esc / Tab / Ctrl-C / Ctrl-U (§4.4.3). Each maps to
 *  a `keyToBytes` name understood by `LiveTerminal.sendKey`. */
const DEFAULT_SEND_CHIPS = ['Esc', 'Tab', 'Ctrl-C', 'Ctrl-U'] as const

export interface DesktopDockProps {
  /** Tap a send-row chip → emit that key into the pty (§4.4.3). */
  onSendKey: (label: string) => void
  /** "+" snippet-drawer toggle — opens the M18 snippet side-sheet. */
  onSnippets?: () => void
  /** Run a slash command in the focused session — sends `cmd\r` to the pty so
   *  the agent actually executes it. Wired by DesktopSplit to the M13 live
   *  terminal's `send`. The desktop dock has NO text composer (deliberate —
   *  the terminal is the composer), so the "/" button opens an inline popover
   *  hosting the M18 SlashMenu instead of typing into a hidden input. */
  onRunSlash: (cmd: string) => void
  /** Detach (⌘D): leave to overview, keep the session alive. */
  onDetach: () => void
  /** Stop (⌘W): confirm + stop the session. */
  onStop: () => void
}

/** Icon-button shell shared by the left/right clusters — 36×36 visible inside a
 *  44pt hit box, spring press, tooltip. */
function IconButton({
  icon: Icon,
  label,
  onClick,
  tone = 'default',
}: {
  icon: typeof Command
  label: string
  onClick?: () => void
  tone?: 'default' | 'destructive'
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          type="button"
          onClick={onClick}
          whileTap={{ scale: 0.94 }}
          transition={springs.buttonPress}
          aria-label={label}
          className={cn(
            'flex size-9 items-center justify-center rounded-xl',
            tone === 'destructive'
              ? 'text-destructive hover:bg-destructive/10'
              : 'text-foreground/80 hover:bg-secondary',
          )}
        >
          <Icon className="size-[18px]" />
        </motion.button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** A SF-Mono send-row chip — 28px tall, 8px corner, tap = sendKey. Tooltip shows
 *  the underlying tmux key name (§4.4.3). */
function SendChip({
  label,
  onSend,
}: {
  label: string
  onSend: (label: string) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          type="button"
          onClick={() => onSend(label)}
          whileTap={{ scale: 0.94 }}
          transition={springs.buttonPress}
          aria-label={`Send ${label}`}
          // 28px visible height inside a ≥44pt hit area via vertical padding.
          className="flex h-7 min-w-9 items-center justify-center rounded-lg border border-border bg-secondary px-2.5 font-mono text-[13px] font-semibold text-secondary-foreground"
        >
          {label}
        </motion.button>
      </TooltipTrigger>
      <TooltipContent>Send {label}</TooltipContent>
    </Tooltip>
  )
}

export function DesktopDock({
  onSendKey,
  onRunSlash,
  onSnippets,
  onDetach,
  onStop,
}: DesktopDockProps) {
  // The send-row is "editable via gear icon": clicking the gear cycles to an
  // editable state where each chip is a text input. Persistent storage is the
  // M16 `/api/kbd-groups` table — here we keep an in-memory edit (single source
  // for THIS dock); M16's manage-sheet supersedes it.
  const [chips, setChips] = React.useState<string[]>([...DEFAULT_SEND_CHIPS])
  const [editing, setEditing] = React.useState(false)

  // The "/" button opens the M18 SlashMenu in an anchored popover above the
  // dock. The menu drives a tiny in-dock filter string (the popover header)
  // since the desktop dock has no text composer to feed `value` from. Picking
  // a command sends `cmd\r` to the pty (via the `onRunSlash` parent callback)
  // and closes the popover.
  const [slashOpen, setSlashOpen] = React.useState(false)
  const [slashQuery, setSlashQuery] = React.useState('/')
  const openSlash = React.useCallback(() => {
    setSlashQuery('/')
    setSlashOpen(true)
  }, [])
  const closeSlash = React.useCallback(() => setSlashOpen(false), [])
  const onPickSlash = React.useCallback(
    (cmd: string) => {
      setSlashOpen(false)
      onRunSlash(cmd)
    },
    [onRunSlash],
  )

  // The global ⌘K palette is mounted at shell level (see <Layout>). The visible
  // "command" button is a convenience — it synthesizes the same keystroke so the
  // global listener opens the palette. No separate trigger callback needed.
  const triggerPalette = React.useCallback(() => {
    const isMac =
      typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
        cancelable: true,
      }),
    )
  }, [])

  return (
    <div className="relative flex h-14 shrink-0 items-center gap-2 border-t border-border bg-card px-6">
      {/* Slash-menu popover: anchored ABOVE the "/" button. A bare input sits
       *  on top — desktop has no text composer, so this serves the same role
       *  the mobile composer plays for the SlashMenu's `value` prop. */}
      {slashOpen && (
        <>
          {/* Backdrop — a click outside closes the popover. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={closeSlash}
            className="fixed inset-0 z-20 cursor-default bg-transparent"
          />
          <div className="pointer-events-none absolute bottom-full left-6 z-30 mb-2 w-[min(420px,90vw)] space-y-2">
            <div className="pointer-events-auto rounded-xl border border-border bg-card p-1.5 shadow-lg">
              <input
                autoFocus
                value={slashQuery}
                onChange={(e) => {
                  const v = e.target.value
                  // Always keep a leading "/" so the menu filter stays aligned
                  // with the M18 mobile composer's prefix contract.
                  setSlashQuery(v.startsWith('/') ? v : `/${v}`)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    closeSlash()
                  }
                }}
                placeholder="/command"
                aria-label="Filter slash commands"
                className="h-8 w-full rounded-lg bg-transparent px-2 font-mono text-base md:text-[13px] outline-none"
              />
            </div>
            <div className="pointer-events-auto">
              <SlashMenu
                value={slashQuery}
                open={slashOpen}
                onSelect={onPickSlash}
                onDismiss={closeSlash}
              />
            </div>
          </div>
        </>
      )}

      {/* Left cluster (24px ≈ px-6 from edge): ⌘K palette, / slash, + snippets. */}
      <div className="flex shrink-0 items-center gap-1">
        <IconButton icon={Command} label="Command palette (⌘K)" onClick={triggerPalette} />
        <IconButton icon={Slash} label="Slash menu" onClick={openSlash} />
        <IconButton icon={Plus} label="Snippets" onClick={onSnippets} />
      </div>

      <span className="h-6 w-px shrink-0 bg-border" aria-hidden />

      {/* Center: editable 4-chip send-row + gear. */}
      <div className="flex flex-1 items-center justify-center gap-1.5">
        {editing
          ? chips.map((label, i) => (
              <input
                key={i}
                value={label}
                onChange={(e) =>
                  setChips((c) => c.map((v, j) => (j === i ? e.target.value : v)))
                }
                aria-label={`Send-row chip ${i + 1}`}
                className="h-7 w-16 rounded-lg border border-primary/60 bg-background px-2 text-center font-mono text-base md:text-[13px] font-semibold outline-none focus:ring-2 focus:ring-ring"
              />
            ))
          : chips.map((label) => (
              <SendChip key={label} label={label} onSend={onSendKey} />
            ))}
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.button
              type="button"
              onClick={() => setEditing((e) => !e)}
              whileTap={{ scale: 0.94 }}
              transition={springs.buttonPress}
              aria-label={editing ? 'Done editing send row' : 'Edit send row'}
              aria-pressed={editing}
              className={cn(
                'flex size-8 items-center justify-center rounded-lg',
                editing
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-secondary',
              )}
            >
              <Settings2 className="size-4" />
            </motion.button>
          </TooltipTrigger>
          <TooltipContent>{editing ? 'Done' : 'Edit send row'}</TooltipContent>
        </Tooltip>
      </div>

      <span className="h-6 w-px shrink-0 bg-border" aria-hidden />

      {/* Right cluster (24px from edge): Detach ⌘D, Stop ⌘W. */}
      <div className="flex shrink-0 items-center gap-1">
        <IconButton icon={Minimize2} label="Detach (⌘D)" onClick={onDetach} />
        <IconButton
          icon={Square}
          label="Stop session (⌘W)"
          onClick={onStop}
          tone="destructive"
        />
      </div>
    </div>
  )
}

export default DesktopDock

// ── MobileDock (M15, TECH_PLAN §4.4.1) ────────────────────────────────────────
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
//   • Input field     — grows 44→80px (≤3 lines, 44pt floor); Enter (no shift)
//     sends. A leading "/" surfaces a slash hint (full slash menu lands in M18).
//   • Send button     — 44pt circular (HIG floor); 40% opacity + disabled when
//     empty (Linear/ChatGPT composer spec).
//
// HIG: every interactive control here (session pill, ⌨/··· dock icons, composer
// input, send) is ≥44×44pt — the iOS Human Interface Guidelines tap-target floor.
//
// iOS haptics caveat (§4.4): chip presses use a 0.96 scale (CSS-only feedback);
// navigator.vibrate(8) is gated by `'vibrate' in navigator` (Android only).

export interface MobileDockProps {
  current: ApiSession
  /** Peek-of-next preview targets for the session-pill swipe. */
  prevSession: ApiSession | null
  nextSession: ApiSession | null
  onOpenPicker: () => void
  onOpenSpecials: () => void
  /** Switch focus to a neighbour session (committed pill swipe). */
  onSwitchSession: (name: string) => void
  /** Send literal text (the composed input) to the pty. */
  onSend: (text: string) => void
  /** Open the M18 snippet panel (in-place slide-up). */
  onOpenSnippets?: () => void
  /** Registration hook the parent calls with this composer's imperative
   *  `insert(text)` once mounted, so the route-level M18 snippet panel can
   *  drop a snippet body into THIS input (tap-to-insert). */
  registerInsert?: (insert: ((text: string) => void) | null) => void
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
  onOpenSnippets,
  registerInsert,
  className,
}: MobileDockProps) {
  const [value, setValue] = React.useState('')
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)
  const canSend = value.trim().length > 0

  // ── M18: slash menu + dictation ───────────────────────────────────────────
  // The slash menu shows whenever the composer value starts with "/" and the
  // field is focused; selecting a command replaces the value (cursor at end).
  const [focused, setFocused] = React.useState(false)
  const [slashDismissed, setSlashDismissed] = React.useState(false)
  const slashOpen = focused && value.startsWith('/') && !slashDismissed

  const setComposer = React.useCallback((next: string) => {
    setValue(next)
    const el = inputRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 80)}px`
    }
  }, [])

  const onSlashSelect = React.useCallback(
    (cmd: string) => {
      // Replace the input with the picked command + a trailing space; park the
      // caret at the end and keep the keyboard up for the argument.
      const next = `${cmd} `
      setComposer(next)
      setSlashDismissed(true)
      const el = inputRef.current
      if (el) {
        el.focus()
        requestAnimationFrame(() => el.setSelectionRange(next.length, next.length))
      }
    },
    [setComposer],
  )

  // Dictation — the mic button toggles Web Speech; results land in the input.
  const dictation = useDictation(setComposer)

  // M18 snippet-panel tap-to-insert: expose an imperative `insert` to the parent
  // so the route-level <SnippetPanel> can drop a snippet body into THIS input.
  // `valueRef` mirrors the latest value (synced in an effect) so the stable
  // `insert` reads it without re-registering on every keystroke.
  const valueRef = React.useRef(value)
  React.useEffect(() => {
    valueRef.current = value
  }, [value])
  const insert = React.useCallback(
    (text: string) => {
      const next = valueRef.current ? `${valueRef.current}${text}` : text
      setComposer(next)
      if (text.startsWith('/')) setSlashDismissed(false)
      const el = inputRef.current
      if (el) {
        el.focus()
        requestAnimationFrame(() =>
          el.setSelectionRange(next.length, next.length),
        )
      }
    },
    [setComposer],
  )
  React.useEffect(() => {
    registerInsert?.(insert)
    return () => registerInsert?.(null)
  }, [registerInsert, insert])

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
    // A fresh "/" re-arms the slash menu after a previous dismissal.
    if (e.target.value.startsWith('/')) setSlashDismissed(false)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 80)}px`
  }

  return (
    <div
      className={cn(
        'glass relative flex shrink-0 items-end gap-1.5 border-t border-border/60 px-2 pb-safe pt-2',
        className,
      )}
    >
      {/* M18 slash menu — floats ABOVE the dock, anchored to the composer. */}
      <div className="pointer-events-none absolute inset-x-2 bottom-full mb-2">
        <div className="pointer-events-auto">
          <SlashMenu
            value={value}
            open={slashOpen}
            onSelect={onSlashSelect}
            onDismiss={() => setSlashDismissed(true)}
          />
        </div>
      </div>

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

      {onOpenSnippets && (
        <DockIcon label="Snippets" onClick={onOpenSnippets}>
          <Plus className="size-5" />
        </DockIcon>
      )}

      {dictation.supported && (
        <DockIcon
          label={dictation.listening ? 'Stop dictation' : 'Dictate'}
          onClick={dictation.toggle}
        >
          <Mic
            className={cn('size-5', dictation.listening && 'text-primary')}
          />
        </DockIcon>
      )}

      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        onChange={onInput}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          // While the slash menu is open let it own Arrow/Enter/Escape.
          if (slashOpen && ['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) {
            return
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={value.startsWith('/') ? 'Slash command…' : 'Message…'}
        className={cn(
          'mb-0.5 min-h-11 min-w-0 flex-1 resize-none rounded-2xl border border-border bg-background',
          // text-base (16px) — iOS Safari auto-zooms any focused input <16px;
          // bumping from 15px → 16px is the proper modern fix. Do NOT add
          // user-scalable=no to the viewport meta (a11y regression). leading-5
          // (20px) is unchanged so the row height stays the same.
          'px-3 py-2.5 text-base leading-5 outline-none focus:ring-2 focus:ring-ring',
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
          'mb-0.5 flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground',
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
  current: ApiSession
  prevSession: ApiSession | null
  nextSession: ApiSession | null
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
  const [peekSession, setPeekSession] = React.useState<ApiSession | null>(null)
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
    <div ref={ref} className="relative h-11 shrink-0" style={{ maxWidth: '46%' }}>
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
          'relative flex h-11 w-full items-center gap-1.5 rounded-full border border-border bg-card px-3',
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
      // ≥44pt hit target (size-11 = 44px) per the iOS HIG floor; glyph stays 20px.
      className="mb-0.5 flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground active:bg-secondary"
    >
      {children}
    </motion.button>
  )
}
