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
import { useToast } from '@/components/ui/use-toast'
import {
  initialEditState,
  isSheetOpen,
  reduceEdit,
  type EditPhase,
  type EditState,
} from './external-edit-machine'

/** Client-side ceiling on the bridge round-trip. If `pending` doesn't transition
 *  to `ready` within this window the buffer is never coming (SSE suspended on a
 *  backgrounded phone, no dashboard subscriber when the bridge POSTed, or a
 *  bridge/network fault). We DON'T close the sheet — that stranded the user with
 *  nothing to retry into. Instead we fall the skeleton open into a DEGRADED empty
 *  editable textarea (see the `timeout` event) so they can still type + send
 *  straight to the live pty. 8s is snappy enough that a stuck skeleton resolves
 *  to a usable editor quickly, while comfortably clearing a slow-but-healthy
 *  bridge round-trip (~250ms typical, a couple of seconds on a cold phone). */
const PENDING_TIMEOUT_MS = 8_000

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
  /** The bridge correlation id — `null` while closed/pending, populated when
   *  `arrived` fires. Surfaced so the sheet can `key` its EditorBody on the
   *  requestId (NOT on the buffer); a redundant `arrived` SSE for the SAME
   *  requestId (e.g. an SSE reconnect replay) then re-renders with the same key,
   *  no remount, in-progress textarea state survives. Keying on buffer would
   *  cause an identical-buffer re-fire to clobber the user's edits. */
  requestId: string | null
  /** DEGRADED FALLBACK. True when the sheet opened WITHOUT a bridge buffer —
   *  the pending round-trip timed out (SSE suspended, no subscriber when the
   *  bridge POSTed, bridge/network fault). The textarea is empty + editable and
   *  there is NO `requestId`, so `save()` cannot write back through the
   *  external-edit submit. The caller must branch on this: in degraded mode write
   *  the text STRAIGHT to the live pty (Claude is not blocked — the bridge never
   *  took the tty), instead of calling `save()`. False on the normal path. */
  degraded: boolean
  /** Optimistic-open trigger — the caller invokes this on the ✎ Edit tap. It
   *  flips the machine to `pending` (sheet renders skeleton THIS frame) and the
   *  caller is expected to send Ctrl+G to the pty in the same tick (we don't
   *  send Ctrl+G here — the caller owns the pty handle).
   *
   *  Returns `true` if the machine transitioned `closed`→`pending` (so the
   *  caller SHOULD fire Ctrl+G), or `false` if the call was a no-op because we
   *  were already `pending`/`ready` (a rapid double-tap, or a sheet still up).
   *  Use the return to gate the Ctrl+G dispatch — a 2nd bridge round-trip with
   *  an empty buffer can otherwise race the first and clobber an in-progress
   *  textarea. */
  requestOpen: () => boolean
  /** Controlled close — `setOpen(false)` CANCELS the in-flight edit (from
   *  `pending` the requestId is null so the dismiss is local-only; from `ready`
   *  it POSTs `cancelled:true`).
   *
   *  `setOpen(true)` is a NO-OP — opening must go through `requestOpen()`
   *  (which the call sites use, paired with a Ctrl+G to the pty). A `setOpen(true)`
   *  from a future Drawer-style consumer would otherwise flip the machine to
   *  `pending` WITHOUT firing Ctrl+G, leaving the sheet stuck on its skeleton
   *  forever (no bridge round-trip → no `arrived` → no `ready`). */
  setOpen: (open: boolean) => void
  /** Save the edited text back to Claude's buffer (Done). Closes the sheet.
   *  Does NOT submit the prompt — Claude leaves the text at `❯` for the user.
   *  Resolves once the submit POST returns (so callers — e.g. the "Send" button —
   *  can chain an Enter byte via the terminal's `sendKey('Enter')` to auto-submit
   *  the now-edited prompt). The Enter byte is queued in the pty input stream and
   *  is consumed by Claude only AFTER the bridge writes the file + exits + Claude
   *  reads the new buffer — the input stream's sequential nature guarantees the
   *  ordering (write-back lands before the queued Enter). Rejects on POST failure
   *  so the Send caller can skip the Enter + surface a toast. */
  save: (text: string) => Promise<void>
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

  // Client-side pending timeout (skeleton-stuck guard). The buffer arrives ONLY
  // over the bridge SSE; if that never lands — SSE suspended on a backgrounded
  // phone, no dashboard subscriber when the bridge POSTed (the open handler then
  // returns a requestId WITHOUT broadcasting), or a bridge/network fault — the
  // sheet would sit on "Loading your prompt…" until the user gives up. We DON'T
  // close it (that stranded them with nothing to retry into, and a retry hit the
  // same dead path). Instead, fall OPEN into a DEGRADED empty editable textarea
  // so they can still type + send straight to the live pty. A quiet toast
  // explains why the current prompt couldn't be loaded. Effect-cleanup clears the
  // timer on any transition OUT of pending (the on-time `arrived`/close paths
  // cost nothing).
  const { toast } = useToast()
  React.useEffect(() => {
    if (state.phase !== 'pending') return
    const timer = window.setTimeout(() => {
      dispatch({ type: 'timeout' })
      toast({
        message: "Couldn't load your current prompt. Start a fresh one here.",
        tone: 'default',
      })
      // VR marker — a transient attribute on <html> so the visual-regression
      // battery can assert the timeout fired. Cleared after the toast's default
      // dismiss window (2500ms) so it doesn't linger across navigations.
      document.documentElement.setAttribute('data-vr-edit-timeout', 'true')
      window.setTimeout(() => {
        document.documentElement.removeAttribute('data-vr-edit-timeout')
      }, 2500)
    }, PENDING_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [state.phase, toast])

  // Resolve the in-flight edit, then close. A stale/expired requestId → 409,
  // swallowed (the bridge already timed out; the sheet just closes). From
  // `pending` (no buffer yet → no requestId) we just close locally; the bridge
  // will time out on its own.
  //
  // Returns a Promise that resolves once the submit POST returns (or
  // immediately when there's no requestId / no POST to make). The Promise lets
  // the "Send" button (saveAndSubmit) sequence `sendKey('Enter')` AFTER the
  // server acknowledges the write-back — so the queued Enter byte arrives in
  // the pty input stream after the bridge has released the tty + Claude has
  // updated its buffer. A failed POST rejects so the Send caller can skip the
  // Enter dispatch and surface a toast.
  const resolve = React.useCallback(
    (body: { text?: string; cancelled?: boolean }): Promise<void> => {
      const current: EditState = stateRef.current
      const requestId = current.requestId
      dispatch({ type: 'close' })
      if (!requestId) return Promise.resolve()
      return sessionsApi
        .externalEditSubmit(session, { requestId, ...body })
        .then(() => undefined)
        .catch((e) => {
          // 409 (stale) is expected if the bridge already timed out; anything
          // else is logged but never crashes the route (sheet is already closed).
          // We still REJECT here so the Send caller can skip the Enter
          // dispatch + show a toast — the plain `save` path swallows the
          // rejection at the call site (`void edit.save(text)`).
          console.warn('externalEditSubmit failed', e)
          throw e
        })
    },
    [session],
  )

  // The optimistic-open trigger. Flips to `pending` (sheet renders THIS frame
  // with a skeleton) — the CALLER then sends Ctrl+G to the pty in the same tick.
  // Splitting "open the sheet" from "fire the pty signal" keeps this hook free
  // of the pty handle.
  //
  // The return value mirrors the reducer's `request` guard: `true` iff we
  // transitioned `closed`→`pending` (caller SHOULD send Ctrl+G), `false` if the
  // sheet was already up (caller MUST NOT fire a 2nd Ctrl+G — a rapid double-tap
  // would otherwise queue a 2nd bridge round-trip whose empty-buffer arrival
  // could clobber an in-progress textarea).
  const requestOpen = React.useCallback((): boolean => {
    const willTransition = stateRef.current.phase === 'closed'
    dispatch({ type: 'request' })
    return willTransition
  }, [])

  // Controlled close: `setOpen(false)` is the dismiss/cancel path (backdrop,
  // Cancel, swipe-confirm-discard). `setOpen(true)` is a deliberate NO-OP —
  // opening MUST go through `requestOpen()` so the caller can pair the optimistic
  // open with a Ctrl+G to the pty. A `setOpen(true)` from a future Drawer-style
  // `onOpenChange` consumer would otherwise flip to `pending` without a bridge
  // in flight, stranding the sheet on its skeleton forever.
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (next) return // no-op — see JSDoc; open via requestOpen()
      // Dismiss → fire-and-forget cancel POST; we don't care about the promise.
      void resolve({ cancelled: true }).catch(() => undefined)
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
    requestId: state.requestId,
    degraded: state.degraded,
    requestOpen,
    setOpen,
    save,
  }
}
