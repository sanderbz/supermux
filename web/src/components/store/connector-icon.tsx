// The connector icon — a cached asset when we have one, a tinted monogram tile
// when we don't. NEVER hotlinks: a `data:` URI renders directly; a catalog card
// resolves its locally-mirrored bytes via `/api/connectors/catalog/icon/{id}`
// (served same-origin, no third-party request); anything else falls to the
// monogram. An <img> that fails to load quietly reveals the monogram beneath it.
import * as React from 'react'

import { apiUrl } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import type { ConnectorCard } from '@/lib/api/connectors'

import { monogram, monogramHue } from './catalog'

function iconSrc(card: ConnectorCard): string | null {
  const icon = card.icon?.trim()
  if (icon && (icon.startsWith('data:') || icon.startsWith('/'))) return icon
  // A catalog card with any icon hint gets its same-origin mirror; the endpoint
  // 404s (→ onError → monogram) when nothing was mirrored.
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
  const hue = monogramHue(card.id)
  const showImg = src && !broken

  return (
    <span
      aria-hidden
      className={cn('cs-icon relative grid shrink-0 place-items-center overflow-hidden', className)}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.29),
        background: showImg
          ? 'var(--card)'
          : `linear-gradient(150deg, hsl(${hue} 62% 52%), hsl(${(hue + 32) % 360} 66% 44%))`,
      }}
    >
      {showImg ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setBroken(true)}
          className="size-full object-cover"
        />
      ) : (
        <span
          className="font-semibold text-white"
          style={{ fontSize: Math.round(size * 0.36), letterSpacing: '-0.02em' }}
        >
          {monogram(card.display_name || card.id)}
        </span>
      )}
    </span>
  )
}
