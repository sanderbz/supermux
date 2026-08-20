// SessionInput — the input plane's contract (fase A4 T1).
//
// The two implementations are pinned against each other because the failure
// they exist to prevent is silent: a caller that appends its own '\r' AND a
// server that appends an Enter submits the same prompt twice.

import { describe, expect, test } from 'bun:test'

import {
  restSessionInput,
  terminalSessionInput,
  TERMINAL_KEY_BYTES,
} from '../../src/lib/session-input'
import type { KeyName, TerminalLike } from '../../src/lib/session-input'

interface Call {
  url: string
  body: unknown
  method?: string
}

function restRig() {
  const calls: Call[] = []
  const input = restSessionInput('rt', {
    request: (url, init) => {
      calls.push({
        url,
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      })
      return Promise.resolve({} as never)
    },
  })
  return { calls, input }
}

function termRig() {
  const sent: string[] = []
  const keys: string[] = []
  let focused = 0
  let blurred = 0
  const term: TerminalLike = {
    send: (t: string) => sent.push(t),
    sendKey: (k: string) => keys.push(k),
    focus: () => {
      focused += 1
    },
    blur: () => {
      blurred += 1
    },
  }
  return {
    sent,
    keys,
    term,
    counts: () => ({ focused, blurred }),
    input: terminalSessionInput(term),
  }
}

describe('restSessionInput', () => {
  test('submit posts /send with the raw text — never a trailing CR', async () => {
    const { calls, input } = restRig()
    await input.submit('hello')
    expect(calls[0].url).toBe('/api/sessions/rt/send')
    expect(calls[0].method).toBe('POST')
    // The server adds the Enter (lifecycle.rs send_text).
    expect(calls[0].body).toEqual({ text: 'hello' })
  })

  test('an idempotency key rides the /send body as send_id; without one the body is unchanged', async () => {
    const { calls, input } = restRig()
    await input.submit('hello', { sendId: 'k-7' })
    expect(calls[0].body).toEqual({ text: 'hello', send_id: 'k-7' })
    // No opts → the key is absent from the wire (JSON drops the undefined), so a
    // caller that mints no id sends exactly `{text}` as before.
    await input.submit('bye')
    expect(calls[1].body).toEqual({ text: 'bye' })
  })

  test('the name is URL-encoded into the path', async () => {
    const calls: Call[] = []
    const input = restSessionInput('a/b c', {
      request: (url, init) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) })
        return Promise.resolve({} as never)
      },
    })
    await input.submit('x')
    expect(calls[0].url).toBe('/api/sessions/a%2Fb%20c/send')
  })

  test('insert never submits', async () => {
    const { calls, input } = restRig()
    await input.insert('/opt/projects/supermux/README.md')
    expect(calls[0].url).toBe('/api/sessions/rt/paste')
    expect(calls[0].body).toEqual({
      text: '/opt/projects/supermux/README.md',
      submit: false,
    })
  })

  test('sendKey posts the allowlist name under {keys}', async () => {
    const { calls, input } = restRig()
    await input.sendKey('Down')
    await input.sendKey('Enter')
    expect(calls.map((c) => c.url)).toEqual([
      '/api/sessions/rt/keys',
      '/api/sessions/rt/keys',
    ])
    expect(calls.map((c) => c.body)).toEqual([{ keys: 'Down' }, { keys: 'Enter' }])
  })

  test('a rejected POST rejects the promise (the T4 watchdog needs to see it)', async () => {
    const input = restSessionInput('rt', {
      request: () => Promise.reject(new Error('session is not running')),
    })
    expect(input.submit('hello')).rejects.toThrow('session is not running')
  })

  test('focus/blur delegate to the composer — the REST plane has no cursor', () => {
    let focused = 0
    let blurred = 0
    const input = restSessionInput('rt', {
      request: () => Promise.resolve({}),
      onFocus: () => {
        focused += 1
      },
      onBlur: () => {
        blurred += 1
      },
    })
    input.focus()
    input.blur()
    expect([focused, blurred]).toEqual([1, 1])
    // …and are safe no-ops when nothing registered one.
    expect(() => restSessionInput('rt').blur()).not.toThrow()
  })
})

describe('terminalSessionInput', () => {
  test('submit appends exactly one CR', async () => {
    const rig = termRig()
    await rig.input.submit('hello')
    expect(rig.sent).toEqual(['hello\r'])
  })

  test('insert appends nothing', async () => {
    const rig = termRig()
    await rig.input.insert('hello')
    expect(rig.sent).toEqual(['hello'])
  })

  test('sendKey translates the tmux name into a keyToBytes name', async () => {
    const rig = termRig()
    await rig.input.sendKey('BTab')
    await rig.input.sendKey('BSpace')
    await rig.input.sendKey('C-c')
    await rig.input.sendKey('Space')
    // Without the table these would be TYPED as the literal words "BTab",
    // "BSpace", "C-c" — keyToBytes passes unknown names through as text.
    expect(rig.keys).toEqual(['BackTab', 'Backspace', 'Ctrl-C', ' '])
  })

  test('every KeyName maps to something, and never to its own tmux spelling', () => {
    const names = Object.keys(TERMINAL_KEY_BYTES) as KeyName[]
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) {
      expect(TERMINAL_KEY_BYTES[n].length).toBeGreaterThan(0)
    }
    // The four names whose vocabularies differ must not pass through unchanged.
    for (const n of ['BTab', 'BSpace', 'C-c', 'C-d'] as KeyName[]) {
      expect(TERMINAL_KEY_BYTES[n]).not.toBe(n)
    }
  })

  test('no KeyName is a digit (KEY_ALLOWLIST has none)', () => {
    for (const n of Object.keys(TERMINAL_KEY_BYTES)) {
      expect(/^\d$/.test(n)).toBe(false)
    }
  })

  test('focus/blur reach the terminal', () => {
    const rig = termRig()
    rig.input.focus()
    rig.input.blur()
    expect(rig.counts()).toEqual({ focused: 1, blurred: 1 })
  })

  test('a ref source resolves per call — a handle built before mount still works', async () => {
    // Exactly what `useTerminalInput` does: the getter closes over the ref, so
    // the handle can be built once, before <LiveTerminal> has ever mounted, and
    // survive it unmounting and remounting.
    const ref: { current: TerminalLike | null } = { current: null }
    const input = terminalSessionInput(() => ref.current)
    // Nothing is mounted yet: the write is dropped, not thrown.
    await input.submit('early')
    input.focus()

    const rig = termRig()
    ref.current = rig.term
    await input.submit('late')
    expect(rig.sent).toEqual(['late\r'])
  })
})

describe('the two planes', () => {
  test('expose the same surface', () => {
    const rest = restSessionInput('x', { request: () => Promise.resolve({}) })
    const term = terminalSessionInput(termRig().term)
    expect(Object.keys(rest).sort()).toEqual(Object.keys(term).sort())
    expect(Object.keys(rest).sort()).toEqual([
      'blur',
      'focus',
      'insert',
      'sendKey',
      'submit',
    ])
  })

  test('only the terminal plane ever appends a CR', async () => {
    const restCalls = restRig()
    await restCalls.input.submit('hello')
    const rest = restCalls.calls[0].body as { text: string }
    const term = termRig()
    await term.input.submit('hello')
    expect(rest.text.endsWith('\r')).toBe(false)
    expect(term.sent[0].endsWith('\r')).toBe(true)
    // Same input, one submit each — never both.
    expect(rest.text + '\r').toBe(term.sent[0])
  })
})
