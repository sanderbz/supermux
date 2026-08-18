// The reader's TEXT SELECTION, as a fact the surface can consult.
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. On iOS Safari a selection made by long-pressing a message is
// not a passive highlight: it is a live UI state that owns the native callout
// ("Copy / Look Up / Share"). Two things the chat surface does routinely will
// take it away before the user's thumb reaches Copy:
//
//   · WRITING `scrollTop` on the track the selection lives in. WebKit treats a
//     programmatic scroll of the selection's scroller as the end of the
//     selection gesture — the handles and the callout go, and on the phone the
//     highlight goes with them. The chat panel's follow-bottom effect does
//     exactly this write, and it used to run on EVERY render of the panel
//     (see `chat-panel.tsx`), i.e. once per peek tick while the agent is idle.
//   · MOVING FOCUS. Focusing a field collapses the document selection, which is
//     why `arm-composer-focus.ts` already refuses to arm while one is held, and
//     why the phone's tap-to-dismiss (BUG 2) must refuse for the same reason.
//
// So both of those behaviours ask this module the same question first. Keeping
// the predicate in one place is the point: "does the user have something
// selected right now" must have exactly ONE reading, or the two call sites
// drift and the selection survives one of them and not the other.

/** Every non-collapsed range the document currently holds. */
function liveRanges(): Range[] {
  if (typeof window === 'undefined') return []
  const sel = window.getSelection?.()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return []
  const out: Range[] = []
  for (let i = 0; i < sel.rangeCount; i += 1) {
    const range = sel.getRangeAt(i)
    if (!range.collapsed) out.push(range)
  }
  return out
}

/**
 * Is the reader holding a selection ANYWHERE on the page?
 *
 * The document-wide reading, for behaviours that must stand down regardless of
 * which surface the selection is on (the phone's tap-to-dismiss: a tap that
 * ends a drag-select is not a "plain tap in the empty transcript").
 */
export function hasTextSelection(): boolean {
  return liveRanges().length > 0
}

/**
 * Is the reader holding a selection INSIDE `root`?
 *
 * The scoped reading, for behaviours that would only disturb their own subtree
 * (the follow-bottom scroll write). `Node.contains` is deliberately called with
 * the range's `commonAncestorContainer`, which is a TEXT node for the ordinary
 * case of a selection inside one paragraph — `contains` accepts any node, so
 * the common "user selected part of one bubble" case is the cheap one.
 */
export function selectionInside(root: Element | null | undefined): boolean {
  if (!root) return false
  return liveRanges().some((range) => root.contains(range.commonAncestorContainer))
}
