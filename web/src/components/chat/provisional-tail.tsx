// P13 provisional tail (REQUIRED fail-branch primitive — master plan §4.2).
// Pty text appears at ~3.2s where the transcript takes ~31s (a0-findings §1);
// this block shows the pty capture, VISUALLY marked unconfirmed, and is
// discarded-and-replaced when the confirming batch lands (the parent gates
// `show`). 1s poll on the FOCUSED session only, only while shown.
//
// Fase A3 T4 reskins it and changes nothing about the poll or the heuristic:
// the block now sits in the transcript's own row grammar (`MessageRow` + the
// 28px session mark) inside an assistant `Bubble` at reduced emphasis, so the
// confirmed bubble that supersedes it lands on the same left edge, at the same
// width, with the same corner — the swap is an opacity change, not a relayout.
// The dashed edge and the caption are what keep it honest: this is what the
// terminal is SAYING, not what the session has committed to.

import * as React from 'react'

import { sessionsApi } from '@/lib/api'
import { parseAnsiLine } from '@/lib/ansi'

import { SessionMark, type MarkPin } from '../../brand/marks'

import { extractProvisionalTail } from './provisional'
import { Bubble, MARK_SIZE, MessageRow } from './ui'

export function ProvisionalTail({
  name,
  show,
  pin,
  surface,
}: {
  name: string
  show: boolean
  pin?: MarkPin
  surface?: 'desktop' | 'phone'
}) {
  const [lines, setLines] = React.useState<string[]>([])

  React.useEffect(() => {
    if (!show) {
      // Teardown of the poll's external state (last pty frame) when the
      // parent hides the block — nothing derived from render lives here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLines([])
      return
    }
    let dead = false
    const poll = async () => {
      try {
        const cap = await sessionsApi.peekAnsi(name, 30)
        if (!dead) setLines(extractProvisionalTail(cap))
      } catch {
        /* transient — keep the previous frame */
      }
    }
    void poll()
    const id = window.setInterval(() => void poll(), 1000)
    return () => {
      dead = true
      window.clearInterval(id)
    }
  }, [name, show])

  if (!show || lines.length === 0) return null
  return (
    <MessageRow
      gutter={<SessionMark seed={name} pin={pin} size={MARK_SIZE.gutter} state="working" label={null} />}
    >
      <Bubble
        surface={surface}
        className="border-dashed border-hairline text-ink-2 shadow-none"
      >
        <div
          data-testid="chat-provisional-tail"
          className="pb-1.5 text-[12.6px] tracking-[-0.05px] text-ink-3"
        >
          Live terminal · unconfirmed
        </div>
        {/* The capture's own columns, at B0's code metrics — the ANSI spans are
            the terminal's colours and carry their own inline style. */}
        <pre className="overflow-x-auto whitespace-pre font-mono text-[12.7px] leading-[1.62] tracking-[-0.1px]">
          {lines.map((l, i) => (
            <div key={i}>
              {parseAnsiLine(l).map((s, j) => (
                <span key={j} style={s.style}>
                  {s.text}
                </span>
              ))}
            </div>
          ))}
        </pre>
      </Bubble>
    </MessageRow>
  )
}
