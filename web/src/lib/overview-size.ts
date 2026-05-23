// Overview density / size tiers (card-sizes-rework).
//
// NEW ALGORITHM — height-first, then column-drop progression:
//
//   Tier 1 (default)  cols=4   +20px height vs the historical baseline
//   Tier 2 (first +)  cols=4   +~50% MORE height (same column count)
//   Tier 3 (second +) cols=3   one fewer column → wider cards (keep tier 2 height)
//   Tier 4 (third +)  cols=2   another column drop (cap — minimum 2 cols on desktop)
//
// Design intent: gentle progression — first you get more vertical room (more
// preview lines visible), THEN you start trading column count for width. Tier
// transitions feel natural, not jarring. The chrome (HEADER_H, font sizes) does
// NOT scale — only the spatial mass — so type hierarchy reads the same at every
// tier and the live-zoom xterm keeps its native font size while FitAddon picks
// up more cols×rows in the bigger container (user mandate: scale the container,
// don't warp xterm).
//
// Persistence: localStorage via the existing `useUI` store (Zustand `persist`,
// `supermux-ui` namespace — unchanged from feat-overview-sizes).
// Per-device, not per-account — a phone vs desktop wants different defaults.
//
// Default tier is 1 — first visit shows the historical baseline + 20px so the
// preview area breathes without a jolt.

export type OverviewSize = 1 | 2 | 3 | 4
export const OVERVIEW_SIZES: OverviewSize[] = [1, 2, 3, 4]
export const MIN_OVERVIEW_SIZE: OverviewSize = 1
export const MAX_OVERVIEW_SIZE: OverviewSize = 4

/** Per-tier geometry.
 *
 *  - `idleLines`     number of tail-preview lines reserved in the idle tile.
 *  - `idleBonusPx`   additional pixels added to the non-peek tile height
 *                    (the user's "+20px hoger default" — a baseline offset,
 *                    not a multiplier, so the increment reads as room and not
 *                    as zoom).
 *  - `livePreviewPx` height of the live-zoom hover terminal viewport. Scales
 *                    proportionally with the tier (tier 2+ ≈ +50% on tier 1)
 *                    so the peek grows with the card.
 *  - `gridColsLg`    desktop (≥ lg / 1024px) column count.
 *  - `gridColsMd`    tablet  (md..lg) column count.
 *  - `tileMinPx`     CSS `minmax(<minPx>, 1fr)` so the grid still gracefully
 *                    drops a column on a narrow window even within a tier.
 *  - `containerMaxRem` overview container max-width — grows at lower-column
 *                    tiers so the wider cards get breathing room instead of
 *                    crashing into the viewport edge.
 *  - `label`         sentence-case tooltip / aria label.
 */
export interface OverviewSizeConfig {
  tier: OverviewSize
  idleLines: number
  idleBonusPx: number
  livePreviewPx: number
  gridColsLg: number
  gridColsMd: number
  tileMinPx: number
  containerMaxRem: number
  label: string
}

// Tier-1 baseline: 6 idle lines + a +20px non-peek height bonus (user spec —
// "size 1 like 20px hoger default"). Tier 2 = ~+50% height (12 idle lines,
// since each line is 14px the math comes out to ~+84px on a ~176px tile, so
// the perceived growth is the requested "noticeably taller, more preview
// content visible"). Tiers 3 & 4 hold the tier-2 vertical room and drop one
// column per step — cards get WIDER, not taller. Two columns is the desktop
// floor (going below feels like a list view, not an overview).
const CONFIGS: Record<OverviewSize, OverviewSizeConfig> = {
  1: {
    tier: 1,
    idleLines: 6,
    idleBonusPx: 20,
    livePreviewPx: 250, // 230 (historical) + 20 (matches the idle bonus baseline)
    gridColsLg: 4,
    gridColsMd: 3,
    tileMinPx: 260,
    containerMaxRem: 82, // 1312px — matches the historical polish-pass baseline
    label: 'Compact',
  },
  2: {
    tier: 2,
    idleLines: 12, // 6 × 2 idle lines → +~50% height vs tier 1 (preview alone +84px)
    idleBonusPx: 20,
    livePreviewPx: 375, // 250 × 1.5 — proportional to the tile growth
    gridColsLg: 4,
    gridColsMd: 3,
    tileMinPx: 260,
    containerMaxRem: 82,
    label: 'Roomy',
  },
  3: {
    tier: 3,
    idleLines: 12, // hold tier-2 vertical room — column drop is the change
    idleBonusPx: 20,
    livePreviewPx: 375,
    gridColsLg: 3, // one fewer column → wider cards
    gridColsMd: 2,
    tileMinPx: 320,
    containerMaxRem: 86, // 1376px — breathing room for the wider cards
    label: 'Wide',
  },
  4: {
    tier: 4,
    idleLines: 12,
    idleBonusPx: 20,
    livePreviewPx: 375,
    gridColsLg: 2, // floor: 2 columns on desktop
    gridColsMd: 2,
    tileMinPx: 400,
    containerMaxRem: 90, // 1440px
    label: 'Spacious',
  },
}

export function getOverviewSizeConfig(tier: OverviewSize): OverviewSizeConfig {
  return CONFIGS[tier] ?? CONFIGS[MIN_OVERVIEW_SIZE]
}

/** Clamp to the valid tier range (defensive against bad localStorage values). */
export function clampOverviewSize(n: number): OverviewSize {
  if (!Number.isFinite(n)) return MIN_OVERVIEW_SIZE
  const r = Math.round(n)
  if (r <= MIN_OVERVIEW_SIZE) return MIN_OVERVIEW_SIZE
  if (r >= MAX_OVERVIEW_SIZE) return MAX_OVERVIEW_SIZE
  return r as OverviewSize
}
