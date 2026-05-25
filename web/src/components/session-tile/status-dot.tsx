import { cn } from '@/lib/utils'
import type { SessionStatus } from '@/lib/api'

/** Status → semantic status color (M28 brand tokens in globals.css).
 *
 *  Five distinct colours + one neutral booting tint, one per `Status` enum
 *  variant (`server/src/sessions/status.rs`): the dot must DIFFERENTIATE
 *  running / needs-input / idle-but-alive / stopped at a glance. `starting` is
 *  the short-lived boot window — neutral grey so it doesn't masquerade as
 *  active or needs-input. `idle` reads as the calm green "ready" tint (turn
 *  ended, agent alive, awaiting your next prompt); `stopped` keeps the muted
 *  grey reserved for "agent is off". */
const STATUS_COLOR: Record<SessionStatus, string> = {
  starting: 'bg-status-idle',
  active: 'bg-status-active',
  waiting: 'bg-status-waiting',
  idle: 'bg-status-ready',
  stopped: 'bg-status-idle',
  error: 'bg-status-error',
}

/** The "loading / working" states that render the animated spinner instead of a
 *  static disc. BOTH the boot window (`starting`) and the working window
 *  (`active`) are "the agent is busy, hang on" — so the top-right loader must
 *  animate for EITHER, deterministically.
 *
 *  This is the fix for the reported "spinner sometimes animates, sometimes not":
 *  previously only `active` spun, so whether you saw motion depended entirely on
 *  WHICH of the two loading statuses the (sometimes-stale) synced data happened
 *  to hold — a freshly-started session sits in `starting` until the detector's
 *  first capture flips it to `active`, and if that delta is delayed (or the SSE
 *  stream was suspended on mobile, the companion bug) the dot froze as a static
 *  grey disc. Making the spinner a pure function of `status ∈ LOADING_STATUSES`
 *  removes that race: the indicator is decided solely by the status value, with
 *  no dependence on transition timing or re-render ordering. */
const LOADING_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'starting',
  'active',
])

/** Status → human label (sentence case, never UPPERCASE — BRAND voice). */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'Booting',
  active: 'Running',
  waiting: 'Needs input',
  idle: 'Idle',
  stopped: 'Stopped',
  error: 'Error',
}

/** Decorative status indicator (§4.3). The "attention" pulse lives on the CARD
 *  (`<StatusBorder>`), NOT here — the dot is a static colour indicator. The one
 *  exception is the LOADING states (`starting` + `active`), where a tiny spinner
 *  replaces the disc because that IS the loading/working affordance (the
 *  "top-right loader icon"):
 *
 *  • `starting` / `active` — the agent is booting or thinking. A small circular
 *    spinner (slightly bigger than the resting dot) rotates at a calm cadence so
 *    the dot reads as "doing work" / "loading". This is the only dot that moves,
 *    and it moves for BOTH loading states so the indicator is a PURE function of
 *    status — never dependent on which loading sub-state a (possibly-stale) sync
 *    happens to hold (that timing dependence was the "sometimes animates,
 *    sometimes not" bug). The card stays calm (no glow) during this phase.
 *  • `waiting` — input is required. STATIC blue disc. The blue attention signal
 *    is the card glow (`<StatusBorder>` waiting pulse), not the dot — the dot
 *    just colours the state. (Earlier this pulsed; reverted to keep the pulse on
 *    the card so loading/done/needs-input read consistently at the card level.)
 *  • `idle` — the turn ended (done → green). STATIC green disc. The "ready"
 *    signal is the subtle green card glow (`<StatusBorder>` idle pulse); the dot
 *    just colours the state. (Earlier this pulsed green; reverted.)
 *  • everything else (`stopped`, `error`) — static disc, no motion.
 *
 *  Footprint stays ≤ 14px (8px dot + a 2px spinner ring) so it never
 *  dominates the tile. The loading spinner ALWAYS rotates while shown — even
 *  under Reduce Motion — because it is functional feedback ("the agent is
 *  working"), not decoration; freezing it would read as "stuck". The dot is
 *  decorative + non-interactive, so the 44pt tap-target rule does not apply. */
export function StatusDot({
  status,
  className,
}: {
  status: SessionStatus
  className?: string
}) {
  // ── Loading spinner (starting + active) — a PURE function of status ────────
  //
  // A 12px ring whose top arc is amber and the rest transparent; the CSS
  // `sm-status-spinner` keyframe rotates the whole element so the amber arc
  // sweeps — the canonical "tiny spinner" without an SVG dep, ≤ 14px footprint.
  // The SAME spinner renders for `starting` and `active` (both are "busy, hang
  // on"), so the loader never depends on which of the two the synced status
  // holds. It uses a pure CSS animation (NOT framer) so it ALWAYS rotates while
  // shown — including under Reduce Motion: a loading indicator is functional
  // feedback (it says "the agent is working"), not a decorative flourish, so it
  // must never freeze, the way Apple keeps its activity indicators spinning.
  if (LOADING_STATUSES.has(status)) {
    return (
      <span
        role="img"
        aria-label={STATUS_LABEL[status]}
        className={cn(
          'sm-status-spinner inline-block size-3 shrink-0 rounded-full border-2 border-transparent border-t-status-active',
          className,
        )}
      />
    )
  }

  // ── Static colour discs (waiting, idle, stopped, error) ────────────────────
  //
  // The pulse/halo now lives on the CARD (`<StatusBorder>`), so the dot is a
  // plain static colour indicator for every non-loading state:
  //   • waiting → blue disc  (card carries the blue "needs input" pulse)
  //   • idle    → green disc  (card carries the subtle green "ready" glow)
  //   • stopped/error → muted / orange disc
  // (`starting` + `active` never reach here — they render the loading spinner
  // above.) Earlier (4f2bc52) the waiting + idle dots pulsed a halo; reverted
  // here so a single, consistent attention model lives at the card level.
  // STATUS_COLOR maps each remaining status to its `bg-status-*` token.
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[status]}
      className={cn(
        'size-2 shrink-0 rounded-full',
        STATUS_COLOR[status],
        className,
      )}
    />
  )
}
