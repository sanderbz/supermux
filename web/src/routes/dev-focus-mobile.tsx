// /dev/focus-mobile/:name — verification page (DEV-only; lazy-loaded so
// neither this route nor its mock data ships in production, matching
// /dev/focus and /dev/tiles).
//
// Renders the REAL `MobileFocus` (mobile-focus-keybar spec) with the mocked
// tiles so the floating KeyBar can be reviewed offline at a 390px viewport —
// WITHOUT a live backend. `LiveTerminal` shows its "Connecting…" pill
// (expected without a server); against a running supermux-server with a
// session named in the route it streams live.
//
// The route bypasses the normal `focus.tsx` desktop/mobile media-query fork
// (`useMediaQuery('(min-width: 768px)')`) — it renders `<MobileFocus>`
// directly regardless of the actual viewport width, so the mobile layout is
// screenshot-able from a wide dev browser window too.
//
// The KeyBar has no "start open" prop — its persisted state (localStorage,
// `focus_key_bar`) is the only source of truth — so this route pre-seeds that
// storage key with `open: true` before mount, exactly once per load, so the
// bar is visible immediately without requiring a manual `···` tap.
//
// Usage: /dev/focus-mobile/web-app

import { useParams } from 'react-router-dom'

import { MobileFocus } from '@/routes/focus/mobile'
import { MOCK_TILES } from '@/components/session-tile/mock'
import {
  DEFAULT_KEY_BAR_STATE,
  KEY_BAR_STORAGE_KEY,
} from '@/components/focus-mode/key-bar'

// Seed the KeyBar open BEFORE MobileFocus's `useKeyBar()` does its lazy
// initial `localStorage.getItem` read. Runs once at module load (this module
// only ever loads for the DEV-only lazy route) — a later manual toggle inside
// the app is still respected on subsequent visits, same as any other
// localStorage-backed pref.
try {
  window.localStorage.setItem(
    KEY_BAR_STORAGE_KEY,
    JSON.stringify({ ...DEFAULT_KEY_BAR_STATE, open: true }),
  )
} catch {
  // localStorage disabled — the bar just falls back to its default (closed);
  // still reviewable via a manual `···` tap.
}

export default function DevFocusMobile() {
  const { name } = useParams()
  // Default to the first mock so a bare /dev/focus-mobile is still meaningful.
  void name
  return (
    <div className="h-dvh w-full">
      <MobileFocus mockSessions={MOCK_TILES} />
    </div>
  )
}
