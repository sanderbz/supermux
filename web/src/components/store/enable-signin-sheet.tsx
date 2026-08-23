/**
 * `<EnableSigninSheet>` — the guided, do-once "Enable Sign-in with GitHub" wizard.
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the ENABLER behind Lane A: without a registered `(provider, company)`
 * OAuth app the server never flips a card to `oauth_device`, so "Sign in with
 * GitHub" never appears. Registering the app is a ONE-TIME setup per box (or per
 * company), reused forever — and the whole point of P2b is that a non-technical
 * self-hoster can do it with Claude walking them through it, no CLI, no restart.
 *
 * GROK-NATIVE + MOBILE-FIRST + DRY. The shell is the canonical `<ResponsiveSheet>`
 * (Vaul bottom-sheet on touch · side sheet on desktop) exactly like
 * `invite-wizard-sheet.tsx`, and every atom is REUSED from `wizard-primitives`
 * (`WizardStepper`, `CopyField`, `SecretInput`, `StatusChip`). The only new thing
 * is the step assembly + the GitHub copy. The data plane is `use-oauth-apps`.
 *
 * SECRET HYGIENE: the `client_secret` is only ever SENT (registerOauthApp). It is
 * never echoed — the response is masked. The SecretInput masks it in the field.
 *
 * The pre-registration guidance (what to click, the scopes, "device flow needs no
 * callback") is authored client-side here so the wizard renders with no server
 * round-trip (and the offline dev bench can screenshot it). The server returns the
 * SAME guidance on register, single-sourced from `oauth.rs::guidance`.
 */
import * as React from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, KeyRound } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import {
  CopyField,
  SecretInput,
  StatusChip,
  WizardStepper,
  type ChipState,
  type StepMeta,
} from '@/components/companies/wizard-primitives'
import { useRegisterOauthApp, oauthErrorStatus } from '@/hooks/use-oauth-apps'
import type { OauthProvider } from '@/lib/api/oauth'
import { ApiError } from '@/lib/api/client'

/** GitHub's device-flow app copy — authored here so the wizard renders offline. */
const GITHUB = {
  /** The DIRECT "new OAuth App" form (one fewer click than /settings/developers). */
  createUrl: 'https://github.com/settings/applications/new',
  scopes: ['repo', 'read:org'],
  deviceNote:
    'Register an OAuth App (NOT a GitHub App). After you create it, open the app page and tick “Enable Device Flow”.',
}

type StepKey = 'why' | 'create' | 'paste' | 'done'
const ORDER: StepKey[] = ['why', 'create', 'paste', 'done']

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return 'Can’t reach the server. Check it’s running, then try again.'
    return e.message
  }
  return e instanceof Error ? e.message : 'Something went wrong — try again.'
}

