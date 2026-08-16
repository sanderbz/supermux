/**
 * The in-flight delegation pill — supermux's own primitive.
 * ─────────────────────────────────────────────────────────────────────────────
 * `[sender] ●●● asking ●Patch… [recipient]`. It appears in the SENDER's
 * transcript the moment a handoff leaves (master plan §13.2); the receiving
 * transcript gets the arrival divider instead (`<ArrivalDivider>` in
 * facepile.tsx).
 *
 * The approved boards draw it as floating chrome, centred in the column:
 *
 *   row    flex, centred, 15px of air above and below
 *   pill   height 46, padding 0 9, radius full, `--sm-surface`,
 *          0.5px hairline, backdrop blur(24px) saturate(160%)
 *   marks  26px, `working`, each with a page-coloured keyline so it separates
 *          from the translucent pill
 *   label  14.5px/500, tracking −0.1px, in the RECIPIENT's pigment — the one
 *          place the surface names a session that is not the focused one
 *
 * `backdrop-filter` is allowed here: §11.1 restricts it to floating chrome
 * (pills, popovers, the composer) and forbids it on the shell, where it would
 * turn the root into a containing block for every fixed descendant.
 */
import { SessionMark, type MarkPin } from '../../../brand/marks'
import { cn } from '../../../lib/utils'

import { ACCENT_INK_CLASS, accentInkVarsForSeed } from './accent-ink'
import { Dots } from './dots'
import { MARK_SIZE } from './metrics'

export interface DelegationPillProps {
  /** The session doing the asking — its transcript this is. */
  from: string
  fromPin?: MarkPin
  /** The session being asked. Its pigment colours the label. */
  to: string
  toPin?: MarkPin
  /** Display name for the recipient, when it differs from the seed. */
  toName?: string
  /**
   * Keyline colour for the two marks — the surface the pill floats over
   * (`PAPER[theme].paperRaised`). Omit for no keyline.
   */
  ring?: string | null
  size?: number
  className?: string
}

export function DelegationPill({
  from,
  fromPin,
  to,
  toPin,
  toName,
  ring = null,
  size = MARK_SIZE.pill,
  className,
}: DelegationPillProps) {
  return (
    <div className={cn('my-[15px] flex justify-center', className)}>
      <div
        className={cn(
          'inline-flex h-[46px] items-center gap-[11px] rounded-full px-[9px]',
          'border-[0.5px] border-hairline bg-surface backdrop-blur-[24px] backdrop-saturate-[160%]',
        )}
      >
        <SessionMark seed={from} pin={fromPin} size={size} state="working" ring={ring} label={null} />
        <span
          style={accentInkVarsForSeed(to, toPin)}
          className={cn(
            ACCENT_INK_CLASS,
            'inline-flex items-center gap-[9px] pr-1 text-[14.5px] font-medium tracking-[-0.1px]',
          )}
        >
          <Dots />
          <span>asking {toName ?? to}…</span>
        </span>
        <SessionMark seed={to} pin={toPin} size={size} state="working" ring={ring} label={null} />
      </div>
    </div>
  )
}
