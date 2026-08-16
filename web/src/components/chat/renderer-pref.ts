// The renderer PREFERENCE — three values, two scopes, one resolver (fase A5 T1).
// ─────────────────────────────────────────────────────────────────────────────
// A1/A3 kept the renderer choice in `React.useState` at each focus seam
// (`desktop-split.tsx`, and since #66 `routes/focus/mobile.tsx` too) — two
// copies of an ephemeral tap that reset on every navigation. A5 makes the
// choice a real preference: persisted per session, synced across devices, and
// resolved by ONE function so an ineligible session cannot grow a chat surface
// no matter what is stored against its name.
//
// Pure by construction: no React, no DOM, no store. The only import is the
// sibling seam module, whose `pickRenderer` already encodes the two rules A5
// must not re-derive (the undecided frame, and eligibility). Duplicating them
// here is exactly how the desktop and mobile seams would drift apart again.

import { pickRenderer, type ChatRenderer } from './seam'

/**
 * What the USER chose.
 *
 * `auto` is a real, stored value — it must be distinguishable from "happens to
 * equal the current default", because the default MOVES (Settings today, fase
 * A7 for everyone). A user who picked `auto` wants to follow; a user who picked
 * `chat` wants chat even after the default flips to terminal.
 */
export type RendererPref = 'auto' | 'chat' | 'terminal'

/**
 * What is actually MOUNTED. There is no `auto` here — a surface renders one
 * thing. Keeping the two types distinct is what stops `auto` leaking into a
 * `<RendererShell>` prop; it is the seam's `ChatRenderer`, re-exported under
 * the name the shell reads better with.
 */
export type Renderer = ChatRenderer

export interface RendererState {
  /** Global default; only ever `chat` or `terminal` (never `auto` — the buck
   *  stops here). Default `chat`: with the experiment ON, chat is the primary
   *  interface (master plan Global Constraints). */
  defaultRenderer: Renderer
  /** Per-session pins. A session at `auto` is ABSENT from the map, never stored
   *  as `'auto'` — so the map stays small and `auto` is the fixpoint. */
  overrides: Record<string, Renderer>
}

export const EMPTY_RENDERER_STATE: RendererState = {
  defaultRenderer: 'chat',
  overrides: {},
}

/** Hard cap on the pin map. An unbounded `Record<name, …>` outlives deleted
 *  sessions; a heavy user's rehydrated blob must not be able to grow forever. */
export const MAX_PINS = 200

/** The account-wide pref key. Its OWN key, deliberately not folded into the
 *  `overview_layout` blob: that one is a whole-value PUT, and last-write-wins
 *  across devices would clobber a renderer choice made on the phone (the
 *  master plan's §12.2 seen-cursor argument, applied here). */
export const SESSION_RENDERER_PREF_KEY = 'session_renderer'

/**
 * The ONE decision function.
 *
 * `null` = undecided: the sessions query has not delivered this row yet.
 * Callers must render NEITHER renderer for that frame — the focus-no-mobile-
 * flash rule A1 established (`tests/e2e/smoke/focus-no-mobile-flash.spec.ts`),
 * and the reason the terminal never mounts→attaches→unmounts on a focus load.
 *
 * The base decision is `pickRenderer(null, …)` from `seam.ts`, unchanged and
 * still unit-tested there. It answers "undecided, or ineligible, or eligible";
 * only in the eligible case does the preference get a vote. Which is the whole
 * rule in one line:
 *
 *   · `chatOn === false` ⇒ `'terminal'`, WHATEVER the pin says. A pin is a
 *     preference, not an override of eligibility; a codex session with a stale
 *     `chat` pin must not render a chat surface (`flag.ts`). The pin is KEPT,
 *     not deleted — flipping the Settings toggle back on restores the choice.
 *   · `sessionKnown === false` ⇒ `null`, byte-identical to A1's branch.
 */
export function resolveRenderer(
  st: RendererState,
  name: string,
  chatOn: boolean,
  sessionKnown: boolean,
): Renderer | null {
  // `null` for the override argument on purpose: A5 replaced the seam's
  // ephemeral tap with this module's persisted map, so the base call is the
  // pure eligibility/undecided ladder and nothing else.
  const base = pickRenderer(null, name, sessionKnown, chatOn)
  // `null` (undecided) and `'terminal'` (ineligible) are both final.
  if (base !== 'chat') return base
  return st.overrides[name] ?? st.defaultRenderer
}

