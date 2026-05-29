// HostBadge — a small "this session runs on a remote
// host" indicator. Rendered on session tiles + rows when `session.host_id`
// is set; absent (and consuming zero space) for local sessions.
//
// Design constraints:
//   * Globe icon (lucide-react `Globe` — the icon set this codebase already
//     imports; see layout.tsx, settings.tsx, etc.).
//   * Truncated host name, max width ~80px.
//   * Subtle styling — muted text, low contrast — must NOT compete with the
//     status dot (which is the primary attention signal on the tile).
//   * Hover/tap reveals the full hostname via a tooltip.
//
// We look the host up out of the shared TanStack-Query `hosts` cache instead
// of taking the name as a prop, so the badge auto-updates if the host is
// renamed elsewhere (re-fetch invalidates the cache; every tile re-renders).
// When the host id doesn't resolve (cache miss, deleted host, fresh boot
// before the hosts list is fetched), we degrade to "remote · {id}" so the
// badge is still legible and never blank.

import { Globe } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useHosts } from '@/hooks/use-hosts'

export interface HostBadgeProps {
  hostId: number
  /** Optional className passthrough (positioning is the caller's job — the
   *  tile pins this top-right, list rows put it inline). */
  className?: string
}

export function HostBadge({ hostId, className }: HostBadgeProps) {
  const { data: hosts } = useHosts()
  const host = hosts?.find((h) => h.id === hostId) ?? null
  const label = host?.name ?? `host ${hostId}`
  const fullTitle = host
    ? `${host.name} (${host.ssh_target})`
    : `Remote host id ${hostId}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={`Runs on ${label}`}
          className={cn(
            // Small pill: muted text + low-opacity background so it sits
            // calmly next to the status dot. `max-w-[80px]` per spec; the
            // truncate clamps the rendered name when it overflows.
            'inline-flex max-w-[80px] items-center gap-1 rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground',
            className,
          )}
        >
          <Globe className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{fullTitle}</TooltipContent>
    </Tooltip>
  )
}
