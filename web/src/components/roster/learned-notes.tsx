// The bot-panel Memory surface — the ARCHIVAL (learned-notes) list beside the
// CORE notes editor. Honest labels throughout: core notes are the capped,
// always-injected set; learned notes are recalled by relevance, not all at once.
//
// Degrades gracefully: until the memory HTTP routes ship, the list renders a
// truthful empty state and search is disabled — it never claims total recall.
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Info, Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import { listNotes, MEMORY_ROUTES_LIVE, type LearnedNote } from '@/lib/api/memory'

const TYPE_DOT: Record<string, string> = {
  decision: 'bg-sky-500',
  bugfix: 'bg-rose-500',
  reference: 'bg-violet-500',
  feedback: 'bg-amber-500',
}

export function LearnedNotes({ name }: { name: string }) {
  const [q, setQ] = React.useState('')
  const { data, isLoading } = useQuery<LearnedNote[]>({
    queryKey: ['learned-notes', name],
    queryFn: () => listNotes(name),
    staleTime: 30_000,
    retry: false,
  })

  const notes = data ?? []
  const routesLive = MEMORY_ROUTES_LIVE && !isLoading
  const filtered = q.trim()
    ? notes.filter(
        (n) =>
          n.title.toLowerCase().includes(q.toLowerCase()) ||
          (n.body ?? '').toLowerCase().includes(q.toLowerCase()),
      )
    : notes

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[13px] font-semibold tracking-tight text-foreground">Learned notes</h3>
          <p className="text-[12px] leading-snug text-muted-foreground">
            The bot writes these as it works.
          </p>
        </div>
      </div>

      <div className="relative flex items-center">
        <Search className="pointer-events-none absolute left-3 size-3.5 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={!routesLive || notes.length === 0}
          placeholder="Search notes"
          aria-label="Search learned notes"
          className="h-10 w-full rounded-xl border border-input bg-background pl-9 pr-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        />
      </div>

      {isLoading ? (
        <div className="h-16 animate-pulse rounded-xl border border-border bg-muted/30" />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-4 text-[13px] text-muted-foreground">
          {q
            ? `No learned notes match "${q}".`
            : "Your bot hasn't written learned notes yet."}
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
          {filtered.map((n) => (
            <li key={n.id} className="flex flex-col gap-1 px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <span className={cn('size-1.5 shrink-0 rounded-full', TYPE_DOT[n.type] ?? 'bg-muted-foreground')} aria-hidden />
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{n.type}</span>
                <span className="truncate text-[13.5px] text-foreground">{n.title}</span>
              </div>
              <div className="ml-3.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
                <span>{relTime(n.created_at)}</span>
                <span>·</span>
                <span>{n.scope.kind === 'role' ? `role:${n.scope.role}` : 'bot'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-muted-foreground">
        <Info className="mt-px size-3.5 shrink-0" aria-hidden />
        These are recalled by relevance, not all at once.
      </p>
    </div>
  )
}

function relTime(sec: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - sec))
  if (delta < 60) return 'just now'
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}
