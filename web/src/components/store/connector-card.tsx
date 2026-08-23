// The connector card — the store's atom (§2.2) + the state-chip machine (§2.3).
//
// One face, one interactive affordance: the state chip. Everything else (icon,
// name, tool-count pill, description, kind dot) is calm and derived straight from
// the card shape. The chip's label is a function of (installed?, granted-to the
// active scope?) — see `chipFor`. Tapping the card (or its chip) opens the detail
// sheet, which hosts the connect / grant flow.
import * as React from 'react'
import { BadgeCheck, Check, MoreHorizontal, Sparkles } from 'lucide-react'

import { connectorAuthKind, toolCountLabel, type ConnectorCard as Card } from '@/lib/api/connectors'

import { ConnectorIcon } from './connector-icon'
import type { GrantScope } from './grant-control'

/** The chip's derived state. */
export type ChipKind = 'get' | 'connect' | 'grant' | 'added'

export function chipFor(installed: boolean, granted: GrantScope, botScope: boolean): ChipKind {
  if (granted) return 'added'
  if (botScope) return 'connect' // bot scope: one tap = install-if-needed + connect + grant
  if (installed) return 'grant' // library view, installed, not granted to any scope
  return 'get'
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
  // The provenance chip and the count chip, once — the same pair in both
  // layouts, so the built-in card answers "how many tools" exactly like the
  // catalog card beside it (jury STORE_CARD #2).
  const chips = (
    <>
      <EaseBadge card={card} />
      {card.kind === 'builtin_browser' && <ToolPill>built-in</ToolPill>}
      {tools && <ToolPill>{tools}</ToolPill>}
    </>
  )

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
            {card.official && <OfficialBadge />}
            {chips}
          </span>
          <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">{card.description}</span>
        </span>
        <StateChip kind={chip} />
      </button>
    )
  }

  return (
    <div
      data-vr="connector-card"
      className="cs-card group relative flex flex-col rounded-[20px] border border-border bg-card p-4 transition-[transform,box-shadow,background-color] duration-150 hover:-translate-y-0.5 hover:shadow-[0_8px_28px_-14px_rgba(0,0,0,0.35)] active:translate-y-0 active:shadow-none"
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
            {card.official && <OfficialBadge />}
          </div>
          {(tools || card.kind === 'builtin_browser' || connectorAuthKind(card) === 'mcp_oauth' || connectorAuthKind(card) === 'oauth_device' || connectorAuthKind(card) === 'oauth_redirect') && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{chips}</div>
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
            className='pointer-events-auto relative z-20 -mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors before:absolute before:-inset-2.5 before:content-[""] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        )}
      </div>

      <p className="pointer-events-none relative z-10 mt-2.5 line-clamp-2 min-h-[2.4em] text-[13px] leading-snug text-muted-foreground">
        {card.description}
      </p>

      {/* One interactive affordance, left-aligned. The connector KIND is surfaced
          on the detail sheet ("12 tools · Catalog"), not as an unlabelled dot on
          the card face (blocker H3). */}
      <div className="relative z-10 mt-3.5 flex items-center">
        <button
          type="button"
          onClick={onOpen}
          className="pointer-events-auto"
          tabIndex={-1}
        >
          <StateChip kind={chip} />
        </button>
      </div>
    </div>
  )
}

/** The ease pill — surfaces the zero-setup lanes so a non-technical user reaches
 *  for them first. `mcp_oauth` (the bot signs in in its own terminal, no app, no
 *  key) is the EASIEST; `oauth_device` is one-tap once an owner has enabled it.
 *  Grok-token styled and kept SUBTLE (quieter than the Official badge). Nothing
 *  for the paste/none lanes — the absence is the signal. */
export function EaseBadge({ card }: { card: Card }) {
  const kind = connectorAuthKind(card)
  if (kind === 'mcp_oauth') {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium"
        style={{ color: 'var(--gr-done)', background: 'color-mix(in oklab, var(--gr-done) 13%, transparent)' }}
        title="Easiest — your bot signs in from its own terminal. No app, no key to set up."
      >
        <Sparkles className="size-3" aria-hidden />
        Easiest
      </span>
    )
  }
  if (kind === 'oauth_device' || kind === 'oauth_redirect') {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
        style={{ background: 'color-mix(in oklab, var(--sm-accent) 10%, transparent)' }}
        title="One-tap sign-in — connect with a short code, no key to paste."
      >
        <Sparkles className="size-3" aria-hidden />
        1-tap
      </span>
    )
  }
  return null
}

/** The "Official" trust badge — a first-party Anthropic/MCP reference server. */
export function OfficialBadge({ label = false }: { label?: boolean }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
      title="Official — a first-party Anthropic MCP reference server"
    >
      <BadgeCheck className="size-3.5" aria-hidden />
      {label ? 'Official' : <span className="sr-only">Official</span>}
    </span>
  )
}

function ToolPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium tabular-nums text-foreground/75">
      {children}
    </span>
  )
}

export function StateChip({ kind }: { kind: ChipKind }) {
  if (kind === 'added') {
    // "Added" and nothing else. The trailing "· 5" read as five agents / five
    // grants as readily as five tools (jury STORE_CARD #2) — the count belongs
    // on the tool chip, which now carries it for every card alike.
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-status-ready/15 px-3 py-1.5 text-[12.5px] font-medium text-status-ready-ink">
        <Check className="size-3.5" aria-hidden />
        Added
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
  // One verb system end-to-end (blocker B3): Connect → Added · N → Grant…. The
  // library "get" and the bot-scope "connect" are the SAME action, one label.
  const label = 'Connect'
  return (
    <span className="cs-chip-primary inline-flex items-center rounded-full bg-primary px-4 py-1.5 text-[12.5px] font-semibold text-primary-foreground shadow-sm transition-transform duration-100 group-active:scale-95">
      {label}
    </span>
  )
}
