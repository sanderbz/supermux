/**
 * A chat code fence you can take with one action.
 * ─────────────────────────────────────────────────────────────────────────────
 * `BubbleCode`'s well, plus the copy affordance: a corner button on a fine
 * pointer, a tap anywhere on the block on a coarse one (phones AND tablets — a
 * tablet renders the `desktop` surface, so touch is read from `(pointer:
 * coarse)`, never from the surface). On success the well's border takes the
 * check's ink and the corner says "Copied"; a denied or insecure clipboard shows
 * nothing, never a false ✓.
 *
 * Its own module, NOT `bubble.tsx`: that file ships in the entry chunk (every
 * surface renders a bubble) and the entry chunk is the strictest size gate in
 * `scripts/size-budget.mjs`. Only the chat's markdown map — a lazy chunk —
 * renders a fence, so only it imports this.
 *
 * What lands on the clipboard is the fence's SOURCE (`fenceCopyText`), handed in
 * as `copyText`: never the rendered text, which wraps on the phone.
 */
import { Check, Copy } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { cn } from '../../../lib/utils'

import { copyText } from '../message-export'
import { BubbleCode } from './bubble'

export function CopyableCode({
  children,
  className,
  copyText: textToCopy,
}: {
  children: ReactNode
  className?: string
  /** Exactly what a copy puts on the clipboard. */
  copyText: string
}) {
  const [copied, setCopied] = useState(false)
  // The corner hint has scrolled out above the viewport while the block is still
  // on screen: a tall fence read from the middle. The hint then also rides the
  // block's bottom-right edge, so "Tap to copy" is never only off screen.
  const [topGone, setTopGone] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const topRef = useRef<HTMLSpanElement>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  useEffect(() => {
    const top = topRef.current
    const block = top?.parentElement
    if (!top || !block || typeof IntersectionObserver === 'undefined') return
    // The sentinel sits at the block's very top, so "block on screen, sentinel
    // not" can only mean the top is cut off ABOVE. Measured against whatever
    // clips it (the transcript's own scroller, under the header), not the
    // window: an IO with the default root intersects through every overflow
    // ancestor.
    const seen = new Map<Element, boolean>()
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target, e.isIntersecting)
      setTopGone(!!seen.get(block) && !seen.get(top))
    })
    io.observe(top)
    io.observe(block)
    return () => io.disconnect()
  }, [textToCopy])

  const doCopy = useCallback(() => {
    void copyText(textToCopy).then((ok) => {
      if (!ok) return // never a false ✓ / buzz on a denied or insecure clipboard
      setCopied(true)
      navigator.vibrate?.(10)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    })
  }, [textToCopy])

  const onTap = useCallback(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) return
    // The tap that ends a text selection inside the block must not copy; a
    // selection that only partly overlaps the block counts as inside.
    const sel = window.getSelection()
    const pre = preRef.current
    if (sel && pre && !sel.isCollapsed && sel.containsNode(pre, true)) return
    doCopy()
  }, [doCopy])

  // Touch-only convenience for pointer users; the button below stays in the a11y
  // tree and the Tab order on touch devices, so it is the keyboard/screen-reader
  // route (the pre itself has no role).
  const pre = (
    <BubbleCode
      ref={preRef}
      onClick={onTap}
      className={cn(
        // The wrapper below owns the block's top margin; `pt-8` seats the corner
        // chrome above line 1. The finger lands → the well answers before the
        // clipboard does; a copy → its edge takes the check's ink for the window.
        'mt-0 pt-8 transition-[border-color] duration-200 [@media(pointer:coarse)]:active:border-hairline',
        copied && 'border-status-active-ink',
        className,
      )}
    >
      {children}
    </BubbleCode>
  )

  const chip = 'items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] leading-none'
  const corner = 'absolute right-1.5 top-1.5'
  // The touch hint's face, shared by the corner and the trailing edge.
  const hint = copied ? (
    <>
      <Check className="sm-code-copied-check size-3 text-status-active-ink" aria-hidden />
      <span className="sm-code-copied-label">Copied</span>
    </>
  ) : (
    'Tap to copy'
  )
  const coarseOnly = 'hidden [@media(pointer:coarse)]:inline-flex'
  return (
    <div data-code-block className="relative mt-[11px]">
      <span ref={topRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-8" />
      {pre}
      {/* The button stays mounted through the copy (focus survives); only its
          content and label swap. Under a coarse pointer the whole block is the tap
          target and the hint below takes the corner, so the button goes visually
          away (sr-only: still announced, still tabbable) and returns on keyboard
          focus, when the hint steps aside (peer). */}
      <button
        type="button"
        aria-label={copied ? 'Copied' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy'}
        onClick={doCopy}
        className={cn(
          'peer',
          chip,
          corner,
          'inline-flex bg-code-bg text-ink-3 transition-colors hover:bg-muted/60 hover:text-ink [@media(pointer:coarse)]:sr-only [@media(pointer:coarse)]:focus-visible:not-sr-only [@media(pointer:coarse)]:focus-visible:absolute [@media(pointer:coarse)]:focus-visible:px-1.5 [@media(pointer:coarse)]:focus-visible:py-1',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {copied ? (
          <>
            <Check className="sm-code-copied-check size-3.5 text-status-active-ink" aria-hidden />
            <span className="sm-code-copied-label">Copied</span>
          </>
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
      <span
        aria-hidden
        className={cn(chip, corner, coarseOnly, 'pointer-events-none text-ink-3 [@media(pointer:coarse)]:peer-focus-visible:hidden')}
      >
        {hint}
      </span>
      {/* The trailing twin: in flow after the pre, pulled up over its bottom-right
          corner, and sticky to the scroller's bottom edge — so while the corner is
          scrolled away it rides the visible bottom of the block, and it can never
          leave the block it belongs to. That edge sits UNDER the floating composer,
          so the offset is the track's measured reserve (`--sm-chat-reserve`,
          conversation.tsx) plus the jump-to-newest disc that sits on the column's
          right edge exactly while the reader is scrolled up (reserve − 16 + its
          44px, + 6px air). Inert: a tap falls through to the pre. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none sticky z-[1] bottom-[calc(var(--sm-chat-reserve,0px)+34px)] -mt-[30px] flex h-[30px] items-end justify-end px-1.5 pb-1.5 transition-opacity duration-150',
          topGone ? 'opacity-100' : 'opacity-0',
        )}
      >
        {/* Code scrolls UNDER this chip, and the well's and the bubble's tints are
            translucent in every skin — so the chip rebuilds the well's own stack on
            an opaque ground (pane paper → bubble tint → well tint): it reads as the
            well, with nothing showing through. */}
        <span className={cn(chip, coarseOnly, 'border-[0.5px] border-hairline-soft bg-paper-raised bg-[linear-gradient(var(--color-code-bg),var(--color-code-bg)),linear-gradient(var(--color-bubble-agent),var(--color-bubble-agent))] text-ink-3')}>
          {hint}
        </span>
      </div>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </div>
  )
}
