// FireLog — surfaces the already-persisted last_run / next_run / run_count
// fields (db::schedules) as a friendly fire log. Used in the editor sheet (the
// full card) and, via `formatRunTime`, on each list row. Relative time is shown
// inline with the absolute datetime on hover (title attribute) — no extra click.

import { History, Timer } from 'lucide-react'

import { formatFull, formatRunTime } from './helpers'

interface FireLogProps {
  lastRun: string | null
  nextRun: string | null
  runCount: number
  paused?: boolean
}

/** A bordered two-up card: when it last fired + when it fires next. */
export function FireLog({ lastRun, nextRun, runCount, paused }: FireLogProps) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
      <FireCell
        icon={<Timer className="size-4" />}
        label="Next fire"
        value={paused ? 'Paused' : formatRunTime(nextRun)}
        title={!paused && nextRun ? formatFull(nextRun) : undefined}
        muted={paused}
      />
      <FireCell
        icon={<History className="size-4" />}
        label="Last fired"
        value={lastRun ? formatRunTime(lastRun) : 'Never'}
        title={lastRun ? formatFull(lastRun) : undefined}
        sub={runCount > 0 ? `${runCount} run${runCount === 1 ? '' : 's'}` : undefined}
        muted={!lastRun}
      />
    </div>
  )
}

function FireCell({
  icon,
  label,
  value,
  title,
  sub,
  muted,
}: {
  icon: React.ReactNode
  label: string
  value: string
  title?: string
  sub?: string
  muted?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 bg-card p-3" title={title}>
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </span>
      <span
        className={
          muted
            ? 'text-sm text-muted-foreground'
            : 'text-sm font-medium text-foreground'
        }
      >
        {value}
      </span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  )
}
