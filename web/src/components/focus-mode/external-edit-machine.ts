// external-edit-machine — the pure state-machine for "Edit in native editor"
// (feat-mobile-edit-refit, Stage 1).
//
// WHY pure. Stage 1's headline win is OPTIMISTIC OPEN: the tap on ✎ Edit must
// open the sheet IMMEDIATELY (one frame), then we wait for the bridge SSE to
// arrive with Claude's buffer. The state-machine here owns those transitions
// (closed → pending → ready → closed, with a `cancelled` quiet-close path). By
// keeping it a plain reducer with NO React imports, the unit test can drive every
// transition with raw inputs — no DOM, no Framer Motion, no SSE singleton — and
// the React hook (`useExternalEdit`) is a thin shell that wires events in.
//
// PHASES.
//   • 'closed'     — no edit in flight. The default at mount + after submit/cancel.
//   • 'pending'    — the user JUST tapped Edit; we sent Ctrl+G and opened the
//                    sheet optimistically. No buffer yet. Render skeleton.
//                    `aria-busy=true`. Bridge round-trip is in flight.
//   • 'ready'      — the bridge SSE arrived. `buffer` holds Claude's actual `❯`
//                    input. Render the real textarea + auto-focus it.
//
// `requestId` is the bridge correlation id — captured on the SSE event, echoed
// in the submit so a stale sheet cannot resolve a newer edit (server 409s
// mismatches).
//
// NON-GOALS. This module does NO IO and does NOT call setState. The hook
// dispatches events; the machine returns the next state.

export type EditPhase = 'closed' | 'pending' | 'ready'

export interface EditState {
  phase: EditPhase
  /** Claude's current `❯` input — populated only in 'ready'. Empty string in
   *  'closed' or 'pending'. */
  buffer: string
  /** The bridge request id from the SSE event — `null` until 'ready'. The submit
   *  echoes this; a stale id is rejected server-side (409, swallowed). */
  requestId: string | null
}

export const initialEditState: EditState = {
  phase: 'closed',
  buffer: '',
  requestId: null,
}

export type EditEvent =
  /** User tapped the ✎ Edit affordance. We send Ctrl+G AND open the sheet at
   *  the same instant — the sheet shows a skeleton until the bridge SSE arrives.
   *  Idempotent from 'pending'/'ready' (a second tap while a sheet is up is a
   *  no-op; the bridge already has one in flight per session). */
  | { type: 'request' }
  /** The bridge SSE `external-edit` event arrived with Claude's buffer. Moves
   *  'pending' → 'ready' (the common case) or 'closed' → 'ready' (a buffer
   *  arrived without a prior tap — e.g. the bridge fired before the user got to
   *  request; we honor it). From 'ready', this REPLACES the buffer + requestId
   *  (the prior was superseded server-side). */
  | { type: 'arrived'; buffer: string; requestId: string }
  /** The bridge reported a cancelled edit (timeout, user pressed Esc in Claude
   *  before the sheet finished, etc.). Close the sheet politely — no error
   *  toast (the user did not initiate this, or already cancelled). */
  | { type: 'cancelled' }
  /** The user dismissed / hit Cancel / Done. The hook handles the network
   *  submit; the machine just resets to 'closed'. */
  | { type: 'close' }

export function reduceEdit(state: EditState, event: EditEvent): EditState {
  switch (event.type) {
    case 'request':
      // Optimistic open. If we're ALREADY pending or ready, leave state alone —
      // a second tap is a no-op (the bridge enforces one in-flight per session
      // server-side; opening a second sheet would just stack). Coming from
      // 'closed', flip to 'pending' with an empty buffer (skeleton renders).
      if (state.phase === 'closed') {
        return { phase: 'pending', buffer: '', requestId: null }
      }
      return state

    case 'arrived':
      // The bridge delivered the buffer. Always honor it — even from 'closed'
      // (a bridge fired before the user's tap registered, or the focused client
      // changed) — so the sheet opens pre-filled, never stuck on skeleton.
      return {
        phase: 'ready',
        buffer: event.buffer,
        requestId: event.requestId,
      }

    case 'cancelled':
      // Quiet close. From any phase.
      return { phase: 'closed', buffer: '', requestId: null }

    case 'close':
      return { phase: 'closed', buffer: '', requestId: null }

    default: {
      // Exhaustiveness check — TS catches a missed event type at compile time;
      // the runtime fallthrough returns the current state unchanged.
      const _exhaust: never = event
      void _exhaust
      return state
    }
  }
}

/** Convenience: the sheet is "open" (sheet rendered) in pending OR ready — both
 *  show the surface; only the body differs (skeleton vs real textarea). */
export function isSheetOpen(state: EditState): boolean {
  return state.phase === 'pending' || state.phase === 'ready'
}
