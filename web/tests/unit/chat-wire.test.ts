/**
 * The A2 chat WebSocket, as the client reads it (fase A2→A3 wiring).
 * ─────────────────────────────────────────────────────────────────────────────
 * Two things are pinned here, and they fail for two different reasons:
 *
 *   1. THE FRAME SHAPES. Every literal in `FRAMES` below is the JSON
 *      `server/src/sessions/chat/ws.rs` actually writes, field for field —
 *      `WireEntry`'s sealed carrier (`model.rs`), the flattened `TailStatus`
 *      (`tailer.rs`, `#[serde(tag = "state", rename_all = "snake_case")]` +
 *      `resync_epoch`), and the four wrappers `push_seed` / `status_frame` /
 *      the live path build. If the server renames a field or changes a tag,
 *      this file goes red — which is the entire point of writing them out
 *      rather than deriving them from a type.
 *   2. THE DEDUPE. The seed carries exactly `seq < high_water` and the live
 *      path forwards exactly `seq >= high_water` (`classify_live`). The client
 *      re-applies that arithmetic, so a frame that races a re-seed cannot
 *      splice the previous ring onto the new one.
 *
 * And, below them, the adapter: the A1 display shape the whole A3/A4 stack is
 * written against, rebuilt out of A2 blocks.
 */
import { describe, expect, test } from 'bun:test'

import {
  applyFrame,
  applyFullBody,
  authFrame,
  EMPTY_WIRE,
  parseFrame,
  type ServerFrame,
  type WireEntry,
  type WireState,
} from '../../src/components/chat/wire'
import {
  classifyPrompt,
  sanitiseText,
  toChatEntries,
  toolLine,
  truncatedUuids,
} from '../../src/components/chat/wire-entries'

/* ── the server's frames, verbatim ───────────────────────────────────────── */

/** `WireEntry::seal`'s output for a plain assistant block — the shape every
 *  path (seed page, live `entry`, history page) puts on the wire. The absent
 *  optionals are absent because the server skips `None` (`model.rs`). */
const ENTRY_JSON = {
  seq: 7,
  uuid: 'u7',
  kind: 'assistant',
  ts_ms: 1_767_225_600_000,
  offset: 4_096,
  session_id: 'conv-a',
  oversize: false,
  truncated: false,
  body: { text: 'hi' },
}

const FRAMES = {
  auth_ok: '{"type":"auth_ok"}',
  seed: JSON.stringify({
    type: 'seed',
    entries: [ENTRY_JSON],
    has_more: true,
    next_before: 'conv-a:4096',
  }),
  // `status_frame("seed_done", status, [("high_water", …)])`: the flattened
  // TailStatus, then `type`, then the extra.
  seed_done: '{"state":"live","resync_epoch":0,"type":"seed_done","high_water":8}',
  entry: JSON.stringify({
    type: 'entry',
    entry: { ...ENTRY_JSON, seq: 8, uuid: 'u8', offset: 4_200 },
  }),
  state_reconnecting:
    '{"state":"reconnecting","reason":"no transcript for the tracked conversation","resync_epoch":0,"type":"state"}',
  state_no_hooks: '{"state":"no_hooks","resync_epoch":0,"type":"state"}',
  state_stopped:
    '{"state":"stopped","reason":"chat tail idle","retry":true,"resync_epoch":2,"type":"state"}',
  resync: '{"type":"resync","reason":"lagged"}',
}

