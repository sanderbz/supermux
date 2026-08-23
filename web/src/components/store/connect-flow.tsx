/**
 * <ConnectFlow> — the ONE connect renderer, shared by the store detail and the
 * in-chat Connect card.
 * ─────────────────────────────────────────────────────────────────────────────
 * Before this there were TWO copies of the same flow (the store's bespoke seal
 * block in `connector-detail.tsx` and the chat `ConnectCard`), and they DISAGREED
 * — they guessed OAuth from a brand regex, showed Slack a fake "API key" field,
 * and said "No sign-in needed" for connectors that plainly need one. This is the
 * single source: it reads the connector's real `auth` descriptor and renders the
 * RIGHT lane, collects the fields, seals via the caller's `onSubmit`, and runs the
 * test leg — identically on both surfaces.
 *
 * The five lanes (`connectorAuthKind`):
 *   · A `oauth_device`/`oauth_redirect` → "Sign in with {name}" primary (+ an "or
 *     use an API key" divider when the schema also has a secret). Wired in P2; with
 *     no `onSignIn` it degrades to the key lane with a calm line — never a dead
 *     button, never a fake key field.
 *   · B `api_key` → one secret field + a "Get your key →" link + a one-line steer.
 *   · C `form` → the identity + secret + non-secret fields the schema declares.
 *   · D `mcp_oauth` → an HONEST note ("signs in in your bot's terminal") — NO key
 *     field, NO sign-in button; the client drives it at first use.
 *   · E `none` → "No sign-in needed" (now TRUE, only for kind=none).
 *
 * Chrome is per-surface (`variant`): the chat card wraps this in `DialogShell`, the
 * store hosts it in a bordered sheet card. Only the CHROME differs — the lane, the
 * fields, the seal and the test row are one component, so Slack looks the same in
 * both places.
 *
 * No `@/` alias imports: the chat unit runner resolves the root tsconfig (no
 * `paths`), and this file is on the chat `ConnectCard`'s import chain — every
 * runtime import stays relative, exactly like `connect-card.tsx` / `live-layer.tsx`.
 */
import * as React from 'react'
import { ArrowUpRight, Check, Copy, Loader2, Lock, Terminal } from 'lucide-react'

import {
  connectorAuthKind,
  plainFields,
  pollDevice,
  secretField,
  startDevice,
  testConnection,
  toolCountLabel,
  type ConnectorCard,
  type DeviceStart,
  type DeviceTarget,
} from '../../lib/api/connectors'
import { cn } from '../../lib/utils'
import {
  CredentialSecretField as SecretInput,
  CredentialTextField as TextField,
  defaultStr,
} from './credential-fields'

/** The outcome of a successful seal — what the surface + the test leg need. */
export interface ConnectFlowResult {
  restartHint: boolean
  /** The connected-account id (multi-account), when the seal minted/updated one.
   *  Drives the real "Test connection" probe; `null` for an identity-less seal. */
  accountRef?: string | null
  /** The connected-account label ("Connected as …"), when captured. */
  accountLabel?: string | null
}

