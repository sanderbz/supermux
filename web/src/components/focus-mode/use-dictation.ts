// useDictation — M18 (TECH_PLAN §M18: "wire dictation … uses `webkitSpeech-
// Recognition` (`SpeechRecognition` polyfill); on result, set input value.
// Gracefully degrade if not supported").
//
// A thin hook around the Web Speech API. `supported` is false on browsers that
// expose neither `SpeechRecognition` nor `webkitSpeechRecognition` (so the dock
// hides the mic button rather than offering a dead control). `start()` opens a
// recognition session; interim + final transcripts stream to `onTranscript`,
// which the composer appends to its input value. `stop()` ends the session.
//
// R5 FIX — DON'T GATE THE FLUSH ON `onend`. iOS Safari / WKWebView fire
// `webkitSpeechRecognition`'s `onend` unreliably (`continuous=true` is ignored,
// sessions auto-end or error without a clean end event), so a consumer that only
// flushed the buffered transcript on listening→idle would silently drop dictation.
// We now ALSO surface FINAL segments the instant they finalize via `onFinal(seg)`
// — the dock sends those straight to the pty (the same sendRaw path keystrokes
// use), independent of whether `onend` ever arrives.
//
// No network, no token — this is an on-device browser API; nothing here touches
// the auth surface.

import * as React from 'react'

// The Web Speech API is not in the TS DOM lib by default; describe the slice we
// use rather than pulling a dependency.
interface SpeechRecognitionResultLike {
  0: { transcript: string }
  isFinal: boolean
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export interface UseDictationResult {
  /** True only when the browser exposes the Web Speech API. */
  supported: boolean
  /** True while a recognition session is live. */
  listening: boolean
  /** Start dictation — no-op if unsupported or already listening. */
  start: () => void
  /** Stop dictation — finalizes the current session. */
  stop: () => void
  /** Convenience toggle for a single mic button. */
  toggle: () => void
}

export interface UseDictationOpts {
  /** Receives the latest full transcript (interim or final) — for live UI echo.
   *  Cumulative, so a consumer must NOT send this per-call (it grows). */
  onTranscript?: (text: string) => void
  /** Receives each FINAL segment the instant Web Speech finalizes it — the
   *  reliable, `onend`-independent flush trigger. The dock sends these straight
   *  to the pty. Each call is a fresh, non-overlapping committed chunk. */
  onFinal?: (segment: string) => void
}

/**
 * @param opts callbacks for interim (`onTranscript`) and final (`onFinal`)
 *        transcript segments. A bare `(text) => void` is also accepted as a
 *        shorthand for `{ onTranscript }` (back-compat).
 */
export function useDictation(
  opts: UseDictationOpts | ((text: string) => void),
): UseDictationResult {
  const normalized: UseDictationOpts =
    typeof opts === 'function' ? { onTranscript: opts } : opts

  const Ctor = React.useMemo(() => getRecognitionCtor(), [])
  const supported = Ctor != null

  const [listening, setListening] = React.useState(false)
  const recRef = React.useRef<SpeechRecognitionLike | null>(null)
  // Keep the latest callbacks without re-creating the recognition session.
  const cbRef = React.useRef(normalized)
  React.useEffect(() => {
    cbRef.current = normalized
  })
  // How many results we've already emitted as FINAL segments this session, so a
  // re-fired `onresult` (Web Speech re-delivers the whole results list each time)
  // never double-emits an already-committed segment.
  const finalCountRef = React.useRef(0)

  const stop = React.useCallback(() => {
    recRef.current?.stop()
  }, [])

  const start = React.useCallback(() => {
    if (!Ctor || recRef.current) return
    const rec = new Ctor()
    rec.lang = navigator.language || 'en-US'
    rec.continuous = true
    rec.interimResults = true
    finalCountRef.current = 0
    rec.onresult = (e) => {
      // (a) Cumulative interim text for live UI echo.
      let text = ''
      for (let i = 0; i < e.results.length; i += 1) {
        text += e.results[i][0].transcript
      }
      cbRef.current.onTranscript?.(text.trim())

      // (b) Emit any newly-finalized segments exactly once. The results list is
      // cumulative and final-then-final entries are stable, so we only walk past
      // the count we've already committed. This is the reliable flush path —
      // it does NOT wait for `onend` (flaky on iOS / WKWebView).
      for (let i = finalCountRef.current; i < e.results.length; i += 1) {
        if (e.results[i].isFinal) {
          const seg = e.results[i][0].transcript.trim()
          finalCountRef.current = i + 1
          if (seg) cbRef.current.onFinal?.(seg)
        } else {
          // First non-final entry — everything after is still interim; stop.
          break
        }
      }
    }
    rec.onerror = () => {
      recRef.current = null
      setListening(false)
    }
    rec.onend = () => {
      recRef.current = null
      setListening(false)
    }
    recRef.current = rec
    setListening(true)
    try {
      rec.start()
    } catch {
      recRef.current = null
      setListening(false)
    }
  }, [Ctor])

  const toggle = React.useCallback(() => {
    if (listening) stop()
    else start()
  }, [listening, start, stop])

  // Abort any live session if the component unmounts mid-dictation.
  React.useEffect(() => {
    return () => recRef.current?.abort()
  }, [])

  return { supported, listening, start, stop, toggle }
}
