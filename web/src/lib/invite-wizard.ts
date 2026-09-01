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

// ── Step 3 — Add people: the share affordance ────────────────────────────────
//
// supermux has NO mailer. `POST /api/companies/{id}/humans` creates the
// `human_users` row and hands back a `login_url` — nothing is ever sent. An owner
// added a colleague and then waited for an email that could not arrive, because
// the step's shape (an email field, an "Invite" button, an "Invited" chip) implied
// a delivery that does not exist. The copy below says so before the row is made,
// and the share block after it is the actual delivery mechanism: the owner's own
// mail client, prefilled.

/** The one sentence that has to be on screen BEFORE anyone is added. */
export function shareItYourselfLine(quick: boolean): string {
  return quick
    ? 'supermux doesn’t send email — you share each personal link yourself.'
    : 'supermux doesn’t send email — you share the sign-in address yourself.'
}

/** What the roster row calls the thing it is offering to share. */
export function shareLinkLabel(quick: boolean, email: string): string {
  return quick
    ? `Personal invite link — send it to ${email}`
    : `Sign-in address — send it to ${email}`
}

/** A person who has never signed in (`invited`, or any status we don't know) is
 *  the one still waiting on the owner to pass the link along. */
export function neverSignedIn(status: string): boolean {
  return status !== 'active' && status !== 'pending'
}

export interface InviteMail {
  subject: string
  body: string
  /** `mailto:` href — opens the owner's own mail client, on desktop and in the
   *  iOS/Android PWA alike. Zero infrastructure, which is the whole point. */
  href: string
}

/** Prefill the mail the owner is going to send anyway.
 *
 *  The two paths differ in what the link IS: a quick-tunnel invite is a personal,
 *  single-person magic link that expires (7 days, `DEFAULT_INVITE_TTL_SECS`); the
 *  permanent path's `login_url` is just the company's sign-in address, where the
 *  colleague signs in with the Google account that was added. Saying the wrong one
 *  would be the same class of lie this whole change is removing. */
export function inviteMailto(v: {
  email: string
  company: string
  loginUrl: string
  quick: boolean
}): InviteMail {
  const subject = `Join ${v.company}`
  const body = v.quick
    ? `Hi,\n\nYou’ve been added to ${v.company}.\n\nOpen your personal link to join — it’s just for you, and it expires in 7 days:\n${v.loginUrl}\n`
    : `Hi,\n\nYou’ve been added to ${v.company}.\n\nSign in with your Google account (${v.email}) here:\n${v.loginUrl}\n`
  const href = `mailto:${v.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  return { subject, body, href }
}

// ── Which surface the sheet OWES the owner ───────────────────────────────────
//
// Witnessed live (owner, mobile, a box whose domain + Google + DNS were ALL
// done): opening "Invite a teammate" showed "Step 1 of 4", a four-step onboarding
// list with Domain "Not set up" and Google login "Not set up", and a bare
// "Checking access…" line underneath. Both halves were wrong.
//
//   (a) The rail rendered while the status query was still in flight. Every chip
//       is derived from `status` with `?.` defaults, so an ABSENT status reads
//       exactly like a box that has nothing set up — the pessimistic default is
//       indistinguishable from a fact, and it was on screen for the whole fetch.
//   (b) Once loaded, a fully-configured box still got the onboarding stepper,
//       when the only thing left to do on it is add a person.
//
// So the sheet picks one of three surfaces, from the query state and the SAME
// completion predicates the stepper already uses.

/** Setup is complete on the permanent path: the tunnel is healthy, THIS company's
 *  Google redirect verifies, and its address is actually written. All three, and
 *  from the server — the quick-tunnel (temporary link) path is deliberately NOT
 *  complete: it is a trial with a link that dies on restart, and its stepper is
 *  where an owner turns it into something permanent. */
export function setupComplete(s?: ExternalStatus): boolean {
  if (!s || quickActive(s)) return false
  return domainDone(s) && googleDone(s) && (s.company?.company_host_written ?? false)
}

/** `loading` — the status has never landed: show ONE skeleton, never the rail of
 *  defaults. `invite` — configured: the Add-people panel, no stepper. `wizard` —
 *  anything unfinished, or the settings entry point. */
export type SheetView = 'loading' | 'invite' | 'wizard'

export function sheetView(v: {
  isLoading: boolean
  isError?: boolean
  status?: ExternalStatus
  /** The "External access…" entry, or "Access settings" from inside the panel. */
  settings?: boolean
}): SheetView {
  // A status that never arrived is not a status that says "nothing is set up".
  // The error branch falls through to the wizard, which renders the error line —
  // never to the invite panel, which would imply a box we could not check.
  if (!v.status) return v.isError ? 'wizard' : v.isLoading ? 'loading' : 'wizard'
  if (v.settings) return 'wizard'
  return setupComplete(v.status) ? 'invite' : 'wizard'
}

/** The step the stepper opens on. Resumable: the FIRST unfinished one, so closing
 *  the tab mid-Google-detour loses nothing. The settings entry starts at the top
 *  instead — nothing is unfinished there, the owner came to CHANGE something. */
export function resumeStep(s: ExternalStatus, opts: { settings?: boolean } = {}): StepKey {
  if (opts.settings) return 'domain'
  if (!domainDone(s)) return 'domain'
  const quick = quickActive(s)
  if (!quick && !googleDone(s)) return 'google'
  // Resume on the inbox step when an agent-inbox is already provisioned (e.g. it
  // still needs its verification click) — otherwise land on Add people.
  if (!quick && s.company?.agent_inbox) return 'inbox'
  return 'person'
}
