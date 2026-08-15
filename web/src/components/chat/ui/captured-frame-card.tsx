/**
 * The captured frame — the one warm, non-flat object in the column.
 * ─────────────────────────────────────────────────────────────────────────────
 * When a session shows you something it made or saw (a screenshot, a rendered
 * page, a chart), the transcript stops being text. The approved boards give it:
 *
 *   frame    9px under the bubble text, radius 14, 16:10 (padding-top 62.5%),
 *            shadow `0 12px 30px -18px rgba(40,20,10,.55)` + a 0.5px ring
 *   caption  12.6px secondary ink, 7px under the frame, a 12px file glyph and
 *            the filename — the deep link a later slice hangs on it
 *   width    340 on desktop, 266 on the phone, never wider than its bubble
 *
 * The warm gradient is not decoration for its own sake: every other surface in
 * this design is flat warm neutral, so the ONE object with depth is the thing
 * the session is showing you. It renders whenever there is no `src` — a
 * placeholder that is honest about being one, rather than a grey box.
 */
import type { ReactNode } from 'react'

import { cn } from '../../../lib/utils'

import { FileIcon } from './icons'
import { CAPTURED_FRAME } from './metrics'

/** Fractal-noise overlay, inline so the frame needs no network asset. */
const GRAIN =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3'/></filter><rect width='120' height='120' filter='url(%23n)' opacity='.55'/></svg>\")"

export interface CapturedFrameCardProps {
  /** The filename under the frame. */
  caption: string
  /** A real capture. Without it the warm placeholder renders. */
  src?: string
  alt?: string
  /** Painted over the frame — what the placeholder is standing in for. */
  children?: ReactNode
  /** Frame width in px (340 desktop / 266 phone). Never exceeds its container. */
  width?: number
  onOpen?: () => void
  className?: string
}

export function CapturedFrameCard({
  caption,
  src,
  alt,
  children,
  width = CAPTURED_FRAME.width,
  onOpen,
  className,
}: CapturedFrameCardProps) {
  return (
    <div style={{ width }} className={cn('max-w-full', className)}>
      <div className="relative mt-[9px] overflow-hidden rounded-[14px] shadow-[0_12px_30px_-18px_rgba(40,20,10,0.55),0_0_0_0.5px_rgba(28,20,10,0.10)]">
        <div
          className="relative"
          style={{
            paddingTop: `${CAPTURED_FRAME.aspectPercent}%`,
            background: [
              'radial-gradient(46% 34% at 68% 30%, rgba(255,243,214,.92) 0%, rgba(255,243,214,0) 70%)',
              'radial-gradient(120% 62% at 20% 0%, #ffd3a2 0%, rgba(255,211,162,0) 62%)',
              'linear-gradient(172deg, #f7b47d 0%, #eb9370 26%, #c47279 48%, #8a5f7d 66%, #4c4463 100%)',
            ].join(','),
          }}
        >
          {/* haze */}
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-[20%] h-[24%]"
            style={{
              background:
                'linear-gradient(180deg, rgba(255,222,180,0) 0%, rgba(255,214,168,.55) 70%, rgba(255,214,168,0) 100%)',
            }}
          />
          {/* the two hills */}
          <div
            aria-hidden
            className="absolute bottom-0 left-[-58%] right-[22%] h-[21%] rounded-[50%_50%_0_0/100%_100%_0_0] opacity-90"
            style={{ background: 'linear-gradient(180deg, #8e5f66 0%, #4d3d54 78%)' }}
          />
          <div
            aria-hidden
            className="absolute bottom-0 left-[-30%] right-[-30%] h-[27%] rounded-[50%_50%_0_0/100%_100%_0_0]"
            style={{ background: 'linear-gradient(180deg, #6b5068 0%, #3d3552 72%)' }}
          />
          <div
            aria-hidden
            className="absolute inset-0 opacity-[0.18] mix-blend-overlay"
            style={{ backgroundImage: GRAIN }}
          />
          {children}
          {src && (
            <img
              src={src}
              alt={alt ?? caption}
              className="absolute inset-0 size-full object-cover"
            />
          )}
        </div>
      </div>
      <CaptionRow caption={caption} onOpen={onOpen} />
    </div>
  )
}

function CaptionRow({ caption, onOpen }: { caption: string; onOpen?: () => void }) {
  const content = (
    <>
      <span className="flex flex-none">
        <FileIcon />
      </span>
      <span className="min-w-0 truncate">{caption}</span>
    </>
  )
  const shared = 'mt-[7px] flex items-center gap-1.5 text-[12.6px] tracking-[-0.05px] text-ink-2'
  if (!onOpen) return <div className={shared}>{content}</div>
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(shared, 'transition-colors duration-[120ms] hover:text-ink')}
    >
      {content}
    </button>
  )
}
