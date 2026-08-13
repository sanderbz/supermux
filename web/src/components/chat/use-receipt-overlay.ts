// Hook-driven receipt overlay (fase A1): the ≤1s live layer. Every activity
// delta on the focused session appends an overlay line while a turn is
// running; confirmed transcript entries SUPERSEDE overlay lines
// (discard-and-replace, never merge — a0-findings §1).
//
// Clock discipline: line stamps are the SERVER's `activity_at`, and the prune
// cutoff is the confirmed entry's (server-host) timestamp — the browser clock
// never participates, so tailnet dogfooding from a skewed device can neither
// silently kill the live layer nor freeze duplicate receipts on screen.
//
// Teardown discipline: the PANEL owns the turn (`turnStartMs`); lines clear
// when the panel ends the turn — which it only does once a confirmed entry
// from this turn is in hand, never on the bare status flip.

import * as React from 'react'

import type { TileSession } from '@/components/session-tile/types'

import { RECEIPT_CAP, stripEmojiPrefix } from './entries'
import { noteServerStamp, recordHookLatency } from './latency'

export interface OverlayLine {
  label: string
  kind?: string
  at: number // ms epoch, SERVER clock (activity_at)
}

export function useReceiptOverlay(
  session: TileSession | null,
  turnStartMs: number | null, // SERVER-clock ms; null = no live turn
  lastConfirmedTs: number, // epoch SECONDS (RecallEntry.ts, server host)
): OverlayLine[] {
  const [lines, setLines] = React.useState<OverlayLine[]>([])
  const activity = session?.activity
  const activityKind = session?.activity_kind
  const activityAt = session?.activity_at

  // Keyed on activity_at (every delta gets a fresh stamp): consecutive
  // same-LABEL tools still sample latency; the label dedupe below only
  // dedupes the visible line. Cap: oldest lines drop past RECEIPT_CAP.
  React.useEffect(() => {
    if (activityAt == null) return
    noteServerStamp(activityAt)
    recordHookLatency(activityAt)
    if (!activity || turnStartMs == null) return
    const label = stripEmojiPrefix(activity)
    // The effect subscribes to an EXTERNAL system (the SSE activity delta,
    // observed as a new `activity_at` stamp) and appends one line; the updater
    // returns the same ref when nothing changes, so it can't cascade. Same
    // exemption the repo already takes in group-grid/desktop-split.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLines((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].label === label) return prev
      const next = [...prev, { label, kind: activityKind, at: activityAt }]
      return next.length > RECEIPT_CAP ? next.slice(-RECEIPT_CAP) : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityAt])

  // Discard-and-replace: anything at or before the newest confirmed entry is
  // now represented by real receipts — drop it (both sides server clocks).
  React.useEffect(() => {
    if (lastConfirmedTs <= 0) return
    const cutoff = lastConfirmedTs * 1000
    // Prune against freshly CONFIRMED transcript data (external system);
    // filter returns a new array only when something was actually superseded.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLines((prev) => prev.filter((l) => l.at > cutoff))
  }, [lastConfirmedTs])

  // Turn ended (panel-gated on confirmation) → clear the remainder.
  React.useEffect(() => {
    // Turn boundary handed down by the panel — clearing here is the teardown
    // of the live layer, not a render-derived value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (turnStartMs == null) setLines([])
  }, [turnStartMs])

  return lines
}
