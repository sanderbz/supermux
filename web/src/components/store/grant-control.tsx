// The per-bot grant control — the differentiator, shown not hidden.
//
// "Grant to → This bot · All agents", a segmented control that lands a grant on
// the exact scope (`POST /{id}/grant { session_name }` — a bot slug or the `*`
// all-agents sentinel), plus a Revoke. Reused on the card, the detail sheet, and
// the bot-panel Tools-tab row.
//
// Honest about a shared grant: when a connector is granted via `*`, the "This
// bot" side reads "via all agents" and per-bot revoke is disabled — you revoke
// the `*` grant globally, never phantom-revoke a shared one from one bot.
import * as React from 'react'
import { Check, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { ALL_AGENTS } from '@/lib/api/connectors'
import { useConnectorActions } from '@/stores/connectors-store'

export type GrantScope = 'bot' | 'all' | null

export function GrantControl({
  connectorId,
  botName,
  scope,
  onGranted,
  onRevoked,
  compact,
}: {
  connectorId: string
  /** The bot this control grants to. `null` = library view (only All agents). */
  botName: string | null
  /** Current grant state for this connector against this scope. */
  scope: GrantScope
  onGranted?: (target: string, restartHint: boolean) => void
  onRevoked?: (target: string) => void
  compact?: boolean
}) {
  const actions = useConnectorActions()
  const [busy, setBusy] = React.useState<'bot' | 'all' | 'revoke' | null>(null)

  const grantTo = async (which: 'bot' | 'all') => {
    if (busy) return
    const target = which === 'all' ? ALL_AGENTS : botName
    if (!target) return
    setBusy(which)
    try {
      const restart = await actions.grant(connectorId, target)
      onGranted?.(target, restart)
    } finally {
      setBusy(null)
    }
  }

  const revoke = async () => {
    if (busy) return
    const target = scope === 'all' ? ALL_AGENTS : botName
    if (!target) return
    setBusy('revoke')
    try {
      await actions.revoke(connectorId, target)
      onRevoked?.(target)
    } finally {
      setBusy(null)
    }
  }

  const sharedGrant = scope === 'all'

  return (
    <div className={cn('flex flex-col gap-2', compact && 'gap-1.5')}>
      <div className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
        Grant to
      </div>
      <div
        role="radiogroup"
        aria-label="Grant scope"
        className="inline-flex items-stretch gap-0.5 self-start rounded-xl bg-secondary p-1"
      >
        <ScopeButton
          selected={scope === 'bot'}
          disabled={!botName || busy !== null}
          busy={busy === 'bot'}
          onClick={() => grantTo('bot')}
          label={botName ? `This bot` : 'This bot'}
          sub={botName ?? undefined}
        />
        <ScopeButton
          selected={scope === 'all'}
          disabled={busy !== null}
          busy={busy === 'all'}
          onClick={() => grantTo('all')}
          label="All agents"
        />
      </div>

      {scope !== null && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          {sharedGrant && botName ? (
            <span>
              Shared via <span className="font-medium text-foreground">all agents</span> — revoke it
              from the store to remove it everywhere.
            </span>
          ) : (
            <button
              type="button"
              onClick={revoke}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              {busy === 'revoke' && <Loader2 className="size-3 animate-spin" aria-hidden />}
              Revoke
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ScopeButton({
  selected,
  disabled,
  busy,
  onClick,
  label,
  sub,
}: {
  selected: boolean
  disabled?: boolean
  busy?: boolean
  onClick: () => void
  label: string
  sub?: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-colors',
        selected
          ? 'bg-white text-foreground shadow-sm dark:bg-white/15'
          : 'text-muted-foreground hover:text-foreground',
        disabled && 'cursor-default opacity-60',
      )}
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : selected ? (
        <Check className="size-3.5" aria-hidden />
      ) : null}
      <span className="flex flex-col items-start leading-none">
        <span>{label}</span>
        {sub && <span className="mt-0.5 max-w-[9ch] truncate text-[10px] text-muted-foreground">{sub}</span>}
      </span>
    </button>
  )
}
