/**
 * The `@`/`/` picker (fase A4 T9) — chat's CONNECTED wrapper around the shared
 * `<EntityPickerView>` (fase B3 T2/T3).
 * ─────────────────────────────────────────────────────────────────────────────
 * §5.6's anti-lookalike rule: the chat surface must not be less capable than
 * the terminal at the app's actual job. `@`-ing a path into a sentence and
 * running a slash command are two of the three things people do in the TUI all
 * day; without them chat is a nice picture of a chat.
 *
 * THREE RULES THIS FILE KEEPS:
 *
 *   1. IT INSERTS, IT NEVER SENDS. Every pick lands in the REACT composer via
 *      the composer's `pick` (T3's `insertAtCaret`), never on the pty. A picker
 *      that typed into the TUI would be racing the user's own cursor.
 *   2. IT NEVER TAKES FOCUS. The textarea keeps it — the keys arrive there and
 *      are routed back in through `bind()`. A popover that grabbed focus would
 *      dismiss the soft keyboard on every phone, one character into the query.
 *   3. IT IS HONEST ABOUT WHAT IT CANNOT DO. `/model`-class commands are listed
 *      (hiding them would be a lie about the session's abilities) but marked as
 *      terminal-only, and the composer's slash gate refuses to send them.
 *
 * WHY THE VIEW MOVED AND THIS DID NOT. §14 called for moving the whole file to
 * `components/ui/`. Only the presentational half went. This half knows
 * `atRows`/`slashRows` — chat's DATA — and `components/ui/` importing them
 * would put chat's row builders on the import path of every other consumer,
 * starting with the ⌘K palette, which is EAGERLY MOUNTED in the root layout.
 * With 0.21 KB of app-JS headroom at the time this landed, "the shared
 * primitive drags chat's data into the hero path" was not a stylistic
 * objection. So the seam is: the view is shared, the wiring is per-surface —
 * which is also what makes the two anchors provable rather than a prop nobody
 * exercises.
 *
 * IT FETCHES NOTHING. `tracked-files` and `/api/slash-commands` are queried by
 * `chat-panel.tsx` — the A3/A4 contract that the panel owns the data plane.
 */
import * as React from 'react'

import { EntityPickerView } from '../ui/entity-picker'

import { acceptRow, atRows, pickerOptionId, PICKER_LISTBOX_ID, slashRows } from './slash'
import { jumpTarget } from './composer-keys'
import type { EntityPickerData, EntityRow } from './slash'
import type { ComposerPickerApi } from './use-composer'

export interface EntityPickerProps extends EntityPickerData {
  /** The session being typed IN — never offered as a mention of itself. */
  name: string
  kind: '@' | '/'
  query: string
  surface?: 'desktop' | 'phone'
  /**
   * Take this row (the composer's `picker.pick`).
   *
   * THE WHOLE ROW, not just `row.value`, even though today's only consumer
   * collapses to `.value` immediately: the row is the picker's identity for the
   * thing that was chosen — `kind`, the slug in `id`/`meta`, the label a
   * receipt would name — and a caller that has only the inserted string has to
   * re-derive all of it by parsing the draft back.
   *
   * IT STILL ONLY EVER INSERTS. Picking a session does NOT dispatch to it
   * (fase B4 T4.4): the hand-off happens at SUBMIT, after the send control has
   * visibly relabelled, so nothing is ever sent by surprise. That is a design
   * constraint, not an unfinished edge — see `delegate-intent.ts`.
   */
  onPick: (row: EntityRow) => void
  /** Hand the composer the two verbs its key handler needs. */
  bind: (api: ComposerPickerApi | null) => void
  /** Report the highlighted row upward, so the FIELD can carry
   *  `aria-activedescendant` (A4 review). The list lives here; the only element
   *  a screen reader is looking at is the textarea. */
  onActive?: (index: number) => void
}

