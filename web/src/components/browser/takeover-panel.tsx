/**
 * The takeover panel — the agent's page, on your screen, under your thumb.
 * ─────────────────────────────────────────────────────────────────────────────
 * A `<canvas>` fed base64 JPEGs off the takeover socket, plus a header that
 * answers the only two questions a human has while looking at it: *what am I
 * looking at* and *who is driving*. Pointer, wheel, keyboard and paste are
 * relayed back, coordinate-mapped through `frame-map.ts`.
 *
 * WHY JPEG→CANVAS AND NOT A VIDEO ELEMENT. iOS Safari is the target: MSE is
 * absent on iPhone, WebCodecs is recent-and-partial, and a `<video>` needs a
 * container format nobody is producing here. A JPEG decoded into a canvas is
 * the one path that works on every engine we ship to, and CDP hands us exactly
 * that. `createImageBitmap` does the decode off the main thread where it
 * exists, with an `<img>` fallback (see `decodeFrame`).
 *
 * DROP-OLD-FRAMES, CLIENT SIDE TOO. Decoding is async; a frame that finishes
 * decoding after a newer one arrived is thrown away rather than painted out of
 * order. Only one decode is ever in flight, which is also what keeps a slow
 * phone from queueing sixty stale frames — and, because the server acks only
 * what it has handed to us, that backpressure reaches all the way to chrome's
 * encoder.
 *
 * MOTION. There is no decorative animation here at all: the only thing that
 * moves is the page itself, which is content. The live dot's pulse is the one
 * exception and it is `motion-reduce:animate-none`.
 */
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions,
                  jsx-a11y/no-noninteractive-tabindex --
   The takeover surface is a `role="application"` widget: it takes the keyboard
   and the pointer wholesale and relays them to ANOTHER document. That is
   precisely what the role is for, and precisely what jsx-a11y's
   "non-interactive element" heuristic cannot model — here the interaction IS
   the element's purpose. The surface is keyboard reachable (`tabIndex={0}`) and
   labelled (`aria-label`), so the accessibility outcome the rules protect is
   met; wrapping the canvas in a <button> to satisfy them would break the
   coordinate mapping every gesture depends on. Scoped to this file, which
   contains exactly one such element. */
import * as React from 'react'

import { cn } from '@/lib/utils'
import {
  decodeFrame,
  fitFrame,
  frameSize,
  toPagePoint,
  type DecodedFrame,
  type TakeoverFrame,
} from '@/lib/browser/frame-map'
import {
  EMPTY_SNAPSHOT,
  TakeoverSocket,
  modifiersFor,
  type TakeoverOptions,
  type TakeoverSnapshot,
} from '@/lib/browser/takeover-socket'

/** Cap the backing store at 2× — a 3× phone would triple the fill cost of
 *  every frame for a JPEG that is 512px wide to begin with. */
const MAX_DPR = 2

export interface TakeoverPanelProps {
  /** The supermux session whose browser context this is. */
  session: string
  /** Injected for tests/benches; production passes nothing. */
  options?: TakeoverOptions
  /** The panel is hosted inside a surface that ALREADY states who is driving and
   *  already offers the single hand-back (the in-chat takeover overlay). Then
   *  this header must not draw its own mode badge and its own mode-flipping
   *  button beside the host's — one state, one control (jury TAKEOVER_PANEL #2).
   *  Standalone (the /dev bench, a future full-page route) keeps both. */
  embedded?: boolean
  className?: string
}

