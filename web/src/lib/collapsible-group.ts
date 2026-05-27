// collapsible-group — shared per-group collapse primitive.
//
// THE PROBLEM. The focus-mode session strip's left sidebar has a beloved
// per-group collapse affordance (chevron left of the title, click to expand/
// collapse, state persisted across reloads). The overview's custom-group view
// needs the SAME affordance — the user explicitly asked for the same pattern
// on the overview: "we have it in the focus terminal page's left sidepanel
// too — that works really well — please make it robust, clean, DRY".
//
// THE SHAPE. A tiny localStorage-backed boolean per (namespace, groupId), plus
// a small React hook that exposes (isCollapsed, setCollapsed) with the same
// hydrate-on-demand pattern the focus strip uses. The focus-strip continues
// to use its OWN namespace (`supermux:focus-strip:collapsed:<id>`) so the
// overview's new collapse state cannot collide and we don't have to touch
// the focus-mode hook (the user warned: focus is "finally stable" — don't
// regress it). When the focus-strip hook is ready for unification, it can
// adopt this primitive with no behaviour change (same key shape, same
// "default expanded, opt-in collapse" contract).
//
// LOCALSTORAGE KEYS.
//   • supermux:overview:collapsed:<groupId>     — the new overview namespace.
//   • supermux:focus-strip:collapsed:<groupId>  — owned by focus-strip-layout.ts.
//
// SSR-SAFE. All reads default to expanded (false) when window is undefined or
// localStorage throws (private mode / quota). Writes are best-effort.

import * as React from 'react'

/** Per-surface namespace prefix. Add new surfaces here when adopting this
 *  primitive. Mirrors the existing focus-strip layout convention. */
export type CollapsibleNamespace = 'overview' | 'focus-strip'

const NAMESPACE_PREFIX: Record<CollapsibleNamespace, string> = {
  overview: 'supermux:overview:collapsed:',
  'focus-strip': 'supermux:focus-strip:collapsed:',
}

/** Build the localStorage key for a given (namespace, groupId). Exported for
 *  tests + the focus-strip-layout shim that may eventually delegate here. */
export function collapsibleKey(
  namespace: CollapsibleNamespace,
  groupId: string,
): string {
  return `${NAMESPACE_PREFIX[namespace]}${groupId}`
}

/** Default = expanded. Collapse is always opt-in (matches focus-strip). */
export function readCollapsed(
  namespace: CollapsibleNamespace,
  groupId: string,
): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = window.localStorage.getItem(collapsibleKey(namespace, groupId))
    return raw === '1'
  } catch {
    return false
  }
}

/** Best-effort write — private-mode / quota failures are swallowed. */
export function writeCollapsed(
  namespace: CollapsibleNamespace,
  groupId: string,
  collapsed: boolean,
): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      collapsibleKey(namespace, groupId),
      collapsed ? '1' : '0',
    )
  } catch {
    /* private mode / quota — non-fatal */
  }
}

/** Drop the persisted row (used when a group is deleted so dead rows don't
 *  accumulate forever — same hygiene `removeGroupSortMode` provides for
 *  per-group sort prefs). */
export function removeCollapsed(
  namespace: CollapsibleNamespace,
  groupId: string,
): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(collapsibleKey(namespace, groupId))
  } catch {
    /* non-fatal */
  }
}

export interface UseCollapsibleGroupsResult {
  /** Read the collapse state for `groupId`. Hydrates from localStorage on
   *  first ask and caches it in component state. */
  isCollapsed: (groupId: string) => boolean
  /** Set + persist the collapse state. */
  setCollapsed: (groupId: string, collapsed: boolean) => void
}

/** Per-group collapse state, scoped to a surface's namespace. Mirrors the
 *  hydrate-on-demand pattern in `useGroupedStrip` (focus mode) so behaviour is
 *  identical across surfaces — first read pulls from localStorage via a
 *  microtask (no state writes during render), subsequent reads are O(1) from
 *  the in-memory map. */
export function useCollapsibleGroups(
  namespace: CollapsibleNamespace,
): UseCollapsibleGroupsResult {
  const [map, setMap] = React.useState<Map<string, boolean>>(() => new Map())

  const isCollapsed = React.useCallback(
    (groupId: string): boolean => {
      const fromState = map.get(groupId)
      if (fromState !== undefined) return fromState
      const fromLs = readCollapsed(namespace, groupId)
      // Don't synchronously setState during render — defer via microtask so a
      // subsequent render picks up the hydrated value cleanly without
      // tripping React 19's "no state writes during render" rule.
      if (fromLs) {
        queueMicrotask(() => {
          setMap((prev) => {
            if (prev.has(groupId)) return prev
            const next = new Map(prev)
            next.set(groupId, fromLs)
            return next
          })
        })
      }
      return fromLs
    },
    [map, namespace],
  )

  const setCollapsed = React.useCallback(
    (groupId: string, collapsed: boolean) => {
      setMap((prev) => {
        const next = new Map(prev)
        next.set(groupId, collapsed)
        return next
      })
      writeCollapsed(namespace, groupId, collapsed)
    },
    [namespace],
  )

  return { isCollapsed, setCollapsed }
}
