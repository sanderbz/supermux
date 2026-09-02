// Resumable-upload manager — the STATEFUL half.
//
// A module singleton, not component state: an upload survives navigating away
// from Files, opening a session, and coming back. It is subscribed to with
// `useSyncExternalStore`, so no store library is pulled onto this path.
//
// One XHR per chunk, deliberately. `fetch` reports nothing about a request
// BODY's progress — the only byte-level upload progress a browser exposes is
// `XMLHttpRequest.upload.onprogress`, and a progress bar that jumps 0 → 100 on
// a 9 GB file is not a progress bar.
//
// The server is the authority on the offset. Every retry begins by ASKING
// (`GET /api/fs/uploads/{id}`) rather than assuming, so a chunk that died
// half-written costs one round-trip, not a restart.

import { apiToken, apiUrl } from '@/lib/api/client'

import {
  backoffMs,
  decodeManifest,
  encodeManifest,
  etaFrom,
  fileMatches,
  MAX_ATTEMPTS,
  MAX_FILE_BYTES,
  nextChunk,
  RATE_WINDOW_MS,
  rateFrom,
  STORE_KEY,
  trimWindow,
  type RateSample,
  type UploadItem,
} from './protocol'

export * from './protocol'

/** How many files move at once. Two keeps a slow link saturated without
 *  splitting it so many ways that every file crawls. */
export const MAX_PARALLEL_FILES = 2

// ── the transport seam ──────────────────────────────────────────────────────

export interface InitResult {
  id: string
  offset: number
  size: number
  name: string
  chunk_size: number
}
export interface StatusResult {
  id: string
  offset: number
  size: number
  name: string
}
export interface CompleteResult {
  path: string
  name: string
  size: number
  sha256: string
}

/** Everything the manager does over the wire, behind one interface — so the
 *  queue/resume/backoff logic can be tested against a fake without a server. */
export interface UploadTransport {
  init(input: { dir: string; name: string; size: number }): Promise<InitResult>
  status(id: string): Promise<StatusResult>
  patch(
    id: string,
    offset: number,
    blob: Blob,
    onProgress: (loaded: number) => void,
    signal: { aborted: boolean; onAbort: (fn: () => void) => void },
  ): Promise<{ offset: number }>
  complete(id: string): Promise<CompleteResult>
  cancel(id: string): Promise<void>
}

/** The server's `{ ok:false, error }` envelope, lifted so the tray can show the
 *  server's own sentence ("not enough free space — …") instead of a status code. */
export class UploadError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'UploadError'
    this.status = status
  }
}

function errorFrom(status: number, body: string): UploadError {
  let message = `Upload failed (${status}).`
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (parsed && typeof parsed.error === 'string') message = parsed.error
  } catch {
    if (body) message = body.slice(0, 300)
  }
  // The server prefixes its envelope with the variant name; the person reading
  // the tray does not need "conflict: " in front of the sentence.
  return new UploadError(message.replace(/^(bad request|conflict|not found|forbidden|insufficient storage): /, ''), status)
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  const token = apiToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init?.body) headers.set('Content-Type', 'application/json')
  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, headers })
  } catch {
    throw new UploadError('Can’t reach supermux-server.', 0)
  }
  const text = await res.text()
  if (!res.ok) throw errorFrom(res.status, text)
  return (text ? JSON.parse(text) : null) as T
}

