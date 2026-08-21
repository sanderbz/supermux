// Mode 0 — BASELINE (current behaviour, the control).
//
// This mode reproduces TODAY exactly. It is a transparent passthrough: it renders
// `header`, `body` and `composer` as a bare fragment, in that order, so they land
// as the direct flex children of ChatSurface's own accent root (`relative flex
// h-full w-full flex-col`) exactly as they did before the KbLayout seam existed —
// while `<MobileSheet>` (untouched) remains the outer keyboard-avoiding box that
// sizes off the visual-viewport CSS vars (`--vvh` / `--vv-offset-top` /
// `--vv-overshoot`). See `mobile-sheet.tsx` for that mechanism.
//
// Because a React fragment creates no DOM, mounting THIS layout produces the
// identical element tree the surface rendered with no layout prop at all — so
// mode 0 is a true no-op relative to today, and it is the CONTROL the owner
// A/B-tests the other ten modes against (it still shows the reported ~68px band
// on his device; that is the bug being fought).

import type { KbLayoutComponent } from './contract'

const Mode0Baseline: KbLayoutComponent = ({ header, body, composer }) => {
  return (
    <>
      {header}
      {body}
      {composer}
    </>
  )
}

export default Mode0Baseline
