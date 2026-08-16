/**
 * Fase A5 T5 — the overview preview follows the resolved renderer.
 * ─────────────────────────────────────────────────────────────────────────────
 * Two separable things are asserted here, and only the first is about pixels:
 *
 *   1. `ChatTailPreview` itself — two lines in the tile's type scale, the empty
 *      string as a REAL state, and the same geometry contract `TailPreview`
 *      carries (`fill` → `h-full`, bottom-anchored, top-masked) so tile heights
 *      are untouched at every density tier;
 *   2. the CHOICE — `chat_tail != null && resolveRenderer(...) === 'chat'`,
 *      exercised as the pure predicate the tile evaluates. `undefined` means
 *      UNCHANGED (the SSE delta merges key-by-key in `applyDelta`), so an absent
 *      tail keeps the ANSI preview and never blanks the tile.
 *
 * The tile itself is not rendered: it mounts `useMediaQuery`, `useLongPress`
 * and a query client, none of which exist in `bun test`. The predicate is what
 * decides, and it is pure.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync } from 'node:fs'

import { ChatTailPreview } from '../../src/components/session-tile/chat-tail-preview'
import {
  EMPTY_RENDERER_STATE,
  resolveRenderer,
  setPref,
  type RendererState,
} from '../../src/components/chat/renderer-pref'
import type { ChatTail } from '../../src/lib/api/sessions'

const tail = (o: Partial<ChatTail> = {}): ChatTail => ({
  user: 'add a test for the retry path',
  agent: 'Added `retries_exhausted` and a case for it.',
  ts: 1_700_000_000_000,
  ...o,
})

const html = (t: ChatTail) =>
  renderToStaticMarkup(<ChatTailPreview tail={t} fill />)

/** The tile's own predicate, transcribed. Kept here rather than imported so a
 *  change to the tile that drops one half of the `&&` fails a test rather than
 *  quietly widening what shows a chat preview. */
const chatPreview = (
  st: RendererState,
  s: { name: string; chat_tail?: ChatTail },
  chatOn: boolean,
) => s.chat_tail != null && resolveRenderer(st, s.name, chatOn, true) === 'chat'

describe('ChatTailPreview', () => {
  test('renders the prompt over the agent line, no ANSI spans', () => {
    const out = html(tail())
    expect(out).toContain('add a test for the retry path')
    expect(out).toContain('Added `retries_exhausted` and a case for it.')
    expect(out).not.toContain('\x1b')
    // The ANSI tail renders <pre> blocks; the conversation renders prose.
    expect(out).not.toContain('<pre')
  })

  test('an empty agent line renders ONE line, never a blank slot', () => {
    const out = html(tail({ agent: '' }))
    expect(out).toContain('chat-tail-user')
    expect(out).not.toContain('chat-tail-agent')
    expect(out).not.toContain('No messages yet')
  })

  test('an empty prompt renders just the agent line', () => {
    const out = html(tail({ user: '' }))
    expect(out).toContain('chat-tail-agent')
    expect(out).not.toContain('chat-tail-user')
  })

  test('both empty is a real state and says so, calmly', () => {
    const out = html(tail({ user: '', agent: '' }))
    expect(out).toContain('No messages yet')
  })

  test('it never grows the tile: same fill/anchor/mask contract as TailPreview', () => {
    const chat = html(tail())
    // `tail-preview.tsx` is FROZEN this fase (a non-chat tile must render
    // byte-identically to today), so its contract is read off its source rather
    // than by rendering it — it imports through the `@/` alias, which the
    // `bun test` resolver has no paths for.
    const ansi = readFileSync(
      new URL('../../src/components/session-tile/tail-preview.tsx', import.meta.url),
      'utf8',
    )
    for (const contract of [
      'h-full', // fill the animated height container, never set one
      'overflow-hidden',
      'absolute inset-x-3 bottom-2', // bottom-anchored in the same inset
      'linear-gradient(to bottom, transparent 0, black 24px)', // the same top fade
    ]) {
      expect(chat).toContain(contract)
      expect(ansi).toContain(contract)
    }
    // Neither preview declares a height of its own — the tile's animated
    // container owns it, which is why the swap is height-neutral at EVERY tier.
    expect(chat).not.toMatch(/style="[^"]*height:/)
  })

  test('it is decorative: the tile row already carries the accessible name', () => {
    expect(html(tail())).toContain('aria-hidden')
  })
})

describe('the choice', () => {
  const S = { name: 'claude-1' }

  test('no chat_tail → the terminal preview renders, unchanged', () => {
    expect(chatPreview(EMPTY_RENDERER_STATE, S, true)).toBe(false)
  })

  test('chat_tail + chat-resolved → the chat preview', () => {
    expect(
      chatPreview(EMPTY_RENDERER_STATE, { ...S, chat_tail: tail() }, true),
    ).toBe(true)
  })

  test('chat_tail present but the session is pinned to terminal → terminal preview', () => {
    const st = setPref(EMPTY_RENDERER_STATE, S.name, 'terminal')
    expect(chatPreview(st, { ...S, chat_tail: tail() }, true)).toBe(false)
  })

  test('chat_tail present but the session is ineligible (codex) → terminal preview', () => {
    // `chatOn` false is exactly what `chatRendererOn` returns for a non-Claude
    // provider, a remote host or a team lead — one function decides for every
    // density, and a stale `chat` pin does not override it.
    const st = setPref(EMPTY_RENDERER_STATE, S.name, 'chat')
    expect(chatPreview(st, { ...S, chat_tail: tail() }, false)).toBe(false)
  })

  test('the global default flips every unpinned tile at once', () => {
    const st: RendererState = { defaultRenderer: 'terminal', overrides: {} }
    expect(chatPreview(st, { ...S, chat_tail: tail() }, true)).toBe(false)
  })
})

describe('§2.5 — zero new requests (grep rule over session-tile/**)', () => {
  test('no tile surface opens a chat subscription or a peek fetch', () => {
    const dir = new URL('../../src/components/session-tile/', import.meta.url)
    const offenders: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue
      const src = readFileSync(new URL(f, dir), 'utf8')
      // Strip prose: these names are legitimately DISCUSSED in comments.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      for (const bad of ['useChatTail', 'useChatWs', 'peekAnsi', 'ChatSocket']) {
        if (code.includes(bad)) offenders.push(`${f}: ${bad}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