export default function EntityPicker({
  name,
  kind,
  query,
  surface = 'desktop',
  files,
  commands,
  sessions,
  loading,
  onPick,
  bind,
  onActive,
}: EntityPickerProps) {
  const rows = React.useMemo(
    () =>
      kind === '@'
        ? atRows(files, sessions ?? [], name, query)
        : slashRows(commands, query),
    [commands, files, kind, name, query, sessions],
  )

  // The highlight is keyed by the QUERY, so it resets to the best match on
  // every keystroke (Spotlight's rule, and the palette's) without an effect
  // that the React rules would flag.
  //
  // `viaKey` rides along because the view scrolls the active row into view for
  // KEYBOARD moves only: a hover that scrolled would move the list out from
  // under the cursor, which would then hover a different row, which would
  // scroll again.
  const key = `${kind}:${query}`
  const [sel, setSel] = React.useState({ key, index: 0, viaKey: false })
  const activeIndex = sel.key === key ? Math.min(sel.index, Math.max(rows.length - 1, 0)) : 0

  // The key handler runs on the TEXTAREA's events, one tick out of this
  // render, so the verbs read the list through a ref rather than a closure.
  const live = React.useRef({ rows, activeIndex, key })
  React.useEffect(() => {
    live.current = { rows, activeIndex, key }
  })

  // The field owns `aria-activedescendant`, so the highlight has to travel one
  // level up. An effect, because it is a notification about this render's
  // outcome rather than something the field needs in order to be drawn.
  React.useEffect(() => {
    onActive?.(rows.length > 0 ? activeIndex : -1)
  }, [activeIndex, onActive, rows.length])

  React.useEffect(() => {
    bind({
      move: (delta) => {
        const now = live.current
        if (now.rows.length === 0) return
        const next = (now.activeIndex + delta + now.rows.length) % now.rows.length
        setSel({ key: now.key, index: next, viaKey: true })
      },
      jump: (to) => {
        const now = live.current
        if (now.rows.length === 0) return
        setSel({
          key: now.key,
          index: jumpTarget(to, now.activeIndex, now.rows.length),
          viaKey: true,
        })
      },
      accept: () => {
        // `false` means "nothing to accept" and the keystroke keeps its normal
        // meaning — Enter still SENDS. The decision is `acceptRow`'s so it can
        // be asserted without a DOM (`slash.ts`).
        const row = acceptRow(live.current.rows, live.current.activeIndex)
        if (!row) return false
        onPick(row)
        return true
      },
    })
    return () => bind(null)
  }, [bind, onPick])

  return (
    <EntityPickerView
      anchor="token"
      rows={rows}
      activeIndex={activeIndex}
      emptyLabel={emptyCopy(kind, query)}
      loading={loading}
      surface={surface}
      listboxId={PICKER_LISTBOX_ID}
      optionId={pickerOptionId}
      scrollOnActive={sel.viaKey}
      onHover={(i) => setSel({ key, index: i, viaKey: false })}
      onPick={onPick}
    />
  )
}

/**
 * What the popover says when it has nothing to offer — CHAT's sentence, not the
 * primitive's (fase B3 T2). It is the only one of the three consumers whose
 * empty state depends on which trigger opened it, and the blank-query branch
 * exists because quoting an empty query printed a pair of bare quotation marks
 * with nothing between them (mobile proof, 21-at-picker-light.png).
 */
export function emptyCopy(kind: '@' | '/', query: string): string {
  if (!query) return `Nothing to ${kind === '@' ? 'mention' : 'run'} here yet`
  return `No ${kind === '@' ? 'tracked file or session' : 'command'} matches “${query}”`
}

// The presentational half now lives in `components/ui/entity-picker.tsx` and is
// re-exported here so A4's tests and `/dev/chat-live` keep their import path —
// the promotion is a move, not a rename of chat's public surface.
export { EntityPickerView } from '../ui/entity-picker'
export type { EntityPickerViewProps } from '../ui/entity-picker'
