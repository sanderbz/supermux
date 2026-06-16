// Terminal URL links that also work on touch / in the installed iOS PWA.
//
// xterm's @xterm/addon-web-links makes URLs clickable, but two things break it
// on iOS specifically:
//
//   1. ACTIVATION is hover-gated. xterm only fires a link's handler on mouseup
//      when `_currentLink` is set, and that is populated by a `mousemove`
//      (hover). Real iOS Safari does not reliably synthesize that pre-click
//      mousemove over a non-hoverable terminal <div>, so a tap never activates.
//   2. The addon's default OPEN path is `window.open()` (blank) then
//      `location.href = uri` — which an installed standalone PWA / WKWebView
//      silently blocks (returns null), so even a desktop-style activation does
//      nothing on a phone.
//
// On the mobile focus route a tap also fires `focusTerm()` → the soft keyboard
// opens → the viewport reflows mid-tap, which fought whatever activation did
// fire. So the fix is two coordinated pieces, both here so there is ONE source
// of truth: `openExternal` (a PWA-safe open, reused by the desktop hover-click
// handler too) and `findLinkAt` (resolve the URL under a tapped point WITHOUT
// relying on hover). The mobile tap handler calls the resolver, opens on a hit,
// and skips the keyboard summon.

import type { Terminal } from '@xterm/xterm'

// The single definition of "what is a clickable URL". A verbatim copy of the
// @xterm/addon-web-links 0.12.0 default so the desktop hover-click path (which
// we hand this same regex) and the mobile tap resolver agree EXACTLY on which
// spans are links — passing it to the addon also pins them together so they
// can never drift. Non-global on purpose: the addon expects a fresh match per
// call; `findLinkAt` makes its own global clone to iterate a line.
export const LINK_URL_REGEX =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/

let lastOpen = { uri: '', t: 0 }

/**
 * Open an external URL in a way that works on every target we ship — desktop
 * (new tab), Android, and the installed iOS standalone PWA / WKWebView, where
 * the addon's `window.open()` silently returns null. A transient anchor click
 * is the one path the PWA honors. `rel="noopener"` matches the addon's
 * `opener = null` security posture.
 *
 * A single tap can reach here twice — once via the mobile tap path and once via
 * xterm's own click activation if iOS does happen to synthesize hover+click —
 * so a repeat of the same URL inside a short window is ignored: one tap, one
 * tab. Must be called from a user gesture (it is: a tap / the addon's click).
 */
export function openExternal(uri: string): void {
  const now = Date.now()
  if (uri === lastOpen.uri && now - lastOpen.t < 800) return
  lastOpen = { uri, t: now }
  const a = document.createElement('a')
  a.href = uri
  a.target = '_blank'
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * Resolve the URL under a viewport point (client px), or `null` if none — using
 * only public xterm API, no hover. Maps the point to a buffer cell, walks back
 * over wrapped continuation rows to the logical-line start, reconstructs the
 * (possibly wrapped) line, and returns the URL match that spans the tapped
 * column. `translateToString` collapses wide-char spacer cells, so the column→
 * string-index mapping stays exact even with CJK earlier on the line.
 */
export function findLinkAt(
  term: Terminal,
  clientX: number,
  clientY: number,
): string | null {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) return null
  const rect = screen.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  // The screen element is exactly cols×rows cells, so a cell size derived from
  // its box maps a tap to a column/row without any private renderer metrics.
  const cellW = rect.width / term.cols
  const cellH = rect.height / term.rows
  const col = Math.floor((clientX - rect.left) / cellW)
  const viewRow = Math.floor((clientY - rect.top) / cellH)
  if (col < 0 || col >= term.cols || viewRow < 0 || viewRow >= term.rows) {
    return null // tap landed in padding / outside the grid
  }

  const buf = term.buffer.active
  const tapRow = buf.viewportY + viewRow
  let start = tapRow
  while (start > 0 && buf.getLine(start)?.isWrapped) start--

  let text = ''
  let tapIndex = -1
  for (let r = start; ; r++) {
    const line = buf.getLine(r)
    if (!line) break
    if (r === tapRow) tapIndex = text.length + line.translateToString(false, 0, col).length
    text += line.translateToString(false)
    if (!buf.getLine(r + 1)?.isWrapped) break
  }
  if (tapIndex < 0) return null

  for (const m of text.matchAll(new RegExp(LINK_URL_REGEX.source, 'g'))) {
    const s = m.index ?? 0
    if (tapIndex >= s && tapIndex < s + m[0].length) return m[0]
  }
  return null
}
