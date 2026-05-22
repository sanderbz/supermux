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
  setViewMode: (v: ViewMode) => void
  setDefaultModel: (m: string) => void
  setHoverPreview: (h: HoverPreview) => void
}

export const useUI = create<UIStore>()(
  persist(
    (set) => ({
      viewMode: 'tile',
      defaultModel: '',
      hoverPreview: 'live',
      setViewMode: (viewMode) => set({ viewMode }),
      setDefaultModel: (defaultModel) => set({ defaultModel }),
      setHoverPreview: (hoverPreview) => set({ hoverPreview }),
    }),
    { name: 'amux-v3-ui' },
  ),
)
