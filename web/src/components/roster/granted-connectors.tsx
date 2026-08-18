// The bot-panel Tools-tab connector surface — replaces the dead "Coming with the
// connector store" placeholder. Lists THIS bot's granted connectors (own +
// all-agents), each with a status dot, a per-row grant control, and a restart
// affordance; plus "Add connector" which opens the bot-scoped store sheet.
import * as React from 'react'
import { AlertTriangle, Loader2, Plus } from 'lucide-react'

import { toolCountLabel, type SessionConnector } from '@/lib/api/connectors'
import { useSessionConnectors } from '@/stores/connectors-store'
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

export function GrantedConnectors({ name }: { name: string }) {
  const { data, isLoading, isError } = useSessionConnectors(name)
  const [storeOpen, setStoreOpen] = React.useState(false)
  const [restartPending, setRestartPending] = React.useState<Set<string>>(new Set())

  // Which of this bot's grants come from a `*` (all-agents) grant. We tell them
  // apart by also reading the all-agents set.
  const { data: allGrants } = useSessionConnectors('*')
  const allSet = React.useMemo(
    () => new Set((allGrants ?? []).filter((g) => g.enabled).map((g) => g.connector_id)),
    [allGrants],
  )

  const grants = data ?? []

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[13px] font-semibold tracking-tight text-foreground">Connectors</h3>
          <p className="text-[12px] leading-snug text-muted-foreground">
            Secure integrations granted to this bot.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setStoreOpen(true)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-[10px] border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          onClick={() => setStoreOpen(true)}
          className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-left text-[13px] text-muted-foreground transition-colors hover:bg-muted/50"
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
              restartPending={restartPending.has(g.connector_id)}
              onRestartPending={() =>
                setRestartPending((s) => new Set(s).add(g.connector_id))
              }
            />
          ))}
        </ul>
      )}

      <ResponsiveSheet
        open={storeOpen}
        onOpenChange={setStoreOpen}
        title="Add a connector"
        description={`For ${name}`}
        className="max-w-3xl"
      >
        <div data-grok className="min-h-[60vh]">
          <React.Suspense fallback={null}>
            <StoreView grantTarget={name} variant="sheet" />
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
  restartPending,
  onRestartPending,
}: {
  grant: SessionConnector
  botName: string
  viaAll: boolean
  restartPending: boolean
  onRestartPending: () => void
}) {
  const card = grant.card
  const tools = card ? toolCountLabel(card) : ''
  const needsSignIn = !grant.has_secret && card?.credentials?.some((c) => c.sensitive)

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
            {viaAll ? 'via all agents' : 'this bot'}
          </span>
        </div>
        <StatusChip
          enabled={grant.enabled}
          needsSignIn={!!needsSignIn}
          restartPending={restartPending}
        />
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
              scope={viaAll ? 'all' : 'bot'}
              compact
              onGranted={(_t, restart) => restart && onRestartPending()}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {restartPending && (
        <p className="ml-[3rem] inline-flex items-center gap-1.5 text-[11.5px] text-status-active-ink">
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          Restart the bot to apply this grant.
        </p>
      )}
    </li>
  )
}

function StatusChip({
  enabled,
  needsSignIn,
  restartPending,
}: {
  enabled: boolean
  needsSignIn: boolean
  restartPending: boolean
}) {
  if (needsSignIn) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-status-active/12 px-2.5 py-1 text-[11.5px] font-medium text-status-active-ink">
        Needs sign-in
      </span>
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
