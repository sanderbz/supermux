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
  Plus,
  Minimize2,
  Square,
  Settings2,
  ChevronRight,
  ChevronDown,
  CornerDownLeft,
  Keyboard,
  Ellipsis,
  Mic,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  ArrowRight,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { ApiSession } from '@/lib/api'
import { StatusDot } from '@/components/session-tile/status-dot'
import { useDictation } from '@/components/focus-mode/use-dictation'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// ── DesktopDock (M14, TECH_PLAN §4.4.3 — full desktop dock, pixel spec) ────────
//
//   ┌─[⌘K]─[+]─┃─[Esc][Tab][^C][^U]⚙─┃─[Detach ⌘D]─[Stop ⌘W]─┐
//   │  left cluster   editable 4-chip send-row    right cluster     │
//   └────────────────────────────────────────────────────────────────┘
//
// 56px tall (mirrors the mobile dock for muscle-memory), bg-card + 1px top
// border. The send-row chips call `sendKey(label)`; they are editable via a gear
// icon. The "+" snippet button + ⌘K palette button take callbacks too. The old
// "/" slash button was removed (DOCK) — slash commands now run from the Claude
// Tools sheet's Commands tab (tap a command → run in the focused terminal).
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
  /** DEPRECATED (DOCK): the "/" slash button was removed — slash commands now
   *  run from the Claude Tools sheet's Commands tab. Kept optional + unused so
   *  DesktopSplit's existing call site still type-checks; safe to drop later. */
  onRunSlash?: (cmd: string) => void
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
      {/* Left cluster (24px ≈ px-6 from edge): ⌘K palette, + snippets. The "/"
          slash button was removed (DOCK) — slash commands now run from the
          Claude Tools sheet's Commands tab. */}
      <div className="flex shrink-0 items-center gap-1">
        <IconButton icon={Command} label="Command palette (⌘K)" onClick={triggerPalette} />
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
//   │ [session ▾]  [⌨]  [···]  [＋]  [🎙]              [↵ Enter]               │
//   └───────────────────────────────────────────────────────────────────────┘
//
//   • Session pill   — status dot + name (truncated ~8ch) + chevron; tap →
//     SessionPickerSheet; horizontal swipe → prev/next session (peek-of-next),
//     unchanged. Truncating the name frees the horizontal room the dock needs.
//   • ⌨ toggle       — focuses/blurs the TERMINAL (summons/dismisses keyboard).
//   • Specials (···) — opens the QuickKeysSheet (curated tap-to-send chips).
//   • ＋ snippets     — opens the snippet panel; snippet run → term.send.
//   • 🎙 dictate      — Web Speech; the transcript is sent to the terminal +'\r'.
//   • ↵ Enter        — sends Enter (`\r`) to the terminal via `onSendKey('Enter')`
//     and KEEPS the soft keyboard up (preventDefault on pointer/mouse-down so the
//     tap never steals focus from xterm's hidden helper textarea — the SAME
//     focus-preservation trick the accessory keys use). Right-aligned cluster.
//   • Accessory strip — Esc/Tab/Ctrl-C/arrows, each → `sendKey` (the SAME named-
//     key path desktop's send-row + the joystick use). Pinned above the keyboard
//     via the route's `keyboardInset`, Termius-style.
//
// HIG: every interactive control here is ≥44×44pt — the iOS tap-target floor.
//
// VISUAL (DOCK polish): SF (sans) controls, NOT terminal-mono — the chips read as
// iOS QuickType-bar pills, not a hacker keymap. Soft `bg-secondary` fills with no
// hard 1px border, continuous 12px corners (rounded-xl), a single lighter SF-style
// icon stroke weight (1.75) at one 20px size, and `text-primary` only for the
// active/toggled state. One coherent rhythm with the overview/settings surfaces.
//
// iOS haptics caveat (§4.4): chip presses use a 0.92 scale (CSS-only feedback);
// navigator.vibrate(8) is gated by `'vibrate' in navigator` (Android only).

/** Accessory-strip keys, in Termius order. Each label maps to a `keyToBytes`
 *  name understood by `LiveTerminal.sendKey` — Esc/Tab/Ctrl-C plus a 4-way
 *  arrow cluster, the keys a soft keyboard lacks. */
