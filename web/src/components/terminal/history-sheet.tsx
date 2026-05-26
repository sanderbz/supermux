// HistorySheet — read-only "earlier output" viewer for the live terminal.
//
// CONTEXT (the bug it solves)
//
// The always-on WS attach seed used to dump tmux's FULL scrollback into the
// live xterm — primary scrollback + the alt-screen TUI (Claude Code) all
// flattened into one byte stream, no `\x1b[?1049h` framing. Two symptoms:
//   1. the Claude splash banner repeated 2-3× stacked (each past launch sat
//      in primary scrollback);
//   2. typing landed on the WRONG ROW because xterm's cursor sat where the
//      captured cells dropped it, not where Claude's TUI prompt was.
// Refresh fixed it because the next capture coincidentally aligned.
//
// The fix: the live WS seed now paints ONLY the current visible screen
// (the proven-stable visible-only path), and older scrollback is reachable
// solely via this explicit user gesture — a read-only sheet that loads the
// alt-screen-AWARE payload from `GET /api/sessions/{name}/scrollback`
// (server frames it correctly: history in primary, then `\x1b[?1049h`, then
// the alt-screen visible, then a cursor restore). The live terminal stays
// 100% live and untouched; this sheet is a quiet read-only archive — the
// same separation Termius / iTerm "session history" surfaces use.
//
// UX notes (Apple HIG + iOS native, mirrors the focus-mode peek sheets)
//   • mobile → Vaul drag-detent bottom sheet via ResponsiveSheet (swipe-down
//     to dismiss, glass material, safe-area aware).
//   • desktop → shadcn right-side dialog.
//   • Inside: full-bleed read-only xterm with the same theme/fontSize as the
//     parent live terminal, so colours + spacing read identically. No WS.
//   • Loads once on open (idempotent abort on rapid open/close).
//   • Empty / capture-failure → calm "No earlier output yet." note (never a
//     red banner — the live terminal still works).
//
// Reused infra
//   • ResponsiveSheet (the same primitive the scheduler/snippet sheets use).
//   • themeFromCss() — the live terminal's theme reader.
//   • ANSI palette + lineHeight + cursorBlink already encoded in useLiveTerm;
//     this sheet's xterm mirrors them for visual continuity (a user's eye
//     should not notice a colour shift between live + history surfaces).

import * as React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

import '@xterm/xterm/css/xterm.css'

import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { authToken } from '@/env'
import { cn } from '@/lib/utils'

export interface HistorySheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Session name — drives the title + the `/api/sessions/{name}/scrollback`
   *  fetch. Teammate terminals do not surface this sheet (no per-teammate
   *  scrollback endpoint yet), so the type is plain string. */
  name: string
  /** Match the parent live terminal's font size so colours + spacing read
   *  identically between live and history (a user's eye must not jolt). */
  fontSize?: number
}

const DEFAULT_FONT_SIZE = 13

// Read the same CSS-driven xterm theme the live terminal builds — keep the two
// surfaces visually identical, including dark-mode flips. Mirrors useLiveTerm's
// `themeFromCss()` byte-for-byte (no shared helper because the live one is
// tightly coupled to its full palette object; copying the small slice keeps
// this component self-contained and free of import cycles).
function themeFromCss() {
  if (typeof window === 'undefined') {
    return { background: '#0b0b0c', foreground: '#f5f5f7', cursor: '#f5f5f7' }
  }
  const root = document.documentElement
  const css = window.getComputedStyle(root)
  const bg = css.getPropertyValue('--terminal-bg').trim() || '#0b0b0c'
  const fg = css.getPropertyValue('--foreground').trim() || '#f5f5f7'
  return { background: bg, foreground: fg, cursor: fg }
}

