import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { parseAnsiLine } from '@/lib/ansi'

const LINE_H = 14 // px — matches leading-[14px]
const PAD_Y = 8 // px — breathing room above the bottom edge
const MAX_RENDER = 22 // expanded ceiling; render this many, clip the rest by height

export interface TailPreviewProps {
  /** Tail lines, ANSI-stripped server-side. Newest last. */
  lines: string[]
  /** Same tail WITH SGR escapes preserved (`SessionView.preview_ansi`). When
   *  present each line renders with its real terminal colours; when absent the
   *  plain `lines` render in the default tail tint. */
  ansiLines?: string[]
  /** Visible line count: 6 idle → 14 hover → 20 expanded. Ignored when
   *  `fill`. */
  visibleLines?: number
  /** Fill the parent height instead of sizing to `visibleLines` (quick-peek). */
  fill?: boolean
  className?: string
}

/** Stable per-line keys (content + occurrence) so that when the tail scrolls —
 *  oldest line drops, new line appended — surviving lines keep their identity
 *  and slide up via `layout`, instead of remounting (no flicker). The key uses
 *  the (plain) text so an ANSI re-colour of the same line doesn't remount it. */
function keyedTail(
  lines: string[],
  ansiLines: string[] | undefined,
): { key: string; text: string; ansi: string | null }[] {
  const seen: Record<string, number> = {}
  // Align the ANSI tail to the plain tail by trailing index — both are the
  // freshest N lines of the SAME capture, so position i ↔ position i.
  const ansiTail = ansiLines?.slice(-MAX_RENDER)
  const plain = lines.slice(-MAX_RENDER)
  const offset = ansiTail ? ansiTail.length - plain.length : 0
  return plain.map((text, i) => {
    const n = (seen[text] = (seen[text] ?? 0) + 1)
    const ansi = ansiTail ? (ansiTail[i + offset] ?? null) : null
    return { key: `${text} ${n}`, text, ansi }
  })
}

/** Render one tail row: ANSI-coloured spans when an escape-bearing line is
 *  available, otherwise the plain text. A space keeps an empty line's height. */
function TailLine({ text, ansi }: { text: string; ansi: string | null }) {
  if (ansi && ansi.includes('\x1b')) {
    const segments = parseAnsiLine(ansi)
    return (
      <>
        {segments.map((seg, i) => (
          <span key={i} style={seg.style}>
            {seg.text || ' '}
          </span>
        ))}
      </>
    )
  }
  return <>{text || ' '}</>
}

/** The live tail of a session's pty. Pre-formatted mono block, last N
 *  lines anchored to the bottom, top-fade mask. New lines slide up via `layout`
 *  (instant under Reduce Motion). The container height springs 6→14→20 so the
 *  peek expands within one frame without a scroll jump. Renders the agent's real
 *  ANSI terminal colours when `ansiLines` is supplied. */
export function TailPreview({
  lines,
  ansiLines,
  visibleLines = 6,
  fill = false,
  className,
}: TailPreviewProps) {
  const reduce = useReducedMotion()
  const tail = React.useMemo(
    () => keyedTail(lines, ansiLines),
    [lines, ansiLines],
  )

  return (
    <motion.div
      aria-hidden
      className={cn('relative overflow-hidden px-3', fill && 'h-full', className)}
      animate={fill ? undefined : { height: visibleLines * LINE_H + PAD_Y }}
      transition={reduce ? { duration: 0 } : springs.cardExpand}
      style={{
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 24px)',
        maskImage: 'linear-gradient(to bottom, transparent 0, black 24px)',
      }}
    >
      <div className="absolute inset-x-3 bottom-2 flex flex-col justify-end">
        {tail.map(({ key, text, ansi }) => (
          <motion.pre
            key={key}
            layout={reduce ? false : 'position'}
            transition={springs.smooth}
            className="m-0 truncate whitespace-pre font-mono text-[10.5px] leading-[14px] text-zinc-700 dark:text-zinc-300"
          >
            <TailLine text={text} ansi={ansi} />
          </motion.pre>
        ))}
      </div>
    </motion.div>
  )
}
