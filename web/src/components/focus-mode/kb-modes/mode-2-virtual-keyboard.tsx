// Mode 2 — VirtualKeyboard API.
//
// The one W3C-standard way to ask the engine to hand US the keyboard geometry
// instead of silently resizing (or, on iOS, silently NOT resizing) the viewport
// underneath. On mount we opt in with `navigator.virtualKeyboard.overlaysContent
// = true`: the layout viewport then stays FULL and the soft keyboard OVERLAYS
// the content, and in exchange the engine publishes the occluded rectangle both
// as CSS `env(keyboard-inset-*)` insets and via the `geometrychange` event. We
// carve the keyboard's height out of a full-viewport fixed box, so its bottom
// edge lands exactly on the keyboard top and the composer (ChatSurface's
// `absolute inset-x-0 bottom-0` footer) sits flush there with zero band.
//
// PLATFORM. `navigator.virtualKeyboard` is Chromium-only (Android + desktop
// Chromium); it is UNDEFINED on iOS WebKit — the owner's device. There the
// effect is a guarded no-op and `env(keyboard-inset-height)` is unsupported, so
// its `0px` fallback leaves the box at full height (the composer then sits behind
// the keyboard — the documented risk). This mode earns its place for Android and
// for completeness; the iOS-specific techniques live in the other modes.
//
// Invariants (contract.ts): default-export a KbLayoutComponent; render header /
// body / composer in that order; body keeps its own `overflow-y:auto;
// overscroll-contain; min-h-0`; the composer keeps a home-indicator safe-area pad
// (ComposerFrame owns its own bottom pad, and the box bottoms out at the viewport
// edge when the keyboard is closed); no RESTING transform on the fixed box (the
// transform-ancestor guard — the edge-swipe wrapper only transforms while
// dragging). The global `overlaysContent` flip is done on mount and REVERTED in
// cleanup, so switching away from this mode restores the default behaviour.

import * as React from 'react'
import type { KbLayoutComponent } from './contract'

/** The slice of the VirtualKeyboard API (Chromium) we touch. Declared locally so
 *  the mode needs no ambient lib and stays type-only against `contract.ts`. */
interface VirtualKeyboard extends EventTarget {
  overlaysContent: boolean
  readonly boundingRect: DOMRectReadOnly
}

const Mode2VirtualKeyboard: KbLayoutComponent = ({ header, body, composer }) => {
  const rootRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const vk = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard })
      .virtualKeyboard
    // iOS WebKit / any non-Chromium engine: no API → nothing to opt into. The
    // env() fallbacks below keep the layout intact (full-height box), so the
    // mode simply renders as a plain dvh column there.
    if (!vk) return

    const prev = vk.overlaysContent
    vk.overlaysContent = true

    // Belt-and-suspenders: mirror the live keyboard height (from the geometry
    // event) into a local custom property, so the box also works on a build that
    // fires `geometrychange` but has not wired the `env(keyboard-inset-*)` insets
    // yet. `env()` remains the primary signal; this var only ever wins via the
    // `max()` in the height calc when the inset reports 0.
    const el = rootRef.current
    const onGeometryChange = () => {
      const h = vk.boundingRect?.height ?? 0
      el?.style.setProperty('--vk-height', `${h}px`)
    }
    onGeometryChange()
    vk.addEventListener('geometrychange', onGeometryChange)

    return () => {
      vk.removeEventListener('geometrychange', onGeometryChange)
      vk.overlaysContent = prev
      el?.style.removeProperty('--vk-height')
    }
  }, [])

  return (
    <div
      ref={rootRef}
      // A full-viewport fixed box shrunk to the visible area ABOVE the keyboard.
      // `position:fixed` also makes this the containing block for the composer's
      // `absolute bottom:0`, so the composer bottoms out on the keyboard top.
      // No resting transform is introduced (transform-ancestor guard). When the
      // keyboard is closed every inset is 0 → the box is a full 100dvh column.
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        // Prefer the standard inset; fall back to the geometry-published var,
        // then to 0. `keyboard-inset-height` is the occluded rectangle's height.
        height:
          'calc(100dvh - max(env(keyboard-inset-height, 0px), var(--vk-height, 0px)))',
      }}
      className="flex flex-col overflow-hidden"
    >
      {header}
      {body}
      {/* ChatSurface's footer is `absolute inset-x-0 bottom-0 z-[4]`; against
          this fixed box, bottom:0 = the keyboard top when open, the viewport
          bottom when closed. ComposerFrame carries its own safe-area bottom pad
          for the home indicator, so nothing to add here. */}
      {composer}
    </div>
  )
}

export default Mode2VirtualKeyboard
