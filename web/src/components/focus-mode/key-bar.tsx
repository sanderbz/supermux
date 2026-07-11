// key-bar.tsx — the floating mobile KeyBar (mobile-focus-keybar spec,
// docs/superpowers/specs/2026-07-11-mobile-focus-keybar-design.md).
//
// Replaces the old behaviour of the dock's `···` "Specials" icon: instead of
// sliding up the QuickKeysSheet bottom drawer, `···` now TOGGLES this small
// floating glass pill pinned just under the header. It exists so the user can
// drive Claude's on-screen option lists with arrow keys + Enter WITHOUT
// summoning the soft keyboard (which reflows the whole viewport) and WITHOUT a
// bottom panel covering the very options being chosen.
//
//   • `useKeyBar()` — localStorage-backed persistence for `{ open, keys }`
//     under the pref key `focus_key_bar` (independent of the legacy
//     `quick_keys` server pref `useQuickKeys` owns). Simple by design: this is
//     a per-device UI toggle, not account data worth a server round-trip.
//   • `<KeyBar>` — the pill itself: a horizontally-scrolling row of small key
//     chips (arrow glyphs for Left/Up/Down/Right, short labels otherwise) plus
//     a trailing edit chip that opens `<KeyBarPicker>`.
//   • `<KeyBarPicker>` — the "customize which keys" sheet. Reuses the SHARED
//     `<MobileActionSheet>` Vaul shell and the `quick-keys.ts` catalog's
//     `CONTROL_ENTRIES` (filtered to `kind === 'key'`, i.e. the entries whose
//     payload IS a `sendKey`-understood name) as on/off toggle chips — no new
//     catalog, no new sheet primitive.
//
// SEND PATH: every chip calls the caller's `onSendKey(name)`, which the route
// wires straight to `termRef.current?.sendKey(name)` — the SAME imperative
// terminal handle the dock/joystick/quick-keys already drive. No new wire.
//
// TOUCH-SAFETY (hard requirement): only the pill's own footprint is
// `pointer-events-auto` — nothing here stretches a full-width catcher over the
// terminal. Every chip guards `onPointerDown`/`onMouseDown` with
// `preventDefault()` so a tap never steals DOM focus from xterm's hidden
// helper textarea (which would pop the soft keyboard on iOS); the actual send
// still fires (immediately, for the repeatable arrow chips; on `click` for
// the rest — the same trick `AccessoryChip`/`EnterButton` in dock.tsx use).

import * as React from 'react'
import {
  AnimatePresence,
  motion,
  useAnimationControls,
  useReducedMotion,
} from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CornerDownLeft,
  SlidersHorizontal,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useMediaQuery } from '@/hooks/use-media-query'
import { MobileActionSheet } from '@/components/focus-mode/mobile-action-sheet'
import { CONTROL_ENTRIES, type QuickEntry } from '@/components/focus-mode/quick-keys'

// ── persistence ────────────────────────────────────────────────────────────

// Exported so the DEV-only /dev/focus-mobile harness can pre-seed
// localStorage with `open: true` before mounting <MobileFocus> — the bar has
// no "start open" prop, its persisted state is the only source of truth.
export const KEY_BAR_STORAGE_KEY = 'focus_key_bar'

export interface KeyBarState {
  open: boolean
  keys: string[]
}

/** Default set — arrow-nav + Enter, useful with zero setup. Each is a plain
 *  `sendKey` name (the CONTROL_ENTRIES payload for the matching 'key' entry). */
export const DEFAULT_KEY_BAR_STATE: KeyBarState = {
  open: false,
  keys: ['Left', 'Up', 'Down', 'Right', 'Enter'],
}

/** Parse the persisted blob defensively — any malformed value falls back to
 *  the default so the bar is never in a broken state. SSR-safe. */
