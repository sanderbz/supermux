// The upload manager's queue, resume and failure behaviour — driven through the
// injected transport seam, so no server and no XHR are involved.
//
// What is pinned here is the part that a person notices when it is wrong: a
// dropped connection must resume from the SERVER's offset (not the client's
// guess), a 4xx that retrying cannot fix must stop instead of hammering, a
// cancel must tell the server so the bytes are reclaimed, and a reload must
// refuse to resume onto a file that doesn't match.

import { describe, expect, test } from 'bun:test'

import {
  createUploadManager,
  UploadError,
  type UploadTransport,
} from '@/lib/upload/manager'
import { STORE_KEY } from '@/lib/upload/protocol'

/** A File stand-in: the manager only ever calls `.slice()` and reads name/size. */
function fakeFile(name: string, size: number): File {
  return {
    name,
    size,
    slice: (start: number, end: number) => ({ size: end - start }) as Blob,
  } as unknown as File
}

interface Server {
  offset: number
  size: number
  completed: boolean
  cancelled: boolean
  patches: number[]
}

function fakeTransport(opts: { failAt?: number; failWith?: UploadError; delayMs?: number } = {}) {
  const server: Server = { offset: 0, size: 0, completed: false, cancelled: false, patches: [] }
  let patchCalls = 0
  const transport: UploadTransport = {
    init: async ({ size }) => {
      server.size = size
      return { id: 'up1', offset: 0, size, name: 'f', chunk_size: 100 }
    },
    status: async () => ({ id: 'up1', offset: server.offset, size: server.size, name: 'f' }),
    patch: async (_id, offset, blob) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      patchCalls += 1
      server.patches.push(offset)
      if (opts.failAt && patchCalls === opts.failAt) {
        // Half the chunk landed before the connection died — the case that makes
        // "resume from where the client thinks it is" wrong.
        server.offset = offset + Math.floor((blob as { size: number }).size / 2)
        throw opts.failWith ?? new UploadError('The connection dropped mid-chunk.', 0)
      }
      server.offset = offset + (blob as { size: number }).size
      return { offset: server.offset }
    },
    complete: async () => {
      server.completed = true
      return { path: `/home/me/f`, name: 'f', size: server.size, sha256: 'deadbeef' }
    },
    cancel: async () => {
      server.cancelled = true
    },
  }
  return { transport, server }
}

async function settle(read: () => string, want: string, budgetMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (read() === want) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`never reached "${want}" — stuck at "${read()}"`)
}

describe('the upload manager', () => {
  test('uploads a file in chunks and finishes', async () => {
    const { transport, server } = fakeTransport()
    const m = createUploadManager(transport)
    m.enqueue('/home/me', [fakeFile('f', 250)])
    await settle(() => m.getSnapshot()[0]?.state ?? '', 'done')

    expect(server.completed).toBe(true)
    expect(server.patches).toEqual([0, 100, 200]) // 100 + 100 + 50
    expect(m.getSnapshot()[0].path).toBe('/home/me/f')
  })

  test('a mid-chunk drop resumes from the SERVER offset, not a chunk boundary', async () => {
    const { transport, server } = fakeTransport({ failAt: 2 })
    const m = createUploadManager(transport)
    m.enqueue('/home/me', [fakeFile('f', 250)])
    await settle(() => m.getSnapshot()[0]?.state ?? '', 'done', 8000)

    // Chunk 2 died after 50 of its 100 bytes, so the server was at 150. The
    // client must ask, then continue at 150 — a naive retry would re-send from
    // 100 (and be refused) or skip to 200 (and corrupt the file).
    expect(server.patches).toContain(150)
    expect(server.completed).toBe(true)
  })

  test('a 4xx that retrying cannot fix stops immediately with the server’s words', async () => {
    const { transport, server } = fakeTransport({
      failAt: 1,
      failWith: new UploadError('not enough free space — needs 9.0 GB, 2.0 GB free', 507),
    })
    const m = createUploadManager(transport)
    m.enqueue('/home/me', [fakeFile('f', 250)])
    await settle(() => m.getSnapshot()[0]?.state ?? '', 'failed')

    expect(m.getSnapshot()[0].error).toContain('not enough free space')
    expect(server.completed).toBe(false)
    // Exactly one attempt: hammering a full disk five more times helps nobody.
    expect(server.patches).toEqual([0])
  })

  test('cancel tells the server, so the partial bytes are reclaimed', async () => {
    const { transport, server } = fakeTransport({ delayMs: 15 })
    const m = createUploadManager(transport)
    m.enqueue('/home/me', [fakeFile('f', 100_000)])
    await settle(() => m.getSnapshot()[0]?.state ?? '', 'uploading')
    m.cancel(m.getSnapshot()[0].key)
    await settle(() => m.getSnapshot()[0]?.state ?? '', 'cancelled')
    await new Promise((r) => setTimeout(r, 20))

    expect(server.cancelled).toBe(true)
    expect(server.completed).toBe(false)
  })

  test('a file over the 10 GB ceiling is refused before a byte moves', () => {
    const { transport, server } = fakeTransport()
    const m = createUploadManager(transport)
    m.enqueue('/home/me', [fakeFile('huge', 11 * 1024 * 1024 * 1024)])

    expect(m.getSnapshot()[0].state).toBe('failed')
    expect(m.getSnapshot()[0].error).toContain('10 GB')
    expect(server.patches).toEqual([])
  })

  test('a reload offers the still-live upload for resume, and checks the re-picked file', async () => {
    const { transport, server } = fakeTransport()
    server.size = 250
    server.offset = 100
    const store = {
      getItem: () =>
        JSON.stringify([{ id: 'up1', name: 'f', size: 250, dir: '/home/me', offset: 100 }]),
      setItem: () => {},
    }
    const m = createUploadManager(transport, store)
    await m.hydrate()

    const row = m.getSnapshot()[0]
    expect(row.state).toBe('resumable')
    expect(row.offset).toBe(100)

    // The wrong file is refused — appending its bytes would produce a corrupt
    // file with a plausible name.
    expect(m.resumeWith(row.key, fakeFile('f', 999))).toBe(false)
    expect(m.getSnapshot()[0].state).toBe('resumable')

    expect(m.resumeWith(row.key, fakeFile('f', 250))).toBe(true)
    await settle(() => m.getSnapshot()[0]?.state ?? '', 'done')
    // It resumed rather than restarting: nothing was re-sent from zero.
    expect(server.patches[0]).toBe(100)
  })

  test('the persisted manifest lands under a versioned key', () => {
    const written: Record<string, string> = {}
    const { transport } = fakeTransport()
    const m = createUploadManager(transport, {
      getItem: (k: string) => written[k] ?? null,
      setItem: (k: string, v: string) => {
        written[k] = v
      },
    })
    m.enqueue('/home/me', [fakeFile('f', 250)])
    expect(Object.keys(written)).toEqual([STORE_KEY])
  })
})
