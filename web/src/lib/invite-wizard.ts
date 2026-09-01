/**
 * The invite wizard's pure core — step order, the completion rules derived from
 * `GET /api/external-access/status`, and the Google step's outcome + orchestration.
 *
 * It lives beside the sheet rather than inside it because these are the parts a
 * test can hold still: this suite has no DOM, so the only way to pin "a successful
 * save+verify MOVES the step" and "a thrown verify is rendered, not swallowed" is
 * to assert the function the button calls and the value the surfaces render.
 */
import { SessionError } from '@/lib/api'
import type { ExternalStatus, VerifyLoginResult } from '@/lib/api'

export type StepKey = 'domain' | 'google' | 'person' | 'inbox' | 'success'
// The full (permanent-domain) order. `inbox` (the optional Cloudflare agent-inbox)
// sits after people — it needs the connected domain. The quick-tunnel branch omits
// both Google and the inbox (a trycloudflare host has no zone to route mail on),
// collapsing to Domain → Add people → Done.
export const ORDER: StepKey[] = ['domain', 'google', 'person', 'inbox', 'success']
export const QUICK_ORDER: StepKey[] = ['domain', 'person', 'success']

export function errText(e: unknown): string {
  if (e instanceof SessionError) {
    if (e.status === 0) return 'Can’t reach supermux-server. Check it’s running, then try again.'
    return e.message
  }
  return e instanceof Error ? e.message : 'Something went wrong — try again.'
}

// Derived completion from the live status. Domain is done once the tunnel is
// healthy OR a temporary quick tunnel is live; Google is done once THIS company's
// redirect verifies green.
export function quickActive(s?: ExternalStatus): boolean {
  return !!s?.box_status.quick_tunnel?.active
}
export function domainDone(s?: ExternalStatus) {
  return s?.box_status.tunnel === 'healthy' || quickActive(s)
}
export function googleDone(s?: ExternalStatus) {
  return s?.box_status.google === 'configured' && s?.company?.redirect_registered === 'ok'
}

/** Google is done when the LIVE status says so — or when this session's own
 *  `POST /verify-login` already answered `{ok:true}`. Both are server truth; only
 *  the first needs a second round-trip to arrive, which is precisely the
 *  round-trip that left a landed save looking like a no-op. */
export function googleStepDone(s: ExternalStatus | undefined, verifiedDetail: string | null): boolean {
  return googleDone(s) || verifiedDetail !== null
}

/** The step that follows `key` in `order`, or `null` at the end. */
export function stepAfter(order: StepKey[], key: StepKey): StepKey | null {
  const i = order.indexOf(key)
  return i >= 0 && i < order.length - 1 ? order[i + 1] : null
}

/** What the Google step has to SAY after an attempt.
 *
 *  · `ready`  — verify answered `{ok:true}`: show its own sentence.
 *  · `failed` — verify answered `{ok:false}`: show its detail, offer Check again.
 *  · `error`  — the save OR the verify THREW (4xx/5xx/offline). This is the case
 *    the step used to swallow whole: the handler caught it, `verify.isError` was
 *    rendered nowhere, and the button just reverted with nothing on screen.
 */
export type GoogleOutcomeKind = 'idle' | 'ready' | 'failed' | 'error'
export interface GoogleOutcome {
  kind: GoogleOutcomeKind
  text: string
}

export function googleOutcome(v: {
  saveError?: unknown
  verifyError?: unknown
  verifyResult?: VerifyLoginResult | null
  verifiedDetail?: string | null
}): GoogleOutcome {
  if (v.saveError != null) return { kind: 'error', text: errText(v.saveError) }
  if (v.verifyError != null) return { kind: 'error', text: errText(v.verifyError) }
  if (v.verifyResult && !v.verifyResult.ok) return { kind: 'failed', text: v.verifyResult.detail }
  const ready = v.verifiedDetail ?? (v.verifyResult?.ok ? v.verifyResult.detail : null)
  return ready ? { kind: 'ready', text: ready } : { kind: 'idle', text: '' }
}

/** A retry is offered for anything that did not land — a refused verify and a
 *  thrown one alike (the thrown one had no retry at all before). */
export function showCheckAgain(o: GoogleOutcome): boolean {
  return o.kind === 'failed' || o.kind === 'error'
}

/** Save (or re-assert the host), verify, and act on what verify SAID.
 *
 *  Extracted from the click handler so the sequence is assertable without a DOM:
 *  a `{ok:true}` verify hands its detail to `onVerified` (which flips the chip and
 *  walks the stepper) — it no longer waits for `refetch` to land, which is what
 *  made a fully-successful save look like nothing happened. A throw is left to the
 *  mutation's own `isError`, now rendered by `GoogleOutcomeLine`. The status
 *  re-read still fires either way, so the rest of the wizard stays current. */
export async function runGoogleVerify(v: {
  save: () => Promise<unknown>
  verify: () => Promise<VerifyLoginResult>
  refetch: () => void
  onVerified: (detail: string) => void
}): Promise<void> {
  try {
    await v.save()
    const res = await v.verify()
    if (res.ok) v.onVerified(res.detail)
  } catch {
    /* surfaced by googleOutcome() → <GoogleOutcomeLine> — never swallowed */
  }
  v.refetch()
}
