import { cn } from '@/lib/utils'

/** Initial-load placeholder (§4.12). Mirrors the tile's shape to suppress
 *  layout shift; three pulse stripes stand in for title / meta / preview.
 *  Shown only until the SSE `sessions` event lands (≤200ms in practice). */
export function TileSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border bg-card p-3',
        className,
      )}
      style={{ height: 156 }}
    >
      <div className="h-3 w-2/3 animate-pulse rounded-md bg-muted" />
      <div className="mt-2 h-2 w-2/5 animate-pulse rounded-md bg-muted/70" />
      <div className="mt-5 space-y-1.5">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-2 animate-pulse rounded bg-muted/40"
            style={{ width: `${85 - i * 12}%` }}
          />
        ))}
      </div>
    </div>
  )
}
