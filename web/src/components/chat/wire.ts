/**
 * The A2 chat WebSocket protocol, as types and a pure reducer (fase A2→A3 wiring).
 * ─────────────────────────────────────────────────────────────────────────────
 * `server/src/sessions/chat/ws.rs` is the authority for every shape in this
 * file. It is deliberately re-declared here rather than inferred from a fetch:
 * the frames are the contract between two codebases that ship together, so the
 * client's reading of them belongs in a file a test can hold against the
 * server's own fixtures (`tests/unit/chat-wire.test.ts` copies frame literals
 * out of `ws.rs`'s test module — when the server's shape drifts, that test goes
 * red rather than the surface going quietly blank).
 *
 * WHAT IS PURE HERE, AND WHY. Everything: the socket, the backoff and the
 * fetch-full queue are in `chat-socket.ts`, and the React binding is
 * `use-chat-ws.ts`. The two decisions that can silently corrupt a conversation
 * — which live entry is a duplicate of the seed, and what a `resync` throws
 * away — are reduced here, where `bun test` can assert them without a socket.
 *
 * THE NO-GAP/NO-OVERLAP PROOF, client half. The server seals+pushes+broadcasts
 * under one lock and snapshots+subscribes under the same one (`store.rs`), and
 * forwards a live frame only when `seq >= high_water` while the seed carries
 * exactly `seq < high_water`. So dedupe is ARITHMETIC on `seq` — never uuid or
 * text matching — and this module keeps it that way on the client side too.
 */

/** `Kind` in `server/src/sessions/chat/model.rs`, `snake_case` on the wire. */
export type WireKind =
  | 'prompt'
  | 'assistant'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'queue'
  | 'mode'
  | 'compact_boundary'
  | 'system'
  | 'attachment'
  | 'subagent'
  | 'unknown'

/**
 * `WireEntry` (the SEALED wire type — `model.rs`). Every optional field is
 * `skip_serializing_if = "Option::is_none"` on the server, so "absent" and
 * "null" both mean the same thing and are read the same way here.
 *
 * `body` is deliberately `unknown`: its shape is kind-specific and the server
 * keeps unmodelled kinds whole rather than dropping them, so the one place
 * allowed to interpret it is `wire-entries.ts`.
 */
export interface WireEntry {
  seq: number
  uuid: string
  kind: WireKind
  ts_ms: number
  offset: number
  session_id?: string
  tool_use_id?: string
  label?: string
  ok?: boolean
  agent_id?: string
  /**
   * The source record's `isMeta` — a harness ASIDE written as a user turn.
   * Absent (skipped) on everything else, so it costs no wire bytes.
   *
   * `recall.rs::classify_user` step 8 has routed these to the system bucket
   * since A1; this plane could not, because the flag was not on it. One managed
   * slash command writes TWO user records — the `<command-name>` envelope and a
   * 6.8 KB plain prompt holding the whole command file — and without this the
   * second was drawn as the owner's own bubble.
   */
  meta?: boolean
  /** The source line was over `MAX_LINE_BYTES`; `body` is a placeholder. */
  oversize: boolean
  /** `WireEntry::seal` clipped the body at `MAX_ENTRY_BYTES`. Fetch-full
   *  (`GET /api/sessions/{name}/chat/entry/{uuid}`) resolves the rest. */
  truncated: boolean
  body: unknown
}

/** `TailState` (`tailer.rs`), flattened into `seed_done` / `state` frames. */
export type TailStateName = 'live' | 'reconnecting' | 'no_hooks' | 'stopped'

/** `TailStatus` — the state plus the monotonic re-seed epoch. */
export interface TailStatus {
  state: TailStateName
  /** Present on `reconnecting` / `stopped` only (`&'static str` server-side). */
  reason?: string
  /** `stopped` only: whether redialing can help. */
  retry?: boolean
  resync_epoch: number
}

/** server→client frames. All JSON text; nothing else is ever sent. */
export type ServerFrame =
  | { type: 'auth_ok' }
  | {
      type: 'seed'
      entries: WireEntry[]
      has_more: boolean
      next_before: string | null
    }
  | ({ type: 'seed_done'; high_water: number } & TailStatus)
  | { type: 'entry'; entry: WireEntry }
  | ({ type: 'state' } & TailStatus)
  | { type: 'resync'; reason: string }

/** client→server: the first frame, and the only one the server reads. */
export function authFrame(token: string): string {
  return JSON.stringify({ type: 'auth', token })
}

// ── parsing ──────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Structural check for one sealed entry. A frame carrying a malformed entry is
 *  dropped WHOLE rather than half-applied — a hole in the transcript with no
 *  `seq` to reason about is the one thing the arithmetic dedupe cannot heal. */
function isWireEntry(v: unknown): v is WireEntry {
  return (
    isObject(v) &&
    typeof v.seq === 'number' &&
    typeof v.uuid === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.ts_ms === 'number' &&
    typeof v.offset === 'number' &&
    typeof v.oversize === 'boolean' &&
    typeof v.truncated === 'boolean'
  )
}

function readStatus(o: Record<string, unknown>): TailStatus | null {
  const state = o.state
  if (
    state !== 'live' &&
    state !== 'reconnecting' &&
    state !== 'no_hooks' &&
    state !== 'stopped'
  ) {
    return null
  }
  const status: TailStatus = {
    state,
    resync_epoch: typeof o.resync_epoch === 'number' ? o.resync_epoch : 0,
  }
  if (typeof o.reason === 'string') status.reason = o.reason
  if (typeof o.retry === 'boolean') status.retry = o.retry
  return status
}