export const httpTransport: UploadTransport = {
  init: (input) =>
    jsonFetch<InitResult>('/api/fs/uploads', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  status: (id) => jsonFetch<StatusResult>(`/api/fs/uploads/${encodeURIComponent(id)}`),
  complete: (id) =>
    jsonFetch<CompleteResult>(`/api/fs/uploads/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  cancel: async (id) => {
    await jsonFetch(`/api/fs/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  patch: (id, offset, blob, onProgress, signal) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PATCH', apiUrl(`/api/fs/uploads/${encodeURIComponent(id)}`), true)
      const token = apiToken()
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.setRequestHeader('Upload-Offset', String(offset))
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.upload.onprogress = (e) => onProgress(e.loaded)
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as { offset: number })
          } catch {
            reject(new UploadError('The server sent a reply we could not read.', xhr.status))
          }
        } else {
          reject(errorFrom(xhr.status, xhr.responseText))
        }
      }
      xhr.onerror = () => reject(new UploadError('The connection dropped mid-chunk.', 0))
      xhr.ontimeout = () => reject(new UploadError('The chunk timed out.', 0))
      xhr.onabort = () => reject(new UploadError('Cancelled.', 0))
      signal.onAbort(() => xhr.abort())
      if (signal.aborted) {
        xhr.abort()
        return
      }
      xhr.send(blob)
    }),
}

// ── the queue ───────────────────────────────────────────────────────────────

interface Entry {
  item: UploadItem
  file: File | null
  chunkSize: number
  samples: RateSample[]
  abort: { aborted: boolean; fns: (() => void)[] }
}

type Listener = () => void

const now = () => Date.now()

class UploadManager {
  private entries = new Map<string, Entry>()
  private order: string[] = []
  private listeners = new Set<Listener>()
  private snapshot: UploadItem[] = []
  private running = 0
  private seq = 0
  private hydrated = false

  private transport: UploadTransport
  private store: Pick<Storage, 'getItem' | 'setItem'> | null

  // Explicit fields rather than constructor parameter properties: this repo
  // builds with `erasableSyntaxOnly`, which bans the shorthand.
  constructor(
    transport: UploadTransport = httpTransport,
    store: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(),
  ) {
    this.transport = transport
    this.store = store
  }

  // — subscription (useSyncExternalStore) —

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getSnapshot = (): UploadItem[] => this.snapshot

  private emit() {
    this.snapshot = this.order
      .map((k) => this.entries.get(k)?.item)
      .filter((i): i is UploadItem => !!i)
    this.persist()
    for (const fn of this.listeners) fn()
  }

  private persist() {
    if (!this.store) return
    try {
      this.store.setItem(STORE_KEY, encodeManifest(this.snapshot))
    } catch {
      // A full or disabled store must never take an upload down with it.
    }
  }

  private patchItem(key: string, patch: Partial<UploadItem>) {
    const e = this.entries.get(key)
    if (!e) return
    e.item = { ...e.item, ...patch }
    this.emit()
  }

  // — public API —

  /** Read back the reload manifest and offer the still-live uploads for resume.
   *  Called once when the tray mounts; safe to call again. */
  async hydrate(): Promise<void> {
    if (this.hydrated || !this.store) return
    this.hydrated = true
    let saved
    try {
      saved = decodeManifest(this.store.getItem(STORE_KEY))
    } catch {
      return
    }
    for (const s of saved) {
      // Ask the server whether it still holds these bytes. A swept or completed
      // upload must not linger in the tray pretending it can be resumed.
      let live: StatusResult
      try {
        live = await this.transport.status(s.id)
      } catch {
        continue
      }
      if (live.offset >= live.size) continue
      const key = this.nextKey()
      this.entries.set(key, {
        item: {
          key,
          id: s.id,
          name: s.name,
          size: s.size,
          dir: s.dir,
          offset: live.offset,
          state: 'resumable',
          error: null,
          speed: null,
          eta: null,
          path: null,
          attempt: 0,
        },
        file: null,
        chunkSize: 0,
        samples: [],
        abort: { aborted: false, fns: [] },
      })
      this.order.push(key)
    }
    this.emit()
  }

