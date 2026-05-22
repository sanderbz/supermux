// /dev/focus/:name — M14 verification page (DEV-only; lazy-loaded so neither
// this route nor the mock data ships in production, matching /dev/tiles).
//
// Renders the REAL desktop focus mode (DesktopFocus → DesktopSplit) with the 12
// mocked sessions so the visual critic can review the two-column split, the
// 320px session-strip with the current-row spring highlight, the compact-tile
// peek-popover (hover a non-current row ≥300ms), the 44px FocusHeader, and the
// §4.4.3 DesktopDock — all at the 375/390/1024/1440 breakpoints — WITHOUT a live
// backend. The LiveTerminal shows its "Connecting…" pill (expected without a
// server); against a running supermux-server with a session named in the route it
// streams live, and the keyboard-capture echo can be filmed.
//
// Usage: /dev/focus/gel-astro

import { useParams } from 'react-router-dom'

import { DesktopFocus } from '@/routes/focus/desktop'
import { MOCK_TILES } from '@/components/session-tile/mock'

export default function DevFocus() {
  const { name } = useParams()
  // Default to the first mock so a bare /dev/focus is still meaningful.
  void name
  return (
    <div className="h-full w-full">
      <DesktopFocus mockSessions={MOCK_TILES} />
    </div>
  )
}
