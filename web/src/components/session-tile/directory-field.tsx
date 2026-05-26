import * as React from 'react'

import { Input } from '@/components/ui/input'
import { sessionsApi } from '@/lib/api'

// ── Shared Directory typeahead field (AT-H1) ────────────────────────────────
// Extracted from the New-session sheet's Advanced tab so BOTH "New session" and
// "Start a team" pick a working directory the same way — the user asked for
// consistency between the two flows.
//
// Behavior:
//  • Controlled: `value` / `onChange` own the path string.
//  • Debounced typeahead against the M7 autocomplete endpoint
//    (`GET /api/autocomplete/dir?q=` → matching subdirectories, capped at 10),
//    rendered as a native <datalist> so the user can PICK a repo from the
//    projects structure OR type a path manually — both supported, native, clean.
//  • On FOCUS we also fetch suggestions for the current path so the user sees
//    their repos/projects to pick straight away — no need to type first. The
//    suggestions are derived purely from what's typed / the home default; no
//    server-specific path is hardcoded (the endpoint lists real subdirectories).

export interface DirectoryFieldProps {
  /** The current directory path (controlled). */
  value: string
  /** Called with the new path on every keystroke / pick. */
  onChange: (value: string) => void
  /** Field label. Defaults to "Directory". */
  label?: string
  /** Helper text under the field. Has a sensible default. */
  hint?: string
  /** DOM id for the input + its <label> + the <datalist> (must be unique per
   *  sheet so two mounted fields don't share a suggestion list). */
  id?: string
}

const DEFAULT_HINT = 'Where the agent runs. Defaults to your home directory.'

export function DirectoryField({
  value,
  onChange,
  label = 'Directory',
  hint = DEFAULT_HINT,
  id = 'dir',
}: DirectoryFieldProps) {
  const [suggestions, setSuggestions] = React.useState<string[]>([])
  const debounce = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const listId = `${id}-suggestions`

  // Cancel any pending debounce on unmount so we never setState after teardown.
  React.useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current)
    },
    [],
  )

  // Fetch suggestions for the given query. `[]` on empty so the datalist clears.
  const fetchSuggestions = async (q: string) => {
    if (!q.trim()) return setSuggestions([])
    setSuggestions(await sessionsApi.autocompleteDir(q))
  }

  // Debounced typeahead while typing.
  const handleChange = (next: string) => {
    onChange(next)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void fetchSuggestions(next), 200)
  }

  // On focus, surface the children of the current path immediately so the user
  // sees their repos/projects to pick — no typing required (the user's ask).
  const handleFocus = () => {
    if (debounce.current) clearTimeout(debounce.current)
    void fetchSuggestions(value)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={handleFocus}
        placeholder="~/projects/app"
        autoComplete="off"
        spellCheck={false}
        list={listId}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