/** The pref a switch should render as SELECTED (`auto` when unpinned). Note it
 *  reads the map directly and never consults eligibility: the switch shows what
 *  the user chose, even while `resolveRenderer` is overruling it. */
export function prefFor(st: RendererState, name: string): RendererPref {
  return st.overrides[name] ?? 'auto'
}

/** Write a pin. `auto` DELETES the key rather than storing the string, so the
 *  map only ever holds real divergences from the default. */
export function setPref(
  st: RendererState,
  name: string,
  p: RendererPref,
): RendererState {
  const has = name in st.overrides
  if (p === 'auto') {
    if (!has) return st
    const next = { ...st.overrides }
    delete next[name]
    return { ...st, overrides: next }
  }
  if (st.overrides[name] === p) return st
  return { ...st, overrides: { ...st.overrides, [name]: p } }
}

/** The two concrete renderers, for the `T` hotkey and the escape-hatch button:
 *  a toggle does one obvious thing, and `auto` is reachable from the switch and
 *  the menus instead. */
export function togglePref(resolved: Renderer): RendererPref {
  return resolved === 'chat' ? 'terminal' : 'chat'
}

/**
 * Drop pins for sessions that no longer exist, and hard-cap the map.
 *
 * MUST be called with the FULL sessions list, never a filtered/`hideStopped`
 * view — an archived-but-alive session that the user has merely hidden must
 * keep its pin. The cap keeps the newest `MAX_PINS` entries in insertion order,
 * which for a `Record` built by `setPref` is "least-recently pinned first".
 */
export function prune(
  st: RendererState,
  liveNames: readonly string[],
): RendererState {
  const live = new Set(liveNames)
  const keys = Object.keys(st.overrides)
  const kept = keys.filter((k) => live.has(k))
  const capped = kept.length > MAX_PINS ? kept.slice(kept.length - MAX_PINS) : kept
  if (capped.length === keys.length) return st
  const next: Record<string, Renderer> = {}
  for (const k of capped) next[k] = st.overrides[k]!
  return { ...st, overrides: next }
}

/** Cap only — no liveness information available (rehydrate, before the sessions
 *  query resolves). Split from `prune` so the rehydrate path cannot accidentally
 *  delete every pin by passing an empty list. */
export function capPins(st: RendererState): RendererState {
  const keys = Object.keys(st.overrides)
  if (keys.length <= MAX_PINS) return st
  const next: Record<string, Renderer> = {}
  for (const k of keys.slice(keys.length - MAX_PINS)) next[k] = st.overrides[k]!
  return { ...st, overrides: next }
}

// ── The wire shape for `/api/prefs/session_renderer` ─────────────────────────
// The server is a dumb key/value store (`prefs.rs`), so the shape lives here,
// next to the type it serializes, and both directions are pure and tested.

/** Parse the account-wide blob. Anything unrecognised degrades to the default
 *  rather than throwing: a pref written by a newer client must never brick an
 *  older one (404-as-unset is the same idea, one layer up). */
export function parseRendererPrefs(raw: string | null): RendererState {
  if (!raw) return EMPTY_RENDERER_STATE
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_RENDERER_STATE
  }
  if (!parsed || typeof parsed !== 'object') return EMPTY_RENDERER_STATE
  const o = parsed as { defaultRenderer?: unknown; overrides?: unknown }
  const def: Renderer = o.defaultRenderer === 'terminal' ? 'terminal' : 'chat'
  const overrides: Record<string, Renderer> = {}
  if (o.overrides && typeof o.overrides === 'object') {
    for (const [k, v] of Object.entries(o.overrides as Record<string, unknown>)) {
      if (v === 'chat' || v === 'terminal') overrides[k] = v
    }
  }
  return capPins({ defaultRenderer: def, overrides })
}

export function serializeRendererPrefs(st: RendererState): string {
  return JSON.stringify({
    defaultRenderer: st.defaultRenderer,
    overrides: st.overrides,
  })
}

/**
 * `null` for UNSET, a state for anything else.
 *
 * The distinction matters exactly once, and it is a data-loss bug when it is
 * missed: on a fresh account `GET /api/prefs/session_renderer` 404s, and if
 * that read as "an empty preference" the sync would immediately apply it over
 * whatever the user had already chosen in localStorage — pins wiped on every
 * first load against a server that has not been written to yet.
 */
export function parseRendererPrefsOrNull(raw: string | null): RendererState | null {
  if (raw == null || raw === '') return null
  return parseRendererPrefs(raw)
}
