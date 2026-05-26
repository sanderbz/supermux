// TeamCard — the first-class container that OWNS an Agent Team (AT-F-FRONT / F1,
// plan §5.1–§5.3). A glass panel (rounded-xl, border-border, bg-card — the SAME
// chrome as a tile) that renders in EVERY overview sort mode, server-formed,
// NOT renameable/deletable, NO drag handle. It is the opposite of the custom-mode
// GroupHeader divider (rename/delete-able, custom-mode-only) — deleting a divider
// must never imply killing live agents, so we deliberately do NOT reuse it.
//
// STRUCTURE:
//   • Header: team name + the two-tier attention-first roll-up (§5.2) + the
//     per-team Chips↔Cards density toggle (§5.3 / F5).
//   • Lead: rendered as a FULL session tile at the top (reusing <SessionTile>,
//     fed from /api/sessions by `lead_supermux_session`). The lead IS a normal
//     supermux session; teammates are NOT.
//   • Teammates: below the lead — CHIPS (default, mobile) or CARDS (desktop /
//     toggled) per the density preference.
//
// Peek + focus state is owned here: a chip/card opens a teammate peek (half-sheet)
// or full-screen focus, both read-only (AT-E teammate WS).

import * as React from 'react'
import { AnimatePresence } from 'framer-motion'

import { cn } from '@/lib/utils'
import { useSession } from '@/hooks/use-sessions'
import { useTeamDensity, type TeamDensity } from '@/stores/team-density-store'
import {
  useTeamWidth,
  TEAM_WIDTH_PX,
  type TeamWidth,
} from '@/stores/team-width-store'
import { SessionTile } from '@/components/session-tile'
import type { TileSession } from '@/components/session-tile'
import type { OverviewSize } from '@/lib/overview-size'
import { type Team, type TeamMember } from '@/lib/api/teams'
import { TeamRollupBadges } from './team-rollup-badges'
import { TeammateChip } from './teammate-chip'
import { TeammateCard } from './teammate-card'
import { TeammatePeekSheet } from './teammate-peek-sheet'
import { TeammateFocus } from './teammate-focus'
import { TeamWidthToggle } from './team-width-toggle'

export interface TeamCardProps {
  team: Team
  /** Density tier passed through to the lead's <SessionTile> so the lead matches
   *  the overview's current size. */
  sizeTier?: OverviewSize
  /** True while the overview is in custom (drag) mode — disables the chip's own
   *  long-press (the @dnd-kit TouchSensor owns that gesture). The TEAM CARD
   *  itself is never draggable regardless. */
  customMode?: boolean
}

