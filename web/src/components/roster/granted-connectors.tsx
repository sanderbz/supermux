// The bot-panel Tools-tab connector surface — replaces the dead "Coming with the
// connector store" placeholder. Lists THIS bot's granted connectors (own +
// all-agents), each with a status dot, an at-a-glance enable toggle, and a
// one-tap restart affordance; plus a premium "Add connector" primary that opens
// the bot-scoped store sheet. A "Needs sign-in" chip deep-links straight to that
// connector's sign-in flow.
import * as React from 'react'
import { AlertTriangle, Loader2, Plus, RotateCw } from 'lucide-react'

import { cn } from '@/lib/utils'
import { companyGrantKey, connectorNeedsCredential, toolCountLabel, type SessionConnector } from '@/lib/api/connectors'
import { useSessionConnectors, useConnectorActions } from '@/stores/connectors-store'
import { useSession } from '@/hooks/use-sessions'
import { useRecovery } from '@/hooks/use-recovery'
import { useArmedConfirm } from '@/hooks/use-armed-confirm'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { ConnectorIcon } from '@/components/store/connector-icon'
import { GrantControl } from '@/components/store/grant-control'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// The bot-scoped store sheet is the heaviest child (the whole catalog grid). It
// only ever renders on demand, so it is code-split into the /store chunk instead
// of riding the main app bundle.
const StoreView = React.lazy(() =>
  import('@/components/store/store-view').then((m) => ({ default: m.StoreView })),
)

/** A bot mid-turn (active/working) shouldn't lose its turn to an accidental
 *  restart — arm-confirm those; an idle bot restarts on the first tap. */
function isMidTurn(status?: string): boolean {
  return status === 'active' || status === 'working'
}

/**
 * The one-tap "Restart to apply" action — the button the restart HINT never had.
 * Reuses the atomic `restart` rung (`useRecovery`), the SAME lifecycle the header
 * actions menu drives, so the add-grant → restart → live loop closes in place.
 * Shared by the per-row hint here and the panel-level `RestartHint` in bot-panel.
 */
export function RestartToApply({
  name,
  className,
}: {
  name: string
  className?: string
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
      {busy ? 'Restarting…' : armed ? 'Restart now — loses this turn' : 'Restart to apply'}
    </button>
  )
}

export function GrantedConnectors({ name }: { name: string }) {
  const { data, isLoading, isError } = useSessionConnectors(name)
  // `null` = closed. A string = open on that connector's detail (the sign-in
  // path). The empty string sentinel `''` opens the catalog grid (plain "Add").
  const [store, setStore] = React.useState<string | null>(null)
  const [restartPending, setRestartPending] = React.useState<Set<string>>(new Set())

  // Which of this bot's grants come via a broader scope, so the row can say WHY
  // it has each connector. A `*` (all-agents) grant, and — if this bot belongs to
  // a company — a company grant (`@company:<id>`). We tell them apart by reading
  // each scope's own set. All-agents wins the label over company (broadest first).
  const { data: allGrants } = useSessionConnectors('*')
  const allSet = React.useMemo(
    () => new Set((allGrants ?? []).filter((g) => g.enabled).map((g) => g.connector_id)),
    [allGrants],
  )
  const { session } = useSession(name)
  const companyId = session?.company_id ?? null
  const { data: companyGrants } = useSessionConnectors(
    companyId !== null ? companyGrantKey(companyId) : null,
  )
  const companySet = React.useMemo(
    () => new Set((companyGrants ?? []).filter((g) => g.enabled).map((g) => g.connector_id)),
    [companyGrants],
  )

  const grants = data ?? []
  const flagRestart = React.useCallback((id: string) => {
    setRestartPending((s) => new Set(s).add(id))
  }, [])
  const openAdd = React.useCallback(() => setStore(''), [])
  const openSignIn = React.useCallback((id: string) => setStore(id), [])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[13px] font-semibold tracking-tight text-foreground">Connectors</h3>
          <p className="text-[12px] leading-snug text-muted-foreground">
            Secure integrations granted to this bot.
          </p>
        </div>
        {/* The ONE clean add action per bot — promoted from a quiet outline to the
            accent primary, so it reads as the section's call to action. */}
        <button
          type="button"
          onClick={openAdd}
          data-vr="connector-add"
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-[10px] bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-3.5" aria-hidden />
          Add connector
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading…
        </div>
      ) : grants.length === 0 ? (
        <button
          type="button"
          onClick={openAdd}
          data-vr="connector-empty"
          className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-left text-[13px] text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {isError
            ? 'Connectors are unavailable right now.'
            : 'Give this bot its first connector →'}
        </button>
      ) : (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
          {grants.map((g) => (
            <ConnectorRow
              key={g.connector_id}
              grant={g}
              botName={name}
              viaAll={allSet.has(g.connector_id)}
              viaCompany={!allSet.has(g.connector_id) && companySet.has(g.connector_id)}
              restartPending={restartPending.has(g.connector_id)}
              onRestartPending={() => flagRestart(g.connector_id)}
              onSignIn={() => openSignIn(g.connector_id)}
            />
          ))}
        </ul>
      )}

      <ResponsiveSheet
        open={store !== null}
        onOpenChange={(o) => !o && setStore(null)}
        title="Add a connector"
        description={`For ${name}`}
        className="max-w-3xl"
      >
        <div data-grok className="min-h-[60vh]">
          <React.Suspense fallback={null}>
            {store !== null && (
              // Key on the open target so a "Needs sign-in" deep-link remounts
              // straight onto that connector's detail even if the sheet was just
              // opened on the grid.
              <StoreView
                key={store || 'grid'}
                grantTarget={name}
                variant="sheet"
                initialOpenId={store || undefined}
              />
            )}
          </React.Suspense>
        </div>
      </ResponsiveSheet>
    </div>
  )
}

