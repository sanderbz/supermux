// Ephemeral UI preferences (TECH_PLAN §4.6).
//
// Zustand + `persist` → localStorage, so these survive a browser restart with no
// backend round-trip (the M22 acceptance bar: "change default view / default
// model, restart browser, settings retained"). TanStack Query stays the source
// of truth for *server* data; this store holds only client-side UI choices.
//
// NOTE on theme: the M10 shell already owns theme via <ThemeProvider> (it must
// apply `.dark` before first paint to avoid a flash, so it can't live here).
// Settings → Appearance drives theme through `useTheme()`; this store covers the
// rest (default tile/list view, default model). One source of truth per setting.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import {
  clampOverviewSize,
  clampOverviewSizeMobile,
  MIN_OVERVIEW_SIZE,
  type OverviewSize,
} from '@/lib/overview-size'

export type ViewMode = 'tile' | 'list'

/** Overview tile hover behaviour.
 *  - `live`     — hover opens a scaled-down LIVE terminal (default).
 *  - `expanded` — hover expands the static preview to ~20 coloured lines. */
export type HoverPreview = 'live' | 'expanded'

interface UIStore {
  /** Overview default layout. */
  viewMode: ViewMode
  /** Default `--model` flag for new sessions ('' = server default). */
  defaultModel: string
  /** What an overview tile shows on hover (§ overview tile preview). */
  hoverPreview: HoverPreview
  /** Overview density tier — 1 = smallest (default, matches polish-pass), 4 =
   *  spacious. Per-device, not per-account (phone vs desktop want different
   *  defaults); see /lib/overview-size.ts. This is the DESKTOP/tablet (≥md)
   *  value; the coarse-pointer / phone value lives in `overviewSizeMobile` so
   *  the two never clobber each other (a phone tweak must not shrink the
   *  laptop's grid and vice-versa). */
  overviewSize: OverviewSize
  /** Overview density tier for mobile (coarse pointer / <md). Independent from
   *  `overviewSize` so phone and desktop sizes are saved separately. On mobile
   *  the grid is single-column, so the tier only changes tile HEIGHT (never the
   *  column count). Clamped to the mobile max tier (height-meaningful tiers
   *  only — see MAX_OVERVIEW_SIZE_MOBILE). */
  overviewSizeMobile: OverviewSize
  setViewMode: (v: ViewMode) => void
  setDefaultModel: (m: string) => void
  setHoverPreview: (h: HoverPreview) => void
  setOverviewSize: (s: OverviewSize) => void
  setOverviewSizeMobile: (s: OverviewSize) => void
}

export const useUI = create<UIStore>()(
  persist(
    (set) => ({
      viewMode: 'tile',
      defaultModel: '',
      hoverPreview: 'live',
      overviewSize: MIN_OVERVIEW_SIZE,
      overviewSizeMobile: MIN_OVERVIEW_SIZE,
      setViewMode: (viewMode) => set({ viewMode }),
      setDefaultModel: (defaultModel) => set({ defaultModel }),
      setHoverPreview: (hoverPreview) => set({ hoverPreview }),
      setOverviewSize: (overviewSize) =>
        set({ overviewSize: clampOverviewSize(overviewSize) }),
      setOverviewSizeMobile: (overviewSizeMobile) =>
        set({ overviewSizeMobile: clampOverviewSizeMobile(overviewSizeMobile) }),
    }),
    { name: 'supermux-ui' },
  ),
)
