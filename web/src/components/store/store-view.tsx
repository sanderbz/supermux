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
import { companyGrantKey } from '@/lib/api/connectors'
import { useConnectors, useSessionConnectors } from '@/stores/connectors-store'
import { useUI } from '@/stores/ui-store'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'

import { CATEGORIES } from './catalog'
import { brandMark } from './brand-marks'
import { ConnectorCard, OfficialBadge, StateChip, chipFor } from './connector-card'
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
  mockGranted?: { bot?: string[]; company?: string[]; all?: string[] }
  /** Offline bench: seed the library "Grant to" bot picker (no `GET /api/sessions`). */
  mockBots?: { name: string; display_name?: string; status?: string }[]
  /** `page` (the /store route) or `sheet` (bot-scoped dock). */
  variant?: 'page' | 'sheet'
  /** Deep-link the sheet straight onto ONE connector's detail (its sign-in /
   *  grant flow) instead of the catalog grid — e.g. an actionable "Needs sign-in"
   *  chip on the bot panel. Seeds the open card; the back arrow returns to the grid. */
  initialOpenId?: string
  /** Offline bench only: the theme (`light`/`dark`) stamped as `data-theme` on the
   *  detail sheet's PORTALED content. The detail `ResponsiveSheet` renders through
   *  a Radix portal at `document.body`, so it escapes a slab's local `data-theme`
   *  wrapper and would otherwise inherit the ONE global `<html>` theme — which made
   *  a bench reviewer opening the sheet from the "light" slab see it in the global
   *  (dark) theme and mis-file it as "detail sheet dark in light mode". Undefined in
   *  production (default), where the single global theme already matches. */
  detailTheme?: 'light' | 'dark'
}

