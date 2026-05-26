// useExternalEdit — the focus-route side of "edit in native editor"
// (feat-edit-in-native-editor; Stage 1 mobile-edit refit: OPTIMISTIC OPEN).
//
// WHY. Typing a long/multi-line prompt one char at a time into xterm (especially
// on a phone) is painful. Claude Code has a built-in Ctrl+G action
// (`chat:externalEditor`) that writes its CURRENT input buffer to a temp file,
// spawns $EDITOR, blocks until it exits, then reads the file back as the new
// buffer. supermux points $EDITOR at a bridge that relays the buffer to THIS
// browser sheet and writes the edited text back. So this is an EDIT affordance,
// not compose-and-send: the edited text lands back at Claude's `❯` prompt and the
// user submits with Enter as usual (we never auto-submit).
//
// FLOW — Stage 1 OPTIMISTIC OPEN (mobile-edit refit):
//   1. Tap the dock's ✎ Edit pill → caller calls `requestOpen()`, which:
//        (a) IMMEDIATELY moves the machine to `pending` (sheet renders THIS
//            frame with a skeleton — `aria-busy=true`), and
//        (b) signals the caller's `onRequest` (the route uses it to send Ctrl+G
//            to the pty). The Ctrl+G round-trip happens in PARALLEL with the
//            sheet animating in — the user sees the sheet at frame 1.
//   2. The bridge POSTs the buffer to the server, which broadcasts an
//      `external-edit` SSE event `{session, requestId, buffer}`.
//   3. This hook (subscribed via the shared SSE singleton) flips to `ready`,
//      seeds the buffer, remembers `requestId`. The sheet swaps its skeleton for
//      the real textarea (a 120ms crossfade) and programmatic focus pops the
//      iOS keyboard.
//   4. Done/Save → POST the edited text; Cancel/dismiss → POST `cancelled:true`.
//      A `cancelled` SSE (bridge timeout, etc.) closes the sheet politely.
//
// One in-flight edit per session is the server's invariant (Claude is blocked
// while editing); a second SSE for the same session just replaces the open sheet's
// requestId + buffer (the prior was superseded server-side).

import * as React from 'react'

import { sessionsApi } from '@/lib/api/sessions'
import { useSse, type SseEventType } from '@/hooks/use-sse'
import {
  initialEditState,
  isSheetOpen,
  reduceEdit,
  type EditPhase,
  type EditState,
} from './external-edit-machine'

/** The `external-edit` SSE payload (mirrors the server's `open` broadcast).
 *  An optional `cancelled` field lets the bridge report a timed-out edit. */
interface ExternalEditEvent {
  session: string
  requestId: string
  /** Claude's current input buffer to seed the editor (may be empty). */
  buffer?: string
  /** Bridge reported a cancelled edit (timeout, user Esc'd in Claude, etc.). */
  cancelled?: boolean
}

export interface UseExternalEditResult {
  /** True while the editor sheet should be rendered (pending OR ready phase). */
  open: boolean
  /** Current machine phase — the sheet uses this to render skeleton vs real
   *  textarea (pending=skeleton, ready=textarea). */
  phase: EditPhase
  /** The buffer text to seed the textarea with (Claude's current `❯` input).
   *  Empty while pending (skeleton up); populated when ready. */
  buffer: string
  /** Optimistic-open trigger — the caller invokes this on the ✎ Edit tap. It
   *  flips the machine to `pending` (sheet renders skeleton THIS frame) and the
   *  caller is expected to send Ctrl+G to the pty in the same tick (we don't
   *  send Ctrl+G here — the caller owns the pty handle). */
  requestOpen: () => void
  /** Controlled close — a dismiss (false) CANCELS the in-flight edit. From
   *  `pending` (buffer never arrived) we still call the submit endpoint with
   *  `cancelled:true` — but the requestId is null then, so we just swallow. */
  setOpen: (open: boolean) => void
  /** Save the edited text back to Claude's buffer (Done). Closes the sheet.
   *  Does NOT submit the prompt — Claude leaves the text at `❯` for the user. */
  save: (text: string) => void
}

