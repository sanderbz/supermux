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

/**
 * @param onTranscript receives the latest full transcript (interim or final);
 *        the composer should set its input value to this.
 */
export function useDictation(
  onTranscript: (text: string) => void,
): UseDictationResult {
  const Ctor = React.useMemo(() => getRecognitionCtor(), [])
  const supported = Ctor != null

  const [listening, setListening] = React.useState(false)
  const recRef = React.useRef<SpeechRecognitionLike | null>(null)
  // Keep the latest callback without re-creating the recognition session.
  const cbRef = React.useRef(onTranscript)
  React.useEffect(() => {
    cbRef.current = onTranscript
  }, [onTranscript])

  const stop = React.useCallback(() => {
    recRef.current?.stop()
  }, [])

  const start = React.useCallback(() => {
    if (!Ctor || recRef.current) return
    const rec = new Ctor()
    rec.lang = navigator.language || 'en-US'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      let text = ''
      for (let i = 0; i < e.results.length; i += 1) {
        text += e.results[i][0].transcript
      }
      cbRef.current(text.trim())
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
