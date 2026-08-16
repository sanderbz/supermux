// /dev/tiles — verification page (DEV-only; lazy-loaded so neither this
// route nor the mock data ships in production). Renders 12 mocked sessions in
// the real tile grid plus toggles for skeleton / error / reduced-motion so the
// visual critic can check every state and the alt (Reduce Motion) path.
//
// Reduce Motion is forced via <MotionConfig reducedMotion="always"> (Framer's
// override of the OS media query) and persisted in the URL (?reduce=1).
// Skeleton and error toggles are URL-backed too, so a
// reviewer can deep-link any state.
//
// `?chat=1` seeds the fase-A5 experiment ON (the SAME store the Settings toggle
// writes — no dev-only fork of the decision), so the chat-tail preview is
// screenshot-able offline. It is worth one frame precisely because the guard is
// visible in it: `web-app` is eligible AND has a `chat_tail`, so it shows the
// conversation; `api-server` is eligible with NO tail, and `codex-app` /
// `kimi-app` are ineligible — all three keep the ANSI screen. With the param
// absent (the shipped default) every tile is byte-identical to before A5.

import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { MotionConfig } from 'framer-motion'

import { cn } from '@/lib/utils'
import { Toggle } from '@/components/ui/toggle'
import { SessionTile } from '@/components/session-tile'
import { TileSkeleton } from '@/components/session-tile/tile-skeleton'
import { MOCK_TILES } from '@/components/session-tile/mock'
import { useUI } from '@/stores/ui-store'
import type { TileSession } from '@/components/session-tile'

const GRID =
  'grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4'

export default function DevTiles() {
  const [params, setParams] = useSearchParams()
  const reduce = params.get('reduce') === '1'
  const skeleton = params.get('skeleton') === '1'
  const error = params.get('error') === '1'
  // Written during render on purpose: the tiles below read `useUI` in the SAME
  // pass, so an effect would paint one ANSI frame into every screenshot.
  // `setState` outside React is zustand's documented API, and this is a DEV-only
  // route (mirrors `/dev/focus-mobile?chat=1`).
  if (params.get('chat') === '1' && !useUI.getState().chatRenderer) {
    useUI.setState({ chatRenderer: true })
  }

  // Live tail demo: append a line to the first tile every 1.6s to exercise the
  // layout slide-up + "no scroll jump / no flicker on update" acceptance bullet.
  const [tiles, setTiles] = React.useState<TileSession[]>(MOCK_TILES)
  React.useEffect(() => {
    let n = 0
    const id = window.setInterval(() => {
      n += 1
      setTiles((prev) => {
        const [first, ...rest] = prev
        return [
          {
            ...first,
            preview_lines: [
              ...first.preview_lines.slice(-13),
              `● tick ${n} — appended line at ${new Date().toLocaleTimeString()}`,
            ],
          },
          ...rest,
        ]
      })
    }, 1600)
    return () => window.clearInterval(id)
  }, [])

  const toggle = (key: string, on: boolean) => {
    setParams(
      (p) => {
        if (on) p.set(key, '1')
        else p.delete(key)
        return p
      },
      { replace: true },
    )
  }

  return (
    <MotionConfig reducedMotion={reduce ? 'always' : 'user'}>
      <div className="mx-auto h-full w-full max-w-6xl overflow-auto px-3 py-6 sm:px-4">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <h1 className="mr-2 text-2xl font-semibold tracking-tight">
            Session tiles
          </h1>
          <DevToggle
            label="Skeleton"
            pressed={skeleton}
            onPressedChange={(v) => toggle('skeleton', v)}
          />
          <DevToggle
            label="Error grid"
            pressed={error}
            onPressedChange={(v) => toggle('error', v)}
          />
          <DevToggle
            label="Reduce motion"
            pressed={reduce}
            onPressedChange={(v) => toggle('reduce', v)}
          />
          <span className="text-xs text-muted-foreground">
            Resize to 375 / 390 / 1024 / 1440 to check the 1→4 column grid.
          </span>
        </div>

        {skeleton ? (
          <div className={GRID}>
            {Array.from({ length: 12 }).map((_, i) => (
              <TileSkeleton key={i} />
            ))}
          </div>
        ) : (
          <div className={cn(GRID)}>
            {(error
              ? tiles.map((t) => ({ ...t, missing: true }))
              : tiles
            ).map((session) => (
              <SessionTile
                key={session.name}
                session={session}
                onReattach={(name) => console.info('reattach', name)}
                onRemove={(name) => console.info('remove', name)}
              />
            ))}
          </div>
        )}
      </div>
    </MotionConfig>
  )
}

function DevToggle({
  label,
  pressed,
  onPressedChange,
}: {
  label: string
  pressed: boolean
  onPressedChange: (v: boolean) => void
}) {
  return (
    <Toggle
      size="sm"
      variant="outline"
      pressed={pressed}
      onPressedChange={onPressedChange}
      aria-label={label}
      className="px-3"
    >
      {label}
    </Toggle>
  )
}
