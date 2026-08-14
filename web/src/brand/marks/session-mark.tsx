/**
 * <SessionMark> — the face of a session.
 * ─────────────────────────────────────────────────────────────────────────────
 * Inline SVG, flat fill, white eyes. Everything about the character comes from
 * the seed (`./character`); everything about its outline from `./geometry`; the
 * heartbeat from `./ticker`. This file only wires those to the DOM.
 *
 * What the component guarantees:
 *   · the silhouette NEVER moves — state lives exclusively in the eyes
 *     (concept contract C5: the face is the status indicator, and nothing ever
 *     overpaints or notches the body);
 *   · ambient life on the live states — a per-seed blink, a micro-saccade while
 *     waiting, and a 5.4s breathe with a per-seed phase, so a calm roster reads
 *     as "eight colleagues sitting there", never as eight synchronised icons;
 *   · `prefers-reduced-motion` renders the identical face, permanently open and
 *     perfectly still — no information is carried by motion alone;
 *   · offscreen marks unregister from the rAF loop and pause the breathe, so a
 *     long roster costs only what is visible.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

// Relative, not `@/lib/utils`: the unit runner (`bun test`) resolves this file
// directly and does not read the app tsconfig's path aliases.
import { cn } from '../../lib/utils'

import {
  characterFromSeed,
  eyesFor,
  isLive,
  type MarkPin,
  type MarkState,
} from './character'
import { eyePath, poseQuat, silhouettePath, VIEWBOX } from './geometry'
import { registerMark } from './ticker'
import { useOnScreen } from './use-on-screen'

export interface SessionMarkProps {
  /** The session's name. The face is a pure function of it. */
  seed: string
  /** Rendered box in px. The geometry is resolution-independent. */
  size?: number
  /** Presence. `done`/`stopped` are stills by design. */
  state?: MarkState
  className?: string
  /**
   * Identity channels fixed by the roster deduper (`assignRoster`). Omit and the
   * character is hash-pure — correct for a single mark out of roster context.
   */
  pin?: MarkPin
  /**
   * Facepile keyline: the page colour, stroked under the fill so overlapping
   * crew members separate. `null` (default) draws no ring.
   */
  ring?: string | null
  /** Opt out of animation (dense strips, drag previews, print). */
  animate?: boolean
  /**
   * Accessible name. Pass `null` where the row already renders the session name
   * — a duplicate label is noise for a screen reader.
   */
  label?: string | null
}

/** Live `prefers-reduced-motion`. No DOM (SSR, tests) ⇒ the still frame. */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function SessionMark({
  seed,
  size = 40,
  state = 'idle',
  className,
  pin,
  ring = null,
  animate = true,
  label,
}: SessionMarkProps) {
  const pinKey = pin ? `${pin.silhouette ?? ''}|${pin.hue ?? ''}|${pin.gaze ?? ''}|${pin.tilt ?? ''}` : ''
  const ch = useMemo(
    () => characterFromSeed(seed, pin),
    // The pin is a value, not an identity — re-derive only when it really changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seed, pinKey],
  )

  const reduced = useReducedMotion()
  const host = useRef<HTMLSpanElement>(null)
  const leftEye = useRef<SVGPathElement>(null)
  const rightEye = useRef<SVGPathElement>(null)

  const wantsMotion = animate && !reduced && isLive(state)
  const onScreen = useOnScreen(host, wantsMotion)
  const live = wantsMotion && onScreen

  const { body, eyeL, eyeR } = useMemo(() => {
    const q = poseQuat(ch)
    const e = eyesFor(ch, state)
    return {
      body: silhouettePath(ch),
      // The still frame is the fully-open eye: what reduced motion keeps, and
      // what every mark paints before the first animation frame lands.
      eyeL: eyePath(ch, q, e, -1, 1),
      eyeR: eyePath(ch, q, e, 1, 1),
    }
  }, [ch, state])

  useEffect(() => {
    const left = leftEye.current
    const right = rightEye.current
    if (!live || !left || !right) return
    const stop = registerMark({ ch, state, left, right })
    return () => {
      stop()
      // Leave the face on the still frame: React will not rewrite `d` (the prop
      // never changed), so a mark paused mid-blink would otherwise stay winking.
      left.setAttribute('d', eyeL)
      right.setAttribute('d', eyeR)
    }
  }, [ch, state, live, eyeL, eyeR])

  const hidden = label === null
  // Facepile keyline: authored in viewBox units so it stays 2 CSS px at any size.
  const ringWidth = ring ? (2 * (VIEWBOX * 2)) / size : 0

  return (
    <span
      ref={host}
      className={cn('sm-mark', className)}
      data-shape={ch.silhouette}
      data-state={state}
      data-hue={ch.hue}
      {...(live ? { 'data-live': '1' } : {})}
      style={{ width: size, height: size }}
      aria-hidden={hidden || undefined}
    >
      <svg
        viewBox={`${-VIEWBOX} ${-VIEWBOX} ${VIEWBOX * 2} ${VIEWBOX * 2}`}
        width={size}
        height={size}
        role={hidden ? undefined : 'img'}
        aria-label={hidden ? undefined : (label ?? seed)}
        aria-hidden={hidden || undefined}
        // Per-seed phase: the roster breathes out of step with itself.
        style={live ? { animationDelay: `${(-ch.clock).toFixed(2)}s` } : undefined}
      >
        <path
          className="sm-mark__body"
          d={body}
          fill={ch.color}
          {...(ring
            ? {
                stroke: ring,
                strokeWidth: ringWidth.toFixed(1),
                paintOrder: 'stroke' as const,
                strokeLinejoin: 'round' as const,
              }
            : {})}
        />
        <path ref={leftEye} className="sm-mark__eye" d={eyeL} fill={ch.ink} />
        <path ref={rightEye} className="sm-mark__eye" d={eyeR} fill={ch.ink} />
      </svg>
    </span>
  )
}
