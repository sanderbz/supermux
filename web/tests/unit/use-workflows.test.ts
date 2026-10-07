/**
 * T5.1 — the workflows transport, and the one branch that decides whether the
 * surface is alive.
 *
 * Two channels carry workflow news (`workflows` frames, and `alerts` frames the
 * engine raises when a run finishes) and the second is SHARED with the board.
 * "Invalidate on every alert" would refetch the whole surface every time an
 * issue moved; "invalidate on `workflows` only" would leave a finished run
 * showing as running until the next focus resync. So the predicate is pure and
 * asserted here rather than inferred from a mounted provider.
 *
 * The 410 branch is the stale-bundle path from spec §5.2: a PWA wedged on a
 * pre-cutover bundle POSTs to `/api/schedules` and gets `410 Gone`. That is the
 * ONE status that means "this client is out of date" rather than "this request
 * was wrong", and the client has to be able to tell them apart to surface the
 * reload prompt instead of a red error.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { isWorkflowEvent } from '../../src/hooks/use-workflows'
import {
  WorkflowError,
  isStaleBundle,
  parseCompletion,
  parseConnectors,
  parseFiles,
  workflowsApi,
} from '../../src/lib/api/workflows'

describe('the SSE invalidation branch', () => {
  test('a `workflows` frame invalidates', () => {
    expect(isWorkflowEvent('workflows', { change: 'run', workflow: 'WF-1' })).toBe(true)
  })

  test('a workflow-sourced `alerts` frame invalidates', () => {
    expect(isWorkflowEvent('alerts', { source: 'workflow' })).toBe(true)
    // The engine's own frames say "workflows"; the spec writes the singular.
    expect(isWorkflowEvent('alerts', { source: 'workflows' })).toBe(true)
    // Some emitters nest the payload one level down.
    expect(isWorkflowEvent('alerts', { payload: { source: 'workflows' } })).toBe(true)
  })

  test('a BOARD-sourced alert does NOT invalidate', () => {
    expect(isWorkflowEvent('alerts', { source: 'board' })).toBe(false)
  })

  test('an unrelated channel does not invalidate', () => {
    expect(isWorkflowEvent('sessions', { delta: [] })).toBe(false)
    expect(isWorkflowEvent('schedules', {})).toBe(false)
  })
})

describe('410 is the stale-bundle tell, not an error', () => {
  test('isStaleBundle is true for 410 and nothing else', () => {
    expect(isStaleBundle(410)).toBe(true)
    for (const s of [0, 400, 403, 404, 409, 500]) expect(isStaleBundle(s)).toBe(false)
  })

  test('a WorkflowError carries the status and reports `gone`', () => {
    expect(new WorkflowError('x', 410).gone).toBe(true)
    expect(new WorkflowError('x', 400).gone).toBe(false)
    expect(new WorkflowError('x', 400).status).toBe(400)
  })
})

describe('the client speaks the envelope', () => {
  // `apiToken`/`apiUrl` read the runtime globals the shell stamps on `window`;
  // a bun test has no DOM, so the two the client actually reads are stubbed
  // rather than the whole surface mocked.
  const globals = globalThis as unknown as { window?: { _SUPERMUX_AUTH_TOKEN?: string; _SUPERMUX_BASE_URL?: string } }
  let originalWindow: typeof globals.window
  let originalToken: string | undefined, originalBase: string | undefined
  beforeEach(() => {
    originalWindow = globals.window
    originalToken = originalWindow?._SUPERMUX_AUTH_TOKEN
    originalBase = originalWindow?._SUPERMUX_BASE_URL
    globals.window ??= {}
    globals.window._SUPERMUX_AUTH_TOKEN = 'test-token'
    globals.window._SUPERMUX_BASE_URL = ''
  })
  afterEach(() => {
    if (originalWindow === undefined) delete globals.window
    else {
      globals.window = originalWindow
      originalWindow._SUPERMUX_AUTH_TOKEN = originalToken
      originalWindow._SUPERMUX_BASE_URL = originalBase
    }
  })

  const withFetch = async <T,>(
    reply: { status: number; body: unknown },
    run: () => Promise<T>,
  ): Promise<{ url: string; init: RequestInit | undefined; result?: T; error?: unknown }> => {
    const seen: { url: string; init: RequestInit | undefined } = { url: '', init: undefined }
    const original = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      seen.url = String(input)
      seen.init = init
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        text: async () => JSON.stringify(reply.body),
      } as unknown as Response
    }) as typeof fetch
    try {
      const result = await run()
      return { ...seen, result }
    } catch (error) {
      return { ...seen, error }
    } finally {
      globalThis.fetch = original
    }
  }

  test('unwraps `{ok,data}` on success', async () => {
    const r = await withFetch({ status: 200, body: { ok: true, data: [{ id: 'WF-1' }] } }, () =>
      workflowsApi.list(),
    )
    expect(r.result).toEqual([{ id: 'WF-1' }] as never)
    expect(r.url).toContain('/api/workflows')
  })

  test('narrows the list to one bot when a session is given', async () => {
    const r = await withFetch({ status: 200, body: { ok: true, data: [] } }, () =>
      workflowsApi.list('scout'),
    )
    expect(r.url).toContain('session=scout')
  })

  test('lifts `{ok:false,error}` into a WorkflowError with its status', async () => {
    const r = await withFetch(
      { status: 400, body: { ok: false, error: 'in 5 potatoes: unknown unit' } },
      () => workflowsApi.preview('in 5 potatoes'),
    )
    expect(r.error).toBeInstanceOf(WorkflowError)
    expect((r.error as WorkflowError).message).toContain('unknown unit')
    expect((r.error as WorkflowError).status).toBe(400)
  })

  test('preview POSTs the expression — the composer’s reassurance line', async () => {
    const r = await withFetch(
      { status: 200, body: { ok: true, data: { next_runs: ['2026-08-31T09:00:00Z'] } } },
      () => workflowsApi.preview('every weekday at 9am'),
    )
    expect(r.url).toContain('/api/workflows/preview')
    expect(r.init?.method).toBe('POST')
    expect(String(r.init?.body)).toContain('every weekday at 9am')
  })

  test('replaceSteps PUTs the ordered list under a `steps` key', async () => {
    const r = await withFetch({ status: 200, body: { ok: true, data: [] } }, () =>
      workflowsApi.replaceSteps('WF-1', [{ prompt: 'Draft the summary' }]),
    )
    expect(r.init?.method).toBe('PUT')
    expect(r.url).toContain('/api/workflows/WF-1/steps')
    expect(JSON.parse(String(r.init?.body))).toEqual({
      steps: [{ prompt: 'Draft the summary' }],
    })
  })
})

describe('the stored-JSON readers are total', () => {
  test('files / connectors survive null, junk and the wrong shape', () => {
    expect(parseFiles(null)).toEqual([])
    expect(parseFiles('not json')).toEqual([])
    expect(parseFiles('{"path":"x"}')).toEqual([])
    expect(parseFiles('[{"path":"/d/uploads/a.pdf","name":"a.pdf"}]')).toEqual([
      { path: '/d/uploads/a.pdf', name: 'a.pdf' },
    ])
    expect(parseConnectors('["gmail",7]')).toEqual(['gmail'])
  })

  test('an unknown completion kind reads back as `none`, never as itself', () => {
    // A row written by a future version — or a hand-edited `command:` — must not
    // reach the UI as something it can render or round-trip.
    expect(parseCompletion('{"kind":"command","text":"rm -rf /"}')).toEqual({ kind: 'none' })
    expect(parseCompletion('')).toEqual({ kind: 'none' })
    expect(parseCompletion('{"kind":"notify"}')).toEqual({ kind: 'notify' })
    expect(parseCompletion('{"kind":"message_bot","session":"inbox"}')).toEqual({
      kind: 'message_bot',
      session: 'inbox',
    })
  })
})
