/**
 * The composer mic is gated on Web Speech (mobile polish #3).
 * ─────────────────────────────────────────────────────────────────────────────
 * The trailing mic reads as a dictation control, and dictation is the Web Speech
 * API — which iOS Safari and every iOS WKWebView expose under neither name. A mic
 * drawn there is a dead glyph the instant a thumb lands on it. The composer now
 * feature-detects (`speech.ts`) and draws the mic only where recognition exists.
 *
 * Both halves are asserted: the pure predicate, and the composer render that
 * consumes it — the iPhone case (no `window` recognition ctor → no mic) is the
 * default SSR environment here, which is exactly the environment the product's
 * iOS users are in.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChatComposer } from '../../src/components/chat/composer'
import { speechRecognitionSupported } from '../../src/components/chat/speech'
import type { ComposerHandle } from '../../src/components/chat/use-composer'

/** A minimal, inert composer handle — the mic gate is at rest (empty draft, not
 *  active), so nothing here needs real behaviour. */
function handle(over: Partial<ComposerHandle> = {}): ComposerHandle {
  return {
    draft: '',
    setDraft: () => undefined,
    ref: React.createRef<HTMLTextAreaElement>(),
    sending: false,
    notice: null,
    dismissNotice: () => undefined,
    submit: () => undefined,
    stop: () => undefined,
    insert: () => undefined,
    handoff: null,
    handoffPending: null,
    picker: {
      open: false,
      kind: '@',
      query: '',
      pick: () => undefined,
      close: () => undefined,
      bind: () => undefined,
    },
    onChange: () => undefined,
    onKeyDown: () => undefined,
    onSelect: () => undefined,
    ...over,
  }
}

const composer = () =>
  renderToStaticMarkup(
    <ChatComposer name="release-train" label="Release Train" handle={handle()} surface="phone" />,
  )

/** Stub a browser `window` that DOES expose recognition, with the matchMedia
 *  framer-motion's `useReducedMotion` reads at render. */
function withSpeechWindow(run: () => void): void {
  const g = globalThis as { window?: unknown }
  const had = 'window' in g
  const prev = g.window
  g.window = {
    webkitSpeechRecognition: function SpeechRecognitionStub() {},
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  }
  try {
    run()
  } finally {
    if (had) g.window = prev
    else delete g.window
  }
}

afterEach(() => {
  // Belt-and-suspenders: never leak a stubbed window into a later SSR test file.
  const g = globalThis as { window?: unknown }
  if (g.window && (g.window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition) {
    delete g.window
  }
})

describe('speechRecognitionSupported', () => {
  test('false when there is no window (SSR / the default here)', () => {
    expect(speechRecognitionSupported()).toBe(false)
  })

  test('true when the recognition constructor is exposed', () => {
    withSpeechWindow(() => {
      expect(speechRecognitionSupported()).toBe(true)
    })
  })
})

describe('the composer mic gate', () => {
  test('no Web Speech (the iPhone case) → no mic glyph at rest', () => {
    const html = composer()
    // The idle trailing cell is empty — no mic path, no dead control.
    expect(html).not.toContain('sm-mic')
  })

  test('with Web Speech → the mic keeps its cell at rest', () => {
    withSpeechWindow(() => {
      const html = composer()
      expect(html).toContain('sm-mic')
    })
  })
})
