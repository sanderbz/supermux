import type { ReactNode } from 'react'
import { ScrollText, TriangleAlert } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useAuditLog } from '@/hooks/use-settings'
import { EmptyStatePlaceholder } from '@/components/empty-state'
import type { AuditEntry } from '@/lib/api'

/** Parse the audit `ts` field. The server sends epoch **seconds** as a number
 *  (`runtime_state.rs` → `ts = Utc::now().timestamp()`); we still tolerate a
 *  string / epoch-millis just in case a different serializer shows up. */
function toDate(ts: number | string | undefined): Date | null {
  if (ts == null) return null
  const n = typeof ts === 'number' ? ts : Number(ts)
  if (!Number.isNaN(n) && String(ts).trim() !== '') {
    // Heuristic: < 1e12 → seconds, otherwise millis.
    return new Date(n < 1e12 ? n * 1000 : n)
  }
  const d = new Date(String(ts))
  return Number.isNaN(d.getTime()) ? null : d
}

function relativeTime(ts: number | string | undefined): string {
  const d = toDate(ts)
  if (!d) return '—'
  const diff = Date.now() - d.getTime()
  const s = Math.round(diff / 1000)
  if (s < 60) return `${Math.max(s, 0)}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.round(h / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString()
}

function detailText(detail?: string): string {
  if (!detail) return ''
  // Detail is a JSON string column (§6.4). Render compactly; never a secret.
  try {
    const v = JSON.parse(detail)
    if (typeof v === 'string') return v
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}: ${String(val)}`)
      .join(' · ')
  } catch {
    return detail
  }
}

function Skeleton() {
  return (
    <div className="flex flex-col divide-y divide-border">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="h-3.5 w-28 animate-pulse rounded bg-muted/60" />
          <div className="ml-auto h-3.5 w-14 animate-pulse rounded bg-muted/40" />
        </div>
      ))}
    </div>
  )
}

function Inline({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-6 text-[13px] text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0">
      {icon}
      <span>{children}</span>
    </div>
  )
}

function Entry({ row, dim }: { row: AuditEntry; dim: boolean }) {
  const detail = detailText(row.detail)
  // Surface who (actor) + what (target) alongside the JSON detail — the server
  // sends both but the UI used to drop them. Compose a compact context line.
  const context = [row.actor, row.target].filter(Boolean).join(' · ')
  const sub = [context, detail].filter(Boolean).join(' — ')
  return (
    <div className="flex items-baseline gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[13px] text-foreground">{row.action}</div>
        {sub ? (
          <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
            {sub}
          </div>
        ) : null}
      </div>
      <time
        className={cn('shrink-0 text-[12px] tabular-nums text-muted-foreground', dim && 'opacity-60')}
        title={toDate(row.ts)?.toLocaleString() ?? undefined}
      >
        {relativeTime(row.ts)}
      </time>
    </div>
  )
}

/** Audit log viewer (§6.4) — last N rows. Graceful loading / error / empty. */
export function AuditLog() {
  const { data, isLoading, isError } = useAuditLog(200)

  if (isLoading) return <Skeleton />

  if (isError) {
    return (
      <Inline icon={<TriangleAlert />}>
        Can’t reach the audit log. The server may not expose it yet.
      </Inline>
    )
  }

  const rows = data ?? []
  if (rows.length === 0) {
    return (
      <EmptyStatePlaceholder
        icon={<ScrollText />}
        message="No audit events yet."
        className="py-10"
      />
    )
  }

  return (
    <div className="flex max-h-[24rem] flex-col divide-y divide-border overflow-auto">
      {rows.map((row, i) => (
        <Entry key={row.id ?? i} row={row} dim={i > 0} />
      ))}
    </div>
  )
}