export function TakeoverPanel({ session, options, embedded, className }: TakeoverPanelProps) {
  const [snap, setSnap] = React.useState<TakeoverSnapshot>(EMPTY_SNAPSHOT)
  const boxRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const socketRef = React.useRef<TakeoverSocket | null>(null)

  /** The frame currently ON the canvas — the mapping basis for every gesture.
   *  A ref, not state: sixty re-renders a second to paint a canvas React does
   *  not own would be pure waste. */
  const paintedRef = React.useRef<{ image: DecodedFrame; frame: TakeoverFrame } | null>(null)

  React.useEffect(() => {
    // The decode loop lives INSIDE the effect, so its two pieces of mutable
    // state (the newest undecoded frame, and whether a decode is in flight) are
    // plain closure variables that are born and die with the socket rather than
    // refs that outlive it.
    let alive = true
    let pending: TakeoverFrame | null = null
    let decoding = false

    const paint = async (): Promise<void> => {
      if (decoding) return
      const next = pending
      pending = null
      if (!next) return
      decoding = true
      try {
        const image = await decodeFrame(next.data)
        const canvas = canvasRef.current
        const box = boxRef.current
        if (alive && canvas && box) {
          const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
          const cssW = box.clientWidth
          const cssH = box.clientHeight
          if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
            canvas.width = Math.round(cssW * dpr)
            canvas.height = Math.round(cssH * dpr)
          }
          const ctx = canvas.getContext('2d')
          if (ctx) {
            const fit = fitFrame({ width: cssW, height: cssH }, frameSize(image))
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            ctx.clearRect(0, 0, cssW, cssH)
            ctx.drawImage(image as CanvasImageSource, fit.left, fit.top, fit.width, fit.height)
          }
          paintedRef.current = { image, frame: next }
        }
      } catch {
        /* a frame that will not decode is a frame we skip */
      } finally {
        decoding = false
        // A newer frame landed while we were decoding: paint that one and drop
        // the ones in between — drop-old-frames, client side.
        if (alive && pending) void paint()
      }
    }

    const sock = new TakeoverSocket(
      session,
      setSnap,
      (frame) => {
        pending = frame
        void paint()
      },
      options,
    )
    socketRef.current = sock
    sock.start()
    return () => {
      alive = false
      pending = null
      sock.stop()
      socketRef.current = null
      paintedRef.current = null
    }
  }, [session, options])

  /** A pointer/wheel event's position in PAGE coordinates, or `null` when it
   *  landed on the letterbox (or before the first frame). */
  const pagePoint = React.useCallback((clientX: number, clientY: number) => {
    const box = boxRef.current
    const painted = paintedRef.current
    if (!box || !painted) return null
    const rect = box.getBoundingClientRect()
    return toPagePoint(
      { x: clientX - rect.left, y: clientY - rect.top },
      { width: rect.width, height: rect.height },
      frameSize(painted.image),
      painted.frame.metadata,
    )
  }, [])

  const driving = snap.mode === 'human_driving'

  // Wheel has to be a native listener: React's synthetic `onWheel` is passive
  // in every current engine, so `preventDefault` there is a no-op and the
  // takeover surface would scroll the supermux page instead of the agent's.
  React.useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (e: WheelEvent) => {
      if (!driving) return
      const p = pagePoint(e.clientX, e.clientY)
      if (!p) return
      e.preventDefault()
      socketRef.current?.wheel(p, { dx: e.deltaX, dy: e.deltaY })
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [driving, pagePoint])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Focus first so the keyboard follows the pointer into the page, even when
    // the gesture itself lands on the letterbox.
    e.currentTarget.focus({ preventScroll: true })
    if (!driving) return
    const p = pagePoint(e.clientX, e.clientY)
    if (!p) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    socketRef.current?.mouse('down', p, { buttons: 1, modifiers: modifiersFor(e) })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!driving) return
    const p = pagePoint(e.clientX, e.clientY)
    if (!p) return
    socketRef.current?.mouse('move', p, {
      buttons: e.buttons,
      modifiers: modifiersFor(e),
    })
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!driving) return
    const p = pagePoint(e.clientX, e.clientY)
    if (!p) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    socketRef.current?.mouse('up', p, { buttons: 0, modifiers: modifiersFor(e) })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!driving) return
    // Let the platform keep its own shortcuts (⌘R, ⌘T, devtools): a takeover
    // canvas that swallows them is a trap.
    if (e.metaKey && e.key !== 'Meta') return
    e.preventDefault()
    socketRef.current?.key('down', e)
  }

  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!driving) return
    if (e.metaKey && e.key !== 'Meta') return
    e.preventDefault()
    socketRef.current?.key('up', e)
  }

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (!driving) return
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (!text) return
    e.preventDefault()
    // `insertText`, not per-key events: it is the only path that carries
    // non-ASCII and emoji intact.
    socketRef.current?.text(text)
  }

  return (
    <div
      className={cn('flex min-h-0 flex-col overflow-hidden bg-paper text-ink', className)}
      data-takeover={session}
    >
      <header className="flex items-center gap-2 border-b border-hairline bg-surface px-3 py-2">
        {!embedded && <ModePill mode={snap.mode} state={snap.state} />}
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2"
          title={snap.url}
          data-takeover-url
        >
          {snap.url || '—'}
        </span>
        {embedded ? null : driving ? (
          <button
            type="button"
            onClick={() => socketRef.current?.handBack()}
            className="shrink-0 rounded-full border border-hairline bg-fill-soft px-3 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-fill-soft-2 motion-reduce:transition-none"
          >
            Hand back to agent
          </button>
        ) : (
          <button
            type="button"
            onClick={() => socketRef.current?.takeOver()}
            disabled={snap.state !== 'live'}
            className="shrink-0 rounded-full border border-hairline bg-fill-soft px-3 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-fill-soft-2 disabled:opacity-60 motion-reduce:transition-none"
          >
            Take over
          </button>
        )}
      </header>

      <div
        ref={boxRef}
        role="application"
        aria-label={`Shared browser for ${session}`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={onPaste}
        className={cn(
          'relative min-h-0 flex-1 touch-none select-none outline-none',
          'bg-[var(--sm-code-bg)]',
          driving ? 'cursor-default' : 'cursor-not-allowed',
        )}
      >
        <canvas ref={canvasRef} className="block h-full w-full" data-takeover-canvas />
        <StatusVeil state={snap.state} refused={snap.refused} />
      </div>
    </div>
  )
}

/** AGENT_DRIVING / HUMAN_DRIVING — the one thing that must never be ambiguous. */
function ModePill({
  mode,
  state,
}: {
  mode: TakeoverSnapshot['mode']
  state: TakeoverSnapshot['state']
}) {
  const human = mode === 'human_driving'
  const label = mode === null ? '—' : human ? 'HUMAN_DRIVING' : 'AGENT_DRIVING'
  return (
    <span
      data-takeover-mode={mode ?? 'unknown'}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-medium tracking-tight',
        human
          ? 'border-transparent bg-bubble-user text-bubble-user-ink'
          : 'border-hairline bg-fill-soft text-ink-2',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          human ? 'bg-current' : 'bg-ink-3',
          state === 'live' && human && 'animate-pulse motion-reduce:animate-none',
        )}
      />
      {label}
    </span>
  )
}

/** The only things worth covering the page for. A live socket renders nothing. */
function StatusVeil({
  state,
  refused,
}: {
  state: TakeoverSnapshot['state']
  refused: string | null
}) {
  const message =
    state === 'no-context'
      ? 'This session has no open page yet — the agent has to open one before you can take over.'
      : state === 'busy'
        ? 'Someone else is already driving this page.'
        : state === 'offline'
          ? 'Disconnected.'
          : state === 'reconnecting'
            ? 'Reconnecting…'
            : state === 'connecting'
              ? 'Connecting…'
              : null
  if (!message && !refused) return null
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3"
      data-takeover-status
    >
      <span className="rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink-2 backdrop-blur">
        {message ?? `Input ignored — ${refused}`}
      </span>
    </div>
  )
}