export function EnableSigninSheet({
  open,
  onOpenChange,
  provider,
  companyId,
  companyName,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  provider: OauthProvider
  /** `null` = a box-wide (global) app reused by every bot. */
  companyId: number | null
  companyName: string | null
}) {
  // Fresh state each OPEN comes from a remount: the caller passes a `key` that
  // changes when it opens the sheet, so `useState` re-initialises to step 'why'
  // and a clean mutation — no reset effect (and no synchronous setState-in-effect).
  const register = useRegisterOauthApp()
  const [step, setStep] = React.useState<StepKey>('why')
  const [clientId, setClientId] = React.useState('')
  const [secret, setSecret] = React.useState('')

  const scopeCtx = companyName ?? 'my box'
  const appName = `supermux (${scopeCtx})`
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-box.example'

  const idx = ORDER.indexOf(step)
  const goBack = () => idx > 0 && setStep(ORDER[idx - 1])
  const goNext = () => idx < ORDER.length - 1 && setStep(ORDER[idx + 1])

  const canRegister = clientId.trim().length > 0 && secret.trim().length > 0

  const pasteChip: { state: ChipState; label: string } = register.isPending
    ? { state: 'working', label: 'Enabling…' }
    : register.isError
      ? { state: 'error', label: 'Failed' }
      : register.isSuccess
        ? { state: 'done', label: 'Enabled' }
        : { state: 'idle', label: 'Paste 2 values' }

  const steps: StepMeta[] = [
    { key: 'why', title: 'What this does', chip: { state: idx > 0 ? 'done' : 'idle', label: idx > 0 ? 'Read' : '1 min' } },
    { key: 'create', title: 'Create the app', chip: { state: idx > 1 ? 'done' : 'idle', label: idx > 1 ? 'Created' : 'On GitHub' } },
    { key: 'paste', title: 'Turn it on', chip: pasteChip },
  ]

  const doRegister = async () => {
    try {
      await register.mutateAsync({
        provider,
        company_id: companyId,
        client_id: clientId.trim(),
        client_secret: secret,
      })
      setSecret('')
      setStep('done')
    } catch {
      /* surfaced via register.error below */
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      className="sm:max-w-lg"
      title={
        <span className="flex items-center gap-2.5">
          <KeyRound className="size-5 shrink-0" aria-hidden />
          <span className="truncate">Enable Sign-in with GitHub</span>
        </span>
      }
      description={
        step === 'done'
          ? 'One-tap sign-in is on.'
          : companyName
            ? `One-time setup for ${companyName}`
            : 'One-time setup for this box'
      }
      footer={
        // `data-grok` so the portalled footer resolves the Grok accent tokens
        // (defined only under `[data-grok]`, which the body-portal escapes).
        <div data-grok>
          {step === 'done' ? (
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
              {step === 'paste' ? (
                <Button
                  type="button"
                  onClick={doRegister}
                  disabled={!canRegister || register.isPending}
                  style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
                >
                  {register.isPending ? 'Enabling…' : 'Turn on sign-in'}
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={goNext}
                  style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
                >
                  Continue <ArrowRight className="size-4" />
                </Button>
              )}
            </div>
          )}
        </div>
      }
    >
      {/* `data-grok` so the body-portalled content resolves the Grok accent tokens
          (defined only under `[data-grok]`) — CTAs/chips render filled. */}
      <div data-grok className="flex flex-col gap-4 px-5 py-4">
        {step !== 'done' && (
          <div className="cs-card rounded-xl border border-border p-3">
            <WizardStepper steps={steps} current={Math.min(idx, 2)} />
          </div>
        )}

        {step === 'why' ? (
          <WhyStep scopeCtx={scopeCtx} boxWide={companyId == null} companyName={companyName} />
        ) : step === 'create' ? (
          <CreateStep appName={appName} origin={origin} />
        ) : step === 'paste' ? (
          <PasteStep
            clientId={clientId}
            secret={secret}
            onClientId={setClientId}
            onSecret={setSecret}
            error={register.isError ? errText(register.error) : null}
            memberBlocked={oauthErrorStatus(register.error) === 404 || oauthErrorStatus(register.error) === 403}
          />
        ) : (
          <DoneStep companyName={companyName} onClose={() => onOpenChange(false)} />
        )}
      </div>
    </ResponsiveSheet>
  )
}

// ── Step 1 — why ──────────────────────────────────────────────────────────────

function WhyStep({
  scopeCtx,
  boxWide,
  companyName,
}: {
  scopeCtx: string
  boxWide: boolean
  companyName: string | null
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed text-muted-foreground">
        This is a <span className="font-medium text-foreground">one-time setup</span>. Once you
        enable Sign-in with GitHub{companyName ? ` for ${companyName}` : ''}, every bot
        {boxWide ? ' on this box' : ` in ${scopeCtx}`} can sign in with a short code — no tokens to
        paste, ever. You only do this once.
      </p>
      <div className="cs-card flex flex-col gap-2 rounded-xl border border-border p-4">
        <p className="text-[13px] font-medium text-foreground">How it works after this</p>
        <ol className="ml-4 list-decimal space-y-1 text-[12.5px] leading-snug text-muted-foreground">
          <li>A bot needs GitHub → it shows “Sign in with GitHub”.</li>
          <li>You get a short code and a link — enter it, approve, done.</li>
          <li>No personal access tokens, no keys to copy around.</li>
        </ol>
      </div>
      <p className="text-[12px] leading-snug text-muted-foreground">
        Google connectors are different — most sign in straight from your bot’s terminal, so they
        need no setup here.
      </p>
    </div>
  )
}

// ── Step 2 — create the app on GitHub ─────────────────────────────────────────

function CreateStep({ appName, origin }: { appName: string; origin: string }) {
  return (
    <div className="flex flex-col gap-3">
      <a
        href={GITHUB.createUrl}
        target="_blank"
        rel="noreferrer noopener"
        data-vr="enable-signin-open-github"
        className="inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-semibold text-primary-foreground shadow-sm transition-colors"
        style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}
      >
        Open GitHub → New OAuth App
        <ExternalLink className="size-4" aria-hidden />
      </a>

      <div className="cs-card flex flex-col gap-2 rounded-xl border border-border p-4">
        <p className="text-[13px] font-medium text-foreground">On that page</p>
        <p className="text-[12.5px] leading-snug text-muted-foreground">{GITHUB.deviceNote}</p>
      </div>

      <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <p className="text-[13px] font-medium text-foreground">Suggested values (copy these in)</p>
        <Field label="Application name">
          <CopyField value={appName} label="Copy the application name" />
        </Field>
        <Field label="Homepage URL">
          <CopyField value={origin} label="Copy the homepage URL" />
        </Field>
        <Field
          label="Authorization callback URL"
          hint="Required by the form but UNUSED by device flow — any https URL works. Paste your box’s address."
        >
          <CopyField value={origin} label="Copy the callback URL" />
        </Field>
      </div>

      <div className="cs-card flex flex-col gap-1.5 rounded-xl border border-border p-4">
        <p className="text-[13px] font-medium text-foreground">Recommended scopes</p>
        <div className="flex flex-wrap gap-1.5">
          {GITHUB.scopes.map((s) => (
            <span
              key={s}
              className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2.5 py-1 font-mono text-[12px] text-foreground"
            >
              {s}
            </span>
          ))}
        </div>
        <p className="text-[12px] leading-snug text-muted-foreground">
          Least-privilege for reading repos and orgs. You can change them on GitHub later.
        </p>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] leading-snug text-muted-foreground">{hint}</span>}
    </div>
  )
}

