// The ONE `/peek` poller for the chat surface (fase A4 T2).
//
// The draft guard (T3), the dialog registry (T6/T7), the mode-chip gate (T7) and
// the Attention card's mini-view (T5) all read the same capture through the same
// pure `readLens`. Four pollers would cost four requests per second AND let two
// consumers disagree about whether a dialog is up — the disagreement that turns
// a keystroke into a wrong answer (master plan §4.3).
//
// A1's `provisional-tail.tsx` keeps its own 1s poll: it is a frozen module and
// folding it in here is a tempting refactor that the A4 plan forbids. Those two
// are the only `peekAnsi` call sites in the app, and that is checkable.
//
// A2-SEAM: cadence becomes the chat WS `capture` frame; `readLens` is unchanged,
// and so is every consumer — only the thing that fills `capture` moves.

import * as React from 'react'

import { sessionsApi } from '@/lib/api'

import {
  EMPTY_LENS,
  peekCadenceMs,
  readLens,
  type DialogContinuity,
  type PeekLens,
} from './peek-lens'

/** The window every consumer reads. 60 lines covers a permission dialog with its
 *  file/diff body and still leaves the composer in frame; the boot banner is NOT
 *  in it (see `BANNER_LINES`). */
const PEEK_LINES = 60
/** The banner scrolls off almost immediately, so it is read once, deep, per
 *  session — and never from the CLI's own `--version` flag, which reports the
 *  DISK binary: a running session keeps the binary it booted with (a0: 2.1.227
 *  running while the disk had 2.1.231). This is the registry's version pin. */
const BANNER_LINES = 10_000
/** Per-session boot version, resolved once. `null` = looked, found nothing (a
 *  session whose banner had already scrolled past a 10k window); `undefined` =
 *  not looked yet. */
const bannerCache = new Map<string, string | null>()

/** Drop a cached pin — the session was relaunched, so its boot binary may have
 *  changed under the same name (the CLI auto-updates; A0 watched it happen
 *  mid-probe). Called by the restart path, never by a poll. */
export function forgetBannerVersion(name?: string): void {
  if (name === undefined) bannerCache.clear()
  else bannerCache.delete(name)
}

export interface PeekLensHandle {
  /** The last reading. `EMPTY_LENS` until the first capture lands. */
  lens: PeekLens
  /** The last raw capture, ANSI intact — what the Attention card's mini-view
   *  renders through `lib/ansi` (T5). Empty string before the first poll. */
  capture: string
  /** Peek NOW and return the fresh reading. `null` means the peek FAILED (not
   *  running, request error) — deliberately not `EMPTY_LENS`, because "I looked
   *  and the screen is clear" and "I could not look" must never collapse into
   *  one value: T3 sends anyway on a failure and lets the watchdog be honest,
   *  T7 aborts.
   *
   *  `continuing` is the answer sequencer's continuity anchor (T7). It affects
   *  only the reading handed BACK; the frame this hook publishes to every other
   *  consumer stays strict. */
  refresh: (continuing?: DialogContinuity | null) => Promise<PeekLens | null>
}

/** The last capture, WITH the session it came from. Carrying the name is what
 *  stops session B from rendering a frame of session A for one tick after a
 *  focus switch — the frame is dropped by identity, never by a reset effect. */
interface Frame {
  name: string
  capture: string
  lens: PeekLens
}