export function StoreView({
  grantTarget = null,
  mock,
  mockGranted,
  mockBots,
  variant = 'page',
  detailTheme,
  initialOpenId,
}: StoreViewProps) {
  const botName = grantTarget && grantTarget !== '*' ? grantTarget : null
  const [q, setQ] = React.useState('')
  const [cat, setCat] = React.useState('all')
  const [openId, setOpenId] = React.useState<string | null>(initialOpenId ?? null)

  const live = useConnectors(mock ? { source: 'local' } : {})
  const cards: Card[] = mock ?? live.data ?? []

  // Grant state: all-agents grants (library "Added" + the shared tag), the active
  // company's grants (the middle tier), and, in a bot scope, that bot's own grants.
  const activeCompany = useUI((s) => s.activeCompany)
  const companyKey = !mock && activeCompany !== null ? companyGrantKey(activeCompany) : null
  const allGrants = useSessionConnectors(mock ? null : '*')
  const companyGrants = useSessionConnectors(companyKey)
  const botGrants = useSessionConnectors(mock ? null : botName)
  const allSet = React.useMemo(
    () => new Set(mockGranted?.all ?? idsOf(allGrants.data)),
    [allGrants.data, mockGranted],
  )
  const companySet = React.useMemo(
    () => new Set(mockGranted?.company ?? idsOf(companyGrants.data)),
    [companyGrants.data, mockGranted],
  )
  const botSet = React.useMemo(
    () => new Set(mockGranted?.bot ?? idsOf(botGrants.data)),
    [botGrants.data, mockGranted],
  )

  const grantedFor = React.useCallback(
    (id: string): GrantScope => {
      // Broadest-first display idiom (matches the all-agents shared treatment):
      // all > company > this bot.
      if (allSet.has(id)) return 'all'
      if (companySet.has(id)) return 'company'
      if (botName && botSet.has(id)) return 'bot'
      return null
    },
    [allSet, companySet, botSet, botName],
  )

  // Featured is a curated highlight, not the whole catalog: cap the rail so it
  // reads as an editorial shelf and never sprawls (blocker H1). In a bot scope
  // (row layout) the rail is skipped entirely — the sheet is a working list.
  const featured = React.useMemo(() => cards.filter((c) => c.featured).slice(0, 3), [cards])

  // The featured rail is only shown at rest (no search, All/Featured) and not in
  // the row/sheet layout — matches the render condition below.
  const railVisible = !q && (cat === 'all' || cat === 'featured') && variant === 'page'
  const featuredIds = React.useMemo(
    () => (railVisible ? new Set(featured.map((c) => c.id)) : new Set<string>()),
    [railVisible, featured],
  )

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase()
    return cards.filter((c) => {
      // Don't repeat the Featured cards as the first grid rows (blocker H1).
      if (featuredIds.has(c.id)) return false
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
  }, [cards, q, cat, featuredIds])

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
                'shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-[transform,color,background-color] duration-100 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
        {/* featured — a filling responsive shelf at rest (no search, All/Featured).
            A grid, not a fixed-width scroll rail, so a short curated set never
            leaves a dead void on wide desktops (blocker H1). */}
        {railVisible && featured.length > 0 && (
          <section className="mb-7">
            <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">Featured</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {featured.map((c) => (
                <FeaturedCard
                  key={c.id}
                  card={c}
                  installed={c.source === 'local'}
                  granted={grantedFor(c.id)}
                  botScope={!!botName}
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
          contentTheme={detailTheme}
        >
          {/* `detailTheme` (bench only) stamps the sheet shell via `contentTheme`; the
              `[data-grok]` skin here resolves against that `[data-theme='…']` root
              (grok-mode's `[data-theme='…'] [data-grok]` rules). Production leaves
              `detailTheme` undefined and the portal inherits the global theme. */}
          <div data-grok>
            <ConnectorDetail
              card={openCard}
              installed={openCard.source === 'local'}
              granted={grantedFor(openCard.id)}
              grantTarget={grantTarget}
              onDone={() => setOpenId(null)}
              botsOverride={mockBots}
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
    <div className="cs-search relative flex w-full max-w-[280px] items-center">
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

// The one-line subtitle for the hero. A curated `card.hook` (an editorial line)
// when present, otherwise the connector's REAL functional description — the same
// accurate one-liner the browse/detail cards show. Never a generic "A featured X
// connector." filler: curated catalog cards ship no hook, so that fallback used
// to surface on every hero (the owner's complaint). The description is always a
// real, connector-specific sentence.
function heroHook(card: Card): string {
  return card.hook?.trim() || card.description
}

function FeaturedCard({
  card,
  installed,
  granted,
  botScope,
  onOpen,
}: {
  card: Card
  installed: boolean
  granted: GrantScope
  botScope: boolean
  onOpen: () => void
}) {
  const tools = connectorToolCount(card)
  const chip = chipFor(installed, granted, botScope)
  const brand = brandMark(card)
  // The hero wash is the connector's OWN brand hue — editorial, distinct from the
  // calm grid card below it (blocker H1). Falls back to the app primary.
  const hue = brand?.hex ?? 'var(--primary)'
  return (
    <div
      data-vr="connector-featured"
      className="cs-featured group relative flex min-h-[176px] flex-col justify-between overflow-hidden rounded-[22px] border border-border bg-card p-4 transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[0_12px_36px_-16px_rgba(0,0,0,0.42)] active:translate-y-0 active:shadow-none"
    >
      <span
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          background: `radial-gradient(130% 100% at 100% 0%, color-mix(in srgb, ${hue} 20%, transparent), transparent 62%)`,
        }}
      />
      {/* Brand artwork — the connector's real mark, large and translucent, bleeding
          off the top-right corner. Fills the hero's formerly-dead upper quadrant
          and earns the extra size (blocker H1); clipped by the card's overflow. */}
      {brand?.path && (
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="pointer-events-none absolute -right-5 -top-6 z-0 size-[132px] opacity-[0.07] transition-transform duration-200 group-hover:scale-105"
          fill={hue}
        >
          <path d={brand.path} />
        </svg>
      )}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${card.display_name}`}
        className="absolute inset-0 z-0 rounded-[22px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {/* Same card grammar as the grid below: icon top-left, name + tool-count
          INLINE beside it (never a top-right pill) — one anatomy down the page,
          the hero differs by size + artwork + hook, not by layout (blocker H3). */}
      <div className="pointer-events-none relative z-10 flex items-start gap-3">
        <ConnectorIcon card={card} size={48} className="cs-icon-lift transition-transform duration-150 group-hover:scale-[1.03]" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[16.5px] font-semibold leading-tight tracking-tight text-foreground">{card.display_name}</span>
            {card.official && <OfficialBadge />}
          </span>
          {tools !== null && (
            <div className="mt-1.5">
              <span className="inline-flex items-center rounded-full bg-background/60 px-2 py-0.5 text-[11.5px] font-medium tabular-nums text-muted-foreground backdrop-blur-sm">
                {tools} tools
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="relative z-10 mt-3 flex items-end justify-between gap-3">
        {/* The editorial hook — one curated line, distinct from the description. */}
        <p className="pointer-events-none min-w-0 flex-1 text-[13px] font-medium leading-snug text-foreground/80">
          {heroHook(card)}
        </p>
        <button type="button" onClick={onOpen} className="pointer-events-auto relative z-10 shrink-0" tabIndex={-1}>
          <StateChip kind={chip} />
        </button>
      </div>
    </div>
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