export function HistorySheet({
  open,
  onOpenChange,
  name,
  fontSize = DEFAULT_FONT_SIZE,
}: HistorySheetProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)
  const [phase, setPhase] = React.useState<
    'idle' | 'loading' | 'ready' | 'empty' | 'error'
  >('idle')

  // Mount + load on open; tear down on close. Mount-on-open keeps memory
  // footprint near-zero when the sheet is unused, AND guarantees the xterm's
  // container has real dimensions when we open it (a hidden parent reports
  // 0×0 to FitAddon → "Cannot read properties of undefined ('dimensions')").
  React.useEffect(() => {
    if (!open) return
    const container = containerRef.current
    if (!container) return

    let cancelled = false
    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize,
      lineHeight: 1.2,
      theme: themeFromCss(),
      allowTransparency: false,
      cursorBlink: false,
      // 100k scrollback ceiling — generous for any tmux history-limit dump.
      // Cheap in xterm.js's compact line storage; the bytes we write are
      // capped server-side by tmux's pane history-limit (~50k).
      scrollback: 100_000,
      disableStdin: true,
      // The read-only nature means stdin never matters; xterm still creates
      // its helper textarea, so suppress iOS autofill on it the same way the
      // live terminal does (no second toolbar over the keyboard).
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    const helper = container.querySelector<HTMLTextAreaElement>(
      '.xterm-helper-textarea',
    )
    if (helper) {
      helper.setAttribute('autocapitalize', 'off')
      helper.setAttribute('autocorrect', 'off')
      helper.setAttribute('autocomplete', 'off')
      helper.spellcheck = false
    }

    // Fit once after a rAF so the container has real dims, then again after a
    // settle frame so xterm + the sheet's drag-in animation agree on cols/rows.
    const settle = () => {
      try {
        fit.fit()
      } catch {
        /* container still 0×0 (sheet still animating in) — next observer fires it */
      }
    }
    requestAnimationFrame(() => {
      settle()
      requestAnimationFrame(settle)
    })

    // Resize on container size changes (sheet drag-detent, orientation flip).
    const ro = new ResizeObserver(() => settle())
    ro.observe(container)

    // Fetch + write the alt-screen-aware payload once. AbortController so a
    // rapid open/close (sheet dismissed mid-fetch) tears down cleanly.
    const ac = new AbortController()
    setPhase('loading')
    fetch(`/api/sessions/${encodeURIComponent(name)}/scrollback`, {
      headers: { Authorization: `Bearer ${authToken()}` },
      signal: ac.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.arrayBuffer()
      })
      .then((buf) => {
        if (cancelled) return
        const bytes = new Uint8Array(buf)
        if (bytes.byteLength === 0) {
          setPhase('empty')
          return
        }
        term.write(bytes, () => {
          if (cancelled) return
          // Pin to the BOTTOM after the write — the user wants to read older
          // output by scrolling UP from the current frame (the natural
          // direction). Mirrors how a tmux copy-mode session opens.
          term.scrollToBottom()
          settle()
          setPhase('ready')
        })
      })
      .catch(() => {
        if (cancelled) return
        setPhase('error')
      })

    return () => {
      cancelled = true
      ac.abort()
      ro.disconnect()
      try {
        term.dispose()
      } catch {
        /* dispose can throw on an already-torn-down term; safe to swallow */
      }
      termRef.current = null
      fitRef.current = null
      setPhase('idle')
    }
  }, [open, name, fontSize])

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Earlier output"
      description={`Read-only scrollback for ${name}. Live terminal continues underneath.`}
      // Wide enough on desktop to render comfortably ~110 cols at the default
      // font size. The mobile bottom-sheet is full-width by default.
      className="sm:max-w-3xl"
    >
      <div className="relative h-[70vh] sm:h-[78vh] w-full overflow-hidden rounded-lg bg-[var(--terminal-bg)]">
        <div
          ref={containerRef}
          className={cn(
            'h-full w-full p-2',
            // Match the live terminal's gesture-isolation rule: vertical pans
            // inside xterm scroll its viewport, not the sheet's drag-detent.
            '[touch-action:pan-y]',
          )}
          aria-label={`Earlier output for ${name}`}
          role="application"
        />

        {/* Calm status overlay during fetch / empty / error. Pointer-events-none
            so a user can still interact with the xterm beneath once content
            arrives mid-render. */}
        {phase !== 'ready' && (
          <div
            aria-live="polite"
            className={cn(
              'pointer-events-none absolute inset-0 flex items-center justify-center',
              'text-sm text-muted-foreground',
            )}
          >
            {phase === 'loading' && 'Loading earlier output…'}
            {phase === 'empty' && 'No earlier output yet.'}
            {phase === 'error' && 'Could not load earlier output.'}
          </div>
        )}
      </div>
    </ResponsiveSheet>
  )
}
