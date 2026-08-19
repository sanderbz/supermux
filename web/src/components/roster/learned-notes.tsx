/**
 * The bot-panel Memory surface — the ARCHIVAL list under the CORE notes editor.
 * ─────────────────────────────────────────────────────────────────────────────
 * CORE notes (the editor above this) are the small, always-injected index the
 * owner curates. THESE are the store the bot writes itself and recalls a handful
 * of per turn. Read-only on purpose: the bot is the author, the owner is the
 * reader — there is no edit affordance to mislead anyone into thinking a hand
 * edit here would survive the bot's next save.
 *
 * Honest ranking: typing in the box hits `GET …/memory/search`, which ranks with
 * the SAME lexical scorer the per-turn recall hook selects with, so the order
 * shown is the order the bot would actually recall — not a second, cosmetic
 * search that would quietly disagree with its memory. An empty box lists the
 * whole union (private ∪ role), freshest first.
 *
 * Markdown sits behind `React.lazy`, exactly as `transcript-item.tsx` does it:
 * the `react-markdown` stack stays in its own chunk and never lands in this
 * panel's weight; the Suspense fallback renders the same body as pre-wrapped
 * text so the expanded row does not jump when the chunk arrives.
 *
 * Styling follows `bot-panel.tsx`'s documented choice — Tailwind + the shadcn
 * semantic tokens, NOT `[data-grok]`-scoped CSS — so one component renders
 * identically in the in-shell pane and the body-portalled sheet, and inverts
 * correctly in both themes.
 */
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Info, Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  getNote,
  listNotes,
  searchNotes,
  type LearnedNote,
  type NoteTier,
  type NotesResponse,
} from '@/lib/api/memory'

/** The markdown stack, kept out of this panel's chunk (see the header note). */
const ChatMarkdown = React.lazy(() => import('@/components/chat/markdown/chat-markdown'))

/** One dot per note type — the taxonomy the store weights recall by. */
const TYPE_DOT: Record<string, string> = {
  decision: 'bg-sky-500',
  bugfix: 'bg-rose-500',
  reference: 'bg-violet-500',
  feedback: 'bg-amber-500',
}

/** Long enough that a fast typist fires one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250

export function LearnedNotes({ name }: { name: string }) {
  const [q, setQ] = React.useState('')
  const [debounced, setDebounced] = React.useState('')
  const [open, setOpen] = React.useState<string | null>(null)

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [q])

  const searching = debounced.length > 0
  const { data, isLoading } = useQuery<NotesResponse>({
    // The query key carries the term, so switching back to an empty box serves
    // the already-cached full list instead of re-fetching it.
    queryKey: ['learned-notes', name, debounced],
    queryFn: () => (searching ? searchNotes(name, debounced) : listNotes(name)),
    staleTime: 30_000,
    retry: false,
  })

  const notes = data?.notes ?? []
  // Derived, not synced: a row the current result set no longer contains simply
  // renders collapsed. Storing that in an effect would be a second source of
  // truth for the same fact, one render behind.
  const openKey = open && notes.some((n) => rowKey(n) === open) ? open : null

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[13px] font-semibold tracking-tight text-foreground">Learned notes</h3>
        <p className="text-[12px] leading-snug text-muted-foreground">
          Written by the bot as it works, and recalled by relevance — a few per turn, not all at once.
        </p>
      </div>

      <div className="relative flex items-center">
        <Search className="pointer-events-none absolute left-3 size-3.5 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search what this bot has learned"
          aria-label="Search learned notes"
          className="h-10 w-full rounded-xl border border-input bg-background pl-9 pr-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {isLoading ? (
        <div className="h-16 animate-pulse rounded-xl border border-border bg-muted/30" />
      ) : notes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-4 text-[13px] leading-relaxed text-muted-foreground">
          {searching ? (
            <>No note matches “{debounced}”.</>
          ) : (
            <>
              This bot hasn’t written any notes yet — the core notes above are its curated index.
            </>
          )}
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
          {notes.map((n) => (
            <NoteRow
              key={rowKey(n)}
              session={name}
              note={n}
              expanded={openKey === rowKey(n)}
              onToggle={() => setOpen(openKey === rowKey(n) ? null : rowKey(n))}
            />
          ))}
        </ul>
      )}

      <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-muted-foreground">
        <Info className="mt-px size-3.5 shrink-0" aria-hidden />
        {data && (data.bot_count > 0 || data.role_count > 0) ? (
          <span>
            {data.bot_count} private
            {data.role_count > 0 && data.role
              ? ` · ${data.role_count} shared with role ${data.role}`
              : ''}{' '}
            · the bot writes these; you read them.
          </span>
        ) : (
          <span>The bot writes these itself; this view is read-only.</span>
        )}
      </p>
    </section>
  )
}

/** A tier + slug pair is the identity: the same slug can exist in both tiers. */
function rowKey(n: LearnedNote): string {
  return `${n.tier}:${n.slug}`
}

function NoteRow({
  session,
  note,
  expanded,
  onToggle,
}: {
  session: string
  note: LearnedNote
  expanded: boolean
  onToggle: () => void
}) {
  // The body is fetched only once a row is actually opened, and cached after.
  const { data: detail, isLoading } = useQuery({
    queryKey: ['learned-note', session, note.tier, note.slug],
    queryFn: () => getNote(session, note.slug, note.tier as NoteTier),
    enabled: expanded,
    staleTime: 60_000,
    retry: false,
  })

  return (
    <li className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full flex-col gap-1 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">{note.description}</span>
          <TierChip tier={note.tier} />
        </div>
        <div className="ml-5.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span className={cn('size-1.5 shrink-0 rounded-full', TYPE_DOT[note.note_type] ?? 'bg-muted-foreground')} aria-hidden />
          <span className="uppercase tracking-wide">{note.note_type}</span>
          <span aria-hidden>·</span>
          <span>{relTime(note.modified)}</span>
        </div>
        {!expanded && note.snippet && (
          <p className="ml-5.5 line-clamp-2 text-[12px] leading-snug text-muted-foreground">{note.snippet}</p>
        )}
      </button>

      {expanded && (
        <div className="border-t border-border bg-muted/20 px-3.5 py-3">
          {isLoading || !detail ? (
            <div className="h-10 animate-pulse rounded-lg bg-muted/40" />
          ) : (
            <React.Suspense
              fallback={
                <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-foreground">
                  {detail.body}
                </pre>
              }
            >
              <div className="text-[13px] leading-relaxed text-foreground">
                <ChatMarkdown text={detail.body} />
              </div>
            </React.Suspense>
          )}
        </div>
      )}
    </li>
  )
}

/** Which store the note came from — the bot's own, or its role's shared tier. */
function TierChip({ tier }: { tier: string }) {
  const role = tier === 'role'
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide',
        role
          ? 'bg-sky-500/12 text-sky-700 dark:text-sky-300'
          : 'bg-muted text-muted-foreground',
      )}
      title={role ? 'Shared with every bot in this role' : 'Private to this bot'}
    >
      {role ? 'role' : 'bot'}
    </span>
  )
}

/** Relative age of an RFC3339 `modified` stamp; blank stamps stay honest. */
function relTime(modified: string): string {
  const ms = Date.parse(modified)
  if (Number.isNaN(ms)) return 'date unknown'
  const delta = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (delta < 60) return 'just now'
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}
