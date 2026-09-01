/**
 * `<InviteWizardSheet>` — the guided, resumable onboarding wizard an owner opens
 * from "Invite to <company>". It gives non-expert self-hosters external access at
 * `https://<slug>.<their-own-domain>` (a Cloudflare zone they control + Google
 * login) and seeds colleague `human_users`, entirely in-app with live verification
 * at every step. The base domain is operator-chosen (BYO) — nothing is hardcoded.
 *
 * GROK-NATIVE + MOBILE-FIRST + DRY. The shell is the app's canonical
 * `<ResponsiveSheet>` (Vaul drag-detent bottom-sheet on coarse pointers · shadcn
 * side sheet on desktop) — NOT a bespoke modal. Identity is `<CompanyMark>`, the
 * panels sit on the store `cs-card` surface, colours are `--gr-*`/`--sm-*` tokens,
 * and inputs are the shared `Button`/`Input`. The only NEW primitives are the tiny
 * `StatusChip`/`CopyField`/`SecretInput`/`RoleSelect`/`WizardStepper`
 * (`wizard-primitives.tsx`). The data plane is the `use-external-access` hooks, and
 * the pure core — step order, the completion rules, the Google step's outcome and
 * its save→verify→advance orchestration — is `@/lib/invite-wizard`, so the parts
 * that decide what the owner SEES are assertable without a DOM.
 *
 * RESUMABLE. On open it reads `GET /api/external-access/status?company_id=<id>`
 * and routes to the FIRST unfinished step — closing the tab mid-Google-detour
 * loses nothing because state lives server-side.
 *
 * This component is lazy-loaded (see the switcher entry point + `App.tsx` dev
 * route), so none of its weight — or the mock's — lands on the cold-load hero path.
 */
import * as React from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Clock,
  ExternalLink,
  Globe,
  Mail,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { CompanyMark } from '@/components/roster/company-mark'
import {
  useAgentInbox,
  useCfToken,
  useCompanyHost,
  useTightenDns,
  useCompanyHumans,
  useDeleteAgentInbox,
  useExternalStatus,
  useGoogleConfig,
  useInviteHuman,
  useProvisionTunnel,
  useRemoveHuman,
  useSetBaseDomain,
  useStartQuickTunnel,
  useStopQuickTunnel,
  useVerifyLogin,
  useZones,
} from '@/hooks/use-external-access'
import {
  CopyField,
  RoleSelect,
  SecretInput,
  StatusChip,
  WizardStepper,
  useCopy,
  type ChipState,
  type HumanRole,
  type StepMeta,
} from '@/components/companies/wizard-primitives'
import type { ExternalStatus, QuickTunnelStatus } from '@/lib/api'
import {
  ORDER,
  QUICK_ORDER,
  domainDone,
  errText,
  googleDone,
  googleOutcome,
  googleStepDone,
  inviteMailto,
  neverSignedIn,
  quickActive,
  runGoogleVerify,
  shareItYourselfLine,
  shareLinkLabel,
  showCheckAgain,
  stepAfter,
  type GoogleOutcome,
  type StepKey,
} from '@/lib/invite-wizard'
import {
  dnsPlanLine,
  labelOf,
  previewHost,
  subdomainError,
  suggestLabel,
} from '@/lib/company-subdomain'
import { connectorLabel, connectorReason, tunnelSetupView } from '@/lib/connector-view'
import { quickTunnelView } from '@/lib/quick-tunnel'

/** The minimal company identity the wizard needs. */
export interface WizardCompany {
  id: number
  slug: string
  display_name: string
}

