/**
 * The `@`/`/` picker (fase A4 T9) — LAZY, and the only place chat reaches for a
 * list of things to talk about.
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
 * IT FETCHES NOTHING. `tracked-files` and `/api/slash-commands` are queried by
 * `chat-panel.tsx` — the A3/A4 contract that the panel owns the data plane, and
 * also the reason this module reaches for neither `lib/api` nor react-query:
 * a lazy chunk that imported the API client made the bundler hoist that client
 * into a THIRD chunk (measured: +0.5 KB gz for zero new behaviour).
 *
 * NO NEW DEPS: the list is plain DOM with the app's own tokens, not a combobox
 * library, and the filter is `slash.ts`'s ~20-line ranker. `React.lazy` at the
 * call site keeps all of it out of the hero path (T12's budget).
 */
import * as React from 'react'

import { cn } from '../../lib/utils'

import { atRows, pickerOptionId, PICKER_LISTBOX_ID, slashRows } from './slash'
import type { EntityPickerData, EntityRow } from './slash'
import type { ComposerPickerApi } from './use-composer'

export interface EntityPickerProps extends EntityPickerData {
  /** The session being typed IN — never offered as a mention of itself. */
  name: string
  kind: '@' | '/'
  query: string
  surface?: 'desktop' | 'phone'
  /** Insert this text over the trigger token (the composer's `picker.pick`). */
  onPick: (value: string) => void
  /** Hand the composer the two verbs its key handler needs. */
  bind: (api: ComposerPickerApi | null) => void
  /** Report the highlighted row upward, so the FIELD can carry
   *  `aria-activedescendant` (A4 review). The list lives here; the only element
   *  a screen reader is looking at is the textarea. */
  onActive?: (index: number) => void
}

/* ── the connected picker ────────────────────────────────────────────────── */

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
  const key = `${kind}:${query}`
  const [sel, setSel] = React.useState({ key, index: 0 })
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
        setSel({ key: now.key, index: next })
      },
      accept: () => {
        const row = live.current.rows[live.current.activeIndex]
        if (!row) return false
        onPick(row.value)
        return true
      },
    })
    return () => bind(null)
  }, [bind, onPick])

  return (
    <EntityPickerView
      rows={rows}
      activeIndex={activeIndex}
      kind={kind}
      query={query}
      loading={loading}
      surface={surface}
      onHover={(i) => setSel({ key, index: i })}
      onPick={(row) => onPick(row.value)}
    />
  )
}

/* ── the view ────────────────────────────────────────────────────────────── */

export interface EntityPickerViewProps {
  rows: readonly EntityRow[]
  activeIndex: number
  kind: '@' | '/'
  query: string
  loading?: boolean
  surface?: 'desktop' | 'phone'
  onHover: (index: number) => void
  onPick: (row: EntityRow) => void
}

/**
 * Presentational, prop-fed, network-free — the same contract `conversation.tsx`
 * keeps, and the reason `/dev/chat-live` can screenshot this popover with no
 * server behind it.
 *
 * It floats ABOVE the pill it belongs to and borrows the pill's own glass and
 * shadow, so the two read as one object rather than as a menu that happened to
 * land nearby.
 */
export function EntityPickerView({
  rows,
  activeIndex,
  kind,
  query,
  loading,
  surface = 'desktop',
  onHover,
  onPick,
}: EntityPickerViewProps) {
  const phone = surface === 'phone'
  return (
    <div
      data-testid="chat-entity-picker"
      // The pill's own glass and shadow (B0 `ui/composer.tsx`), so the popover
      // and the composer read as one object rather than as a menu that happened
      // to land nearby.
      className={
        'absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-[22px]' +
        ' border-[0.5px] border-hairline bg-surface backdrop-blur-[60px] backdrop-saturate-[180%]' +
        ' shadow-[0_12px_34px_-18px_rgba(30,18,10,0.35)]'
      }
    >
      <ul
        role="listbox"
        id={PICKER_LISTBOX_ID}
        aria-label="Suggestions"
        className="max-h-[264px] overflow-y-auto overscroll-contain py-1.5"
      >
        {rows.map((row, i) => (
          // `presentation`: a listbox owns OPTIONS, and an `li` between the
          // two breaks that ownership for a screen reader.
          <li key={row.id} role="presentation">
            <button
              type="button"
              role="option"
              id={pickerOptionId(i)}
              aria-selected={i === activeIndex}
              data-testid="chat-entity-row"
              data-active={i === activeIndex ? '' : undefined}
              // `onMouseDown` + preventDefault: a click must not blur the
              // textarea, or the caret the pick is about to replace is gone.
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(row)
              }}
              onMouseEnter={() => onHover(i)}
              className={cn(
                'flex w-full items-center gap-2.5 px-3.5 text-left',
                // 44pt of tappable row on the phone, the boards' 30px on the
                // desktop where a pointer is doing the aiming.
                phone ? 'py-[13px]' : 'py-[7px]',
                i === activeIndex && 'bg-fill-soft-2',
              )}
            >
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
        ))}
        {rows.length === 0 && (
          <li role="presentation" className="px-3.5 py-[9px] text-[12.6px] text-ink-2">
            {loading
              ? 'Looking…'
              : query
                ? `No ${kind === '@' ? 'tracked file or session' : 'command'} matches “${query}”`
                : // The trigger has just been typed and there is nothing to
                  // offer yet — a repo with no tracked files, an instance with
                  // no other session. Quoting the empty query printed a pair of
                  // bare quotation marks with nothing between them (mobile
                  // proof, 21-at-picker-light.png).
                  `Nothing to ${kind === '@' ? 'mention' : 'run'} here yet`}
          </li>
        )}
      </ul>
    </div>
  )
}
