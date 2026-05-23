// focus-mode/dock.tsx — the focus-mode docks for BOTH viewports.
//
//   • DesktopDock — M14 (TECH_PLAN §4.4.3): the full desktop dock (left cluster /
//     editable 4-chip send-row / right cluster). Imported by DesktopSplit.
//   • MobileDock  — M15 (TECH_PLAN §4.4.1) → LIVE-TYPE rework: the accessory bar
//     inside the Vaul sheet (session-pill / ⌨ toggle / slash / specials /
//     snippets / dictate + a keyboard-pinned Esc/Tab/^C/arrows strip). NO text
//     composer — you type straight into the terminal. Imported by focus/mobile.tsx.
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
  ChevronDown,
  Keyboard,
  MoreHorizontal,
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

// ── MobileDock (M15 → M-mobile-livetype LIVE-TYPE rework) ─────────────────────
//
// The bar pinned below the terminal inside the Vaul sheet. LIVE-TYPE model: you
// type DIRECTLY into the terminal (xterm's hidden helper textarea is the single
// keystroke-capture element, same `term.onData`→pty path desktop uses) — the
// dock is now the ACCESSORY surface, not a second input. The old chat-style
// compose textarea + Send button were removed: two real textareas (xterm vs the
// composer) fought for focus, which is what made typing feel broken, and a
// line-buffered composer can't drive interactive TUIs (no live Ctrl-C, no arrow
// nav in claude/vim/fzf, no char-at-a-time prompts).
//
// Layout (two rows when the keyboard is open):
//   ┌ accessory key strip — rides the keyboard top ──────────────────────────┐
//   │ [Esc] [Tab] [^C] [←][↑][↓][→] [⌨ hide]                                  │
//   ├ dock row ───────────────────────────────────────────────────────────────┤
//   │ [session-pill ▾]  [⌨ toggle]  [···]  [＋ snippets]  [🎙 dictate]         │
//   └───────────────────────────────────────────────────────────────────────┘
//
//   • Session pill   — status dot + name + chevron; tap → SessionPickerSheet;
//     horizontal swipe → prev/next session (peek-of-next), unchanged.
//   • ⌨ toggle       — focuses/blurs the TERMINAL (summons/dismisses keyboard).
//   • Specials (···) — opens the SpecialsSheet (kbd-groups 2×2 pager).
//   • ＋ snippets     — opens the M18 snippet panel; snippet run → term.send.
//   • 🎙 dictate      — Web Speech; the transcript is sent to the terminal +'\r'.
//   • Accessory strip — Esc/Tab/Ctrl-C/arrows, each → `sendKey` (the SAME named-
//     key path desktop's send-row + the joystick use). Pinned above the keyboard
//     via the route's `keyboardInset`, Termius-style.
//
// HIG: every interactive control here is ≥44×44pt — the iOS tap-target floor.
//
// iOS haptics caveat (§4.4): chip presses use a 0.92 scale (CSS-only feedback);
// navigator.vibrate(8) is gated by `'vibrate' in navigator` (Android only).

/** Accessory-strip keys, in Termius order. Each label maps to a `keyToBytes`
 *  name understood by `LiveTerminal.sendKey` — Esc/Tab/Ctrl-C plus a 4-way
 *  arrow cluster, the keys a soft keyboard lacks. */
const ACCESSORY_KEYS = ['Esc', 'Tab', 'Ctrl-C'] as const
const ARROW_KEYS = [
  { key: 'Left', glyph: '←' },
  { key: 'Up', glyph: '↑' },
  { key: 'Down', glyph: '↓' },
  { key: 'Right', glyph: '→' },
] as const

