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
 * (`wizard-primitives.tsx`). The data plane is the `use-external-access` hooks.
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
import { SessionError } from '@/lib/api'
import {
  useAgentInbox,
  useCfToken,
  useCompanyHost,
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

/** The minimal company identity the wizard needs. */
export interface WizardCompany {
  id: number
  slug: string
  display_name: string
}

type StepKey = 'domain' | 'google' | 'person' | 'inbox' | 'success'
// The full (permanent-domain) order. `inbox` (the optional Cloudflare agent-inbox)
// sits after people — it needs the connected domain. The quick-tunnel branch omits
// both Google and the inbox (a trycloudflare host has no zone to route mail on),
// collapsing to Domain → Add people → Done.
const ORDER: StepKey[] = ['domain', 'google', 'person', 'inbox', 'success']
const QUICK_ORDER: StepKey[] = ['domain', 'person', 'success']

function errText(e: unknown): string {
  if (e instanceof SessionError) {
    if (e.status === 0) return 'Can’t reach supermux-server. Check it’s running, then try again.'
    return e.message
  }
  return e instanceof Error ? e.message : 'Something went wrong — try again.'
}

// Derived completion from the live status. Domain is done once the tunnel is
// healthy OR a temporary quick tunnel is live; Google is done once THIS company's
// redirect verifies green.
function quickActive(s?: ExternalStatus): boolean {
  return !!s?.box_status.quick_tunnel?.active
}
function domainDone(s?: ExternalStatus) {
  return s?.box_status.tunnel === 'healthy' || quickActive(s)
}
function googleDone(s?: ExternalStatus) {
  return s?.box_status.google === 'configured' && s?.company?.redirect_registered === 'ok'
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
  const { status, isLoading, refetch } = useExternalStatus(company.id, { enabled: open })

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
  if (!open && routedOpen) setRoutedOpen(false)
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
          chip: chipFor(googleDone(status), false, googleDone(status) ? 'Verified' : status?.box_status.google === 'configured' ? 'One URL to add' : 'Not set up'),
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
        ? googleDone(status)
        : step === 'person' || step === 'inbox'
          ? true
          : false
  // The last input step before "success" shows "Finish".
  const isLastInputStep = idx === order.length - 2

  const goBack = () => idx > 0 && setStep(order[idx - 1])
  const goNext = () => idx < order.length - 1 && setStep(order[idx + 1])

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      className="sm:max-w-lg"
      title={
        <span className="flex items-center gap-2.5">
          <CompanyMark slug={company.slug} name={company.display_name} size={24} className="grok-identity" />
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

        {isLoading && !status ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Checking access…</p>
        ) : step === 'domain' ? (
          <DomainStep status={status} host={host} company={company} refetch={refetch} />
        ) : step === 'google' ? (
          <GoogleStep status={status} redirectUri={redirectUri} liveUrl={liveUrl} companyId={company.id} refetch={refetch} />
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

const CF_SCOPES =
  'Account · Cloudflare Tunnel: Edit\nZone · DNS: Edit\nZone · Zone: Read\nZone · Email Routing Rules: Edit'

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
  const tunnel = status?.box_status.tunnel ?? 'none'
  const done = tunnel === 'healthy'

  // A temporary link is live → the ephemeral panel (upgrade / stop from here).
  if (qt?.active) {
    return (
      <QuickTunnelPanel
        qt={qt}
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
        error={startQuick.isError ? errText(startQuick.error) : null}
        onQuick={() => startQuick.mutate(undefined, { onSuccess: () => refetch() })}
        onDomain={() => setPath('domain')}
      />
    )
  }

  if (done) {
    return (
      <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <StatusChip state="done" label={`Connected · reachable at ${host}`} />
        <p className="text-sm text-muted-foreground">
          Your box has a public web address. Continue to set up Google login.
        </p>
      </div>
    )
  }

  // Sub-step 1a — no token yet.
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
          Give your colleagues a web address to reach this supermux. First connect the Cloudflare
          account that manages your domain.
        </p>
        <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <label htmlFor="cf-token" className="text-sm font-medium text-foreground">
            Cloudflare API token
          </label>
          <p className="text-[12.5px] leading-snug text-muted-foreground">
            Create a token scoped to the zone for your domain with these permissions, then paste it
            here. Cloudflare shows the token once — copy it before you close that page.
          </p>
          <CopyField value={CF_SCOPES.replace(/\n/g, '  ·  ')} label="Copy the required scopes" />
          <SecretInput id="cf-token" value={token} onChange={setToken} placeholder="Paste the token" invalid={cf.isError} />
          {cf.isError && <p className="text-sm text-destructive">{errText(cf.error)}</p>}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] text-muted-foreground">
              dash.cloudflare.com → My Profile → API Tokens
            </span>
            <Button
              type="button"
              size="sm"
              onClick={() => cf.mutate(token)}
              disabled={token.trim().length < 8 || cf.isPending}
            >
              {cf.isPending ? 'Verifying…' : 'Verify token'}
            </Button>
          </div>
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
      <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <StatusChip state="done" label={`Domain set · ${baseDomain}`} />

        {tunnel === 'connecting' || provision.isPending ? (
          <div className="flex flex-col gap-2">
            <StatusChip state="working" label="Connecting… setting up the tunnel" />
            <p className="text-[12.5px] text-muted-foreground">
              This runs the connector on your box and waits for Cloudflare to report it healthy.
            </p>
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={refetch}>
              Check again
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              One click sets up a wildcard tunnel + DNS and starts the connector — no terminal
              commands.
            </p>
            {provision.isError && <p className="text-sm text-destructive">{errText(provision.error)}</p>}
            <Button
              type="button"
              onClick={() => provision.mutate(undefined, { onSuccess: () => refetch() })}
              disabled={provision.isPending}
              className="self-start"
              style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
            >
              Set up access
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
  error,
  onQuick,
  onDomain,
}: {
  starting: boolean
  error: string | null
  onQuick: () => void
  onDomain: () => void
}) {
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
          disabled={starting}
          className="h-11 w-full"
          style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
        >
          {starting ? 'Creating your link…' : 'Create a temporary link'}
        </Button>
        {starting && (
          <StatusChip state="working" label="Starting the tunnel — a few seconds…" className="self-start" />
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

// ── Step 1 (quick tunnel active) — the temporary-link panel ───────────────────

/** The live ephemeral link (design §5.2). Shows the trycloudflare URL prominently
 *  + copyable, a persistent (non-scary) honesty note, and a Stop/upgrade control. */
function QuickTunnelPanel({
  qt,
  stopping,
  error,
  onStop,
}: {
  qt: QuickTunnelStatus
  stopping: boolean
  error: string | null
  onStop: () => void
}) {
  return (
    <div data-vr="qt-success" className="flex flex-col gap-4">
      <div
        className="flex flex-col gap-3 rounded-2xl border p-4"
        style={{
          borderColor: 'color-mix(in oklab, var(--gr-work) 40%, var(--gr-line))',
          background: 'color-mix(in oklab, var(--gr-work) 7%, transparent)',
        }}
      >
        <StatusChip
          state="done"
          label="Temporary link — active"
          className="self-start"
        />
        <div className="flex flex-col gap-1.5">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Clock aria-hidden className="size-3.5" /> Your temporary web address
          </span>
          <CopyField value={qt.url} label="Copy the temporary link" />
        </div>

        <div
          className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-[12.5px] leading-snug"
          style={{ background: 'color-mix(in oklab, var(--gr-work) 12%, transparent)', color: 'var(--foreground)' }}
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: 'var(--gr-work)' }} />
          <span>
            <span className="font-medium">Temporary</span> — this link changes each time supermux
            restarts. Connect your own domain for a permanent address.
          </span>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Continue to add colleagues — each gets their own link to join, no sign-in needed.
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onStop} disabled={stopping}>
          {stopping ? 'Stopping…' : 'Stop / replace link'}
        </Button>
        <span className="text-[12px] text-muted-foreground">
          Stopping lets you connect your own domain for a permanent address.
        </span>
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

  const [selected, setSelected] = React.useState<string | null>(null)
  // Auto-select the sole zone so the common case is one confirm, not a choice.
  // Derived, not synced through an effect: while nothing is explicitly picked,
  // `chosen` already falls back to the first zone.
  const chosen = selected ?? (zones.length >= 1 ? zones[0] : null)
  const preview = chosen ? `${company.slug}.${chosen}` : `${company.slug}.<your-domain>`

  const confirm = () => {
    if (!chosen) return
    setBase.mutate(chosen, { onSuccess: () => refetch() })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">Choose your domain</p>
        <p className="text-sm text-muted-foreground">
          Pick the domain your teammates will use — e.g.{' '}
          <span className="font-mono text-foreground">company.&lt;your-domain&gt;</span>.
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
              Your teammates will reach{' '}
              <span className="font-mono text-foreground">{preview}</span> — use this domain?
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

          <p className="text-[12px] text-muted-foreground">
            Preview: <span className="font-mono text-foreground">{preview}</span>
          </p>

          {setBase.isError && <p className="text-sm text-destructive">{errText(setBase.error)}</p>}

          <Button
            type="button"
            onClick={confirm}
            disabled={!chosen || setBase.isPending}
            className="self-start"
            style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
          >
            {setBase.isPending ? 'Saving…' : 'Use this domain'}
          </Button>
        </div>
      )}
    </div>
  )
}

// ── Step 2 — Google login ─────────────────────────────────────────────────────

function GoogleStep({
  status,
  redirectUri,
  liveUrl,
  companyId,
  refetch,
}: {
  status?: ExternalStatus
  redirectUri: string
  liveUrl: string
  companyId: number
  refetch: () => void
}) {
  const boxConfigured = status?.box_status.google === 'configured'
  const registered = status?.company?.redirect_registered ?? 'unknown'
  const done = boxConfigured && registered === 'ok'

  const [clientId, setClientId] = React.useState('')
  const [secret, setSecret] = React.useState('')
  const google = useGoogleConfig(companyId)
  const host = useCompanyHost(companyId)
  const verify = useVerifyLogin(companyId)

  if (done) {
    return (
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
  const verifyResult = verify.data

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

      {(google.isError || host.isError) && (
        <p className="text-sm text-destructive">{errText(google.error || host.error)}</p>
      )}
      {verifyResult && !verifyResult.ok && (
        <p className="text-sm text-destructive">{verifyResult.detail}</p>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={async () => {
            try {
              if (miniStep) {
                await host.mutateAsync()
              } else {
                await google.mutateAsync({ client_id: clientId.trim(), client_secret: secret })
              }
              await verify.mutateAsync()
            } catch {
              /* surfaced via the mutation error above */
            }
            refetch()
          }}
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
        {verifyResult && !verifyResult.ok && (
          <Button type="button" variant="ghost" onClick={() => verify.mutate(undefined, { onSuccess: () => refetch() })}>
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

const STATUS_CHIP: Record<string, { state: ChipState; label: string }> = {
  active: { state: 'done', label: 'Active' },
  pending: { state: 'working', label: 'Pending first login' },
  invited: { state: 'idle', label: 'Invited' },
}

function PersonStep({
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
            {invite.isPending ? 'Inviting…' : `Invite ${validDrafts.length || ''}`.trim()}
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
              const link = quick ? links[h.id] : undefined
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
                  {link && (
                    <div className="flex flex-col gap-1">
                      <span className="text-[11.5px] text-muted-foreground">
                        Personal invite link — send it to {h.email}
                      </span>
                      <CopyField value={link} label={`Copy invite link for ${h.email}`} />
                    </div>
                  )}
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
