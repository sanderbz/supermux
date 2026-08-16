// PromptField — a single textarea that doubles as a slash-command picker.
//
// Mirrors the Claude Code TUI input contract: the user types freely; a leading
// `/` opens an inline autocomplete that filters the user's REAL installed
// commands (skills + user/managed commands + claude.ai MCP connectors — the
// same `useSchedulerCommands` source the `/board` ⌘K palette uses, exposed as
// `GET /api/schedules/commands`). Picking a row inserts the command token at
// the start, drops the open menu, and leaves the caret at the end so the user
// can keep typing their prompt.
//
// Why one field, not three: the old composer forced the user through a preset
// grid → a command dropdown → a prompt textarea (three forced steps even when
// only a free-text prompt was needed). One field with inline autocomplete lets
// the user type a bare prompt, a bare `/cmd`, or `/cmd then more text` — same
// shape as the in-session terminal, so the muscle memory carries over.
//
// Output split: the caller passes the merged text and a derived `command` /
// `prompt` pair (computed by `splitCommandAndPrompt`) so the wire payload still
// matches the wire schema (separate `command` + `prompt`). The field itself only
// knows about the merged text.

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Sparkles, Terminal, ServerCog } from 'lucide-react'

import { springs } from '@/lib/springs'
import type { RecipeCommand } from '@/lib/api'
import type { EntityRow } from '@/lib/entity'
import { EntityPickerView } from '@/components/ui/entity-picker'
// The two shared PURE modules, reached directly rather than through
// `use-composer.ts` / `slash.ts`: those re-export them for chat's own callers,
// but importing through them would drag chat's hook and command table into the
// scheduler's chunk for the sake of two functions (fase B3 T3.3/T3.4).
import { composerKeyIntent, jumpTarget } from '@/components/chat/composer-keys'
import { rankEntities } from '@/lib/rank'

/** A command token plus its trailing space → `/cso ` style insertion. */
function insertion(cmd: string): string {
  const trimmed = cmd.startsWith('/') ? cmd : `/${cmd}`
  return `${trimmed} `
}

/** Split the merged text back into `command` + `prompt`. A leading slash token
 *  becomes `command`; everything else is the `prompt`. Falls back to all-prompt
 *  when nothing looks like a command (free-text only). Used at the WIRE
 *  boundary only (form → API payload) — not on every keystroke, because the
 *  split → merge round-trip is lossy (it strips trailing spaces and the
 *  command-prompt separator, which would prevent the user from typing spaces
 *  in the field). The editor keeps the raw merged text in its own state. */
export function splitCommandAndPrompt(text: string): {
  command: string
  prompt: string
} {
  const t = text.trimStart()
  if (!t.startsWith('/')) return { command: '', prompt: text.trim() }
  // First whitespace ends the command token; everything after is the prompt.
  // Newlines + tabs also end it (matches the TUI's tokenizer).
  const match = /^(\/\S+)(\s+([\s\S]*))?$/.exec(t)
  if (!match) return { command: t.trim(), prompt: '' }
  return {
    command: match[1] ?? '',
    prompt: (match[3] ?? '').trim(),
  }
}

/** Inverse of `splitCommandAndPrompt` — assemble the merged text for the field
 *  from a stored row's `command` + `prompt`. Adds the leading slash if the row
 *  stored a bare command name. Used to SEED the editor on first open; once
 *  the user starts typing the editor keeps the raw merged text directly so the
 *  round-trip can't strip user-typed spaces. */
export function mergeCommandAndPrompt(
  command: string,
  prompt: string,
): string {
  const c = command.trim()
  const p = prompt.trim()
  if (!c && !p) return ''
  if (!c) return p
  const slash = c.startsWith('/') ? c : `/${c}`
  return p ? `${slash} ${p}` : slash
}

// Icon COMPONENTS, not elements: the shared picker takes `row.icon` as a
// component so it can size and colour the glyph itself, which is what keeps
// every list in the app agreeing about what a 14px muted icon looks like.
const SOURCE_ICON: Record<RecipeCommand['source'], EntityRow['icon']> = {
  skill: Sparkles,
  command: Terminal,
  mcp: ServerCog,
}

/** How many rows this box shows. A per-surface number: chat's popover shows 12
 *  because it floats over a transcript; this one sits inside a form and 8 is
 *  what fits without pushing the fields below it out of reach. */
const LIST_CAP = 8

const SOURCE_LABEL: Record<RecipeCommand['source'], string> = {
  skill: 'Skill',
  command: 'Command',
  mcp: 'MCP connector',
}

interface PromptFieldProps {
  value: string
  onChange: (next: string) => void
  /** REAL installed commands from `GET /api/schedules/commands`. */
  commands: ReadonlyArray<RecipeCommand>
  loading: boolean
  placeholder: string
  /** Min textarea rows (grows up to 8). */
  rows?: number
  /** Optional aria label override (defaults to "Prompt"). */
  ariaLabel?: string
}

