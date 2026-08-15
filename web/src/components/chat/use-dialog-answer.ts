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
  chooseable,
  dialogCardView,
  hardDisable,
  resolutionLine,
  visibleResolution,
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
  const [blocked, setBlocked] = React.useState<{ key: string; detail: string } | null>(null)
  const [resolved, setResolved] = React.useState<DialogResolution | null>(null)

  const lens = peek.lens
  const pin = pinFor(lens)
  const base = React.useMemo(() => dialogCardView(lens, pin), [lens, pin])

  const card = React.useMemo(() => {
    if (!base) return null
    return blocked && blocked.key === base.key ? hardDisable(base, blocked.detail) : base
  }, [base, blocked])

  // The peek is the authority, so the refs the async sequence reads are kept
  // fresh here rather than closed over: a card pressed at the moment the poll
  // lands must be answered against the frame the USER saw, and everything after
  // step 1 re-verifies anyway.
  const refresh = peek.refresh
  const sendKey = input.sendKey

  const choose = React.useCallback(
    (target: number | 'escape') => {
      // Rendered-but-inert controls are inert here too (`chooseable`), and a
      // sequence in flight owns the card until it finishes.
      if (!chooseable(card, busy, target) || !card?.id) return
      const req: AnswerRequest = { entryId: card.id, target, key: card.key }
      setBusy(target)
      void (async () => {
        const out = await answerDialog({ refresh, sendKey, pin }, req)
        setBusy(null)
        if (out.ok) {
          setResolved({
            key: card.key,
            line: resolutionLine(out.effect ?? 'accept', card),
            atMs: serverNowMs(),
          })
          // The feedback branch is a two-step by design: the dialog is
          // dismissed here, the sentence is typed in the React composer, and
          // the composer's own send carries it (verified round-trip, a0 §3).
          if (out.effect === 'feedback') onFeedback?.()
          return
        }
        // Reverted to unanswered AND latched: the user can still read the
        // question, the terminal is one tap away, and this app will not offer
        // to press anything into this sighting again.
        setBlocked({ key: card.key, detail: out.detail ?? fallbackDetail(out.committed) })
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
    attention: card?.attention ?? null,
  }
}

/** The honest sentence when the failure carried none. The committed half is the
 *  one that must never be dressed up: a key left this client. */
function fallbackDetail(committed: boolean): string {
  return committed
    ? 'The key was sent and this app could not confirm what it did. Check the terminal.'
    : 'This app could not confirm what the terminal is showing, so nothing was sent.'
}
