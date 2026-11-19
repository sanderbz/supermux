// Resumable-upload protocol — the PURE half.
//
// Everything here is a function of its arguments: chunk planning, the sliding
// rate window, retry backoff, the reload manifest, and the sentences the tray
// renders. The stateful engine (XHR, timers, the queue) lives in `manager.ts`
// and imports these, so the arithmetic that decides WHERE the next byte goes is
// unit-testable without a network or a DOM.

/** Server-declared defaults; the init response overrides them per upload. */
export const DEFAULT_CHUNK = 16 * 1024 * 1024
/** The stated ceiling, mirrored from `server/src/files/uploads.rs`. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024

/** localStorage key for the reload manifest. Versioned: a shape change gets a
 *  new key rather than a migration for 24-hour scratch state. */
export const STORE_KEY = 'supermux.uploads.v1'

export type UploadState =
  | 'queued'
  | 'initializing'
  | 'uploading'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'
  /** Survived a page reload: the server still holds the bytes, but a browser
   *  cannot persist a `File` handle, so the person must re-pick the file. */
  | 'resumable'

export interface UploadItem {
  /** Stable client key — the identity the UI lists by, alive before the server
   *  has minted an id and still valid after a failure. */
  key: string
  /** Server upload id, once init has returned. */
  id: string | null
  name: string
  size: number
  dir: string
  /** Bytes the server has confirmed (or, mid-chunk, is confirming). */
  offset: number
  state: UploadState
  /** The SERVER's sentence when there is one — never a generic "upload failed". */
  error: string | null
  /** Bytes/s over the sliding window, or null when there is nothing to average. */
  speed: number | null
  /** Seconds remaining, or null when speed is unknown. */
  eta: number | null
  /** Absolute path, once the file has landed. */
  path: string | null
  attempt: number
}

/** One chunk's byte range. `end` is EXCLUSIVE — `File.slice`'s convention, so
 *  no ±1 ever has to be remembered at a call site. */
export interface ChunkRange {
  start: number
  end: number
}

/** The next chunk to send given where the server actually is. Returns null when
 *  the file is fully received — which is also how the loop terminates after a
 *  resume that turned out to be complete. */
export function nextChunk(
  offset: number,
  size: number,
  chunkSize: number = DEFAULT_CHUNK,
): ChunkRange | null {
  if (chunkSize <= 0) throw new RangeError('chunkSize must be positive')
  if (offset < 0 || offset > size) throw new RangeError('offset outside the file')
  if (offset >= size) return null
  return { start: offset, end: Math.min(offset + chunkSize, size) }
}

/** How many chunks a file of `size` takes. Used only for display. */
export function chunkCount(size: number, chunkSize: number = DEFAULT_CHUNK): number {
  if (size <= 0) return 0
  return Math.ceil(size / chunkSize)
}

/** Exponential backoff with full jitter, capped. A resumable upload retries by
 *  DESIGN — a network blip is the normal case, not an exception — so the delays
 *  stay short at first and only stretch out once the link is clearly down. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1))
  // Full jitter: two tabs that lost the same wifi do not retry in lockstep.
  return Math.round(base / 2 + rand() * (base / 2))
}

/** Give up after this many consecutive failures on one file. */
export const MAX_ATTEMPTS = 6

// ── the sliding rate window ─────────────────────────────────────────────────

export interface RateSample {
  t: number
  bytes: number
}

/** Window length. Long enough that one slow chunk does not make the number
 *  jump around; short enough that it reacts when the link changes. */
export const RATE_WINDOW_MS = 5000

/** Drop samples older than the window — but never below two points, because a
 *  link so slow that only one sample landed inside the window is exactly the
 *  link whose speed the person most wants to see. In that case the sample
 *  straddling the window's edge is kept as the second point. */
export function trimWindow(
  samples: RateSample[],
  now: number,
  window: number = RATE_WINDOW_MS,
): RateSample[] {
  const cut = now - window
  const kept = samples.filter((s) => s.t >= cut)
  if (kept.length >= 2) return kept
  const first = samples.findIndex((s) => s.t >= cut)
  if (first > 0) return samples.slice(first - 1)
  return samples.slice()
}

/** Bytes/s across the window, or null when there is not enough to say.
 *  Returning null (and rendering nothing) beats printing a made-up number. */
export function rateFrom(samples: RateSample[]): number | null {
  if (samples.length < 2) return null
  const first = samples[0]
  const last = samples[samples.length - 1]
  const dt = (last.t - first.t) / 1000
  const db = last.bytes - first.bytes
  if (dt <= 0 || db <= 0) return null
  return db / dt
}

/** Seconds left, or null when the speed is unknown. */
export function etaFrom(
  bytesLeft: number,
  speed: number | null,
): number | null {
  if (!speed || speed <= 0 || bytesLeft <= 0) return null
  return bytesLeft / speed
}

// ── the reload manifest ─────────────────────────────────────────────────────

/** What survives a reload. Deliberately NOT the `File`: no browser can persist
 *  a file handle, and pretending otherwise would mean silently resuming onto
 *  whatever bytes happened to be picked next. */
