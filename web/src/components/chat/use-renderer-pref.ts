// React binding for the fase-A5 renderer preference.
//
// Three thin selectors over `ui-store`, so no surface ever reaches into the
// store shape directly and `renderer-pref.ts` stays the only place the decision
// is spelled out. Cross-device sync is a separate concern
// (`hooks/use-renderer-prefs-sync.ts`, mounted once in `App.tsx`).

import * as React from 'react'

import { useUI } from '@/stores/ui-store'

import { useChatRenderer } from './use-chat-renderer'
import type { ChatEligibleSession } from './flag'

import {
  prefFor,
  resolveRenderer,
  togglePref,
  type Renderer,
  type RendererPref,
  type RendererState,
} from './renderer-pref'

/** The whole preference state, memoised so it is a stable object identity for
 *  as long as neither half changes (the pure functions take it by value). */
export function useRendererState(): RendererState {
  const defaultRenderer = useUI((s) => s.defaultRenderer)
  const overrides = useUI((s) => s.rendererOverrides)
  return React.useMemo(
    () => ({ defaultRenderer, overrides }),
    [defaultRenderer, overrides],
  )
}

export interface UseRendererResult {
  /** What to MOUNT: `null` = undecided, render neither renderer this frame. */
  resolved: Renderer | null
  /** What the switch shows as selected (`auto` when unpinned). */
  pref: RendererPref
  /** Write a pin (or clear it, with `auto`). */
  setPref: (p: RendererPref) => void
  /** The `T` hotkey / escape-hatch move: flip between the two CONCRETE
   *  renderers. Never selects `auto` — a toggle does one obvious thing. */
  toggle: () => void
}

/**
 * The whole preference, resolved for ONE session.
 *
 * `chatOn` is the caller's `useChatRenderer(...)` result (settings toggle AND
 * kill-switch AND eligibility) and `sessionKnown` is "the sessions query has
 * delivered THIS row" — both passed in rather than re-derived here, because the
 * mobile route synthesizes a placeholder row and only it knows the difference.
 */
export function useRenderer(
  name: string,
  chatOn: boolean,
  sessionKnown: boolean,
): UseRendererResult {
  const st = useRendererState()
  const write = useUI((s) => s.setRendererPref)

  const resolved = resolveRenderer(st, name, chatOn, sessionKnown)
  const pref = prefFor(st, name)

  const setPref = React.useCallback(
    (p: RendererPref) => write(name, p),
    [write, name],
  )
  const toggle = React.useCallback(() => {
    // Read the RESOLVED renderer, not the pref: from `auto` the user means
    // "away from what I am looking at", which is only knowable after resolution.
    if (!resolved) return
    write(name, togglePref(resolved))
  }, [write, name, resolved])

  return { resolved, pref, setPref, toggle }
}

/**
 * The resolved renderer for a session on a NON-focus surface (the overview
 * tiles, the quick-peek).
 *
 * There is no team-lead argument any more: a lead is a first-class chat bot
 * (TEAMS-in-Bot-mode Phase 2a — see `flag.ts`), so a tile decides purely on the
 * session in front of it.
 *
 * `sessionKnown` is `true` by construction: a tile only exists because its row
 * does. The undecided frame is a focus-route concern.
 */
export function useSessionRenderer(
  s: (ChatEligibleSession & { name: string }) | null,
): Renderer | null {
  const chatOn = useChatRenderer(s)
  const st = useRendererState()
  return s ? resolveRenderer(st, s.name, chatOn, true) : null
}