export interface ConnectFlowProps {
  card: ConnectorCard
  /** Chrome + copy density: the chat card vs the store sheet. */
  variant: 'chat' | 'store'
  /** Lane A (device grant): the destination the seal auto-grants to. When present
   *  (and the card is an OAuth-device lane) ConnectFlow runs the built-in device
   *  sub-flow itself — startDevice → the code panel → the poll loop. The server
   *  auto-grants to THIS session on authorize; the store fans the account out to
   *  any extra targets via `onDeviceGranted`. */
  deviceTarget?: DeviceTarget
  /** Store multi-target: after authorize, fan the returned `account_ref` to the
   *  remaining bots (mirrors the paste `secret_ref` fan-out). May be null. */
  onDeviceGranted?: (accountRef: string | null) => Promise<void>
  /** Legacy/opaque escape hatch (a caller that drives OAuth itself). When neither
   *  this nor `deviceTarget` is set, Lane A degrades to the key lane (calm line)
   *  rather than a dead button. */
  onSignIn?: (connectorId: string) => Promise<void>
  /** Seal the collected fields + land the grant(s). The surface owns its targets /
   *  install; this component owns the fields, the lane and the test leg. Throws on
   *  failure (surfaced inline). */
  onSubmit: (args: { fields: Record<string, string> }) => Promise<ConnectFlowResult>
  /** Fired after a successful seal (the surface may flip its own chrome). */
  onDone?: (r: ConnectFlowResult) => void
  /** Dismiss ("Not now") — chat only; the store has its own close. */
  onDismiss?: () => void
  /** The primary CTA label in the collect state (surface-specific, e.g. "Install"). */
  submitLabel?: string
  /** Block the CTA (e.g. the store library's "choose who gets it" gate). */
  submitDisabled?: boolean
  /** Alternate CTA copy while blocked (e.g. "Choose who gets it first"). */
  blockedLabel?: string
  /** Store: suppress the collect-state submit CTA entirely (an `mcp_oauth` card
   *  finishes in the bot's chat via the handoff, so its grant-only button is
   *  meaningless — only the honest Lane D note shows here). Chat never sets it. */
  suppressCta?: boolean
  /** Store: a slot above the CTA (the GrantPicker). */
  children?: React.ReactNode
  /** Store: extra content in the added panel (e.g. the per-bot restart buttons). */
  renderAddedExtra?: (r: ConnectFlowResult) => React.ReactNode
  /** Seed straight to the added state (store re-opening an already-granted card). */
  initialAdded?: boolean
}

// The `device` phase renders the code panel + runs the poll loop; it subsumes the
// P2 `oauth_pending` spinner (the built-in flow now owns the whole wait).
type Phase = 'collect' | 'device' | 'saving' | 'added' | 'error'

