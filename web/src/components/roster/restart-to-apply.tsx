/**
 * The one-tap "Restart to apply" action — the button the restart HINT never had.
 *
 * Its own module because THREE surfaces need it now: the bot-panel Tools tab, the
 * store detail's connected panel, and the in-chat Connect card. The chat card is
 * lazy-loaded into the transcript, so it must not drag the whole Tools-tab module
 * (and the store sheet it lazily references) along just to render one button.
 * `granted-connectors.tsx` re-exports this, so every existing importer is
 * unaffected.
 *
 * Reuses the atomic `restart` rung (`useRecovery`) — the SAME lifecycle the header
 * actions menu drives — so the add-grant → restart → live loop closes in place.
 */
import * as React from 'react'
import { Loader2, RotateCw } from 'lucide-react'

import { Check } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useSessionConnectors } from '@/stores/connectors-store'
import { useSession } from '@/hooks/use-sessions'
import { useRecovery } from '@/hooks/use-recovery'
import { useArmedConfirm } from '@/hooks/use-armed-confirm'

/** A bot mid-turn (active/working) shouldn't lose its turn to an accidental
 *  restart — arm-confirm those; an idle bot restarts on the first tap. */
export function isMidTurn(status?: string): boolean {
  return status === 'active' || status === 'working'
}

export function RestartToApply({
  name,
  className,
  /** Name the bot in the label ("Restart folderwijzer to apply") — for a surface
   *  that shows one row and would otherwise leave "to apply" hanging without a
   *  subject. The bot-panel list keeps the short label (the row names the bot). */
  withName,
  /** The bot's display name, when it differs from the session slug. */
  label,
}: {
  name: string
  className?: string
  withName?: boolean
  label?: string
}) {
  const { session } = useSession(name)
  const { run, pending } = useRecovery()
  const busy = pending === 'restart'
  const midTurn = isMidTurn(session?.status)

  const fire = React.useCallback(() => {
    void run(name, 'restart').catch(() => {})
  }, [run, name])
  // Mid-turn asks first (arm-confirm); idle fires on the first press.
  const confirm = useArmedConfirm({ onConfirm: fire })
  const onClick = midTurn ? confirm.press : fire
  const armed = midTurn && confirm.armed
  const rest = withName ? `Restart ${label || name} to apply` : 'Restart to apply'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-vr="connector-restart"
      aria-label={armed ? `Confirm restart of ${name}` : `Restart ${name} to apply`}
      className={cn(
        'inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
        armed
          ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
          : 'bg-status-active/15 text-status-active-ink hover:bg-status-active/25',
        className,
      )}
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <RotateCw className="size-3.5" aria-hidden />
      )}
      {busy ? 'Restarting…' : armed ? 'Restart now — loses this turn' : rest}
    </button>
  )
}

/**
 * One bot's SERVER-COMPUTED restart state for a connector: `!applied && running`
 * → the one-tap chip; already applied → a quiet "applied"; stopped → nothing at
 * all (its next start binds the grant, so nagging would be a lie).
 *
 * Server-computed is the point. `applied` comes from the session's `last_started`
 * against the grant's `granted_at`, so the hint survives the brokered sign-in's
 * full-page redirect — which is exactly the moment a React-local "restart
 * pending" flag is guaranteed to be gone.
 */
export function RestartIfNeeded({
  name,
  label,
  connectorId,
}: {
  name: string
  label?: string
  connectorId: string
}) {
  const { data } = useSessionConnectors(name)
  const grant = (data ?? []).find((g) => g.connector_id === connectorId)
  if (!grant || !grant.running) return null
  if (grant.applied === false) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <RestartToApply name={name} label={label} withName />
      </div>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-status-ready-ink">
      <Check className="size-3.5" aria-hidden />
      {label || name} · applied
    </span>
  )
}
