// Fase A5 T7 — the `T` hotkey's refusal matrix.
//
// One row per refusal, because each one is a keystroke that would otherwise
// land in the wrong place — and a lost keystroke in a terminal is a wrong
// command, not a wrong screen.

import { describe, expect, test } from 'bun:test'

import {
  shouldToggleRenderer,
  type HotkeyCtx,
} from '../../src/components/chat/renderer-hotkey'

const ctx = (o: Partial<HotkeyCtx> = {}): HotkeyCtx => ({
  key: 't',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 84,
  target: { tag: 'DIV', editable: false, role: null },
  inOverlay: false,
  terminalFocused: false,
  chatFocused: false,
  onRendererSwitch: false,
  eligible: true,
  ...o,
})

test('a key from inside a visible chat surface is never the shortcut', () => {
  // The blocker, as a matrix row. A click on the transcript background parks
  // focus on a container that owns no keys, so `t` arrives at the DOCUMENT with
  // a plain `DIV` target and every other refusal passing — and swallowing it
  // flipped the surface mid-sentence, after which the rest was typed at the pty.
  expect(shouldToggleRenderer(ctx({ chatFocused: true }))).toBe(false)
  expect(shouldToggleRenderer(ctx({ chatFocused: true, target: { tag: 'MAIN', editable: false, role: null } }))).toBe(
    false,
  )
})

test('a key that arrived at the renderer switch is never the shortcut', () => {
  // The coarse-pointer half: a tap leaves the caret on the tab it pressed, the
  // composer arm is exempt on touch, and the next letter typed flipped the
  // surface — which focuses xterm, so the rest went to the pty.
  expect(
    shouldToggleRenderer(
      ctx({ onRendererSwitch: true, target: { tag: 'BUTTON', editable: false, role: 'tab' } }),
    ),
  ).toBe(false)
})

test('plain t on the pane toggles', () => {
  expect(shouldToggleRenderer(ctx())).toBe(true)
})

test('an upper-case T (caps lock, no shift) still toggles', () => {
  expect(shouldToggleRenderer(ctx({ key: 'T' }))).toBe(true)
})

test('any other key never toggles', () => {
  for (const key of ['a', 'Enter', 'Escape', 'ArrowUp', 'Tab', ' ']) {
    expect(shouldToggleRenderer(ctx({ key }))).toBe(false)
  }
})

describe('the six refusals', () => {
  test('1. ⌘T / Ctrl+T never toggles (a new browser tab must survive)', () => {
    expect(shouldToggleRenderer(ctx({ metaKey: true }))).toBe(false)
    expect(shouldToggleRenderer(ctx({ ctrlKey: true }))).toBe(false)
  })

  test('1b. Alt+t and Shift+T belong to the terminal', () => {
    expect(shouldToggleRenderer(ctx({ altKey: true }))).toBe(false)
    expect(shouldToggleRenderer(ctx({ shiftKey: true, key: 'T' }))).toBe(false)
  })

  test('2. t while composing (IME / keyCode 229) never toggles', () => {
    expect(shouldToggleRenderer(ctx({ isComposing: true }))).toBe(false)
    expect(shouldToggleRenderer(ctx({ keyCode: 229 }))).toBe(false)
  })

  test('3. t in the composer never toggles', () => {
    expect(
      shouldToggleRenderer(
        ctx({ target: { tag: 'TEXTAREA', editable: true, role: null } }),
      ),
    ).toBe(false)
    expect(
      shouldToggleRenderer(
        ctx({ target: { tag: 'INPUT', editable: true, role: null } }),
      ),
    ).toBe(false)
    // contenteditable without a telling tag name — the markdown surfaces.
    expect(
      shouldToggleRenderer(
        ctx({ target: { tag: 'DIV', editable: true, role: null } }),
      ),
    ).toBe(false)
    // …and a role-only textbox (a custom composer).
    expect(
      shouldToggleRenderer(
        ctx({ target: { tag: 'DIV', editable: false, role: 'textbox' } }),
      ),
    ).toBe(false)
  })

  test('4. t inside an open dialog / sheet / popover never toggles', () => {
    expect(shouldToggleRenderer(ctx({ inOverlay: true }))).toBe(false)
  })

  test('5. t while xterm has focus never toggles', () => {
    expect(shouldToggleRenderer(ctx({ terminalFocused: true }))).toBe(false)
  })

  test('6. t on an ineligible session never toggles', () => {
    expect(shouldToggleRenderer(ctx({ eligible: false }))).toBe(false)
  })
})

test('typing “the terminal is faster” flips nothing', () => {
  // The composer case, spelled out as the sentence that motivated the rule.
  const inComposer = { tag: 'TEXTAREA', editable: true, role: null }
  const flips = [...'the terminal is faster'].filter((ch) =>
    shouldToggleRenderer(ctx({ key: ch, target: inComposer })),
  )
  expect(flips).toEqual([])
})
