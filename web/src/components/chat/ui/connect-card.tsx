/**
 * The inline CONNECT card — the Grok moment, supermux-native in chat.
 * ─────────────────────────────────────────────────────────────────────────────
 * A bot's `connect(service)` tool asked for a human (the `_meta`
 * `requiresUserInteraction` marker reached the prompt). Instead of a settings
 * excursion, ONE card slides into the transcript: tap **Sign in**, or paste an
 * API key once, and it flips to **Added · N tools**.
 *
 * It reuses `DialogShell` (from `choice-card.tsx`) so it is visually one family
 * with the question / permission / form cards — the same glass, eyebrow, and
 * attribution grammar.
 *
 * ## The secret never touches the chat/MCP stream
 *
 * This card POSTs straight to the vault (`POST /api/connectors/{id}/credential`,
 * write-only) — it is NEVER an MCP `elicitation/create` (the spec forbids
 * elicitation for secrets). The response is masked (`{K:"••••••"}`); nothing here
 * ever reads a stored value back. The reveal eye toggles only what YOU are
 * typing.
 *
 * No `@/` alias imports (the unit runner resolves the root tsconfig, which has no
 * `paths`) — every runtime import is relative, exactly like `live-layer.tsx`.
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, Eye, EyeOff, Lock } from 'lucide-react'

import {
  getConnector,
  grant as apiGrant,
  plainFields,
  putCredential,
  secretField,
  toolCountLabel,
  type ConnectorCard,
  type CredentialField,
} from '../../../lib/api/connectors'
import type { ConnectRequestInfo } from '../../../lib/api/sessions'
import { cn } from '../../../lib/utils'

import { DialogShell } from './choice-card'

type Phase = 'proposed' | 'oauth_pending' | 'key_entry' | 'saving' | 'added' | 'error'

export interface ConnectCardProps {
  request: ConnectRequestInfo
  /** The session (bot) the grant lands on — the credential auto-grants here. */
  sessionName: string
  /**
   * Deliver the OAuth sign-in. Absent = no live OAuth lane on this session
   * (the shipped state until the server surfaces the flow); the card falls back
   * to the key lane with the documented calm line rather than a dead button.
   */
  onSignIn?: (connectorId: string) => Promise<void>
  /** Dismiss ("Not now"). */
  onDismiss?: () => void
  /** Test seam: skip the network schema fetch, render against this card. */
  card?: ConnectorCard
}