function readKeyBarState(): KeyBarState {
  if (typeof window === 'undefined') return DEFAULT_KEY_BAR_STATE
  try {
    const raw = window.localStorage.getItem(KEY_BAR_STORAGE_KEY)
    if (!raw) return DEFAULT_KEY_BAR_STATE
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return DEFAULT_KEY_BAR_STATE
    const o = parsed as Record<string, unknown>
    const open = typeof o.open === 'boolean' ? o.open : DEFAULT_KEY_BAR_STATE.open
    const keys =
      Array.isArray(o.keys) && o.keys.every((k) => typeof k === 'string')
        ? Array.from(new Set(o.keys as string[])) // dedupe a hand-edited blob
        : DEFAULT_KEY_BAR_STATE.keys
    return { open, keys }
  } catch {
    return DEFAULT_KEY_BAR_STATE
  }
}

function writeKeyBarState(state: KeyBarState) {
  try {
    window.localStorage.setItem(KEY_BAR_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // localStorage disabled / quota exceeded — the bar still works for this
    // session, it just won't survive a reload.
  }
}

export interface UseKeyBarResult {
  open: boolean
  keys: string[]
  /** Flip open/closed — the dock's `···` Specials icon calls this now. */
  toggleOpen: () => void
  /** Replace the whole ordered key set (from the customize picker). */
  setKeys: (keys: string[]) => void
}

/** Route-level hook — `MobileFocus` owns one instance so both the dock's
 *  toggle icon and the `<KeyBar>` render share the same persisted state. */
export function useKeyBar(): UseKeyBarResult {
  const [state, setState] = React.useState<KeyBarState>(() => readKeyBarState())

  // Persist AFTER commit rather than inside the setState updater: React 18
  // StrictMode double-invokes updater functions to surface impure reducers,
  // which would double-write from inside them. An effect keyed on `state`
  // writes exactly once per real change.
  React.useEffect(() => {
    writeKeyBarState(state)
  }, [state])

  const toggleOpen = React.useCallback(() => {
    setState((s) => ({ ...s, open: !s.open }))
  }, [])

  const setKeys = React.useCallback((keys: string[]) => {
    setState((s) => ({ ...s, keys }))
  }, [])

  return { open: state.open, keys: state.keys, toggleOpen, setKeys }
}

// ── key catalog reuse (customize picker) ────────────────────────────────────

/** Only the `kind: 'key'` entries — their `payload` IS a `sendKey`-understood
 *  name, so the picker's toggle id doubles as the bar's stored key string
 *  (no separate id↔payload mapping to keep in sync). This drops the one
 *  `kind: 'paste'` control entry (clipboard paste needs `send`, not
 *  `sendKey`) — out of scope for a KEY bar. */
const KEY_ENTRIES: QuickEntry[] = CONTROL_ENTRIES.filter((e) => e.kind === 'key')

/** payload → the catalog's human label (the picker's own wording) so a chip's
 *  aria-label announces "Send Stop" / "Send Cycle mode (⇧⇥)" rather than the
 *  opaque internal token "Send Ctrl-C" / "Send BackTab" — matters once the
 *  picker lets users add non-default keys. */
const KEY_LABELS: Map<string, string> = new Map(
  KEY_ENTRIES.map((e) => [e.payload, e.label]),
)

/** Arrow glyphs mirror the dock's accessory strip (`ArrowUp`/`Down`/`Left`/
 *  `Right`, size-[18px], strokeWidth 1.75). Enter gets the same corner-arrow
 *  glyph the dock's `EnterButton` uses. Everything else renders as a short
 *  text label. */
const KEY_GLYPHS: Partial<Record<string, LucideIcon>> = {
  Left: ArrowLeft,
  Up: ArrowUp,
  Down: ArrowDown,
  Right: ArrowRight,
  Enter: CornerDownLeft,
}

/** Held-and-repeats: only the 4 arrows (navigating a long option list). */
const REPEATABLE_KEYS = new Set(['Left', 'Up', 'Down', 'Right'])

/** Movement (px) past which a touch is a scroll, not a tap — mirrors the
 *  TAP_SLOP the terminal pane + compose field already use for the same
 *  tap-vs-swipe arbitration, so a horizontal swipe to scroll an overflowing
 *  bar never arms an arrow's hold-repeat. */
const TAP_SLOP_PX = 10

/** Short chip labels for the non-glyph keys — matches the dock's economical
 *  raw-name chips (`Esc`/`Tab`/`Ctrl-C`) with a few extra abbreviations for the
 *  longer catalog entries. Falls back to the raw key name. */
const KEY_SHORT_LABELS: Record<string, string> = {
  'Ctrl-C': '^C',
  'Ctrl-U': '^U',
  'Ctrl-L': '^L',
  BackTab: '⇧⇥',
  EscEsc: 'Esc⎋',
  Newline: '⏎+',
  Backspace: '⌫',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
}

function keyLabel(key: string): string {
  return KEY_SHORT_LABELS[key] ?? key
}

// ── the floating pill ───────────────────────────────────────────────────────

export interface KeyBarProps {
  open: boolean
  /** Ordered `sendKey` names to render as chips. */
  keys: string[]
  /** Persist a new ordered key set (from the customize picker). */
  onKeysChange: (keys: string[]) => void
  /** Send a named key to the pty — the SAME `termRef.current?.sendKey` handle
   *  every other key path in the route uses. */
  onSendKey: (key: string) => void
  /** Whether the customize-keys picker sheet is open. Lifted to the route
   *  (rather than kept as local state) so `useEdgeGestures`'s `enabled` gate
   *  can disable edge-swipe nav while the picker's Vaul sheet is up — the
   *  SAME guard the session-picker sheet gets. */
  pickerOpen: boolean
  onPickerOpenChange: (open: boolean) => void
}

export function KeyBar({
  open,
  keys,
  onKeysChange,
  onSendKey,
  pickerOpen,
  onPickerOpenChange,
}: KeyBarProps) {
  const reduceMotion = useReducedMotion()
  // Respect the accessibility "reduce transparency" preference the same way
  // the shared `glass` utility does, since this pill overrides the utility's
  // background to be a touch MORE transparent (62% vs 72%) — that override
  // must not survive under reduced-transparency, or the surface loses the
  // legibility guarantee `glass` normally provides.
  const reducedTransparency = useMediaQuery('(prefers-reduced-transparency: reduce)')

  return (
    <>
      {/* AnimatePresence handles the collapse-up + fade exit; the enter is a
          spring-down "unfurl" from under the header. `pointer-events-auto` is
          scoped to JUST this fixed pill (it has no width/height beyond its
          content) — the rest of the screen stays the terminal underneath. */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={
              reduceMotion
                ? { opacity: 0 }
                : { opacity: 0, y: -8, scale: 0.96 }
            }
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={
              reduceMotion
                ? { opacity: 0 }
                : { opacity: 0, y: -8, scale: 0.96 }
            }
            transition={reduceMotion ? { duration: 0.15 } : springs.snappy}
            style={{ top: 'calc(env(safe-area-inset-top) + 44px + 20px)' }}
            className="pointer-events-auto fixed left-1/2 z-[60] -translate-x-1/2"
          >
            <div
              role="toolbar"
              aria-label="Key bar"
              className={cn(
                'glass flex max-w-[92vw] items-center gap-1.5 rounded-full',
                // A hairline + inset top-highlight gives the capsule a crisp
                // glass edge in BOTH themes: a light hairline over the near-black
                // dark-theme pill, a dark one over the near-white light-theme
                // pill (a single static border would vanish on one of them),
                // plus a deep soft ambient shadow that reads as elevation.
                'overflow-x-auto border border-black/10 px-2 py-1.5 dark:border-white/10',
                'shadow-[0_1px_0_0_rgba(255,255,255,0.06)_inset,0_12px_28px_-6px_rgba(0,0,0,0.65)]',
              )}
              style={
                reducedTransparency
                  ? undefined
                  : {
                      backgroundColor:
                        'color-mix(in srgb, var(--card) 62%, transparent)',
                    }
              }
            >
              {keys.map((key, i) => (
                <KeyBarButton
                  key={`${key}-${i}`}
                  index={i}
                  reduceMotion={!!reduceMotion}
                  keyName={key}
                  onSend={() => onSendKey(key)}
                />
              ))}
              <span className="h-5 w-px shrink-0 bg-border/50" aria-hidden />
              <EditChip
                index={keys.length}
                reduceMotion={!!reduceMotion}
                onClick={() => onPickerOpenChange(true)}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <KeyBarPicker
        open={pickerOpen}
        onOpenChange={onPickerOpenChange}
        keys={keys}
        onKeysChange={onKeysChange}
      />
    </>
  )
}

/** Per-child stagger delay for the "unfurl" — 22ms apart, skipped entirely
 *  under reduced motion (plain opacity, no choreography). */
function staggerDelay(index: number, reduceMotion: boolean): number {
  // ~34ms/chip so the cascade is perceptible against the parent pill's own
  // unfurl spring (a tighter gap blurs into a single motion).
  return reduceMotion ? 0 : index * 0.034
}

/** One key chip — echoes `dock.tsx`'s `AccessoryChip` but a touch smaller
 *  (h-9 vs h-[38px]). Press = `whileTap` scale (its OWN spring, so it never
 *  inherits the entrance stagger's `delay`) + a brief primary key-flash glow
 *  (a crisp inner fill + a soft outer bloom that bleeds past the chip edge —
 *  there's no visible keyboard to confirm a tap landed).
 *
 *  SEND TIMING (touch-safety): single taps — repeatable or not — fire on
 *  `click`, which the browser suppresses after a scroll/drag, so a horizontal
 *  swipe to scroll an overflowing bar never emits a stray keystroke. The 4
 *  arrows ALSO hold-to-repeat: the repeat is ARMED on pointerdown but only
 *  starts sending after a ~300ms press that hasn't travelled past TAP_SLOP_PX
 *  (a scroll cancels it first); while held, a steady glow replaces the
 *  per-tick flash so it reads as one sustained highlight, not a strobe.
 *  Timers are cleared on every release path and on unmount. */
function KeyBarButton({
  keyName,
  index,
  reduceMotion,
  onSend,
}: {
  keyName: string
  index: number
  reduceMotion: boolean
  onSend: () => void
}) {
  const repeatable = REPEATABLE_KEYS.has(keyName)
  const glow = useAnimationControls()
  const holdTimer = React.useRef<number | null>(null)
  const repeatTimer = React.useRef<number | null>(null)
  const startRef = React.useRef<{ x: number; y: number } | null>(null)
  const scrolledRef = React.useRef(false)
  // True once a genuine hold-repeat has fired, so the trailing synthetic
  // `click` is swallowed (it must not double-send the key).
  const heldRef = React.useRef(false)

  const clearTimers = React.useCallback(() => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    if (repeatTimer.current !== null) {
      window.clearInterval(repeatTimer.current)
      repeatTimer.current = null
    }
  }, [])
  // Belt-and-suspenders: a stray hold-repeat interval must never survive an
  // unmount (route change while a chip is held down).
  React.useEffect(() => clearTimers, [clearTimers])

  const send = React.useCallback(() => {
    onSend()
    if ('vibrate' in navigator) navigator.vibrate(8)
  }, [onSend])

  // A discrete press: send + a one-shot flash (inner fill + outer bloom, both
  // driven by `glow`). Plain opacity, so it stays under reduced motion too.
  const tapFire = React.useCallback(() => {
    send()
    void glow.start({ opacity: [0.55, 0] }, { duration: 0.24, ease: 'easeOut' })
  }, [send, glow])

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault() // never steal xterm's hidden-textarea focus
      if (!repeatable) return
      startRef.current = { x: e.clientX, y: e.clientY }
      scrolledRef.current = false
      heldRef.current = false
      clearTimers()
      // Arm hold-to-repeat but DON'T send yet — a swipe that becomes a scroll
      // (onPointerMove) cancels this before it ever fires.
      holdTimer.current = window.setTimeout(() => {
        if (scrolledRef.current) return
        heldRef.current = true
        send() // first auto-repeat
        // Steady "held" highlight (no per-tick strobe). Use start() rather than
        // set() so it reliably applies on this chip's first-ever glow
        // activation (set() can no-op before the controls' first animation).
        void glow.start({ opacity: 0.34 }, { duration: 0.12 })
        repeatTimer.current = window.setInterval(send, 70)
      }, 300)
    },
    [repeatable, clearTimers, send, glow],
  )

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent) => {
      if (!repeatable || !startRef.current || heldRef.current) return
      const dx = Math.abs(e.clientX - startRef.current.x)
      const dy = Math.abs(e.clientY - startRef.current.y)
      if (dx > TAP_SLOP_PX || dy > TAP_SLOP_PX) {
        // Abort the pending hold-arm. NOTE: single-tap safety on the `click`
        // path relies on the browser suppressing `click` after a real scroll
        // (same as dock.tsx's AccessoryChip/EnterButton) — `scrolledRef` only
        // guards the hold, it does not itself gate the click.
        scrolledRef.current = true
        clearTimers()
      }
    },
    [repeatable, clearTimers],
  )

  const onPointerRelease = React.useCallback(() => {
    if (heldRef.current) {
      void glow.start({ opacity: 0 }, { duration: 0.18, ease: 'easeOut' })
    }
    clearTimers()
  }, [clearTimers, glow])

  const onClick = React.useCallback(
    (e: React.MouseEvent) => {
      if (repeatable) {
        // Keyboard activation (Enter/Space on a focused chip) has no pointer
        // gesture — `detail === 0` — and must still fire exactly once.
        if (e.detail === 0) {
          tapFire()
          return
        }
        // A hold already sent (+ repeated) → swallow the trailing click.
        if (heldRef.current) {
          heldRef.current = false
          return
        }
        // A scroll emits no click, so reaching here is a genuine tap.
        tapFire()
        return
      }
      tapFire()
    },
    [repeatable, tapFire],
  )

  const Glyph = KEY_GLYPHS[keyName]
  const label = KEY_LABELS.get(keyName) ?? keyName

  return (
    <motion.button
      type="button"
      aria-label={`Send ${label}`}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        ...(reduceMotion ? { duration: 0.12 } : springs.snappy),
        delay: staggerDelay(index, reduceMotion),
      }}
      // whileTap carries its OWN spring so press-feedback never inherits the
      // entrance stagger's `delay` (framer falls back to the component's
      // `transition` prop otherwise, lagging later chips ~90ms behind the flash).
      whileTap={{ scale: 0.9, transition: springs.buttonPress }}
      onPointerDown={onPointerDown}
      onMouseDown={(e) => e.preventDefault()}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerRelease}
      onPointerLeave={onPointerRelease}
      onPointerCancel={onPointerRelease}
      onClick={onClick}
      style={{ touchAction: 'manipulation' }}
      className="relative flex h-9 min-w-9 shrink-0 items-center justify-center rounded-xl bg-secondary px-2.5 text-[13px] font-medium text-secondary-foreground active:bg-secondary/70"
    >
      {/* Soft outer bloom — bleeds a few px past the chip edge (not clipped)
          for a real radiating glow; paired with the crisp inner fill below. */}
      <motion.span
        aria-hidden
        initial={{ opacity: 0 }}
        animate={glow}
        className="pointer-events-none absolute -inset-1 rounded-2xl bg-primary/30 blur-md"
      />
      <motion.span
        aria-hidden
        initial={{ opacity: 0 }}
        animate={glow}
        className="pointer-events-none absolute inset-0 rounded-xl bg-primary/50"
      />
      {Glyph ? (
        <Glyph className="relative size-[18px]" strokeWidth={1.75} aria-hidden />
      ) : (
        <span className="relative">{keyLabel(keyName)}</span>
      )}
    </motion.button>
  )
}