describe('the wire’s frame shapes', () => {
  test('every server frame parses into its typed form', () => {
    expect(parseFrame(FRAMES.auth_ok)).toEqual({ type: 'auth_ok' })

    const seed = parseFrame(FRAMES.seed)
    expect(seed?.type).toBe('seed')
    if (seed?.type !== 'seed') throw new Error('unreachable')
    expect(seed.entries).toHaveLength(1)
    expect(seed.entries[0]).toMatchObject({
      seq: 7,
      uuid: 'u7',
      kind: 'assistant',
      ts_ms: 1_767_225_600_000,
      offset: 4_096,
      session_id: 'conv-a',
      oversize: false,
      truncated: false,
    })
    expect(seed.has_more).toBe(true)
    expect(seed.next_before).toBe('conv-a:4096')

    expect(parseFrame(FRAMES.seed_done)).toEqual({
      type: 'seed_done',
      high_water: 8,
      state: 'live',
      resync_epoch: 0,
    })

    const live = parseFrame(FRAMES.entry)
    expect(live?.type).toBe('entry')
    if (live?.type !== 'entry') throw new Error('unreachable')
    expect(live.entry.seq).toBe(8)

    // The three tail states a client must tell apart, plus the reason strings
    // the server actually sends.
    expect(parseFrame(FRAMES.state_reconnecting)).toEqual({
      type: 'state',
      state: 'reconnecting',
      reason: 'no transcript for the tracked conversation',
      resync_epoch: 0,
    })
    expect(parseFrame(FRAMES.state_no_hooks)).toEqual({
      type: 'state',
      state: 'no_hooks',
      resync_epoch: 0,
    })
    expect(parseFrame(FRAMES.state_stopped)).toEqual({
      type: 'state',
      state: 'stopped',
      reason: 'chat tail idle',
      retry: true,
      resync_epoch: 2,
    })
    expect(parseFrame(FRAMES.resync)).toEqual({ type: 'resync', reason: 'lagged' })
  })

  test('a frame this client does not model is ignored, never fatal', () => {
    // A2's own rule in the other direction: the server ignores frames it does
    // not know rather than closing the socket. A future `history` or `receipt`
    // frame must not take the transcript down with it.
    expect(parseFrame('{"type":"something-new","x":1}')).toBeNull()
    expect(parseFrame('not json')).toBeNull()
    expect(parseFrame('[]')).toBeNull()
    // …but a KNOWN frame carrying a malformed entry is dropped whole: half of
    // a seed page is a hole no `seq` arithmetic can heal.
    expect(parseFrame('{"type":"seed","entries":[{"uuid":"x"}],"has_more":false}')).toBeNull()
    expect(parseFrame('{"type":"entry","entry":{"uuid":"x"}}')).toBeNull()
    expect(parseFrame('{"type":"seed_done","state":"live","resync_epoch":0}')).toBeNull()
    expect(parseFrame('{"type":"state","state":"whatever","resync_epoch":0}')).toBeNull()
  })

  test('the auth frame is the terminal socket’s, byte for byte', () => {
    // `verify_auth_frame` is shared between the two sockets — the chat plane
    // must not invent a second handshake.
    expect(authFrame('t0k3n')).toBe('{"type":"auth","token":"t0k3n"}')
  })
})

/* ── the reducer ─────────────────────────────────────────────────────────── */

function wire(seq: number, uuid: string, text = 'x'): WireEntry {
  return {
    seq,
    uuid,
    kind: 'assistant',
    ts_ms: seq * 1000,
    offset: seq * 100,
    oversize: false,
    truncated: false,
    body: { text },
  }
}

function feed(state: WireState, ...frames: ServerFrame[]): WireState {
  return frames.reduce(applyFrame, state)
}

const seedOf = (entries: WireEntry[]): ServerFrame => ({
  type: 'seed',
  entries,
  has_more: false,
  next_before: null,
})
const doneAt = (high: number): ServerFrame => ({
  type: 'seed_done',
  high_water: high,
  state: 'live',
  resync_epoch: 0,
})

describe('seed → live, with no gap and no overlap', () => {
  test('the seed is the page, and live frames extend it', () => {
    const s = feed(
      EMPTY_WIRE,
      seedOf([wire(5, 'a'), wire(6, 'b')]),
      doneAt(7),
      { type: 'entry', entry: wire(7, 'c') },
      { type: 'entry', entry: wire(8, 'd') },
    )
    expect(s.entries.map((e) => e.uuid)).toEqual(['a', 'b', 'c', 'd'])
    expect(s.seeded).toBe(true)
    expect(s.highWater).toBe(7)
    expect(s.status).toEqual({ state: 'live', resync_epoch: 0 })
  })

  test('an entry below the high water is already on screen — dropped', () => {
    const s = feed(EMPTY_WIRE, seedOf([wire(5, 'a'), wire(6, 'b')]), doneAt(7))
    // The server does not send this; the client drops it anyway, because a
    // frame that raced a re-seed is exactly the one that would duplicate.
    const same = applyFrame(s, { type: 'entry', entry: wire(6, 'b') })
    expect(same).toBe(s)
    // …and so is one that is not newer than what we hold.
    const s2 = applyFrame(s, { type: 'entry', entry: wire(7, 'c') })
    expect(applyFrame(s2, { type: 'entry', entry: wire(7, 'c-again') })).toBe(s2)
  })

  test('a live frame before seed_done is dropped: the boundary is unknown', () => {
    const s = feed(EMPTY_WIRE, seedOf([wire(5, 'a')]))
    expect(applyFrame(s, { type: 'entry', entry: wire(9, 'z') }).entries).toHaveLength(1)
  })

  test('resync + the seed that follows REPLACE the conversation', () => {
    const before = feed(EMPTY_WIRE, seedOf([wire(5, 'a'), wire(6, 'b')]), doneAt(7))
    const after = feed(
      before,
      { type: 'resync', reason: 'conversation changed' },
      seedOf([wire(0, 'fresh')]),
      doneAt(1),
    )
    expect(after.entries.map((e) => e.uuid)).toEqual(['fresh'])
    expect(after.resyncCount).toBe(1)
    // The old high water is gone with the old ring.
    expect(after.highWater).toBe(1)
  })

  test('a status frame does not disturb the transcript', () => {
    const s = feed(EMPTY_WIRE, seedOf([wire(5, 'a')]), doneAt(6))
    const next = applyFrame(s, { type: 'state', state: 'no_hooks', resync_epoch: 0 })
    expect(next.entries).toBe(s.entries)
    expect(next.status?.state).toBe('no_hooks')
  })
})

