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

export function ComposerShell({
  label,
  surface = 'desktop',
  readOnly = true,
  stat,
  className,
}: ComposerShellProps) {
  const phone = surface === 'phone'
  return (
    <div
      data-testid="chat-composer"
      className={cn(phone ? 'px-[14px] pb-[14px]' : 'px-8 pb-[18px]', className)}
    >
      <div className={cn('group relative mx-auto w-full', !phone && 'max-w-[744px]')}>
        {stat && (
          <p className="pointer-events-none absolute inset-x-0 -top-[42px] text-center text-[11.5px] tabular-nums text-ink-3">
            {stat}
          </p>
        )}
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
      </div>
    </div>
  )
}

export default ComposerShell