export function ConnectFlow({
  card,
  variant,
  deviceTarget,
  onDeviceGranted,
  onSignIn,
  onSubmit,
  onDone,
  onDismiss,
  submitLabel,
  submitDisabled,
  blockedLabel,
  suppressCta,
  children,
  renderAddedExtra,
  initialAdded,
}: ConnectFlowProps) {
  const kind = connectorAuthKind(card)
  const secret = secretField(card)
  const plains = plainFields(card)
  const auth = card.auth ?? null

  const hasOAuth = kind === 'oauth_device' || kind === 'oauth_redirect'
  const isMcpOauth = kind === 'mcp_oauth'
  const isNone = kind === 'none'
  const needsSecret = !!secret

  const [phase, setPhase] = React.useState<Phase>(initialAdded ? 'added' : 'collect')
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(plains.map((f) => [f.key, defaultStr(f)])),
  )
  const [secretVal, setSecretVal] = React.useState('')
  const [reveal, setReveal] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<ConnectFlowResult | null>(null)
  // Lane A device sub-flow: the started grant (code + verification URL + handle).
  const [dev, setDev] = React.useState<DeviceStart | null>(null)
  const pollRef = React.useRef<number | null>(null)
  // Lane A leads with the OAuth primary; the key lane hides behind the divider
  // until the user taps sign-in (or the card isn't an OAuth lane at all).
  const [keyLaneOpen, setKeyLaneOpen] = React.useState(!hasOAuth)

  const requiredMissing =
    (secret?.required && secretVal.trim() === '') ||
    plains.some((f) => f.required && (values[f.key] ?? '').trim() === '')

  // Reset to the collect state with a calm line (denied/expired/blip). Re-offers
  // "Sign in with {name}" (+ the key lane when there's a secret to paste).
  const backToCollect = (message: string) => {
    setDev(null)
    setError(message)
    setPhase('collect')
  }

  const startSignIn = async () => {
    // No built-in device target on this surface — use the legacy escape hatch, or
    // fall back to the key lane with a calm line (never a dead button).
    if (!deviceTarget) {
      if (!onSignIn) {
        setKeyLaneOpen(true)
        setError(
          needsSecret
            ? 'Sign-in isn’t available here yet — paste an API key instead.'
            : 'Sign-in isn’t available here yet.',
        )
        return
      }
      setError(null)
      try {
        await onSignIn(card.id)
        const r: ConnectFlowResult = { restartHint: true }
        setResult(r)
        setPhase('added')
        onDone?.(r)
      } catch {
        setKeyLaneOpen(true)
        setPhase('collect')
        setError('Couldn’t finish sign-in. You can paste an API key instead.')
      }
      return
    }
    // The built-in RFC-8628 device grant: start it, then render the code panel and
    // let the poll effect drive it to `authorized`.
    setError(null)
    try {
      const d = await startDevice(card.id, deviceTarget)
      setDev(d)
      setPhase('device')
    } catch {
      setKeyLaneOpen(true)
      setError(
        needsSecret
          ? 'Couldn’t start sign-in — you can paste an API key instead.'
          : 'Couldn’t start sign-in. Try again in a moment.',
      )
    }
  }

  // The poll loop — an effect keyed on the started grant. Honours the RFC-8628
  // `interval` (raised on `slow_down`) + a client-side expiry guard, and clears
  // its timeout on unmount / phase change so an abandoned card never keeps polling.
  React.useEffect(() => {
    if (phase !== 'device' || !dev) return
    let alive = true
    let interval = dev.interval
    const deadline = Date.now() + dev.expires_in * 1000
    const tick = async () => {
      if (!alive) return
      if (Date.now() >= deadline) {
        backToCollect('That code expired — start again.')
        return
      }
      try {
        const r = await pollDevice(card.id, dev.handle)
        if (!alive) return
        if (r.status === 'authorized') {
          const accountRef = r.account_ref ?? null
          if (onDeviceGranted) await onDeviceGranted(accountRef)
          if (!alive) return
          const res: ConnectFlowResult = { restartHint: true, accountRef, accountLabel: null }
          setResult(res)
          setPhase('added')
          onDone?.(res)
          return
        }
        if (r.status === 'denied') {
          backToCollect('Sign-in was declined. You can try again.')
          return
        }
        if (r.status === 'expired') {
          backToCollect('That code expired — start again.')
          return
        }
        if (r.status === 'slow_down') interval += 5 // RFC-8628 §3.5, mirrors the server
        pollRef.current = window.setTimeout(tick, interval * 1000)
      } catch {
        // A transient network blip — back off one interval, don't kill the flow.
        pollRef.current = window.setTimeout(tick, interval * 1000)
      }
    }
    pollRef.current = window.setTimeout(tick, interval * 1000)
    return () => {
      alive = false
      if (pollRef.current) window.clearTimeout(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, dev, card.id])

  const submit = async () => {
    setPhase('saving')
    setError(null)
    try {
      const fields: Record<string, string> = { ...values }
      if (secret && secretVal.trim()) fields[secret.key] = secretVal
      const r = await onSubmit({ fields })
      setSecretVal('')
      setResult(r)
      setPhase('added')
      onDone?.(r)
    } catch (e) {
      setError((e as Error).message || 'Something went wrong.')
      setPhase('error')
    }
  }

  if (phase === 'added') {
    return (
      <AddedBlock
        card={card}
        variant={variant}
        result={result}
        renderAddedExtra={renderAddedExtra}
      />
    )
  }

  if (phase === 'device' && dev) {
    return <DevicePanel card={card} dev={dev} chat={variant === 'chat'} onCancel={() => backToCollect('')} />
  }

  const chat = variant === 'chat'
  const showCta = keyLaneOpen && !suppressCta // during the OAuth lead the "Sign in" button is the primary; mcp_oauth suppresses it entirely (store)
  const ctaBase = submitLabel ?? (needsSecret ? 'Connect' : 'Add')
  const ctaLabel =
    phase === 'saving' ? 'Connecting…' : submitDisabled && blockedLabel ? blockedLabel : ctaBase

  return (
    // The store variant carries its own bordered card chrome (the chat card lives
    // inside DialogShell, so it stays flush).
    <div className={cn('flex flex-col', chat ? 'gap-0' : 'gap-3 rounded-2xl border border-border bg-card p-4')}>
      {/* Lane A — the branded OAuth primary (leads the trust hierarchy). Disabled
          while the store's "choose who gets it" gate is unmet (submitDisabled), so
          the GrantPicker above is picked first; startSignIn degrades to the key
          lane if no device target / legacy handler is wired (never a dead button). */}
      {hasOAuth && !keyLaneOpen && (
        <div className={chat ? 'mt-[13px]' : ''}>
          <button
            type="button"
            onClick={startSignIn}
            disabled={submitDisabled}
            data-vr="connect-oauth"
            className={cn(
              chat
                ? 'inline-flex h-[38px] w-full items-center justify-center gap-2 rounded-full bg-fill-soft-2 px-[15px] text-[13.6px] font-semibold text-ink sm-t-morph hover:bg-fill-soft disabled:opacity-60'
                : 'inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[14px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-60',
            )}
            style={
              chat
                ? { borderColor: 'color-mix(in oklab, var(--sm-accent) 40%, transparent)', borderWidth: '0.5px' }
                : undefined
            }
          >
            Sign in with {card.display_name}
          </button>
          {submitDisabled && blockedLabel && (
            <p className={cn('mt-2 text-[12px]', chat ? 'text-ink-3' : 'text-muted-foreground')}>
              {blockedLabel}
            </p>
          )}
          {needsSecret && <Divider chat={chat}>or use an API key</Divider>}
          {!needsSecret && (
            <button
              type="button"
              onClick={() => setKeyLaneOpen(true)}
              className={cn('mt-2 text-[12px] underline-offset-2 hover:underline', chat ? 'text-ink-3' : 'text-muted-foreground')}
            >
              Sign in later
            </button>
          )}
        </div>
      )}

      {/* Lane D — hosted MCP that signs in in the bot's terminal (no key here). */}
      {isMcpOauth && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-xl px-3 py-2.5 text-[12.5px] leading-[1.45]',
            chat ? 'mt-[11px] bg-fill-soft text-ink-2' : 'bg-muted/50 text-muted-foreground',
          )}
        >
          <Terminal className="mt-px size-4 shrink-0" aria-hidden />
          <span>{auth?.help_text || `${card.display_name} signs in the first time your bot uses it — approve it in the bot's terminal. There's no key to paste here.`}</span>
        </div>
      )}

      {/* Lane E — no sign-in needed (now TRUE, only for kind=none). */}
      {isNone && (
        <div className={cn('flex flex-col gap-2', chat ? 'mt-[11px]' : '')}>
          <p className={cn('text-[13px]', chat ? 'text-ink-2' : 'text-muted-foreground')}>
            No sign-in needed — {card.kind === 'builtin_browser' ? 'this is built in.' : 'grant it to a bot to use it.'}
          </p>
          {card.kind === 'builtin_browser' && (
            <p className={cn('text-[13px] leading-[1.45]', chat ? 'text-ink-2' : 'text-muted-foreground')}>
              When the bot hits a login, a 2FA prompt or a CAPTCHA it asks you to take the wheel: the live page
              opens in your chat, you finish the step on your phone, and closing it hands control straight back.
              While you are driving, the bot cannot act on — or even read — that page.
            </p>
          )}
        </div>
      )}

      {/* Lane B / C — the key + form fields. NEVER for mcp_oauth (Lane D is
          note-only: the bot signs in in its terminal, there is no key to paste
          here even if the manifest happens to declare a credential). */}
      {keyLaneOpen && !isMcpOauth && (needsSecret || plains.length > 0) && (
        <div className={cn('flex flex-col', chat ? 'mt-[11px] gap-[9px]' : 'gap-3')}>
          {plains.map((f) => (
            <TextField
              key={f.key}
              field={f}
              chat={chat}
              value={values[f.key] ?? ''}
              onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
            />
          ))}
          {secret && (
            <SecretInput
              field={secret}
              chat={chat}
              value={secretVal}
              reveal={reveal}
              onReveal={() => setReveal((r) => !r)}
              onChange={setSecretVal}
            />
          )}
          {/* Lane B "Get your key →" deep link + the one-line steer. */}
          {auth?.help_url && (
            <a
              href={auth.help_url}
              target="_blank"
              rel="noreferrer noopener"
              data-vr="connect-help-url"
              className={cn(
                'inline-flex w-fit items-center gap-1 text-[12.5px] font-medium underline-offset-2 hover:underline',
                chat ? 'text-ink-2' : 'text-primary',
              )}
            >
              Get your key here
              <ArrowUpRight className="size-3.5" aria-hidden />
            </a>
          )}
          {auth?.help_text && !isMcpOauth && (
            <p className={cn('text-[12px] leading-[1.4]', chat ? 'text-ink-3' : 'text-muted-foreground')}>
              {auth.help_text}
            </p>
          )}
          <p className={cn('flex items-center gap-1.5 text-[12px]', chat ? 'text-ink-3' : 'text-muted-foreground')}>
            <Lock className="size-3.5 shrink-0" aria-hidden />
            Stored securely, never shown to your bot.
          </p>
        </div>
      )}

      {error && (
        <p data-testid="chat-connect-error" className={cn('text-[12.6px]', chat ? 'mt-[8px] text-status-error-ink' : 'text-destructive')}>
          {error}
        </p>
      )}

      {children}

      {/* Primary CTA row. During the OAuth lead the "Sign in" button above is the
          primary, so this row only carries "Not now" until the key lane opens. */}
      {(showCta || onDismiss) && (
        <div className={cn('flex flex-wrap items-center gap-2', chat ? 'mt-[13px] justify-end' : '')}>
          {chat && onDismiss && <PillButton label="Not now" onClick={onDismiss} />}
          {showCta && (
            <button
              type="button"
              onClick={submit}
              disabled={phase === 'saving' || requiredMissing || submitDisabled}
              data-vr="connect-submit"
              className={cn(
                chat
                  ? 'inline-flex h-[34px] items-center gap-2 rounded-full border-[0.5px] border-hairline bg-fill-soft-2 px-[15px] text-[13.4px] font-semibold text-ink sm-t-morph disabled:cursor-default disabled:opacity-45'
                  : cn(
                      'mt-1 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-semibold shadow-sm transition-colors',
                      requiredMissing || submitDisabled
                        ? 'cursor-not-allowed bg-muted text-muted-foreground shadow-none'
                        : 'bg-primary text-primary-foreground hover:bg-primary/90',
                    ),
              )}
            >
              {phase === 'saving' && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {ctaLabel}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Lane A device sub-flow panel ──────────────────────────────────────────────

/** The device-grant panel: the big copyable `user_code`, an "Open {provider} →"
 *  button, a plain "enter this code" line, and a "waiting" spinner while the poll
 *  loop (owned by <ConnectFlow>) runs. NEVER renders a secret / device_code — only
 *  the human-facing `user_code` + verification URL. Both variants via `chat`. */
function DevicePanel({
  card,
  dev,
  chat,
  onCancel,
}: {
  card: ConnectorCard
  dev: DeviceStart
  chat: boolean
  onCancel: () => void
}) {
  const openUrl = dev.verification_uri_complete || dev.verification_uri
  const host = hostOf(dev.verification_uri)
  return (
    <div className={cn('flex flex-col', chat ? 'mt-[13px] gap-3' : 'gap-3 rounded-2xl border border-border bg-card p-4')}>
      {/* The hero: the code, large + letter-spaced, tap-to-copy (≥44px target). */}
      <CodeChip code={dev.user_code} chat={chat} />

      {/* Open the provider's device page (pre-filled when the provider supports it). */}
      <a
        href={openUrl}
        target="_blank"
        rel="noreferrer noopener"
        data-vr="device-open"
        className={cn(
          'inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-semibold transition-colors',
          chat
            ? 'bg-fill-soft-2 text-ink hover:bg-fill-soft'
            : 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
        )}
      >
        Open {card.display_name}
        <ArrowUpRight className="size-4" aria-hidden />
      </a>

      <p className={cn('text-[13px] leading-[1.45]', chat ? 'text-ink-2' : 'text-muted-foreground')}>
        Enter this code at <span className="font-medium">{host}</span> — I’ll wait.
      </p>

      <div className={cn('flex items-center gap-2 text-[12.5px]', chat ? 'text-ink-3' : 'text-muted-foreground')}>
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Waiting for you to approve…
        <button
          type="button"
          onClick={onCancel}
          className={cn('ml-auto underline-offset-2 hover:underline', chat ? 'text-ink-2' : 'text-foreground/80')}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

/** The big, letter-spaced device code + a full-width tap-to-copy affordance. */
function CodeChip({ code, chat }: { code: string; chat: boolean }) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<number | null>(null)
  React.useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true)
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1600)
      },
      () => {},
    )
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy the code ${code}`}
      data-vr="device-code"
      className={cn(
        'group flex min-h-[56px] w-full items-center justify-center gap-3 rounded-xl px-4 py-3 transition-colors',
        chat ? 'bg-fill-soft hover:bg-fill-soft-2' : 'border border-border bg-muted/40 hover:bg-muted/60',
      )}
    >
      <span className={cn('select-all font-mono text-[26px] font-semibold tracking-[0.28em]', chat ? 'text-ink' : 'text-foreground')}>
        {code}
      </span>
      <span className={cn('inline-flex items-center gap-1 text-[12px] font-medium', copied ? 'text-status-ready-ink' : chat ? 'text-ink-3' : 'text-muted-foreground')}>
        {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        {copied ? 'Copied' : 'Copy'}
      </span>
    </button>
  )
}

/** The bare host of a verification URL ("github.com/login/device"), for the calm
 *  "enter this code at …" line. Falls back to the raw string if it won't parse. */
function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`.replace(/\/$/, '')
  } catch {
    return url
  }
}

// ── the added / test block ────────────────────────────────────────────────────

/** After a successful seal: the confirmation + the account label + the TEST leg.
 *  When the seal minted an account we run the REAL server probe
 *  (`POST /{id}/test` → IMAP login / URL reachability). Otherwise we surface the
 *  agent-as-probe contract (`connect_server.py`): the bot retries `mcp__{svc}__*`
 *  next turn — no new server code needed. */
function AddedBlock({
  card,
  variant,
  result,
  renderAddedExtra,
}: {
  card: ConnectorCard
  variant: 'chat' | 'store'
  result: ConnectFlowResult | null
  renderAddedExtra?: (r: ConnectFlowResult) => React.ReactNode
}) {
  const chat = variant === 'chat'
  const tools = toolCountLabel(card)
  const accountRef = result?.accountRef ?? null
  const label = result?.accountLabel ?? null

  if (chat) {
    return (
      <div className="mt-2 flex flex-col gap-2">
        <div className="text-[12.6px] text-ink-2">
          {label ? (
            <>
              Connected as <span className="text-ink">{label}</span>. The key is sealed in the vault and never shown to your bot.
            </>
          ) : (
            <>{card.display_name} is connected to this bot. The key is sealed in the vault and never shown to your bot.</>
          )}
        </div>
        <TestRow card={card} accountRef={accountRef} chat />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-status-ready/30 bg-status-ready/10 p-4">
      <div className="flex items-center gap-2 text-[14px] font-semibold text-status-ready-ink">
        <span className="grid size-6 place-items-center rounded-full bg-status-ready/20">
          <Check className="size-3.5" aria-hidden />
        </span>
        Added{tools ? ` · ${tools}` : ''}
      </div>
      {label && (
        <p className="text-[12.5px] text-muted-foreground">
          Connected as <span className="text-foreground/80">{label}</span>.
        </p>
      )}
      {result?.restartHint && (
        <p className="text-[12.5px] text-muted-foreground">Restart the bot to apply — grants bind at the next launch.</p>
      )}
      <TestRow card={card} accountRef={accountRef} />
      {result && renderAddedExtra?.(result)}
    </div>
  )
}

type TestState = 'idle' | 'running' | 'done'

function TestRow({ card, accountRef, chat }: { card: ConnectorCard; accountRef: string | null; chat?: boolean }) {
  const [state, setState] = React.useState<TestState>('idle')
  const [note, setNote] = React.useState<{ message: string; tone: 'ok' | 'bad' | 'muted' } | null>(null)

  // No connected account to probe (identity-less seal, or an mcp_oauth/none lane):
  // fall back to the honest agent-as-probe line rather than a fake green.
  if (!accountRef) {
    return (
      <p className={cn('text-[12px] leading-[1.4]', chat ? 'text-ink-3' : 'text-muted-foreground')}>
        Your bot verifies {card.display_name} on its next turn — it retries the tool and reports back.
      </p>
    )
  }

  const run = async () => {
    setState('running')
    setNote(null)
    try {
      const r = await testConnection(card.id, accountRef)
      const tone = !r.testable ? 'muted' : r.health === 'ok' ? 'ok' : 'bad'
      setNote({ message: r.message, tone })
    } catch {
      setNote({ message: 'Couldn’t run the test just now.', tone: 'bad' })
    } finally {
      setState('done')
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={run}
        disabled={state === 'running'}
        data-vr="connect-test"
        className={cn(
          'inline-flex h-8 w-fit items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors disabled:opacity-60',
          chat ? 'bg-fill-soft text-ink hover:bg-fill-soft-2' : 'bg-foreground/[0.06] text-foreground hover:bg-foreground/10',
        )}
      >
        {state === 'running' ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
        {state === 'running' ? 'Testing…' : state === 'done' ? 'Test again' : 'Test connection'}
      </button>
      {note && (
        <p
          className={cn(
            'text-[12px] leading-[1.4]',
            note.tone === 'ok'
              ? chat ? 'text-status-ready-ink' : 'text-status-ready-ink'
              : note.tone === 'bad'
                ? chat ? 'text-status-error-ink' : 'text-destructive'
                : chat ? 'text-ink-3' : 'text-muted-foreground',
          )}
        >
          {note.tone === 'ok' ? 'Connected ✓ — ' : ''}
          {note.message}
        </p>
      )}
    </div>
  )
}

// ── field atoms ───────────────────────────────────────────────────────────────
// The credential text/secret widgets live in `./credential-fields` (one set,
// both surfaces via `chat`), reused by connector-detail + installed-panel.

function Divider({ chat, children }: { chat: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('flex items-center gap-3', chat ? 'my-[11px] text-[11.5px] text-ink-3' : 'text-[11.5px] text-muted-foreground')}>
      <span className={cn('h-px flex-1', chat ? 'bg-hairline' : 'bg-border')} />
      {children}
      <span className={cn('h-px flex-1', chat ? 'bg-hairline' : 'bg-border')} />
    </div>
  )
}

function PillButton({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-[34px] items-center gap-2 rounded-full border-[0.5px] border-hairline bg-transparent px-[15px] text-[13.4px] font-medium text-ink hover:bg-fill-soft sm-t-morph"
    >
      {label}
    </button>
  )
}

