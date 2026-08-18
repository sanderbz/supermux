/**
 * The composer's rest-state mic IS dictation (iOS included).
 * ─────────────────────────────────────────────────────────────────────────────
 * The trailing mic is a real dictation control, not decoration: at rest it is a
 * button that toggles Web Speech (`useDictation`) and inserts the transcript into
 * the draft. Web Speech DOES exist on iOS Safari / WKWebView under the `webkit`
 * prefix — dictation works on the iPhone — so the mic is SHOWN there, and hidden
 * only where the browser exposes no recognition constructor at all (and in SSR,
 * where there is no window).
 *
 * What is asserted here, and what is not: this repo has no jsdom, so a real tap —
 * `aria-pressed` flipping to true, the recording wash, `handle.insert` firing on a
 * final Web Speech result — is Playwright's job (the same split the picker's
 * keyboard tests call out: behaviour that needs real events lives in e2e). What a
 * unit test CAN pin is the pure predicate and the SSR structure: with a
 * recognition ctor present the rest cell is a real, labelled, toggle-wired button
 * (`aria-pressed="false"`, not an `aria-hidden` glyph); with none it is absent.
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

/** Stub a browser `window` that DOES expose recognition under the `webkit`
 *  prefix — i.e. exactly what iOS Safari / WKWebView expose — with the matchMedia
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

  test('true with the webkit-prefixed ctor — i.e. iOS Safari / WKWebView', () => {
    withSpeechWindow(() => {
      expect(speechRecognitionSupported()).toBe(true)
    })
  })
})

describe('the composer mic gate', () => {
  test('no recognition ctor (SSR / a browser without Web Speech) → no mic at rest', () => {
    const html = composer()
    // The idle trailing cell is empty — no mic disc, no dead control. This is the
    // genuinely-unsupported case, NOT the iPhone (iOS has webkitSpeechRecognition).
    expect(html).not.toContain('sm-mic')
    expect(html).not.toContain('data-testid="chat-mic"')
  })

  test('iOS (webkitSpeechRecognition present) → the mic is SHOWN at rest', () => {
    withSpeechWindow(() => {
      const html = composer()
      expect(html).toContain('data-testid="chat-mic"')
      // The boards' inverted disc keeps its cell.
      expect(html).toContain('sm-mic')
    })
  })

  test('the shown mic is a REAL dictation toggle, not decoration', () => {
    withSpeechWindow(() => {
      const html = composer()
      // A real, labelled button — not the old `aria-hidden` glyph.
      expect(html).toContain('<button')
      expect(html).toContain('data-testid="chat-mic"')
      expect(html).toContain('aria-label="Dictate"')
      // Wired to the listening state: a toggle sits at `aria-pressed="false"` when
      // it is off. (The true/tint side of the toggle needs a real tap — e2e.)
      expect(html).toContain('aria-pressed="false"')
    })
  })
})
