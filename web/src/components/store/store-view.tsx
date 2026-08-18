// The store surface — header + search, Featured rail, category chips, card grid.
// One reusable body rendered in three containers: the `/store` route, the
// bot-scoped sheet, and the dev bench. Scope is a prop (`grantTarget`): `null` is
// the library view (Get / Grant… chips), a bot slug pre-scopes the connect flow
// so one tap installs + connects + grants to that bot.
//
// Skinned with the app's shadcn tokens so it reads identically in base mode and
// both themes; `[data-grok]` layers the frosted-glass treatment via `store.css`
// (scoped, so removing the attribute is a byte-exact revert).
import * as React from 'react'
import { Search, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  connectorToolCount,
  type ConnectorCard as Card,
  type SessionConnector,
} from '@/lib/api/connectors'
import { useConnectors, useSessionConnectors } from '@/stores/connectors-store'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'

import { CATEGORIES } from './catalog'
import { ConnectorCard } from './connector-card'
import { ConnectorDetail } from './connector-detail'
import { ConnectorIcon } from './connector-icon'
import type { GrantScope } from './grant-control'
import './store.css'

export interface StoreViewProps {
  /** The active grant scope: a bot slug, `*`, or `null` (library view). */
  grantTarget?: string | null
  /** Offline bench: render these cards instead of the live query. */
  mock?: Card[]
  /** Offline bench: seed the "granted" set (connector ids). */
  mockGranted?: { bot?: string[]; all?: string[] }
  /** `page` (the /store route) or `sheet` (bot-scoped dock). */
  variant?: 'page' | 'sheet'
}