export interface PersistedUpload {
  id: string
  name: string
  size: number
  dir: string
  offset: number
}

export function encodeManifest(items: UploadItem[]): string {
  const live = items
    .filter((i) => i.id && (i.state === 'uploading' || i.state === 'queued' || i.state === 'initializing' || i.state === 'resumable' || i.state === 'failed'))
    .map<PersistedUpload>((i) => ({
      id: i.id as string,
      name: i.name,
      size: i.size,
      dir: i.dir,
      offset: i.offset,
    }))
  return JSON.stringify(live)
}

/** Parse defensively: this string came out of a browser store that another tab,
 *  an older bundle, or a person with devtools may have written. */
export function decodeManifest(raw: string | null): PersistedUpload[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: PersistedUpload[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (
      typeof e.id === 'string' &&
      typeof e.name === 'string' &&
      typeof e.dir === 'string' &&
      typeof e.size === 'number' &&
      typeof e.offset === 'number' &&
      e.size > 0 &&
      e.offset >= 0 &&
      e.offset <= e.size
    ) {
      out.push({ id: e.id, name: e.name, size: e.size, dir: e.dir, offset: e.offset })
    }
  }
  return out
}

/** A re-picked file may only resume an upload it actually matches. Name AND
 *  size — the pair a person can verify at a glance, and the only guard between
 *  "resume" and "append the wrong bytes to a 9 GB file". */
export function fileMatches(
  saved: Pick<PersistedUpload, 'name' | 'size'>,
  picked: { name: string; size: number },
): boolean {
  return saved.name === picked.name && saved.size === picked.size
}

// ── copy ────────────────────────────────────────────────────────────────────

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

export function formatSpeed(bytesPerSec: number | null): string {
  if (!bytesPerSec || bytesPerSec <= 0) return ''
  return `${formatBytes(bytesPerSec)}/s`
}

/** Coarse on purpose: a per-second ETA that visibly jitters reads as broken. */
export function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s left`
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} min left`
  const hours = Math.floor(mins / 60)
  const rem = mins % 60
  return rem ? `${hours}h ${rem}m left` : `${hours}h left`
}

/** 0–100, clamped. A file at 100 % that is still hashing shows `verifying`, so
 *  the bar never sits full while the UI claims to be busy. */
export function percent(offset: number, size: number): number {
  if (size <= 0) return 0
  return Math.max(0, Math.min(100, (offset / size) * 100))
}

/** The one-line summary in the tray header. */
export function summarize(items: UploadItem[]): {
  active: number
  done: number
  failed: number
  cancelled: number
  percent: number
  speed: number | null
} {
  const live = items.filter(
    (i) => i.state === 'uploading' || i.state === 'queued' || i.state === 'initializing' || i.state === 'verifying',
  )
  const total = live.reduce((s, i) => s + i.size, 0)
  const sent = live.reduce((s, i) => s + i.offset, 0)
  const speeds = live.map((i) => i.speed).filter((s): s is number => typeof s === 'number')
  return {
    active: live.length,
    done: items.filter((i) => i.state === 'done').length,
    failed: items.filter((i) => i.state === 'failed').length,
    cancelled: items.filter((i) => i.state === 'cancelled').length,
    percent: total > 0 ? percent(sent, total) : 0,
    speed: speeds.length ? speeds.reduce((a, b) => a + b, 0) : null,
  }
}

/** The tray's header sentence. Every branch reports something that is actually
 *  true of the rows below it — a tray holding one cancelled upload said
 *  "0 uploads finished" before this existed, which is a true number attached to
 *  a false claim. */
export function headline(s: ReturnType<typeof summarize>): string {
  if (s.active > 0) {
    return `Uploading ${s.active} file${s.active === 1 ? '' : 's'} · ${Math.round(s.percent)}%`
  }
  if (s.failed > 0) return `${s.failed} upload${s.failed === 1 ? '' : 's'} failed`
  if (s.done > 0) return `${s.done} upload${s.done === 1 ? '' : 's'} finished`
  if (s.cancelled > 0) {
    return `${s.cancelled} upload${s.cancelled === 1 ? '' : 's'} cancelled`
  }
  return 'Uploads'
}

/** Per-item status line. Every branch says something TRUE about that state —
 *  in particular `verifying`, which is what stops a 10 GB file from looking
 *  frozen at 100 % while the server hashes it. */
export function statusLine(item: UploadItem): string {
  switch (item.state) {
    case 'queued':
      return 'Waiting…'
    case 'initializing':
      return 'Starting…'
    case 'uploading': {
      const parts = [`${formatBytes(item.offset)} of ${formatBytes(item.size)}`]
      const speed = formatSpeed(item.speed)
      if (speed) parts.push(speed)
      const eta = formatEta(item.eta)
      if (eta) parts.push(eta)
      return parts.join(' · ')
    }
    case 'verifying':
      return 'Verifying…'
    case 'done':
      return formatBytes(item.size)
    case 'cancelled':
      return 'Cancelled'
    case 'resumable':
      return `Interrupted at ${formatBytes(item.offset)} — pick “${item.name}” again to resume`
    case 'failed':
      return item.error ?? 'Upload failed'
  }
}