/** Trailing edit affordance — opens the customize picker. Same chip shell as
 *  the key buttons, muted (it's not a send action), no hold-to-repeat. */
function EditChip({
  index,
  reduceMotion,
  onClick,
}: {
  index: number
  reduceMotion: boolean
  onClick: () => void
}) {
  return (
    <motion.button
      type="button"
      aria-label="Customize key bar"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        ...(reduceMotion ? { duration: 0.12 } : springs.snappy),
        delay: staggerDelay(index, reduceMotion),
      }}
      whileTap={{ scale: 0.9, transition: springs.buttonPress }}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{ touchAction: 'manipulation' }}
      className="flex h-9 min-w-9 shrink-0 items-center justify-center rounded-xl bg-secondary/50 text-muted-foreground active:bg-secondary/70"
    >
      <SlidersHorizontal className="size-[16px]" strokeWidth={1.75} aria-hidden />
    </motion.button>
  )
}

// ── customize picker (reuses MobileActionSheet + the quick-keys catalog) ────

export interface KeyBarPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  keys: string[]
  onKeysChange: (keys: string[]) => void
}

/** The KeyBar's "customize which keys" sheet — the SAME Vaul shell
 *  (`MobileActionSheet`) the quick-keys/snippets panels use, populated with
 *  the catalog's `key`-kind entries as on/off toggle chips. Toggling appends
 *  to (or removes from) the ordered `keys` list — order is chip order, same
 *  reconcile philosophy as `QuickKeysSheet`'s catalog editor. */
