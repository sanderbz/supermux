/**
 * A held selection is a state the surface must not walk over (iOS BUG 1).
 * ─────────────────────────────────────────────────────────────────────────────
 * On iOS Safari, selecting a message and reaching for the native Copy is a race
 * against the chat panel: the follow-bottom pin wrote `scrollTop` on the very
 * scroller the selection lived in, once per render, and the peek poller
 * re-rendered the panel every few seconds while the agent was IDLE. A
 * programmatic scroll of the selection's scroller ends the selection gesture in
 * WebKit — the callout goes, the highlight goes, and it reads as "some JS keeps
 * deselecting me".
 *
 * The repair has two locks and this file pins the lower one: the predicate both
 * of them consult. `selectionInside` is scoped (the scroll pin only has to keep
 * its hands off ITS track) and `hasTextSelection` is document-wide (the phone's
 * tap-to-dismiss must not fire on the tap that ENDS a drag-select, wherever it
 * happened).
 *
 * No jsdom in this repo, so the DOM is faked at exactly the two seams the module
 * touches: `window.getSelection()` and `Node.contains`. That is the whole
 * surface — which is itself the argument for the predicate living in one module
 * instead of being written out at each call site.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { hasTextSelection, selectionInside } from '../../src/components/chat/selection'

type FakeRange = { collapsed: boolean; commonAncestorContainer: object }

/** Install a `window.getSelection` that answers with these ranges. */
function withSelection(ranges: FakeRange[] | null): void {
  const sel =
    ranges === null
      ? null
      : {
          isCollapsed: ranges.every((r) => r.collapsed),
          rangeCount: ranges.length,
          getRangeAt: (i: number) => ranges[i],
        }
  ;(globalThis as unknown as { window: unknown }).window = {
    getSelection: () => sel,
  }
}

/** A stand-in for the scroll track: it only ever gets asked `contains`. */
function track(...owned: object[]): Element {
  return { contains: (n: object) => owned.includes(n) } as unknown as Element
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('the selection guard', () => {
  test('no selection at all — both readings say no', () => {
    withSelection(null)
    expect(hasTextSelection()).toBe(false)
    expect(selectionInside(track())).toBe(false)
  })

  test('a COLLAPSED selection is a caret, not a selection', () => {
    // The ordinary state of any focused field: a caret reports as a range with
    // `collapsed: true`. Treating it as "the user has something selected" would
    // freeze follow-bottom permanently the moment anyone tapped the composer.
    const caret = {}
    withSelection([{ collapsed: true, commonAncestorContainer: caret }])
    expect(hasTextSelection()).toBe(false)
    expect(selectionInside(track(caret))).toBe(false)
  })

  test('a real selection inside the track — the pin must stand down', () => {
    const textNode = {}
    withSelection([{ collapsed: false, commonAncestorContainer: textNode }])
    expect(hasTextSelection()).toBe(true)
    expect(selectionInside(track(textNode))).toBe(true)
  })

  test('a selection SOMEWHERE ELSE does not freeze this track', () => {
    // Two chat panes in a desktop split: a selection in the other one is not a
    // reason for this one to stop following its own conversation.
    const elsewhere = {}
    withSelection([{ collapsed: false, commonAncestorContainer: elsewhere }])
    expect(hasTextSelection()).toBe(true) // the document-wide reading still sees it
    expect(selectionInside(track(/* owns nothing */))).toBe(false)
  })

  test('a null track is not a selection host', () => {
    const textNode = {}
    withSelection([{ collapsed: false, commonAncestorContainer: textNode }])
    expect(selectionInside(null)).toBe(false)
    expect(selectionInside(undefined)).toBe(false)
  })

  test('no window (SSR) — the predicate answers, it does not throw', () => {
    delete (globalThis as unknown as { window?: unknown }).window
    expect(hasTextSelection()).toBe(false)
    expect(selectionInside(track())).toBe(false)
  })
})
