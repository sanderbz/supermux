/**
 * <EntityPicker> — one list of things to find and act on (fase B3 T2).
 * ─────────────────────────────────────────────────────────────────────────────
 * Promoted out of `components/chat/` where fase A4 built it, because by B3 the
 * app had FOUR of these: this one, the ⌘K palette's, the scheduler
 * `PromptField`'s, and the focus-mode session sheet's (which had no keyboard
 * navigation at all). Each re-implemented `(i+1) % len` wrap and
 * `scrollIntoView({block:'nearest'})` — and this one, the newest, had FORGOTTEN
 * the scrollIntoView, so arrowing past the fold moved a highlight nobody could
 * see. That is exactly how a defect hides in a copy-paste family, and fixing it
 * in one place is the argument for this file existing.
 *
 * FIVE RULES IT KEEPS:
 *
 *   1. IT FETCHES NOTHING. Rows arrive as props from whichever surface owns the
 *      data plane. A lazy chunk that imported the API client made the bundler
 *      hoist that client into a third chunk (measured: +0.5 KB gz for zero new
 *      behaviour), and the whole point of the token anchor is that it can be
 *      screenshotted with no server behind it.
 *   2. IT NEVER TAKES FOCUS IN THE TOKEN ANCHOR. The textarea keeps it and
 *      carries `aria-activedescendant`; the list is `aria-controls`. A popover
 *      that grabbed focus would dismiss the soft keyboard on every phone, one
 *      character into the query. (The FIELD anchor is the opposite — it hangs
 *      under an input that owns its own focus. The anchor prop is what
 *      distinguishes them, and it is the only thing that does.)
 *   3. ONE HIGHLIGHT ATOM. Keyboard and pointer write the same state, and
 *      `[data-highlighted]` is set by RENDER, never by an event handler.
 *      Keyboard changes scroll the row into view; pointer changes must NOT
 *      (a hover that scrolls moves the list out from under the cursor, which
 *      then hovers a different row, which scrolls again).
 *   4. NO NEW DEPENDENCY. No cmdk, no floating-ui, no kbar. Plain DOM with the
 *      app's own tokens. The app-JS budget had 0.21 KB of headroom when this
 *      landed; a combobox library was never on the table.
 *   5. NO PORTAL. The token anchor positions itself against a parent that is
 *      already `relative`. A portal would break the composer's never-take-focus
 *      rule and buy nothing, so `anchor` selects a WRAPPER CLASS — it is not a
 *      positioning engine, and it must not grow into one.
 */
import * as React from 'react'

import { cn } from '../../lib/utils'
import type { EntityRow } from '../../lib/entity'

/**
 * Where the list hangs.
 *
 * `token` — up from an `@`/`/` token in a composer, in flow, over the
 *   transcript it is being written about.
 * `field` — the parent already owns a box (the ⌘K dialog, a sheet). The list
 *   renders with NO positioning and NO chrome of its own, because the box it
 *   sits in has its own border and shadow and a second one reads as a menu
 *   inside a menu.
 */
export type PickerAnchor = 'token' | 'field'

/** Per-anchor default height, and the reason they differ.
 *
 *  The token anchor's job is to not cover the conversation it is being typed
 *  into, so it is short. The field anchor IS the surface — a ⌘K spotlight that
 *  showed six rows would be a regression from what the palette does today — so
 *  it is tall. §14 specified one number for both; one number is wrong for one
 *  of them, and this is the deviation, logged in BRAND.md §6c. */
const MAX_H: Record<PickerAnchor, string> = {
  token: 'max-h-[min(280px,46vh)]',
  field: 'max-h-[min(420px,60vh)]',
}

export interface EntityPickerViewProps {
  rows: readonly EntityRow[]
  activeIndex: number
  loading?: boolean
  surface?: 'desktop' | 'phone'
  anchor?: PickerAnchor
  /** Override the per-anchor default. */
  maxHeight?: string
  /** The listbox's own id, so a FIELD can point `aria-controls` at it. */
  listboxId?: string
  /** `id` for row `i`, so a FIELD can point `aria-activedescendant` at it. */
  optionId?: (index: number) => string
  ariaLabel?: string
  /**
   * The heading that opens the group row `i` belongs to, or undefined.
   *
   * Headings live INSIDE the listbox as `role="presentation"` — they are not
   * options, so the arrow keys skip them for free and a screen reader still
   * counts the right number of choices. The alternative (one listbox per
   * group) would make "how many results are there" unanswerable and would
   * break every selector that names the list.
   */
  headingAt?: (index: number) => string | undefined
  /**
   * What to say when there is nothing to show.
   *
   * ALWAYS THE CALLER'S SENTENCE. The primitive knows how many rows it has and
   * nothing else — not what was searched, not what the corpus was, not whether
   * "nothing" means "no match" or "none exist yet". Chat's copy is
   * trigger-specific ("No tracked file or session matches …", and a distinct
   * line for the blank query so it never prints a bare pair of quotation
   * marks); the palette's names the query; the scheduler's distinguishes "no
   * match" from "nothing installed". Three different sentences, none of which
   * this component could have written.
   */
  emptyLabel?: string
  onHover: (index: number) => void
  onPick: (row: EntityRow) => void
  /**
   * True when the highlight last moved because of a KEY. The scroll-into-view
   * is driven off this rather than off `activeIndex` alone, which is the whole
   * of rule 3: a pointer-driven change must not scroll.
   */
  scrollOnActive?: boolean
  testId?: string
  rowTestId?: string
}