export function InviteWizardSheet({
  open,
  onOpenChange,
  company,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  company: WizardCompany
}) {
  // `isError`/`error` are READ here on purpose: the wizard's whole view is derived
  // from this one query, so a GET that fails must say so — silently rendering the
  // last-known (stale) status is exactly how a landed mutation looked like a no-op.
  const {
    status,
    isLoading,
    isError: statusIsError,
    error: statusError,
    refetch,
  } = useExternalStatus(company.id, { enabled: open })

  // Derived host/redirect. The base domain is operator-chosen (BYO) — there is NO
  // hardcoded suffix fallback. Prefer the server's computed host; else derive from
  // the chosen base domain; else empty (the copy shows a `<your-domain>` placeholder,
  // never a fake host). The Google/People/Success steps only render once the tunnel
  // is healthy, by which point the base is set and the server host is populated.
  const qt = status?.box_status.quick_tunnel ?? null
  const isQuick = quickActive(status)
  const baseDomain = status?.box_status.base_domain ?? null
  const serverHost = status?.company?.host
  const host =
    isQuick && qt
      ? qt.host
      : serverHost && serverHost.length > 0
        ? serverHost
        : baseDomain
          ? `${company.slug}.${baseDomain}`
          : ''
  const redirectUri =
    status?.company?.redirect_uri && status.company.redirect_uri.length > 0
      ? status.company.redirect_uri
      : host
        ? `https://${host}/auth/callback`
        : ''
  const liveUrl = isQuick && qt ? qt.url : host ? `https://${host}` : ''

  // The active panel. Initialised ONCE from status to the first unfinished step
  // (resumable), then user-driven via Back/Continue.
  const [step, setStep] = React.useState<StepKey>('domain')
  // Route to the resume step ONCE, the first render after the sheet opens with a
  // loaded status. Done during render (the "adjust state when a prop changes"
  // pattern) with a state latch rather than an effect + ref: it avoids both
  // react-hooks/set-state-in-effect and a ref write during render, and is one
  // fewer commit than the effect was.
  const [routedOpen, setRoutedOpen] = React.useState(false)
  // What THIS session's verify call reported when it reported success. The Google
  // step used to derive its whole view from the status query, so a save+verify
  // that had already landed on the server showed nothing at all until a
  // background refetch happened to arrive — and when that GET lagged or failed,
  // nothing ever moved and nothing was said. The verify response is the truth we
  // just received: hold it, and let the chip, the gate and the confirmation read
  // it directly instead of waiting on a second round-trip.
  const [verifiedDetail, setVerifiedDetail] = React.useState<string | null>(null)
  if (!open && routedOpen) {
    setRoutedOpen(false)
    setVerifiedDetail(null)
  }
  if (open && status && !routedOpen) {
    setRoutedOpen(true)
    if (!domainDone(status)) setStep('domain')
    else if (!isQuick && !googleDone(status)) setStep('google')
    // Resume on the inbox step when an agent-inbox is already provisioned (e.g. it
    // still needs its verification click) — otherwise land on Add people.
    else if (!isQuick && status.company?.agent_inbox) setStep('inbox')
    else setStep('person')
  }

  // The active order branches: the quick-tunnel path skips Google entirely.
  const order = isQuick ? QUICK_ORDER : ORDER
  // Google is done when the live status says so OR when this session's own verify
  // said so — either is server truth, and the second one does not need a refetch.
  const googleOk = googleStepDone(status, verifiedDetail)
  const idx = Math.max(0, order.indexOf(step))
  const totalSteps = order.length - 1 // exclude the terminal "success" screen

  // Per-step chips for the rail — derived from live status. The quick-tunnel branch
  // shows a 2-step rail (Domain → Add people); the permanent path shows 3.
  const domainChip: StepMeta = isQuick
    ? {
        key: 'domain',
        title: 'Temporary link',
        chip: chipFor(true, false, 'Active'),
      }
    : {
        key: 'domain',
        title: 'Domain',
        chip: chipFor(
          domainDone(status),
          status?.box_status.tunnel === 'connecting',
          status?.box_status.tunnel === 'healthy' ? 'Connected' : status?.box_status.tunnel === 'connecting' ? 'Connecting…' : 'Not set up',
        ),
      }
  const steps: StepMeta[] = isQuick
    ? [
        domainChip,
        { key: 'person', title: 'Add people', chip: { state: 'idle', label: 'Invite' } },
        { key: 'success', title: 'Done', chip: { state: 'idle', label: '' } },
      ]
    : [
        domainChip,
        {
          key: 'google',
          title: 'Google login',
          chip: chipFor(googleOk, false, googleOk ? 'Verified' : status?.box_status.google === 'configured' ? 'One URL to add' : 'Not set up'),
        },
        { key: 'person', title: 'Add people', chip: { state: 'idle', label: 'Invite' } },
        { key: 'inbox', title: 'Agent email', chip: inboxChipFor(status) },
        { key: 'success', title: 'Done', chip: { state: 'idle', label: '' } },
      ]
  const railSteps = steps.slice(0, totalSteps)

  // `inbox` is optional — Continue is always enabled on it (the owner may skip
  // giving bots their own email); every other input step keeps its own gate.
  const canContinue =
    step === 'domain'
      ? domainDone(status)
      : step === 'google'
        ? googleOk
        : step === 'person' || step === 'inbox'
          ? true
          : false
  // The last input step before "success" shows "Finish".
  const isLastInputStep = idx === order.length - 2

  const goBack = () => idx > 0 && setStep(order[idx - 1])
  const goNext = () => idx < order.length - 1 && setStep(order[idx + 1])
  // Success has to MOVE, not just settle: record what verify said, then walk the
  // stepper on — the confirmation sentence rides along above the next panel so
  // the beat is visible even though the advance is immediate.
  const onGoogleVerified = (detail: string) => {
    setVerifiedDetail(detail)
    const next = stepAfter(order, 'google')
    if (next) setStep(next)
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      className="sm:max-w-lg"
      title={
        <span className="flex items-center gap-2.5">
          <CompanyMark slug={company.slug} name={company.display_name} logo={company} size={24} className="grok-identity" />
          <span className="truncate">Invite a teammate</span>
        </span>
      }
      description={step === 'success' ? 'All set.' : `Step ${idx + 1} of ${totalSteps}`}
      footer={
        // `data-grok` so the portalled footer resolves the Grok accent tokens
        // (`--sm-accent-fill`/`--gr-onaccent` are defined only under `[data-grok]`,
        // which the body-portal escapes) — same fix as the sibling sheets.
        <div data-grok>
          {step === 'success' ? (
            <div className="flex justify-end">
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="ghost" onClick={goBack} disabled={idx === 0}>
                <ArrowLeft className="size-4" /> Back
              </Button>
              <Button
                type="button"
                onClick={goNext}
                disabled={!canContinue}
                style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
              >
                {isLastInputStep ? 'Finish' : 'Continue'} <ArrowRight className="size-4" />
              </Button>
            </div>
          )}
        </div>
      }
    >
      {/* `data-grok` so the body-portalled content resolves the Grok accent tokens
          (defined only under `[data-grok]`) — CTAs/chips/copy fields render filled. */}
      <div data-grok className="flex flex-col gap-4 px-5 py-4">
        {/* The rail — collapses to one line on a phone via responsive class. */}
        {step !== 'success' && (
          <div className="cs-card rounded-xl border border-border p-3">
            <WizardStepper steps={railSteps} current={Math.min(idx, railSteps.length - 1)} />
          </div>
        )}

        {/* The status re-read is the wizard's only eye on the server — when it
            fails, SAY so rather than keep rendering the last-known answer. */}
        {statusIsError && (
          <p role="alert" data-vr="status-error" className="text-sm text-destructive">
            Couldn’t re-check access — {errText(statusError)}
          </p>
        )}
        {/* The Google step's success, carried forward: the chip is already done in
            the rail above, and this is the sentence the server actually said. */}
        {verifiedDetail && step !== 'google' && step !== 'success' && (
          <GoogleReadyCard detail={verifiedDetail} />
        )}

        {isLoading && !status ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Checking access…</p>
        ) : step === 'domain' ? (
          <DomainStep status={status} host={host} company={company} refetch={refetch} />
        ) : step === 'google' ? (
          <GoogleStep
            status={status}
            redirectUri={redirectUri}
            liveUrl={liveUrl}
            companyId={company.id}
            refetch={refetch}
            verifiedDetail={verifiedDetail}
            onVerified={onGoogleVerified}
          />
        ) : step === 'person' ? (
          <PersonStep company={company} liveUrl={liveUrl} quick={isQuick} />
        ) : step === 'inbox' ? (
          <AgentInboxStep status={status} companyId={company.id} baseDomain={baseDomain} refetch={refetch} />
        ) : (
          <SuccessStep company={company} liveUrl={liveUrl} quick={isQuick} onInviteAnother={() => setStep('person')} />
        )}
      </div>
    </ResponsiveSheet>
  )
}

function chipFor(done: boolean, working: boolean, label: string): { state: ChipState; label: string } {
  if (done) return { state: 'done', label }
  if (working) return { state: 'working', label }
  return { state: 'idle', label }
}

/** Rail chip for the optional agent-inbox step: verified (done), pending
 *  (working), or not set up yet (idle). */
function inboxChipFor(status?: ExternalStatus): { state: ChipState; label: string } {
  const ai = status?.company?.agent_inbox
  if (!ai) return { state: 'idle', label: 'Optional' }
  if (ai.verified) return { state: 'done', label: 'Live' }
  return { state: 'working', label: 'Verify' }
}

// ── Step 1 — Domain / external access ─────────────────────────────────────────

/** The permission rows to add in Cloudflare's token editor. Each row is that
 *  editor's three dropdowns — group, permission, level — so they are LISTED for
 *  the operator to pick, never offered as text to paste (there is nowhere to
 *  paste them). `why` says what supermux does with each one; the last row is
 *  only needed for the optional agent email address.
 *
 *  Kept in lockstep with what the code actually calls: Tunnel:Edit for
 *  `POST /accounts/{id}/cfd_tunnel` (external_access/cf.rs), DNS:Edit for the
 *  wildcard CNAME, Zone:Read to find the zone, Email Routing Rules:Edit for the
 *  agent inbox. */
/** The taps, in order. `*…*` marks what the operator reads off the Cloudflare UI
 *  (a menu item, a button, a field) so the eye can find it — one authored list
 *  instead of seven hand-built paragraphs. */
const CF_TOKEN_STEPS: string[] = [
  'Open *dash.cloudflare.com* in another tab and sign in.',
  'Go to *My Profile → API Tokens*, or *Manage Account → API Tokens*. Both kinds of token work here.',
  'Tap *Create Token*, then *Create Custom Token*.',
  'Under *Permissions*, add these rows. Each row is three dropdowns:',
  'Under *Zone Resources*, choose *Include → Specific zone* and pick your domain.',
  'Tap *Continue to summary*, then *Create Token*.',
  'Copy the token straight away — Cloudflare shows it one time — and paste it below.',
]
/** Which step the permission rows hang under (0-based). */
const PERMISSIONS_STEP = 3