export function StoreView({
  grantTarget = null,
  mock,
  mockGranted,
  variant = 'page',
}: StoreViewProps) {
  const botName = grantTarget && grantTarget !== '*' ? grantTarget : null
  const [q, setQ] = React.useState('')
  const [cat, setCat] = React.useState('all')
  const [openId, setOpenId] = React.useState<string | null>(null)

  const live = useConnectors(mock ? { source: 'local' } : {})
  const cards: Card[] = mock ?? live.data ?? []

  // Grant state: all-agents grants (library "Added" + the shared tag) and, in a
  // bot scope, that bot's own grants.
  const allGrants = useSessionConnectors(mock ? null : '*')
  const botGrants = useSessionConnectors(mock ? null : botName)
  const allSet = React.useMemo(
    () => new Set(mockGranted?.all ?? idsOf(allGrants.data)),
    [allGrants.data, mockGranted],
  )
  const botSet = React.useMemo(
    () => new Set(mockGranted?.bot ?? idsOf(botGrants.data)),
    [botGrants.data, mockGranted],
  )

  const grantedFor = React.useCallback(
    (id: string): GrantScope => {
      if (allSet.has(id)) return 'all'
      if (botName && botSet.has(id)) return 'bot'
      return null
    },
    [allSet, botSet, botName],
  )

  const featured = React.useMemo(() => cards.filter((c) => c.featured), [cards])

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase()
    return cards.filter((c) => {
      if (cat !== 'all') {
        if (cat === 'featured' ? !c.featured : !(c.categories ?? []).includes(cat)) return false
      }
      if (!needle) return true
      return (
        c.display_name.toLowerCase().includes(needle) ||
        c.id.toLowerCase().includes(needle) ||
        c.description.toLowerCase().includes(needle)
      )
    })
  }, [cards, q, cat])

  const openCard = cards.find((c) => c.id === openId) ?? null
  const isRow = variant === 'sheet'

  return (
    <div className={cn('cs-root flex min-h-0 flex-1 flex-col', variant === 'page' && 'mx-auto w-full max-w-[1120px]')}>
      {/* header */}
      <div className="cs-header sticky top-0 z-10 flex flex-col gap-3 px-4 pb-3 pt-4 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[24px] font-semibold tracking-tight text-foreground sm:text-[28px]">Connectors</h1>
            <p className="mt-0.5 text-[13.5px] text-muted-foreground">
              {botName ? `Give ${botName} the tools it needs.` : 'Give your bots the tools they need.'}
            </p>
          </div>
          <SearchBox value={q} onChange={setQ} />
        </div>

        {/* category chips */}
        <div className="cs-chips -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setCat(c.key)}
              aria-pressed={cat === c.key}
              className={cn(
                'shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors',
                cat === c.key
                  ? 'bg-foreground text-background'
                  : 'bg-secondary text-muted-foreground hover:text-foreground',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-1 sm:px-6">
        {/* featured rail — only at rest (no search, All/Featured) */}
        {!q && (cat === 'all' || cat === 'featured') && featured.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">Featured</h2>
            <div className="cs-rail -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
              {featured.map((c) => (
                <FeaturedCard
                  key={c.id}
                  card={c}
                  onOpen={() => setOpenId(c.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* the grid */}
        {live.isLoading && !mock ? (
          <GridSkeleton />
        ) : filtered.length === 0 ? (
          <EmptyState q={q} />
        ) : (
          <div
            className={cn(
              isRow
                ? 'flex flex-col gap-2'
                : 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3',
            )}
          >
            {filtered.map((c) => (
              <ConnectorCard
                key={c.id}
                card={c}
                installed={c.source === 'local'}
                granted={grantedFor(c.id)}
                botScope={!!botName}
                layout={isRow ? 'row' : 'grid'}
                onOpen={() => setOpenId(c.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* detail sheet */}
      {openCard && (
        <ResponsiveSheet
          open={!!openId}
          onOpenChange={(o) => !o && setOpenId(null)}
          title={openCard.display_name}
          description={botName ? `For ${botName}` : 'Connector'}
        >
          <div data-grok>
            <ConnectorDetail
              card={openCard}
              installed={openCard.source === 'local'}
              granted={grantedFor(openCard.id)}
              grantTarget={grantTarget}
              onDone={() => setOpenId(null)}
            />
          </div>
        </ResponsiveSheet>
      )}
    </div>
  )
}

// ── pieces ────────────────────────────────────────────────────────────────────

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative flex w-full max-w-[280px] items-center">
      <Search className="pointer-events-none absolute left-3 size-4 text-muted-foreground" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search connectors"
        aria-label="Search connectors"
        className="h-10 w-full rounded-full border border-border bg-card pl-9 pr-9 text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-2 grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  )
}

function FeaturedCard({ card, onOpen }: { card: Card; onOpen: () => void }) {
  const n = connectorToolCount(card)
  return (
    <button
      type="button"
      onClick={onOpen}
      data-vr="connector-featured"
      className="cs-featured group relative flex w-[248px] shrink-0 snap-start flex-col justify-between overflow-hidden rounded-[22px] border border-border bg-card p-4 text-left transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[0_10px_32px_-16px_rgba(0,0,0,0.4)]"
    >
      <span className="cs-featured-glow pointer-events-none absolute inset-0 opacity-70" aria-hidden />
      <span className="relative flex items-start justify-between">
        <ConnectorIcon card={card} size={52} />
      </span>
      <span className="relative mt-4 flex flex-col">
        <span className="text-[16px] font-semibold text-foreground">{card.display_name}</span>
        <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">{card.description}</span>
        {n !== null && (
          <span className="mt-2 text-[11.5px] font-medium tabular-nums text-muted-foreground">{n} tools</span>
        )}
      </span>
    </button>
  )
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-[168px] animate-pulse rounded-[20px] border border-border bg-muted/40" />
      ))}
    </div>
  )
}

function EmptyState({ q }: { q: string }) {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-border py-16 text-center">
      <p className="text-[14px] font-medium text-foreground">
        {q ? `No connectors match "${q}"` : 'No connectors yet'}
      </p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {q ? 'Try a different search or category.' : 'Import a .mcpb bundle or wait for the catalog to warm up.'}
      </p>
    </div>
  )
}

function idsOf(list: SessionConnector[] | undefined): string[] {
  return (list ?? []).filter((g) => g.enabled).map((g) => g.connector_id)
}
