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
// `?chat=1` seeds the fase-A5 renderer seam ON, so the CHAT composition of this
// route (floating header card + transcript + composer, no focus header, no
// KeyBar, reduced dock) is screenshot-able offline without walking into
// Settings → Experimental first. It flips the SAME store the Settings toggle
// writes — there is no dev-only fork of the seam decision, because the point of
// this page is to review the real one. Only `web-app` / `api-server` / the
// other local Claude mocks are eligible; `build-runner` (shell) and the Codex
// mock stay terminal-only, which is itself worth a screenshot.
//
// Usage: /dev/focus-mobile/web-app   ·   /dev/focus-mobile/web-app?chat=1

import { useParams, useSearchParams } from 'react-router-dom'

import { MobileFocus } from '@/routes/focus/mobile'
import { useViewportShellVars } from '@/hooks/use-keyboard-viewport'
import { MOCK_TILES } from '@/components/session-tile/mock'
import { mockTeamsForLead } from '@/routes/dev-teams.fixture'
import { useUI } from '@/stores/ui-store'
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

// The session the bench focuses when the URL carries no `:name`: a tile with a
// cached `preview_ansi` so the pane shows a populated last-screen (the app's own
// cold-open) rather than the empty placeholder terminal the bench captured.
const FOCUS_NAME =
  MOCK_TILES.find((t) => t.name === 'web-app')?.name ?? MOCK_TILES[0]?.name ?? ''

// A mock team whose lead maps to the FIRST mock tile, exactly as /dev/focus
// does (Phase 0.2). Without it the phone focus bench renders the teammate strip
// empty, so the one surface that has to be reviewed at 390px — a lead WITH a
// crew — was the one surface the bench could not show.
const MOCK_FOCUS_TEAMS = mockTeamsForLead(MOCK_TILES[0]?.name ?? '')

export default function DevFocusMobile() {
  const { name } = useParams()
  // This bench renders <MobileFocus> DIRECTLY, outside <Layout> — which is the
  // ONLY place the app mounts the viewport-shell-var publisher (layout.tsx:424).
  // Mount it here too so `--vvh` / `--vv-offset-top` are LIVE-published off
  // `window.visualViewport` exactly as in production, letting an offline rig fake
  // the visual viewport and verify MobileSheet's visual-viewport pin end to end.
  // DEV-only route → tree-shaken from prod; the base app is untouched.
  useViewportShellVars()
  // `?chat=1` — seed the experiment ON for this review. Written during render on
  // purpose: `useUI` is read by <MobileFocus> in the SAME pass, so an effect
  // would paint one frame of the terminal composition into every screenshot.
  // `setState` outside React is zustand's documented API and this is a DEV-only
  // route, so the store's normal subscribe/persist behaviour is unchanged (a
  // reviewer who wants it off again drops the param and flips the Settings
  // toggle, which is the same switch).
  const [params] = useSearchParams()
  // `?grok=1` (DEV-only) — stamp `data-grok` on the wrapper so the grok-scoped
  // chat CSS applies here (this route renders <MobileFocus> DIRECTLY, outside
  // <Layout>, which is the only place the app stamps `data-grok` —
  // layout.tsx:418 — so without this the grok chat surface never gets its skin).
  // Bare `data-grok`, mirroring /dev/store · /dev/roster · /dev/pickers (never
  // `data-grok-root`, whose shell-root substrate is not this bench's ground).
  // Byte-inert when off: production + the base app are untouched.
  const grok = import.meta.env.DEV && params.get('grok') === '1'
  // `?chat=1` — and `?grok=1` — seed the fase-A5 bot composition ON so the CHAT
  // surface (header card + transcript + composer) renders under the skin, not
  // the terminal focus. Written during render on purpose (see below).
  if ((params.get('chat') === '1' || grok) && !useUI.getState().botMode) {
    useUI.setState({ botMode: true })
  }
  return (
    <div {...(grok ? { 'data-grok': '' } : {})} className="h-dvh w-full">
      <MobileFocus
        mockSessions={MOCK_TILES}
        mockTeams={MOCK_FOCUS_TEAMS}
        mockName={name || FOCUS_NAME}
      />
    </div>
  )
}