const ACCESSORY_KEYS = ['Esc', 'Tab', 'Ctrl-C'] as const
// Arrows render as real SF-style chevron/arrow ICONS (not raw ←↑↓→ glyphs) so
// they share the dock's single icon stroke weight + size — cleaner than the
// terminal-y unicode arrows. Each `key` is the `keyToBytes` name `sendKey` wants.
const ARROW_KEYS = [
  { key: 'Left', Glyph: ArrowLeft },
  { key: 'Up', Glyph: ArrowUp },
  { key: 'Down', Glyph: ArrowDown },
  { key: 'Right', Glyph: ArrowRight },
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
  // ── dictation ──────────────────────────────────────────────────────────────
  // The "/" slash affordance was removed (DOCK): slash commands now run from the
  // Claude Tools sheet's Commands tab (tap a command → it runs in the focused
  // terminal). MobileDock keeps NO slash state.
  //
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
        // pb: at least ~10px of breathing room under the row even when the device
        // reports no safe-area inset (e.g. iPhone Air in the Vaul sheet), so the
        // session pill + Enter never sit flush against the viewport bottom; grows
        // to the home-indicator inset where there is one.
        'glass relative flex shrink-0 flex-col gap-2 border-t border-border/60 px-2.5 pb-[max(env(safe-area-inset-bottom),0.625rem)] pt-2',
        className,
      )}
    >
      {/* Accessory key strip — iOS QuickType-style, shown while the keyboard is
          open (the route pins the whole dock above the keyboard via
          `keyboardInset`). Each chip drives `sendKey` — the keys a soft keyboard
          lacks. Soft SF pills, not a terminal keymap. */}
      {keyboardOpen && (
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
          {ACCESSORY_KEYS.map((label) => (
            <AccessoryChip key={label} label={label} onTap={() => onSendKey(label)}>
              {label}
            </AccessoryChip>
          ))}
          <span className="h-5 w-px shrink-0 bg-border/50" aria-hidden />
          {ARROW_KEYS.map(({ key, Glyph }) => (
            <AccessoryChip
              key={key}
              label={`Arrow ${key}`}
              onTap={() => onSendKey(key)}
            >
              <Glyph className="size-[18px]" strokeWidth={1.75} aria-hidden />
            </AccessoryChip>
          ))}
          <div className="ml-auto shrink-0">
            <DockIcon label="Hide keyboard" onClick={onBlurTerm}>
              <ChevronDown className="size-5" strokeWidth={1.75} />
            </DockIcon>
          </div>
        </div>
      )}

      {/* Dock row — session-pill + accessory dock icons + Enter. NO text
          composer. The icon cluster is one balanced group; Enter is pushed to
          the right edge (the room the name-truncation frees). */}
      <div className="flex items-center gap-1">
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
          active={keyboardOpen}
        >
          <Keyboard className="size-5" strokeWidth={1.75} />
        </DockIcon>

        <DockIcon label="Specials" onClick={onOpenSpecials}>
          <Ellipsis className="size-5" strokeWidth={1.75} />
        </DockIcon>

        {onOpenSnippets && (
          <DockIcon label="Snippets" onClick={onOpenSnippets}>
            <Plus className="size-5" strokeWidth={1.75} />
          </DockIcon>
        )}

        {dictation.supported && (
          <DockIcon
            label={dictation.listening ? 'Stop dictation' : 'Dictate'}
            onClick={onMicTap}
            active={dictation.listening}
          >
            <Mic className="size-5" strokeWidth={1.75} />
          </DockIcon>
        )}

        {/* Enter — sends `\r` to the focused terminal so you can submit without
            the soft keyboard's return key. The `preventDefault` on
            pointer/mouse-down is load-bearing: it stops the tap from moving DOM
            focus off xterm's hidden helper textarea, which on iOS would dismiss
            the keyboard. The send still fires on `onClick`, so the keyboard
            stays up. Mirrors the accessory-key focus-preservation pattern.
            Right-aligned (ml-auto) into the space the name-truncation frees;
            primary-tinted as the dock's one affirmative action. */}
        <EnterButton onSend={() => onSendKey('Enter')} />
      </div>
    </div>
  )
}

/** The dock's Enter affordance — a primary-tinted ↵ pill pinned to the right of
 *  the dock row. Sends Enter (`\r`) via `onSendKey('Enter')` WITHOUT stealing
 *  focus from xterm (preventDefault on pointer/mouse-down keeps the soft keyboard
 *  up — the SAME trick the accessory keys use). ≥44pt, spring press, reduced-
 *  motion-safe (springs.buttonPress is a no-op scale change framer respects under
 *  prefers-reduced-motion). */
function EnterButton({ onSend }: { onSend: () => void }) {
  return (
    <motion.button
      type="button"
      aria-label="Send Enter"
      whileTap={{ scale: 0.94 }}
      transition={springs.buttonPress}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if ('vibrate' in navigator) navigator.vibrate(8)
        onSend()
      }}
      // Icon-only square (size-11 = 44pt floor) so it fits narrow iPhone widths
      // (iPhone Air) without crowding the dock row — the ↵ glyph alone reads as
      // "send" and the aria-label keeps it accessible. Primary-tinted soft fill
      // matching the app's affirmative controls (no hard border — iOS-native);
      // the ↵ glyph mirrors the dock's single SF-style stroke weight + 20px size.
      className="ml-auto flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 font-medium text-primary active:bg-primary/25"
    >
      <CornerDownLeft className="size-5" strokeWidth={1.75} aria-hidden />
    </motion.button>
  )
}

