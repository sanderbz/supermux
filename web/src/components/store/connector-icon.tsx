// The connector icon — a cached asset when we have one, a REAL brand mark when we
// recognise the connector, a tinted monogram tile only as the last resort.
//
// NEVER hotlinks: a `data:` URI renders directly; a catalog card resolves its
// locally-mirrored bytes via `/api/connectors/catalog/icon/{id}` (served
// same-origin, no third-party request). When no asset is present we draw the
// connector's canonical brand mark (bundled, see `brand-marks`) on its own
// App-Store-style tile — deliberately theme-independent so the mark reads the
// same in light and dark. Only a card we cannot brand at all falls to the
// tinted-monogram tile (the honest placeholder for user-authored connectors).
import * as React from 'react'

import { apiUrl } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import type { ConnectorCard } from '@/lib/api/connectors'

import { monogram, monogramHue } from './catalog'
import { brandMark } from './brand-marks'

function iconSrc(card: ConnectorCard): string | null {
  const icon = card.icon?.trim()
  if (icon && (icon.startsWith('data:') || icon.startsWith('/'))) return icon
  // A catalog card with any icon hint gets its same-origin mirror; the endpoint
  // 404s (→ onError → brand mark / monogram) when nothing was mirrored.
  if (card.source === 'catalog' && icon) {
    return apiUrl(`/api/connectors/catalog/icon/${encodeURIComponent(card.id)}`)
  }
  return null
}

export function ConnectorIcon({
  card,
  size = 44,
  className,
}: {
  card: ConnectorCard
  size?: number
  className?: string
}) {
  const src = iconSrc(card)
  const [broken, setBroken] = React.useState(false)
  const showImg = src && !broken
  const radius = Math.round(size * 0.29)
  const brand = brandMark(card)
  // ONE tile recipe, shared by the asset and the brand-mark branch. A mirrored
  // asset used to sit on `var(--card)` — invisible against the card behind it,
  // so a stroke-only SVG (the built-in browser's) floated with no tile at all
  // in dark (jury STORE_CARD #3). Now every icon wears the same App-Store tile.
  const tile = brand
    ? {
        background: `color-mix(in srgb, ${brand.hex} 9%, #ffffff)`,
        boxShadow: `inset 0 0 0 0.5px color-mix(in srgb, ${brand.hex} 26%, transparent)`,
      }
    : { background: 'var(--muted)', boxShadow: 'inset 0 0 0 0.5px var(--border)' }

  // 1) A real mirrored asset always wins.
  if (showImg) {
    return (
      <span
        aria-hidden
        className={cn('cs-icon relative grid shrink-0 place-items-center overflow-hidden', className)}
        style={{ width: size, height: size, borderRadius: radius, ...tile }}
      >
        <img
          src={src!}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setBroken(true)}
          className="size-full object-cover"
        />
      </span>
    )
  }

  // 2) A recognised brand → its real mark on an App-Store-style tile.
  if (brand) {
    return (
      <span
        aria-hidden
        className={cn(
          'cs-icon cs-brand relative grid shrink-0 place-items-center overflow-hidden',
          className,
        )}
        style={{ width: size, height: size, borderRadius: radius, color: brand.hex, ...tile }}
      >
        {brand.path ? (
          <svg
            viewBox="0 0 24 24"
            width={Math.round(size * 0.54)}
            height={Math.round(size * 0.54)}
            fill={brand.hex}
            aria-hidden
          >
            <path d={brand.path} />
          </svg>
        ) : (
          brand.node
        )}
      </span>
    )
  }

  // 3) Last resort: the tinted monogram (user-authored / unknown connectors).
  const hue = monogramHue(card.id)
  return (
    <span
      aria-hidden
      className={cn('cs-icon relative grid shrink-0 place-items-center overflow-hidden', className)}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `linear-gradient(150deg, hsl(${hue} 62% 52%), hsl(${(hue + 32) % 360} 66% 44%))`,
      }}
    >
      <span
        className="font-semibold text-white"
        style={{ fontSize: Math.round(size * 0.36), letterSpacing: '-0.02em' }}
      >
        {monogram(card.display_name || card.id)}
      </span>
    </span>
  )
}
