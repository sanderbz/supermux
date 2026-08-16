// Fase A5 T3 — the mount-set reducer.
//
// A static render cannot prove a WebSocket did not reconnect (that is T6's
// thrash spec), but it can prove the MOUNT SET is what it should be, and that
// is the part that decides. Every case below is one of the three resets or the
// stickiness they exist to bound.

import { describe, expect, test } from 'bun:test'

import { retain, type Retention } from '../../src/components/chat/retention'

const input = (o: Partial<Parameters<typeof retain>[1]> = {}) => ({
  name: 's1',
  chat: false,
  terminal: false,
  stopped: false,
  ...o,
})

describe('sticky within a session', () => {
  test('a renderer that has been shown once stays mounted', () => {
    let r: Retention | null = null
    r = retain(r, input({ chat: true }))
    expect(r).toEqual({ name: 's1', chat: true, terminal: false })
    // Toggle to the terminal: chat is HIDDEN, not unmounted.
    r = retain(r, input({ terminal: true }))
    expect(r).toEqual({ name: 's1', chat: true, terminal: true })
    // …and back. Both stay.
    r = retain(r, input({ chat: true }))
    expect(r).toEqual({ name: 's1', chat: true, terminal: true })
  })

  test('100 toggles never grow the mount set past two', () => {
    let r: Retention | null = null
    for (let i = 0; i < 100; i++) {
      r = retain(r, input({ chat: i % 2 === 0, terminal: i % 2 === 1 }))
    }
    expect(r).toEqual({ name: 's1', chat: true, terminal: true })
  })

  test('a steady frame returns the SAME object (identity is load-bearing)', () => {
    const first = retain(null, input({ chat: true }))
    expect(retain(first, input({ chat: true }))).toBe(first)
  })
})

describe('reset on session change', () => {
  test('a retained terminal from session A is never revealed under B', () => {
    let r: Retention | null = retain(null, input({ chat: true }))
    r = retain(r, input({ terminal: true }))
    expect(r.terminal).toBe(true)
    // Navigate. The retained panes point at the WRONG pty / conversation.
    r = retain(r, input({ name: 's2', chat: true }))
    expect(r).toEqual({ name: 's2', chat: true, terminal: false })
  })
})

describe('reset on stopped', () => {
  test('stopped unmounts both — the pty is gone, StoppedSession owns the cell', () => {
    let r: Retention | null = retain(null, input({ chat: true }))
    r = retain(r, input({ terminal: true }))
    r = retain(r, input({ stopped: true, terminal: true }))
    expect(r).toEqual({ name: 's1', chat: false, terminal: false })
  })

  test('stopped beats every other signal, including a fresh chat frame', () => {
    expect(retain(null, input({ chat: true, stopped: true }))).toEqual({
      name: 's1',
      chat: false,
      terminal: false,
    })
  })

  test('a steady stopped session returns the SAME object (no render loop)', () => {
    // The shell folds `retain` during render and compares by reference; a
    // fresh-but-equal object here is "Too many re-renders", not a wasted alloc.
    const first = retain(null, input({ stopped: true }))
    expect(retain(first, input({ stopped: true }))).toBe(first)
    expect(retain(first, input({ stopped: true, chat: true }))).toBe(first)
  })

  test('restarting re-mounts from nothing (a fresh handshake, as it must be)', () => {
    let r: Retention | null = retain(null, input({ terminal: true }))
    r = retain(r, input({ stopped: true }))
    r = retain(r, input({ terminal: true }))
    expect(r).toEqual({ name: 's1', chat: false, terminal: true })
  })
})

describe('the undecided frame', () => {
  test('neither renderer selected mounts NOTHING (A1 no-flash rule survives)', () => {
    expect(retain(null, input())).toEqual({
      name: 's1',
      chat: false,
      terminal: false,
    })
  })

  test('an undecided frame after a mount does not tear anything down', () => {
    const r = retain(retain(null, input({ chat: true })), input())
    expect(r).toEqual({ name: 's1', chat: true, terminal: false })
  })
})
