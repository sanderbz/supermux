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
import { selectionInChatTrack } from './selection'
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
        if (dead) return
        // Held-selection stand-down (issue #38, same trade `LiveElapsed` makes).
        // Committing a new frame replaces this block's text nodes; WebKit (iOS
        // AND desktop Safari) collapses a Range anchored anywhere in the chat
        // track when that happens, so a selection made to copy a settled message
        // vanished on the very next 1s tick and copy was impossible. While the
        // reader holds a selection in a `[data-chat-track]`, SKIP the setLines —
        // the block keeps its current frame. This is a deferral, not a freeze:
        // the poll keeps running on its 1s interval, so the moment the selection
        // clears the next tick commits the true, current pty capture. When no
        // selection is held (the normal live case) nothing changes — the frame
        // swaps every tick exactly as before.
        if (selectionInChatTrack()) return
        setLines(extractProvisionalTail(cap))
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
  return <ProvisionalTailView lines={lines} seed={name} pin={pin} surface={surface} />
}

/**
 * The block itself, without the poll — what the pty capture LOOKS like.
 *
 * Split out for the same reason `live-layer.tsx` takes this component as a slot:
 * the network is the one thing that cannot be rendered from a fixture, so the
 * `/dev/chat-live` bench (and any future test) hands the view its lines and gets
 * the real object, dashed edge and all, with no `/peek` in sight.
 */
export function ProvisionalTailView({
  lines,
  seed,
  pin,
  surface,
}: {
  lines: readonly string[]
  seed: string
  pin?: MarkPin
  surface?: 'desktop' | 'phone'
}) {
  const name = seed
  return (
    <MessageRow
      surface={surface}
      gutter={<SessionMark seed={name} pin={pin} size={MARK_SIZE.gutter} state="working" label={null} />}
    >
      <Bubble
        surface={surface}
        // 1px, not the bubble's 0.5px hairline: a half-pixel dashed edge at DPR
        // 1 renders as a continuous line, i.e. as a NORMAL bubble — and "this is
        // not confirmed yet" is the whole point of the block. The fill stays the
        // agent bubble's, so the confirmed message that supersedes it lands on
        // the same box (§11.6's opacity-only swap).
        className="border border-dashed border-ink-3/45 text-ink-2 shadow-none"
      >
        <div
          data-testid="chat-provisional-tail"
          className="pb-1.5 text-[12.6px] tracking-[-0.05px] text-ink-3"
        >
          Live terminal · unconfirmed
        </div>
        {/* B0's code metrics, and the ANSI spans are the terminal's colours
            carrying their own inline style — but the capture's own COLUMNS are
            not preserved. A 128-col pty inside a 230px phone bubble hid 74% of
            every line off-screen behind a hairline scrollbar, during the one
            phase where the surface is genuinely live and the reader most wants
            to read it. The dashed edge is what says "unconfirmed"; the fixed
            column grid never was. So it soft-wraps, and a word longer than the
            bubble breaks rather than pushing a scrollbar under the whole block. */}
        <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[12.7px] leading-[1.62] tracking-[-0.1px]">
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
