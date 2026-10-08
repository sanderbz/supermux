/**
 * A colleague on a company host (cookie session, no bearer) could not change
 * anything: the server's double-submit check wants the readable `supermux_csrf`
 * cookie echoed in `x-supermux-csrf`, and only `/auth/*` did that. Every other
 * write ("connect GitHub with a key", …) came back 403 "missing or invalid CSRF
 * token". That 403 — and any 403 from an owner-only route the colleague's UI
 * touched — then raised the sticky full-screen "Sign in again / Reload" overlay,
 * because 403 was classified as an expired session.
 *
 * Pinned here: the global fetch wrapper adds the header on state-changing API
 * calls of a cookie session (and nowhere else), and only a 401 raises the
 * overlay.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { installFetchInstrumentation } from '@/lib/api/fetch-wrap'
import { useApiStatus } from '@/stores/api-status-store'
import { httpTransport } from '@/lib/upload/manager'

interface Call {
  input: unknown
  init?: RequestInit
}

const calls: Call[] = []
let nextStatus = 200

function header(c: Call, name: string): string | null {
  return new Headers(c.init?.headers).get(name)
}

const testWindow = {
  location: { origin: 'https://acme.test', pathname: '/' },
  _SUPERMUX_BASE_URL: '',
  fetch: (input: unknown, init?: RequestInit) => {
    calls.push({ input, init })
    return Promise.resolve({ ok: nextStatus < 400, status: nextStatus, statusText: '' })
  },
}
let priorWindow: PropertyDescriptor | undefined
let priorDocument: PropertyDescriptor | undefined
let priorXhr: PropertyDescriptor | undefined
let priorApiState: ReturnType<typeof useApiStatus.getState>

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else Reflect.deleteProperty(globalThis, name)
}

beforeAll(() => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window')
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: testWindow })
    installFetchInstrumentation()
  } finally {
    restoreGlobal('window', prior)
  }
})

beforeEach(() => {
  calls.length = 0
  nextStatus = 200
  priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  priorXhr = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
  priorApiState = useApiStatus.getState()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: testWindow })
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { cookie: 'supermux_csrf=tok%2B123; other=x' },
  })
  useApiStatus.setState({ kind: 'connected', lastError: null, retryAt: null })
})

afterEach(() => {
  restoreGlobal('window', priorWindow)
  restoreGlobal('document', priorDocument)
  restoreGlobal('XMLHttpRequest', priorXhr)
  useApiStatus.setState(priorApiState)
})

const wfetch = (input: RequestInfo | URL, init?: RequestInit) =>
  (globalThis as unknown as { window: { fetch: typeof fetch } }).window.fetch(input, init)

describe('CSRF header on a cookie session', () => {
  test('a POST to the API carries the decoded CSRF cookie', async () => {
    await wfetch('/api/connectors/github/credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(header(calls[0], 'x-supermux-csrf')).toBe('tok+123')
    expect(header(calls[0], 'content-type')).toBe('application/json')
  })

  test('PUT / PATCH / DELETE carry it too; GET does not', async () => {
    await wfetch('/api/sessions/x/config', { method: 'PATCH' })
    await wfetch('/api/sessions/x', { method: 'delete' })
    await wfetch('/api/sessions')
    expect(header(calls[0], 'x-supermux-csrf')).toBe('tok+123')
    expect(header(calls[1], 'x-supermux-csrf')).toBe('tok+123')
    expect(header(calls[2], 'x-supermux-csrf')).toBeNull()
  })

  test('no CSRF cookie (the owner on a bearer) leaves the request untouched', async () => {
    document.cookie = ''
    const init = { method: 'POST', headers: { Authorization: 'Bearer t' } }
    await wfetch('/api/sessions', init)
    expect(calls[0].init).toBe(init)
  })

  test('a non-API URL is never given the header', async () => {
    await wfetch('https://example.com/api/x', { method: 'POST' })
    expect(header(calls[0], 'x-supermux-csrf')).toBeNull()
  })

  test('a caller-supplied header is kept as is', async () => {
    await wfetch('/api/x', { method: 'POST', headers: { 'x-supermux-csrf': 'mine' } })
    expect(header(calls[0], 'x-supermux-csrf')).toBe('mine')
  })
})

describe('which refusals raise the "Sign in again" overlay', () => {
  test('a 403 is a refusal from a healthy server, not an expired session', async () => {
    nextStatus = 403
    await wfetch('/api/version')
    expect(useApiStatus.getState().kind).toBe('connected')
  })

  test('a 401 still means the credential is gone', async () => {
    nextStatus = 401
    await wfetch('/api/sessions')
    expect(useApiStatus.getState().kind).toBe('auth_invalid')
  })
})


describe('other cookie-authenticated write paths', () => {
  test('a Request keeps its headers and body while gaining the CSRF header', async () => {
    const request = new Request('https://acme.test/api/sessions', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"name":"agent"}',
    })
    await wfetch(request)
    expect(calls[0].input).toBe(request)
    expect(header(calls[0], 'x-supermux-csrf')).toBe('tok+123')
    expect(header(calls[0], 'content-type')).toBe('application/json')
    expect(await request.text()).toBe('{"name":"agent"}')
  })

  test('upload chunks carry CSRF even though XHR bypasses the fetch wrapper', async () => {
    const headers = new Map<string, string>()
    class UploadXhr {
      status = 200
      responseText = '{"offset":3}'
      upload = {}
      onload?: () => void
      open(method: string, url: string) {
        expect(method).toBe('PATCH')
        expect(url).toBe('/api/fs/uploads/upload-1')
      }
      setRequestHeader(name: string, value: string) { headers.set(name, value) }
      send() { this.onload?.() }
    }
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      configurable: true, value: UploadXhr,
    })
    expect(await httpTransport.patch('upload-1', 0, new Blob(['abc']), () => {}, {
      aborted: false, onAbort: () => {},
    })).toEqual({ offset: 3 })
    expect(headers.get('x-supermux-csrf')).toBe('tok+123')
    expect(headers.get('Upload-Offset')).toBe('0')
  })
})
