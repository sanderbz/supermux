import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { useChatBacklog, type ChatBacklog } from '../../src/components/chat/use-chat-backlog'
import type { ChatWireView } from '../../src/components/chat/use-chat-ws'
import type { WireEntry } from '../../src/components/chat/wire'

const entry = (uuid: string, offset: number): WireEntry => ({ uuid, offset, seq: offset, ts_ms: 1000 + offset, kind: 'assistant', body: { text: uuid }, truncated: false, oversize: false })
function tail(id = 'conversation-a', epoch = 'store-a', revision = 1): ChatWireView {
  return { wire: [entry(id + '-tail', 100)], state: 'live', seeded: true, hasMore: true, nextBefore: id + ':100', resyncCount: 0, sourceRevision: revision, conversationId: id, sourceEpoch: epoch, sourceGeneration: 1, isLoading: false, isError: false, lastSignalAt: 1000, fetching: new Set(), fetchFailed: new Set(), retryFull: () => {}, redial: () => {}, fresh: false, gone: null }
}
let root: Root | null = null, dom: JSDOM | null = null
const nativeFetch = globalThis.fetch
const prior = new Map<string, PropertyDescriptor | undefined>()
afterEach(async () => {
  if (root) await React.act(() => root?.unmount()); root = null
  dom?.window.close(); dom = null; globalThis.fetch = nativeFetch
  for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } prior.clear()
})
async function harness(initial = tail()) {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) { prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value }) }
  Object.assign(dom.window, { _SUPERMUX_BASE_URL: 'http://localhost/', _SUPERMUX_AUTH_TOKEN: 'fixture-only' })
  const requests: Array<{ url: URL; resolve: (value: Response) => void }> = []
  globalThis.fetch = ((url: string | URL | Request) => new Promise<Response>(resolve => requests.push({ url: new URL(String(url), 'http://localhost'), resolve }))) as typeof fetch
  let view: ChatBacklog
  function Probe({ data }: { data: ChatWireView }) { view = useChatBacklog('test-session', data); return null }
  root = createRoot(dom.window.document.getElementById('root')!)
  const render = async (data: ChatWireView) => { await React.act(async () => { root!.render(<Probe data={data} />) }) }
  await render(initial)
  const answer = async (index: number, data: unknown) => { await React.act(async () => { requests[index].resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 })); await new Promise(resolve => setTimeout(resolve, 0)) }) }
  return { render, answer, requests, view: () => view!, load: async () => { await React.act(() => view!.loadOlder()) } }
}
describe('paged history belongs to its transcript source', () => {
  test('same conversation reconnect retains paged history; different conversation drops it before display', async () => {
    const h = await harness(); await h.load()
    expect(h.requests[0].url.searchParams.get('conversation_id')).toBe('conversation-a')
    expect(h.requests[0].url.searchParams.get('source_epoch')).toBe('store-a')
    await h.answer(0, { entries: [entry('older-a', 0)], has_more: false, conversation_id: 'conversation-a' })
    expect(h.view().entries.some(e => e.uuid === 'older-a')).toBe(true)
    await h.render(tail('conversation-a', 'restarted-store', 1))
    expect(h.view().entries.some(e => e.uuid === 'older-a')).toBe(true)
    await h.render(tail('conversation-b', 'restarted-store', 2))
    expect(h.view().entries.map(e => e.uuid)).toEqual(['conversation-b-tail'])
  })
  test('same-store source reset discards loaded history and a late page', async () => {
    const h = await harness(); await h.load()
    await h.answer(0, { entries: [entry('before-reset', 0)], has_more: true, next_before: 'conversation-a:0' })
    await h.load()
    await h.render({ ...tail('conversation-a', 'store-a', 2), sourceGeneration: 2 })
    expect(h.view().entries.map(e => e.uuid)).toEqual(['conversation-a-tail'])
    await h.answer(1, { entries: [entry('late-before-reset', -1)], has_more: false })
    expect(h.view().entries.map(e => e.uuid)).toEqual(['conversation-a-tail'])
  })
  test('old in-flight page cannot block a new source or splice a late response into it', async () => {
    const h = await harness(); await h.load(); await h.render(tail('conversation-b', 'store-b', 2)); await h.load()
    expect(h.requests.length).toBe(2)
    await h.answer(1, { entries: [entry('older-b', 0)], has_more: false })
    await h.answer(0, { entries: [entry('obsolete-private-page', 0)], has_more: false })
    expect(h.view().entries.map(e => e.uuid)).toEqual(['conversation-b-tail', 'older-b'])
    expect(h.view().loadingOlder).toBe(false)
  })
})
