// The connector card — the store's atom (§2.2) + the state-chip machine (§2.3).
//
// One face, one interactive affordance: the state chip. Everything else (icon,
// name, tool-count pill, description, kind dot) is calm and derived straight from
// the card shape. The chip's label is a function of (installed?, granted-to the
// active scope?) — see `chipFor`. Tapping the card (or its chip) opens the detail
// sheet, which hosts the connect / grant flow.
import * as React from 'react'
import { Check, MoreHorizontal } from 'lucide-react'

import { cn } from '@/lib/utils'
import { toolCountLabel, type ConnectorCard as Card } from '@/lib/api/connectors'

import { ConnectorIcon } from './connector-icon'
import type { GrantScope } from './grant-control'

/** The chip's derived state. */
type ChipKind = 'get' | 'connect' | 'grant' | 'added'

function chipFor(installed: boolean, granted: GrantScope, botScope: boolean): ChipKind {
  if (granted) return 'added'
  if (botScope) return 'connect' // bot scope: one tap = install-if-needed + connect + grant
  if (installed) return 'grant' // library view, installed, not granted to any scope
  return 'get'
}

const KIND_DOT: Record<string, { label: string; className: string }> = {
  mcp_catalog: { label: 'From the catalog', className: 'bg-sky-500' },
  agent_authored: { label: 'Agent-authored', className: 'bg-violet-500' },
  builtin_browser: { label: 'Built-in', className: 'bg-emerald-500' },
}

export function ConnectorCard({
  card,
  installed,
  granted,
  botScope,
  onOpen,
  onMenu,
  layout = 'grid',
}: {
  card: Card
  installed: boolean
  granted: GrantScope
  /** True when the active scope is a specific bot (chip reads "Connect"). */
  botScope: boolean
  onOpen: () => void
  onMenu?: () => void
  /** `grid` (desktop tile) or `row` (mobile / bot-panel list). */
  layout?: 'grid' | 'row'
}) {
  const chip = chipFor(installed, granted, botScope)
  const tools = toolCountLabel(card)
  const dot = KIND_DOT[card.kind] ?? { label: card.kind, className: 'bg-muted-foreground' }
  const n = card.tools?.length || card.tool_count || 0

  if (layout === 'row') {
    return (
      <button
        type="button"
        onClick={onOpen}
        data-vr="connector-row"
        className="cs-card cs-row group flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ConnectorIcon card={card} size={40} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-foreground">{card.display_name}</span>
            {tools && <ToolPill>{tools}</ToolPill>}
          </span>
          <span className="mt-0.5 line-clamp-1 text-[12.5px] text-muted-foreground">{card.description}</span>
        </span>
        <StateChip kind={chip} count={n} />
      </button>
    )
  }

  return (
    <div
      data-vr="connector-card"
      className="cs-card group relative flex flex-col rounded-[20px] border border-border bg-card p-4 transition-[transform,box-shadow,background-color] duration-150 hover:-translate-y-0.5 hover:shadow-[0_8px_28px_-14px_rgba(0,0,0,0.35)]"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${card.display_name}`}
        className="absolute inset-0 z-0 rounded-[20px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="pointer-events-none relative z-10 flex items-start gap-3">
        <ConnectorIcon card={card} size={44} className="cs-icon-lift transition-transform duration-150 group-hover:scale-[1.02]" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[15px] font-medium leading-tight text-foreground">{card.display_name}</h3>
          </div>
          {tools && (
            <div className="mt-1.5">
              <ToolPill>{tools}</ToolPill>
            </div>
          )}
        </div>
        {onMenu && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onMenu()
            }}
            aria-label="Connector options"
            className="pointer-events-auto relative z-20 -mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        )}
      </div>

      <p className="pointer-events-none relative z-10 mt-2.5 line-clamp-2 min-h-[2.4em] text-[13px] leading-snug text-muted-foreground">
        {card.description}
      </p>

      <div className="relative z-10 mt-3.5 flex items-center justify-between">
        <button
          type="button"
          onClick={onOpen}
          className="pointer-events-auto"
          tabIndex={-1}
        >
          <StateChip kind={chip} count={n} />
        </button>
        <span className="pointer-events-auto flex items-center gap-1.5 text-[11px] text-muted-foreground" title={dot.label}>
          <span className={cn('size-1.5 rounded-full', dot.className)} aria-hidden />
        </span>
      </div>
    </div>
  )
}

function ToolPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium tabular-nums text-muted-foreground">
      {children}
    </span>
  )
}

function StateChip({ kind, count }: { kind: ChipKind; count: number }) {
  if (kind === 'added') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-status-ready/15 px-3 py-1.5 text-[12.5px] font-medium text-status-ready-ink">
        <Check className="size-3.5" aria-hidden />
        Added{count ? ` · ${count}` : ''}
      </span>
    )
  }
  if (kind === 'grant') {
    return (
      <span className="inline-flex items-center rounded-full border border-border bg-secondary px-3.5 py-1.5 text-[12.5px] font-medium text-foreground">
        Grant…
      </span>
    )
  }
  const label = kind === 'get' ? 'Get' : 'Connect'
  return (
    <span className="cs-chip-primary inline-flex items-center rounded-full bg-primary px-4 py-1.5 text-[12.5px] font-semibold text-primary-foreground shadow-sm">
      {label}
    </span>
  )
}
