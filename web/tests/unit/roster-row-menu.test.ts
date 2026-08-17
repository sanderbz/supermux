/**
 * The roster row's SECONDARY action, now that the ⋯ trigger is not a tab stop.
 *
 * Measured before this: tab-walking a 7-session roster in the default
 * Tiles/Smart mode recorded seven consecutive "More actions for <name>" stops
 * straight after the single roving tile stop — 1+N instead of N, in a control
 * that is `opacity: 0` at rest on a fine pointer. The trigger left the tab order
 * and the row took the platform's own keys instead; this pins both halves of
 * that contract without a browser (what the keys MEAN, and that the request
 * reaches exactly the row it names).
 */
import { describe, expect, test } from 'bun:test'

import { isRowMenuKey, onRowMenuRequest, requestRowMenu } from '../../src/components/session-tile/row-menu-bus'

describe('which keys open a row menu', () => {
  test('Shift+F10 and the Menu key, the two the desktop already uses', () => {
    expect(isRowMenuKey({ key: 'F10', shiftKey: true })).toBe(true)
    expect(isRowMenuKey({ key: 'ContextMenu' })).toBe(true)
  })

  test('a bare F10 belongs to the browser', () => {
    expect(isRowMenuKey({ key: 'F10' })).toBe(false)
    expect(isRowMenuKey({ key: 'F10', shiftKey: false })).toBe(false)
  })

  test('another owner’s modifier is another owner’s shortcut', () => {
    expect(isRowMenuKey({ key: 'F10', shiftKey: true, ctrlKey: true })).toBe(false)
    expect(isRowMenuKey({ key: 'F10', shiftKey: true, metaKey: true })).toBe(false)
    expect(isRowMenuKey({ key: 'ContextMenu', altKey: true })).toBe(false)
  })

  test('the roster’s own navigation keys are not menu keys', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape']) {
      expect(isRowMenuKey({ key })).toBe(false)
    }
  })
})

describe('the request reaches one row and no other', () => {
  test('the named row’s menu opens; its neighbour does not', () => {
    const opened: string[] = []
    const offA = onRowMenuRequest('vx-alpha', () => opened.push('alpha'))
    const offB = onRowMenuRequest('vx-bravo', () => opened.push('bravo'))
    expect(requestRowMenu('vx-alpha')).toBe(true)
    expect(opened).toEqual(['alpha'])
    offA()
    offB()
  })

  test('an unmounted menu is not called, and the caller is told nothing listened', () => {
    // The row uses the return value to decide whether it CONSUMED the key: a
    // surface with no menu (a bench, a picker) must leave Shift+F10 alone.
    const off = onRowMenuRequest('vx-alpha', () => {})
    off()
    expect(requestRowMenu('vx-alpha')).toBe(false)
    expect(requestRowMenu('never-mounted')).toBe(false)
  })
})
