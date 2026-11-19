// The resumable-upload protocol's arithmetic and its reload manifest.
//
// These are the parts where being off by one costs someone a 9 GB file: the
// chunk range, the resume point, the rate window, and the guard that refuses to
// append a re-picked file's bytes onto an upload it doesn't match.

import { describe, expect, test } from 'bun:test'

import {
  backoffMs,
  chunkCount,
  decodeManifest,
  encodeManifest,
  etaFrom,
  fileMatches,
  formatBytes,
  formatEta,
  MAX_FILE_BYTES,
  nextChunk,
  percent,
  rateFrom,
  statusLine,
  headline,
  summarize,
  trimWindow,
  type UploadItem,
} from '@/lib/upload/protocol'

const item = (over: Partial<UploadItem> = {}): UploadItem => ({
  key: 'k1',
  id: 'abc',
  name: 'movie.mov',
  size: 1000,
  dir: '/home/me',
  offset: 0,
  state: 'uploading',
  error: null,
  speed: null,
  eta: null,
  path: null,
  attempt: 0,
  ...over,
})

describe('chunk planning', () => {
  test('the first chunk starts at zero and is one chunk long', () => {
    expect(nextChunk(0, 100, 10)).toEqual({ start: 0, end: 10 })
  })

  test('the LAST chunk is short, not padded past the end of the file', () => {
    // The bug this pins: `start + chunkSize` would ask for bytes 100..110 of a
    // 105-byte file, and the server would refuse the whole chunk.
    expect(nextChunk(100, 105, 10)).toEqual({ start: 100, end: 105 })
  })

  test('a fully received file has no next chunk — that is how the loop ends', () => {
    expect(nextChunk(105, 105, 10)).toBeNull()
  })

  test('resuming picks up at the server offset, not at a chunk boundary', () => {
    // A dead connection leaves a partial chunk on the server. The next request
    // must start where the FILE is, not where the chunk grid says.
    expect(nextChunk(37, 100, 10)).toEqual({ start: 37, end: 47 })
  })

  test('an offset past the end is a programming error, not a silent no-op', () => {
    expect(() => nextChunk(200, 100, 10)).toThrow()
    expect(() => nextChunk(-1, 100, 10)).toThrow()
    expect(() => nextChunk(0, 100, 0)).toThrow()
  })

  test('chunk count', () => {
    expect(chunkCount(0)).toBe(0)
    expect(chunkCount(100, 10)).toBe(10)
    expect(chunkCount(101, 10)).toBe(11)
  })
})

describe('backoff', () => {
  test('grows exponentially and then stops growing', () => {
    const fixed = () => 1
    expect(backoffMs(1, fixed)).toBe(1000)
    expect(backoffMs(2, fixed)).toBe(2000)
    expect(backoffMs(10, fixed)).toBe(30_000)
  })

  test('is jittered, so two tabs on the same wifi do not retry in lockstep', () => {
    expect(backoffMs(3, () => 0)).toBe(2000)
    expect(backoffMs(3, () => 1)).toBe(4000)
  })
})

describe('the rate window', () => {
  test('drops samples older than the window but keeps the straddling one', () => {
    const s = [
      { t: 0, bytes: 0 },
      { t: 1000, bytes: 100 },
      { t: 6000, bytes: 600 },
    ]
    // At t=6000 with a 5 s window the cut is 1000: t=0 falls out, and the two
    // remaining points are enough to divide.
    expect(trimWindow(s, 6000, 5000)).toEqual([
      { t: 1000, bytes: 100 },
      { t: 6000, bytes: 600 },
    ])
  })

  test('a link so slow only one sample is inside the window keeps a second one', () => {
    // Otherwise the speed would read as "unknown" on exactly the transfer whose
    // speed the person is staring at.
    const s = [
      { t: 0, bytes: 0 },
      { t: 9000, bytes: 900 },
    ]
    expect(trimWindow(s, 9000, 5000)).toEqual(s)
  })

  test('a single sample yields no speed rather than a fabricated one', () => {
    expect(rateFrom([{ t: 0, bytes: 0 }])).toBeNull()
    expect(rateFrom([])).toBeNull()
  })

  test('speed is bytes over elapsed seconds', () => {
    expect(rateFrom([{ t: 0, bytes: 0 }, { t: 2000, bytes: 2_000_000 }])).toBe(1_000_000)
  })

  test('a stalled window reports null, never zero-divided nonsense', () => {
    expect(rateFrom([{ t: 1000, bytes: 500 }, { t: 1000, bytes: 500 }])).toBeNull()
    expect(rateFrom([{ t: 0, bytes: 500 }, { t: 1000, bytes: 500 }])).toBeNull()
  })

  test('ETA is null whenever the speed is unknown', () => {
    expect(etaFrom(1000, null)).toBeNull()
    expect(etaFrom(1000, 0)).toBeNull()
    expect(etaFrom(0, 100)).toBeNull()
    expect(etaFrom(1000, 100)).toBe(10)
  })
})

