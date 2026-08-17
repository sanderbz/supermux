/**
 * The chat data plane's honesty layer (fase A6 T2).
 * ─────────────────────────────────────────────────────────────────────────────
 * The server has computed staleness since A2 — `TailState::{Live, Reconnecting,
 * NoHooks, Stopped}` (`server/src/sessions/chat/tailer.rs:158`), with the
 * contract spelled out at `:153`: *"`Reconnecting` is deliberately not an error:
 * the transcript we already showed stays on screen, but the client must not
 * present it as a complete, current conversation."*
 *
 * Until A6 the client threw that away: `useChatWs` collapsed five socket states
 * into `isLoading`/`isError`, so `reconnecting` and `no_hooks` rendered
 * IDENTICALLY to `live`. The mechanism was built and unplugged. This module is
 * the plug, and it is deliberately pure so `bun test` can hold it to account.
 *
 * ONE VOCABULARY (A6 T2.6). Four words, and no surface may invent a fifth:
 *
 *   live          the tailer is reading the right file and said so recently
 *   reconnecting  the socket or the tailer is between states — what is on
 *                 screen STAYS on screen, it is just not a claim about now
 *   stale         the socket believes it is live, but nothing authoritative has
 *                 arrived inside the ceiling. Same presentation as
 *                 `reconnecting`, different cause, and worth telling apart in
 *                 a bug report
 *   offline       terminal: no chat data plane, or the socket gave up
 *
 * The same four words appear in `brand/copy.ts::CHAT_CONNECTION` and in
 * `BRAND.md` §6f. `connecting` and `no_hooks` are socket-level states that map
 * onto this vocabulary here rather than leaking a fifth and sixth word onto
 * the surface.
 */

import type { ChatConnState, ChatGone } from './chat-socket'

/** What a surface is allowed to say about the data plane. */
export type ChatPresentation = 'live' | 'reconnecting' | 'stale' | 'offline'

/**
 * The staleness ceiling: how long the socket may claim `live` with no
 * authoritative signal before the surface stops repeating the claim.
 *
 * THE NUMBER IS AN A0 MEASUREMENT, NOT A GUESS — a ceiling that trips during a
 * normal long prose turn is a worse bug than no ceiling, because it teaches the
 * user that the honesty mechanism lies. A0 measured the two signal classes:
 *
 *   · hook-borne frames (`state`, permission, tool receipts)  ≪ 1 s
 *   · a text-only transcript entry     p50 31.4 s · max 32.8 s
 *
 * So a perfectly healthy session can be silent for ~33 s while Claude writes
 * prose. The ceiling is set at ~2.7× the measured maximum. `A0_LATENCIES`
 * below is the fixture the unit test drives, so the day someone shortens this
 * the long-quiet-turn case fails loudly instead of shipping.
 */
export const STALENESS_CEILING_MS = 90_000

/** A0's measured signal latencies, in ms — the unit-test fixtures for the
 *  ceiling, kept next to the number they justify (A6 T2.2). */
export const A0_LATENCIES = {
  /** Hook-borne frames — the fast plane. */
  hookMaxMs: 1_000,
  /** Text-only transcript entry, p50. */
  transcriptP50Ms: 31_400,
  /** Text-only transcript entry, the worst A0 saw. This is the number the
   *  ceiling must clear with room, or a normal turn reads as broken. */
  transcriptMaxMs: 32_800,
} as const

/** Debounce for the foreground redial, so a fast alt-tab or a notification
 *  pull-down cannot thrash the dialler. Same value as the terminal socket's
 *  (`use-live-term.ts:200`), because it is the same human gesture. */
export const VISIBILITY_DEBOUNCE_MS = 2_000

/**
 * How long the page may be hidden before a foreground redial is unconditional.
 *
 * Mobile suspends the network without closing sockets, so `readyState` still
 * says OPEN while the server reaped the subscription long ago. Copied from
 * `use-live-term.ts:207`, which has survived in production.
 */
export const RESUME_STALE_MS = 15_000

/**
 * The socket's state plus the age of its last authoritative signal, as the one
 * word the surface says.
 *
 * `lastSignalAtMs === null` means nothing has arrived yet on this socket — that
 * is `connecting`, not staleness, so the ceiling does not apply.
 */
