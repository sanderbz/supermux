/**
 * The phone composer is NOT a form control — the whole of bug #2's first half.
 * ─────────────────────────────────────────────────────────────────────────────
 * iOS Safari draws its prev/next/Done accessory bar above the keyboard for
 * `<input>`/`<textarea>` and for nothing else, so `plain-editable.tsx` makes the
 * phone's message box a `contenteditable` host instead. The bar itself is a
 * UIKit artifact of the real device — no headless browser on Linux (Chromium OR
 * WebKit) renders it, so its REMOVAL is only confirmable on the owner's iPhone.
 *
 * What a unit test CAN pin, and what this file is, is the MECHANISM that removes
 * it: the host is a contenteditable textbox and there is no form control in the
 * markup at all. If a later edit reintroduced a `<textarea>` on the phone the bar
 * would come back, and this test is what fails first. The live typing/caret/paste
 * behaviour needs real events (no jsdom here — the same split the mic test calls
 * out); it is Playwright's job.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { PlainEditable } from '../../src/components/chat/plain-editable'

const render = (el: React.ReactElement) => renderToStaticMarkup(el)

describe('the phone composer host', () => {
  test('is a contenteditable textbox, never a form control', () => {
    const html = render(<PlainEditable value="hello" placeholder="Message Bob" />)
    // The mechanism: an editable host, not an input/textarea.
    expect(html).toContain('contentEditable="plaintext-only"')
    expect(html).toContain('role="textbox"')
    expect(html).toContain('aria-multiline="true"')
    // The bar is drawn for form controls — there must be none.
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('<input')
  })

  test('carries the placeholder as data, since an editable host is never :empty', () => {
    const html = render(<PlainEditable value="" placeholder="Message Bob" />)
    expect(html).toContain('data-placeholder="Message Bob"')
    // Empty draft ⇒ the placeholder shows (`data-empty` drives the ::before).
    expect(html).toContain('data-empty=""')
  })

  test('a non-empty draft hides the placeholder', () => {
    const html = render(<PlainEditable value="typed" placeholder="Message Bob" />)
    expect(html).not.toContain('data-empty=""')
  })

  test('readOnly maps to a non-editable host (the blocked / preview composer)', () => {
    const html = render(<PlainEditable value="x" placeholder="Message Bob" readOnly />)
    expect(html).toContain('contentEditable="false"')
    expect(html).not.toContain('plaintext-only')
  })
})
