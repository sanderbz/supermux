/**
 * The composer, as the approved boards draw it (fase A3 T7).
 * ─────────────────────────────────────────────────────────────────────────────
 * `board-light.png` and `mobile-light.png` both end the same way: a glass pill
 * inset from the pane's bottom edge, `+` on the left, `Message <session>` in
 * secondary ink, the one inverted control on the right. B0 shipped that pill
 * (`ui/composer.tsx`); this is the surface's use of it, and the two things B0
 * deliberately left to the renderer:
 *
 *   1. THE COPY. The placeholder names the session — the display name, because
 *      the composer is a sentence the user reads, not a slug they type.
 *   2. THE HONESTY. A3 cannot send a key yet. The pill is `readOnly`, and the
 *      "why" appears the moment somebody tries to use it — on focus, above the
 *      pill, at ZERO layout cost (absolutely positioned), so the surface at rest
 *      is exactly the board and the surface being used is never silent about
 *      what it can do. A permanent banner would put a line the boards do not
 *      have under every screenshot of the app; a silent read-only field would be
 *      worse. This is the rung between them.
 *
 * The dogfood latency read-out rides ABOVE the note for the same reason: it only
 * ever renders when there are samples, which is a live session, never a board.
 */
import * as React from 'react'

import { cn } from '../../lib/utils'

import { Composer } from './ui'

export interface ComposerShellProps {
  /** The name the placeholder says out loud — display name, then slug. */
  label: string
  surface?: 'desktop' | 'phone'
  /** A3: true. A4 flips it when the input plane lands. */
  readOnly?: boolean
  /** The `hook→UI p50` read-out, when the session has produced samples. */
  stat?: React.ReactNode
  className?: string
}

/**
 * The composer's FRAME — the boards' inset, the 744px alignment with the track,
 * and the stat's parking spot above the pill.
 *
 * Extracted (fase A4 T3) so the live composer (`components/chat/composer.tsx`)
 * sits in exactly the same box as the read-only one instead of re-typing four
 * measurements that were taken off the boards. Behaviour of `ComposerShell`
 * itself is unchanged — it is the frame's first caller.
 */
export function ComposerFrame({
  surface = 'desktop',
  stat,
  className,
  children,
  drop,
  dropActive,
}: {
  surface?: 'desktop' | 'phone'
  stat?: React.ReactNode
  className?: string
  children: React.ReactNode
  /**
   * Drag-drop handlers for the composer's own wrapper (the `group relative`
   * div) — the composer upgrade drops files onto the whole bar. Optional: absent
   * ⇒ no listeners, byte-identical to today.
   */
  drop?: {
    onDragOver: React.DragEventHandler
    onDragLeave: React.DragEventHandler
    onDrop: React.DragEventHandler
  }
  /** A drag is currently over the frame — draw the accent drop ring. */
  dropActive?: boolean
}) {
  const phone = surface === 'phone'
  return (
    <div
      data-testid="chat-composer"
      className={cn(
        // On the phone the composer is now the SINGLE bottom bar (the old dock
        // below it is folded away under chat — mobile polish #4), so it owns the
        // home-indicator inset: the `max(…, 36px)` (floor was 24px) keeps a 36px
        // breathing room on a flat-bottom phone and lifts clear of the indicator
        // on a notched one. The 36px floor lifts the input clear of the iOS
        // keyboard on mode 9 (imperative root resize), where the composer rides
        // flush at bottom:0 and 14px was clipped under the keyboard; at rest the
        // env(safe-area-inset-bottom)=34px<36 so pb=36, a harmless 2px more
        // resting gutter. The inner gate is `min(--kb-safe-bottom, --safe-bottom)`: BOTH are
        // env(safe-area-inset-bottom) at rest, and keyboard-open zeros WHICHEVER
        // signal fires — the JS keyboard detector sets `--kb-safe-bottom=0` on
        // devices where visualViewport SHRINKS, and the globals `:root:has(:focus)`
        // rule sets `--safe-bottom=0` on devices where the contenteditable
        // registers as :focus for :has. Neither alone is robust (the owner's real
        // device shrinks vv but does NOT match :has for the contenteditable, so
        // --safe-bottom stayed 34px there); the MIN of both drops to 0 as long as
        // EITHER path detects the open keyboard — so the ~34px home-indicator band
        // cannot survive as a transparent gap between the composer and the keyboard.
        phone
          ? 'px-[14px] pb-[max(min(var(--kb-safe-bottom,env(safe-area-inset-bottom)),var(--safe-bottom,env(safe-area-inset-bottom))),36px)]'
          : 'px-8 pb-[18px]',
        className,
      )}
    >
      <div
        {...drop}
        className={cn(
          'group relative mx-auto w-full',
          !phone && 'max-w-[744px]',
          // The drop ring: an accent halo over the whole composer while a file
          // drag hovers it. `rounded-[26px]` matches the grown pill's corner.
          dropActive &&
            'rounded-[26px] ring-2 ring-[color-mix(in_oklab,var(--sm-accent)_55%,transparent)]',
        )}
      >
        {stat && (
          <p className="pointer-events-none absolute inset-x-0 -top-[42px] text-center text-[11.5px] tabular-nums text-ink-3">
            {stat}
          </p>
        )}
        {children}
      </div>
    </div>
  )
}

export function ComposerShell({
  label,
  surface = 'desktop',
  readOnly = true,
  stat,
  className,
}: ComposerShellProps) {
  const phone = surface === 'phone'
  return (
    <ComposerFrame surface={surface} stat={stat} className={className}>
      <>
        {readOnly && (
          <p
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-x-0 -top-[22px] text-center',
              'text-[12.6px] tracking-[-0.05px] text-ink-2',
              'opacity-0 transition-opacity duration-200 group-focus-within:opacity-100',
            )}
          >
            Read-only preview — switch to Terminal to type.
          </p>
        )}
        <Composer
          size={phone ? 'mobile' : 'desktop'}
          readOnly={readOnly}
          placeholder={`Message ${label}`}
        />
      </>
    </ComposerFrame>
  )
}

export default ComposerShell
