/**
 * `<Skeleton>` — the ONE loading placeholder (B5/T11.1).
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * Seven idioms, none of which shared a line: the tile skeleton, a local
 * `Skeleton()` in the audit log, `RunsSkeleton`, `ListSkeleton`, an inline
 * `LoadingRows`, four bare `animate-pulse` blocks, and two SHIMMER variants
 * built a completely different way (a framer gradient sweep).
 *
 * Seven idioms is seven chances to get the accessibility wrong, and it mostly
 * was: a placeholder that announces nothing leaves a screen-reader user with
 * silence where a sighted user sees motion. Every `<Skeleton>` carries
 * `aria-hidden`, and the SURFACE owns one `role="status"` region — which is the
 * right split, because ten shimmering rows are one loading state, not ten.
 *
 * ── shimmer vs pulse is a PROP, not a second component ──────────────────────
 * Both existed, for a reason worth keeping: `pulse` is the cheap CSS-only
 * placeholder for a list of rows, while `shimmer` is the more deliberate sweep
 * used where a single large surface is loading and the wait is expected to be
 * noticeable (the compose sheet's textarea). Making that a prop keeps the
 * choice available without keeping two implementations of it.
 *
 * Under Reduce Motion BOTH degrade to a static block. A skeleton is decoration
 * around an absence — unlike a spinner, which is functional feedback and keeps
 * moving (see `StatusDot`).
 */
import { cn } from '@/lib/utils'

export interface SkeletonProps {
  /** Extra classes — the geometry lives at the call site, since only the call
   *  site knows the shape of the thing that is missing. */
  className?: string
  /** `pulse` (default) is the cheap CSS opacity loop. `shimmer` is the sweeping
   *  band, for a single large surface where the wait is expected to be felt. */
  variant?: 'pulse' | 'shimmer'
  /** Inline style, for the odd percentage width a class cannot express. */
  style?: React.CSSProperties
}

export function Skeleton({ className, variant = 'pulse', style }: SkeletonProps) {
  return (
    <div
      // ALWAYS hidden from assistive tech. The surface announces "loading"
      // once, as a region; the individual bars are shape, not information, and
      // announcing each one turns one loading state into ten.
      aria-hidden
      data-skeleton={variant}
      className={cn(
        'rounded-md bg-muted',
        variant === 'pulse'
          ? 'animate-pulse'
          : // The shimmer is a CSS-only sweep so it costs no framer subscription
            // per bar — the old version mounted a motion component each, which
            // is why it was only ever used in one place.
            'sm-skeleton-shimmer relative overflow-hidden',
        // Both stop moving under Reduce Motion: a skeleton is decoration around
        // an absence, not feedback about work in progress.
        'motion-reduce:animate-none',
        className,
      )}
      style={style}
    />
  )
}

/**
 * The wrapper that makes a group of skeletons ONE announced loading state.
 *
 * Use it around whatever set of `<Skeleton>`s stands in for a surface. Without
 * it the skeletons are silent (they are `aria-hidden` by design) and a
 * screen-reader user is told nothing at all — which is worse than the seven
 * idioms were, and is the trap a shared primitive has to close rather than
 * open.
 */
export function SkeletonRegion({
  label = 'Loading…',
  className,
  children,
}: {
  /** What is loading. Specific beats generic: "Loading sessions…" tells a user
   *  which part of the page is pending when several are. */
  label?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}