/** An accessory-strip key chip — iOS QuickType-bar style, ~38px tall inside a
 *  ≥44pt hit area, tap = sendKey. SF (sans) text, NOT terminal-mono; a soft
 *  `bg-secondary` fill with no hard border + continuous 12px corner, so the strip
 *  reads as a native keyboard accessory bar rather than a hacker keymap. No
 *  tooltip — touch has no hover. */
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
      // Don't steal focus from xterm's hidden helper textarea — without this the
      // tap moves DOM focus to the button, which on iOS dismisses the soft
      // keyboard (and breaks live-type). preventDefault on pointer/mouse-down
      // keeps the textarea focused so the keyboard stays up; the sendKey on
      // `onClick` still fires (the key reaches the pty). The standard accessory-
      // bar pattern (Termius / CodeEditor toolbars use the same trick).
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if ('vibrate' in navigator) navigator.vibrate(8)
        onTap()
      }}
      // ~38px visible height inside a ≥44pt vertical hit area via py; min-w keeps
      // single-glyph arrows finger-friendly. SF text (no font-mono), soft fill,
      // no border — the iOS-native accessory-bar look.
      className="flex h-[38px] min-w-11 shrink-0 items-center justify-center rounded-xl bg-secondary px-3 text-[14px] font-medium text-secondary-foreground active:bg-secondary/70"
    >
      {children}
    </motion.button>
  )
}

// ── Session pill with swipe-to-switch + peek-of-next ──────────────────────────

/** Truncate the bottom-left switcher's session name to ~8 chars + a trailing
 *  ellipsis so the pill stays compact — this frees the horizontal room the dock
 *  row (icon cluster + Enter) needs. The FULL name is always kept as the
 *  accessible `title`/`aria-label` on the pill, so nothing is lost. (This is the
 *  bottom switcher ONLY — the top header truncation lives in focus-header.tsx.) */
const PILL_NAME_MAX = 8
function truncatePillName(name: string): string {
  return name.length > PILL_NAME_MAX ? `${name.slice(0, PILL_NAME_MAX)}…` : name
}

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
    <div ref={ref} className="relative h-11 shrink-0" style={{ maxWidth: '40%' }}>
      {/* Peek-of-next, revealed beneath the dragging pill. */}
      <motion.div
        aria-hidden
        style={{ opacity: peekOpacity }}
        className="pointer-events-none absolute inset-0 flex items-center gap-1.5 rounded-full bg-secondary/60 px-3"
      >
        {peekSession && (
          <>
            <StatusDot status={peekSession.status} />
            <span className="min-w-0 truncate text-[14px] font-medium text-muted-foreground">
              {truncatePillName(peekSession.name)}
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
        // FULL name stays the accessible label so the truncated display never
        // hides which session you're on.
        title={current.name}
        aria-label={`Session ${current.name} — switch session`}
        className={cn(
          'relative flex h-11 w-full items-center gap-1.5 rounded-full bg-secondary px-3.5',
          'text-[14px] font-medium active:bg-secondary/70',
        )}
      >
        <StatusDot status={current.status} />
        {/* Display name truncated to ~8ch + ellipsis (frees dock room); the full
            name lives in title/aria-label above. */}
        <span className="min-w-0 flex-1 truncate text-left">
          {truncatePillName(current.name)}
        </span>
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
        />
      </motion.button>
    </div>
  )
}

/** A dock icon button — ≥44pt hit target, one 20px SF-weight glyph. `active`
 *  tints it `text-primary` with a soft fill (the toggled state: keyboard open /
 *  dictation live), otherwise it rests as a quiet `muted-foreground` icon. One
 *  coherent style across the whole row (iOS-native, no hard borders). */
function DockIcon({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string
  onClick: () => void
  /** Toggled/on state — primary tint + soft primary fill. */
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      whileTap={{ scale: 0.92 }}
      transition={springs.buttonPress}
      onClick={() => {
        if ('vibrate' in navigator) navigator.vibrate(8)
        onClick()
      }}
      // ≥44pt hit target (size-11 = 44px) per the iOS HIG floor; glyph stays 20px.
      // Continuous 12px corner; active = primary tint + soft fill, else a quiet
      // muted icon — one rhythm for the whole dock row.
      className={cn(
        'flex size-11 shrink-0 items-center justify-center rounded-xl',
        active
          ? 'bg-primary/15 text-primary active:bg-primary/25'
          : 'text-muted-foreground active:bg-secondary',
      )}
    >
      {children}
    </motion.button>
  )
}
