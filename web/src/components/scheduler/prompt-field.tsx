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
// matches the M8 schema (separate `command` + `prompt`). The field itself only
// knows about the merged text.

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Sparkles, Terminal, ServerCog } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { RecipeCommand } from '@/lib/api'

/** A command token plus its trailing space → `/cso ` style insertion. */
function insertion(cmd: string): string {
  const trimmed = cmd.startsWith('/') ? cmd : `/${cmd}`
  return `${trimmed} `
}

/** Split the merged text back into `command` + `prompt`. A leading slash token
 *  becomes `command`; everything else is the `prompt`. Falls back to all-prompt
 *  when nothing looks like a command (free-text only). */
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
 *  stored a bare command name. */
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

const SOURCE_ICON: Record<RecipeCommand['source'], React.ReactNode> = {
  skill: <Sparkles className="size-3.5" aria-hidden />,
  command: <Terminal className="size-3.5" aria-hidden />,
  mcp: <ServerCog className="size-3.5" aria-hidden />,
}

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
  const [active, setActive] = React.useState(0)
  // Suppress the menu while the user is editing somewhere that doesn't qualify
  // (e.g. the value is empty so the placeholder shows, or they explicitly
  // dismissed with Escape). The slash query alone is the open-signal.
  const [escDismissed, setEscDismissed] = React.useState(false)

  const slashQuery = detectSlashQuery(value, caret)
  const open = slashQuery !== null && !escDismissed

  const matches = React.useMemo(() => {
    if (slashQuery === null) return [] as RecipeCommand[]
    const q = slashQuery
    if (!q) return commands.slice(0, 8)
    return commands
      .filter((c) => {
        const n = bareName(c.cmd)
        if (n.includes(q)) return true
        if (c.desc.toLowerCase().includes(q)) return true
        return false
      })
      .slice(0, 8)
  }, [commands, slashQuery])

  // Clamp the highlight whenever the match list shrinks.
  const clamped = matches.length === 0 ? 0 : Math.min(active, matches.length - 1)

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

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || matches.length === 0) {
      if (e.key === 'Escape') {
        // Even with no matches, a leading Escape should bail out of slash mode.
        setEscDismissed(true)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % matches.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + matches.length) % matches.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const pick = matches[clamped]
      if (pick) pickCommand(pick)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEscDismissed(true)
    }
  }

  // Auto-scroll the highlighted row into view as arrows walk the menu.
  const listRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-prompt-row="${clamped}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, clamped])

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setActive(0)
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
          <motion.div
            ref={listRef}
            role="listbox"
            aria-label="Slash commands"
            initial={reduce ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -4 }}
            transition={springs.cardExpand}
            className="absolute left-0 right-0 top-full z-30 mt-1.5 max-h-64 overflow-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
          >
            {loading && !matches.length ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                Loading installed commands…
              </p>
            ) : matches.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                {commands.length
                  ? 'No matching command — keep typing to send as-is.'
                  : 'No installed skills or commands yet.'}
              </p>
            ) : (
              matches.map((c, i) => (
                <button
                  key={`${c.source}:${c.cmd}`}
                  type="button"
                  role="option"
                  data-prompt-row={i}
                  aria-selected={i === clamped}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pickCommand(c)}
                  className={cn(
                    'flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-1.5 text-left',
                    i === clamped ? 'bg-accent' : 'hover:bg-accent/60',
                  )}
                >
                  <span className="mt-0.5 shrink-0 text-muted-foreground">
                    {SOURCE_ICON[c.source]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs text-foreground">
                        {c.cmd}
                      </span>
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {SOURCE_LABEL[c.source]}
                      </span>
                    </span>
                    {c.desc && (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {c.desc}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