export function ConnectCard({
  request,
  sessionName,
  onSignIn,
  onDismiss,
  card: seedCard,
}: ConnectCardProps) {
  const [card, setCard] = useState<ConnectorCard | null>(seedCard ?? null)
  const [phase, setPhase] = useState<Phase>('proposed')
  const [values, setValues] = useState<Record<string, string>>({})
  const [secretVal, setSecretVal] = useState('')
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restartHint, setRestartHint] = useState(false)

  // Pull the credential SCHEMA (field names/types/flags — never a value). On a
  // failure we degrade to a single generic API-key field so the card still works.
  useEffect(() => {
    if (seedCard) return
    let live = true
    getConnector(request.connector_id)
      .then((c) => live && setCard(c))
      .catch(() => {
        if (live) setCard(null)
      })
    return () => {
      live = false
    }
  }, [request.connector_id, seedCard])

  const secret: CredentialField | undefined = card
    ? secretField(card)
    : { key: 'API_KEY', title: 'API key', sensitive: true, required: true }
  const plains = card ? plainFields(card) : []
  const hasOAuth = request.has_oauth ?? false

  const name = request.display_name ?? card?.display_name ?? request.connector_id
  const toolsLine = useMemo(() => {
    if (card) return toolCountLabel(card)
    const n = request.tool_count
    return typeof n === 'number' ? (n === 1 ? '1 tool' : `${n} tools`) : ''
  }, [card, request.tool_count])

  const requiredMissing =
    (secret?.required && secretVal.trim() === '') ||
    plains.some((f) => f.required && (values[f.key] ?? '').trim() === '')

  // A connector with no OAuth shows the key lane directly (no disclosure).
  const keyLaneOpen = phase === 'key_entry' || phase === 'saving' || phase === 'error' || !hasOAuth

  const signIn = async () => {
    if (!onSignIn) {
      // No live OAuth lane — fall back gracefully to the key lane.
      setPhase('key_entry')
      setError('Sign-in isn’t available here yet — paste an API key instead.')
      return
    }
    setPhase('oauth_pending')
    setError(null)
    try {
      await onSignIn(request.connector_id)
      setRestartHint(true)
      setPhase('added')
    } catch {
      setPhase('key_entry')
      setError('Couldn’t finish sign-in. You can paste an API key instead.')
    }
  }

  const connect = async () => {
    setPhase('saving')
    setError(null)
    try {
      const fields: Record<string, string> = { ...values }
      if (secret && secretVal.trim()) fields[secret.key] = secretVal
      const res = await putCredential(request.connector_id, {
        fields,
        session_name: sessionName,
      })
      // Belt-and-braces: ensure the grant lands on this bot even if the server
      // build predates the credential-write's inline grant.
      if (!res.secret_ref) {
        await apiGrant(request.connector_id, { session_name: sessionName })
      }
      setSecretVal('')
      setRestartHint(true)
      setPhase('added')
    } catch (e) {
      setError((e as Error).message || 'Something went wrong.')
      setPhase('error')
    }
  }

  if (phase === 'added') {
    return (
      <div data-testid="chat-connect-card" data-phase="added">
        <DialogShell
          eyebrow={<>Connector · {name}</>}
          question={
            <span className="inline-flex items-center gap-2">
              <CheckMark />
              Added{toolsLine ? ` · ${toolsLine}` : ''}
            </span>
          }
          why={restartHint ? 'Restart the bot to apply — grants bind at the next launch.' : undefined}
        >
          <div className="mt-2 text-[12.6px] text-ink-2">
            {name} is connected to this bot. The key is sealed in the vault and never shown to your bot.
          </div>
        </DialogShell>
      </div>
    )
  }

  return (
    <div data-testid="chat-connect-card" data-phase={phase}>
      <DialogShell
        eyebrow={<>Connector · {name}</>}
        question={<>Connect {name}</>}
        why={`Your bot asked to use ${name}${toolsLine ? ` · ${toolsLine}` : ''}.`}
      >
        {/* OAuth primary (only when the connector offers it) */}
        {hasOAuth && phase !== 'key_entry' && phase !== 'error' && (
          <div className="mt-[13px]">
            <button
              type="button"
              onClick={signIn}
              disabled={phase === 'oauth_pending'}
              className={cn(
                'inline-flex h-[38px] w-full items-center justify-center gap-2 rounded-full',
                'bg-fill-soft-2 px-[15px] text-[13.6px] font-semibold text-ink sm-t-morph',
                'hover:bg-fill-soft disabled:opacity-60',
              )}
              style={{
                borderColor: 'color-mix(in oklab, var(--sm-accent) 40%, transparent)',
                borderWidth: '0.5px',
              }}
            >
              {phase === 'oauth_pending' ? (
                <>
                  <TwoDot /> Waiting for {name}…
                </>
              ) : (
                <>Sign in with {name}</>
              )}
            </button>
            <Divider>or use an API key</Divider>
          </div>
        )}

        {/* Key lane */}
        {keyLaneOpen && (
          <div className="mt-[11px] flex flex-col gap-[9px]">
            {plains.map((f) => (
              <TextField
                key={f.key}
                field={f}
                value={values[f.key] ?? ''}
                onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
              />
            ))}
            {secret && (
              <div>
                <label
                  htmlFor="connect-secret"
                  className="block text-[12.6px] font-medium leading-[1.3] text-ink-2"
                >
                  {secret.title || 'API key'}
                  {secret.required && <span className="ml-1 text-ink-3">*</span>}
                </label>
                <div className="relative mt-[4px] flex items-center">
                  <input
                    id="connect-secret"
                    type={reveal ? 'text' : 'password'}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={secretVal}
                    onChange={(e) => setSecretVal(e.target.value)}
                    placeholder="Paste your key"
                    data-testid="chat-connect-secret"
                    className="h-[34px] w-full rounded-[9px] border-[0.5px] border-hairline bg-fill-soft px-[10px] pr-[36px] font-mono text-[13px] text-ink outline-none focus-visible:border-[color-mix(in_oklab,var(--sm-accent)_55%,transparent)]"
                  />
                  <button
                    type="button"
                    onClick={() => setReveal((r) => !r)}
                    aria-label={reveal ? 'Hide key' : 'Show key'}
                    className="absolute right-[5px] grid size-[26px] place-items-center rounded-[7px] text-ink-3 hover:bg-fill-soft"
                  >
                    {reveal ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                  </button>
                </div>
              </div>
            )}
            <p className="flex items-center gap-1.5 text-[12px] text-ink-3">
              <Lock className="size-3.5 shrink-0" aria-hidden />
              Stored securely, never shown to your bot.
            </p>
          </div>
        )}

        {error && (
          <p data-testid="chat-connect-error" className="mt-[8px] text-[12.6px] text-status-error-ink">
            {error}
          </p>
        )}

        <div className="mt-[13px] flex flex-wrap items-center justify-end gap-2">
          <PillButton label="Not now" onClick={onDismiss} />
          {keyLaneOpen && (
            <PillButton
              label={phase === 'saving' ? 'Connecting…' : 'Connect'}
              primary
              disabled={phase === 'saving' || requiredMissing}
              onClick={connect}
            />
          )}
        </div>
      </DialogShell>
    </div>
  )
}