export function TeamCard({ team, sizeTier, customMode }: TeamCardProps) {
  const [density, setDensity] = useTeamDensity(team.team_name)
  // Per-team desktop width tier (FEAT-RESIZE). The store defaults to `'full'`
  // so the overview reads identically to today until the user opts in. The
  // outer `<section>` reads the tier and applies a max-width (`full` ⇒ no
  // cap), and the overview's flex-wrap container lays sibling cards out
  // accordingly. Mobile (< sm) ignores the value entirely (the wrapper drops
  // the max-width below `sm` so every card is full-width there — see below).
  const [width, setWidth] = useTeamWidth(team.team_name)
  // Peek (half-sheet) + focus (full-screen) state — by member NAME so it survives
  // an SSE snapshot replace (the member object identity changes each tick).
  const [peekName, setPeekName] = React.useState<string | null>(null)
  const [focusName, setFocusName] = React.useState<string | null>(null)

  // The lead IS a normal supermux session — read it from the shared sessions
  // cache by `lead_supermux_session`. Null when unmapped this tick or not yet in
  // the cache (the card still renders its header + teammates).
  const leadSession = useSession(team.lead_supermux_session ?? '').session

  const members = team.members
  const peekMember = members.find((m) => m.name === peekName) ?? null
  const focusMember = members.find((m) => m.name === focusName) ?? null

  const openPeek = React.useCallback((name: string) => setPeekName(name), [])
  const openFocus = React.useCallback((name: string) => {
    setPeekName(null)
    setFocusName(name)
  }, [])

  // Width tier → desktop sizing tokens (FEAT-RESIZE). Applied as inline style
  // so the four tiers are JIT-safe without flooding the Tailwind class list.
  // Mobile (< sm) ALWAYS gets `width: 100%` + `flex: '1 1 100%'` so the card
  // stays full-width regardless of tier — the resize feature is desktop-only.
  // On `sm:` and up the per-team tier kicks in:
  //   • `full`  → no cap (the row's lone card OR fills remaining flex space)
  //   • else    → max-width = tier ceiling, flex-basis = ceiling so wrapping
  //               siblings honour the tier instead of crashing into each other.
  // `flex: '1 1 <basis>'` lets a single card on a row still claim the full
  // width gracefully (the only sibling would be empty space), while
  // `max-width` keeps it from running past its tier when peers are present.
  const widthStyle = useTeamCardWidthStyle(width)

  return (
    <section
      aria-label={`Team ${team.team_name}`}
      style={widthStyle}
      className="flex w-full flex-col gap-2.5 rounded-xl border border-border bg-card p-2.5 transition-[max-width,flex-basis] duration-200 sm:p-3"
    >
      <TeamRollup
        team={team}
        density={density}
        onDensityChange={setDensity}
        width={width}
        onWidthChange={setWidth}
      />

      {/* Lead — a FULL session tile (reused). When the lead session isn't in the
          cache (unmapped this tick) we show a calm placeholder so the card never
          looks broken. The "Lead" label lives in the header row (next to the team
          name) — NOT overlaid on the tile — so it can never collide with the
          tile's own title / status dot / hover controls at any density tier. */}
      {leadSession ? (
        <SessionTile
          session={leadSession as TileSession}
          sizeTier={sizeTier}
        />
      ) : (
        <div className="flex h-16 items-center justify-center rounded-xl border border-dashed border-border/60 px-3 text-center text-xs text-muted-foreground">
          {team.lead_supermux_session
            ? 'Lead session starting…'
            : 'Lead not mapped to a session right now'}
        </div>
      )}

      {/* Teammates — chips (default) or cards (toggled). */}
      {members.length === 0 ? (
        <div className="px-1 py-1 text-xs text-muted-foreground/70">
          No teammates yet.
        </div>
      ) : density === 'cards' ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {members.map((m) => (
            <TeammateCard
              key={m.agent_id}
              team={team}
              member={m}
              onFocus={() => openFocus(m.name)}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {members.map((m) => (
            <TeammateChip
              key={m.agent_id}
              team={team}
              member={m}
              customMode={customMode}
              onFocus={() => openFocus(m.name)}
              onPeek={() => openPeek(m.name)}
            />
          ))}
        </div>
      )}

      {/* Calm note: teammates are split-panes inside the lead's session, so
          stopping the lead ends the whole team. Surfaced quietly (muted, no
          colour, no icon) only when there's both a lead and teammates — it sets
          expectation before the user ever reaches the lead's Stop confirm. */}
      {leadSession && members.length > 0 && (
        <p className="px-1 text-[11px] leading-snug text-muted-foreground/60">
          Stopping the lead ends the whole team — its teammates are panes in the
          lead’s session.
        </p>
      )}

      {/* Teammate peek (half-sheet). */}
      {peekMember && (
        <TeammatePeekSheet
          team={team}
          member={peekMember}
          open={!!peekName}
          onOpenChange={(o) => {
            if (!o) setPeekName(null)
          }}
          onFocus={() => openFocus(peekMember.name)}
        />
      )}

      {/* Teammate full-screen focus (read-only). */}
      <AnimatePresence>
        {focusMember && (
          <TeammateFocus
            team={team}
            member={focusMember}
            onSelectMember={(name) => setFocusName(name)}
            onClose={() => setFocusName(null)}
          />
        )}
      </AnimatePresence>
    </section>
  )
}

// ── Roll-up header (§5.2) ────────────────────────────────────────────────────
// Attention-first: ONE loud token when present (the blue `needs you · N` pill in
// the tile waiting-pill geometry) else a calm green "done"; a muted, tabular
// secondary (`N agents · X/Y tasks`) that drops first on a narrow screen. We do
// NOT show a "working" number — it's the implicit default (per-member spinners
// already show it). The density toggle (Chips↔Cards) sits at the trailing edge.
//
// The two attention badges (primary token + muted secondary) are the SHARED
// <TeamRollupBadges> — the SAME markup the focus session-strip header renders —
// so the roll-up never drifts between the overview and focus views.

function TeamRollup({
  team,
  density,
  onDensityChange,
  width,
  onWidthChange,
}: {
  team: Team
  density: TeamDensity
  onDensityChange: (d: TeamDensity) => void
  width: TeamWidth
  onWidthChange: (w: TeamWidth) => void
}) {
  // At the Compact (360px) tier the header chrome (4-segment width toggle +
  // 2-segment density toggle + needs-you pill + "Lead" tag + muted secondary)
  // genuinely doesn't fit ~340px usable. Drop the muted "Lead" tag and the
  // muted secondary AT Compact so the loud needs-you/done pill + toggles stay
  // legible and the team name keeps its identity (see also h2 min-w below).
  const isCompact = width === 'compact'
  return (
    <header className="flex items-center gap-2 px-0.5">
      {/* Team name — the stable identity. min-w keeps a few characters always
          visible so the name never collapses to 0 even when chrome is dense. */}
      <h2 className="min-w-[5ch] shrink truncate text-sm font-semibold tracking-tight">
        {team.team_name}
      </h2>

      {/* "Lead" tag — inline here (not overlaid on the tile) so it labels the
          hierarchy. Dropped at the Compact card width: the lead tile sitting
          right below is already unmistakable on its own. */}
      {!isCompact && (
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground">
          Lead
        </span>
      )}

      {/* Shared attention badges (primary token + muted, tabular secondary).
          `hideSecondary` is gated on CARD width (not viewport) — at Compact the
          card itself is too narrow regardless of the screen size. */}
      <TeamRollupBadges team={team} density="card" hideSecondary={isCompact} />

      {/* Width toggle — per-team TEAM CARD width (FEAT-RESIZE). Desktop-only
          (the component itself is `hidden sm:flex`); the narrow screen always
          renders the card full-width, so the control would be a no-op. Sits
          just before the density toggle so the two read as one pair of
          per-team chrome controls. `ml-auto` so the toggle cluster stays
          right-aligned even when the secondary badge is hidden on narrow. */}
      <TeamWidthToggle
        value={width}
        onChange={onWidthChange}
        className="ml-auto"
      />

      {/* Density toggle — per-team Chips↔Cards (NOT the global controls). On
          desktop it sits next to the width toggle; on mobile (where the width
          toggle is hidden) it keeps its own `ml-auto` so the cluster is still
          right-aligned. */}
      <div className="ml-auto sm:ml-2">
        <DensityToggle value={density} onChange={onDensityChange} />
      </div>
    </header>
  )
}

// ── Width tier → sizing style (FEAT-RESIZE) ──────────────────────────────────
// The TEAM CARD wrapper applies these as inline style: max-width caps the
// card at the chosen tier, flex-basis seeds the flex-wrap parent so siblings
// honour the cap when they share a row. `full` → no cap (current behaviour).
// Mobile (< sm) overrides this via a matchMedia hook so every card stays
// full-width below the breakpoint regardless of the chosen tier.

function useTeamCardWidthStyle(width: TeamWidth): React.CSSProperties {
  // Track viewport against the Tailwind `sm` breakpoint (640px). Below it, we
  // collapse every tier to full-width so the resize feature is truly
  // desktop-only and mobile sees the historical behaviour. matchMedia (vs
  // `useMediaQuery`) keeps the dep set local to this hook + avoids importing
  // the project hook just for one boolean here.
  const [isDesktop, setIsDesktop] = React.useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true
    return window.matchMedia('(min-width: 640px)').matches
  })
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(min-width: 640px)')
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    // addEventListener is the modern API; fall back to addListener for the
    // (vanishingly rare) old Safari that still ships the legacy form.
    if (mql.addEventListener) mql.addEventListener('change', onChange)
    else mql.addListener(onChange)
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange)
      else mql.removeListener(onChange)
    }
  }, [])

  // Mobile OR `full` tier → no cap. `flex: 1 1 100%` so the card occupies its
  // entire row even when sibling cards (different teams) coexist on desktop.
  if (!isDesktop || width === 'full') {
    return { maxWidth: '100%', flex: '1 1 100%' }
  }
  const px = TEAM_WIDTH_PX[width]
  // Desktop, non-full: cap the card at the tier's px ceiling, but let it
  // GROW within that ceiling so a lone card on a row still feels balanced
  // (not pinned to the left edge with empty space beside it). The grow
  // factor is `1` so multiple sub-Full cards on the same row share leftover
  // space proportionally up to their caps.
  return { maxWidth: `${px}px`, flex: `1 1 ${px}px` }
}

