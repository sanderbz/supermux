// P13 provisional tail (REQUIRED fail-branch primitive — master plan §4.2).
// Pty text appears at ~3.2s where the transcript takes ~31s (a0-findings §1);
// this block shows the pty capture, VISUALLY marked unconfirmed, and is
// discarded-and-replaced when the confirming batch lands (the parent gates
// `show`). 1s poll on the FOCUSED session only, only while shown.

import * as React from 'react'

import { sessionsApi } from '@/lib/api'
import { parseAnsiLine } from '@/lib/ansi'

import { extractProvisionalTail } from './provisional'

export function ProvisionalTail({ name, show }: { name: string; show: boolean }) {
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
    <div
      data-testid="chat-provisional-tail"
      className="rounded-lg border border-dashed border-border bg-card px-3 py-2 opacity-80 transition-opacity duration-300"
    >
      <div className="pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Live terminal · unconfirmed
      </div>
      <pre className="overflow-x-auto font-mono text-[12.5px] leading-[18px]">
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
    </div>
  )
}