/**
 * One raw text frame → a typed frame, or `null` for anything this client does
 * not model.
 *
 * `null` is not an error: the server's frame set can grow (A2's own module
 * header treats an unmodelled client the same way), and a chat socket that
 * tore itself down over a frame it merely does not know yet would be a worse
 * failure than ignoring it.
 */
export function parseFrame(raw: string): ServerFrame | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(v) || typeof v.type !== 'string') return null
  switch (v.type) {
    case 'auth_ok':
      return { type: 'auth_ok' }
    case 'seed': {
      if (!Array.isArray(v.entries) || !v.entries.every(isWireEntry)) return null
      return {
        type: 'seed',
        entries: v.entries,
        has_more: v.has_more === true,
        next_before: typeof v.next_before === 'string' ? v.next_before : null,
      }
    }
    case 'seed_done': {
      const status = readStatus(v)
      if (!status || typeof v.high_water !== 'number') return null
      return { type: 'seed_done', high_water: v.high_water, ...status }
    }
    case 'entry': {
      if (!isWireEntry(v.entry)) return null
      return { type: 'entry', entry: v.entry }
    }
    case 'state': {
      const status = readStatus(v)
      return status ? { type: 'state', ...status } : null
    }
    case 'resync':
      return {
        type: 'resync',
        reason: typeof v.reason === 'string' ? v.reason : '',
      }
    default:
      return null
  }
}

// ── the reduced conversation ─────────────────────────────────────────────────

/** Everything one open socket knows, and nothing about the socket itself. */
export interface WireState {
  /** Sealed entries, OLDEST-FIRST — the order the seed arrives in (`newest-last`)
   *  and the order live frames extend. The renderer's newest-first list is
   *  derived in `wire-entries.ts`; this stays in wire order so `seq`
   *  arithmetic reads the way the server's proof does. */
  entries: readonly WireEntry[]
  /** The seed→live boundary. `null` until `seed_done`. */
  highWater: number | null
  /** True once `seed_done` landed: the transcript on screen is a complete page. */
  seeded: boolean
  status: TailStatus | null
  /** Backlog paging (`has_more` / `next_before`). Carried because the frame
   *  carries it — the scroll-back UI that consumes it is a later fase. */
  hasMore: boolean
  nextBefore: string | null
  /** Bumped by every `resync` frame, so a consumer can tell "the same
   *  conversation grew" from "this is a different conversation now". */
  resyncCount: number
}

export const EMPTY_WIRE: WireState = {
  entries: [],
  highWater: null,
  seeded: false,
  status: null,
  hasMore: false,
  nextBefore: null,
  resyncCount: 0,
}

/**
 * Apply one frame. Returns the SAME state object when nothing changed, so a
 * React binding can hand it straight to `useState` without re-rendering the
 * whole transcript on a keep-alive frame.
 *
 * The rules, in the order they matter:
 *
 *  · `seed` REPLACES the list. That is what makes `resync` correct without a
 *    blank frame in between: the server always follows a `resync` with a fresh
 *    seed immediately, so dropping the old content on the SEED (rather than on
 *    the resync notice) shows the old conversation for one round-trip instead
 *    of showing nothing.
 *  · `entry` is appended only when `seq >= high_water` AND it is newer than
 *    everything held. The server already applies the first rule; the client
 *    re-applies it because a frame that raced a re-seed would otherwise splice
 *    an entry from the previous ring onto the new one.
 *  · a frame arriving BEFORE `seed_done` (high_water unknown) is dropped: the
 *    seed it belongs behind has not been drawn yet, and the socket's own
 *    ordering guarantees it will be in that seed or in a frame after it.
 */
export function applyFrame(state: WireState, frame: ServerFrame): WireState {
  switch (frame.type) {
    case 'auth_ok':
      return state
    case 'seed':
      return {
        ...state,
        entries: frame.entries,
        seeded: false,
        hasMore: frame.has_more,
        nextBefore: frame.next_before,
      }
    case 'seed_done': {
      const { type: _t, high_water: hw, ...status } = frame
      return { ...state, highWater: hw, seeded: true, status }
    }
    case 'state': {
      const { type: _t, ...status } = frame
      return { ...state, status }
    }
    case 'resync':
      return { ...state, seeded: false, resyncCount: state.resyncCount + 1 }
    case 'entry': {
      const e = frame.entry
      if (state.highWater === null || e.seq < state.highWater) return state
      const last = state.entries[state.entries.length - 1]
      if (last && e.seq <= last.seq) return state
      return { ...state, entries: [...state.entries, e] }
    }
  }
}

/**
 * Swap a fetched-full body into the entry it belongs to (fetch-full landed).
 *
 * Identity is the uuid and nothing else: `seq`, `offset` and every other
 * header field are the SEALED ones and stay exactly as they were, because they
 * are what the dedupe arithmetic and the paging cursor are built on. Only the
 * body — the thing the cap clipped — is replaced, and `truncated` clears with
 * it so the "… clipped" marker disappears in the same render.
 *
 * A uuid that is no longer held (the ring rolled, a re-seed replaced the page)
 * returns the same state: a late fetch must never resurrect a dropped entry.
 */
export function applyFullBody(
  state: WireState,
  uuid: string,
  body: unknown,
): WireState {
  const i = state.entries.findIndex((e) => e.uuid === uuid)
  if (i < 0 || !state.entries[i].truncated) return state
  const entries = state.entries.slice()
  entries[i] = { ...entries[i], body, truncated: false }
  return { ...state, entries }
}
