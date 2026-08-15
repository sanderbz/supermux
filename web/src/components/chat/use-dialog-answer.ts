// Answering a dialog — the STATE (fase A4 T7).
//
// `dialog-answer.ts` decides what may be pressed and what happened; this is the
// small amount of React around it: which card is on screen, which control is
// mid-sequence, what the surface says afterwards, and — the part that matters —
// the LATCH that stops this app offering to press keys into a screen it has
// already misread once.
//
// THE FOUR REFUSAL SOURCES, all of which end in the same place (a disabled card
// + the Attention cause):
//   · the registry has no entry for what the lens sees        → `dialog-unmapped`
//   · the session's boot-banner version is not pinned         → `registry-version-mismatch`
//   · the rows on screen no longer match the entry            → `dialog-unmapped`
//   · a sequence aborted (caret drift, dead peek, survivor)   → `dialog-unmapped`
//
// A2-SEAM: the lens frame arrives on the chat WS `capture` frame instead of the
// `/peek` poll; nothing in this file changes — it reads a `PeekLens`, not a
// transport.

import * as React from 'react'

import type { SessionInput } from '../../lib/session-input'

import type { AttentionCause } from './attention'
import {
  answerDialog,
  answerNotice,
  applyLatch,
  chooseable,
  dialogCardView,
  resolutionLine,
  visibleResolution,
  type AbortLatch,
  type AnswerRequest,
  type DialogCardView,
  type DialogResolution,
} from './dialog-answer'
import { serverNowMs } from './latency'
import type { PeekLens } from './peek-lens'
import { pinFor } from './registry'

export interface UseDialogAnswerOptions {
  /** The shared peek lens (T2) — the AUTHORITY for what is on screen. */
  peek: { lens: PeekLens; refresh: () => Promise<PeekLens | null> }
  /** The write plane. Only `sendKey` is ever used here: this hook types no
   *  text, and it never touches `/send` or `/mode`. */
  input: Pick<SessionInput, 'sendKey'>
  /** Called after a `feedback` answer (Escape on a permission, option 3 on a
   *  plan) — the sentence itself goes through the React composer, because there
   *  is no in-dialog free-text row on 2.1.2xx (a0 §3). */
  onFeedback?: () => void
}

export interface DialogAnswerHandle {
  /** What to draw, or null when nothing is asking. */
  card: DialogCardView | null
  /** The control mid-sequence, so the card can disable itself while a slow pty
   *  catches up (no double-fire). */
  busy: number | 'escape' | null
  choose: (target: number | 'escape') => void
  /** The line the card became, while it is still worth showing. */
  resolved: string | null
  /** The T5 cause this surface should raise, if any. */
  attention: AttentionCause | null
  /**
   * What the raiser knows, for `AttentionContext.detail`.
   *
   * Without it the card says "this app has no verified mapping for that prompt"
   * over an abort whose mapping was perfect and whose actual cause was a second
   * client typing — a sentence that is not merely vague but false. The copy
   * module has always had the slot; this is what fills it.
   */
  attentionDetail: string | null
}

export function useDialogAnswer({
  peek,
  input,
  onFeedback,
}: UseDialogAnswerOptions): DialogAnswerHandle {
  const [busy, setBusy] = React.useState<number | 'escape' | null>(null)
  // The latch: the sighting this app aborted on, and the sentence explaining
  // it. Keyed by SIGHTING, not by session — a new question is a new chance, the
  // same question is not.
  const [blocked, setBlocked] = React.useState<AbortLatch | null>(null)
  const [resolved, setResolved] = React.useState<DialogResolution | null>(null)

  const lens = peek.lens
  const pin = pinFor(lens)
  const base = React.useMemo(() => dialogCardView(lens, pin), [lens, pin])

  // THE LATCH LIVES AS LONG AS ITS DIALOG, AND NOT A MOMENT LONGER. While the
  // sighting that confounded this app is still on screen, its card stays inert:
  // whatever made the reading wrong has not gone anywhere. When the dialog
  // changes or is answered elsewhere, the latch goes with it — otherwise the
  // next identical question (the same command asked twice is routine) would
  // arrive pre-disabled with no way back, which is a refusal that has stopped
  // being about evidence. Reset during render, not in an effect: the disabled
  // card must never be painted for the new question, not even for one frame.
  const lastKey = React.useRef<string | null>(null)
  const key = base?.key ?? null
  if (lastKey.current !== key) {
    lastKey.current = key
    if (blocked && blocked.key !== key) setBlocked(null)
  }
  const { card, attention } = React.useMemo(() => applyLatch(base, blocked), [base, blocked])

  // The peek is the authority, so the refs the async sequence reads are kept
  // fresh here rather than closed over: a card pressed at the moment the poll
  // lands must be answered against the frame the USER saw, and everything after
  // step 1 re-verifies anyway.
  const refresh = peek.refresh
  const sendKey = input.sendKey

  // The double-fire guard is a REF, not the `busy` state it mirrors. State is
  // only as good as the render that follows it, and `choose` is a closure over
  // the render that made it: two taps dispatched before React has re-rendered
  // (a synthetic double-tap, a click racing an Enter on the focused pill) would
  // both read `busy === null` and both start a sequence — two answers to one
  // question, which on a permission dialog means the second Enter lands on
  // whatever Claude asked next. The ref is written before any await, so the
  // second tap loses regardless of when the render arrives.
  const running = React.useRef(false)

  const choose = React.useCallback(
    (target: number | 'escape') => {
      // Rendered-but-inert controls are inert here too (`chooseable`), and a
      // sequence in flight owns the card until it finishes.
      if (running.current || !chooseable(card, busy, target) || !card?.id) return
      const req: AnswerRequest = { entryId: card.id, target, key: card.key }
      running.current = true
      setBusy(target)
      void (async () => {
        const out = await answerDialog({ refresh, sendKey, pin }, req)
        running.current = false
        setBusy(null)
        // ONE outcome line for both halves of the story. On success it names the
        // decision; on a refusal it carries the evidence — and it is set for
        // BOTH because the latch below dies with its sighting, and the sighting
        // is routinely what went away.
        setResolved({
          key: card.key,
          line: out.ok ? resolutionLine(out.effect ?? 'accept', card) : answerNotice(out),
          atMs: serverNowMs(),
        })
        if (out.ok) {
          // The feedback branch is a two-step by design: the dialog is
          // dismissed here, the sentence is typed in the React composer, and
          // the composer's own send carries it (verified round-trip, a0 §3).
          if (out.effect === 'feedback') onFeedback?.()
          return
        }
        // Reverted to unanswered AND latched: the user can still read the
        // question, the terminal is one tap away, and this app will not offer
        // to press anything into this sighting again.
        setBlocked({
          key: card.key,
          detail: answerNotice(out),
          // The card goes inert AND the surface says so out loud: a refusal the
          // user has to infer from a greyed-out button is not a refusal, it is
          // a bug they will report as one.
          attention: out.attention ?? 'dialog-unmapped',
        })
      })()
    },
    [busy, card, onFeedback, pin, refresh, sendKey],
  )

  // The outcome line outlives the card by design (the dialog being gone IS the
  // success signal), but not the next question and not for long.
  const line = visibleResolution(resolved, card, serverNowMs())

  return {
    card,
    busy,
    choose,
    resolved: line,
    attention,
    // Only while the latch is the live one — `applyLatch` has already decided
    // whether it belongs to what is on screen, and a stale sentence under a new
    // question is the same lie in the other direction.
    attentionDetail: card?.disabled && blocked?.key === card.key ? blocked.detail : null,
  }
}
