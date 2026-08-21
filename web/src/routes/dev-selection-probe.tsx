// /dev/selection-probe — DEV-ONLY bench for the text-selection stand-down.
//
// Proves, against the REAL shipping code, that a held text selection survives the
// ~1s peek re-render / height reflow that used to wipe it:
//
//   · CHAT  — a real `[data-chat-track]` scroller pinned to bottom, driven by the
//             REAL `useDeferredFollow` hook (`follow-bottom.ts`, the exact hook
//             `chat-panel.tsx` uses). `window.__sel.chat.tick()` forces the peek
//             re-render; the follow write is deferred while a selection is held
//             and flushes on clear.
//   · TERM  — a REAL xterm `Terminal` + `FitAddon`, with the REAL
//             `shouldDeferReflow` decision (`use-live-term.ts`). Shows the
//             baseline wipe (a forced height fit clears the selection), the guard
//             (a deferred height fit keeps it), that a WIDTH change still refits,
//             and that `term.write()` never clears the selection.
//
// Registered behind `import.meta.env.DEV` in `App.tsx` (same lazy pattern as
// /dev/term, /dev/renderer-thrash), so it is absent from a production bundle and
// the base app is completely unaffected.

import * as React from 'react'

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

import { useDeferredFollow } from '@/components/chat/follow-bottom'
import { shouldDeferReflow } from '@/hooks/use-live-term'
import '@xterm/xterm/css/xterm.css'

declare global {
  interface Window {
    __sel?: {
      chat?: {
        /** Force a peek-style re-render (runs the follow effect). */
        tick(): void
        /** Append a message and re-render (new content arriving mid-selection). */
        addMessage(): void
        /** Scroll the reader up off the bottom. */
        scrollUp(): void
        /** Distance from the live bottom, in px (0 ⇒ pinned). */
        distanceFromBottom(): number
        pinned(): boolean
      }
      term?: {
        hasSelection(): boolean
        selectFirstLine(): void
        cols(): number
        rows(): number
        /** Write bytes to the pty surface (live output). */
        write(text: string): void
        /** Shrink the container by `px` then FORCE an unguarded fit (baseline wipe). */
        forceHeightFit(px: number): void
        /** Shrink the container by `px` then take the GUARDED path (defer if selecting). */
        guardedHeightFit(px: number): void
        /** Change the container WIDTH then take the guarded path (still refits). */
        guardedWidthFit(px: number): void
        /** Whether the last guarded fit was deferred. */
        lastDeferred(): boolean
      }
    }
  }
}

const MESSAGES = Array.from({ length: 40 }, (_, i) =>
  `Message ${i + 1}: the quick brown fox jumps over the lazy dog — selectable transcript text that a reader can long-press and copy on a confirmed assistant bubble number ${i + 1}.`,
)

function ChatProbe() {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const pinnedRef = React.useRef(true)
  const [, setTick] = React.useState(0)
  const [extra, setExtra] = React.useState<string[]>([])
  const follow = useDeferredFollow()

  const onScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedRef.current = distance < 4
  }, [])

  // The REAL follow effect shape from chat-panel.tsx: no deps, runs on every
  // render, re-asserts the pin through the deferred-follow gate.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el || !pinnedRef.current) return
    const bottom = el.scrollHeight - el.clientHeight
    if (Math.abs(el.scrollTop - bottom) < 1) return
    follow(() => {
      const e = scrollRef.current
      if (!e || !pinnedRef.current) return
      e.scrollTop = e.scrollHeight - e.clientHeight
    })
  })

  React.useEffect(() => {
    window.__sel = window.__sel ?? ({} as NonNullable<Window['__sel']>)
    window.__sel.chat = {
      tick: () => setTick((n) => n + 1),
      addMessage: () =>
        setExtra((xs) => [...xs, `Late message ${xs.length + 1}: arrived while a selection was held — content must still render.`]),
      scrollUp: () => {
        const el = scrollRef.current
        if (!el) return
        pinnedRef.current = false
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 400)
      },
      distanceFromBottom: () => {
        const el = scrollRef.current
        if (!el) return -1
        return el.scrollHeight - el.scrollTop - el.clientHeight
      },
      pinned: () => pinnedRef.current,
    }
  })

  // Pin to bottom on first paint.
  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-chat-track=""
      data-testid="chat-track"
      style={{ height: 400, overflowY: 'auto', padding: 12, background: '#111', color: '#eee', fontSize: 14, lineHeight: 1.5 }}
    >
      {[...MESSAGES, ...extra].map((m, i) => (
        <p data-msg={i} key={i} style={{ margin: '0 0 14px' }}>
          {m}
        </p>
      ))}
    </div>
  )
}

function TermProbe() {
  const hostRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({ rows: 24, cols: 80, convertEol: true })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    for (let i = 1; i <= 60; i++) {
      term.write(`terminal line ${i}: the quick brown fox jumps over the lazy dog\r\n`)
    }

    let lastDeferred = false

    const doFit = (widthChanged: boolean): void => {
      lastDeferred = shouldDeferReflow(term.hasSelection(), widthChanged)
      if (lastDeferred) return
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
    }

    window.__sel = window.__sel ?? ({} as NonNullable<Window['__sel']>)
    window.__sel.term = {
      hasSelection: () => term.hasSelection(),
      selectFirstLine: () => term.select(0, 0, 40),
      cols: () => term.cols,
      rows: () => term.rows,
      write: (text: string) => term.write(text),
      forceHeightFit: (px: number) => {
        host.style.height = `${host.clientHeight - px}px`
        try {
          fit.fit()
        } catch {
          /* ignore */
        }
      },
      guardedHeightFit: (px: number) => {
        host.style.height = `${host.clientHeight - px}px`
        doFit(false)
      },
      guardedWidthFit: (px: number) => {
        host.style.width = `${host.clientWidth - px}px`
        doFit(true)
      },
      lastDeferred: () => lastDeferred,
    }

    return () => {
      term.dispose()
      if (window.__sel) delete window.__sel.term
    }
  }, [])

  return <div ref={hostRef} data-testid="term-host" style={{ height: 360, width: 640, background: '#000' }} />
}

export default function DevSelectionProbe() {
  return (
    <div style={{ display: 'flex', gap: 24, padding: 16, flexWrap: 'wrap', background: '#222', minHeight: '100vh' }}>
      <div>
        <h2 style={{ color: '#fff', font: '14px sans-serif' }}>chat</h2>
        <ChatProbe />
      </div>
      <div>
        <h2 style={{ color: '#fff', font: '14px sans-serif' }}>terminal</h2>
        <TermProbe />
      </div>
    </div>
  )
}