/** Strip the leading slash from a command token for comparison. */
function bareName(cmd: string): string {
  return cmd.replace(/^\//, '').toLowerCase()
}

/** The user is currently writing a slash token (caret sits inside `/foo` at the
 *  very start of the field, before any whitespace). Returns the typed token
 *  without the slash, or null when the field isn't in slash mode. */
function detectSlashQuery(value: string, caret: number): string | null {
  // Slash mode requires the slash to be the FIRST non-whitespace character of
  // the field — typing `/` mid-sentence (e.g. "fix and/or refactor") must NOT
  // pop the menu, matching the in-session terminal's tokenizer.
  const leading = value.trimStart()
  if (!leading.startsWith('/')) return null
  // Find where the leading whitespace ends so we can locate the `/`.
  const slashIdx = value.indexOf('/')
  if (slashIdx < 0 || slashIdx >= caret) return null
  // The token ends at the first whitespace AFTER the slash. If the caret is
  // past that boundary the user is now typing the prompt body — close the menu.
  const after = value.slice(slashIdx + 1)
  const wsRel = after.search(/\s/)
  const tokenEnd = wsRel < 0 ? value.length : slashIdx + 1 + wsRel
  if (caret > tokenEnd) return null
  return value.slice(slashIdx + 1, caret).toLowerCase()
}

export function PromptField({
  value,
  onChange,
  commands,
  loading,
  placeholder,
  rows = 3,
  ariaLabel = 'Prompt',
}: PromptFieldProps) {
  const reduce = useReducedMotion()
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = React.useState(0)
  // `viaKey` rides with the index because the picker scrolls the active row
  // into view for KEYBOARD moves only — a hover that scrolled would move the
  // list out from under the cursor, which would then hover a different row.
  const [active, setActive] = React.useState({ i: 0, viaKey: false })
  // Suppress the menu while the user is editing somewhere that doesn't qualify
  // (e.g. the value is empty so the placeholder shows, or they explicitly
  // dismissed with Escape). The slash query alone is the open-signal.
  const [escDismissed, setEscDismissed] = React.useState(false)

  const slashQuery = detectSlashQuery(value, caret)
  const open = slashQuery !== null && !escDismissed

  // ONE RANKER FOR BOTH TYPE-AHEADS (fase B3 T3.4). This field and the chat
  // `@`/`/` popover filter the SAME corpus of installed slash commands, in
  // opposite directions, and until B3 they did it with two different matchers:
  // this one was `includes()`, chat's is `fuzzyScore`'s subsequence match with
  // score ordering. Adopting chat's here is a DELIBERATE BEHAVIOUR CHANGE for
  // the scheduler — `/dcr` now finds `/daily-code-review` — and it is called
  // out in the PR body rather than slipped in as a refactor.
  //
  // The CAP stays per-surface (8 here, 12 in chat): how many rows fit is a
  // property of the box the list is in, not of the ranking.
  const matches = React.useMemo(() => {
    if (slashQuery === null) return [] as RecipeCommand[]
    return rankEntities(
      commands,
      slashQuery,
      // Rank on the bare name AND the description, which is what the old
      // predicate looked at — the matcher changed, the corpus did not.
      (c) => `${bareName(c.cmd)} ${c.desc}`,
      LIST_CAP,
    )
  }, [commands, slashQuery])

  // The picker's rows. Built here because they are the SCHEDULER's data — the
  // primitive fetches nothing and knows no command shapes.
  const pickerRows = React.useMemo<EntityRow[]>(
    () =>
      matches.map((c) => ({
        id: `${c.source}:${c.cmd}`,
        kind: 'command',
        value: c.cmd,
        label: c.cmd,
        meta: c.desc,
        warn: SOURCE_LABEL[c.source],
        icon: SOURCE_ICON[c.source],
      })),
    [matches],
  )

  // Clamp the highlight whenever the match list shrinks.
  const clamped = matches.length === 0 ? 0 : Math.min(active.i, matches.length - 1)

  const updateCaret = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    setCaret(el.selectionStart ?? 0)
  }, [])

  const pickCommand = React.useCallback(
    (cmd: RecipeCommand) => {
      const el = ref.current
      if (!el) return
      const slashIdx = value.indexOf('/')
      if (slashIdx < 0) return
      // Replace the in-progress slash token (`/foo`) with the picked command
      // + a single trailing space, then position the caret right after it.
      const after = value.slice(slashIdx + 1)
      const wsRel = after.search(/\s/)
      const tokenEnd = wsRel < 0 ? value.length : slashIdx + 1 + wsRel
      const head = value.slice(0, slashIdx)
      const tail = value.slice(tokenEnd).replace(/^\s+/, '') // collapse leading whitespace
      const inserted = insertion(cmd.cmd) // "/cmd "
      const next = `${head}${inserted}${tail}`
      onChange(next)
      // Defer the caret + focus restore until after the controlled update
      // applies, otherwise the textarea snaps the caret to the end.
      const nextCaret = head.length + inserted.length
      requestAnimationFrame(() => {
        const node = ref.current
        if (!node) return
        node.focus()
        node.setSelectionRange(nextCaret, nextCaret)
        setCaret(nextCaret)
      })
      setEscDismissed(true)
    },
    [value, onChange],
  )

  // ONE KEYBOARD ENGINE (fase B3 T3.3). This was the app's SECOND hand-rolled
  // `(i+1) % len` wrap with its own `scrollIntoView` beside it — a copy of the
  // palette's, which is a copy of the composer's, one of which had already lost
  // the scroll call. What a key MEANS is now `composerKeyIntent`'s decision and
  // where a coarse jump lands is `jumpTarget`'s, both pure and both truth-tabled
  // in `tests/unit/entity-picker-keys.test.ts`; the scroll lives in the picker.
  //
  // `caret: false` — this textarea is in SLASH MODE, and while the list is up
  // Home/End address it rather than the line. The moment the list closes the
  // reducer is not consulted at all and the textarea gets its keys back.
  //
  // WHAT DID NOT MOVE: every piece of scheduler text plumbing.
  // `detectSlashQuery`, `splitCommandAndPrompt`, `mergeCommandAndPrompt`,
  // `insertion` and `bareName` are this form's semantics, not the picker's, and
  // the field/token split is exactly the seam that lets them stay put.
  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || pickerRows.length === 0) {
      if (e.key === 'Escape') {
        // Even with no matches, a leading Escape should bail out of slash mode.
        setEscDismissed(true)
      }
      return
    }
    const intent = composerKeyIntent(e, {
      draft: value,
      active: false,
      picker: true,
      caret: false,
    })
    if (intent === 'pass' || intent === 'newline') return
    switch (intent) {
      case 'picker-down':
        e.preventDefault()
        setActive((i) => ({ i: (i.i + 1) % pickerRows.length, viaKey: true }))
        break
      case 'picker-up':
        e.preventDefault()
        setActive((i) => ({ i: (i.i - 1 + pickerRows.length) % pickerRows.length, viaKey: true }))
        break
      case 'picker-first':
      case 'picker-last':
      case 'picker-page-up':
      case 'picker-page-down':
        e.preventDefault()
        setActive((i) => ({
          i: jumpTarget(
            intent.replace('picker-', '') as 'first' | 'last' | 'page-up' | 'page-down',
            i.i,
            pickerRows.length,
          ),
          viaKey: true,
        }))
        break
      case 'picker-accept': {
        e.preventDefault()
        const pick = matches[clamped]
        if (pick) pickCommand(pick)
        break
      }
      case 'picker-close':
        e.preventDefault()
        setEscDismissed(true)
        break
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setActive({ i: 0, viaKey: false })
          // Re-arm the menu when the user keeps typing — Escape only suppresses
          // the CURRENT slash token; the next edit gets a fresh autocomplete.
          setEscDismissed(false)
          // Defer caret read so it reflects the post-change position.
          requestAnimationFrame(updateCaret)
        }}
        onSelect={updateCaret}
        onClick={updateCaret}
        onKeyUp={updateCaret}
        onKeyDown={handleKey}
        placeholder={placeholder}
        aria-label={ariaLabel}
        rows={rows}
        className="min-h-11 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-base md:text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <AnimatePresence>
        {open && (
          // THE DOWN ANCHOR. The parent owns the box — its position, its border
          // and its entry animation — and the picker renders a bare list inside
          // it. That is the whole of `anchor="field"`: not a positioning
          // engine, just "somebody else already drew the container". The chat
          // popover's `anchor="token"` draws its own, because it floats free
          // over a transcript with nothing behind it.
          //
          // Keeping the wrapper here also keeps this surface's framer entry
          // (and `springs.cardExpand`) out of the shared primitive, which the
          // chat popover must stay free of — it is lazy, and framer is a
          // separate vendor chunk.
          <motion.div
            initial={reduce ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -4 }}
            transition={springs.cardExpand}
            className="absolute left-0 right-0 top-full z-30 mt-1.5 overflow-hidden rounded-lg border border-border bg-popover shadow-[var(--sm-popover-shadow)]"
          >
            <EntityPickerView
              anchor="field"
              rows={pickerRows}
              activeIndex={clamped}
              loading={loading && pickerRows.length === 0}
              maxHeight="max-h-64"
              ariaLabel="Slash commands"
              testId="prompt-field-picker"
              rowTestId="prompt-field-row"
              emptyLabel={
                commands.length
                  ? 'No matching command — keep typing to send as-is.'
                  : 'No installed skills or commands yet.'
              }
              scrollOnActive={active.viaKey}
              onHover={(i) => setActive({ i, viaKey: false })}
              onPick={(row) => {
                const pick = matches.find((c) => `${c.source}:${c.cmd}` === row.id)
                if (pick) pickCommand(pick)
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
