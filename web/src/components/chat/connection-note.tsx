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

import type { ChatPresentation } from './connection'

export interface ConnectionNoteProps {
  state: ChatPresentation
  /** Dial again now. Offered on `offline`, where waiting will not help. */
  onRetry?: () => void
}

/**
 * Renders nothing while `live` — the healthy case must cost no pixels and no
 * announcement, or the honest state becomes wallpaper.
 */
export function ConnectionNote({ state, onRetry }: ConnectionNoteProps) {
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
  const copy = CHAT_CONNECTION[state]
  const detail = copy.why + CHAT_CONNECTION_STAYS
  const retryable = state === 'offline' && onRetry
  const className =
    'flex-none rounded-full border-[0.5px] border-hairline-soft bg-fill-soft px-2 py-[3px] text-[11.5px] font-medium tracking-[0.1px] text-ink-2'

  // One live region, `polite`, holding one short sentence. It is the STATE
  // that is announced, not the transcript — G1's streaming announcements are a
  // separate region with a separate politeness (T7.1).
  const body = (
    <span data-state={state} data-vr="chat-connection" className={className}>
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
