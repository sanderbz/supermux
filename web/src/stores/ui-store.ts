// Ephemeral UI preferences.
//
// Zustand + `persist` → localStorage, so these survive a browser restart with no
// backend round-trip (acceptance bar: "change default view / default
// model, restart browser, settings retained"). TanStack Query stays the source
// of truth for *server* data; this store holds only client-side UI choices.
//
// NOTE on theme: the shell already owns theme via <ThemeProvider> (it must
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
import {
  capPins,
  prune,
  setPref,
  type Renderer,
  type RendererPref,
  type RendererState,
} from '@/components/chat/renderer-pref'

export type ViewMode = 'tile' | 'list'

/** Overview tile hover behaviour.
 *  - `live`     — hover opens a scaled-down LIVE terminal (default).
 *  - `expanded` — hover expands the static preview to ~20 coloured lines. */
export type HoverPreview = 'live' | 'expanded'

/** Overview tile PREVIEW mode — the master switch for what an overview tile may
 *  show, distinct from `hoverPreview` (which only chooses BETWEEN the two live-
 *  mode hover behaviours).
 *  - `live` — the tile may open a scaled-down LIVE terminal peek (default;
 *    hover-warmed via a WebSocket). Honours `hoverPreview` for the exact hover
 *    behaviour.
 *  - `text` — the tile shows ONLY the static, coloured text tail (the
 *    `TailPreview`), both at rest and on hover. No live xterm peek, no live WS
 *    peek connection (no hover-warm, no on-hover connect) — saves resources. */
export type OverviewPreview = 'live' | 'text'

interface UIStore {
  /** Overview default layout. */
  viewMode: ViewMode
  /** Default `--model` flag for new sessions ('' = server default). */
  defaultModel: string
  /** What an overview tile shows on hover. Only
   *  consulted while `overviewPreview === 'live'`. */
  hoverPreview: HoverPreview
  /** Master overview-tile preview mode: live xterm peek vs static text tail
   *  only. `text` suppresses the live peek + its WS
   *  entirely — at rest and on hover. */
  overviewPreview: OverviewPreview
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
  /** Files route: show dotfiles (`.claude`, `.config`, …). Default `true` so
   *  the dirs users actually want to open from the Files page are visible
   *  without hunting for the eye toggle. Persisted so the choice survives
   *  reloads/navigation — was previously local React state that reset on every
   *  route mount. */
  showHidden: boolean
  /** Hide `stopped` sessions across the overview AND the focus strip — one
   *  global filter behind the shared Eye/EyeOff toggle (the focus strip's old
   *  per-surface localStorage flag folds into this). Default `false`: stopped
   *  sessions are shown until the user opts to hide them. */
  hideStopped: boolean
  /** Companies (Bot Mode) — the ACTIVE company scope the whole roster reads.
   *  `null` = HQ (the main/PA space that shows only `company_id`-null bots); a
   *  number scopes to that company. Additive persisted field — a brand-new key
   *  defaults cleanly for existing `version:1` blobs, so no `migrate` change is
   *  needed. Mirrors `hideStopped`'s field+setter shape. */
  activeCompany: number | null
  setActiveCompany: (id: number | null) => void
  /** Bot mode — the ONE unified flag (merges the former `chatRenderer` +
   *  `grokMode`). When ON: (1) the shell root carries `data-grok` and the
   *  scoped token layer (styles/grok-mode.css) restyles the whole app in Grok's
   *  visual language, and (2) eligible LOCAL Claude sessions default to the
   *  read-only chat renderer at the focus seam (terminal one tap away).
   *  Kill-switches (checked in lib/bot-mode-flag.ts + components/chat/flag.ts):
   *  the master `localStorage['supermux:bot-mode'] = '0'` force-disables BOTH;
   *  the legacy scoped kills still work — `supermux:grok-mode='0'` kills only
   *  the skin, `supermux:chat-renderer='0'` kills only the renderer. The skin
   *  is read ONCE at mount (a skin flip is a reload-level change, not a live
   *  re-render). Default OFF — the default flip ships in a later, separate PR. */
  botMode: boolean
  setBotMode: (v: boolean) => void
  /** Fase A5 — the GLOBAL default renderer for eligible sessions at `auto`.
   *  Only ever `chat` or `terminal`; the buck stops here (`auto` is the
   *  per-session fixpoint, not a default). Takes effect only once the
   *  `chatRenderer` experiment is on, which is what keeps `chat` safe as the
   *  shipped value — the default FLIP is fase A7, never here. */
  defaultRenderer: Renderer
  /** Fase A5 — per-session pins. A session at `auto` is ABSENT from this map,
   *  never stored as `'auto'`. Bounded by `MAX_PINS` on rehydrate and pruned
   *  against the FULL sessions list once the query settles. */
  rendererOverrides: Record<string, Renderer>
  setDefaultRenderer: (r: Renderer) => void
  setRendererPref: (name: string, p: RendererPref) => void
  /** Pass the FULL sessions list — never a filtered / hide-stopped view, or a
   *  merely hidden session loses its pin. */
  pruneRendererOverrides: (liveNames: readonly string[]) => void
  /** Adopt an account-wide blob from `/api/prefs/session_renderer` (a peer tab
   *  or another device). Whole-value; the sync hook does the conflict scoping. */
  applyRendererPrefs: (next: RendererState) => void
  setViewMode: (v: ViewMode) => void
  setDefaultModel: (m: string) => void
  setHoverPreview: (h: HoverPreview) => void
  setOverviewPreview: (p: OverviewPreview) => void
  setOverviewSize: (s: OverviewSize) => void
  setOverviewSizeMobile: (s: OverviewSize) => void
  setShowHidden: (v: boolean) => void
  setHideStopped: (v: boolean) => void
}

