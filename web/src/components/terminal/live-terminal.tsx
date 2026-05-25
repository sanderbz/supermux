// LiveTerminal — M13. Thin React wrapper over `useLiveTerm` (TECH_PLAN §4.5).
//
// Renders the xterm container full-bleed. Connection health surfaces TWO ways:
//   • A normal (read-write) terminal registers its WS with the global
//     `useConnection` store via `useTerminalConnectionLink` (§M23a); the
//     app-wide <ReconnectBanner> is then THE connection surface — worst-state
//     aggregated across the SSE stream + every open terminal.
//   • A read-only embed (the M11 quick-peek modal) does NOT register — its WS
//     blips shouldn't drive the global banner — so it keeps the small in-place
//     <ConnectionPill> below as its own scoped indicator.
//
// VISUAL: iOS-native xterm theming (background tracks --terminal-bg), glass
// material status pill, Title-Case labels (never UPPERCASE), ≥44pt retry hit
// target, spring physics from lib/springs.ts. No `transition: all`.

import * as React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, Loader2, WifiOff } from 'lucide-react'

import '@xterm/xterm/css/xterm.css'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useLiveTerm } from '@/hooks/use-live-term'
import type { LiveTermState, UseLiveTermResult } from '@/hooks/use-live-term'
import { useTerminalConnectionLink } from '@/hooks/use-connection-link'
import { useSession } from '@/hooks/use-sessions'
import { TailPreview } from '@/components/session-tile/tail-preview'

export interface LiveTerminalProps {
  /** Session name — maps to the M4 WS route `/ws/sessions/:name`. */
  name: string
  /** Read-only embed (e.g. the M11 quick-peek modal): no keystrokes sent. */
  readOnly?: boolean
  className?: string
  /** xterm base font size in px. Omit for the M13 default (13). The overview
   *  hover-zoom embed passes a larger value so its small pane shows fewer,
   *  legible rows (FitAddon then sizes the geometry to the container). */
  fontSize?: number
  /** Opt in to the peek-prewarm fast-path: on mount, try to adopt an already-
   *  open, already-authed WS + buffered bytes from the prewarm registry so
   *  hover-zoom hydrates instantly. Falls back to the normal connect when no
   *  pre-warm exists (cap full, just-became-visible, etc.). Used by the
   *  overview hover-zoom embed only — the focus terminal + quick-peek modal
   *  keep their existing single-WS lifecycle. */
  prewarmSeed?: boolean
  /** Receive the imperative handle so a parent dock/joystick (M14/M15/M17) can
   *  drive `sendKey` / `copyAll` without re-subscribing. */
  onReady?: (term: UseLiveTermResult) => void
  /** Fires ONCE when xterm has written its first real pty data frame (replay
   *  buffer / live stream). The overview hover-zoom uses this to crossfade the
   *  live terminal IN once it actually has content — keeping the static ANSI
   *  preview visible until then so the tile never flashes blank-black. */
  onFirstFrame?: () => void
  /** Fires ONCE per connection the moment the replay has SETTLED — the snapshot
   *  finished streaming AND the viewport is pinned to the bottom (the instant
   *  the hook's `ready` flips). The overview hover-peek gates its static→live
   *  crossfade on THIS (not `onFirstFrame`) so the live content is coherent when
   *  it fades in — no mid-fill flicker. Pure passthrough to `useLiveTerm`'s
   *  `onSettled`; the focus/quick-peek paths omit it and are unaffected. */
  onSettled?: () => void
  /** Notified whenever the WS lifecycle state changes — used by the overview
   *  hover-zoom embed to disarm the crossfade if the connection drops to a
   *  retry/stopped state without ever delivering a frame. */
  onStateChange?: (state: UseLiveTermResult['state']) => void
  /** Allow imperative `send` / `sendKey` even while `readOnly` is true. The
   *  overview type-on-hover peek sets this so a document-level keydown
   *  listener can pipe quick interjections through the existing M13 wire
   *  while xterm's own DOM stdin stays disabled (the peek user never focuses
   *  the xterm element). Default false preserves the M11 readOnly contract. */
  allowProgrammaticInput?: boolean
  /** The session's already-cached last-screen capture WITH SGR escapes (the
   *  same `SessionView.preview_ansi` the overview cards render via
   *  <TailPreview>). Shown INSTANTLY as a static overlay on open — the user
   *  sees the current screen already-at-the-bottom with NO blank flash and NO
   *  visible replay scroll — then we crossfade to the live xterm once it's
   *  pinned to the bottom (`ready`). When omitted, the focus path falls back to
   *  the shared `useSessions` cache (look-up by `name`); when there's no cached
   *  tail at all (a new/empty session) we skip the overlay and reveal the
   *  xterm directly — nothing to scroll, so it's already instant. */
  previewAnsi?: string[]
  /** ANSI-stripped twin of `previewAnsi` (`SessionView.preview_lines`) — the
   *  plain-text fallback <TailPreview> renders when no SGR-coloured tail is
   *  available. Same fallback-to-`useSessions` behaviour as `previewAnsi`. */
  previewLines?: string[]
  /** Suppress the internal cached-tail overlay. The overview hover-peek
   *  (<TileLiveTerminal>) ALREADY owns a static→live crossfade — its <TailPreview>
   *  sits behind the live layer which fades in on `onFirstFrame`. Rendering the
   *  overlay here too would stack TWO covers. With it suppressed the peek's xterm
   *  reveals as soon as it has content (no inner blank), so the peek keeps ONE
   *  coherent crossfade. The focus routes leave this false (they own no outer
   *  crossfade, so the overlay IS their instant current-screen). */
  suppressCachedTail?: boolean
}

