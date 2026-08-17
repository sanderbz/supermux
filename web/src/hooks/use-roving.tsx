/**
 * Roving tabindex for the roster — one tab stop per list, arrows to move.
 * ─────────────────────────────────────────────────────────────────────────────
 * A6 T8.3 promised "list semantics AND a roving tabindex so a 40-session roster
 * is not 40 tab stops". The list semantics landed; the roving tabindex did not,
 * and the ledger was checked anyway. Measured on the shipping roster before this
 * module existed: `{lists:1, listitems:4, tileButtons:10, totalTabbables:38}`,
 * and focusing the first tile then pressing ArrowDown/ArrowRight moved nothing.
 *
 * ── What a composite widget owes the keyboard (WAI-ARIA APG) ────────────────
 * A list of peers is ONE stop in the tab sequence, and the arrows choose which
 * peer. Tab therefore steps *past* the roster to the next region instead of
 * walking every session in it, and Shift+Tab comes back to the row you left —
 * because the tab stop is remembered, not reset to the first row.
 *
 * The three rules this implements, and nothing more:
 *   · exactly one item in a list has `tabIndex={0}`; every other has `-1`
 *   · Arrow keys move focus AND the tab stop; Home/End jump to the ends
 *   · focusing an item by any other means (click, `.focus()`, a screen reader's
 *     own navigation) adopts it as the tab stop — the two must never disagree
 *
 * ── Why keys and not DOM order ──────────────────────────────────────────────
 * The provider is given the ORDERED KEYS (session names) rather than discovering
 * items by querying the DOM. The roster re-sorts under the user continuously —
 * smart sort moves a row the moment it speaks — and a DOM scan taken at keydown
 * would navigate the order that existed a frame ago. Keys also survive the
 * `layoutId` morph between tile and list view, where the DOM nodes do not.
 *
 * ── Orientation ─────────────────────────────────────────────────────────────
 * A list takes Up/Down; a grid takes all four, because in a wrapped grid the
 * visual "next" is horizontal. Both accept both here on purpose: the roster is
 * the same objects in two views, and a user who learned ArrowDown in list view
 * should not find it inert in tiles. Home/End always work.
 *
 * In a GRID, Up/Down step a whole visual row — the column count read off the
 * items' own geometry at keydown (`itemsPerRow`). It shipped as `±1` on every
 * arrow, which made ArrowDown byte-identical to ArrowRight in a four-column
 * roster: reaching the tile visually below took four presses, and Up/Down after
 * a re-sort landed somewhere unpredictable.
 *
 * Outside a provider `useRovingItem` returns `tabIndex: undefined` and a no-op
 * handler, so every existing call site (a picker row, the archived sheet, a
 * bench) keeps today's plain-tab-stop behaviour rather than losing its tabindex.
 */
import * as React from 'react'

export type RovingOrientation = 'vertical' | 'grid'

/** What one arrow press steps over: the flat item order, or a visual ROW of a
 *  wrapped grid. Left/Right are always `item`; Up/Down are `row`, which is `1`
 *  in a vertical list and the live column count in a grid. */
export type RovingAxis = 'item' | 'row'

interface RovingCtx {
  /** The key that currently owns the tab stop, or `null` outside a provider. */
  active: string | null
  /** Adopt a key as the tab stop (a focus event, or an arrow landing). */
  adopt: (key: string) => void
  /** Move the tab stop by `delta` items (or rows), or to an end, and FOCUS the
   *  result. */
  move: (from: string, to: number | 'first' | 'last', axis?: RovingAxis) => void
  /** Item DOM nodes, so `move` can focus what it selects. */
  register: (key: string, el: HTMLElement | null) => void
  orientation: RovingOrientation
  /** While a keyboard DRAG owns the arrows (dnd-kit in custom mode), navigation
   *  must not also move the tab stop — two owners of one key is worse than the
   *  tab stops this module removes. The tab stop itself keeps roving. */
  arrows: boolean
}

/**
 * How many items sit on the FIRST visual row, given each item's top edge in
 * document order.
 *
 * Pure so the grid step can be tested without a browser. A wrapped CSS grid has
 * no accessible "column count" from the item's own side — the roster's items are
 * two wrappers below the grid container — so the count is read off geometry:
 * the leading run of items that share a top edge IS the row.
 *
 * `tolerance` absorbs sub-pixel rounding and a mid-flight `layout` spring.
 */
export function itemsPerRow(tops: readonly number[], tolerance = 4): number {
  if (tops.length < 2) return 1
  const first = tops[0]!
  let n = 0
  for (const top of tops) {
    if (Math.abs(top - first) > tolerance) break
    n++
  }
  return Math.max(1, n)
}

const RovingContext = React.createContext<RovingCtx | null>(null)

export interface RovingListProviderProps {
  /** The items, in the order the arrows should walk them. */
  keys: readonly string[]
  orientation?: RovingOrientation
  /** Set `false` while something else legitimately owns the arrow keys — the
   *  custom-mode grid hands them to dnd-kit for the duration of a keyboard
   *  drag. The tab stop keeps roving; only navigation stands down, so a list
   *  never falls back to one tab stop per row. */
  arrows?: boolean
  children: React.ReactNode
}

/**
 * Owns the tab stop for one list. Render it around a `role="list"` (or as its
 * parent) — it renders no DOM of its own, so it never disturbs the grid layout
 * or the `<LayoutGroup>` morph.
 */