export const useUI = create<UIStore>()(
  persist(
    (set) => ({
      viewMode: 'tile',
      defaultModel: '',
      hoverPreview: 'live',
      overviewPreview: 'live',
      overviewSize: MIN_OVERVIEW_SIZE,
      overviewSizeMobile: MIN_OVERVIEW_SIZE,
      showHidden: true,
      hideStopped: false,
      activeCompany: null,
      botMode: false,
      setBotMode: (botMode) => set({ botMode }),
      defaultRenderer: 'chat',
      rendererOverrides: {},
      setDefaultRenderer: (defaultRenderer) => set({ defaultRenderer }),
      setRendererPref: (name, p) =>
        set((s) => ({
          rendererOverrides: setPref(
            { defaultRenderer: s.defaultRenderer, overrides: s.rendererOverrides },
            name,
            p,
          ).overrides,
        })),
      pruneRendererOverrides: (liveNames) =>
        set((s) => ({
          rendererOverrides: prune(
            { defaultRenderer: s.defaultRenderer, overrides: s.rendererOverrides },
            liveNames,
          ).overrides,
        })),
      applyRendererPrefs: (next) =>
        set({
          defaultRenderer: next.defaultRenderer,
          rendererOverrides: next.overrides,
        }),
      setViewMode: (viewMode) => set({ viewMode }),
      setDefaultModel: (defaultModel) => set({ defaultModel }),
      setHoverPreview: (hoverPreview) => set({ hoverPreview }),
      setOverviewPreview: (overviewPreview) => set({ overviewPreview }),
      setOverviewSize: (overviewSize) =>
        set({ overviewSize: clampOverviewSize(overviewSize) }),
      setOverviewSizeMobile: (overviewSizeMobile) =>
        set({ overviewSizeMobile: clampOverviewSizeMobile(overviewSizeMobile) }),
      setShowHidden: (showHidden) => set({ showHidden }),
      setHideStopped: (hideStopped) => set({ hideStopped }),
      setActiveCompany: (activeCompany) => set({ activeCompany }),
    }),
    {
      name: 'supermux-ui',
      // Persist schema version. v1 folds the two former experiment flags
      // (`chatRenderer` + `grokMode`) into ONE `botMode`. `migrate` runs BEFORE
      // `onRehydrateStorage`, so the rehydrate hook below sees the migrated
      // shape unaffected.
      version: 1,
      migrate: (persisted, from) => {
        const p = (persisted ?? {}) as Record<string, unknown>
        if (from < 1) {
          // Owner-approved OR: bot mode is on if EITHER old flag was on.
          p.botMode = !!(p.grokMode || p.chatRenderer)
          delete p.grokMode
          delete p.chatRenderer
        }
        return p as unknown as UIStore
      },
      // One-time migration: the focus strip used to keep its OWN hide-stopped
      // flag in localStorage; it's now this shared value. Carry a pre-existing
      // preference over exactly once — at boot, before any surface can toggle it
      // (so it can't race a user toggle) — then drop the legacy key.
      onRehydrateStorage: () => (state) => {
        if (!state || typeof window === 'undefined') return
        // Fase A5 — hard-cap the rehydrated pin map. `capPins`, not `prune`:
        // no sessions list exists yet, and pruning against an empty one would
        // delete every pin the user ever made. The liveness prune runs later,
        // from the overview, once the query resolves.
        const capped = capPins({
          defaultRenderer: state.defaultRenderer,
          overrides: state.rendererOverrides,
        })
        if (capped.overrides !== state.rendererOverrides) {
          state.applyRendererPrefs(capped)
        }
        try {
          const legacy = window.localStorage.getItem('supermux:focus-strip:hide-stopped')
          if (legacy === null) return
          if (legacy === '1' && !state.hideStopped) state.setHideStopped(true)
          window.localStorage.removeItem('supermux:focus-strip:hide-stopped')
        } catch {
          /* private mode / quota — non-fatal */
        }
      },
    },
  ),
)
