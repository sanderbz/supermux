// The connector detail sheet — the store's expand: full tool list, the connect
// flow (secure credential paste OR sign-in), the grant control, and remove.
//
// This is where the store's connect actually happens: paste a key once → it is
// sealed into the vault (`POST /{id}/credential`, write-only) and, when a bot
// scope is active, granted to that bot in the same call. The secret is never
// echoed back — the field flips to a masked "Added" state.
import * as React from 'react'
import { Check, Eye, EyeOff, Loader2, Lock, Trash2 } from 'lucide-react'

import {
  connectorHasOAuth,
  plainFields,
  secretField,
  toolCountLabel,
  type ConnectorCard as Card,
  type CredentialField,
} from '@/lib/api/connectors'
import { useConnectorActions } from '@/stores/connectors-store'
import { cn } from '@/lib/utils'

import { ConnectorIcon } from './connector-icon'
import { OfficialBadge } from './connector-card'
import { GrantControl, type GrantScope } from './grant-control'

type Phase = 'idle' | 'saving' | 'added'

export function ConnectorDetail({
  card,
  installed,
  granted,
  grantTarget,
  onDone,
  onRemoved,
}: {
  card: Card
  installed: boolean
  granted: GrantScope
  /** The active scope: a bot slug, `*`, or `null` (library view). */
  grantTarget: string | null
  onDone: () => void
  onRemoved?: () => void
}) {
  const actions = useConnectorActions()
  const secret = secretField(card)
  const plains = plainFields(card)
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(plains.map((f) => [f.key, defaultStr(f)])),
  )
  const [secretVal, setSecretVal] = React.useState('')
  const [reveal, setReveal] = React.useState(false)
  const [phase, setPhase] = React.useState<Phase>(granted ? 'added' : 'idle')
  const [restartHint, setRestartHint] = React.useState(false)
  const [localGrant, setLocalGrant] = React.useState<GrantScope>(granted)
  // OAuth-capable connectors LEAD with the branded "Sign in" primary; the key
  // paste is demoted behind an "or use an API key" divider (blocker B4). There is
  // no live OAuth lane on the server yet, so tapping sign-in reveals the key lane
  // with a calm line — the same honest fallback the inline connect-card uses.
  const hasOAuth = connectorHasOAuth(card) && !!secret
  const [keyLaneOpen, setKeyLaneOpen] = React.useState(!hasOAuth)

  const needsSecret = !!secret
  const requiredMissing =
    (needsSecret && secret?.required && secretVal.trim() === '') ||
    plains.some((f) => f.required && (values[f.key] ?? '').trim() === '')

  const connect = async () => {
    setPhase('saving')
    try {
      // Install a catalog card into the local registry first (idempotent).
      if (!installed) {
        await actions.install({
          id: card.id,
          kind: card.kind,
          display_name: card.display_name,
          icon: card.icon,
          description: card.description,
          tools: card.tools,
          credentials: card.credentials,
        })
      }
      const fields: Record<string, string> = { ...values }
      if (needsSecret && secretVal.trim()) fields[secret!.key] = secretVal
      if (Object.keys(fields).length > 0) {
        const r = await actions.putCredential(card.id, {
          fields,
          session_name: grantTarget ?? undefined,
        })
        if (r === null) {
          setPhase('idle')
          return
        }
        setRestartHint(true)
      } else if (grantTarget) {
        // No credential (built-in / OAuth-only) — just land the grant.
        const restart = await actions.grant(card.id, grantTarget)
        setRestartHint(restart)
      }
      setSecretVal('')
      setLocalGrant(grantTarget === '*' ? 'all' : grantTarget ? 'bot' : null)
      setPhase('added')
    } catch {
      setPhase('idle')
    }
  }

  const tools = toolCountLabel(card)
  const botName = grantTarget && grantTarget !== '*' ? grantTarget : null

  return (
    <div className="flex flex-col gap-5">
      {/* header */}
      <div className="flex items-start gap-3.5">
        <ConnectorIcon card={card} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[19px] font-semibold leading-tight tracking-tight text-foreground">
              {card.display_name}
            </h2>
            {card.official && <OfficialBadge label />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            {tools && <span className="font-medium">{tools}</span>}
            <span className="capitalize">{kindLabel(card.kind)}</span>
            {primaryCategory(card) && <span className="capitalize">{primaryCategory(card)}</span>}
          </div>
        </div>
      </div>

      <p className="text-[14px] leading-relaxed text-foreground/90">{card.description}</p>

      {/* Install / connect command — the exact one-liner to wire this connector. */}
      {card.install && <InstallBlock command={card.install} />}

      {/* connect / credential flow */}
      {phase === 'added' ? (
        <AddedPanel restartHint={restartHint} target={grantTarget} />
      ) : (
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
          {/* OAuth primary — the branded sign-in, leading the trust hierarchy. */}
          {hasOAuth && !keyLaneOpen && (
            <>
              <button
                type="button"
                onClick={() => setKeyLaneOpen(true)}
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[14px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
              >
                Sign in with {card.display_name}
              </button>
              <div className="flex items-center gap-3 text-[11.5px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or use an API key
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}
          {needsSecret && keyLaneOpen ? (
            <>
              {hasOAuth && (
                <p className="text-[12px] text-muted-foreground">
                  Sign-in isn’t available here yet — paste an API key instead.
                </p>
              )}
              {plains.map((f) => (
                <PlainField
                  key={f.key}
                  field={f}
                  value={values[f.key] ?? ''}
                  onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
                />
              ))}
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-medium text-foreground">
                  {secret!.title || 'API key'}
                  {secret!.required && <span className="ml-1 text-muted-foreground">*</span>}
                </span>
                <span className="relative flex items-center">
                  <input
                    type={reveal ? 'text' : 'password'}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={secretVal}
                    onChange={(e) => setSecretVal(e.target.value)}
                    placeholder="Paste your key"
                    aria-label={secret!.title || 'API key'}
                    className="h-11 w-full rounded-xl border border-input bg-background px-3 pr-11 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => setReveal((r) => !r)}
                    aria-label={reveal ? 'Hide key' : 'Show key'}
                    className="absolute right-1.5 grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {reveal ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                  </button>
                </span>
              </label>
              <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Lock className="size-3.5 shrink-0" aria-hidden />
                Stored securely, never shown to your bot.
              </p>
            </>
          ) : !needsSecret ? (
            <>
              <p className="text-[13px] text-muted-foreground">
                No sign-in needed — {card.kind === 'builtin_browser' ? 'this is built in.' : 'grant it to a bot to use it.'}
              </p>
              {/* HOW THE TAKEOVER WORKS — the one thing about this connector that
                  is not obvious from a tool list, said once, where it is decided
                  whether to grant it. */}
              {card.kind === 'builtin_browser' && (
                <p className="text-[13px] leading-[1.45] text-muted-foreground">
                  When the bot hits a login, a 2FA prompt or a CAPTCHA it asks you
                  to take the wheel: the live page opens in your chat, you finish
                  the step on your phone, and closing it hands control straight
                  back. While you are driving, the bot cannot act on — or even
                  read — that page.
                </p>
              )}
            </>
          ) : null}

          {/* The bottom CTA belongs to the key/no-secret path; during the OAuth
              lead the branded "Sign in" above is the primary, so it stands alone.
              Enabled/working: SOLID brand-blue + white label (>=4.5:1). Blocked (a
              required field still empty) is a NEUTRAL muted fill — never a washed
              blue that could read as a live-but-dim CTA (blocker H2). */}
          {(keyLaneOpen || !needsSecret) && (
            <button
              type="button"
              onClick={connect}
              disabled={phase === 'saving' || requiredMissing}
              className={cn(
                'mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-semibold shadow-sm transition-colors',
                requiredMissing
                  ? 'cursor-not-allowed bg-muted text-muted-foreground shadow-none'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:hover:bg-primary',
              )}
            >
              {phase === 'saving' && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {needsSecret ? 'Connect' : grantTarget ? 'Add to this bot' : 'Install'}
            </button>
          )}
        </div>
      )}

      {/* grant control (once installed) */}
      {(installed || phase === 'added') && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <GrantControl
            connectorId={card.id}
            botName={botName}
            scope={localGrant}
            onGranted={(_t, restart) => {
              setLocalGrant(grantTarget === '*' ? 'all' : 'bot')
              if (restart) setRestartHint(true)
            }}
            onRevoked={() => setLocalGrant(null)}
          />
        </div>
      )}

      {/* tools */}
      {card.tools && card.tools.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold text-foreground">Tools</h3>
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
            {card.tools.map((t) => (
              <li key={t.name} className="flex flex-col gap-0.5 px-3.5 py-2.5">
                <span className="font-mono text-[12.5px] font-medium text-foreground">{t.name}</span>
                {t.description && <span className="text-[12px] text-muted-foreground">{t.description}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* remove (local rows only) */}
      {installed && (
        <button
          type="button"
          onClick={async () => {
            await actions.remove(card.id)
            onRemoved?.()
            onDone()
          }}
          className="inline-flex items-center gap-1.5 self-start rounded-lg px-2 py-1.5 text-[12.5px] font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          <Trash2 className="size-3.5" aria-hidden />
          Remove connector
        </button>
      )}
    </div>
  )
}

/** The connector's primary chip-rail category (skips the `featured` meta tag). */
function primaryCategory(card: Card): string | null {
  return (card.categories ?? []).find((c) => c !== 'featured') ?? null
}

/** The install/connect command — monospace, selectable, horizontally scrollable. */
function InstallBlock({ command }: { command: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-muted-foreground">Install</span>
      <code className="block w-full select-all overflow-x-auto whitespace-pre rounded-xl border border-border bg-muted/50 px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground">
        {command}
      </code>
    </div>
  )
}

function AddedPanel({ restartHint, target }: { restartHint: boolean; target: string | null }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-status-ready/30 bg-status-ready/10 p-4">
      <div className="flex items-center gap-2 text-[14px] font-semibold text-status-ready-ink">
        <span className="grid size-6 place-items-center rounded-full bg-status-ready/20">
          <Check className="size-3.5" aria-hidden />
        </span>
        Added{target && target !== '*' ? ` to ${target}` : target === '*' ? ' for all agents' : ''}
      </div>
      {restartHint && (
        <p className="text-[12.5px] text-muted-foreground">
          Restart the bot to apply — grants bind at the next launch.
        </p>
      )}
    </div>
  )
}

function PlainField({
  field,
  value,
  onChange,
}: {
  field: CredentialField
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-foreground">
        {field.title || field.key}
        {field.required && <span className="ml-1 text-muted-foreground">*</span>}
      </span>
      <input
        type="text"
        value={value}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        aria-label={field.title || field.key}
        className="h-11 w-full rounded-xl border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  )
}

function defaultStr(f: CredentialField): string {
  if (f.default === undefined || f.default === null) return ''
  return typeof f.default === 'string' ? f.default : String(f.default)
}

function kindLabel(kind: string): string {
  if (kind === 'mcp_catalog') return 'Catalog'
  if (kind === 'agent_authored') return 'Agent-authored'
  if (kind === 'builtin_browser') return 'Built-in'
  return kind
}
