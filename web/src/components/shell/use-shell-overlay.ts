// The shell-overlay host — a context so any route can raise an overlay INSIDE
// the shell without prop-drilling and without a body-level portal.
//
// Why not a body portal: the whole point of the desktop shell overlay is that
// it is bounded by the CONTENT COLUMN. The nav rail and the route header stay
// visible and clickable beside it, which is what makes it read as "a thing on
// top of this page" instead of "a modal that replaced the app". A body-level
// portal cannot be bounded that way without re-deriving the column's geometry
// in JS on every resize.
//
// So `Layout` publishes the content column (`<main data-shell-content>`) as the
// host, and `<ShellOverlay>` portals into it. On mobile there IS no shell to
// live inside (the focus route strips both navs and lives in its own body-level
// fixed sheet), so the mobile form is a `ResponsiveSheet` and never touches this
// context — see shell-overlay.tsx.

import * as React from 'react'

export interface ShellOverlayHost {
  /** The content column. `null` until Layout's ref attaches (first render). */
  element: HTMLElement | null
}

const ShellOverlayContext = React.createContext<ShellOverlayHost>({
  element: null,
})

export const ShellOverlayProvider = ShellOverlayContext.Provider

/** The shell's overlay host. Returns `{ element: null }` outside a `Layout`
 *  (dev benches, unit tests, SSR), which `<ShellOverlay>` treats as "nowhere to
 *  portal to" and falls back gracefully rather than throwing. */
export function useShellOverlayHost(): ShellOverlayHost {
  return React.useContext(ShellOverlayContext)
}

/**
 * Layout's side of the contract: a ref to attach to the content column plus the
 * memoised context value.
 *
 * The ref is mirrored into state on purpose — a plain `useRef` never triggers a
 * re-render when it attaches, so consumers mounted in the same commit would see
 * `null` forever.
 */
export function useShellOverlayProvider(): [
  /** Callback ref for the content column. */
  attach: (el: HTMLElement | null) => void,
  /** The context value to publish. */
  value: ShellOverlayHost,
] {
  const [element, setElement] = React.useState<HTMLElement | null>(null)
  const value = React.useMemo(() => ({ element }), [element])
  // A TUPLE, not an object: the react-hooks lint rule reads any property
  // access on a hook result inside render as a possible ref dereference, and a
  // callback ref handed straight to `ref={…}` is exactly the shape it flags.
  // Destructuring at the call site sidesteps that with no runtime cost.
  return [setElement, value]
}

/** Attribute the overlay sets on the host while it is open.
 *
 *  It gates `container-type: size` in globals.css, and that gating is
 *  LOAD-BEARING, not tidiness: `container-type: size` implies layout
 *  containment, which makes the element a containing block for `position:
 *  fixed` descendants — the exact hazard `tests/e2e/smoke/shell-containing-
 *  block.spec.ts` guards. The content column hosts the mobile focus sheet, the
 *  KeyBar and the joystick, all `fixed`. Scoping the containment to
 *  (desktop width AND an open overlay) means it can never be on while any of
 *  that mobile chrome is mounted. */
export const OVERLAY_OPEN_ATTR = 'data-overlay-open'