function KeyBarPicker({ open, onOpenChange, keys, onKeysChange }: KeyBarPickerProps) {
  const selectedSet = React.useMemo(() => new Set(keys), [keys])

  const onToggle = React.useCallback(
    (payload: string) => {
      onKeysChange(
        selectedSet.has(payload)
          ? keys.filter((k) => k !== payload)
          : [...keys, payload],
      )
    },
    [keys, selectedSet, onKeysChange],
  )

  return (
    <MobileActionSheet open={open} onOpenChange={onOpenChange} title="Key bar keys">
      <div
        data-vaul-no-drag
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-1"
      >
        <div className="grid grid-cols-2 gap-2">
          {KEY_ENTRIES.map((entry) => (
            <PickerChip
              key={entry.id}
              entry={entry}
              selected={selectedSet.has(entry.payload)}
              onClick={() => onToggle(entry.payload)}
            />
          ))}
        </div>
      </div>
    </MobileActionSheet>
  )
}

function PickerChip({
  entry,
  selected,
  onClick,
}: {
  entry: QuickEntry
  selected: boolean
  onClick: () => void
}) {
  const Icon = entry.icon
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.96 }}
      transition={springs.buttonPress}
      aria-pressed={selected}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if ('vibrate' in navigator) navigator.vibrate(8)
        onClick()
      }}
      className={cn(
        // Left-aligned list item ([icon] [label…] [✓]) so the label gets the
        // full cell width and truncates cleanly at the end, and the check
        // right-aligns — reads more designed than centered + mid-truncated.
        'flex h-12 items-center gap-2 rounded-xl border px-3.5',
        'text-[14px] font-semibold active:bg-secondary',
        selected
          ? 'border-primary/40 bg-primary/15 text-primary'
          : 'border-border bg-card text-foreground',
      )}
    >
      {Icon && <Icon className="size-[18px] shrink-0" aria-hidden />}
      <span className="flex-1 truncate text-left">{entry.label}</span>
      {selected && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
    </motion.button>
  )
}

export default KeyBar
