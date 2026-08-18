/**
 * The chat data plane, said out loud (fase A6 T2.1).
 *
 * Before A6 this surface had no way to be anything but confident: the socket
 * knew it was `reconnecting`, the tailer knew it had `no_hooks`, and both
 * rendered pixel-identically to `live`. The server's own contract
 * (`tailer.rs:153`) says the transcript STAYS ON SCREEN through all of it —
 * which is exactly why the chrome has to say so, or the user reads a stale
 * transcript as a current one.
 *
 * Deliberately a header chip and not a banner: a banner over the transcript
 * would be a bigger claim than the situation warrants (nothing is broken; the
 * conversation is simply not being updated right now), and it would push the
 * transcript down — layout shift on a surface whose whole value is that the
 * fixed header slot never moves.
 */

import * as React from 'react'

import { CHAT_CONNECTION, CHAT_CONNECTION_STAYS } from '../../brand/copy'
import { claimConnectionVoice } from '../../lib/live-region-owner'
import { cn } from '../../lib/utils'

import type { ChatGone } from './chat-socket'
import { CHAT_GONE, type ChatPresentation } from './connection'

export interface ConnectionNoteProps {
  state: ChatPresentation
  /** Dial again now. Offered on `offline`, where waiting will not help. */
  onRetry?: () => void
  /**
   * The server's own reason for a TERMINAL close, when it named one.
   *
   * It outranks `state`, because it is the more specific reader of the same
   * sighting: `offline` collapses "this session no longer exists" and "chat
   * isn't available for this session" onto one word and offers a retry for
   * both. Neither can be retried, and only one of them is an outage.
   */
  gone?: ChatGone | null
}

/**
 * Renders nothing while `live` — the healthy case must cost no pixels and no
 * announcement, or the honest state becomes wallpaper.
 */
export function ConnectionNote({ state, onRetry, gone = null }: ConnectionNoteProps) {
  // OWNERSHIP (fase B6 — live-region ownership). While this chip is actually
  // saying something, the global `ReconnectBanner` must not say the same thing
  // in a second polite region — before this claim a dropped socket was
  // announced twice, once per region, with no relationship between them. The
  // claim tracks `state !== 'live'` and not merely "a chat surface is mounted":
  // a healthy chat plane renders nothing here, and in that case the global
  // banner is the correct — and only — voice for a backend outage.
  const speaking = state !== 'live'
  React.useEffect(() => (speaking ? claimConnectionVoice() : undefined), [speaking])

  if (state === 'live') return null
  const terminal = gone === null ? null : CHAT_GONE[gone]
  const copy = terminal ?? CHAT_CONNECTION[state]
  // The "what is on screen stays" half is a promise about a link that may yet
  // come back. A terminal close makes no such promise, so it does not borrow
  // that sentence.
  const detail = terminal ? terminal.detail : CHAT_CONNECTION[state].why + CHAT_CONNECTION_STAYS
  // Nothing terminal is retryable: the server has answered, and a retry button
  // on "this session no longer exists" is an invitation to keep tapping.
  const retryable = terminal === null && state === 'offline' && onRetry
  // A DEAD STATE MUST NOT READ AS METADATA (showcase honesty wave).
  //
  // Every other thing this chip says is a link that may yet come back —
  // reconnecting, stale, an outage under a grace window — so the neutral grey
  // wash is right for them. A TERMINAL close that `CHAT_GONE` marks `alarming`
  // is a different sentence: "this session no longer exists" is final, and a
  // soft grey pill indistinguishable from "reconnecting…" hid exactly that (the
  // `alarming` flag was authored for this and then read by nothing). It borrows
  // the composer's own blocked-strip palette — the brand's calm `status-error`
  // orange, never alarmist red — so the one chip that means "gone for good"
  // looks unmistakably not-healthy. `chat-unavailable` is `alarming:false` and
  // stays calm: a session with no chat plane is not a fault.
  const alarming = terminal?.alarming ?? false
  const className = cn(
    'flex-none rounded-full border-[0.5px] px-2 py-[3px] text-[11.5px] font-medium tracking-[0.1px]',
    alarming
      ? 'border-status-error/30 bg-status-error/10 text-status-error-ink'
      : 'border-hairline-soft bg-fill-soft text-ink-2',
  )

  // One live region, `polite`, holding one short sentence. It is the STATE
  // that is announced, not the transcript — G1's streaming announcements are a
  // separate region with a separate politeness (T7.1).
  const body = (
    <span
      data-state={state}
      data-gone={gone ?? undefined}
      data-vr="chat-connection"
      className={className}
    >
      {copy.label}
    </span>
  )

  return (
    <span role="status" aria-live="polite" aria-label={detail}>
      {retryable ? (
        // `data-state` rides BOTH branches. It is how the VR rig, the
        // `/dev/chat-live?conn=` bench and the T3 reconnect specs read the
        // state, and `offline` — the only branch that renders a button — is the
        // one state where losing it hurts most: an unlabelled chip is
        // indistinguishable from the healthy case, which renders nothing at all.
        <button
          type="button"
          onClick={onRetry}
          className={className}
          data-state={state}
          data-gone={gone ?? undefined}
          data-vr="chat-connection"
        >
          {copy.label}
        </button>
      ) : (
        body
      )}
    </span>
  )
}
