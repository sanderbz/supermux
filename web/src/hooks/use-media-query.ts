// useMediaQuery — subscribe to a CSS media query.
//
// Used to fork tile behaviour by input modality: `pointer: fine` enables the
// desktop hover-peek; `pointer: coarse` enables tap + long-press. Also forks the
// focus route by viewport (`min-width: 768px`, focus.tsx) — desktop split vs the
// mobile Vaul sheet.
//
// Implemented with `useSyncExternalStore` (React 18/19's canonical primitive for
// reading an external, mutable source). This matters for the focus fork: opening
// a terminal navigates inside a View Transition that wraps the route swap in
// `flushSync` (morph.tsx). `useSyncExternalStore` guarantees React reads the
// match value CONSISTENTLY at commit time — the value React renders is the value
// the subscription holds, with no tearing and no stale-subscription window. A
// `useState`+`useEffect` pair, by contrast, leaves a gap between the lazy initial
// read and the effect that re-subscribes; during a `flushSync` commit that gap
// can let the rendered branch diverge from the live media state for a single
// COMMITTED frame — and that frame is exactly what `::view-transition-new(root)`
// snapshots and cross-fades, so it surfaces as a one-frame desktop↔mobile flash
// even though the live DOM (sampled post-commit) only ever shows desktop.
// `useSyncExternalStore` closes that gap by construction.
//
// SSR-safe: `getServerSnapshot` returns `false` (no `matchMedia` off-DOM), and on
// the client the first read comes straight from `window.matchMedia(...).matches`.

import { useCallback, useSyncExternalStore } from 'react'

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && 'matchMedia' in window
}

export function useMediaQuery(query: string): boolean {
  // Subscribe: register a `change` listener on the MediaQueryList so REAL
  // viewport/input changes (e.g. dragging the window across the 768px breakpoint)
  // re-render. Keyed on `query` via useCallback so a changed query re-subscribes.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!hasMatchMedia()) return () => {}
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onStoreChange)
      return () => mql.removeEventListener('change', onStoreChange)
    },
    [query],
  )

  // getSnapshot: the source of truth React reads at every render AND at commit.
  // Reading `matchMedia(...).matches` live here (not from cached state) is what
  // keeps the rendered branch in lockstep with the actual media state — no
  // transient flip during the View Transition's flushSync commit.
  const getSnapshot = useCallback(
    () => (hasMatchMedia() ? window.matchMedia(query).matches : false),
    [query],
  )

  // getServerSnapshot: SSR / no-DOM fallback (matches the previous behaviour).
  const getServerSnapshot = useCallback(() => false, [])

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