/** Render one step, lifting `*marked*` fragments to foreground weight. */
function Steps({ text }: { text: string }) {
  return (
    <>
      {text.split('*').map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="text-foreground">
            {part}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  )
}

const CF_PERMISSIONS: { row: string; why: string; optional?: boolean }[] = [
  { row: 'Account · Cloudflare Tunnel · Edit', why: 'creates the tunnel to your box' },
  { row: 'Zone · DNS · Edit', why: 'points your domain at that tunnel' },
  { row: 'Zone · Zone · Read', why: 'lists your domains so you can pick one' },
  {
    row: 'Zone · Email Routing Rules · Edit',
    why: 'only for the agent email address',
    optional: true,
  },
]

function DomainStep({
  status,
  host,
  company,
  refetch,
}: {
  status?: ExternalStatus
  host: string
  company: WizardCompany
  refetch: () => void
}) {
  const [token, setToken] = React.useState('')
  const cf = useCfToken(company.id)
  const provision = useProvisionTunnel(company.id)
  const startQuick = useStartQuickTunnel(company.id)
  const stopQuick = useStopQuickTunnel(company.id)
  // Which branch the operator picked at the two-card chooser. `choose` shows the
  // chooser; `domain` reveals the existing Cloudflare/Google path.
  const [path, setPath] = React.useState<'choose' | 'domain'>('choose')

  const qt = status?.box_status.quick_tunnel ?? null
  const cfValid = status?.box_status.cf_token === 'valid'
  const baseDomain = status?.box_status.base_domain ?? null
  // Whether THIS company's address is written yet — Entry B (a new company on an
  // already-configured box) reaches the connected card with none, and must get a
  // chance to name it rather than silently inheriting the slug.
  const hostWritten = status?.company?.company_host_written ?? false
  // A box provisioned by an older build still holds `*.<base>`; surface it here
  // (never act on it implicitly) so the owner can narrow their zone in one tap.
  const wildcardDns = status?.box_status.wildcard_dns ?? false
  const dnsRecords = status?.box_status.dns_records ?? []
  const tunnel = status?.box_status.tunnel ?? 'none'
  const done = tunnel === 'healthy'
  // The connector PROCESS on the box. `tunnel === 'connecting'` alone used to
  // drive an indefinite spinner; a tunnel with no connector attached to it is a
  // failure with a reason, not progress. See `lib/connector-view.ts`.
  const connector = status?.box_status.connector ?? null
  const setupView = tunnelSetupView({ tunnel, connector, provisionPending: provision.isPending })
  const startTunnel = () => startQuick.mutate(undefined, { onSuccess: () => refetch() })

  // The box knows about a temporary link → the ephemeral panel, LIVE or not.
  // A tunnel that stopped is its own state (`quickTunnelView`), never a silent
  // fall-back to the chooser: the operator asked for a link and one was created,
  // so the panel has to say what became of it.
  const qtView = quickTunnelView(qt)
  if (qt && qtView !== 'none') {
    return (
      <QuickTunnelPanel
        qt={qt}
        live={qtView === 'live'}
        retrying={startQuick.isPending}
        retryError={startQuick.isError ? errText(startQuick.error) : null}
        onRetry={startTunnel}
        stopping={stopQuick.isPending}
        error={stopQuick.isError ? errText(stopQuick.error) : null}
        onStop={() => stopQuick.mutate(undefined, { onSuccess: () => refetch() })}
      />
    )
  }

  // Neither path started yet → the flagship two-card chooser (quick tunnel first).
  const domainStarted = cfValid || baseDomain != null || done
  if (!domainStarted && path === 'choose') {
    return (
      <QuickTunnelChoice
        starting={startQuick.isPending}
        // The POST returned a URL but `status` has not caught up yet — hold the
        // working state instead of re-offering the button that just succeeded.
        settling={startQuick.isSuccess && qtView === 'none'}
        error={startQuick.isError ? errText(startQuick.error) : null}
        onQuick={startTunnel}
        onDomain={() => setPath('domain')}
      />
    )
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        {wildcardDns && baseDomain && (
          <WildcardNotice
            zone={baseDomain}
            records={dnsRecords}
            companyId={company.id}
            refetch={refetch}
          />
        )}
      <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <StatusChip
          state={hostWritten ? 'done' : 'idle'}
          label={hostWritten ? `Connected · reachable at ${host}` : 'Connected · name this company'}
        />
        <p className="text-sm text-muted-foreground">
          {hostWritten
            ? 'Your box has a public web address. Continue to set up Google login.'
            : 'Your box has a public web address. Choose the name this company answers on.'}
        </p>
        {baseDomain && (
          <AddressEditor
            // Keyed on the address it is editing: when status catches up with a
            // save (or a base-domain change), the card re-reads the REAL current
            // label instead of holding the one it mounted with.
            key={`${baseDomain}:${host}`}
            company={company}
            zone={baseDomain}
            currentHost={host}
            written={hostWritten}
            refetch={refetch}
          />
        )}
      </div>
      </div>
    )
  }

  // Sub-step 1a — no token yet.
  //
  // The copy here is the whole feature for a non-expert: the owner followed the
  // previous version into a zone's menu looking for a "Cloudflare Tunnel" item
  // that does not live there (tunnels are ACCOUNT-level — dash.cloudflare.com →
  // Networking → Tunnels). supermux creates the tunnel over the API, so the
  // honest instruction is simply "make a token", spelled as numbered taps with
  // the real 2026 menu names.
  if (!cfValid) {
    return (
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => setPath('choose')}
          className="inline-flex items-center gap-1 self-start text-[12.5px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Other options
        </button>
        <p className="text-sm text-muted-foreground">
          Your colleagues will reach this supermux at an address on your own domain, like{' '}
          <span className="font-mono text-foreground">team.acme.com</span>. supermux builds the
          Cloudflare tunnel and the DNS record for you. The one thing it needs from you is an API
          token.
        </p>

        <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <p className="text-sm font-medium text-foreground">Make the token in Cloudflare</p>
          <ol className="flex flex-col gap-2 text-[12.5px] leading-snug text-muted-foreground">
            {CF_TOKEN_STEPS.map((step, i) => (
              <li key={step}>
                <span className="font-medium text-foreground">{i + 1}.</span>{' '}
                <Steps text={step} />
                {/* The permission rows belong inside the step that asks for them. */}
                {i === PERMISSIONS_STEP && (
                  <ul className="mt-1.5 flex flex-col gap-1.5">
                    {CF_PERMISSIONS.map((p) => (
                      <li key={p.row} className="rounded-lg bg-[var(--gr-sel)] px-2.5 py-1.5">
                        <span className="font-mono text-[12px] text-foreground">{p.row}</span>
                        <span className="block text-[11.5px] text-muted-foreground">
                          {p.optional ? 'Optional — ' : ''}
                          {p.why}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </div>

        <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <label htmlFor="cf-token" className="text-sm font-medium text-foreground">
            Paste your Cloudflare API token
          </label>
          <SecretInput id="cf-token" value={token} onChange={setToken} placeholder="Paste the token" invalid={cf.isError} />
          {cf.isError && <p className="text-sm text-destructive">{errText(cf.error)}</p>}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => cf.mutate(token)}
              disabled={token.trim().length < 8 || cf.isPending}
            >
              {cf.isPending ? 'Checking…' : 'Check the token'}
            </Button>
          </div>
          <p className="text-[12px] leading-snug text-muted-foreground">
            supermux stores the token on your own box, readable only by supermux, and never shows it
            again.
          </p>
        </div>
      </div>
    )
  }

  // Sub-step 1b — token valid but no base domain chosen yet.
  if (!baseDomain) {
    return <ChooseDomainStep company={company} refetch={refetch} />
  }

  // Sub-step 1c — base domain chosen; provision (or watch it come up).
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Your colleagues will reach this supermux at{' '}
        <span className="font-mono text-foreground">{host}</span>.
      </p>
      {wildcardDns && (
        <WildcardNotice
          zone={baseDomain}
          records={dnsRecords}
          companyId={company.id}
          refetch={refetch}
        />
      )}
      <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <StatusChip state="done" label={`Domain set · ${baseDomain}`} />
        <AddressEditor
          key={`${baseDomain}:${host}`}
          company={company}
          zone={baseDomain}
          currentHost={host}
          written={hostWritten}
          refetch={refetch}
        />

        {setupView === 'connecting' ? (
          <div className="flex flex-col gap-2">
            <StatusChip state="working" label="Connecting… setting up the tunnel" />
            <p className="text-[12.5px] text-muted-foreground">
              {provision.isPending
                ? 'Creating the tunnel and starting the connector on your box.'
                : 'The connector is running on your box; waiting for Cloudflare to report it healthy.'}
            </p>
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={refetch}>
              Check again
            </Button>
          </div>
        ) : setupView === 'stalled' ? (
          // The connector is NOT running, so nothing will ever report healthy.
          // Say that, with the box's own reason — never a spinner that waits on
          // a process that does not exist.
          <div className="flex flex-col gap-2">
            <StatusChip state="error" label="The connector isn’t running on your box" />
            <p className="text-[12.5px] text-muted-foreground">
              Cloudflare has the tunnel, but nothing on this box is connected to it, so it will stay
              at “connecting”. {connectorReason(connector)}
            </p>
            {provision.isError && <p className="text-sm text-destructive">{errText(provision.error)}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => provision.mutate(undefined, { onSuccess: () => refetch() })}
                disabled={provision.isPending}
                className="self-start"
                style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
              >
                Try again
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={refetch}>
                Check again
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {setupView === 'connected' && (
              <StatusChip state="done" label={connectorLabel(connector)} />
            )}
            <p className="text-sm text-muted-foreground">
              {setupView === 'connected' ? 'Running it again' : 'One click'} creates the tunnel,
              starts the connector, and adds{' '}
              {host ? (
                <>
                  one DNS record — <span className="font-mono text-foreground">{host}</span>
                </>
              ) : (
                'one DNS record per company address'
              )}
              . Nothing else on <span className="font-mono">{baseDomain}</span> changes.
            </p>
            {provision.isError && <p className="text-sm text-destructive">{errText(provision.error)}</p>}
            <Button
              type="button"
              onClick={() => provision.mutate(undefined, { onSuccess: () => refetch() })}
              disabled={provision.isPending}
              className="self-start"
              variant={setupView === 'connected' ? 'outline' : 'default'}
              style={
                setupView === 'connected'
                  ? undefined
                  : { background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }
              }
            >
              {setupView === 'connected' ? 'Set up access again' : 'Set up access'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Step 1 (chooser) — "Try without a domain" vs "Connect your own domain" ─────

/** The flagship fork on the Domain step (design §5.1). Two cards, quick tunnel
 *  FIRST as the primary/effortless path: one tap starts a zero-config Cloudflare
 *  quick tunnel (no token, no zone, no Google). The secondary card reveals the
 *  existing permanent BYO-domain + Google flow. Honest about the trade either way. */
function QuickTunnelChoice({
  starting,
  settling,
  error,
  onQuick,
  onDomain,
}: {
  starting: boolean
  /** The start call returned; the box has not reported the tunnel back yet. */
  settling: boolean
  error: string | null
  onQuick: () => void
  onDomain: () => void
}) {
  const busy = starting || settling
  return (
    <div data-vr="qt-choice" className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Give your colleagues a web address to reach this supermux. Pick how — you can switch to a
        permanent domain later.
      </p>

      {/* Primary — the zero-config temporary link. */}
      <div
        className="flex flex-col gap-3 rounded-2xl border p-4"
        style={{
          borderColor: 'color-mix(in oklab, var(--sm-accent) 45%, var(--gr-line))',
          background: 'color-mix(in oklab, var(--sm-accent) 8%, transparent)',
        }}
      >
        <div className="flex items-start gap-3">
          <span
            className="grid size-9 shrink-0 place-items-center rounded-xl"
            style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
          >
            <Sparkles aria-hidden className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-[15px] font-semibold text-foreground">Try it now — no domain needed</p>
            <p className="text-[12.5px] leading-snug text-muted-foreground">
              Get a temporary web link in one tap. No domain, no Cloudflare token, no Google — invite
              colleagues with a link they just click.
            </p>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button
          type="button"
          onClick={onQuick}
          disabled={busy}
          className="h-11 w-full"
          style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
        >
          {starting ? 'Creating your link…' : settling ? 'Confirming your link…' : 'Create a temporary link'}
        </Button>
        {busy && (
          <StatusChip
            state="working"
            label={starting ? 'Starting the tunnel — a few seconds…' : 'Link created — waiting for supermux to confirm it…'}
            className="self-start"
          />
        )}
      </div>

      {/* Secondary — the permanent BYO-domain path. */}
      <div className="cs-card flex flex-col gap-3 rounded-2xl border border-border p-4">
        <div className="flex items-start gap-3">
          <span
            className="grid size-9 shrink-0 place-items-center rounded-xl"
            style={{ background: 'var(--gr-sel)', color: 'var(--muted-foreground)' }}
          >
            <Globe aria-hidden className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-[15px] font-semibold text-foreground">Connect your own domain</p>
            <p className="text-[12.5px] leading-snug text-muted-foreground">
              A permanent address like <span className="font-mono text-foreground">team.acme.com</span>,
              with Google sign-in. Needs a Cloudflare account + a Google login. Identity-verified.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={onDomain}
          // Only a request actually in flight blocks this — `settling` must never
          // trap the operator on a card whose primary button is disabled.
          disabled={starting}
          className="h-11 w-full"
        >
          Set up a domain <ArrowRight className="size-4" />
        </Button>
      </div>

      <p className="px-1 text-[12px] leading-snug text-muted-foreground">
        Temporary link = instant, no setup, but it changes when supermux restarts and anyone with the
        link can join. Your own domain = permanent + identity-verified sign-in.
      </p>
    </div>
  )
}

// ── Step 1 (a quick tunnel exists) — the temporary-link panel ────────────────

/** The ephemeral link panel (design §5.2). Two honest faces:
 *  - LIVE: the trycloudflare URL prominently + copyable, a persistent
 *    (non-scary) honesty note, and a Stop/upgrade control.
 *  - STOPPED: the box has a quick-tunnel record but the tunnel is NOT running,
 *    so the address is dead. It says exactly that and offers "Try again" —
 *    it never shows a copyable link the colleague cannot reach, and it never
 *    pretends nothing happened.
 */
function QuickTunnelPanel({
  qt,
  live,
  retrying,
  retryError,
  onRetry,
  stopping,
  error,
  onStop,
}: {
  qt: QuickTunnelStatus
  live: boolean
  retrying: boolean
  retryError: string | null
  onRetry: () => void
  stopping: boolean
  error: string | null
  onStop: () => void
}) {
  const tone = live ? 'var(--gr-work)' : 'var(--destructive)'
  return (
    <div data-vr={live ? 'qt-success' : 'qt-stopped'} className="flex flex-col gap-4">
      <div
        className="flex flex-col gap-3 rounded-2xl border p-4"
        style={{
          borderColor: `color-mix(in oklab, ${tone} 40%, var(--gr-line))`,
          background: `color-mix(in oklab, ${tone} 7%, transparent)`,
        }}
      >
        <StatusChip
          state={live ? 'done' : 'error'}
          label={live ? 'Temporary link — active' : 'Temporary link — not running'}
          className="self-start"
        />

        {live ? (
          <div className="flex flex-col gap-1.5">
            <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Clock aria-hidden className="size-3.5" /> Your temporary web address
            </span>
            <CopyField value={qt.url} label="Copy the temporary link" />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted-foreground">
              The address supermux created — nobody can reach it right now:
            </span>
            <span className="break-all font-mono text-[12.5px] text-muted-foreground line-through">
              {qt.host}
            </span>
          </div>
        )}

        <div
          className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-[12.5px] leading-snug"
          style={{ background: `color-mix(in oklab, ${tone} 12%, transparent)`, color: 'var(--foreground)' }}
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: tone }} />
          {live ? (
            <span>
              <span className="font-medium">Temporary</span> — this link changes each time supermux
              restarts. Connect your own domain for a permanent address.
            </span>
          ) : (
            <span>
              <span className="font-medium">The tunnel stopped.</span> supermux created this link,
              but the process that serves it is no longer running, so the address is dead. Try again
              — if it keeps stopping, connect your own domain instead.
            </span>
          )}
        </div>
      </div>

      {live ? (
        <p className="text-sm text-muted-foreground">
          Continue to add colleagues — each gets their own link to join, no sign-in needed.
        </p>
      ) : (
        <>
          {retryError && <p className="text-sm text-destructive">{retryError}</p>}
          <Button
            type="button"
            onClick={onRetry}
            disabled={retrying || stopping}
            className="self-start"
            style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
          >
            {retrying ? 'Creating your link…' : 'Try again'}
          </Button>
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onStop} disabled={stopping || retrying}>
          {stopping ? 'Stopping…' : live ? 'Stop / replace link' : 'Clear this link'}
        </Button>
        <span className="text-[12px] text-muted-foreground">
          {live
            ? 'Stopping lets you connect your own domain for a permanent address.'
            : 'Clearing it takes you back to the two setup options.'}
        </span>
      </div>
    </div>
  )
}

// ── A legacy wildcard, and the one-click way out of it ────────────────────────

/** Boxes set up by an older supermux wrote a `*.<domain>` DNS record: every
 *  undefined name on the operator's own domain resolved here. That is far more of
 *  someone's zone than this needs, so new boxes get one record per company — but
 *  an existing wildcard is NEVER deleted behind the owner's back. It is named,
 *  explained, and replaced only when they press the button. */
function WildcardNotice({
  zone,
  records,
  companyId,
  refetch,
}: {
  zone: string
  records: string[]
  companyId: number
  refetch: () => void
}) {
  const tighten = useTightenDns(companyId)
  return (
    <div className="cs-card flex flex-col gap-2 rounded-xl border border-border p-4">
      <StatusChip state="idle" label="Wildcard DNS record" />
      <p className="text-[12.5px] leading-snug text-muted-foreground">
        An older setup added <span className="font-mono text-foreground">*.{zone}</span> to your
        Cloudflare zone, so every name under <span className="font-mono">{zone}</span> points at
        this box. supermux only needs{' '}
        {records.length > 0 ? (
          <span className="font-mono text-foreground">{records.join(', ')}</span>
        ) : (
          'the addresses your companies actually use'
        )}
        .
      </p>
      {tighten.isError && <p className="text-sm text-destructive">{errText(tighten.error)}</p>}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        disabled={tighten.isPending}
        onClick={() => tighten.mutate(undefined, { onSuccess: () => refetch() })}
      >
        {tighten.isPending ? 'Tightening…' : 'Replace it with one record per company'}
      </Button>
      <p className="text-[12px] leading-snug text-muted-foreground">
        Adds the per-company records first, then removes the wildcard — and only if it still points
        at this box.
      </p>
    </div>
  )
}

// ── The company's address (the editable subdomain) ────────────────────────────

/** `<label>.<zone>` as ONE control: a text field for the part the owner owns and
 *  the zone pinned beside it, so the address reads the way it will be typed into
 *  a browser. Mobile-first — 44px target, the input flexes, the zone never wraps
 *  off-screen — and the preview/validation line below says the same thing the
 *  server would (`subdomainError` mirrors its `is_dns_label`). */
function SubdomainField({
  id,
  value,
  onChange,
  zone,
  error,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  zone: string
  error: string | null
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12px] text-muted-foreground">
        The address your teammates will use
      </label>
      {/* The field and the zone sit SIDE BY SIDE rather than the field living
          inside a bordered shell: one box, one focus ring. The zone shrinks (and
          truncates) before the input does, so a long domain never pushes the
          typing area off a 390px screen. */}
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="team"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-note`}
          className="h-11 min-w-0 flex-1 font-mono"
        />
        <span className="min-w-0 shrink truncate font-mono text-[12.5px] text-muted-foreground">
          .{zone}
        </span>
      </div>
      <p
        id={`${id}-note`}
        className={error ? 'text-[12px] text-destructive' : 'text-[12px] text-muted-foreground'}
      >
        {error ?? (
          <>
            Preview: <span className="font-mono text-foreground">{previewHost(value, zone)}</span>
          </>
        )}
      </p>
      {/* Say exactly what lands on their zone BEFORE they commit — one record,
          named. supermux never writes a wildcard. */}
      {!error && (
        <p className="text-[12px] leading-snug text-muted-foreground">
          {dnsPlanLine(value, zone)} — nothing else on{' '}
          <span className="font-mono">{zone}</span> is touched.
        </p>
      )}
    </div>
  )
}

/** Change (or first set) the label in front of the base domain, once the domain
 *  itself is settled. Renaming is honest about its cost: the old address stops
 *  working and Google needs the new redirect URI, so the card SAYS so before the
 *  owner commits. Opens by default when this company has no address written yet
 *  (Entry B — a new company on an already-configured box). */
function AddressEditor({
  company,
  zone,
  currentHost,
  written,
  refetch,
}: {
  company: WizardCompany
  zone: string
  currentHost: string
  written: boolean
  refetch: () => void
}) {
  const host = useCompanyHost(company.id)
  const currentLabel = labelOf(currentHost, zone)
  const [open, setOpen] = React.useState(!written)
  const [label, setLabel] = React.useState(() => currentLabel || suggestLabel(company.slug))

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => {
          setLabel(currentLabel || suggestLabel(company.slug))
          setOpen(true)
        }}
      >
        Change the address
      </Button>
    )
  }

  const error = subdomainError(label)
  const next = label.trim().toLowerCase()
  const moving = written && currentLabel !== '' && next !== currentLabel && !error

  return (
    <div className="flex flex-col gap-3">
      <SubdomainField id="company-subdomain" value={label} onChange={setLabel} zone={zone} error={error} />
      {moving && (
        <p className="text-[12px] leading-snug text-muted-foreground">
          <span className="font-mono text-foreground">{currentHost}</span> stops working when you
          save — its DNS record is removed and the new one added — and Google needs the new
          redirect URI before anyone can sign in.
        </p>
      )}
      {host.isError && <p className="text-sm text-destructive">{errText(host.error)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!!error || host.isPending}
          onClick={async () => {
            try {
              await host.mutateAsync(next)
              setOpen(false)
              refetch()
            } catch {
              /* surfaced by host.isError above */
            }
          }}
          style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
        >
          {host.isPending ? 'Saving…' : written ? 'Save the address' : 'Set the address'}
        </Button>
        {written && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Step 1b — Choose your domain (CF zone auto-discovery) ─────────────────────

/** After the CF token verifies, the operator picks WHICH of the domains that token
 *  controls their teammates will use. Exactly one → auto-select + confirm; several →
 *  a pick-one radio list; none → an empty state pointing back to Cloudflare. Setting
 *  it (`useSetBaseDomain`) is what un-gates provisioning — the box stays fail-closed
 *  (no external host) until a domain the token actually controls is chosen. */
function ChooseDomainStep({ company, refetch }: { company: WizardCompany; refetch: () => void }) {
  const { zones, isLoading, isError, error, refetch: refetchZones } = useZones({ enabled: true })
  const setBase = useSetBaseDomain(company.id)
  const host = useCompanyHost(company.id)

  const [selected, setSelected] = React.useState<string | null>(null)
  // The label in front of the zone. SUGGESTED from the company slug — which is
  // what the owner sees first — but theirs to change: "Enverder" does not have to
  // live at `enverder.<zone>`.
  const [label, setLabel] = React.useState(() => suggestLabel(company.slug))
  // Auto-select the sole zone so the common case is one confirm, not a choice.
  // Derived, not synced through an effect: while nothing is explicitly picked,
  // `chosen` already falls back to the first zone.
  const chosen = selected ?? (zones.length >= 1 ? zones[0] : null)
  const labelError = subdomainError(label)

  // Two writes, in order: the base domain (which un-gates everything) and then
  // THIS company's host entry carrying the chosen label. The entry is what every
  // later read is resolved from, so the label has to land with it — deriving it
  // again from the slug downstream is exactly the bug being fixed.
  const confirm = async () => {
    if (!chosen || labelError) return
    try {
      await setBase.mutateAsync(chosen)
      await host.mutateAsync(label.trim().toLowerCase())
    } catch {
      /* surfaced by the mutation errors below / the address card in the next step */
    }
    refetch()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">Choose your domain</p>
        <p className="text-sm text-muted-foreground">
          Pick the domain your teammates will use, and the name in front of it — we suggest your
          company&rsquo;s, but it is yours to change.
        </p>
      </div>

      {isLoading ? (
        <p className="cs-card rounded-xl border border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Finding the domains this token controls…
        </p>
      ) : isError ? (
        <div className="cs-card flex flex-col gap-2 rounded-xl border border-border p-4">
          <p className="text-sm text-destructive">{errText(error)}</p>
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={refetchZones}>
            Try again
          </Button>
        </div>
      ) : zones.length === 0 ? (
        <div className="cs-card flex flex-col gap-2 rounded-xl border border-border p-4">
          <StatusChip state="idle" label="No domains found" />
          <p className="text-[12.5px] leading-snug text-muted-foreground">
            This Cloudflare account has no domains yet. Add one in Cloudflare (Websites → Add a
            site), then check again.
          </p>
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={refetchZones}>
            Check again
          </Button>
        </div>
      ) : (
        <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
          {zones.length === 1 ? (
            <p className="text-sm text-muted-foreground">
              This token controls <span className="font-mono text-foreground">{chosen}</span> — use
              it?
            </p>
          ) : (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[12px] text-muted-foreground">
                Domains this token controls
              </legend>
              {zones.map((z) => (
                <label
                  key={z}
                  className="flex min-h-[44px] w-full cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm text-foreground has-[:checked]:border-[var(--sm-accent)]"
                >
                  <input
                    type="radio"
                    name="base-domain"
                    value={z}
                    checked={chosen === z}
                    onChange={() => setSelected(z)}
                    className="size-4 shrink-0 accent-[var(--sm-accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono">{z}</span>
                </label>
              ))}
            </fieldset>
          )}

          <SubdomainField
            id="choose-subdomain"
            value={label}
            onChange={setLabel}
            zone={chosen ?? '<your-domain>'}
            error={labelError}
          />

          {(setBase.isError || host.isError) && (
            <p className="text-sm text-destructive">{errText(setBase.error || host.error)}</p>
          )}

          <Button
            type="button"
            onClick={() => void confirm()}
            disabled={!chosen || !!labelError || setBase.isPending || host.isPending}
            className="self-start"
            style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
          >
            {setBase.isPending || host.isPending ? 'Saving…' : 'Use this address'}
          </Button>
        </div>
      )}
    </div>
  )
}

// ── Step 2 — Google login ─────────────────────────────────────────────────────

/** The one confirmation surface: chip + the sentence the server actually said.
 *  Shared by the step itself and by the banner that rides along after the
 *  stepper advances, so success reads identically in both places. */
export function GoogleReadyCard({ detail }: { detail: string }) {
  return (
    <div
      data-vr="google-ready"
      className="cs-card flex flex-col gap-2 rounded-xl border border-border p-3"
    >
      <StatusChip state="done" label="Google login verified" />
      <p role="status" className="text-[12.5px] leading-snug text-muted-foreground">
        {detail}
      </p>
    </div>
  )
}

/** Render whatever the last attempt produced — including the thrown case. */
export function GoogleOutcomeLine({ outcome }: { outcome: GoogleOutcome }) {
  if (outcome.kind === 'idle') return null
  if (outcome.kind === 'ready') return <GoogleReadyCard detail={outcome.text} />
  return (
    <p role="alert" data-vr="google-error" className="text-sm text-destructive">
      {outcome.text}
    </p>
  )
}

function GoogleStep({
  status,
  redirectUri,
  liveUrl,
  companyId,
  refetch,
  verifiedDetail,
  onVerified,
}: {
  status?: ExternalStatus
  redirectUri: string
  liveUrl: string
  companyId: number
  refetch: () => void
  /** What this session's verify already said, if it said `{ok:true}`. */
  verifiedDetail: string | null
  /** Success: hand the sentence up so the chip flips and the stepper advances. */
  onVerified: (detail: string) => void
}) {
  const boxConfigured = status?.box_status.google === 'configured'
  const done = googleStepDone(status, verifiedDetail)

  const [clientId, setClientId] = React.useState('')
  const [secret, setSecret] = React.useState('')
  const google = useGoogleConfig(companyId)
  const host = useCompanyHost(companyId)
  const verify = useVerifyLogin(companyId)

  if (done) {
    return verifiedDetail ? (
      <GoogleReadyCard detail={verifiedDetail} />
    ) : (
      <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <StatusChip state="done" label="Google login verified" />
        <p className="text-sm text-muted-foreground">
          Colleagues can sign in at <span className="font-mono text-foreground">{liveUrl}</span> with
          their Google account. Continue to add people.
        </p>
      </div>
    )
  }

  const idValid = /\.apps\.googleusercontent\.com$/.test(clientId.trim())
  // Everything the last attempt produced, in ONE value — a refused verify, a
  // thrown one, and a failed save all reach the screen through it.
  const outcome = googleOutcome({
    saveError: google.isError ? google.error : host.isError ? host.error : null,
    verifyError: verify.isError ? verify.error : null,
    verifyResult: verify.data ?? null,
    verifiedDetail,
  })
  const retry = () =>
    void runGoogleVerify({
      save: async () => {},
      verify: () => verify.mutateAsync(),
      refetch,
      onVerified,
    })

  // Entry B: the box already has a Google client — only THIS company's redirect
  // URL is missing. Collapse to the single "add one URL" mini-step (no secrets).
  const miniStep = boxConfigured

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Colleagues sign in with their Google account — no passwords for you to manage.
      </p>

      {/* The handoff: URLs to paste INTO Google Cloud Console. */}
      <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <p className="text-sm font-medium text-foreground">Add to your Google OAuth client</p>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted-foreground">Authorized redirect URI</span>
          <CopyField value={redirectUri} label="Copy the redirect URI" />
        </div>
        {!miniStep && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted-foreground">Authorized JavaScript origin</span>
            <CopyField value={liveUrl} label="Copy the JavaScript origin" />
          </div>
        )}
        <ol className="ml-4 list-decimal space-y-1 text-[12.5px] leading-snug text-muted-foreground">
          <li>Google Cloud Console → APIs &amp; Services → Credentials.</li>
          {miniStep ? (
            <li>Open your existing OAuth client → add the redirect URI above → Save.</li>
          ) : (
            <>
              <li>Create credentials → OAuth client ID → Web application.</li>
              <li>Paste both values above, then Create.</li>
              <li>Copy the Client ID and Secret now — Google may not show the secret again.</li>
            </>
          )}
        </ol>
        <p className="text-[12px] text-muted-foreground">Keep this page open while you do it.</p>
      </div>

      {/* Reciprocal paste-back — only in the full flow (Entry A). */}
      {!miniStep && (
        <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="g-client-id" className="text-sm font-medium text-foreground">
              Client ID
            </label>
            <Input
              id="g-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="…apps.googleusercontent.com"
              autoComplete="off"
              className="font-mono"
              aria-invalid={clientId.length > 0 && !idValid ? true : undefined}
            />
            {clientId.length > 0 && !idValid && (
              <p className="text-[12px] text-destructive">Should end in .apps.googleusercontent.com</p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="g-secret" className="text-sm font-medium text-foreground">
              Client Secret
            </label>
            <SecretInput id="g-secret" value={secret} onChange={setSecret} placeholder="Paste the client secret" />
          </div>
        </div>
      )}

      <GoogleOutcomeLine outcome={outcome} />

      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={() =>
            void runGoogleVerify({
              // No label argument on the mini-step: re-assert the entry the owner
              // already named (the server keeps it; only a company with none falls
              // back to the slug). Passing one here would rename their address back.
              save: () =>
                miniStep
                  ? host.mutateAsync(undefined)
                  : google.mutateAsync({ client_id: clientId.trim(), client_secret: secret }),
              verify: () => verify.mutateAsync(),
              refetch,
              onVerified,
            })
          }
          disabled={
            google.isPending ||
            host.isPending ||
            verify.isPending ||
            (!miniStep && (!idValid || secret.trim().length < 6))
          }
          style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
        >
          {google.isPending || host.isPending || verify.isPending
            ? 'Verifying…'
            : miniStep
              ? 'Verify login'
              : 'Save & verify'}
        </Button>
        {showCheckAgain(outcome) && (
          <Button type="button" variant="ghost" onClick={retry}>
            Check again
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Step 3 — Add people ───────────────────────────────────────────────────────

interface Draft {
  email: string
  role: HumanRole
}

// The roster's three derived states (`human_users::list_by_company`), named for
// what actually happened. NOTHING here may imply a delivery: `invited` means the
// row exists and the link is still sitting with the owner — no mail was sent.
// `pending` means they HAVE signed in before and have no live session now, which
// is why it no longer says "Pending first login".
const STATUS_CHIP: Record<string, { state: ChipState; label: string }> = {
  active: { state: 'done', label: 'Active' },
  pending: { state: 'idle', label: 'Signed out' },
  invited: { state: 'idle', label: 'Link ready — share it' },
}

export function PersonStep({
  company,
  liveUrl,
  quick,
}: {
  company: WizardCompany
  liveUrl: string
  quick: boolean
}) {
  const { humans } = useCompanyHumans(company.id)
  const invite = useInviteHuman(company.id)
  const remove = useRemoveHuman(company.id)
  const [drafts, setDrafts] = React.useState<Draft[]>([{ email: '', role: 'member' }])
  // On the quick-tunnel path each invite returns a personal magic link; keep them
  // keyed by the created human id so a per-person "Copy invite link" can surface.
  const [links, setLinks] = React.useState<Record<number, string>>({})

  const setDraft = (i: number, patch: Partial<Draft>) =>
    setDrafts((d) => d.map((row, j) => (j === i ? { ...row, ...patch } : row)))
  const addRow = () => setDrafts((d) => [...d, { email: '', role: 'member' }])
  const removeRow = (i: number) => setDrafts((d) => (d.length === 1 ? d : d.filter((_, j) => j !== i)))

  const validDrafts = drafts.filter((d) => /.+@.+\..+/.test(d.email.trim()))

  const sendAll = async () => {
    for (const d of validDrafts) {
      try {
        const res = await invite.mutateAsync({ email: d.email.trim(), role: d.role })
        if (res?.login_url && res.user?.id != null) {
          setLinks((m) => ({ ...m, [res.user.id]: res.login_url }))
        }
      } catch {
        /* surfaced below */
      }
    }
    setDrafts([{ email: '', role: 'member' }])
  }

  return (
    <div className="flex flex-col gap-4">
      {quick ? (
        <p className="text-sm text-muted-foreground">
          Add colleagues by email, then send each one their personal link — they click it to join, no
          sign-in needed.{' '}
          <span className="text-foreground">
            Anyone with a link can join as that person until it expires or you remove them.
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Add colleagues by email. Adding the email IS the invitation — the first Google login at{' '}
          <span className="font-mono text-foreground">{liveUrl}</span> creates their account.
        </p>
      )}
      {/* Said BEFORE anyone is added, because the field + button look exactly like
          a mailer and there is none: adding a person sends nothing at all. */}
      <p data-vr="no-mailer" className="text-sm font-medium text-foreground">
        {shareItYourselfLine(quick)}
      </p>

      <div className="flex flex-col gap-3">
        {drafts.map((d, i) => (
          <div key={i} className="cs-card flex flex-col gap-2.5 rounded-xl border border-border p-3">
            <div className="flex items-center gap-2">
              <Input
                type="email"
                inputMode="email"
                value={d.email}
                onChange={(e) => setDraft(i, { email: e.target.value })}
                placeholder="colleague@company.com"
                autoComplete="off"
                className="flex-1"
              />
              {drafts.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  aria-label="Remove row"
                  className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
            <RoleSelect
              value={d.role}
              onChange={(role) => setDraft(i, { role })}
              company={company.display_name}
            />
          </div>
        ))}
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={addRow}>
            <Plus className="size-4" /> Add another
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={sendAll}
            disabled={validDrafts.length === 0 || invite.isPending}
            style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
          >
            {invite.isPending ? 'Adding…' : `Add ${validDrafts.length || ''}`.trim()}
          </Button>
        </div>
        {invite.isError && <p className="text-sm text-destructive">{errText(invite.error)}</p>}
      </div>

      {/* Roster */}
      <div className="flex flex-col gap-2">
        <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
          People in {company.display_name}
        </p>
        {humans.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No colleagues yet — invite the first person to {company.display_name}.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {humans.map((h) => {
              const chip = STATUS_CHIP[h.status] ?? STATUS_CHIP.invited
              // What there is to share, per path. Quick-tunnel: the personal magic
              // link, which the server mints once — we only hold the ones minted in
              // this session. Permanent: the company's sign-in address, which is the
              // same for everyone and always known.
              const link = quick ? links[h.id] : liveUrl
              const share = neverSignedIn(h.status) && link ? link : null
              return (
                <li
                  key={h.id}
                  className="cs-card flex flex-col gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-foreground">{h.email}</span>
                      <span className="text-[12px] capitalize text-muted-foreground">{h.role}</span>
                    </span>
                    <StatusChip state={chip.state} label={chip.label} className="shrink-0" />
                    <button
                      type="button"
                      onClick={() => remove.mutate(h.id)}
                      aria-label={`Remove ${h.email}`}
                      className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                  {/* The delivery mechanism, since there is no mailer: the link
                      itself, and the owner's own mail client, prefilled. */}
                  {share ? (
                    <div data-vr="share-link" className="flex flex-col gap-1.5">
                      <span className="text-[11.5px] text-muted-foreground">
                        {shareLinkLabel(quick, h.email)}
                      </span>
                      <CopyField value={share} label={`Copy the link for ${h.email}`} />
                      <Button asChild variant="outline" size="sm" className="self-start">
                        <a
                          data-vr="email-the-link"
                          href={
                            inviteMailto({
                              email: h.email,
                              company: company.display_name,
                              loginUrl: share,
                              quick,
                            }).href
                          }
                        >
                          <Mail className="size-4" /> Email the link
                        </a>
                      </Button>
                    </div>
                  ) : quick && neverSignedIn(h.status) ? (
                    <p className="text-[11.5px] text-muted-foreground">
                      Their personal link was shown once, when you added them — remove and re-add{' '}
                      {h.email} to mint a new one.
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── Step 3b — Agent email (Cloudflare agent-inbox) ────────────────────────────

/** The optional "give this company's bots their own email" step (design §3). Mints
 *  `<local>@<domain>` via Cloudflare Email Routing forwarding to a mailbox the bot
 *  reads. Honest about the ONE manual step: Cloudflare emails the destination a
 *  verify link the owner must click before mail forwards. Mobile-first + DRY
 *  (reuses the wizard chrome, `StatusChip`, `CopyField`, `Button`/`Input`). */
function AgentInboxStep({
  status,
  companyId,
  baseDomain,
  refetch,
}: {
  status?: ExternalStatus
  companyId: number
  baseDomain: string | null
  refetch: () => void
}) {
  const inbox = status?.company?.agent_inbox ?? null
  const provision = useAgentInbox(companyId)
  const remove = useDeleteAgentInbox(companyId)

  const [localPart, setLocalPart] = React.useState('agent')
  const [destination, setDestination] = React.useState('')
  const domain = baseDomain ?? '<your-domain>'
  const preview = `${(localPart.trim() || 'agent').toLowerCase()}@${domain}`
  const destValid = /.+@.+\..+/.test(destination.trim())

  // Already provisioned + verified → the live "bots have their own email" state.
  if (inbox && inbox.verified) {
    return (
      <div data-vr="agent-inbox" className="flex flex-col gap-4">
        <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <StatusChip state="done" label="Agent email — live" />
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted-foreground">This company’s bots receive mail at</span>
            <CopyField value={inbox.address} label="Copy the agent address" />
          </div>
          <p className="text-[12.5px] leading-snug text-muted-foreground">
            Mail to <span className="font-mono text-foreground">{inbox.address}</span> forwards to{' '}
            <span className="font-mono text-foreground">{inbox.destination}</span>. A bot granted the
            mail connector reads only its own messages.
          </p>
          {remove.isError && <p className="text-sm text-destructive">{errText(remove.error)}</p>}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => remove.mutate(undefined, { onSuccess: () => refetch() })}
            disabled={remove.isPending}
          >
            {remove.isPending ? 'Removing…' : 'Remove agent email'}
          </Button>
        </div>
      </div>
    )
  }

  // Provisioned but the destination still needs its one verification click.
  if (inbox && !inbox.verified) {
    return (
      <div data-vr="agent-inbox" className="flex flex-col gap-4">
        <div
          className="flex flex-col gap-3 rounded-2xl border p-4"
          style={{
            borderColor: 'color-mix(in oklab, var(--gr-work) 40%, var(--gr-line))',
            background: 'color-mix(in oklab, var(--gr-work) 7%, transparent)',
          }}
        >
          <StatusChip state="working" label="One step left — verify the destination" className="self-start" />
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted-foreground">The bot’s address</span>
            <CopyField value={inbox.address} label="Copy the agent address" />
          </div>
          <div
            className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-[12.5px] leading-snug"
            style={{ background: 'color-mix(in oklab, var(--gr-work) 12%, transparent)', color: 'var(--foreground)' }}
          >
            <Mail aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: 'var(--gr-work)' }} />
            <span>
              Cloudflare emailed <span className="font-mono text-foreground">{inbox.destination}</span> a
              verification link. Open that inbox and click it, then press{' '}
              <span className="font-medium">Check again</span> — mail only forwards once it’s verified.
            </span>
          </div>
          {provision.isError && <p className="text-sm text-destructive">{errText(provision.error)}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() =>
                provision.mutate(
                  { localPart: inbox.address.split('@')[0], destinationEmail: inbox.destination },
                  { onSuccess: () => refetch() },
                )
              }
              disabled={provision.isPending}
              style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
            >
              {provision.isPending ? 'Checking…' : 'Check again'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => remove.mutate(undefined, { onSuccess: () => refetch() })}
              disabled={remove.isPending}
            >
              {remove.isPending ? 'Removing…' : 'Remove'}
            </Button>
          </div>
        </div>
        <p className="text-[12px] text-muted-foreground">
          Optional — you can skip this and add it later. Continue when you’re done.
        </p>
      </div>
    )
  }

  // Not provisioned yet → the form.
  return (
    <div data-vr="agent-inbox" className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <span
          className="grid size-9 shrink-0 place-items-center rounded-xl"
          style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
        >
          <Mail aria-hidden className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-[15px] font-semibold text-foreground">Give this company’s bots their own email</p>
          <p className="text-[12.5px] leading-snug text-muted-foreground">
            A dedicated address on your domain — mail forwards to a mailbox you’ve connected, and a bot
            granted the mail connector reads only its own messages. Optional.
          </p>
        </div>
      </div>

      <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ai-local" className="text-sm font-medium text-foreground">
            Address
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="ai-local"
              value={localPart}
              onChange={(e) => setLocalPart(e.target.value)}
              placeholder="agent"
              autoComplete="off"
              className="w-32 font-mono"
              aria-label="Local part"
            />
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-muted-foreground">@{domain}</span>
          </div>
          <p className="text-[12px] text-muted-foreground">
            Preview: <span className="font-mono text-foreground">{preview}</span>
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="ai-dest" className="text-sm font-medium text-foreground">
            Forward to a connected mailbox
          </label>
          <Input
            id="ai-dest"
            type="email"
            inputMode="email"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="you@example.com"
            autoComplete="off"
            className="font-mono"
            aria-invalid={destination.length > 0 && !destValid ? true : undefined}
          />
          <p className="text-[12px] text-muted-foreground">
            Use the address of a mailbox you already connected (iCloud, Gmail, Outlook…). Cloudflare
            emails it a one-time verification link.
          </p>
        </div>

        {provision.isError && <p className="text-sm text-destructive">{errText(provision.error)}</p>}

        <Button
          type="button"
          onClick={() =>
            provision.mutate(
              { localPart: localPart.trim() || 'agent', destinationEmail: destination.trim() },
              { onSuccess: () => refetch() },
            )
          }
          disabled={!destValid || provision.isPending}
          className="self-start"
          style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
        >
          {provision.isPending ? 'Setting up…' : 'Create agent email'}
        </Button>
      </div>

      <p className="px-1 text-[12px] leading-snug text-muted-foreground">
        Needs your Cloudflare token to include <span className="font-mono">Email Routing Rules: Edit</span>.
        You can skip this step and add it later.
      </p>
    </div>
  )
}

// ── Step 4 — Success ──────────────────────────────────────────────────────────

function SuccessStep({
  company,
  liveUrl,
  quick,
  onInviteAnother,
}: {
  company: WizardCompany
  liveUrl: string
  quick: boolean
  onInviteAnother: () => void
}) {
  const [copied, copy] = useCopy()
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <span
        className="grid size-16 place-items-center rounded-full"
        style={{ background: 'color-mix(in oklab, var(--gr-done) 16%, transparent)', color: 'var(--gr-done)' }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="size-8">
          <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold text-foreground">{company.display_name} is ready</h3>
        <p className="text-sm text-muted-foreground">
          {quick ? 'Your colleagues can join with their link now.' : 'Your colleagues can sign in now.'}
        </p>
      </div>

      <a
        href={liveUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 font-mono text-sm underline"
        style={{ color: 'var(--sm-accent)' }}
      >
        {liveUrl} <ExternalLink className="size-3.5" />
      </a>

      {quick && (
        <p
          className="flex items-start gap-1.5 rounded-xl px-3 py-2 text-left text-[12px] leading-snug"
          style={{ background: 'color-mix(in oklab, var(--gr-work) 12%, transparent)', color: 'var(--foreground)' }}
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" style={{ color: 'var(--gr-work)' }} />
          Temporary link — it changes when supermux restarts. Connect your own domain for a permanent
          address.
        </p>
      )}

      <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
        <Button type="button" variant="outline" onClick={() => copy(liveUrl)}>
          {copied ? 'Copied ✓' : 'Copy link'}
        </Button>
        <Button type="button" variant="ghost" onClick={onInviteAnother}>
          <Plus className="size-4" /> Invite another
        </Button>
      </div>

      <p className="text-[12px] text-muted-foreground">
        {quick
          ? 'What’s next: send each colleague their personal invite link — they click it to join, no sign-in.'
          : 'What’s next: send them the link, then they open it and sign in with Google.'}
      </p>
    </div>
  )
}

export default InviteWizardSheet
