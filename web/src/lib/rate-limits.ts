/**
 * Usage headroom — the only signal that arrives BEFORE the block.
 * ─────────────────────────────────────────────────────────────────────────────
 * `session.blocked` is a post-mortem: it is read off the banner Claude Code
 * printed after the bucket ran out, and by the time it exists the session has
 * already lost its next five hours. `session.rate_limits` is the other half —
 * `used_percentage` for the 5-hour and 7-day windows, fed by the opt-in
 * statusline tap, available while there is still time to change plans.
 *
 * supermux has had the tap since fase B: 900 lines, wrap-don't-clobber, an exact
 * uninstall, and its own test suite. It was never READ. `AppState::statusline()`
 * had zero call sites, `config.statusline_tap` defaults to `false`, and no web
 * code mentioned `rate_limits` at all (verify matrix finding 7). This module is
 * the last mile.
 *
 * WHAT IT CANNOT SAY, stated because a gauge that overclaims is worse than none:
 * `rate_limits` carries no `blocked` flag, no Opus/Sonnet split, no overage
 * bucket, and the whole key is absent on a fresh boot and on every host without
 * the tap. It answers "how full is the window", never "can this session work".
 * That question is `session.blocked`'s.
 *
 * Pure: no React, no network, no clock of its own.
 */

/** The wire shape of `SessionView.rate_limits`. Every level optional, because
 *  every level of Claude Code's own payload is. */
export interface RateLimits {
  five_hour?: RateWindow
  seven_day?: RateWindow
  /** Server-clock ms at which the tap last reported. The payload has no stamp of
   *  its own and the tap is per-turn, so a stale gauge must be recognisable. */
  at_ms?: number
}

export interface RateWindow {
  /** 0–100. */
  used_pct: number
  /** UNIX epoch SECONDS — Claude Code's unit, passed through unconverted. */
  resets_at?: number
}

/**
 * Below this the gauge says nothing.
 *
 * A roster of forty rows each carrying `5h 3%` is forty pieces of furniture and
 * zero information — and this surface's whole design argument is that a signal
 * which is always on is not a signal. Claude Code suppresses its own dim footer
 * warning under 70 % utilisation; 60 is the same judgement one notch earlier, so
 * the chip appears while the number can still change a decision.
 */
export const USAGE_FLOOR_PCT = 60
/** Above this the chip takes the blocked badge's orange: the window is nearly
 *  gone and the next thing that happens is a block. */
export const USAGE_HOT_PCT = 85

export interface UsageReading {
  /** `5h` or `7d` — which window this is. */
  label: string
  pct: number
  /** At or above [`USAGE_HOT_PCT`]. */
  hot: boolean
}

/**
 * The fuller of the two windows, or `null` when neither is worth showing.
 *
 * The WORSE bucket wins, singular: which window is about to run out is what the
 * user needs, and printing both turns a hint into a table. The other one is
 * still reachable — [`usageTitle`] puts the pair in the tooltip.
 */
export function worstWindow(r?: RateLimits): UsageReading | null {
  const candidates: UsageReading[] = []
  const push = (label: string, w?: RateWindow) => {
    if (w && Number.isFinite(w.used_pct)) {
      candidates.push({ label, pct: w.used_pct, hot: w.used_pct >= USAGE_HOT_PCT })
    }
  }
  push('5h', r?.five_hour)
  push('7d', r?.seven_day)
  if (!candidates.length) return null
  const worst = candidates.reduce((a, b) => (b.pct > a.pct ? b : a))
  return worst.pct >= USAGE_FLOOR_PCT ? worst : null
}

/** Both windows, for the hover — so the quiet one is not lost to the chip's
 *  single number. Empty string when there is nothing to say. */
export function usageTitle(r?: RateLimits): string {
  return [
    r?.five_hour ? `5-hour window ${Math.round(r.five_hour.used_pct)}% used` : '',
    r?.seven_day ? `7-day window ${Math.round(r.seven_day.used_pct)}% used` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