// ── Step 3 — paste the two values ─────────────────────────────────────────────

function PasteStep({
  clientId,
  secret,
  onClientId,
  onSecret,
  error,
  memberBlocked,
}: {
  clientId: string
  secret: string
  onClientId: (v: string) => void
  onSecret: (v: string) => void
  error: string | null
  memberBlocked: boolean
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Back on GitHub, copy the two values from your new app and paste them here. The secret is
        stored on your box and never shown to your bots.
      </p>
      <div className="cs-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="gh-client-id" className="text-sm font-medium text-foreground">
            Client ID
          </label>
          <Input
            id="gh-client-id"
            value={clientId}
            onChange={(e) => onClientId(e.target.value)}
            placeholder="Iv1.abc123…"
            autoComplete="off"
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="gh-secret" className="text-sm font-medium text-foreground">
            Client Secret
          </label>
          <SecretInput id="gh-secret" value={secret} onChange={onSecret} placeholder="Paste the client secret" />
        </div>
      </div>
      {error && (
        <p className="text-sm text-destructive">
          {memberBlocked ? 'Only an owner or admin can enable sign-in for this box.' : error}
        </p>
      )}
      <StatusChip
        state="idle"
        label="Nothing is shared with GitHub yet — this just stores your app on the box."
        className="self-start"
      />
    </div>
  )
}

// ── Step 4 — done ─────────────────────────────────────────────────────────────

function DoneStep({ companyName, onClose }: { companyName: string | null; onClose: () => void }) {
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
        <h3 className="text-lg font-semibold text-foreground">Sign-in with GitHub is on</h3>
        <p className="text-sm text-muted-foreground">
          Any bot{companyName ? ` in ${companyName}` : ' on this box'} can now connect GitHub with a
          code — the card now shows “Sign in with GitHub”.
        </p>
      </div>
      <Button type="button" onClick={onClose} style={{ background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }}>
        Connect GitHub now
      </Button>
    </div>
  )
}

export default EnableSigninSheet