/** Type-guard the loosely-typed SSE payload. Either `buffer` or `cancelled` must
 *  be present — the bridge sends one or the other. */
function isEditEvent(payload: unknown): payload is ExternalEditEvent {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  if (typeof p.session !== 'string' || typeof p.requestId !== 'string') return false
  if (typeof p.buffer === 'string') return true
  if (p.cancelled === true) return true
  return false
}

/**
 * Drive the native-editor sheet for the focused `session`. Subscribes to the
 * shared SSE channel for `external-edit` events; opens the sheet OPTIMISTICALLY
 * on `requestOpen()` (skeleton), then seeds the textarea when the bridge SSE
 * arrives. `save`/dismiss resolve the in-flight edit via the API.
 */
export function useExternalEdit(session: string): UseExternalEditResult {
  const [state, dispatch] = React.useReducer(reduceEdit, initialEditState)
  // Keep the latest dispatch + state available to long-lived callbacks
  // (the SSE subscription) without re-subscribing.
  const stateRef = React.useRef(state)
  React.useEffect(() => {
    stateRef.current = state
  }, [state])

  // Stable handler via a ref so the SSE subscription never tears down on
  // re-render (the singleton reads handlers through a ref; see use-sse.ts).
  const onEvent = React.useCallback(
    (type: SseEventType, payload: unknown) => {
      if (type !== 'external-edit') return
      if (!isEditEvent(payload)) return
      // Only the FOCUSED client opens the sheet (SSE fan-out is process-wide).
      if (payload.session !== session) return
      if (payload.cancelled) {
        dispatch({ type: 'cancelled' })
        return
      }
      if (typeof payload.buffer === 'string') {
        dispatch({
          type: 'arrived',
          buffer: payload.buffer,
          requestId: payload.requestId,
        })
      }
    },
    [session],
  )
  // Subscribe to the shared SSE singleton. Cheap (a Set add/remove); the channel
  // itself is already open for the overview/board.
  useSse(React.useMemo(() => ({ onEvent }), [onEvent]))

  // Resolve the in-flight edit, then close. A stale/expired requestId → 409,
  // swallowed (the bridge already timed out; the sheet just closes). From
  // `pending` (no buffer yet → no requestId) we just close locally; the bridge
  // will time out on its own.
  const resolve = React.useCallback(
    (body: { text?: string; cancelled?: boolean }) => {
      const current: EditState = stateRef.current
      const requestId = current.requestId
      dispatch({ type: 'close' })
      if (!requestId) return
      void sessionsApi
        .externalEditSubmit(session, { requestId, ...body })
        .catch((e) => {
          // 409 (stale) is expected if the bridge already timed out; anything
          // else is logged but never crashes the route (sheet is already closed).
          console.warn('externalEditSubmit failed', e)
        })
    },
    [session],
  )

  // The optimistic-open trigger. Flips to `pending` (sheet renders THIS frame
  // with a skeleton) — the CALLER then sends Ctrl+G to the pty in the same tick.
  // Splitting "open the sheet" from "fire the pty signal" keeps this hook free
  // of the pty handle.
  const requestOpen = React.useCallback(() => {
    dispatch({ type: 'request' })
  }, [])

  // Controlled close: any dismiss (backdrop, Cancel, swipe-confirm-discard)
  // CANCELS the edit so Claude's buffer is left unchanged.
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (next) {
        dispatch({ type: 'request' })
        return
      }
      resolve({ cancelled: true })
    },
    [resolve],
  )

  const save = React.useCallback(
    (text: string) => resolve({ text }),
    [resolve],
  )

  return {
    open: isSheetOpen(state),
    phase: state.phase,
    buffer: state.buffer,
    requestOpen,
    setOpen,
    save,
  }
}