// ── Chips↔Cards density toggle (F5) ──────────────────────────────────────────
// A compact segmented control matching the overview <ViewToggle> geometry (h-8,
// rounded-lg, bg-muted) so it reads as native chrome. Per-team, persisted.

function DensityToggle({
  value,
  onChange,
}: {
  value: TeamDensity
  onChange: (d: TeamDensity) => void
}) {
  const items: { mode: TeamDensity; label: string; icon: React.ReactNode }[] = [
    { mode: 'chips', label: 'Chips', icon: <ChipsGlyph /> },
    { mode: 'cards', label: 'Cards', icon: <CardsGlyph /> },
  ]
  return (
    <div
      role="group"
      aria-label="Teammate density"
      className="flex h-8 items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {items.map(({ mode, label, icon }) => {
        const active = value === mode
        return (
          <button
            key={mode}
            type="button"
            aria-label={`${label} view`}
            aria-pressed={active}
            title={`${label} view`}
            onClick={() => onChange(mode)}
            className={cn(
              'flex size-7 items-center justify-center rounded-md transition-colors',
              active
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {icon}
          </button>
        )
      })}
    </div>
  )
}

/** Chips glyph — two stacked thin rows (compact). */
function ChipsGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4" fill="currentColor">
      <rect x="2" y="4" width="12" height="3" rx="1.5" />
      <rect x="2" y="9" width="12" height="3" rx="1.5" />
    </svg>
  )
}

/** Cards glyph — a 2×2 grid of cards (richer). */
function CardsGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4" fill="currentColor">
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  )
}

// `member` type re-exported for convenience to any future TEAM CARD consumer.
export type { TeamMember }