describe('the reload manifest', () => {
  test('round-trips the in-flight uploads', () => {
    const raw = encodeManifest([
      item({ key: 'a', id: 'i1', offset: 512, state: 'uploading' }),
      item({ key: 'b', id: 'i2', state: 'done' }),
      item({ key: 'c', id: null, state: 'queued' }),
    ])
    const back = decodeManifest(raw)
    // Only the one the server still holds bytes for: a finished upload has
    // nothing to resume, and an un-inited one has no id to resume WITH.
    expect(back).toHaveLength(1)
    expect(back[0]).toEqual({ id: 'i1', name: 'movie.mov', size: 1000, dir: '/home/me', offset: 512 })
  })

  test('garbage in localStorage is ignored, never thrown on', () => {
    // Another tab, an older bundle, or a person with devtools wrote this.
    expect(decodeManifest(null)).toEqual([])
    expect(decodeManifest('')).toEqual([])
    expect(decodeManifest('{oops')).toEqual([])
    expect(decodeManifest('{"not":"an array"}')).toEqual([])
    expect(decodeManifest('[null, 3, "x"]')).toEqual([])
    expect(decodeManifest('[{"id":"i","name":"n","dir":"/d","size":10,"offset":99}]')).toEqual([])
    expect(decodeManifest('[{"id":"i","name":"n","dir":"/d","size":-1,"offset":0}]')).toEqual([])
  })

  test('a re-picked file may only resume an upload it actually matches', () => {
    const saved = { name: 'movie.mov', size: 1000 }
    expect(fileMatches(saved, { name: 'movie.mov', size: 1000 })).toBe(true)
    // Same name, different bytes — appending these onto the server's partial
    // file would produce a corrupt movie with a plausible name.
    expect(fileMatches(saved, { name: 'movie.mov', size: 1001 })).toBe(false)
    expect(fileMatches(saved, { name: 'movie-2.mov', size: 1000 })).toBe(false)
  })
})

describe('what the tray says', () => {
  test('verifying is its own line, so 100 % never looks frozen', () => {
    expect(statusLine(item({ state: 'verifying', offset: 1000 }))).toBe('Verifying…')
  })

  test('a failure shows the SERVER’s sentence, not a status code', () => {
    expect(
      statusLine(item({ state: 'failed', error: 'not enough free space — needs 9.0 GB, 2.0 GB free' })),
    ).toContain('not enough free space')
  })

  test('an interrupted upload explains what the person has to do', () => {
    const line = statusLine(item({ state: 'resumable', offset: 512 }))
    expect(line).toContain('pick')
    expect(line).toContain('movie.mov')
  })

  test('progress with an unknown speed omits the speed rather than printing 0', () => {
    expect(statusLine(item({ offset: 500, speed: null }))).toBe('500 B of 1000 B')
    expect(statusLine(item({ offset: 500, speed: 1024 * 1024, eta: 120 }))).toBe(
      '500 B of 1000 B · 1.0 MB/s · 2 min left',
    )
  })

  test('percent is clamped to the bar’s range', () => {
    expect(percent(0, 0)).toBe(0)
    expect(percent(50, 100)).toBe(50)
    expect(percent(150, 100)).toBe(100)
  })

  test('byte and ETA copy', () => {
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(MAX_FILE_BYTES)).toBe('10.0 GB')
    expect(formatEta(null)).toBe('')
    expect(formatEta(45)).toBe('45s left')
    expect(formatEta(3600)).toBe('1h left')
    expect(formatEta(3900)).toBe('1h 5m left')
  })

  test('the header aggregates only the live rows', () => {
    const s = summarize([
      item({ key: 'a', offset: 500, size: 1000, speed: 100 }),
      item({ key: 'b', offset: 1000, size: 1000, state: 'done' }),
      item({ key: 'c', state: 'failed' }),
    ])
    expect(s.active).toBe(1)
    expect(s.done).toBe(1)
    expect(s.failed).toBe(1)
    expect(s.percent).toBe(50)
    expect(s.speed).toBe(100)
  })

  test('the header never claims a number that isn’t about the rows shown', () => {
    // The bug this pins: a tray holding one CANCELLED upload used to read
    // "0 uploads finished" — a true number attached to a false claim.
    expect(headline(summarize([item({ state: 'cancelled' })]))).toBe('1 upload cancelled')
    expect(headline(summarize([item({ state: 'done' })]))).toBe('1 upload finished')
    expect(headline(summarize([item({ state: 'failed' })]))).toBe('1 upload failed')
    expect(headline(summarize([item({ offset: 250, size: 1000 })]))).toBe(
      'Uploading 1 file · 25%',
    )
    expect(headline(summarize([]))).toBe('Uploads')
  })
})