  enqueue(dir: string, files: File[]): void {
    for (const file of files) {
      const key = this.nextKey()
      const oversize = file.size > MAX_FILE_BYTES
      this.entries.set(key, {
        item: {
          key,
          id: null,
          name: file.name,
          size: file.size,
          dir,
          offset: 0,
          state: oversize ? 'failed' : 'queued',
          error: oversize
            ? `“${file.name}” is over the 10 GB per-file limit.`
            : file.size === 0
              ? 'This file is empty.'
              : null,
          speed: null,
          eta: null,
          path: null,
          attempt: 0,
        },
        file,
        chunkSize: 0,
        samples: [],
        abort: { aborted: false, fns: [] },
      })
      if (!oversize && file.size === 0) {
        const e = this.entries.get(key)
        if (e) e.item = { ...e.item, state: 'failed' }
      }
      this.order.push(key)
    }
    this.emit()
    void this.pump()
  }

  /** The person re-picked a file for an upload that survived a reload. */
  resumeWith(key: string, file: File): boolean {
    const e = this.entries.get(key)
    if (!e || e.item.state !== 'resumable') return false
    if (!fileMatches(e.item, { name: file.name, size: file.size })) {
      this.patchItem(key, {
        error: `That file doesn’t match — expected “${e.item.name}” at ${e.item.size} bytes.`,
      })
      return false
    }
    e.file = file
    e.abort = { aborted: false, fns: [] }
    this.patchItem(key, { state: 'queued', error: null, attempt: 0 })
    void this.pump()
    return true
  }

  retry(key: string): void {
    const e = this.entries.get(key)
    if (!e) return
    if (!e.file) {
      this.patchItem(key, { state: 'resumable' })
      return
    }
    e.abort = { aborted: false, fns: [] }
    e.samples = []
    this.patchItem(key, { state: 'queued', error: null, attempt: 0 })
    void this.pump()
  }

  cancel(key: string): void {
    const e = this.entries.get(key)
    if (!e) return
    e.abort.aborted = true
    for (const fn of e.abort.fns) fn()
    const id = e.item.id
    this.patchItem(key, { state: 'cancelled', speed: null, eta: null })
    if (id) void this.transport.cancel(id).catch(() => {})
  }

  /** Remove a finished/failed row from the tray. */
  dismiss(key: string): void {
    this.entries.delete(key)
    this.order = this.order.filter((k) => k !== key)
    this.emit()
  }

  clearFinished(): void {
    for (const key of [...this.order]) {
      const st = this.entries.get(key)?.item.state
      if (st === 'done' || st === 'cancelled' || st === 'failed') {
        this.entries.delete(key)
        this.order = this.order.filter((k) => k !== key)
      }
    }
    this.emit()
  }

  private nextKey(): string {
    this.seq += 1
    return `u${this.seq}-${now().toString(36)}`
  }

  // — the pump —

  private async pump(): Promise<void> {
    if (this.running >= MAX_PARALLEL_FILES) return
    const next = this.order.find((k) => this.entries.get(k)?.item.state === 'queued')
    if (!next) return
    this.running += 1
    void this.run(next).finally(() => {
      this.running -= 1
      void this.pump()
    })
    // Fill the remaining slot(s) in the same tick.
    void this.pump()
  }

  private async run(key: string): Promise<void> {
    const e = this.entries.get(key)
    if (!e || !e.file) return

    for (;;) {
      if (e.abort.aborted) return
      try {
        await this.driveOnce(key)
        return
      } catch (err) {
        if (e.abort.aborted) return
        const message = err instanceof Error ? err.message : String(err)
        const status = err instanceof UploadError ? err.status : 0
        // A 4xx that is not a 409 means the request itself is wrong (too big,
        // gone, refused) — retrying identical bytes cannot fix it. 409 IS
        // retryable: it is the offset-mismatch the next attempt re-syncs. 507
        // is grouped with the 4xx despite its digit — hammering a full disk
        // five more times helps nobody, and the message already says what to do.
        const fatal = (status >= 400 && status < 500 && status !== 409) || status === 507
        const attempt = e.item.attempt + 1
        if (fatal || attempt >= MAX_ATTEMPTS) {
          this.patchItem(key, { state: 'failed', error: message, speed: null, eta: null, attempt })
          return
        }
        this.patchItem(key, { attempt, error: message, speed: null, eta: null })
        await sleep(backoffMs(attempt))
      }
    }
  }

