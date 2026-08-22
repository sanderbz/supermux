/**
 * `<InviteWizardSheet>` — the guided, resumable onboarding wizard an owner opens
 * from "Invite to <company>". It gives non-expert self-hosters external access to
 * `https://<slug>.s.iwd.nl` (Cloudflare tunnel + Google login) and seeds
 * colleague `human_users`, entirely in-app with live verification at every step.
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
import { ArrowLeft, ArrowRight, ExternalLink, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { CompanyMark } from '@/components/roster/company-mark'
import { SessionError } from '@/lib/api'
import {
  useCfToken,
  useCompanyHost,
  useCompanyHumans,
  useExternalStatus,
  useGoogleConfig,
  useInviteHuman,
  useProvisionTunnel,
  useRemoveHuman,
  useVerifyLogin,
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
import type { ExternalStatus } from '@/lib/api'

/** The minimal company identity the wizard needs. */
export interface WizardCompany {
  id: number
  slug: string
  display_name: string
}

type StepKey = 'domain' | 'google' | 'person' | 'success'
const ORDER: StepKey[] = ['domain', 'google', 'person', 'success']

function errText(e: unknown): string {
  if (e instanceof SessionError) {
    if (e.status === 0) return 'Can’t reach supermux-server. Check it’s running, then try again.'
    return e.message
  }
  return e instanceof Error ? e.message : 'Something went wrong — try again.'
}

