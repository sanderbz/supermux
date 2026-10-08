import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import {
  usePendingSends,
  type PendingSendsHandle,
} from '../../src/components/chat/use-pending-sends'
import {
  useComposer,
  type ComposerHandle,
} from '../../src/components/chat/use-composer'
import { getDraft, setDraft } from '../../src/components/chat/composer-draft'
import { restSessionInput } from '../../src/lib/session-input'
import { SessionError } from '../../src/lib/api/sessions'
import { retryAttachmentsUnchanged } from '../../src/components/chat/composer-insert'
import { sendFailureNote } from '../../src/components/chat/send-errors'

let root: Root | null = null,
  dom: JSDOM | null = null,
  seq = 0
let currentName: string | null = null
const prior = new Map<string, PropertyDescriptor | undefined>()
afterEach(async () => {
  if (root) await React.act(() => root?.unmount())
  root = null
  if (currentName) setDraft(currentName, '')
  currentName = null
  dom?.window.close()
  dom = null
  for (const [key, descriptor] of prior) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  prior.clear()
})
async function harness() {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const name = `retry-unit-${++seq}`
  currentName = name
  const requests: Array<{
    body: { text: string; send_id: string }
    resolve: () => void
    reject: (e: Error) => void
  }> = []
  const input = restSessionInput(name, {
    request: (_url, init) =>
      new Promise<void>((resolve, reject) =>
        requests.push({
          body: JSON.parse(String(init?.body)),
          resolve,
          reject,
        }),
      ),
  })
  let pending: PendingSendsHandle,
    composer: ComposerHandle,
    blocked = false,
    prefix = ''
  const peek = { refresh: async () => null }
  function Probe() {
    pending = usePendingSends({
      name,
      input,
      entries: [],
      active: false,
      peek,
      formCard: blocked,
    })
    composer = useComposer({
      name,
      input: pending.input,
      active: false,
      getOutgoingPrefix: () => prefix,
    })
    return null
  }
  root = createRoot(dom.window.document.getElementById('root')!)
  const render = async () => {
    await React.act(() => root!.render(<Probe />))
  }
  await render()
  const flush = async (fn: () => void) => {
    await React.act(async () => {
      fn()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  const draft = (text: string) => flush(() => setDraft(name, text))
  const send = () => flush(() => composer!.submit())
  const retry = () => flush(() => pending!.retry(pending!.items[0].id))
  const fail = (index = 0, status = 409) =>
    flush(() =>
      requests[index].reject(
        new SessionError(
          'conflict: session has an unsent terminal draft',
          status,
        ),
      ),
    )
  const succeed = (index = 1) => flush(() => requests[index].resolve())
  return {
    requests,
    draft,
    send,
    retry,
    fail,
    succeed,
    flush,
    pending: () => pending!,
    composer: () => composer!,
    text: () => getDraft(name),
    block: async () => {
      blocked = true
      await render()
    },
    prefix: (value: string) => {
      prefix = value
    },
  }
}
describe('failed send recovery', () => {
  test('unchanged Send reuses one row and original key, accepted response clears draft', async () => {
    const h = await harness()
    await h.draft('Saved question')
    await h.send()
    await h.fail()
    const id = h.pending().items[0].id
    expect(h.text()).toBe('Saved question')
    expect(h.pending().items[0].transportError).toBe(false)
    expect(h.pending().items[0].note).toBe(
      'Finish or clear the draft in Terminal, then retry.',
    )
    await h.send()
    expect(h.pending().items).toHaveLength(1)
    expect(h.pending().items[0].id).toBe(id)
    expect(h.requests[1].body).toEqual(h.requests[0].body)
    expect(Object.keys(h.requests[0].body).sort()).toEqual(['send_id', 'text'])
    await h.succeed()
    expect(h.text()).toBe('')
    expect(h.pending().items[0].receipted).toBe(true)
  })
  test('Retry clears the matching raw draft, preserves whitespace edits and sends saved text', async () => {
    const h = await harness()
    await h.draft(' Saved question ')
    await h.send()
    await h.fail()
    await h.retry()
    expect(h.requests[1].body.text).toBe('Saved question')
    await h.draft(' Saved question  ')
    await h.succeed()
    expect(h.text()).toBe(' Saved question  ')
  })
  test('Retry clears a draft that is still exactly the saved original', async () => {
    const h = await harness()
    await h.draft(' original ')
    await h.send()
    await h.fail()
    await h.retry()
    await h.succeed()
    expect(h.text()).toBe('')
  })
  test('retry cannot erase a newer uploading, failed or ready attachment', () => {
    const first = { uploading: false, path: '/uploads/first.png' }
    const prefix = '"/uploads/first.png" '
    expect(retryAttachmentsUnchanged([first], prefix)).toBe(true)
    expect(
      retryAttachmentsUnchanged(
        [first, { uploading: true, path: null }],
        prefix,
      ),
    ).toBe(false)
    expect(
      retryAttachmentsUnchanged(
        [first, { uploading: false, path: null, error: 'failed' }],
        prefix,
      ),
    ).toBe(false)
    expect(
      retryAttachmentsUnchanged(
        [first, { uploading: false, path: '/uploads/new.png' }],
        prefix,
      ),
    ).toBe(false)
  })
  test('new draft survives in-flight Retry; unchanged concurrent Send joins its request', async () => {
    const h = await harness()
    await h.draft('original')
    await h.send()
    await h.fail(0, 0)
    await h.retry()
    await h.send()
    expect(h.requests).toHaveLength(2)
    expect(h.pending().items).toHaveLength(1)
    await h.draft('a new question')
    await h.succeed()
    expect(h.text()).toBe('a new question')
    expect(h.requests[1].body.send_id).toBe(h.requests[0].body.send_id)
  })
  test('edited Send has its own identity and preserves the refused row', async () => {
    const h = await harness()
    await h.draft('original')
    await h.send()
    await h.fail()
    await h.draft('edited')
    await h.send()
    expect(h.pending().items).toHaveLength(2)
    expect(h.requests[1].body.send_id).not.toBe(h.requests[0].body.send_id)
    await h.succeed()
  })
  test('fresh local refusal remains definitely unsent, never a transport failure', async () => {
    const h = await harness()
    await h.draft('original')
    await h.send()
    await h.fail()
    await h.block()
    await h.retry()
    expect(h.requests).toHaveLength(1)
    expect(h.pending().items[0].state).toBe('undelivered')
    expect(h.pending().items[0].transportError).toBe(false)
    expect(h.pending().items[0].note).toBe(
      'Answer the request above before retrying.',
    )
  })
  test('attachment-only retry retains original draft provenance', async () => {
    const h = await harness()
    h.prefix('"/uploads/first.png" ')
    await h.send()
    await h.fail()
    await h.draft('new question')
    await h.retry()
    await h.succeed()
    expect(h.text()).toBe('new question')
    expect(h.requests[1].body.text).toBe('"/uploads/first.png" ')
    expect(h.pending().items[0].attachmentPrefix).toBe('"/uploads/first.png" ')
  })
  test('known refusal and connection failures are readable; unknown diagnostics survive', () => {
    expect(
      sendFailureNote(new SessionError('unsent terminal draft', 409)),
    ).toBe('Finish or clear the draft in Terminal, then retry.')
    expect(sendFailureNote(new SessionError('network', 0))).toContain(
      'Your message is saved',
    )
    expect(sendFailureNote(new SessionError('new server refusal', 422))).toBe(
      'new server refusal',
    )
  })
})
