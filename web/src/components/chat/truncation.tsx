/**
 * Clipped entries, made recoverable inside chat (fase A6 T4.2).
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS WRONG. The wire caps an entry at 16 KB and flags it `truncated`.
 * The socket auto-fetches the full body for the newest `AUTOFETCH_WINDOW` (12)
 * entries, two at a time, and a failed fetch is **never retried by design**.
 * Everything older than the newest twelve — and everything whose one fetch
 * failed — kept its clip **forever**, and the only affordance was a
 * non-interactive `title=` tooltip reading *"open the Terminal view for the
 * full text"*.
 *
 * That is a message the user cannot read, in a surface that is about to become
 * the default, whose only escape is to leave the surface.
 *
 * WHAT A6 CHANGES, and what it deliberately does not:
 *   · the automatic policy is UNCHANGED — 12 newest, 2 concurrent, one attempt.
 *     It is a policy about server cost (`find_full_entry` streams the
 *     transcript until the uuid matches), and a retry loop against a 404 is
 *     dishonest, not helpful.
 *   · "never retried" stops meaning "unreachable forever". The user gets an
 *     explicit request, with a loading state and a failure state that KEEPS
 *     the condensed text. A clipped message now reads as deliberately
 *     condensed with a way to see the rest, rather than as broken.
 *
 * WHY A CONTEXT AND NOT A PROP. The seam is three values wide (in-flight set,
 * failed set, the request) and its consumer is a leaf that renders inside four
 * different row shapes. Threading it would mean a prop on every intermediate
 * component in the transcript, all of which exist to lay rows out and none of
 * which has an opinion about fetch state. The provider is mounted once, by the
 * panel that owns the socket.
 */

import * as React from 'react'

/** What a clipped row may ask of the data plane. */
export interface TruncationSeam {
  /** Uuids whose full body is being fetched right now. */
  fetching: ReadonlySet<string>
  /** Uuids whose fetch came back an error — retryable. */
  failed: ReadonlySet<string>
  /** Ask for one entry's full body. */
  request: (uuid: string) => void
}

const NONE: ReadonlySet<string> = new Set()

/** The identity a consumer compares against to know there is no data plane
 *  behind it. Referential, not a boolean flag, so it cannot drift out of sync
 *  with the inert seam it belongs to. */
export const NO_REQUEST = (_uuid: string): void => {}

/** No provider ⇒ the marker degrades to exactly the A3 behaviour: it says the
 *  message is clipped and offers nothing. That is what the benches and the
 *  unit tests render, and it must never be a crash. */
const INERT: TruncationSeam = { fetching: NONE, failed: NONE, request: NO_REQUEST }

/** The tooltip the A3 marker carried. Kept as the SECOND line of explanation
 *  now that the first line is a real button. */
export const CLIP_TITLE =
  'This message was clipped for transport. Show the rest, or open the Terminal view.'

export const CLIP_RETRY_TITLE =
  'Fetching the rest of this message failed. The condensed text above is unchanged — try again.'

const TruncationContext = React.createContext<TruncationSeam>(INERT)

export const TruncationProvider = TruncationContext.Provider

export function useTruncation(): TruncationSeam {
  return React.useContext(TruncationContext)
}

/**
 * The three states of a clipped entry, as one word each.
 *
 * Exported and pure so the test can drive the state machine without a DOM —
 * the A0 lesson (`b8daf73`) is that a silent dead signal survives for weeks,
 * and "is the retry reachable" is exactly that kind of signal.
 */
export type ClipState = 'clipped' | 'loading' | 'failed'

export function clipStateFor(uuid: string, seam: TruncationSeam): ClipState {
  if (seam.fetching.has(uuid)) return 'loading'
  if (seam.failed.has(uuid)) return 'failed'
  return 'clipped'
}