function TextField({
  field,
  value,
  onChange,
}: {
  field: CredentialField
  value: string
  onChange: (v: string) => void
}) {
  const id = `connect-${field.key}`
  return (
    <div>
      <label htmlFor={id} className="block text-[12.6px] font-medium leading-[1.3] text-ink-2">
        {field.title || field.key}
        {field.required && <span className="ml-1 text-ink-3">*</span>}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-[4px] h-[34px] w-full rounded-[9px] border-[0.5px] border-hairline bg-fill-soft px-[10px] text-[13px] text-ink outline-none focus-visible:border-[color-mix(in_oklab,var(--sm-accent)_55%,transparent)]"
      />
    </div>
  )
}

function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-[11px] flex items-center gap-3 text-[11.5px] text-ink-3">
      <span className="h-px flex-1 bg-hairline" />
      {children}
      <span className="h-px flex-1 bg-hairline" />
    </div>
  )
}

function PillButton({
  label,
  primary,
  disabled,
  onClick,
}: {
  label: string
  primary?: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-[34px] items-center gap-2 rounded-full border-[0.5px] border-hairline px-[15px]',
        'text-[13.4px] tracking-[-0.05px] text-ink sm-t-morph',
        primary ? 'bg-fill-soft-2 font-semibold' : 'bg-transparent font-medium hover:bg-fill-soft',
        disabled && 'cursor-default opacity-45 hover:bg-transparent',
      )}
    >
      {label}
    </button>
  )
}

function CheckMark() {
  return (
    <span
      aria-hidden
      className="grid size-[18px] place-items-center rounded-full text-white"
      style={{ background: 'color-mix(in oklab, var(--sm-accent) 78%, black 6%)' }}
    >
      <Check className="size-3" />
    </span>
  )
}

function TwoDot() {
  return (
    <span aria-hidden className="inline-flex items-center gap-1">
      <span className="size-1.5 animate-pulse rounded-full bg-current" />
      <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
    </span>
  )
}
