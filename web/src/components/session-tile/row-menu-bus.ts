/**
 * "Open this row's action menu" — the keyboard's half of the roster kebab.
 * ─────────────────────────────────────────────────────────────────────────────
 * The ⋯ trigger used to be its own tab stop. On a 40-session roster that is 41
 * stops instead of 40-become-1, and every one of them is a button that is
 * `opacity: 0` at rest on a fine pointer — so a keyboard user tabbed through N
 * invisible-until-focused controls to get PAST the roster. Moving the menu into
 * the default branch was right; adding its trigger as a PEER of the roving item
 * is what put the count back.
 *
 * So the trigger leaves the tab order (`tabIndex={-1}`) and the row itself
 * carries the gesture, which is the platform's own: Shift+F10 and the Menu
 * (ContextMenu) key — the same two keys that open a context menu in every
 * desktop app, and what the APG names for a "secondary action on the focused
 * item".
 *
 * ── Why a bus and not a context ─────────────────────────────────────────────
 * The row and its menu are SIBLINGS in four different trees (the flat overview
 * body ×2 views, and the custom-mode grid ×2 views), and in one of them they are
 * separated by a dnd-kit sortable wrapper. A React context would need a provider
 * at each of those mount sites — or one at shell level, whose state change would
 * re-render the whole app for a keystroke on one row. A name-keyed subscription
 * re-renders exactly the one menu that was asked for, works in every tree
 * without ceremony, and is a pure module the tests can drive directly.
 */

type Listener = () => void

const listeners = new Map<string, Set<Listener>>()

/** Ask the action menu for `name` to open. Returns whether anything was
 *  listening — the caller uses it to decide whether it consumed the key. */
export function requestRowMenu(name: string): boolean {
  const set = listeners.get(name)
  if (!set || set.size === 0) return false
  for (const fn of [...set]) fn()
  return true
}

/** Subscribe a menu to its row's requests. Returns the unsubscribe. */
export function onRowMenuRequest(name: string, fn: Listener): () => void {
  let set = listeners.get(name)
  if (!set) {
    set = new Set()
    listeners.set(name, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) listeners.delete(name)
  }
}

/**
 * Is this keystroke "open the focused row's menu"?
 *
 * Pure, and exported, so the contract is a test and not a comment. Shift+F10 is
 * the ANSI/Windows binding every desktop toolkit honours; `ContextMenu` is the
 * dedicated Menu key. Both are deliberately modifier-strict — a bare F10 belongs
 * to the browser, and Ctrl/Meta+Shift+F10 is somebody else's shortcut.
 */
export function isRowMenuKey(e: {
  key: string
  shiftKey?: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  if (e.key === 'ContextMenu') return true
  return e.key === 'F10' && e.shiftKey === true
}