function ConnectorRow({
  grant,
  botName,
  viaAll,
  viaCompany,
  restartPending,
  onRestartPending,
  onSignIn,
}: {
  grant: SessionConnector
  botName: string
  viaAll: boolean
  viaCompany: boolean
  restartPending: boolean
  onRestartPending: () => void
  onSignIn: () => void
}) {
  const card = grant.card
  const tools = card ? toolCountLabel(card) : ''
  // "Needs sign-in" now derives from the connector's real AUTH LANE, not the old
  // `!has_secret && credentials.some(sensitive)` heuristic that painted a hosted
  // mcp_oauth connector (no vaulted secret, signs in in the terminal) a false green
  // "Active" AND flagged a no-auth `none` connector as needing a sign-in it doesn't.
  // Only the paste / supermux-OAuth lanes count as "needs a credential from you".
  const needsSignIn = card ? connectorNeedsCredential(card) && !grant.has_secret : false
  const actions = useConnectorActions()
  const [busy, setBusy] = React.useState(false)

  // A grant reaching this bot via a broader scope (all-agents OR its company) is
  // read-only on this row — you flip it from the store, at that scope.
  const shared = viaAll || viaCompany

  // Own-grant rows get an at-a-glance enable toggle (lifted out of the ⋯ menu);
  // a shared grant is read-only here — you flip it from the store, globally.
  const toggle = async () => {
    if (busy || shared) return
    setBusy(true)
    try {
      const restart = await actions.setEnabled(grant.connector_id, botName, !grant.enabled)
      if (restart) onRestartPending()
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex items-center gap-3">
        {card ? (
          <ConnectorIcon card={card} size={36} />
        ) : (
          <span className="size-9 shrink-0 rounded-[10px] bg-muted" aria-hidden />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-foreground">
              {card?.display_name ?? grant.connector_id}
            </span>
            {tools && <span className="text-[11.5px] tabular-nums text-muted-foreground">{tools}</span>}
          </span>
          <span className="mt-0.5 text-[11.5px] text-muted-foreground">
            {viaAll ? 'via all agents' : viaCompany ? 'via company' : 'this bot'}
          </span>
        </div>

        {/* status / affordance cluster */}
        {needsSignIn ? (
          <StatusChip needsSignIn onSignIn={onSignIn} />
        ) : restartPending ? (
          <StatusChip restartPending />
        ) : shared ? (
          // Shared grants (all-agents / company) are read-only here — show state,
          // not a control.
          <StatusChip enabled={grant.enabled} />
        ) : (
          <RowToggle enabled={grant.enabled} busy={busy} onToggle={toggle} />
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Connector grant options"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span aria-hidden className="text-lg leading-none">⋯</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64 p-3">
            <GrantControl
              connectorId={grant.connector_id}
              botName={botName}
              scope={viaAll ? 'all' : viaCompany ? 'company' : 'bot'}
              compact
              onGranted={(_t, restart) => restart && onRestartPending()}
              onRevoked={() => onRestartPending()}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {restartPending && (
        <div className="ml-[3rem] flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-status-active-ink">
            <AlertTriangle className="size-3 shrink-0" aria-hidden />
            Restart to apply this grant.
          </span>
          <RestartToApply name={botName} />
        </div>
      )}
    </li>
  )
}

/** The at-a-glance enable/disable switch, lifted onto own-grant rows (was buried
 *  in the ⋯ menu). role="switch" so it reads as the toggle it is. */
function RowToggle({
  enabled,
  busy,
  onToggle,
}: {
  enabled: boolean
  busy: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? 'Disable this connector' : 'Enable this connector'}
      onClick={onToggle}
      disabled={busy}
      data-vr="connector-toggle"
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
        enabled ? 'justify-end bg-status-ready' : 'justify-start bg-muted-foreground/35',
      )}
    >
      <span
        className="inline-flex size-4 items-center justify-center rounded-full bg-white shadow-sm"
      >
        {busy && <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden />}
      </span>
    </button>
  )
}

function StatusChip({
  enabled,
  needsSignIn,
  restartPending,
  onSignIn,
}: {
  enabled?: boolean
  needsSignIn?: boolean
  restartPending?: boolean
  onSignIn?: () => void
}) {
  if (needsSignIn) {
    // Actionable: opens the connector's sign-in flow instead of sitting inert.
    return (
      <button
        type="button"
        onClick={onSignIn}
        data-vr="connector-signin"
        aria-label="Sign in to this connector"
        className="inline-flex items-center gap-1 rounded-full bg-status-active/12 px-2.5 py-1 text-[11.5px] font-semibold text-status-active-ink transition-colors hover:bg-status-active/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Needs sign-in
      </button>
    )
  }
  if (restartPending) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-status-active/12 px-2.5 py-1 text-[11.5px] font-medium text-status-active-ink">
        Restart
      </span>
    )
  }
  if (!enabled) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground">
        Disabled
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-status-ready/12 px-2.5 py-1 text-[11.5px] font-medium text-status-ready-ink">
      <span className="size-1.5 rounded-full bg-status-ready" aria-hidden />
      Active
    </span>
  )
}
