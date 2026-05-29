// View Transitions — the route-morph helper.
//
// `navigateMorph(to)` wraps a react-router `navigate()` in the browser's View
// Transitions API: `document.startViewTransition(() => flushSync(() => navigate))`.
// The `flushSync` is load-bearing — `startViewTransition` snapshots the OLD DOM,
// runs the callback, then snapshots the NEW DOM and cross-fades / morphs between
// them. React 18+ batches state updates, so without `flushSync` the route swap
// would land AFTER the snapshot and nothing would animate. On browsers without
// the API (Safari < 18, Firefox) it degrades to a plain, instant `navigate()`.
//
// Shared-element morph: any element that carries the SAME `view-transition-name`
// in both the old and new DOM is matched and tweened (position + size). The
// session tile sets `view-transition-name: session-<name>` (see tile.tsx /
// `vtTileName`); the focus header sets the SAME name on its title block — so a
// tile visually flies into the focus header. Names MUST be unique per snapshot,
// so only ONE tile may carry a given name at a time; that holds because the
// overview unmounts on navigate.
//
// Reduced motion: `::view-transition-*` animations are disabled wholesale in
// globals.css under `@media (prefers-reduced-motion: reduce)` — the navigation
// still happens, just with a hard cut. We ALSO skip `startViewTransition`
// entirely when reduced motion is set, so no snapshot work is done at all.

import * as React from 'react'
import { flushSync } from 'react-dom'
import { useNavigate, type NavigateOptions, type To } from 'react-router-dom'

/** Feature-detect the View Transitions API once (it never changes at runtime). */
export const supportsViewTransitions =
  typeof document !== 'undefined' &&
  typeof (document as Document & { startViewTransition?: unknown })
    .startViewTransition === 'function'

/** True when the user has asked the OS to minimise motion. Read live (not
 *  cached) so toggling the setting takes effect without a reload. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

type DocWithVT = Document & {
  startViewTransition: (cb: () => void) => { finished: Promise<void> }
}

/**
 * Run `apply` inside a View Transition when the platform supports it and the
 * user has not requested reduced motion; otherwise run it directly. `apply` is
 * wrapped in `flushSync` so React commits the DOM change inside the transition's
 * capture window. Exported for non-navigation morphs (e.g. a layout flip).
 */
export function withViewTransition(apply: () => void): void {
  if (!supportsViewTransitions || prefersReducedMotion()) {
    apply()
    return
  }
  ;(document as DocWithVT).startViewTransition(() => flushSync(apply))
}

/** Build the canonical `view-transition-name` for a session — used by BOTH the
 *  overview tile and the focus header so they morph into each other. Session
 *  names may contain characters illegal in a CSS custom-ident, so sanitise; the
 *  `vt-session-` prefix keeps it collision-free with other named elements. */
export function vtSessionName(sessionName: string): string {
  return `vt-session-${sessionName.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

/**
 * `useNavigateMorph()` — returns a `navigate`-shaped function that performs the
 * route change inside a View Transition. Drop-in for `useNavigate()` at any call
 * site that wants the overview↔focus morph.
 */
export function useNavigateMorph() {
  const navigate = useNavigate()
  return React.useCallback(
    (to: To, options?: NavigateOptions) => {
      withViewTransition(() => navigate(to, options))
    },
    [navigate],
  )
}

export interface MorphLinkProps
  extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** Destination route. */
  to: To
  /** Replace the history entry instead of pushing (e.g. focus→overview back). */
  replace?: boolean
  children: React.ReactNode
}

/**
 * `<MorphLink>` — a router link that navigates inside a View Transition.
 *
 * Renders a real `<a>` so middle-click / cmd-click / "open in new tab" still
 * work (the browser handles those natively); only a plain left-click is
 * intercepted and routed through `navigateMorph`. This is the canonical
 * shared-element entry point — the session tile uses `useNavigateMorph()`
 * directly (it is a `role="button"`, not an anchor), and routes that want a
 * real link use this component.
 */
export const MorphLink = React.forwardRef<HTMLAnchorElement, MorphLinkProps>(
  function MorphLink({ to, replace, onClick, children, ...rest }, ref) {
    const morph = useNavigateMorph()
    const href = typeof to === 'string' ? to : (to.pathname ?? '')

    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e)
      // Let the browser handle modified clicks + non-primary buttons natively.
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return
      }
      e.preventDefault()
      morph(to, { replace })
    }

    return (
      <a ref={ref} href={href} onClick={handleClick} {...rest}>
        {children}
      </a>
    )
  },
)
