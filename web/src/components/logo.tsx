// Logo — the supermux brand mark (v6).
//
// Two filled chevron-banner shapes in a vertical blue gradient. Inlined as SVG
// so it scales crisply at any size and inherits no extra network hop. Master
// at `brand/logo-supermux.svg` (repo root) is the single source of truth —
// see `brand/preview/` for the radius critique.
//
// Usage:
//   <Logo className="size-8" />                  // square, sized via Tailwind
//   <Logo className="h-6 w-auto" />              // height-locked, aspect-ratio preserved
//
// Visual notes:
//   - viewBox is tight to the chevron bbox (no negative padding) so callers
//     control the visual size with width/height utilities.
//   - The gradient id is suffixed with a stable instance counter so multiple
//     <Logo>s on the same page do not collide on '#g'. (Two <Logo>s with the
//     same id would cause Safari to share the first instance's gradient.)
import { useId } from 'react'

interface LogoProps {
  className?: string
  title?: string
}

export function Logo({ className, title = 'supermux' }: LogoProps) {
  const id = useId().replace(/:/g, '')
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="294 158 474 704"
      role="img"
      aria-label={title}
      className={className}
    >
      <title>{title}</title>
      <defs>
        <linearGradient id={`logo-g-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3da0ff" />
          <stop offset="100%" stopColor="#007aff" />
        </linearGradient>
      </defs>
      <g transform="translate(357.67,157.60) scale(0.8166)">
        <path
          d="M 264.233,306.112 L 2.141,2.480 A 1.50,1.50 0 0 1 3.276,0.000 L 249.297,0.000 A 1.50,1.50 0 0 1 250.450,0.540 L 492.787,291.728 A 18.00,18.00 0 0 1 492.034,315.605 L 400.444,412.530 A 1.50,1.50 0 0 1 399.354,413.000 L 192.899,413.000 A 1.50,1.50 0 0 1 191.674,410.634 L 264.322,307.958 A 1.50,1.50 0 0 0 264.233,306.112 Z"
          fill={`url(#logo-g-${id})`}
        />
      </g>
      <g transform="translate(293.97,529.15) scale(0.8166)">
        <path
          d="M 219.543,405.460 L 0.867,147.024 A 1.50,1.50 0 0 1 0.922,145.025 L 137.556,0.470 A 1.50,1.50 0 0 1 138.646,0.000 L 308.094,0.000 A 1.50,1.50 0 0 1 309.316,2.369 L 225.679,120.044 A 1.50,1.50 0 0 0 225.764,121.890 L 441.897,373.747 A 18.00,18.00 0 0 1 428.455,403.468 L 220.707,405.991 A 1.50,1.50 0 0 1 219.543,405.460 Z"
          fill={`url(#logo-g-${id})`}
        />
      </g>
    </svg>
  )
}