export function usePeekLens(
  name: string,
  {
    enabled = true,
    live = false,
    running = true,
  }: { enabled?: boolean; live?: boolean; running?: boolean } = {},
): PeekLensHandle {
  // THE RESTART PATH the cache's doc-comment promised and nothing called (A4
  // review). `bannerCache` is keyed by session NAME, and a session relaunched
  // under the same name onto an auto-updated CLI would otherwise be certified
  // by the old binary's banner — a pin that fails in the unsafe direction,
  // because it ENABLES options rather than degrading them. A session that has
  // stopped is the moment to forget: whatever boots next under this name reads
  // its own banner.
  React.useEffect(() => {
    if (!running) forgetBannerVersion(name)
  }, [name, running])

  const [frame, setFrame] = React.useState<Frame>(() => ({
    name,
    capture: '',
    lens: EMPTY_LENS,
  }))
  const current = enabled && frame.name === name
  const capture = current ? frame.capture : ''
  const lens = current ? frame.lens : EMPTY_LENS

  // The banner pin lives in the module cache, not in state: it is resolved once
  // per session and every consumer of that session wants the same answer. The
  // reducer exists only to re-render the mount that resolved it.
  const [, bannerResolved] = React.useReducer((n: number) => n + 1, 0)
  const banner = bannerCache.get(name) ?? null

  // The poll reads these instead of re-subscribing when they change: the
  // cadence must be able to speed up mid-flight without restarting the loop.
  const liveRef = React.useRef(live)
  const dialogRef = React.useRef(false)
  React.useEffect(() => {
    liveRef.current = live
    dialogRef.current = lens.dialog !== null
  }, [live, lens])

  /** The module's ONE peek. Every read below goes through it, so "how many
   *  pollers does the chat surface have?" stays a `grep` with an answer. */
  const peek = React.useCallback(
    (lines: number = PEEK_LINES): Promise<string> => sessionsApi.peekAnsi(name, lines),
    [name],
  )

  const apply = React.useCallback(
    (text: string): PeekLens => {
      const next = readLens(text)
      setFrame({ name, capture: text, lens: next })
      return next
    },
    [name],
  )

  const refresh = React.useCallback(
    async (continuing?: DialogContinuity | null): Promise<PeekLens | null> => {
      try {
        const text = await peek()
        // The SHARED frame is always the strict reading: the card, the composer
        // gate and the Attention view must never be shown a relaxed one, not
        // even for the tick an answer is in flight. The anchor buys a second,
        // private reading for the caller that earned it — one more pass over 60
        // lines of string, and the surface keeps its refusals.
        const strict = apply(text)
        return continuing ? readLens(text, continuing) : strict
      } catch {
        return null
      }
    },
    [apply, peek],
  )

  // One boot-banner read per session, ever.
  React.useEffect(() => {
    if (!enabled || bannerCache.has(name)) return
    let dead = false
    void (async () => {
      let found: string | null
      try {
        found = readLens(await peek(BANNER_LINES)).bannerVersion
      } catch {
        return // not running / transient — leave it unresolved, retry on remount
      }
      bannerCache.set(name, found)
      if (!dead) bannerResolved()
    })()
    return () => {
      dead = true
    }
  }, [name, enabled, peek, bannerResolved])

  // The poll: one self-scheduling timeout, not an interval, so the cadence can
  // change between ticks and a slow request can never stack two peeks.
  React.useEffect(() => {
    if (!enabled) return
    let dead = false
    let timer: number | null = null
    // ONE poller means one in-flight peek. Without this, a `visibilitychange`
    // that lands while a request is in the air starts a SECOND self-scheduling
    // loop beside the first (clearing an already-fired timeout is a no-op), and
    // every further hide/show adds another — the poll rate multiplies silently.
    let inFlight = false

    const hidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden'

    const schedule = () => {
      if (dead) return
      const wait = peekCadenceMs({ live: liveRef.current, dialog: dialogRef.current })
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void tick(), wait)
    }

    const tick = async () => {
      if (dead || inFlight) return
      // Paused, not slowed: a backgrounded tab has no one to be honest to, and
      // the first thing `visibilitychange` does is peek again.
      if (hidden()) return schedule()
      inFlight = true
      try {
        const text = await peek()
        if (!dead) apply(text)
      } catch {
        /* transient — keep the previous frame, try again next tick */
      } finally {
        inFlight = false
      }
      schedule()
    }

    const onVisible = () => {
      if (dead || hidden()) return
      if (timer != null) window.clearTimeout(timer)
      void tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    void tick()

    return () => {
      dead = true
      if (timer != null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [name, enabled, peek, apply])

  // The pin comes from the deep read; the 60-line window will almost never carry
  // a banner, and when it does (a session that just booted) it agrees.
  const merged = React.useMemo(
    () => (lens.bannerVersion === banner ? lens : { ...lens, bannerVersion: banner ?? lens.bannerVersion }),
    [lens, banner],
  )

  return React.useMemo(
    () => ({ lens: merged, capture, refresh }),
    [merged, capture, refresh],
  )
}