export interface MobileDockProps {
  current: ApiSession
  /** Peek-of-next preview targets for the session-pill swipe. */
  prevSession: ApiSession | null
  nextSession: ApiSession | null
  onOpenPicker: () => void
  onOpenSpecials: () => void
  /** Switch focus to a neighbour session (committed pill swipe). */
  onSwitchSession: (name: string) => void
  /** Send literal text to the pty — used by dictation (transcript +'\r'). */
  onSend: (text: string) => void
  /** Send a named key (Esc/Tab/Ctrl-C/arrows) — the accessory strip drives this,
   *  the SAME path the desktop send-row + joystick use. */
  onSendKey: (key: string) => void
  /** Focus the terminal (summon the keyboard) — the ⌨ toggle + the strip's
   *  show-keyboard tap call this so xterm is the unambiguous keyboard owner. */
  onFocusTerm: () => void
  /** Blur the terminal (dismiss the keyboard) — the ⌨ toggle when already open. */
  onBlurTerm: () => void
  /** True when the soft keyboard is open (from `useKeyboardViewport`). Shows the
   *  accessory key strip + flips the ⌨ toggle to "hide". */
  keyboardOpen?: boolean
  /** Open the M18 snippet panel (in-place slide-up). */
  onOpenSnippets?: () => void
  /** Registration hook the parent calls with this dock's imperative
   *  `insert(text)` once mounted, so the route-level M18 snippet panel can drop
   *  a snippet body straight into the terminal (tap-to-insert sends it live). */
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
  onSendKey,
  onFocusTerm,
  onBlurTerm,
  keyboardOpen = false,
  onOpenSnippets,
  registerInsert,
  className,
}: MobileDockProps) {
  // ── M18: slash menu + dictation ───────────────────────────────────────────
  // The "/" affordance lives in the SlashMenu, anchored above the dock. With no
  // composer to type into, the menu opens on demand and a pick is sent LIVE to
  // the terminal (`cmd\r`) — the keystroke-capture stays xterm's helper textarea.
  const [slashOpen, setSlashOpen] = React.useState(false)
  const onSlashSelect = React.useCallback(
    (cmd: string) => {
      // Send the picked command live + keep the keyboard up for the next line.
      onSend(`${cmd} `)
      setSlashOpen(false)
      onFocusTerm()
    },
    [onSend, onFocusTerm],
  )

  // Dictation — the mic toggles Web Speech. R5 FIX: the flush no longer depends
  // on Web Speech firing `onend` (flaky on iOS Safari / WKWebView — when it never
  // arrives the transcript was silently dropped). Instead `useDictation` surfaces
  // each FINAL segment via `onFinal` the instant it commits, and we send that
  // segment STRAIGHT to the pty via `onSend` (the same sendRaw path keystrokes
  // use). The cumulative interim (`onTranscript`) is buffered only as a SAFETY
  // tail for any text that finalized late / never finalized — flushed on the stop
  // tap, blur, and unmount. A "sent length" cursor dedupes the two paths so a
  // segment can never land twice.
  const pendingTranscriptRef = React.useRef('')
  // Number of leading chars of the cumulative transcript already sent (via
  // onFinal). The safety flush only emits the UNSENT tail past this cursor.
  const sentLenRef = React.useRef(0)
  const dictation = useDictation({
    // Cumulative interim — buffered for the safety-tail flush; never sent here.
    onTranscript: React.useCallback((text: string) => {
      pendingTranscriptRef.current = text
    }, []),
    // Final segment — send immediately (does not wait for the unreliable onend).
    onFinal: React.useCallback(
      (segment: string) => {
        const seg = segment.trim()
        if (!seg) return
        onSend(seg + ' ')
        onFocusTerm()
        // Advance the dedupe cursor so the safety flush won't re-send this text.
        // Web Speech's cumulative transcript joins finals with spaces, so account
        // for the trailing separator we appended.
        sentLenRef.current = pendingTranscriptRef.current.length
      },
      [onSend, onFocusTerm],
    ),
  })
  // Flush only the UNSENT tail of the cumulative transcript — text the user spoke
  // that never finalized (so `onFinal` never fired for it) before they stopped.
  // Clears state BEFORE sending so the three flush paths (stop tap, blur, unmount)
  // can never double-send: whichever runs first consumes the tail, the rest no-op.
  const flushTranscript = React.useCallback(() => {
    const full = pendingTranscriptRef.current
    const tail = full.slice(sentLenRef.current).trim()
    pendingTranscriptRef.current = ''
    sentLenRef.current = 0
    if (tail) {
      onSend(tail + ' ')
      onFocusTerm()
    }
  }, [onSend, onFocusTerm])
  // Keep a ref to the latest flush so the unmount cleanup (which must run with an
  // empty dep list, or it would fire on every onSend identity change) always
  // calls the current version.
  const flushTranscriptRef = React.useRef(flushTranscript)
  React.useEffect(() => {
    flushTranscriptRef.current = flushTranscript
  }, [flushTranscript])

  // Safety flush on the listening→idle transition (kept for the case where onend
  // DOES fire) — flushes any unsent interim tail. Belt-and-suspenders with the
  // stop-tap flush below; the dedupe cursor makes both safe.
  const wasListeningRef = React.useRef(false)
  React.useEffect(() => {
    if (wasListeningRef.current && !dictation.listening) {
      flushTranscript()
    }
    wasListeningRef.current = dictation.listening
  }, [dictation.listening, flushTranscript])

  // Mic tap: when STOPPING, flush the unsent tail INSIDE the user gesture (WS
  // still open, dock still mounted) THEN stop — independent of whether `onend`
  // ever arrives. When starting, just start. (Final segments already streamed via
  // onFinal while listening; this catches anything still interim at stop time.)
  const onMicTap = React.useCallback(() => {
    if (dictation.listening) {
      flushTranscript()
      dictation.stop()
    } else {
      dictation.start()
    }
  }, [dictation, flushTranscript])

  // Defensive flush on unmount: if the dock unmounts mid-dictation (route change,
  // focus-pane teardown) without a stop tap or `onend`, flush any unsent tail. The
  // clear-before-send guard in flushTranscript keeps this safe against a race.
  React.useEffect(() => {
    return () => flushTranscriptRef.current()
  }, [])

  // M18 snippet-panel tap-to-insert: with no composer, "insert" now sends the
  // snippet body straight to the terminal (live-type model — the body lands at
  // the shell prompt exactly as if typed). The parent's onRun path appends '\r'.
  const insert = React.useCallback(
    (text: string) => {
      onSend(text)
      onFocusTerm()
    },
    [onSend, onFocusTerm],
  )
  React.useEffect(() => {
    registerInsert?.(insert)
    return () => registerInsert?.(null)
  }, [registerInsert, insert])

  return (
    <div
      className={cn(
        'glass relative flex shrink-0 flex-col gap-1.5 border-t border-border/60 px-2 pb-safe pt-2',
        className,
      )}
    >
      {/* M18 slash menu — floats ABOVE the dock. */}
      <div className="pointer-events-none absolute inset-x-2 bottom-full mb-2">
        <div className="pointer-events-auto">
          <SlashMenu
            value="/"
            open={slashOpen}
            onSelect={onSlashSelect}
            onDismiss={() => setSlashOpen(false)}
          />
        </div>
      </div>

      {/* Accessory key strip — Termius-style, shown while the keyboard is open
          (the route pins the whole dock above the keyboard via `keyboardInset`).
          Each chip drives `sendKey` — the keys a soft keyboard lacks. */}
      {keyboardOpen && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          {ACCESSORY_KEYS.map((label) => (
            <AccessoryChip key={label} label={label} onTap={() => onSendKey(label)}>
              {label}
            </AccessoryChip>
          ))}
          <span className="h-6 w-px shrink-0 bg-border/60" aria-hidden />
          {ARROW_KEYS.map(({ key, glyph }) => (
            <AccessoryChip
              key={key}
              label={`Arrow ${key}`}
              onTap={() => onSendKey(key)}
            >
              <span aria-hidden className="text-[15px] leading-none">
                {glyph}
              </span>
            </AccessoryChip>
          ))}
          <div className="ml-auto shrink-0">
            <DockIcon label="Hide keyboard" onClick={onBlurTerm}>
              <ChevronDown className="size-5" />
            </DockIcon>
          </div>
        </div>
      )}

      {/* Dock row — session-pill + accessory dock icons. NO text composer. */}
      <div className="flex items-end gap-1.5">
        <SessionPill
          current={current}
          prevSession={prevSession}
          nextSession={nextSession}
          onTap={onOpenPicker}
          onSwitch={onSwitchSession}
        />

        <DockIcon
          label={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'}
          onClick={keyboardOpen ? onBlurTerm : onFocusTerm}
        >
          <Keyboard
            className={cn('size-5', keyboardOpen && 'text-primary')}
          />
        </DockIcon>

        <DockIcon label="Slash command" onClick={() => setSlashOpen((o) => !o)}>
          <Slash className="size-5" />
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
            onClick={onMicTap}
          >
            <Mic
              className={cn('size-5', dictation.listening && 'text-primary')}
            />
          </DockIcon>
        )}
      </div>
    </div>
  )
}

/** An accessory-strip key chip — SF-Mono, 36px tall inside a ≥44pt hit area,
 *  tap = sendKey. Mirrors the desktop SendChip but tuned for the keyboard-top
 *  strip (no tooltip — touch has no hover). */
function AccessoryChip({
  label,
  onTap,
  children,
}: {
  label: string
  onTap: () => void
  children: React.ReactNode
}) {
  return (
    <motion.button
      type="button"
      aria-label={`Send ${label}`}
      whileTap={{ scale: 0.92 }}
      transition={springs.buttonPress}
      onClick={() => {
        if ('vibrate' in navigator) navigator.vibrate(8)
        onTap()
      }}
      // 36px visible height inside a ≥44pt vertical hit area via py; min-w keeps
      // single-glyph arrows finger-friendly.
      className="flex h-9 min-w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary px-2.5 font-mono text-[13px] font-semibold text-secondary-foreground"
    >
      {children}
    </motion.button>
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
