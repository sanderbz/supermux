// TerminalCaptureIndicator — polish-pass #4.
//
// A small chrome pill in the top-right corner of the terminal pane that fades
// in when xterm has DOM focus and out when focus leaves. Mirrors the
// LiveTerminal connection-pill geometry (glass material, ≥11px label, spring
// motion) so it feels native to the app — NOT an overlay over terminal
// content. Sentence-case copy. No `transition: all`.
//
// WHY NOT "Esc to release". Esc must reach the terminal (vim insert mode, REPL
// readline, slash-menu close — every classic CLI relies on it). The natural
// release is clicking outside the pane (dock / header / session strip), which
// the parent's focusin/focusout listener already drives — no extra key.

import { AnimatePresence, motion } from 'framer-motion'
import { CornerDownLeft } from 'lucide-react'

import { springs } from '@/lib/springs'

export interface TerminalCaptureIndicatorProps {
  /** True while xterm holds DOM focus inside the parent pane. */
  capturing: boolean
}

/** A glass status pill that says "Capturing input" when xterm has focus.
 *  Lives in the terminal pane's top-right corner — pinned to the corner via
 *  absolute positioning, padded off the safe-area so it never sits flush with
 *  the header/border. Pointer-events disabled: it's purely informational. */
export function TerminalCaptureIndicator({
  capturing,
}: TerminalCaptureIndicatorProps) {
  return (
    <AnimatePresence>
      {capturing && (
        <motion.div
          key="cap-pill"
          // Slide in from the top edge, spring physics shared with the rest of
          // the app (no ad-hoc timing). Snappy spring keeps it crisp at
          // ~150-200ms perceived rise; under Reduce Motion the AnimatePresence
          // toggle reduces to a fade (framer respects the user setting).
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={springs.snappy}
          // Pinned chrome — top-right of the terminal pane. `pointer-events:
          // none` so a stray click reaches xterm; the click-outside-to-release
          // gesture is handled by the parent's focusin/focusout listener.
          className="pointer-events-none absolute right-2 top-2 z-10"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="glass flex h-7 items-center gap-1.5 rounded-full border border-border/60 px-2.5 text-[11px] font-semibold tracking-tight text-foreground/85 shadow-sm">
            <CornerDownLeft className="size-3" aria-hidden />
            <span>Capturing input</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default TerminalCaptureIndicator