export function LiveTerminal({
  name,
  readOnly = false,
  className,
  fontSize,
  prewarmSeed,
  onReady,
  onFirstFrame,
  onSettled,
  onStateChange,
  allowProgrammaticInput = false,
  previewAnsi,
  previewLines,
  suppressCachedTail = false,
}: LiveTerminalProps) {
  const term = useLiveTerm(name, {
    readOnly,
    fontSize,
    allowProgrammaticInput,
    prewarmSeed,
    onSettled,
  })
  const { containerRef, state, hasFirstFrame, ready, retry, scrolledUp, scrollToBottom } =
    term

  // Resolve the cached tail. Callers that already hold the session row (mobile
  // focus route, the overview peek) pass it explicitly. The desktop focus route
  // renders us deep inside <DesktopSplit> without threading it, so when no props
  // are given we fall back to the shared SSE-merged `useSessions` cache by name
  // — the SAME source the overview tiles render, so the static screen matches.
  // Skip the lookup entirely when the overlay is suppressed (the peek owns its
  // own crossfade) or when explicit preview props were supplied.
  const wantFallback = !suppressCachedTail && !previewAnsi && !previewLines
  const fallback = useSession(wantFallback ? name : '').session
  const tailAnsi = previewAnsi ?? fallback?.preview_ansi
  const tailLines = previewLines ?? fallback?.preview_lines
  // A cached tail exists when either array has content. With no tail there is
  // nothing to scroll, so we reveal the xterm directly (instant) rather than
  // covering it with an empty overlay. Suppressed → never render the overlay.
  const hasTail =
    !suppressCachedTail &&
    ((tailAnsi?.length ?? 0) > 0 || (tailLines?.length ?? 0) > 0)
  // Reveal the xterm when it's pinned to the bottom (`ready`) — OR immediately
  // when there is nothing behind it to cover the replay. "Nothing behind" means:
  // no cached-tail overlay AND no external cover. The suppressed peek path keeps
  // an EXTERNAL cover (the tile's own static <TailPreview> behind <LivePeekLayer>),
  // so we still gate it on `ready` — the static preview shows through during
  // replay, so the peek never shows the scroll either (one coherent crossfade).
  // A focus terminal with no cached tail (empty/new session) reveals instantly.
  const showTerm = ready || (!hasTail && !suppressCachedTail)

  React.useEffect(() => {
    onReady?.(term)
    // Only re-emit when the imperative surface meaningfully changes (state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Notify the parent the first time pty bytes arrive — gates the overview's
  // peek-crossfade (no flicker). Fires exactly once per mount (the underlying
  // ref-then-state in useLiveTerm is idempotent).
  React.useEffect(() => {
    if (hasFirstFrame) onFirstFrame?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFirstFrame])

  React.useEffect(() => {
    onStateChange?.(state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Register this terminal's WebSocket as a connection link in the global store
  // (§M23a). The <ReconnectBanner> aggregates it with the SSE stream + any other
  // open terminals — worst-state wins, so the banner never flickers between two
  // terminals reconnecting out of phase (Codex #16). A read-only embed (e.g. the
  // quick-peek modal) does NOT register: its blips shouldn't drive the global
  // banner. The local <ConnectionPill> below stays as the in-terminal surface.
  useTerminalConnectionLink(readOnly ? '' : name, state, retry)

  return (
    <div
      className={cn(
        // Terminal surface tracks the theme token (iOS-native, §4.5). The pill
        // overlays the top-center, glass material, never UPPERCASE.
        'relative h-full w-full overflow-hidden bg-[var(--terminal-bg)]',
        className,
      )}
      data-state={state}
    >
      <div
        ref={containerRef}
        // Fix 2 — `touch-action: pan-y` overrides the `touch-action: none` that
        // Vaul injects onto its drawer subtree, so vertical drags inside the
        // terminal produce native vertical-pan gestures that xterm's
        // `.xterm-viewport` scrollback consumes (instead of being swallowed by
        // Vaul's drag). Paired with `data-vaul-no-drag` on the focus wrapper.
        //
        // SCROLL-ON-OPEN FIX (cached-tail crossfade). On open we INSTANTLY show
        // the session's already-cached last-screen capture as a static overlay
        // (the cached-tail overlay below) — the user sees the CURRENT screen,
        // already-at-the-bottom, with NO blank flash and NO visible replay
        // scroll. Behind it the live xterm connects, writes the replay, and
        // `scrollToBottom()`s; once it's pinned (`ready`) we crossfade: the
        // overlay fades OUT and the xterm fades IN. We use OPACITY (not
        // display/visibility) so the layout box stays intact — FitAddon still
        // measures real cols/rows while covered. When there's no cached tail
        // (empty/new session) `showTerm` is true from t=0 so the xterm reveals
        // immediately — nothing to scroll. Reduced-motion: no transition.
        className={cn(
          'h-full w-full p-2 [touch-action:pan-y]',
          'transition-opacity duration-150 ease-out motion-reduce:transition-none',
          showTerm ? 'opacity-100' : 'opacity-0',
        )}
        // xterm focuses on click; expose to the keyboard-capture layer (M14).
        tabIndex={readOnly ? -1 : 0}
        aria-label={`Live terminal for ${name}`}
        role="application"
      />

      {/* Cached-tail overlay — the instant "current screen" on open. Renders the
          session's last-screen capture (the same preview the overview cards
          show), terminal-bg, bottom-anchored so it reads as the live screen
          already-at-the-bottom. Mounts whenever a cached tail EXISTS and fades
          OUT once the live xterm is `ready` (a quick ~150ms crossfade,
          reduced-motion-safe) — staying mounted at opacity-0 through the fade so
          the crossfade actually plays (unmounting on `ready` would pop, not
          fade). Mirrors the proven overview peek pattern (static preview behind,
          live surface fades in over it). Pointer-events-none so a click during
          the brief crossfade lands on the xterm beneath it. */}
      {hasTail && (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 bg-[var(--terminal-bg)] p-2',
            'transition-opacity duration-150 ease-out motion-reduce:transition-none',
            ready ? 'opacity-0' : 'opacity-100',
          )}
        >
          <TailPreview
            lines={tailLines ?? []}
            ansiLines={tailAnsi}
            fill
            className="h-full px-0"
          />
        </div>
      )}

      {/* Jump-to-bottom button (SD-2) — appears once the user scrolls up from the
          live bottom and pins back on tap. Focus terminal only (`!readOnly`): the
          read-only embeds are the tiny hover-peek tiles + quick-peek modal, where
          a floating control would just be clutter. Gated on `showTerm` so it never
          peeks out from under the on-open cached-tail cover. */}
      <AnimatePresence>
        {!readOnly && showTerm && scrolledUp && (
          <ScrollToBottomButton onClick={scrollToBottom} />
        )}
      </AnimatePresence>

      {/* In-terminal connection pill — kept ONLY for read-only embeds (e.g. the
          quick-peek modal), which do NOT register with the global connection
          store and so have no other surface. A normal focus terminal registers
          its WS as a link via `useTerminalConnectionLink`, and the global
          <ReconnectBanner> (§M23a) is then THE connection surface — showing a
          second pill here would be redundant (Steve-Jobs bar: one surface). */}
      {readOnly && <ConnectionPill state={state} onRetry={retry} />}
    </div>
  )
}

// ── Jump-to-bottom button (SD-2) ──────────────────────────────────────────────

// A subtle, glass-material circular control that fades+rises in at the bottom
// centre when the user has scrolled up, mirroring the top-centre <ConnectionPill>
// for visual symmetry. Tap pins the viewport back to the live bottom.
function ScrollToBottomButton({ onClick }: { onClick: () => void }) {
  return (
    <motion.div
      key="scroll-bottom"
      initial={{ y: 12, opacity: 0, scale: 0.9 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      exit={{ y: 12, opacity: 0, scale: 0.9 }}
      transition={springs.snappy}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center pb-safe"
    >
      <button
        type="button"
        onClick={onClick}
        aria-label="Scroll to bottom"
        className={cn(
          'glass pointer-events-auto mb-3 grid size-9 place-items-center rounded-full',
          'border border-border/60 text-muted-foreground shadow-sm',
          'transition-colors hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <ChevronDown className="size-4" aria-hidden />
      </button>
    </motion.div>
  )
}

// ── Status pill (placeholder for the M23a reconnect banner) ───────────────────

const PILL: Record<
  Exclude<LiveTermState, 'live'>,
  { label: string; tint: string; spin: boolean; retry: boolean }
> = {
  connecting: {
    label: 'Connecting…',
    tint: 'bg-warning/15 text-foreground',
    spin: true,
    retry: false,
  },
  reconnecting: {
    label: 'Reconnecting…',
    tint: 'bg-warning/15 text-foreground',
    spin: true,
    retry: false,
  },
  offline: {
    label: 'Offline',
    tint: 'bg-destructive/15 text-foreground',
    spin: false,
    retry: true,
  },
  // Terminal: the session's pty is gone. No retry — restarting the session is
  // the only way back, which the focus route surfaces as a primary action.
  stopped: {
    label: 'Session stopped',
    tint: 'bg-muted text-muted-foreground',
    spin: false,
    retry: false,
  },
}

function ConnectionPill({
  state,
  onRetry,
}: {
  state: LiveTermState
  onRetry: () => void
}) {
  // `live` shows nothing — the M23a banner owns the green "Connected" flash.
  const cfg = state === 'live' ? null : PILL[state]

  return (
    <AnimatePresence>
      {cfg && (
        <motion.div
          // Slide down from above the safe-area, in-place state morph (§Termius
          // reconnect-banner spec): one surface, spring physics, no slide-out.
          key="conn-pill"
          initial={{ y: -44, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -44, opacity: 0 }}
          transition={springs.smooth}
          className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-safe"
        >
          <motion.div
            layout
            transition={springs.snappy}
            className={cn(
              'glass pointer-events-auto mt-2 flex h-9 items-center gap-2 rounded-full px-4',
              'border border-border/60 text-[13px] font-semibold shadow-sm',
              cfg.tint,
            )}
          >
            {cfg.spin ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <WifiOff className="size-3.5" aria-hidden />
            )}
            <span>{cfg.label}</span>
            {cfg.retry && (
              <button
                type="button"
                onClick={onRetry}
                // ≥44pt hit target (Termius criterion #5) via negative-margin
                // padding while the pill stays 36pt tall.
                className="-my-2 -mr-2 ml-1 flex h-11 items-center rounded-full px-3 text-[13px] font-semibold text-primary"
              >
                Tap to retry
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default LiveTerminal
