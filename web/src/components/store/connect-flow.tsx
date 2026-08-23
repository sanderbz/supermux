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
import { ArrowUpRight, Check, Eye, EyeOff, Loader2, Lock, Terminal } from 'lucide-react'

import {
  connectorAuthKind,
  plainFields,
  secretField,
  testConnection,
  toolCountLabel,
  type ConnectorCard,
  type CredentialField,
} from '../../lib/api/connectors'
import { cn } from '../../lib/utils'

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
  /** Lane A: deliver OAuth. Absent = no live OAuth lane on this surface yet — the
   *  card falls back to the key lane (with a calm line) rather than a dead button. */
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
  /** Alternate CTA copy while blocked (e.g. "Install — choose who gets it"). */
  blockedLabel?: string
  /** Store: a slot above the CTA (the GrantPicker). */
  children?: React.ReactNode
  /** Store: extra content in the added panel (e.g. the per-bot restart buttons). */
  renderAddedExtra?: (r: ConnectFlowResult) => React.ReactNode
  /** Seed straight to the added state (store re-opening an already-granted card). */
  initialAdded?: boolean
}

type Phase = 'collect' | 'oauth_pending' | 'saving' | 'added' | 'error'

export function ConnectFlow({
  card,
  variant,
  onSignIn,
  onSubmit,
  onDone,
  onDismiss,
  submitLabel,
  submitDisabled,
  blockedLabel,
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
  // Lane A leads with the OAuth primary; the key lane hides behind the divider
  // until the user taps sign-in (or there is no live OAuth lane to offer).
  const [keyLaneOpen, setKeyLaneOpen] = React.useState(!hasOAuth)

  const requiredMissing =
    (secret?.required && secretVal.trim() === '') ||
    plains.some((f) => f.required && (values[f.key] ?? '').trim() === '')

  const signIn = async () => {
    if (!onSignIn) {
      setKeyLaneOpen(true)
      setError(
        needsSecret
          ? 'Sign-in isn’t available here yet — paste an API key instead.'
          : 'Sign-in isn’t available here yet.',
      )
      return
    }
    setPhase('oauth_pending')
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
  }

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

  const chat = variant === 'chat'
  const showCta = keyLaneOpen // during the OAuth lead the "Sign in" button is the primary
  const ctaBase = submitLabel ?? (needsSecret ? 'Connect' : 'Add')
  const ctaLabel =
    phase === 'saving' ? 'Connecting…' : submitDisabled && blockedLabel ? blockedLabel : ctaBase

  return (
    // The store variant carries its own bordered card chrome (the chat card lives
    // inside DialogShell, so it stays flush).
    <div className={cn('flex flex-col', chat ? 'gap-0' : 'gap-3 rounded-2xl border border-border bg-card p-4')}>
      {/* Lane A — the branded OAuth primary (leads the trust hierarchy). */}
      {hasOAuth && !keyLaneOpen && (
        <div className={chat ? 'mt-[13px]' : ''}>
          <button
            type="button"
            onClick={signIn}
            disabled={phase === 'oauth_pending'}
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
            {phase === 'oauth_pending' ? <>Waiting for {card.display_name}…</> : <>Sign in with {card.display_name}</>}
          </button>
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

      {/* Lane B / C — the key + form fields. */}
      {keyLaneOpen && (needsSecret || plains.length > 0) && (
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

// ── field atoms (one set, both surfaces via `chat`) ───────────────────────────

function TextField({
  field,
  chat,
  value,
  onChange,
}: {
  field: CredentialField
  chat: boolean
  value: string
  onChange: (v: string) => void
}) {
  const id = `connect-${field.key}`
  return (
    <div className={chat ? '' : 'flex flex-col gap-1.5'}>
      <label
        htmlFor={id}
        className={cn('font-medium', chat ? 'block text-[12.6px] leading-[1.3] text-ink-2' : 'text-[12.5px] text-foreground')}
      >
        {field.title || field.key}
        {field.required && <span className={cn('ml-1', chat ? 'text-ink-3' : 'text-muted-foreground')}>*</span>}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={field.title || field.key}
        className={cn(
          chat
            ? 'mt-[4px] h-[34px] w-full rounded-[9px] border-[0.5px] border-hairline bg-fill-soft px-[10px] text-[13px] text-ink outline-none focus-visible:border-[color-mix(in_oklab,var(--sm-accent)_55%,transparent)]'
            : 'h-11 w-full rounded-xl border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring',
        )}
      />
    </div>
  )
}

function SecretInput({
  field,
  chat,
  value,
  reveal,
  onReveal,
  onChange,
}: {
  field: CredentialField
  chat: boolean
  value: string
  reveal: boolean
  onReveal: () => void
  onChange: (v: string) => void
}) {
  return (
    <div className={chat ? '' : 'flex flex-col gap-1.5'}>
      <label
        htmlFor="connect-secret"
        className={cn('font-medium', chat ? 'block text-[12.6px] leading-[1.3] text-ink-2' : 'text-[12.5px] text-foreground')}
      >
        {field.title || 'API key'}
        {field.required && <span className={cn('ml-1', chat ? 'text-ink-3' : 'text-muted-foreground')}>*</span>}
      </label>
      <div className={cn('relative flex items-center', chat ? 'mt-[4px]' : '')}>
        <input
          id="connect-secret"
          type={reveal ? 'text' : 'password'}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste your key"
          data-testid="chat-connect-secret"
          aria-label={field.title || 'API key'}
          className={cn(
            'w-full font-mono outline-none',
            chat
              ? 'h-[34px] rounded-[9px] border-[0.5px] border-hairline bg-fill-soft px-[10px] pr-[36px] text-[13px] text-ink focus-visible:border-[color-mix(in_oklab,var(--sm-accent)_55%,transparent)]'
              : 'h-11 rounded-xl border border-input bg-background px-3 pr-11 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring',
          )}
        />
        <button
          type="button"
          onClick={onReveal}
          aria-label={reveal ? 'Hide key' : 'Show key'}
          className={cn(
            'absolute grid place-items-center rounded-lg text-muted-foreground hover:text-foreground',
            chat ? 'right-[5px] size-[26px] rounded-[7px] text-ink-3 hover:bg-fill-soft' : 'right-1.5 size-8 hover:bg-muted',
          )}
        >
          {reveal ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      </div>
    </div>
  )
}

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

function defaultStr(f: CredentialField): string {
  if (f.default === undefined || f.default === null) return ''
  return typeof f.default === 'string' ? f.default : String(f.default)
}