// Derived completion from the live status. Domain is done once the tunnel is
// healthy; Google is done once THIS company's redirect verifies green.
function domainDone(s?: ExternalStatus) {
  return s?.box_status.tunnel === 'healthy'
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

  // Derived host/redirect: prefer the server's computed values, else derive the
  // canonical shape locally so the panels can render before status lands.
  const host = status?.company?.host ?? `${company.slug}.s.iwd.nl`
  const redirectUri = status?.company?.redirect_uri ?? `https://${host}/auth/callback`
  const liveUrl = `https://${host}`

  // The active panel. Initialised ONCE from status to the first unfinished step
  // (resumable), then user-driven via Back/Continue.
  const [step, setStep] = React.useState<StepKey>('domain')
  const routed = React.useRef(false)
  React.useEffect(() => {
    if (!open) {
      routed.current = false
      return
    }
    if (routed.current || !status) return
    routed.current = true
    if (!domainDone(status)) setStep('domain')
    else if (!googleDone(status)) setStep('google')
    else setStep('person')
  }, [open, status])

  const idx = ORDER.indexOf(step)

  // Per-step chips for the rail — derived from live status.
  const steps: StepMeta[] = [
    {
      key: 'domain',
      title: 'Domain',
      chip: chipFor(
        domainDone(status),
        status?.box_status.tunnel === 'connecting',
        status?.box_status.tunnel === 'healthy' ? 'Connected' : status?.box_status.tunnel === 'connecting' ? 'Connecting…' : 'Not set up',
      ),
    },
    {
      key: 'google',
      title: 'Google login',
      chip: chipFor(googleDone(status), false, googleDone(status) ? 'Verified' : status?.box_status.google === 'configured' ? 'One URL to add' : 'Not set up'),
    },
    { key: 'person', title: 'Add people', chip: { state: 'idle', label: 'Invite' } },
    { key: 'success', title: 'Done', chip: { state: 'idle', label: '' } },
  ]

  const canContinue =
    step === 'domain' ? domainDone(status) : step === 'google' ? googleDone(status) : step === 'person' ? true : false

  const goBack = () => idx > 0 && setStep(ORDER[idx - 1])
  const goNext = () => idx < ORDER.length - 1 && setStep(ORDER[idx + 1])

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      className="sm:max-w-lg"
      title={
        <span className="flex items-center gap-2.5">
          <CompanyMark slug={company.slug} name={company.display_name} size={24} className="grok-identity" />
          <span className="truncate">Invite to {company.display_name}</span>
        </span>
      }
      description={step === 'success' ? 'All set.' : `Step ${idx + 1} of 3`}
      footer={
        step === 'success' ? (
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
              {step === 'person' ? 'Finish' : 'Continue'} <ArrowRight className="size-4" />
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        {/* The rail — collapses to one line on a phone via responsive class. */}
        {step !== 'success' && (
          <div className="cs-card rounded-xl border border-border p-3">
            <WizardStepper steps={steps.slice(0, 3)} current={Math.min(idx, 2)} />
          </div>
        )}

        {isLoading && !status ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Checking access…</p>
        ) : step === 'domain' ? (
          <DomainStep status={status} host={host} companyId={company.id} onDone={goNext} refetch={refetch} />
        ) : step === 'google' ? (
          <GoogleStep status={status} redirectUri={redirectUri} liveUrl={liveUrl} companyId={company.id} refetch={refetch} />
        ) : step === 'person' ? (
          <PersonStep company={company} liveUrl={liveUrl} />
        ) : (
          <SuccessStep company={company} liveUrl={liveUrl} onInviteAnother={() => setStep('person')} />
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

// ── Step 1 — Domain / external access ─────────────────────────────────────────

const CF_SCOPES = 'Account · Cloudflare Tunnel: Edit\nZone · DNS: Edit\nZone · Zone: Read'

function DomainStep({
  status,
  host,
  companyId,
  onDone,
  refetch,
}: {
  status?: ExternalStatus
  host: string
  companyId: number
  onDone: () => void
  refetch: () => void
}) {
  const [token, setToken] = React.useState('')
  const cf = useCfToken(companyId)
  const provision = useProvisionTunnel(companyId)

  const cfValid = status?.box_status.cf_token === 'valid'
  const tunnel = status?.box_status.tunnel ?? 'none'
  const done = tunnel === 'healthy'

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

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Give your colleagues a web address to reach this supermux —{' '}
        <span className="font-mono text-foreground">{host}</span>.
      </p>

      {/* 1a — the Cloudflare token */}
      {!cfValid ? (
        <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <label htmlFor="cf-token" className="text-sm font-medium text-foreground">
            Cloudflare API token
          </label>
          <p className="text-[12.5px] leading-snug text-muted-foreground">
            Create a token scoped to the <span className="font-mono">s.iwd.nl</span> zone with these
            permissions, then paste it here. Cloudflare shows the token once — copy it before you
            close that page.
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
      ) : (
        <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <StatusChip state="done" label="Token valid · account & zone found" />

          {/* 1b — provision the tunnel */}
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
      )}
      {done && (
        <Button type="button" onClick={onDone} className="self-end">
          Continue
        </Button>
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

function PersonStep({ company, liveUrl }: { company: WizardCompany; liveUrl: string }) {
  const { humans } = useCompanyHumans(company.id)
  const invite = useInviteHuman(company.id)
  const remove = useRemoveHuman(company.id)
  const [drafts, setDrafts] = React.useState<Draft[]>([{ email: '', role: 'member' }])

  const setDraft = (i: number, patch: Partial<Draft>) =>
    setDrafts((d) => d.map((row, j) => (j === i ? { ...row, ...patch } : row)))
  const addRow = () => setDrafts((d) => [...d, { email: '', role: 'member' }])
  const removeRow = (i: number) => setDrafts((d) => (d.length === 1 ? d : d.filter((_, j) => j !== i)))

  const validDrafts = drafts.filter((d) => /.+@.+\..+/.test(d.email.trim()))

  const sendAll = async () => {
    for (const d of validDrafts) {
      try {
        await invite.mutateAsync({ email: d.email.trim(), role: d.role })
      } catch {
        /* surfaced below */
      }
    }
    setDrafts([{ email: '', role: 'member' }])
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Add colleagues by email. Adding the email IS the invitation — the first Google login at{' '}
        <span className="font-mono text-foreground">{liveUrl}</span> creates their account.
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
                  className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
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
              return (
                <li
                  key={h.id}
                  className="cs-card flex items-center gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-foreground">{h.email}</span>
                    <span className="text-[12px] capitalize text-muted-foreground">{h.role}</span>
                  </span>
                  <StatusChip state={chip.state} label={chip.label} className="shrink-0" />
                  <button
                    type="button"
                    onClick={() => remove.mutate(h.id)}
                    aria-label={`Remove ${h.email}`}
                    className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── Step 4 — Success ──────────────────────────────────────────────────────────

function SuccessStep({
  company,
  liveUrl,
  onInviteAnother,
}: {
  company: WizardCompany
  liveUrl: string
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
        <p className="text-sm text-muted-foreground">Your colleagues can sign in now.</p>
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

      <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
        <Button type="button" variant="outline" onClick={() => copy(liveUrl)}>
          {copied ? 'Copied ✓' : 'Copy invite link'}
        </Button>
        <Button type="button" variant="ghost" onClick={onInviteAnother}>
          <Plus className="size-4" /> Invite another
        </Button>
      </div>

      <p className="text-[12px] text-muted-foreground">
        What’s next: send them the link, then they open it and sign in with Google.
      </p>
    </div>
  )
}

export default InviteWizardSheet
