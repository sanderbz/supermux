import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

/** Initial-load placeholder. Mirrors the tile's shape to suppress
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
      <Skeleton className="h-3 w-2/3 bg-muted" />
      <Skeleton className="mt-2 h-2 w-2/5 bg-muted/70" />
      <div className="mt-5 space-y-1.5">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton
            key={i}
            className="h-2 rounded bg-muted/40"
            style={{ width: `${85 - i * 12}%` }}
          />
        ))}
      </div>
    </div>
  )
}
