// HostPicker — reusable dropdown that lists the registered remote hosts plus a
// "Local" option (id = null). Surfaces in the new-session sheet so the user
// picks where the agent runs. Default selection
// is Local (null) — preserves the historical behaviour for every existing
// session and keeps the picker invisible-by-default for users who have no
// remote hosts registered.
//
// We use the existing shadcn DropdownMenu primitive (the spec asks for a
// "shadcn Select", but this codebase ships the dropdown-menu and uses it for
// the equivalent "pick one from a fixed list" affordance — see the
// ModelPicker in routes/settings.tsx). Keeps the new component dep-free
// (no new package, no new primitive).
//
// "Local" sits at the top so the picker is one click to revert; remote hosts
// follow alphabetically with a small colored status dot mirroring the /hosts
// route's table. An empty host list collapses the menu to just "Local" + a
// muted "No remote hosts yet" hint — never a dead empty popup.

import * as React from 'react'
import { Check, ChevronsUpDown, Globe, Laptop } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useHosts } from '@/hooks/use-hosts'
import type { Host, HostStatus } from '@/lib/api'

/** Status dot — mirrors the table's color tokens so the picker reads at a
 *  glance. `reachable` = ready (status-ready, our green), `unreachable` =
 *  status-error (calm orange — matches the tile-error border treatment),
 *  `unknown` = muted (never-checked or stale). */
function StatusBlip({ status }: { status: HostStatus }) {
  const cls =
    status === 'reachable'
      ? 'bg-status-ready'
      : status === 'unreachable'
        ? 'bg-status-error'
        : 'bg-muted-foreground/50'
  return (
    <span
      aria-hidden
      className={cn('size-1.5 shrink-0 rounded-full', cls)}
    />
  )
}

export interface HostPickerProps {
  /** Currently selected host id; `null` = Local (the default). */
  value: number | null
  /** Fired when the user picks. `null` = Local. */
  onChange: (hostId: number | null) => void
  /** Optional id on the trigger (so a sibling <label htmlFor=…> binds). */
  id?: string
  /** Optional className passthrough on the trigger button. */
  className?: string
  /** Disabled state — used by the new-session form while submitting. */
  disabled?: boolean
}

export function HostPicker({
  value,
  onChange,
  id,
  className,
  disabled,
}: HostPickerProps) {
  const { data: hosts, isLoading, isError } = useHosts()

  // Sort hosts alphabetically by name so the picker is stable across renders
  // even if the server changes its list order.
  const sortedHosts = React.useMemo<Host[]>(
    () =>
      (hosts ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [hosts],
  )

  const selectedHost =
    value !== null ? sortedHosts.find((h) => h.id === value) ?? null : null

  // Label shown in the trigger. Local is the default; an unknown selected id
  // (host was deleted server-side between picks) degrades to "Local" so the
  // form never freezes on a phantom selection.
  const triggerLabel = selectedHost ? selectedHost.name : 'Local'
  const TriggerIcon = selectedHost ? Globe : Laptop

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          id={id}
          type="button"
          variant="outline"
          className={cn(
            'h-11 w-full justify-between gap-2 text-left text-sm font-normal',
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <TriggerIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[12rem]">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
          Run on
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => onChange(null)}
          className="justify-between gap-3"
        >
          <span className="flex items-center gap-2">
            <Laptop className="size-4 text-muted-foreground" />
            Local
          </span>
          {value === null && <Check className="size-4 text-primary" />}
        </DropdownMenuItem>

        {sortedHosts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
              Remote
            </DropdownMenuLabel>
            {sortedHosts.map((host) => (
              <DropdownMenuItem
                key={host.id}
                onSelect={() => onChange(host.id)}
                className="justify-between gap-3"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Globe className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{host.name}</span>
                  <StatusBlip status={host.status} />
                </span>
                {value === host.id && (
                  <Check className="size-4 shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {sortedHosts.length === 0 && !isLoading && !isError && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No remote hosts yet. Add one in Hosts.
            </p>
          </>
        )}
        {isLoading && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Loading hosts…
            </p>
          </>
        )}
        {isError && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-xs text-status-error">
              Couldn’t load hosts.
            </p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