/* ── fetch-full ──────────────────────────────────────────────────────────── */

describe('the truncated swap', () => {
  const clipped: WireEntry = { ...wire(5, 'big'), truncated: true, body: { text: 'aaa' } }

  test('the full body replaces the clipped one, in place', () => {
    const s = feed(EMPTY_WIRE, seedOf([wire(4, 'a'), clipped]), doneAt(6))
    const next = applyFullBody(s, 'big', { text: 'the whole thing' })
    expect(next.entries[1].truncated).toBe(false)
    expect(next.entries[1].body).toEqual({ text: 'the whole thing' })
    // The sealed header is untouched: `seq` is what the dedupe is built on and
    // `offset` is what the paging cursor is built on.
    expect(next.entries[1].seq).toBe(5)
    expect(next.entries[1].offset).toBe(clipped.offset)
    expect(next.entries[0]).toBe(s.entries[0])
  })

  test('a fetch that lands after the entry is gone changes nothing', () => {
    const s = feed(EMPTY_WIRE, seedOf([wire(4, 'a')]), doneAt(5))
    expect(applyFullBody(s, 'big', { text: 'late' })).toBe(s)
    // …and an entry that is no longer truncated is never re-swapped.
    const swapped = applyFullBody(
      feed(EMPTY_WIRE, seedOf([clipped]), doneAt(6)),
      'big',
      { text: 'full' },
    )
    expect(applyFullBody(swapped, 'big', { text: 'again' })).toBe(swapped)
  })

  test('only entries the renderer SHOWS, and only the newest few, are fetched', () => {
    const many: WireEntry[] = []
    for (let i = 0; i < 30; i++) {
      many.push({ ...wire(i, `u${i}`), truncated: true })
    }
    // A clipped thinking block is never drawn, so fetching it would be a
    // whole-file scan for nothing.
    many.push({ ...wire(30, 'think'), kind: 'thinking', truncated: true })
    // Neither is a subagent turn (the A1 calm view hides them).
    many.push({ ...wire(31, 'sub'), truncated: true, agent_id: 'x1' })
    const uuids = truncatedUuids(many, 12)
    expect(uuids).not.toContain('think')
    expect(uuids).not.toContain('sub')
    expect(uuids).toHaveLength(12)
    expect(uuids[0]).toBe('u29')
  })
})

/* ── the adapter: A2 blocks → the frozen A1 display shape ────────────────── */

function block(over: Partial<WireEntry> & { uuid: string; kind: WireEntry['kind'] }): WireEntry {
  return {
    seq: 0,
    ts_ms: 1_000,
    offset: 0,
    oversize: false,
    truncated: false,
    body: null,
    ...over,
  }
}

