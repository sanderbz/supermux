// useExternalEdit — the focus-route side of "edit in native editor"
// (feat-edit-in-native-editor).
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
// FLOW.
//   1. Tap the dock's "Edit" field → send Ctrl+G to the pty (the caller wires
//      `sendCtrlG`). We do NOT open the sheet on tap — we wait for the SSE event
//      so the sheet is pre-filled with Claude's ACTUAL buffer.
//   2. The bridge POSTs the buffer to the server, which broadcasts an
//      `external-edit` SSE event `{session, requestId, buffer}`.
//   3. This hook (subscribed via the shared SSE singleton) opens the sheet for
//      the FOCUSED session only, pre-filled with `buffer`, remembering `requestId`.
//   4. Done/Save → POST the edited text; Cancel/dismiss → POST `cancelled:true`.
//      Either way the server resolves the bridge's long-poll and the sheet closes.
//
// One in-flight edit per session is the server's invariant (Claude is blocked
// while editing); a second SSE for the same session just replaces the open sheet's
// requestId + buffer (the prior was superseded server-side).

import * as React from 'react'

import { sessionsApi } from '@/lib/api/sessions'
import { useSse, type SseEventType } from '@/hooks/use-sse'

/** The `external-edit` SSE payload (mirrors the server's `open` broadcast). */
interface ExternalEditEvent {
  session: string
  requestId: string
  /** Claude's current input buffer to seed the editor (may be empty). */
  buffer: string
}

export interface UseExternalEditResult {
  /** True while the native editor sheet should be open. */
  open: boolean
  /** Controlled open-state setter — a dismiss (false) cancels the in-flight edit. */
  setOpen: (open: boolean) => void
  /** The buffer text to seed the textarea with (Claude's current `❯` input). */
  buffer: string
  /** Save the edited text back to Claude's buffer (Done/Save). Closes the sheet.
   *  Does NOT submit the prompt — Claude leaves the text at `❯` for the user. */
  save: (text: string) => void
}

/** Type-guard the loosely-typed SSE payload into an [`ExternalEditEvent`]. */
function isEditEvent(payload: unknown): payload is ExternalEditEvent {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  return (
    typeof p.session === 'string' &&
    typeof p.requestId === 'string' &&
    typeof p.buffer === 'string'
  )
}

/**
 * Drive the native-editor sheet for the focused `session`. Subscribes to the
 * shared SSE channel for `external-edit` events; opens the sheet (pre-filled)
 * only for THIS session. `save`/dismiss resolve the in-flight edit via the API.
 */
export function useExternalEdit(session: string): UseExternalEditResult {
  const [open, setOpenState] = React.useState(false)
  const [buffer, setBuffer] = React.useState('')
  // The request id of the in-flight edit — the submit must echo it so a stale
  // sheet can't resolve a newer edit (the server matches on it; mismatch → 409).
  const requestIdRef = React.useRef<string | null>(null)

  // Stable handlers object via a ref so the SSE subscription never tears down on
  // re-render (the singleton reads handlers through a ref; see use-sse.ts).
  const onEvent = React.useCallback(
    (type: SseEventType, payload: unknown) => {
      if (type !== 'external-edit') return
      if (!isEditEvent(payload)) return
      // Only the FOCUSED client opens the sheet (the SSE fan-out is process-wide).
      if (payload.session !== session) return
      requestIdRef.current = payload.requestId
      setBuffer(payload.buffer)
      setOpenState(true)
    },
    [session],
  )
  // Subscribe to the shared SSE singleton. Cheap (a Set add/remove); the channel
  // itself is already open for the overview/board.
  useSse(React.useMemo(() => ({ onEvent }), [onEvent]))

  // Resolve the in-flight edit, then close. A stale/expired requestId → 409,
  // swallowed (the bridge already timed out; the sheet just closes). Always clears
  // the local request id so a later dismiss can't double-submit.
  const resolve = React.useCallback(
    (body: { text?: string; cancelled?: boolean }) => {
      const requestId = requestIdRef.current
      requestIdRef.current = null
      setOpenState(false)
      if (!requestId) return
      void sessionsApi
        .externalEditSubmit(session, { requestId, ...body })
        .catch((e) => {
          // 409 (stale) is expected if the bridge already timed out; anything else
          // is logged but never crashes the route (the sheet is already closed).
          console.warn('externalEditSubmit failed', e)
        })
    },
    [session],
  )

  // Controlled open setter: closing the sheet (any dismiss path — backdrop tap,
  // drag handle, Cancel) CANCELS the edit so Claude's buffer is left unchanged.
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (next) {
        setOpenState(true)
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

  return { open, setOpen, buffer, save }
}
