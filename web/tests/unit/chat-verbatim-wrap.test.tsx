/**
 * Verbatim pty text has to be READABLE on a phone (round-2 findings 18 + 24).
 * ─────────────────────────────────────────────────────────────────────────────
 * Two blocks on this surface print the terminal's own bytes rather than the
 * app's words, and both preserved the pty's COLUMNS inside a bubble a third of
 * that wide:
 *
 *   · the provisional tail — 128 pty columns in a 230px phone bubble hid 74% of
 *     every line of live streaming prose behind a hairline scrollbar, during the
 *     one phase where the surface is genuinely live;
 *   · the paused/consent dialog body — "Continue with Fable 5 on usage credits,
 *     or switch models for the rest of this session." rendered as "Continue with
 *     Fable 5 on usage credits, / session.", a complete-looking sentence that
 *     hides the second option, on the one card the build refuses to act on.
 *
 * What stays: a PERMISSION body is a shell command, where a soft break could
 * change what a reader believes they are approving. That one keeps its columns
 * and scrolls, and this file pins that too — a blanket wrap would be the other
 * half of the same bug.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { dialogCardView } from '../../src/components/chat/dialog-answer'
import { DialogCard } from '../../src/components/chat/live-layer'
import { readLens } from '../../src/components/chat/peek-lens'
import { ProvisionalTailView } from '../../src/components/chat/provisional-tail'

/** The `<pre>` a testid names, with its class list. */
function preClass(html: string, testid: string): string {
  const at = html.indexOf(`data-testid="${testid}"`)
  expect(at).toBeGreaterThan(-1)
  // The attributes of the element carrying the testid.
  const open = html.lastIndexOf('<', at)
  const close = html.indexOf('>', at)
  const tag = html.slice(open, close)
  return /class="([^"]*)"/.exec(tag)?.[1] ?? ''
}

describe('the provisional tail', () => {
  const LINES = [
    'When navigating a long transcript the keyboard shortcuts matter more than the mouse, because the reading column is narrow and the pointer has nowhere to rest.',
    'Each block is a paragraph the terminal wrapped at its own column width.',
  ]

  test('soft-wraps instead of scrolling the pty’s columns off the bubble', () => {
    const html = renderToStaticMarkup(<ProvisionalTailView lines={LINES} seed="v-claude" surface="phone" />)
    // `chat-provisional-tail` names the caption; the block itself is the <pre>
    // right after it, and it is the class list that decides whether 74% of the
    // line is on screen or not.
    expect(html).toContain('whitespace-pre-wrap')
    // No `whitespace-pre` other than the `-wrap` form, and no horizontal scroll
    // box: the two together are what shipped, and either alone re-clips it.
    expect(html).not.toContain('overflow-x-auto')
    expect(/whitespace-pre(?![-\w])/.test(html)).toBe(false)
    // The prose itself still arrives whole — wrapping is a layout change, not a
    // clamp.
    expect(html).toContain('keyboard short')
  })
})

describe('a dialog card’s verbatim body', () => {
  /** The overage consent modal, as `chat-peek-lens.test.ts` captures it. */
  const OVERAGE = [
    '────────────────────────────',
    ' Session paused',
    '',
    ' Continue with Fable 5 on usage credits,',
    ' or switch models for the rest of this session.',
    '',
    '   1. Continue on usage credits',
    ' ❯ 2. Switch to the default model',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n')

  /** The a0 permission capture — the same bytes the registry's claims are made
   *  against (`tests/fixtures/tui/perm-bash.txt`). */
  const PERMISSION = readFileSync(join(import.meta.dir, '../fixtures/tui/perm-bash.txt'), 'utf8')

  test('a paused turn’s prose wraps — a clipped sentence reads as a finished one', () => {
    const view = dialogCardView(readLens(OVERAGE), '2.1.233')
    expect(view?.family).toBe('paused')
    const html = renderToStaticMarkup(<DialogCard view={view!} />)
    const cls = preClass(html, 'chat-dialog-body')
    expect(cls).toContain('whitespace-pre-wrap')
    expect(cls).toContain('break-words')
    // The second option is the half the clip ate. It has to be in the body, and
    // the body has to be allowed to show it.
    expect(html).toContain('switch models')
  })

  test('a command body keeps the pty’s columns — a soft break there changes what is approved', () => {
    const view = dialogCardView(readLens(PERMISSION), '2.1.233')
    expect(view?.family).toBe('permission')
    const cls = preClass(renderToStaticMarkup(<DialogCard view={view!} />), 'chat-dialog-body')
    expect(cls).toContain('whitespace-pre')
    expect(cls).not.toContain('whitespace-pre-wrap')
  })
})