  /** One full attempt: (re)sync the offset with the server, then stream chunks
   *  until the file is in. Throws to the retry loop above. */
  private async driveOnce(key: string): Promise<void> {
    const e = this.entries.get(key)
    if (!e || !e.file) return
    const file = e.file

    if (!e.item.id) {
      this.patchItem(key, { state: 'initializing' })
      const init = await this.transport.init({
        dir: e.item.dir,
        name: file.name,
        size: file.size,
      })
      e.chunkSize = init.chunk_size > 0 ? init.chunk_size : 0
      this.patchItem(key, { id: init.id, offset: init.offset })
    } else {
      // Resuming: the SERVER says where it is. Never assume.
      const st = await this.transport.status(e.item.id)
      this.patchItem(key, { offset: st.offset })
    }

    this.patchItem(key, { state: 'uploading' })
    e.samples = [{ t: now(), bytes: e.item.offset }]

    for (;;) {
      if (e.abort.aborted) return
      const current = this.entries.get(key)
      if (!current || !current.item.id) return
      const range = nextChunk(current.item.offset, current.item.size, e.chunkSize || undefined)
      if (!range) break
      const blob = file.slice(range.start, range.end)
      const base = range.start
      const res = await this.transport.patch(
        current.item.id,
        range.start,
        blob,
        (loaded) => this.onProgress(key, base + loaded),
        {
          get aborted() {
            return e.abort.aborted
          },
          onAbort: (fn) => e.abort.fns.push(fn),
        },
      )
      this.patchItem(key, { offset: res.offset, attempt: 0 })
      this.sample(key, res.offset)
    }

    if (e.abort.aborted) return
    // 100 % of the bytes are in; the server still has to check them. Saying so
    // is the difference between "verifying" and a bar that looks stuck.
    this.patchItem(key, { state: 'verifying', speed: null, eta: null })
    const done = await this.transport.complete(e.item.id as string)
    this.patchItem(key, { state: 'done', path: done.path, name: done.name, offset: done.size })
  }

  private onProgress(key: string, bytes: number) {
    const e = this.entries.get(key)
    if (!e || e.item.state !== 'uploading') return
    // Optimistic: these bytes are on the wire, not yet acknowledged. The
    // authoritative offset lands when the PATCH resolves, and it can only ever
    // move this number backwards by a chunk — which is the truth.
    e.item = { ...e.item, offset: Math.min(bytes, e.item.size) }
    this.sample(key, e.item.offset, false)
    this.emit()
  }

  private sample(key: string, bytes: number, emit = true) {
    const e = this.entries.get(key)
    if (!e) return
    const t = now()
    e.samples.push({ t, bytes })
    e.samples = trimWindow(e.samples, t, RATE_WINDOW_MS)
    const speed = rateFrom(e.samples)
    const eta = etaFrom(e.item.size - bytes, speed)
    e.item = { ...e.item, speed, eta }
    if (emit) this.emit()
  }
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    if (typeof localStorage === 'undefined') return null
    // Private windows throw on WRITE, not on access — probe properly.
    localStorage.setItem('supermux.uploads.probe', '1')
    localStorage.removeItem('supermux.uploads.probe')
    return localStorage
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Test seam — a manager with a fake transport and no browser storage. */
export function createUploadManager(
  transport: UploadTransport,
  store: Pick<Storage, 'getItem' | 'setItem'> | null = null,
): UploadManager {
  return new UploadManager(transport, store)
}

export type { UploadManager }

/** The app-wide singleton. Module scope, so it outlives every component that
 *  renders it and an upload keeps going while the person browses elsewhere. */
export const uploads = new UploadManager()