export function chatPresentation(input: {
  state: ChatConnState
  lastSignalAtMs: number | null
  nowMs: number
  ceilingMs?: number
}): ChatPresentation {
  const { state, lastSignalAtMs, nowMs } = input
  const ceiling = input.ceilingMs ?? STALENESS_CEILING_MS
  switch (state) {
    case 'offline':
      return 'offline'
    case 'no_hooks':
      // The pointer cannot self-heal. It is shown, never presented as current.
      return 'stale'
    case 'connecting':
    case 'reconnecting':
      return 'reconnecting'
    case 'live':
      if (lastSignalAtMs === null) return 'live'
      return nowMs - lastSignalAtMs > ceiling ? 'stale' : 'live'
  }
}

/**
 * A FRESH CONVERSATION — seeded, empty, and the server's own reason is that no
 * transcript exists for it yet.
 *
 * The fifth word this module refuses to invent, expressed as a predicate over
 * the four it has. `classify_pointer` (`tailer.rs`) answers a missing pointer
 * FILE with `Reconnecting{reason: NO_TRANSCRIPT_REASON}`, and that branch has
 * no escalation ceiling — so the word never changed, and every new chat session
 * opened on a permanent `Reconnecting…` next to the body's own "No conversation
 * yet." Three claims about one calm fact, on the first screen the surface ever
 * shows.
 *
 * `reconnecting` PROMISES a reconnection. There is nothing to reconnect to, so
 * the surface says nothing at all: the calm empty state is the whole truth. All
 * three conditions are load-bearing —
 *   · `seeded`, or an ordinary boot frame would suppress the chip before we
 *     know anything;
 *   · `noTranscript`, so an ordinary socket drop still says so;
 *   · `entries === 0`, because the same reason WITH a transcript on screen is
 *     had-and-lost, and there the chip is exactly right: a stale conversation
 *     really is being presented as a current one.
 */
export function isFreshConversation(t: {
  seeded: boolean
  noTranscript: boolean
  entryCount: number
}): boolean {
  return t.seeded && t.noTranscript && t.entryCount === 0
}

/** True when the live plane is known-dead, so anything that infers a failure
 *  from the ABSENCE of a frame over this socket is inferring it from a silence
 *  it caused itself (A6 T2.5 — the delivery watchdog). */
export function isPlaneDown(p: ChatPresentation): boolean {
  return p === 'reconnecting' || p === 'offline'
}

/** The chat socket's state, on `connection-store.ts`'s vocabulary, so the
 *  app-wide `<ReconnectBanner>` stops being blind to a dead chat socket
 *  (A6 T2.4). `stale` is NOT reported as degraded: the socket is genuinely
 *  connected, and a global red banner for a quiet session would be the false
 *  alarm this whole task exists to remove. */
export function linkStateFor(
  p: ChatPresentation,
  gone: ChatGone | null = null,
): 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'gone' {
  // A TERMINAL CLOSE IS NOT A DEGRADED LINK. The app-wide aggregate treats an
  // `offline` link as still-reconnecting for its 30 s grace, so a session that
  // was DELETED under an open panel painted "Reconnecting…" with a spinner —
  // a promise nothing can keep, since the 4404 is terminal and the dialler has
  // already stopped. `gone` is reported instead and the aggregate skips it: the
  // link is not unhealthy, it is finished.
  if (gone !== null) return 'gone'
  switch (p) {
    case 'live':
    case 'stale':
      return 'connected'
    case 'reconnecting':
      return 'reconnecting'
    case 'offline':
      return 'offline'
  }
}

/** What a `gone` chat socket says, and how loudly.
 *
 *  `no-session` is a fact about the world ("this session no longer exists") —
 *  calm, final, and not retryable. `chat-unavailable` is not a failure at all:
 *  a codex / remote / team-lead session simply has no chat plane, so it must
 *  not wear outage styling or offer a retry that can only ever fail again. */
export const CHAT_GONE: Record<ChatGone, { label: string; detail: string; alarming: boolean }> = {
  'no-session': {
    label: 'Session deleted',
    detail: 'This session no longer exists.',
    alarming: true,
  },
  'chat-unavailable': {
    label: 'No chat here',
    detail: "Chat isn't available for this session — open the terminal to see it.",
    alarming: false,
  },
}
