import * as React from 'react'
import { motion } from 'framer-motion'
import { Folder } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { sessionsApi } from '@/lib/api'
import { springs } from '@/lib/springs'

// ── Shared Directory field (AT-H1 + FEAT-DIR-CHIPS) ─────────────────────────
// The SHARED working-dir picker for both "New session" and "Start a team" — the
// user asked for consistency between the two flows and, more recently, for the
// options to be VISIBLE up front (a hidden-until-focus native <datalist> hid
// the project list behind a click).
//
// Behavior:
//  • Controlled: `value` / `onChange` own the path string.
//  • Suggestion-chip grid BELOW the input, sourced from the M7 autocomplete
//    endpoint (`GET /api/autocomplete/dir?q=` → matching subdirectories, capped
//    server-side at 10). The chips REUSE the visual language of the New-session
//    preset cards (rounded-xl, border-border, bg-card, motion press) — tighter
//    so they fit two per row on desktop / one on phone, with 44pt touch targets.
//  • Up to 6 chips shown (user explicitly: "not all, that would be too many").
//    Any overflow shows a muted "+N more — keep typing to filter" hint.
//  • Tap a chip → fills the input with that path + trailing `/` and re-fetches
//    its children, so picking `/opt/projects/supermux/` then shows that repo's
//    subdirs. Free typing still works — the input is fully editable.
//  • On mount + when `value` changes (debounced), we fetch suggestions for the
//    PARENT directory of what's typed (or `value` itself if it ends with `/`),
//    so a pre-filled `/opt/projects/` immediately surfaces the project repos.
//  • Empty result → the chip section is hidden entirely (no empty box, no
//    false hits when typing a non-existent path).
//
// The native `<datalist>` is intentionally GONE: the user's ask was to SEE
// options directly, and a duplicate hidden dropdown alongside visible chips
// would muddle the primary affordance. Free typing + visible chips is the
// whole story.

export interface DirectoryFieldProps {
  /** The current directory path (controlled). */
  value: string
  /** Called with the new path on every keystroke / pick. */
  onChange: (value: string) => void
  /** Field label. Defaults to "Directory". */
  label?: string
  /** Helper text under the field. Has a sensible default. */
  hint?: string
  /** DOM id for the input + its <label> (must be unique per sheet). */
  id?: string
}

const DEFAULT_HINT = 'Pick a project below or type a path.'

/** How many suggestion chips we render. The user explicitly capped this:
 *  "see [a few] but not all, because that would be too many". 6 fits a
 *  2-column grid in three rows on desktop and a single column on a phone
 *  without dominating the sheet. */
const MAX_CHIPS = 6

/** Cancellation token: when a newer fetch starts we tag this number on it; any
 *  in-flight earlier fetch that resolves later compares its tag and bails so
 *  results NEVER arrive out of order (which would flash stale chips). */
let fetchSeq = 0

export function DirectoryField({
  value,
  onChange,
  label = 'Directory',
  hint = DEFAULT_HINT,
  id = 'dir',
}: DirectoryFieldProps) {
  const [suggestions, setSuggestions] = React.useState<string[]>([])
  const debounce = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const mySeq = React.useRef(0)

  // Fetch suggestions for the given query. Tagged with a sequence so a stale
  // late-arriving response can't overwrite a fresher one. `[]` on empty / fail
  // so the chip section cleanly disappears.
  const fetchSuggestions = React.useCallback(async (q: string) => {
    const seq = ++fetchSeq
    mySeq.current = seq
    if (!q.trim()) {
      setSuggestions([])
      return
    }
    const next = await sessionsApi.autocompleteDir(q)
    // A newer fetch started after us — drop this stale result.
    if (mySeq.current !== seq) return
    setSuggestions(next)
  }, [])

  // Initial fetch (on mount + whenever the controlled `value` changes). We
  // debounce so a rapid sequence of keystrokes doesn't hammer the endpoint.
  // The fetch query IS the current value: the autocomplete endpoint already
  // walks up to the parent directory and matches descendants, so a path like
  // `/opt/projects/` immediately lists the project repos.
  React.useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void fetchSuggestions(value), 180)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [value, fetchSuggestions])

  // Picking a chip fills the input + appends a trailing slash (so the next
  // fetch lists THAT directory's children — a natural drill-down). If the
  // chip already ends in `/` we leave it alone.
  const pickChip = (path: string) => {
    const withSlash = path.endsWith('/') ? path : `${path}/`
    onChange(withSlash)
    // The value-change effect will re-fetch, but we kick one off NOW (without
    // the debounce delay) so the chip set updates instantly on tap.
    if (debounce.current) clearTimeout(debounce.current)
    void fetchSuggestions(withSlash)
  }

  const shown = suggestions.slice(0, MAX_CHIPS)
  const overflow = Math.max(0, suggestions.length - shown.length)
  const inputId = id

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="~/projects/app"
        autoComplete="off"
        spellCheck={false}
      />
      {shown.length > 0 && (
        <div className="mt-1 flex flex-col gap-2">
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {shown.map((path) => (
              <DirChip key={path} path={path} onPick={pickChip} />
            ))}
          </div>
          {overflow > 0 && (
            <p className="text-xs text-muted-foreground">
              +{overflow} more — keep typing to filter.
            </p>
          )}
        </div>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** A single suggestion chip — visual cousin of the New-session preset cards
 *  (`min-h-14 rounded-xl border border-border bg-card`), tightened (px-3 py-2,
 *  min-h-11 = 44pt touch target) so a 2-column grid fits comfortably below
 *  the input on desktop and a 1-column on phone. Shows the directory's base
 *  name prominently with the full path muted underneath. */
function DirChip({ path, onPick }: { path: string; onPick: (p: string) => void }) {
  // Derive the base name. Strip any trailing slash first so `/opt/projects/`
  // → `projects`, not an empty string.
  const trimmed = path.replace(/\/+$/, '')
  const base = trimmed.split('/').pop() || path
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.98 }}
      transition={springs.buttonPress}
      onClick={() => onPick(path)}
      title={path}
      className="flex min-h-11 items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{base}</span>
        <span className="truncate text-xs text-muted-foreground">{path}</span>
      </span>
    </motion.button>
  )
}
