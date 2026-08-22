import { ChevronRight, House } from 'lucide-react'

import { cn } from '@/lib/utils'

interface Crumb {
  label: string
  path: string
}

function toCrumbs(abs: string, floor?: string | null): Crumb[] {
  const parts = abs.split('/').filter(Boolean)
  const out: Crumb[] = [{ label: '', path: '/' }] // root (House icon)
  let cur = ''
  for (const p of parts) {
    cur += `/${p}`
    out.push({ label: p, path: cur })
  }
  if (!floor) return out
  // Company-scoped Files floors the crumbs at the company root: no crumb ABOVE
  // it is shown, and the floor becomes the House root the owner can return to —
  // there is no walking out of the company via the breadcrumb.
  const f = floor.length > 1 ? floor.replace(/\/+$/, '') : floor
  const idx = out.findIndex((c) => c.path === f)
  if (idx <= 0) return out // floor not on this chain (or is `/`) → leave as-is
  const sliced = out.slice(idx)
  sliced[0] = { label: '', path: sliced[0].path } // floor renders as the House
  return sliced
}

export interface BreadcrumbProps {
  /** Resolved absolute directory path. */
  path: string
  onNavigate: (path: string) => void
  /** When set, the breadcrumb FLOORS here: crumbs above this dir are dropped and
   *  this dir becomes the House root. Company-scoped Files passes the company
   *  root so the owner can't walk out of the company folder via the crumbs. */
  floor?: string | null
}

/** Horizontally-scrollable path breadcrumb. Each segment is a ≥44 pt
 *  touch target; the trailing segment is the current directory and is inert. */
export function Breadcrumb({ path, onNavigate, floor }: BreadcrumbProps) {
  const crumbs = toCrumbs(path, floor)
  return (
    <nav
      aria-label="Path"
      className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <ol className="flex items-center">
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1
          const isRoot = i === 0
          return (
            <li key={crumb.path} className="flex shrink-0 items-center">
              {i > 0 && (
                <ChevronRight
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground/50"
                />
              )}
              <button
                type="button"
                disabled={isLast}
                onClick={() => onNavigate(crumb.path)}
                aria-current={isLast ? 'page' : undefined}
                title={crumb.path}
                className={cn(
                  'flex h-11 max-w-[12rem] items-center gap-1.5 truncate rounded-lg px-2 text-sm transition-colors',
                  isLast
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground active:bg-accent',
                )}
              >
                {isRoot ? (
                  <House className="size-4 shrink-0" />
                ) : (
                  <span className="truncate">{crumb.label}</span>
                )}
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