describe('the adapter', () => {
  test('a tool_result folds into the receipt it answers, never its own row', () => {
    const entries = toChatEntries([
      block({
        uuid: 't1',
        kind: 'tool_use',
        label: 'Bash',
        tool_use_id: 'toolu_1',
        body: { input: { command: 'npm test' } },
      }),
      block({
        uuid: 'r1',
        kind: 'tool_result',
        tool_use_id: 'toolu_1',
        ok: false,
        body: { content: 'FAIL src/x.test.ts' },
      }),
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      uuid: 't1',
      kind: 'tool_use',
      label: 'Bash',
      text: 'Bash npm test',
      reply: 'FAIL src/x.test.ts',
      ok: false,
    })
  })

  test('a tool_result whose call is off the page is dropped, not orphaned', () => {
    const entries = toChatEntries([
      block({ uuid: 'r1', kind: 'tool_result', tool_use_id: 'gone', body: { content: 'x' } }),
    ])
    expect(entries).toEqual([])
  })

  test('user turns are classified by their harness wrapper', () => {
    const entries = toChatEntries([
      block({ uuid: 'p1', kind: 'prompt', body: { text: 'ship it' } }),
      block({
        uuid: 'p2',
        kind: 'prompt',
        body: { text: '<command-name>/model</command-name><command-args>opus</command-args>' },
      }),
      block({
        uuid: 'p3',
        kind: 'prompt',
        body: {
          text: '<teammate-message teammate_id="release-train">branch is ready</teammate-message>',
        },
      }),
      // Harness noise: a user-ROLE line nobody typed. It must never render as
      // something the human said.
      block({
        uuid: 'p4',
        kind: 'prompt',
        body: { text: '<system-reminder>your todo list is empty</system-reminder>' },
      }),
    ])
    expect(entries.map((e) => [e.kind, e.text, e.label])).toEqual([
      ['teammate', 'branch is ready', 'release-train'],
      ['command', '/model opus', '/model'],
      ['prompt', 'ship it', undefined],
    ])
  })

  test('the calm view: everything A1 hid stays hidden', () => {
    const entries = toChatEntries([
      block({ uuid: 'th', kind: 'thinking', body: { text: 'hmm' } }),
      block({ uuid: 'at', kind: 'attachment', label: 'image', body: { image: true } }),
      block({ uuid: 'sy', kind: 'system', label: 'compact', body: { content: 'compacted' } }),
      block({ uuid: 'qu', kind: 'queue', body: null }),
      block({ uuid: 'un', kind: 'unknown', label: 'ai-title', body: {} }),
      block({ uuid: 'sub', kind: 'assistant', agent_id: 'x1', body: { text: 'subagent prose' } }),
      block({ uuid: 'a1', kind: 'assistant', body: { text: 'the answer' } }),
    ])
    expect(entries.map((e) => e.uuid)).toEqual(['a1'])
  })

  test('newest-first, in SECONDS — the contract every A4 comparison reads', () => {
    const entries = toChatEntries([
      block({ uuid: 'old', kind: 'assistant', ts_ms: 1_000, body: { text: 'first' } }),
      block({ uuid: 'new', kind: 'assistant', ts_ms: 2_900, body: { text: 'second' } }),
    ])
    expect(entries.map((e) => e.uuid)).toEqual(['new', 'old'])
    // Floored, like `parse_ts` — the supersede cutoff rounds the floored
    // second back UP, and a millisecond stamp here would break that.
    expect(entries.map((e) => e.ts)).toEqual([2, 1])
  })

  test('the clip flag survives, so the “… clipped” marker can', () => {
    const entries = toChatEntries([
      block({ uuid: 'a', kind: 'assistant', truncated: true, body: { text: 'long…' } }),
    ])
    expect(entries[0].truncated).toBe(true)
  })

  test('an assistant block with no prose is a tool call, not a blank bubble', () => {
    expect(toChatEntries([block({ uuid: 'a', kind: 'assistant', body: { text: '' } })])).toEqual([])
  })

  test('tool lines and results are sanitised and clipped like the server did', () => {
    expect(toolLine('Read', { file_path: '/opt/x.ts' })).toBe('Read /opt/x.ts')
    expect(toolLine('Read', { unknown: 'x' })).toBe('Read')
    expect(toolLine('Grep', { pattern: 'a'.repeat(200) })).toHaveLength('Grep '.length + 120)
    expect(sanitiseText('\u001b[31mred\u001b[0m')).toBe('red')
    expect(sanitiseText('keeps\nnewlines\tand tabs')).toBe('keeps\nnewlines\tand tabs')
  })

  test('classification never swallows prose that merely looks like markup', () => {
    expect(classifyPrompt('<3 this').kind).toBe('prompt')
    expect(classifyPrompt('a < b and c > d').kind).toBe('prompt')
    expect(classifyPrompt('[Image: screenshot.png]').kind).toBe('image')
    expect(classifyPrompt('<task-notification><summary>ran the suite</summary></task-notification>')).toMatchObject(
      { kind: 'notification', text: 'ran the suite' },
    )
  })
})