/** Presentational, prop-fed, network-free — the contract that lets `/dev/pickers`
 *  screenshot every state with no server behind it. */
export function EntityPickerView({
  rows,
  activeIndex,
  loading,
  surface = 'desktop',
  anchor = 'token',
  maxHeight,
  listboxId,
  optionId,
  ariaLabel = 'Suggestions',
  headingAt,
  emptyLabel,
  onHover,
  onPick,
  scrollOnActive,
  testId = 'chat-entity-picker',
  rowTestId = 'chat-entity-row',
}: EntityPickerViewProps) {
  const phone = surface === 'phone'
  const token = anchor === 'token'
  const listRef = React.useRef<HTMLUListElement | null>(null)

  // THE FIX THIS FILE EXISTS FOR. The palette had this; the chat popover — the
  // newest copy — did not, so ArrowDown past the fold moved a highlight the
  // user could not see. It lives here now, once.
  //
  // An effect rather than a scroll inside the key handler, because the row it
  // has to scroll to is the one THIS render just drew: scrolling from the
  // handler reads the previous layout and lands one row short.
  React.useEffect(() => {
    if (!scrollOnActive) return
    const el = listRef.current?.querySelector<HTMLElement>('[data-highlighted]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [scrollOnActive, activeIndex])

  return (
    <div
      data-testid={testId}
      data-anchor={anchor}
      className={
        token
          ? // The composer pill's own glass and shadow, so the popover and the
            // field read as ONE object rather than as a menu that happened to
            // land nearby.
            'absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-[22px]' +
            ' border-[0.5px] border-hairline bg-surface backdrop-blur-[60px] backdrop-saturate-[180%]' +
            ' shadow-[var(--sm-popover-shadow)]'
          : // The parent owns the box. Adding a border here would draw a second
            // one inside the dialog's.
            'w-full'
      }
    >
      <ul
        ref={listRef}
        role="listbox"
        id={listboxId}
        aria-label={ariaLabel}
        className={cn(
          'overflow-y-auto overscroll-contain py-1.5',
          // The list keeps its own horizontal padding so the highlight fill
          // FLOATS inside it instead of running edge to edge.
          'px-1.5',
          maxHeight ?? MAX_H[anchor],
        )}
      >
        {rows.map((row, i) => {
          const on = i === activeIndex
          const Icon = row.icon
          const heading = headingAt?.(i)
          return (
            <React.Fragment key={row.id}>
            {heading && (
              <li
                role="presentation"
                className="px-2 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.4px] text-ink-3 first:pt-1"
              >
                {heading}
              </li>
            )}
            {/* `presentation`: a listbox owns OPTIONS, and an `li` between the
                two breaks that ownership for a screen reader. */}
            <li role="presentation">
              <button
                type="button"
                role="option"
                id={optionId?.(i)}
                aria-selected={on}
                data-testid={rowTestId}
                data-highlighted={on ? '' : undefined}
                // `onMouseDown` + preventDefault: a click must not blur the
                // textarea, or the caret the pick is about to replace is gone.
                // Harmless on the field anchor, where the input keeps focus
                // through the pick anyway.
                onMouseDown={(e) => {
                  e.preventDefault()
                  onPick(row)
                }}
                onMouseEnter={() => onHover(i)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2 text-left',
                  // 44pt of tappable row on the phone; the desktop keeps the
                  // tighter number where a pointer is doing the aiming. The
                  // phone exception is deliberate — HIG beats a design doc's
                  // single figure — and it is recorded in BRAND.md §6c.
                  phone ? 'py-[13px]' : 'py-[7px]',
                  on && 'bg-fill-soft-2',
                )}
              >
                {row.leading ?? (Icon && <Icon className="size-3.5 shrink-0 text-ink-3" />)}
                <span
                  className={cn(
                    'min-w-0 flex-none truncate tracking-[-0.1px] text-ink',
                    phone ? 'text-[14px]' : 'text-[13.5px]',
                    row.kind === 'command' && 'font-mono',
                  )}
                >
                  {row.label}
                </span>
                {row.meta && (
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[11.5px] text-ink-3',
                      row.kind === 'file' && 'font-mono',
                    )}
                  >
                    {row.meta}
                  </span>
                )}
                {row.warn && (
                  <span className="ml-auto flex-none rounded-full bg-fill-soft px-2 py-[1px] text-[10.5px] tracking-[0.2px] text-ink-2">
                    {row.warn}
                  </span>
                )}
              </button>
            </li>
            </React.Fragment>
          )
        })}
        {rows.length === 0 && (
          <li role="presentation" className="px-2 py-[9px] text-[12.6px] text-ink-2">
            {/* "Looking…" outranks the empty copy: "I have not answered yet"
                and "there is nothing" are different facts, and showing the
                second while the first is true is the list lying about a
                request still in flight. */}
            {loading ? 'Looking…' : emptyLabel}
          </li>
        )}
      </ul>
    </div>
  )
}