export function RovingListProvider({
  keys,
  orientation = 'vertical',
  arrows = true,
  children,
}: RovingListProviderProps) {
  const [active, setActive] = React.useState<string | null>(null)
  const nodes = React.useRef(new Map<string, HTMLElement>())
  // The roster hands us a fresh array on every render (it is a `.map()` over a
  // query result), so memoise on the CONTENT. Without this the context value is
  // new every frame and every row in the list re-renders on every SSE delta —
  // the exact cost the attention provider goes out of its way to avoid. NUL is
  // the separator because a session name cannot contain one.
  const signature = keys.join('\u0000')
  const items = React.useMemo(
    () => (signature.length > 0 ? signature.split('\u0000') : []),
    [signature],
  )

  const register = React.useCallback((key: string, el: HTMLElement | null) => {
    if (el) nodes.current.set(key, el)
    else nodes.current.delete(key)
  }, [])

  // The tab stop falls back to the FIRST key whenever the remembered one is not
  // on the roster any more — the session was archived, deleted or filtered out.
  // Without this a list can end up with zero `tabIndex={0}` items, i.e. a
  // composite widget the keyboard cannot enter at all, which is strictly worse
  // than the forty tab stops we started from.
  const effective = active !== null && items.includes(active) ? active : (items[0] ?? null)

  const adopt = React.useCallback((key: string) => setActive(key), [])

  // The live column count, measured at KEYDOWN rather than remembered: the
  // roster reflows on every resize, on the density control and on the
  // tile↔list morph, and a stale count would send ArrowDown to a tile that is
  // not below the one you are on.
  const columns = React.useCallback((): number => {
    if (orientation !== 'grid') return 1
    const tops: number[] = []
    for (const key of items) {
      const el = nodes.current.get(key)
      if (!el || !el.isConnected) continue
      tops.push(el.getBoundingClientRect().top)
    }
    return itemsPerRow(tops)
  }, [items, orientation])

  const move = React.useCallback(
    (from: string, to: number | 'first' | 'last', axis: RovingAxis = 'item') => {
      if (items.length === 0) return
      const at = items.indexOf(from)
      // A ROW step is `columns` items in a wrapped grid — the WAI-ARIA grid
      // pattern this module's header cites, and the half that never shipped:
      // every arrow was `±1`, so in a four-column roster ArrowDown was
      // byte-identical to ArrowRight and the tile visually below took four
      // presses to reach.
      const step = typeof to === 'number' && axis === 'row' ? to * columns() : to
      const idx =
        step === 'first'
          ? 0
          : step === 'last'
            ? items.length - 1
            : // CLAMP, do not wrap. Wrapping is defensible for a menu you opened
              // deliberately; on a roster it silently teleports you from the top
              // of a forty-row list to the bottom, and the APG's own list pattern
              // clamps for exactly that reason.
              Math.min(items.length - 1, Math.max(0, (at < 0 ? 0 : at) + step))
      const next = items[idx]
      if (next === undefined) return
      setActive(next)
      nodes.current.get(next)?.focus()
    },
    [items, columns],
  )

  const value = React.useMemo<RovingCtx>(
    () => ({ active: effective, adopt, move, register, orientation, arrows }),
    [effective, adopt, move, register, orientation, arrows],
  )
  return <RovingContext.Provider value={value}>{children}</RovingContext.Provider>
}

export interface RovingItem {
  /** `0` for the one item that owns the tab stop, `-1` for the rest, and
   *  `undefined` outside a provider (keep whatever the component already had). */
  tabIndex: number | undefined
  /** Attach to the focusable element. */
  ref: (el: HTMLElement | null) => void
  /** Adopt the tab stop when focus arrives by any other route. */
  onFocus: () => void
  /** Arrow / Home / End. Returns whether it consumed the event, so a component
   *  with its own Enter/Space handling can chain rather than fork. */
  onKeyDown: (e: React.KeyboardEvent) => boolean
}

const NOOP_ITEM: RovingItem = {
  tabIndex: undefined,
  ref: () => {},
  onFocus: () => {},
  onKeyDown: () => false,
}

/** One roster item's half of the contract. `key` is the session name. */
export function useRovingItem(key: string): RovingItem {
  const ctx = React.useContext(RovingContext)
  const register = ctx?.register
  const ref = React.useCallback(
    (el: HTMLElement | null) => register?.(key, el),
    [register, key],
  )
  const onFocus = React.useCallback(() => ctx?.adopt(key), [ctx, key])
  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!ctx || !ctx.arrows) return false
      // A keystroke aimed at something INSIDE the row (the kebab, an inline
      // input) is not roster navigation. Without this an arrow key pressed with
      // the kebab menu open would yank focus to the next tile.
      if (e.target !== e.currentTarget) return false
      if (e.altKey || e.ctrlKey || e.metaKey) return false
      const horizontal = ctx.orientation === 'grid'
      switch (e.key) {
        case 'ArrowDown':
          break
        case 'ArrowUp':
          break
        case 'ArrowRight':
        case 'ArrowLeft':
          if (!horizontal) return false
          break
        case 'Home':
        case 'End':
          break
        default:
          return false
      }
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Home') ctx.move(key, 'first')
      else if (e.key === 'End') ctx.move(key, 'last')
      // Left/Right walk the flat order; Up/Down walk a visual ROW, which is one
      // item in a list and one grid row in tiles.
      else if (e.key === 'ArrowLeft') ctx.move(key, -1, 'item')
      else if (e.key === 'ArrowRight') ctx.move(key, +1, 'item')
      else if (e.key === 'ArrowUp') ctx.move(key, -1, 'row')
      else ctx.move(key, +1, 'row')
      return true
    },
    [ctx, key],
  )
  if (!ctx) return NOOP_ITEM
  return { tabIndex: ctx.active === key ? 0 : -1, ref, onFocus, onKeyDown }
}
