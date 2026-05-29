// useStandaloneMode.
//
// Detects whether the app is running as an installed PWA (launched from the
// home screen) rather than inside a browser tab. The Layout uses this to drop
// browser-chrome affordances (e.g. an address-bar-style back button) that are
// redundant once the OS owns the window chrome.
//
// Two signals, ORed because iOS Safari and Chromium disagree:
//   - `display-mode: standalone` media query (the standard; Chromium, modern
//     iOS) — and we also accept `fullscreen` / `minimal-ui`.
//   - `navigator.standalone === true` — the legacy iOS-Safari-only flag.

import { useEffect, useState } from 'react'

const STANDALONE_QUERY =
  '(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)'

function readStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const mq =
    'matchMedia' in window && window.matchMedia(STANDALONE_QUERY).matches
  // iOS Safari exposes a non-standard boolean instead of the media query.
  const iosLegacy =
    'standalone' in navigator &&
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  return Boolean(mq || iosLegacy)
}

/** True when the app runs as an installed/standalone PWA. */
export function useStandaloneMode(): boolean {
  const [standalone, setStandalone] = useState(readStandalone)

  useEffect(() => {
    if (typeof window === 'undefined' || !('matchMedia' in window)) return
    const mql = window.matchMedia(STANDALONE_QUERY)
    const onChange = () => setStandalone(readStandalone())
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return standalone
}

/** Synchronous, non-hook read — for boot-time decisions before React mounts. */
export function isStandalone(): boolean {
  return readStandalone()
}
