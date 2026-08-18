// Ephemeral "is a blocking overlay open?" gate.
//
// A tiny reference-counted flag that modal surfaces (the ⌘K command palette, and
// any future full-screen sheet that must own the viewport) raise while they are
// open. Its ONE consumer today is the onboarding WelcomeBanner, which is a fixed
// top-anchored coachmark: without this gate it renders ABOVE an open command
// palette and occludes the palette's search input + first rows (and, being fixed,
// no z-index tweak alone reliably hides it behind every overlay across themes).
//
// NOT persisted and NOT part of `ui-store` (which is a localStorage-backed
// PREFERENCES store): this is transient view state that must reset to 0 on every
// reload. A COUNTER, not a boolean, so two overlays open at once can't have the
// first one's close prematurely re-show the banner.
//
// Contract: a modal calls `openOverlay()` on mount/open and MUST call the
// returned disposer exactly once on close/unmount (an effect cleanup is the
// natural home). `useOverlayOpen()` is the read hook for consumers.

import { create } from 'zustand'

interface OverlayGateStore {
  /** Number of blocking overlays currently open. */
  count: number
  /** Raise the gate; returns a disposer that lowers it exactly once. */
  openOverlay: () => () => void
}

export const useOverlayGate = create<OverlayGateStore>((set) => ({
  count: 0,
  openOverlay: () => {
    set((s) => ({ count: s.count + 1 }))
    let released = false
    return () => {
      if (released) return
      released = true
      set((s) => ({ count: Math.max(0, s.count - 1) }))
    }
  },
}))

/** `true` while at least one blocking overlay is open. */
export function useOverlayOpen(): boolean {
  return useOverlayGate((s) => s.count > 0)
}
