/* eslint-disable react-hooks/refs --
 * dnd-kit's `useSortable` returns `setNodeRef`, `attributes`, `listeners`,
 * `transform`, `transition`, `isDragging` as a stable object that the canonical
 * pattern reads + spreads during render (see dnd-kit docs). The new
 * `react-hooks/refs` rule mis-classifies these as ref-during-render reads;
 * the values are NOT React refs and are safe to read in render. File-level
 * disable keeps the dnd-kit binding code readable. */
// GroupGrid — the custom-mode body of the Overview (feat-group-ux 2026 spec).
//
// Owns:
//   • Group layout (one section per group + the implicit "Ungrouped" bucket).
//   • Per-group sort mode (read from localStorage; applied per section).
//   • Drag-and-drop (groups reorder by ROW; tiles drag between groups +
//     within Custom-sort groups).
//   • Drop-intent indication that DEPENDS ON destination group's sort mode:
//       Smart-sort dest  → colored outline + tinted bg on the container,
//                          floating cursor caption "Drop in <group> —
//                          sorted by Smart." NO insertion line inside.
//       Custom-sort dest → short inter-tile insertion line at the precise
//                          drop slot; the layout reflows via dnd-kit's
//                          built-in CSS-transform animation, retimed from
//                          its ~200ms default to 100ms ease-out (S11). The
//                          duration source-of-truth is `tweens.reflow` in
//                          @/lib/springs; sortable.transition is overridden
//                          per-tile (see SortableTileSlot).
//   • Group reorder drop indicator → FULL-grid-width 2 px horizontal line
//     with an 8 px terminal dot on the left margin (Atlassian "line indicator"
//     spec). Width = 100% of the grid, NOT one column — the visual articulation
//     of "groups reorder by row; columns don't matter."
//   • DragOverlay rendered OUTSIDE the grid container so the floating preview
//     tracks the cursor and is NOT clipped by the columns.
//   • Hover-gap "+ Add group here" affordance between rows (desktop only).
//   • Auto-scroll near the viewport edge (dnd-kit's built-in autoScroll).
//   • Keyboard a11y: pick up with Space/Enter, navigate, drop with Enter,
//     cancel with Escape. dnd-kit's Announcements + an aria-live region
//     announce every transition.
//   • Visual-critic hooks: stable `data-vr-*` attributes the orchestrator's
//     Playwright trace asserts each of the 10 named drag states against.
//
// Non-goals: this component does NOT own search/filter — the parent does.
// It receives the already-filtered session list + the persisted custom order.

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Plus, MoveRight, Square, Archive, Info, ChevronRight } from 'lucide-react'

import { springs, tweens } from '@/lib/springs'
import {
  removeCollapsed,
  useCollapsibleGroups,
} from '@/lib/collapsible-group'
import { useSessionActions } from '@/hooks/use-session-actions'
import { SessionInfoPanel } from '@/components/focus-mode/session-info-panel'
import { useNavigateMorph } from '@/components/view-transitions/morph'
import {
  bucketSessionsByLayout,
  defaultGroupSortMode,
  hasImplicitUngrouped,
  readGroupSortMode,
  removeGroupSortMode,
  sortSessionsByMode,
  UNGROUPED_GROUP_ID,
  writeGroupSortMode,
  type GroupSortMode,
  type LayoutItem,
} from '@/lib/overview-layout'
import type { ApiSession } from '@/lib/api'
import { GROUP_SORT_LABEL } from '@/lib/overview-layout'
import { useToast } from '@/components/ui/use-toast'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { GroupHeader } from './group-header'
import { SessionTile } from './tile'
import { SessionRow } from './session-row'
import type { OverviewSize } from '@/lib/overview-size'
import type { TileSession } from './types'

/** Duration of the post-drop "flash" highlight on the just-dropped tile.
 *  Spec §4 (Atlassian motion language) calls for a brief background-color
 *  flash so the eye locks onto the landing. 700ms ease-out. Skipped under
 *  `useReducedMotion`. */
const DROP_FLASH_MS = 700

// ── Public types ─────────────────────────────────────────────────────────────

export interface GroupGridProps {
  /** Reconciled custom-layout list (live + persisted, dead sessions pruned). */
  layoutItems: ReadonlyArray<LayoutItem>
  /** Live, search-filtered sessions. The grid only renders sessions present
   *  in this set (so search continues to work in custom mode). */
  filteredSessions: ReadonlyArray<ApiSession>
  /** Persist a new ordered LayoutItem[] (sessions + groups in display order). */
  onLayoutChange: (next: LayoutItem[]) => void
  /** Density tier — passed through to each tile. */
  sizeTier: OverviewSize
  /** Tailwind grid class for the active density (parent-computed; one literal
   *  per tier so JIT compiles them all up front). */
  tileGridClass: string
  /** Tile vs list view — controls which child component the grid renders. */
  viewMode: 'tile' | 'list'
  /** Click handler so the hover-gap & header "+ Add group here" can hand a
   *  position back to the parent's AddGroupInput flow. The parent owns the
   *  inline-input UX (modal-free, styled), so the grid never reaches for
   *  window.prompt. `atIndex` is the LayoutItem[] index at which to insert the
   *  new group (so the first call from "above row 0" produces index 0). */
  onRequestNewGroupAt: (atIndex: number) => void
  /** Tour anchor on the first tile (preserves the existing onboarding tour). */
  tourFirstTileId?: string
  /** The gap index where an inline AddGroupInput should render (replaces the
   *  hover-gap chip at that position). `Number.MAX_SAFE_INTEGER` means "after
   *  the last section". Null/undefined = no inline input active. */
  addingGroupAt?: number | null
  /** Render-prop: supplied by Overview; returns the `<AddGroupInput>` element
   *  to embed at the active gap. GroupGrid just decides WHERE to place it. */
  renderInlineAddGroupInput?: (at: number) => React.ReactNode
}

/** A unit shown by the renderer. `group` items are section headers; `session`
 *  items are individual tiles. */
type Section = {
  groupId: string
  groupName: string
  // null for the implicit "Ungrouped" bucket so the renderer can suppress the
  // header chrome on it (no rename, no drag, no kebab — system bucket).
  isImplicit: boolean
  layoutIndex: number // index of this group's header in the LayoutItem list (-1 for implicit)
  sortMode: GroupSortMode
  sessions: ApiSession[]
}

// Stable id helpers — used everywhere we hand an id to dnd-kit.
function groupDragId(id: string): string {
  return `group:${id}`
}
function sessionDragId(name: string): string {
  return `session:${name}`
}
function groupDropId(id: string): string {
  return `group-body:${id}`
}

// ── The hook that turns layout + filtered sessions + group-sort-prefs into
//    rendered sections. Memoized so it doesn't churn every keystroke. ──

function buildSections(
  layoutItems: ReadonlyArray<LayoutItem>,
  filteredSessions: ReadonlyArray<ApiSession>,
  groupSortModes: ReadonlyMap<string, GroupSortMode>,
): Section[] {
  // Pass 1 — walk the layout via the shared kernel. `bucketSessionsByLayout`
  // always returns the implicit Ungrouped bucket at position 0 (we drop it
  // when empty, matching today's behaviour where the implicit bucket only
  // exists if a session floated above the first group header). Per-section
  // enrichment (sortMode + layoutIndex) is overview-specific and stays here.
  const rawBuckets = bucketSessionsByLayout(layoutItems, filteredSessions)
  const headerIndex = new Map<string, number>()
  for (let i = 0; i < layoutItems.length; i++) {
    const it = layoutItems[i]
    if (it.type === 'group') headerIndex.set(it.id, i)
  }
  const sections: Section[] = rawBuckets
    .filter((b) => !b.isImplicit || b.sessions.length > 0)
    .map((b) =>
      b.isImplicit
        ? {
            groupId: UNGROUPED_GROUP_ID,
            groupName: 'Ungrouped',
            isImplicit: true,
            layoutIndex: -1,
            sortMode:
              groupSortModes.get(UNGROUPED_GROUP_ID) ??
              defaultGroupSortMode(UNGROUPED_GROUP_ID),
            sessions: b.sessions,
          }
        : {
            groupId: b.groupId,
            groupName: b.groupName,
            isImplicit: false,
            layoutIndex: headerIndex.get(b.groupId) ?? -1,
            sortMode:
              groupSortModes.get(b.groupId) ?? defaultGroupSortMode(b.groupId),
            sessions: b.sessions,
          },
    )

  // Pass 2 — apply per-group sort to each section's session list. For Custom
  // mode the order is the pass-1 walk (the LayoutItem ordering already encodes
  // the user's free-drag positions).
  for (const section of sections) {
    if (section.sortMode !== 'custom') {
      section.sessions = sortSessionsByMode(section.sortMode, section.sessions)
    }
  }

  return sections
}

// Build a fresh LayoutItem[] from sections after a drop. The session ORDER
// within each section is what changes; group ordering is preserved by the
// section array's own order (which the caller mutates via arrayMove).
function layoutFromSections(sections: ReadonlyArray<Section>): LayoutItem[] {
  const out: LayoutItem[] = []
  for (const section of sections) {
    if (!section.isImplicit) {
      out.push({
        type: 'group',
        id: section.groupId,
        name: section.groupName,
      })
    }
    for (const s of section.sessions) {
      out.push({ type: 'session', name: s.name })
    }
  }
  return out
}

// ── Per-group sort modes — local hook that hydrates from localStorage and
//    persists writes. Stored under `supermux:overview:group-sort:<id>`. ──

function useGroupSortModes(
  groupIds: ReadonlyArray<string>,
): [ReadonlyMap<string, GroupSortMode>, (id: string, mode: GroupSortMode) => void] {
  // The state shape is a Map<groupId, GroupSortMode> so we can lookup O(1)
  // while rendering. Lazy initial state: read all known ids once on mount.
  const [modes, setModes] = React.useState<Map<string, GroupSortMode>>(() => {
    const m = new Map<string, GroupSortMode>()
    for (const id of groupIds) m.set(id, readGroupSortMode(id))
    return m
  })

  // When the set of group ids changes (group added / removed), pull the modes
  // for the new ids from localStorage. Run as an effect (not in render) so we
  // don't violate React state rules; the lookup is cheap. The setModes call
  // here is conditional (only fires when ids actually changed → returns same
  // ref otherwise) so it can't loop; the strict rule's blanket warning is a
  // false positive for prop-reconciling effects.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModes((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const id of groupIds) {
        if (!next.has(id)) {
          next.set(id, readGroupSortMode(id))
          changed = true
        }
      }
      // Drop modes for groups that no longer exist so the map doesn't grow.
      const live = new Set(groupIds)
      for (const id of next.keys()) {
        if (!live.has(id)) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [groupIds])

  const set = React.useCallback((id: string, mode: GroupSortMode) => {
    setModes((prev) => {
      const next = new Map(prev)
      next.set(id, mode)
      return next
    })
    // Persist via the shared helper (M4 — consolidate localStorage keying so
    // every key flows through `groupSortKey()`).
    writeGroupSortMode(id, mode)
  }, [])

  return [modes, set]
}

// ── Live-region announcements (a11y mandate) ──────────────────────────────────

function announcementsFactory(
  liveRef: React.MutableRefObject<string>,
  setLive: React.Dispatch<React.SetStateAction<string>>,
  sections: ReadonlyArray<Section>,
): Announcements {
  // Resolve a dnd-kit drag id back to a human label.
  const labelFor = (id: UniqueIdentifier | undefined | null): string => {
    if (!id) return ''
    const s = String(id)
    if (s.startsWith('group:')) {
      const gid = s.slice('group:'.length)
      const sec = sections.find((x) => x.groupId === gid)
      return sec ? `group ${sec.groupName}` : 'group'
    }
    if (s.startsWith('session:')) {
      const name = s.slice('session:'.length)
      return `session ${name}`
    }
    if (s.startsWith('group-body:')) {
      const gid = s.slice('group-body:'.length)
      const sec = sections.find((x) => x.groupId === gid)
      return sec ? `group ${sec.groupName}` : 'group'
    }
    return s
  }
  const announce = (msg: string) => {
    liveRef.current = msg
    setLive(msg)
    return msg
  }
  return {
    onDragStart({ active }) {
      // S8 — Copy reflects what's actually wired: dnd-kit's
      // `sortableKeyboardCoordinates` implements arrows + Space/Enter + Esc.
      // Tab is NOT wired for choosing a group; the old copy promised a
      // feature that doesn't exist.
      return announce(
        `Picked up ${labelFor(active.id)}. Use arrow keys to move; Enter drops; Escape cancels.`,
      )
    },
    onDragOver({ active, over }) {
      if (!over) return announce(`Moving ${labelFor(active.id)}.`)
      return announce(
        `${labelFor(active.id)} is over ${labelFor(over.id)}.`,
      )
    },
    onDragEnd({ active, over }) {
      if (!over) return announce(`Dropped ${labelFor(active.id)} — no change.`)
      return announce(
        `Dropped ${labelFor(active.id)} on ${labelFor(over.id)}.`,
      )
    },
    onDragCancel({ active }) {
      return announce(`Cancelled drag of ${labelFor(active.id)}.`)
    },
  }
}

// ── The grid itself ──────────────────────────────────────────────────────────

export function GroupGrid({
  layoutItems,
  filteredSessions,
  onLayoutChange,
  sizeTier,
  tileGridClass,
  viewMode,
  onRequestNewGroupAt,
  tourFirstTileId,
  addingGroupAt,
  renderInlineAddGroupInput,
}: GroupGridProps) {
  const reduce = useReducedMotion()
  const { toast } = useToast()

  // ── Drop-flash state (Gap 1) ────────────────────────────────────────────
  // The just-dropped session's name — present for ~DROP_FLASH_MS after a
  // successful onDragEnd, then cleared. The matching <SortableTileSlot> reads
  // this and plays a 700ms background-color flash via framer-motion's
  // `animate`. Skipped entirely under `useReducedMotion`.
  const [justDroppedName, setJustDroppedName] = React.useState<string | null>(
    null,
  )
  const flashTimerRef = React.useRef<number | null>(null)
  const armDropFlash = React.useCallback(
    (name: string) => {
      if (reduce) return
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current)
      }
      setJustDroppedName(name)
      flashTimerRef.current = window.setTimeout(() => {
        flashTimerRef.current = null
        setJustDroppedName(null)
      }, DROP_FLASH_MS)
    },
    [reduce],
  )
  React.useEffect(
    () => () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current)
      }
    },
    [],
  )

  // ── Gap 3: smart-sort snackbar VR hook ────────────────────────────────
  // The toast itself is rendered by the shared <ToastProvider>'s viewport
  // (lives in a portal near the root, not under this component). To give the
  // visual-regression battery a deterministic DOM hook on *this* component's
  // subtree, we mount a hidden marker span here for the duration of the toast
  // (matches the toast's default 2.5s). The marker carries the message text
  // so a single VR assertion can check both "fired" and "with the right
  // copy" without screen-scraping the toast capsule.
  const [smartSortSnackbar, setSmartSortSnackbar] = React.useState<
    string | null
  >(null)
  const snackbarTimerRef = React.useRef<number | null>(null)
  // S12 — Toast dedupe. Three rapid identical smart-sort moves would stack
  // three toasts (the global ToastProvider keeps 3 visible × 2.5s). Track
  // the last fired message + timestamp and skip a repeat within ~500ms.
  const lastSnackbarRef = React.useRef<{ message: string; at: number }>({
    message: '',
    at: 0,
  })
  const fireSmartSortSnackbar = React.useCallback(
    (message: string) => {
      const now = Date.now()
      const last = lastSnackbarRef.current
      if (last.message === message && now - last.at < 500) {
        // Same message fired in the last 500ms — skip the duplicate toast.
        return
      }
      lastSnackbarRef.current = { message, at: now }
      toast({ message })
      // VR-hook lifetime mirrors the default toast duration.
      if (snackbarTimerRef.current !== null) {
        window.clearTimeout(snackbarTimerRef.current)
      }
      setSmartSortSnackbar(message)
      snackbarTimerRef.current = window.setTimeout(() => {
        snackbarTimerRef.current = null
        setSmartSortSnackbar(null)
      }, 2500)
    },
    [toast],
  )
  React.useEffect(
    () => () => {
      if (snackbarTimerRef.current !== null) {
        window.clearTimeout(snackbarTimerRef.current)
      }
    },
    [],
  )

  // Discover all current group ids (including the implicit Ungrouped if any
  // sessions float without a group). Stable identity for the sort-mode hook.
  const groupIds = React.useMemo(() => {
    const ids: string[] = []
    for (const item of layoutItems) {
      if (item.type === 'group') ids.push(item.id)
    }
    // Probe the filtered session list — if any floating session survived the
    // filter we need the implicit bucket.
    if (hasImplicitUngrouped(layoutItems)) {
      // Confirm at least one of the floating sessions matches the filter.
      const filteredNames = new Set(filteredSessions.map((s) => s.name))
      let hasFiltered = false
      for (const item of layoutItems) {
        if (item.type === 'group') break
        if (filteredNames.has(item.name)) {
          hasFiltered = true
          break
        }
      }
      if (hasFiltered) ids.unshift(UNGROUPED_GROUP_ID)
    }
    return ids
  }, [layoutItems, filteredSessions])

  const [groupSortModes, setGroupSortMode] = useGroupSortModes(groupIds)

  // ── Per-group COLLAPSE state ─────────────────────────────────────────────
  // Mirrors the focus-mode strip's collapse contract (chevron left of title,
  // localStorage-persisted, hydrate-on-demand) via the shared
  // `useCollapsibleGroups` primitive. Namespace `overview` keeps the keys
  // separate from `focus-strip` so the two surfaces collapse independently
  // (the overview is the layout surface; the strip is the viewport-rail
  // surface — same group can legitimately be expanded on one and collapsed
  // on the other).
  const { isCollapsed, setCollapsed } = useCollapsibleGroups('overview')
  const toggleCollapsed = React.useCallback(
    (groupId: string) => {
      setCollapsed(groupId, !isCollapsed(groupId))
    },
    [isCollapsed, setCollapsed],
  )

  const sections = React.useMemo(
    () => buildSections(layoutItems, filteredSessions, groupSortModes),
    [layoutItems, filteredSessions, groupSortModes],
  )

  // ── dnd-kit wiring ──────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      // 300ms long-press per the spec (mobile drag is SECONDARY — the kebab
      // "Move to…" sheet is the PRIMARY mobile path).
      activationConstraint: { delay: 300, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const [activeId, setActiveId] = React.useState<UniqueIdentifier | null>(null)
  const [overGroupId, setOverGroupId] = React.useState<string | null>(null)
  const [overItemId, setOverItemId] = React.useState<UniqueIdentifier | null>(
    null,
  )
  const isDragging = activeId !== null
  const draggingKind: 'group' | 'session' | null = React.useMemo(() => {
    if (!activeId) return null
    const s = String(activeId)
    if (s.startsWith('group:')) return 'group'
    if (s.startsWith('session:')) return 'session'
    return null
  }, [activeId])

  // The live region — narrate every transition. Real <div aria-live> mounted
  // below; dnd-kit's `Announcements` writes the same text so SR users get one
  // consistent narrative.
  const [liveText, setLiveText] = React.useState('')
  const liveRef = React.useRef('')
  const announcements = React.useMemo(
    () => announcementsFactory(liveRef, setLiveText, sections),
    [sections],
  )

  // Smart-sort destination → soft tooltip on pickup INSIDE the group (the
  // user attempted free-drag within a smart-sorted group; we accept the drag
  // but on drop discard the position and re-run the smart sort, with a
  // visible caption explaining why). The caption is rendered on the
  // DragOverlay so it floats with the cursor.

  // Find which group the dragging session originally lives in (for "same
  // group, smart-sort → re-sort on drop" branch).
  const activeSessionGroup = React.useMemo<Section | null>(() => {
    if (!activeId) return null
    const s = String(activeId)
    if (!s.startsWith('session:')) return null
    const name = s.slice('session:'.length)
    return sections.find((sec) => sec.sessions.some((x) => x.name === name)) ?? null
  }, [activeId, sections])

  const destSection: Section | null = React.useMemo(() => {
    if (!overGroupId) return null
    return sections.find((sec) => sec.groupId === overGroupId) ?? null
  }, [overGroupId, sections])

  // ── Drag lifecycle ──────────────────────────────────────────────────────────

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(e.active.id)
    setOverGroupId(null)
    setOverItemId(null)
  }

  const onDragOver = (e: DragOverEvent) => {
    const over = e.over
    setOverItemId(over?.id ?? null)
    if (!over) {
      setOverGroupId(null)
      return
    }
    const overStr = String(over.id)
    // Hovering a group body droppable → that group is the dest.
    if (overStr.startsWith('group-body:')) {
      setOverGroupId(overStr.slice('group-body:'.length))
      return
    }
    // Hovering a session → its group is the dest.
    if (overStr.startsWith('session:')) {
      const name = overStr.slice('session:'.length)
      const sec = sections.find((x) => x.sessions.some((s) => s.name === name))
      setOverGroupId(sec?.groupId ?? null)
      return
    }
    // Hovering a group header → that group is the dest.
    if (overStr.startsWith('group:')) {
      setOverGroupId(overStr.slice('group:'.length))
      return
    }
  }

  const onDragCancel = (_e: DragCancelEvent) => {
    setActiveId(null)
    setOverGroupId(null)
    setOverItemId(null)
  }

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    setActiveId(null)
    setOverGroupId(null)
    setOverItemId(null)
    if (!over) return
    const activeStr = String(active.id)
    const overStr = String(over.id)
    if (activeStr === overStr) return

    // ── Branch 1: group-to-group reorder ──────────────────────────────────
    if (activeStr.startsWith('group:') && overStr.startsWith('group:')) {
      const fromId = activeStr.slice('group:'.length)
      const toId = overStr.slice('group:'.length)
      const fromIdx = sections.findIndex((s) => s.groupId === fromId)
      const toIdx = sections.findIndex((s) => s.groupId === toId)
      if (fromIdx < 0 || toIdx < 0) return
      // The implicit Ungrouped section can't be reordered (it's always at the
      // top of whatever wasn't placed in a real group).
      if (sections[fromIdx].isImplicit) return
      const next = arrayMove([...sections], fromIdx, toIdx)
      onLayoutChange(layoutFromSections(next))
      return
    }

    // ── Branch 2: session drag ────────────────────────────────────────────
    if (!activeStr.startsWith('session:')) return
    const draggedName = activeStr.slice('session:'.length)
    const fromSection = sections.find((s) =>
      s.sessions.some((x) => x.name === draggedName),
    )
    if (!fromSection) return

    // Resolve destination section + index.
    let destSec: Section | undefined
    let dropIndex = -1
    if (overStr.startsWith('group-body:')) {
      destSec = sections.find(
        (s) => s.groupId === overStr.slice('group-body:'.length),
      )
      dropIndex = destSec ? destSec.sessions.length : -1
    } else if (overStr.startsWith('session:')) {
      const overName = overStr.slice('session:'.length)
      destSec = sections.find((s) =>
        s.sessions.some((x) => x.name === overName),
      )
      dropIndex = destSec ? destSec.sessions.findIndex((x) => x.name === overName) : -1
    } else if (overStr.startsWith('group:')) {
      destSec = sections.find((s) => s.groupId === overStr.slice('group:'.length))
      dropIndex = 0
    }
    if (!destSec) return

    // Apply the move. For SMART-SORT destination, we discard the precise
    // insertion index (the sort kernel re-orders on the next render anyway).
    // For CUSTOM-SORT destination, the index matters.
    const nextSections = sections.map((s) => ({ ...s, sessions: [...s.sessions] }))
    const fromSec = nextSections.find((s) => s.groupId === fromSection.groupId)!
    const toSec = nextSections.find((s) => s.groupId === destSec.groupId)!
    const fromIdx = fromSec.sessions.findIndex((x) => x.name === draggedName)
    if (fromIdx < 0) return
    const [moved] = fromSec.sessions.splice(fromIdx, 1)
    if (toSec.sortMode === 'custom') {
      // Clamp dropIndex to [0, sessions.length]; if dropping in the same
      // section, the splice above shifted indices, so adjust for that.
      let insertAt = dropIndex < 0 ? toSec.sessions.length : dropIndex
      if (fromSec === toSec && fromIdx < insertAt) insertAt -= 1
      insertAt = Math.max(0, Math.min(insertAt, toSec.sessions.length))
      toSec.sessions.splice(insertAt, 0, moved)
    } else {
      // Smart / Name / etc. — append; the sort kernel will reposition on render
      // and the persisted LayoutItem[] just records membership.
      toSec.sessions.push(moved)
    }
    onLayoutChange(layoutFromSections(nextSections))

    // ── Gap 1: arm the 700ms drop-flash on the just-dropped tile. ────────
    armDropFlash(draggedName)

    // ── Gap 3: smart-sort destination snackbar. ──────────────────────────
    // The position was discarded (toSec.sortMode !== 'custom') and the smart
    // sort re-runs on the next render. Surface a calm snackbar so the user
    // understands why their precise drop position didn't stick. Same message
    // for any non-custom destination (Smart / Name / Status / Recent / Age)
    // since the user experience is identical: "you dropped it here, but the
    // sort kernel just repositioned it."
    //
    // S5 — Only fire on CROSS-group moves. Dragging a tile WITHIN the same
    // smart-sort group and releasing without leaving the group is a no-op
    // from the user's perspective; the sort kernel quietly re-runs but
    // there's no "moved to <group>" event to announce. Without this guard
    // the snackbar fires on every within-group drag — noise.
    if (toSec.sortMode !== 'custom' && fromSec.groupId !== toSec.groupId) {
      fireSmartSortSnackbar(
        `Moved to ${toSec.groupName} — re-sorted by ${GROUP_SORT_LABEL[toSec.sortMode]}.`,
      )
    }
  }

  // ── moveSessionToGroup (Gap 2 — kebab "Move to ▸" reuses this) ────────
  // The same logical action the drag-drop performs, but driven by an explicit
  // destination group id (no precise index — the kebab is the keyboard /
  // touch alternative path, not a precision tool). For a custom-sort dest the
  // tile lands at the END; for smart-sort the sort kernel positions it.
  const moveSessionToGroup = React.useCallback(
    (sessionName: string, destGroupId: string) => {
      const fromSection = sections.find((s) =>
        s.sessions.some((x) => x.name === sessionName),
      )
      const destSec = sections.find((s) => s.groupId === destGroupId)
      if (!fromSection || !destSec) return
      if (fromSection.groupId === destSec.groupId) return // No-op.

      const nextSections = sections.map((s) => ({
        ...s,
        sessions: [...s.sessions],
      }))
      const fromSec = nextSections.find(
        (s) => s.groupId === fromSection.groupId,
      )!
      const toSec = nextSections.find((s) => s.groupId === destSec.groupId)!
      const fromIdx = fromSec.sessions.findIndex((x) => x.name === sessionName)
      if (fromIdx < 0) return
      const [moved] = fromSec.sessions.splice(fromIdx, 1)
      // No precise index for the kebab path — append; the smart sort (if any)
      // will reposition on render. For custom, "end of list" is the safest
      // landing for a non-drag action.
      toSec.sessions.push(moved)
      onLayoutChange(layoutFromSections(nextSections))

      // Mirror the drag-drop UX: flash the just-moved tile + (if dest is
      // auto-sorted) fire the same snackbar so the user has the same mental
      // model regardless of the entrypoint (drag vs kebab).
      armDropFlash(sessionName)
      if (toSec.sortMode !== 'custom') {
        fireSmartSortSnackbar(
          `Moved to ${toSec.groupName} — re-sorted by ${GROUP_SORT_LABEL[toSec.sortMode]}.`,
        )
      }
    },
    [sections, onLayoutChange, armDropFlash, fireSmartSortSnackbar],
  )

  // ── Group-header move-actions (kebab alt path) ───────────────────────────
  const moveGroup = React.useCallback(
    (groupId: string, target: 'up' | 'down' | 'top' | 'bottom') => {
      const fromIdx = sections.findIndex(
        (s) => s.groupId === groupId && !s.isImplicit,
      )
      if (fromIdx < 0) return
      const realIdx = (i: number) =>
        sections[i] && !sections[i].isImplicit ? i : -1
      let toIdx = fromIdx
      if (target === 'up') {
        for (let i = fromIdx - 1; i >= 0; i--) {
          if (realIdx(i) >= 0) {
            toIdx = i
            break
          }
        }
      } else if (target === 'down') {
        for (let i = fromIdx + 1; i < sections.length; i++) {
          if (realIdx(i) >= 0) {
            toIdx = i
            break
          }
        }
      } else if (target === 'top') {
        for (let i = 0; i < sections.length; i++) {
          if (realIdx(i) >= 0) {
            toIdx = i
            break
          }
        }
      } else if (target === 'bottom') {
        for (let i = sections.length - 1; i >= 0; i--) {
          if (realIdx(i) >= 0) {
            toIdx = i
            break
          }
        }
      }
      if (toIdx === fromIdx) return
      const next = arrayMove([...sections], fromIdx, toIdx)
      onLayoutChange(layoutFromSections(next))
    },
    [sections, onLayoutChange],
  )

  // ── Per-group sort write ────────────────────────────────────────────────
  const setGroupMode = React.useCallback(
    (groupId: string, mode: GroupSortMode) => {
      setGroupSortMode(groupId, mode)
    },
    [setGroupSortMode],
  )

  // ── Group ids in render order, for the outer SortableContext ────────────
  const groupSortableIds = React.useMemo(
    () => sections.map((s) => groupDragId(s.groupId)),
    [sections],
  )

  // ── The drag-over container-indicate mode ────────────────────────────────
  // Per the spec: smart-sort dest → 'smart' (outline + tinted bg);
  // custom-sort dest → 'custom' (the inter-tile line owns the precision —
  // container indication is QUIETER for custom). Off when not dragging or no
  // dest. Tile drag only (group drag uses the full-grid drop-line indicator).
  const destIndicateFor = React.useCallback(
    (sec: Section): 'smart' | 'custom' | 'off' => {
      if (draggingKind !== 'session') return 'off'
      if (!destSection || destSection.groupId !== sec.groupId) return 'off'
      return sec.sortMode === 'custom' ? 'custom' : 'smart'
    },
    [destSection, draggingKind],
  )

  // The floating caption text for the DragOverlay when the dest is smart-sort.
  const overlayCaption = React.useMemo(() => {
    if (draggingKind !== 'session') return null
    if (!destSection) return null
    if (destSection.sortMode === 'custom') return null
    return `Drop in ${destSection.groupName} — sorted by ${GROUP_SORT_LABEL[destSection.sortMode]}.`
  }, [destSection, draggingKind])

  // The active-session info (used by the DragOverlay).
  const activeSession = React.useMemo<ApiSession | null>(() => {
    if (!activeId) return null
    const s = String(activeId)
    if (!s.startsWith('session:')) return null
    const name = s.slice('session:'.length)
    return filteredSessions.find((x) => x.name === name) ?? null
  }, [activeId, filteredSessions])
  const activeGroup = React.useMemo<Section | null>(() => {
    if (!activeId) return null
    const s = String(activeId)
    if (!s.startsWith('group:')) return null
    const gid = s.slice('group:'.length)
    return sections.find((sec) => sec.groupId === gid) ?? null
  }, [activeId, sections])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      data-vr="group-grid"
      // Gap 3 — when the smart-sort snackbar is active, the grid root carries
      // the flag too, so the VR battery can assert "snackbar fired" from a
      // single root selector without screen-scraping the toast portal.
      data-vr-smart-sort-snackbar={smartSortSnackbar ? 'active' : undefined}
      className="relative"
    >
      {/* SR live region — assertive so a Picked up / dropped / cancel message
          interrupts whatever the SR was reading. Visually hidden. */}
      <div
        role="status"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
      >
        {liveText}
      </div>
      {/* Gap 3 VR hook — hidden marker that mirrors the smart-sort snackbar
          while it's on screen. Carries the message text so a VR assertion can
          verify both "fired" and "the right copy" in one query. */}
      {smartSortSnackbar && (
        <span
          hidden
          data-vr="smart-sort-snackbar"
          data-vr-smart-sort-snackbar="active"
          data-vr-message={smartSortSnackbar}
        />
      )}
      <DndContext
        sensors={sensors}
        accessibility={{ announcements }}
        // pointerWithin first (more forgiving over container droppables),
        // then closest-center as a fallback for edge hovers.
        //
        // M2 — Cross-context collision FILTER. dnd-kit's collision strategy
        // runs across EVERY droppable in the context. When dragging a GROUP
        // HEADER, the pointer often lands inside a tile sortable (tile bodies
        // are much larger than the 40px header row) and `over.id` becomes
        // `session:<name>` — none of our group-drop branches match and the
        // drop is silently swallowed. Antipattern: trusting a single global
        // collision strategy across multiple drag KINDS. Fix: gate on the
        // dragging item's id prefix and only consider droppables of the
        // same kind. Sessions can drop on group-bodies + sessions + group
        // headers (all valid dest types); groups can only drop on other
        // group headers.
        collisionDetection={(args) => {
          const activeId = String(args.active.id)
          const filterByKind = <T extends { id: UniqueIdentifier }>(arr: T[]): T[] => {
            if (activeId.startsWith('group:')) {
              return arr.filter((c) => String(c.id).startsWith('group:'))
            }
            // Session drag — keep everything (group-body, session, group header).
            return arr
          }
          const pointer = filterByKind(pointerWithin(args))
          if (pointer.length > 0) return pointer
          const intersect = filterByKind(rectIntersection(args))
          if (intersect.length > 0) return intersect
          return filterByKind(closestCenter(args))
        }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragCancel={onDragCancel}
        onDragEnd={onDragEnd}
        // S13 — Auto-scroll threshold ≈ 40px from the edge. dnd-kit takes a
        // normalized fraction (0..1) of viewport height, not pixels. We pick
        // a fixed 0.05 — ≈40px on a 1080p laptop, slightly more aggressive
        // on shorter phone viewports (which is fine for touch). A
        // ResizeObserver-driven dynamic value would be more precise but
        // adds an observer for no perceivable user benefit.
        autoScroll={{
          enabled: true,
          threshold: { x: 0, y: 0.05 },
          // Acceleration: 10 (default) is a good "feels like Notion" baseline.
          acceleration: 10,
        }}
      >
        <SortableContext
          items={groupSortableIds}
          strategy={verticalListSortingStrategy}
        >
          {/* S11 — Removed dead `<LayoutGroup>` wrapper. No inner element
              uses framer-motion `layout`/`layoutId`, so it was a no-op
              (and the docstring above mis-claimed Motion drove the reflow
              when in fact dnd-kit's CSS transform does). Reflow timing now
              comes from `tweens.reflow` (100ms ease-out) via the
              sortable.transition override — see SortableTileSlot. */}
            <div className="flex flex-col gap-2">
              {/* Hover-gap above the first section (or inline input if active here). */}
              {addingGroupAt != null && addingGroupAt === 0 && renderInlineAddGroupInput ? (
                renderInlineAddGroupInput(0)
              ) : (
                <GapAddGroup
                  index={0}
                  onPick={() => onRequestNewGroupAt(0)}
                  reduce={!!reduce}
                />
              )}
              {(() => {
                // S6 — Pre-compute the first/last REORDERABLE section index
                // (skipping the implicit Ungrouped bucket) so the kebab's
                // move-up/down/top/bottom items can be DISABLED at boundaries
                // instead of being live and silently no-op'ing.
                let firstReal = -1
                let lastReal = -1
                for (let i = 0; i < sections.length; i++) {
                  if (sections[i].isImplicit) continue
                  if (firstReal < 0) firstReal = i
                  lastReal = i
                }
                return sections.map((section, sIdx) => {
                const dragLifted =
                  activeGroup?.groupId === section.groupId && !section.isImplicit
                const dragOver =
                  draggingKind === 'group' &&
                  overGroupId === section.groupId &&
                  !section.isImplicit &&
                  !dragLifted
                const canMoveUp = !section.isImplicit && sIdx > firstReal
                const canMoveDown = !section.isImplicit && sIdx < lastReal
                return (
                  <React.Fragment key={section.groupId}>
                    {/* Full-grid-width drop line for group-to-group reorder.
                        Renders ABOVE the section it would drop over (the row
                        becomes the section it's about to land before). */}
                    {dragOver && (
                      <FullGridDropLine reduce={!!reduce} />
                    )}
                    <GroupSection
                      section={section}
                      allSections={sections}
                      sIdx={sIdx}
                      collapsed={isCollapsed(section.groupId)}
                      onToggleCollapsed={() =>
                        toggleCollapsed(section.groupId)
                      }
                      viewMode={viewMode}
                      sizeTier={sizeTier}
                      tileGridClass={tileGridClass}
                      containerIndicate={destIndicateFor(section)}
                      isDragging={isDragging}
                      draggingKind={draggingKind}
                      activeSessionName={
                        activeSession?.name ?? null
                      }
                      justDroppedName={justDroppedName}
                      onMoveSessionToGroup={moveSessionToGroup}
                      overItemId={overItemId}
                      onSortModeChange={(mode) =>
                        setGroupMode(section.groupId, mode)
                      }
                      // S6 — Pass `undefined` at boundaries so GroupHeader's
                      // `disabled={!onMove*}` actually disables the kebab
                      // item. The "Move to top" / "Move up" items are
                      // undefined for the first reorderable section; mirror
                      // for "Move down" / "Move to bottom" on the last.
                      onMoveUp={
                        canMoveUp
                          ? () => moveGroup(section.groupId, 'up')
                          : undefined
                      }
                      onMoveDown={
                        canMoveDown
                          ? () => moveGroup(section.groupId, 'down')
                          : undefined
                      }
                      onMoveTop={
                        canMoveUp
                          ? () => moveGroup(section.groupId, 'top')
                          : undefined
                      }
                      onMoveBottom={
                        canMoveDown
                          ? () => moveGroup(section.groupId, 'bottom')
                          : undefined
                      }
                      onDelete={() => {
                        // Remove the group header; sessions inside it survive
                        // (the reconciler floats them into Ungrouped). Also
                        // drop the per-group sort-mode + collapsed
                        // localStorage rows so dead keys don't accumulate (M4
                        // hygiene + the matching collapse-row cleanup).
                        removeGroupSortMode(section.groupId)
                        removeCollapsed('overview', section.groupId)
                        const next = layoutItems.filter(
                          (it) =>
                            !(it.type === 'group' && it.id === section.groupId),
                        )
                        onLayoutChange(next as LayoutItem[])
                      }}
                      onRename={(nextName) => {
                        const next = layoutItems.map((it) =>
                          it.type === 'group' && it.id === section.groupId
                            ? { ...it, name: nextName }
                            : it,
                        )
                        onLayoutChange(next as LayoutItem[])
                      }}
                      activeSessionGroupId={
                        activeSessionGroup?.groupId ?? null
                      }
                      reduce={!!reduce}
                      tourFirstTileId={tourFirstTileId}
                    />
                    {/* Hover-gap BELOW each section (the "add between" + "add
                        after last" affordance). When the inline input is active
                        at this gap (exact match OR MAX_SAFE_INTEGER on the last
                        gap), replace the chip with the input. */}
                    {(() => {
                      const gapIdx = sIdx + 1
                      const isAddingHere =
                        addingGroupAt != null &&
                        renderInlineAddGroupInput != null &&
                        (addingGroupAt === gapIdx ||
                          (addingGroupAt === Number.MAX_SAFE_INTEGER &&
                            gapIdx === sections.length))
                      return isAddingHere ? (
                        renderInlineAddGroupInput(addingGroupAt)
                      ) : (
                        <GapAddGroup
                          index={gapIdx}
                          onPick={() => onRequestNewGroupAt(gapIdx)}
                          reduce={!!reduce}
                        />
                      )
                    })()}
                  </React.Fragment>
                )
              })
              })()}
            </div>
        </SortableContext>

        {/* DragOverlay — rendered OUTSIDE the grid container so the floating
            preview tracks the cursor and is NOT clipped by the column grid.
            This is the user's explicit bug fix: "drag preview escapes the grid
            container; tracks the cursor, NOT the column grid." */}
        <DragOverlay
          dropAnimation={null}
          // No grid constraints — the overlay portal renders to <body>.
          adjustScale={false}
          zIndex={1000}
        >
          {activeSession ? (
            <div
              data-vr="drag-overlay"
              data-vr-drag-state="lifted"
              data-vr-kind="session"
              className="pointer-events-none"
            >
              <div className="rounded-xl border border-border bg-card/95 px-3 py-2 text-sm shadow-2xl">
                <div className="font-medium">
                  {activeSession.task_summary ?? activeSession.name}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {activeSession.name}
                </div>
              </div>
              {overlayCaption && (
                <div
                  data-vr="drag-overlay-caption"
                  className="mt-1.5 inline-block rounded-md bg-foreground/85 px-2 py-1 text-[11px] font-medium text-background shadow-md"
                >
                  {overlayCaption}
                </div>
              )}
            </div>
          ) : activeGroup ? (
            <div
              data-vr="drag-overlay"
              data-vr-drag-state="lifted"
              data-vr-kind="group"
              className="pointer-events-none rounded-md border border-border bg-card/95 px-3 py-1.5 text-xs font-medium shadow-2xl"
            >
              {activeGroup.groupName}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}

// ── GroupSection — one section header + its tiles ────────────────────────────

function GroupSection({
  section,
  allSections,
  sIdx,
  viewMode,
  sizeTier,
  tileGridClass,
  containerIndicate,
  isDragging,
  draggingKind,
  activeSessionName,
  justDroppedName,
  onMoveSessionToGroup,
  overItemId,
  onSortModeChange,
  onMoveUp,
  onMoveDown,
  onMoveTop,
  onMoveBottom,
  onDelete,
  onRename,
  activeSessionGroupId,
  reduce,
  tourFirstTileId,
  collapsed,
  onToggleCollapsed,
}: {
  section: Section
  /** All sections in render order — passed through to each tile so the
   *  "Move to ▸" kebab submenu can list every OTHER group. (Gap 2.) */
  allSections: ReadonlyArray<Section>
  sIdx: number
  viewMode: 'tile' | 'list'
  sizeTier: OverviewSize
  tileGridClass: string
  containerIndicate: 'smart' | 'custom' | 'off'
  isDragging: boolean
  draggingKind: 'group' | 'session' | null
  activeSessionName: string | null
  /** The name of the session that was JUST DROPPED (and should flash). Cleared
   *  ~700ms after the drop. (Gap 1.) */
  justDroppedName: string | null
  /** Move a session to another group, used by the kebab "Move to ▸" submenu
   *  (Gap 2) and (internally) the drag-drop path. */
  onMoveSessionToGroup: (sessionName: string, destGroupId: string) => void
  overItemId: UniqueIdentifier | null
  onSortModeChange: (mode: GroupSortMode) => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  onMoveTop?: () => void
  onMoveBottom?: () => void
  onDelete: () => void
  onRename: (next: string) => void
  activeSessionGroupId: string | null
  reduce: boolean
  tourFirstTileId?: string
  /** Per-group collapse state from the parent's `useCollapsibleGroups`. */
  collapsed: boolean
  /** Toggle the collapse state. Wired to the chevron + (when collapsed) a
   *  click on the implicit-bucket label so every section can re-expand even
   *  without the GroupHeader chrome. */
  onToggleCollapsed: () => void
}) {
  // Each section has its OWN SortableContext over its session ids so dnd-kit's
  // within-container sortable strategy operates on the right scope.
  const sessionIds = React.useMemo(
    () => section.sessions.map((s) => sessionDragId(s.name)),
    [section.sessions],
  )

  // The header row is sortable as a GROUP — the whole row is the drag target.
  // The implicit Ungrouped bucket isn't reorderable, so we suppress the
  // header chrome on it.
  const headerSortable = useSortable({
    id: groupDragId(section.groupId),
    disabled: section.isImplicit,
    // S11 — Match the per-tile 100ms reflow for consistency across the grid.
    transition: { duration: 100, easing: 'ease-out' },
  })
  const headerStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(headerSortable.transform),
    // S9 — Honor prefers-reduced-motion: skip dnd-kit's CSS transition entirely.
    transition: reduce ? undefined : (headerSortable.transition ?? undefined),
  }

  // The group body is a Droppable so a tile dragged anywhere over the body —
  // even over empty space — registers this group as the destination.
  const droppable = useDroppable({ id: groupDropId(section.groupId) })

  // Smart-sort group prohibits intra-group precise positioning: the alternative
  // (allowed in the spec) is "accept the drag but discard the position and
  // re-run the smart sort on drop". We choose THAT alternative because it
  // gives the user the smoother feel — they can still pull a tile out, move
  // it to another group, etc., and within the same group the drop just
  // resnaps. No surprise blocking gesture mid-drag.

  // Per-section drop-indicator: for a SMART-SORT dest, no inter-tile line is
  // shown; for a CUSTOM-SORT dest, a short inter-tile line is shown at the
  // precise drop slot (between adjacent tiles).
  const showInterTileLine =
    draggingKind === 'session' &&
    containerIndicate === 'custom' &&
    overItemId !== null

  // EFFECTIVE collapse — the user's persisted collapse state, but FORCE-OPEN
  // while a drag is in flight. Rationale: dnd-kit's drop targets live on the
  // body's sortable wrappers; collapsing the body mid-drag would yank those
  // out from under the active gesture and break "drag a tile into a
  // collapsed group" (a power-user move the user would silently lose if we
  // unmounted). The chevron's aria-expanded still reflects the user's
  // PERSISTED state so the SR announcement is honest — the temporary
  // open-while-dragging is a transient visual concession, not a state
  // change.
  const effectiveCollapsed = collapsed && !isDragging

  return (
    <section
      data-vr="group-section"
      data-vr-group-id={section.groupId}
      data-vr-sort-mode={section.sortMode}
      data-vr-container-indicate={containerIndicate}
      data-vr-section-index={sIdx}
      data-vr-collapsed={collapsed ? 'true' : 'false'}
      ref={droppable.setNodeRef}
      // Container indication — a smart-sort dest gets a tinted outline + bg;
      // a custom-sort dest gets a quieter outline (the inter-tile line owns
      // the precision). Duration + easing source-of-truth is
      // `tweens.containerIndicate` in @/lib/springs (S10 — Tailwind classes
      // mirror that token: 350ms ease-out). Under prefers-reduced-motion the
      // tween is dropped (M3) — the colour swap is instant.
      className={`relative rounded-lg transition-[background-color,box-shadow,border-color] duration-[350ms] ease-out motion-reduce:transition-none ${
        containerIndicate === 'smart'
          ? 'bg-primary/5 outline outline-2 outline-primary/40'
          : containerIndicate === 'custom'
            ? 'outline outline-1 outline-border'
            : ''
      }`}
    >
      {!section.isImplicit && (
        <div
          ref={headerSortable.setNodeRef}
          style={headerStyle}
        >
          <GroupHeader
            id={section.groupId}
            name={section.groupName}
            count={section.sessions.length}
            dragListeners={{
              ...headerSortable.attributes,
              ...headerSortable.listeners,
            }}
            sortMode={section.sortMode}
            onSortModeChange={onSortModeChange}
            containerIndicate={containerIndicate}
            dragLifted={headerSortable.isDragging}
            dragOver={false}
            onRename={onRename}
            onDelete={onDelete}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onMoveTop={onMoveTop}
            onMoveBottom={onMoveBottom}
            collapsed={collapsed}
            onToggleCollapsed={onToggleCollapsed}
          />
        </div>
      )}
      {section.isImplicit && (
        // Implicit "Ungrouped" bucket — render a tiny muted label so the user
        // sees what they're looking at without it competing for attention.
        // Wrapped in a button so the same collapse affordance is available
        // here as on a real group header (chevron-left-of-title pattern from
        // the focus-strip — but at the implicit bucket's muted density).
        <button
          type="button"
          data-vr="ungrouped-label"
          data-vr-collapse-toggle="true"
          data-vr-collapsed={collapsed ? 'true' : 'false'}
          aria-expanded={!collapsed}
          aria-label={`${
            collapsed ? 'Expand' : 'Collapse'
          } Ungrouped (${section.sessions.length})`}
          onClick={onToggleCollapsed}
          className="flex w-full items-center gap-1.5 rounded-md px-1 pb-1 pt-0.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:py-2"
        >
          <ChevronRight
            aria-hidden
            className={
              'size-3 shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none' +
              (!collapsed ? ' rotate-90' : '')
            }
          />
          <span>Ungrouped · {section.sessions.length}</span>
        </button>
      )}

      {/* The tiles. Tile view → grid; list view → flex column.
          The body is wrapped in AnimatePresence so collapse animates a
          smooth height: auto → 0 transition (matches the user's preferred
          focus-mode sidepanel collapse feel). Under prefers-reduced-motion
          the transition is a single-frame snap (duration: 0). While a drag
          is in flight `effectiveCollapsed` is forced false so dnd-kit's
          drop targets remain mounted — see the comment on
          `effectiveCollapsed` above. */}
      <AnimatePresence initial={false}>
        {!effectiveCollapsed && (
          <motion.div
            key="body"
            data-vr="group-body-wrapper"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : springs.smooth}
            // overflow-hidden so the height tween doesn't reveal content as
            // it shrinks past the new height; the tile grid otherwise paints
            // outside the collapsing container.
            className="overflow-hidden"
          >
      <SortableContext
        items={sessionIds}
        strategy={viewMode === 'tile' ? rectSortingStrategy : verticalListSortingStrategy}
      >
        {viewMode === 'tile' ? (
          <div
            data-vr="group-body"
            data-vr-group-id={section.groupId}
            className={tileGridClass}
          >
            {section.sessions.map((sess, i) => (
              <SortableTileSlot
                key={sess.name}
                session={sess}
                sizeTier={sizeTier}
                groupSortMode={section.sortMode}
                isDragging={isDragging}
                draggingKind={draggingKind}
                activeSessionName={activeSessionName}
                showLineBefore={
                  showInterTileLine &&
                  overItemId === sessionDragId(sess.name)
                }
                tour={i === 0 && sIdx === 0 ? tourFirstTileId : undefined}
                reduce={reduce}
                justDropped={justDroppedName === sess.name}
                currentGroupId={section.groupId}
                allSections={allSections}
                onMoveToGroup={(destGroupId) =>
                  onMoveSessionToGroup(sess.name, destGroupId)
                }
                // If smart-sort dest and a session is dragged from elsewhere,
                // hide the inter-tile line; the container indication shows.
              />
            ))}
            {/* End-of-list drop slot: when a tile is dragged into this group
                with no specific over-target inside, the line shows at the END.
                The container indication on a smart-sort group already covers
                this case, so we only render the end-line for custom. */}
            {showInterTileLine &&
              overItemId === groupDropId(section.groupId) && (
                <div
                  data-vr="tile-drop-line"
                  data-vr-drop-line="tile"
                  className="col-span-full h-0.5 rounded-full bg-primary"
                />
              )}
            {/* Empty-section caption when this section has no tiles AND a
                drag is hovering it — keeps the destination box from looking
                broken. */}
            {section.sessions.length === 0 && containerIndicate !== 'off' && (
              <div className="col-span-full grid h-20 place-items-center text-xs text-muted-foreground">
                Drop here
              </div>
            )}
            {/* The activeSessionGroupId is consumed silently — kept as a hook
                point for the smart-sort within-group re-sort effect; assigned
                to a no-op span so the prop is "used" per lint. */}
            <span hidden data-vr-active-session-group={activeSessionGroupId} />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {section.sessions.map((sess) => (
              <SortableRow
                key={sess.name}
                session={sess}
                groupSortMode={section.sortMode}
                isDragging={isDragging}
                draggingKind={draggingKind}
                activeSessionName={activeSessionName}
                showLineBefore={
                  showInterTileLine &&
                  overItemId === sessionDragId(sess.name)
                }
                reduce={reduce}
                justDropped={justDroppedName === sess.name}
                currentGroupId={section.groupId}
                allSections={allSections}
                onMoveToGroup={(destGroupId) =>
                  onMoveSessionToGroup(sess.name, destGroupId)
                }
              />
            ))}
            <span hidden data-vr-active-session-group={activeSessionGroupId} />
          </div>
        )}
      </SortableContext>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

// ── SortableTileSlot — one tile draggable inside its group ───────────────────

function SortableTileSlot({
  session,
  sizeTier,
  groupSortMode,
  isDragging,
  draggingKind,
  activeSessionName,
  showLineBefore,
  tour,
  reduce,
  justDropped,
  currentGroupId,
  allSections,
  onMoveToGroup,
}: {
  session: ApiSession
  sizeTier: OverviewSize
  groupSortMode: GroupSortMode
  isDragging: boolean
  draggingKind: 'group' | 'session' | null
  activeSessionName: string | null
  showLineBefore: boolean
  tour?: string
  reduce: boolean
  /** True for ~700ms after this tile was the drop target — drives the
   *  Gap-1 background-color flash. Honors `useReducedMotion` (when reduced,
   *  the parent never sets justDropped). */
  justDropped: boolean
  /** This tile's CURRENT group id — used to filter out the current group
   *  from the kebab "Move to ▸" submenu (Gap 2). */
  currentGroupId: string
  /** All sections in render order, so the submenu can list every OTHER
   *  group. (Gap 2.) */
  allSections: ReadonlyArray<Section>
  /** Move this tile to the given destination group (Gap 2). */
  onMoveToGroup: (destGroupId: string) => void
}) {
  const sortable = useSortable({
    id: sessionDragId(session.name),
    // Per the spec: smart-sort GROUP allows the drag to start (alternative B
    // accepted), and on drop the smart sort re-runs. So we don't `disable`
    // here — that would prevent picking the tile up at all. The drop logic
    // discards the precise position when the dest is smart-sort.
    disabled: false,
    // S11 — Reflow timing comes from `tweens.reflow` (100ms ease-out) instead
    // of dnd-kit's ~200ms default; matches spec. Reduce-motion handled by
    // the explicit `transition: reduce ? undefined : ...` at the style level.
    transition: { duration: 100, easing: 'ease-out' },
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    // S9 — Honor prefers-reduced-motion.
    transition: reduce ? undefined : (sortable.transition ?? undefined),
    opacity: sortable.isDragging ? 0.4 : 1,
    zIndex: sortable.isDragging ? 10 : undefined,
  }
  const isThisActive = activeSessionName === session.name
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      data-vr="group-tile-slot"
      data-vr-session-name={session.name}
      data-vr-drag-state={
        sortable.isDragging
          ? 'lifted'
          : isDragging && !isThisActive
            ? 'reflow'
            : 'idle'
      }
      data-vr-group-sort-mode={groupSortMode}
      // Gap 1 — VR hook the visual-regression battery can assert. Stays
      // "active" for the duration of the flash, then clears.
      data-vr-just-dropped={justDropped ? 'true' : undefined}
      data-vr-drop-flash={justDropped ? 'active' : undefined}
      className="group/tile relative"
    >
      {showLineBefore && (
        <div
          aria-hidden
          data-vr="tile-drop-line"
          data-vr-drop-line="tile"
          // A short inter-tile insertion line — left edge of THIS tile, full
          // tile width, 2px tall. Sits absolutely so it doesn't reflow the
          // surrounding grid cells.
          className="pointer-events-none absolute -left-1 -top-1 z-30 h-0.5 w-[calc(100%+0.5rem)] rounded-full bg-primary shadow-[0_0_0_2px_hsl(var(--background))]"
        />
      )}
      {/* Gap 1 — 700ms drop-flash overlay. Sits ABOVE the tile chrome
          (z-10) but BELOW the drag handle / kebab (z-20) so the
          accent-tinted flash announces the landing without disabling
          clicks. AnimatePresence drives a single one-shot tween: tinted
          background → transparent over 700ms ease-out. The framer-motion
          render returns null under Reduce Motion (justDropped is never
          set in that branch). */}
      {justDropped && (
        <motion.div
          aria-hidden
          data-vr="drop-flash"
          initial={{ backgroundColor: 'hsl(var(--primary) / 0.18)' }}
          animate={{ backgroundColor: 'hsl(var(--primary) / 0)' }}
          transition={tweens.dropFlash}
          className="pointer-events-none absolute inset-0 z-10 rounded-xl"
        />
      )}
      <SessionTileWrapper
        session={session}
        sizeTier={sizeTier}
        listeners={{ ...sortable.attributes, ...sortable.listeners }}
        reduce={reduce}
        tour={tour}
        draggingKind={draggingKind}
        currentGroupId={currentGroupId}
        allSections={allSections}
        onMoveToGroup={onMoveToGroup}
      />
    </div>
  )
}

function SortableRow({
  session,
  groupSortMode,
  isDragging,
  draggingKind,
  activeSessionName,
  showLineBefore,
  reduce,
  justDropped,
  currentGroupId,
  allSections,
  onMoveToGroup,
}: {
  session: ApiSession
  groupSortMode: GroupSortMode
  isDragging: boolean
  draggingKind: 'group' | 'session' | null
  activeSessionName: string | null
  showLineBefore: boolean
  reduce: boolean
  /** Gap 1 — 700ms drop-flash. See <SortableTileSlot>. */
  justDropped: boolean
  /** Gap 2 — the "Move to ▸" submenu lists every other group. */
  currentGroupId: string
  allSections: ReadonlyArray<Section>
  onMoveToGroup: (destGroupId: string) => void
}) {
  const sortable = useSortable({
    id: sessionDragId(session.name),
    // S11 — Match SortableTileSlot's 100ms reflow.
    transition: { duration: 100, easing: 'ease-out' },
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    // S9 — Honor prefers-reduced-motion.
    transition: reduce ? undefined : (sortable.transition ?? undefined),
    opacity: sortable.isDragging ? 0.4 : 1,
  }
  const isThisActive = activeSessionName === session.name
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      data-vr="group-row-slot"
      data-vr-session-name={session.name}
      data-vr-drag-state={
        sortable.isDragging
          ? 'lifted'
          : isDragging && !isThisActive
            ? 'reflow'
            : 'idle'
      }
      data-vr-group-sort-mode={groupSortMode}
      data-vr-just-dropped={justDropped ? 'true' : undefined}
      data-vr-drop-flash={justDropped ? 'active' : undefined}
      className="relative flex items-stretch gap-1"
    >
      {showLineBefore && (
        <div
          aria-hidden
          data-vr="row-drop-line"
          data-vr-drop-line="tile"
          className="pointer-events-none absolute -top-0.5 left-0 right-0 z-30 h-0.5 rounded-full bg-primary shadow-[0_0_0_2px_hsl(var(--background))]"
        />
      )}
      {/* Gap 1 — 700ms drop-flash overlay (row variant). Inset to cover the
          row + its drag handle without overlapping the surrounding gap. */}
      {justDropped && (
        <motion.div
          aria-hidden
          data-vr="drop-flash"
          initial={{ backgroundColor: 'hsl(var(--primary) / 0.18)' }}
          animate={{ backgroundColor: 'hsl(var(--primary) / 0)' }}
          transition={tweens.dropFlash}
          className="pointer-events-none absolute inset-0 z-10 rounded-md"
        />
      )}
      <button
        type="button"
        aria-label={`Drag ${session.name}`}
        {...sortable.attributes}
        {...sortable.listeners}
        className="flex w-7 items-center justify-center rounded-md text-muted-foreground/40 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-none"
        style={{ opacity: reduce ? 1 : undefined }}
        onClick={(e) => e.stopPropagation()}
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="6" cy="4" r="0.75" fill="currentColor" />
          <circle cx="10" cy="4" r="0.75" fill="currentColor" />
          <circle cx="6" cy="8" r="0.75" fill="currentColor" />
          <circle cx="10" cy="8" r="0.75" fill="currentColor" />
          <circle cx="6" cy="12" r="0.75" fill="currentColor" />
          <circle cx="10" cy="12" r="0.75" fill="currentColor" />
        </svg>
      </button>
      <div className="min-w-0 flex-1">
        <SessionRow session={toTileSession(session)} />
      </div>
      {/* Gap 2 — the "Move to ▸" kebab is the a11y alt path for the row
          view too. Tiny hover-revealed button (≥44pt via padding) so the
          row chrome stays calm at rest. */}
      <TileMoveToKebab
        sessionName={session.name}
        sessionLabel={session.task_summary ?? session.name}
        sessionStatus={session.status}
        currentGroupId={currentGroupId}
        allSections={allSections}
        onMoveToGroup={onMoveToGroup}
        variant="row"
      />
      {/* Silently consume props that don't affect the row render but matter
          for future expansion (suppresses unused-var lint). */}
      <span hidden data-dragging-kind={draggingKind ?? ''} />
    </div>
  )
}

// Tile wrapper — WHOLE-CARD drag hit target (M1).
//
// Listeners are spread on the ROOT so any pixel of the tile can initiate a
// drag — the Trello/Linear/Notion pattern. Click-vs-drag is differentiated
// by the MouseSensor `activationConstraint: { distance: 5 }` at the
// DndContext level: a press that moves <5px before release is a click and
// passes through to the tile's existing focus route; a press that moves ≥5px
// picks up. A small decorative grip icon in the top-right telegraphs the
// "draggable" affordance but it is NOT a separate hit target — the whole
// card is.
function SessionTileWrapper({
  session,
  sizeTier,
  listeners,
  reduce,
  tour,
  draggingKind,
  currentGroupId,
  allSections,
  onMoveToGroup,
}: {
  session: ApiSession
  sizeTier: OverviewSize
  listeners: React.HTMLAttributes<HTMLElement>
  reduce: boolean
  tour?: string
  draggingKind: 'group' | 'session' | null
  /** Gap 2 — props for the tile-level "Move to ▸" kebab. */
  currentGroupId: string
  allSections: ReadonlyArray<Section>
  onMoveToGroup: (destGroupId: string) => void
}) {
  return (
    <div
      data-vr="group-tile"
      data-tour={tour}
      data-dnd-handle
      // Whole-card hit target — listeners spread on the root. We use
      // `touch-manipulation` (not `touch-none`): the TouchSensor's
      // `delay: 300, tolerance: 5` arbitrates tap/scroll/drag in JS, so
      // we MUST NOT preempt iOS Safari's gesture router at the CSS layer
      // — `touch-none` would kill native vertical scroll on tiles. Click
      // navigation still works because <5px movement = click (distance:5
      // sensor constraint at the DndContext). Per dnd-kit Touch sensor docs.
      {...listeners}
      className="relative touch-manipulation"
      style={{ cursor: 'grab' }}
    >
      <SessionTile session={toTileSession(session)} sizeTier={sizeTier} />
      {/* Decorative drag affordance — telegraphs "this card is draggable"
          at a glance. NOT a separate hit target; the whole card is. Placed
          on the LEFT so it doesn't overlap the Move-to kebab on the right. */}
      <span
        aria-hidden
        data-vr="tile-drag-affordance"
        style={{ opacity: reduce ? 1 : undefined }}
        className="pointer-events-none absolute left-1 top-1 z-10 flex size-7 items-center justify-center rounded-md text-muted-foreground/40 opacity-0 transition-opacity group-hover/tile:opacity-100 [@media(pointer:coarse)]:opacity-60"
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="6" cy="4" r="0.75" fill="currentColor" />
          <circle cx="10" cy="4" r="0.75" fill="currentColor" />
          <circle cx="6" cy="8" r="0.75" fill="currentColor" />
          <circle cx="10" cy="8" r="0.75" fill="currentColor" />
          <circle cx="6" cy="12" r="0.75" fill="currentColor" />
          <circle cx="10" cy="12" r="0.75" fill="currentColor" />
        </svg>
      </span>
      {/* Gap 2 — tile-level "Move to ▸" kebab. Mirrors the group-header
          kebab's a11y intent: a non-drag entrypoint that lets keyboard +
          touch users move a tile between groups without ever picking up a
          drag handle. Hover-revealed (fine pointers) / always-shown
          (coarse pointers) via the kebab component itself. */}
      <TileMoveToKebab
        sessionName={session.name}
        sessionLabel={session.task_summary ?? session.name}
        sessionStatus={session.status}
        currentGroupId={currentGroupId}
        allSections={allSections}
        onMoveToGroup={onMoveToGroup}
        variant="tile"
      />
      {/* Silently consume `draggingKind` so it's tracked but doesn't
          influence render (kept for future state hooks / VR assertions). */}
      <span hidden data-vr-dragging-kind={draggingKind ?? ''} />
    </div>
  )
}

// ── TileMoveToKebab — Gap 2 + feat-tile-hover-actions ───────────────────
//
// A tiny per-tile kebab whose menu carries the FULL set of overview-context
// session actions: Info (always), Stop (when running), Archive (when not
// already stopped — a stopped tile already shows a big Archive in its peek
// body), and "Move to ▸" (the original a11y alt path for drag-drop, listed
// last because moving between groups is the rarer click-driven action).
//
// One menu, one trigger — no separate kebab + archive-icon competing for the
// same top-right real-estate. Mirrors the mobile quick-peek's action surface
// (Info / Restart / Stop|Archive) so desktop hover and mobile long-press
// share intent: the SAME `useSessionActions` hook performs Stop + Archive, and
// the SAME `<SessionInfoPanel>` component opens for Info (desktop = anchored
// Popover, mobile = bottom Sheet — the panel forks internally on pointer
// modality).
//
// Why not invent a new kebab on the bare <SessionTile>? Because group-grid
// is the only surface that wraps the tile with drag affordances AND owns the
// LayoutItem context the Move-to submenu needs. Keeping the kebab here
// scopes the chrome to the place it can act on; bare tiles outside groups
// remain calm.
//
// Variants:
//   * 'tile' — overlay on the top-right of the tile chrome (mirrors the
//     drag handle's position); hover-revealed on fine pointers,
//     always-shown on coarse.
//   * 'row' — inline on the right of the row chrome; hover-revealed on
//     fine pointers.
//
// Visual-critic hook: `data-vr-tile-kebab` on the trigger and
// `data-vr-move-to-submenu` on the submenu trigger so the VR battery can
// click through deterministically.
function TileMoveToKebab({
  sessionName,
  sessionLabel,
  sessionStatus,
  currentGroupId,
  allSections,
  onMoveToGroup,
  variant,
}: {
  sessionName: string
  sessionLabel: string
  sessionStatus: ApiSession['status']
  currentGroupId: string
  allSections: ReadonlyArray<Section>
  onMoveToGroup: (destGroupId: string) => void
  variant: 'tile' | 'row'
}) {
  // Every OTHER group, in render order. Skip the implicit Ungrouped bucket
  // ONLY if THIS tile is currently in it (you can't "Move to Ungrouped" from
  // Ungrouped — but moving a tile from a named group INTO Ungrouped is fine,
  // since the user might want to drop something out of every group).
  const targets = React.useMemo(
    () =>
      allSections.filter((sec) => {
        if (sec.groupId === currentGroupId) return false
        return true
      }),
    [allSections, currentGroupId],
  )

  // Shared lifecycle handlers — one source of truth across desktop kebab
  // and mobile quick-peek (busy guard, team-lead-aware confirm, optimistic
  // cache update, toasts). The kebab's gating decides whether to SHOW the
  // item; the hook decides whether to RUN it.
  const { busy, stop, archive } = useSessionActions(sessionName)

  // FEAT-SESSION-INFO — the SAME panel the focus-page title-click opens,
  // hosted here for overview parity. Desktop = anchored Popover (we pass
  // `infoAnchorRef` as the trigger), mobile = bottom Sheet (the panel forks
  // internally; no anchor needed for the touch path through the kebab).
  const [infoOpen, setInfoOpen] = React.useState(false)
  const infoAnchorRef = React.useRef<HTMLButtonElement>(null)
  const navigateMorph = useNavigateMorph()

  // Action visibility matrix (per user spec — keep redundancies pruned):
  //   Stop:    session is mid-flight (active / waiting / idle / starting).
  //            Skipped on 'stopped' (nothing to stop) and 'error' (the
  //            session is already dead — Archive is the actionable path).
  //   Archive: session is NOT stopped. A stopped tile already exposes a
  //            primary Archive button in its hover-peek body — listing it
  //            here too would surface Archive twice on the same tile.
  //   Move to: at least one other group exists.
  //   Info:    always.
  const canStop =
    sessionStatus === 'active' ||
    sessionStatus === 'waiting' ||
    sessionStatus === 'idle' ||
    sessionStatus === 'starting'
  const canArchive = sessionStatus !== 'stopped'
  const canMove = targets.length > 0

  const triggerClassName =
    variant === 'tile'
      ? // Overlay on the top-right of the tile (the drag affordance is
        // decorative-only since M1; the kebab is the only INTERACTIVE button
        // in the corner). Same hover-reveal pattern: invisible at rest on
        // fine pointers, always visible on coarse. ≥44pt touch target.
        'absolute right-1 top-1 z-20 flex size-9 items-center justify-center rounded-md bg-card/80 text-muted-foreground/60 backdrop-blur-sm transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/tile:opacity-100 touch-none [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:opacity-100 [@media(pointer:fine)]:opacity-0'
      : // Inline at the end of the row.
        'flex w-7 items-center justify-center rounded-md text-muted-foreground/40 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring opacity-0 transition-opacity group-hover/tile:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100'

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            ref={infoAnchorRef}
            type="button"
            aria-label={`More actions for ${sessionLabel}`}
            data-vr="tile-kebab"
            data-vr-tile-kebab="true"
            data-vr-session-name={sessionName}
            // Stop pointer events at the trigger so opening the menu doesn't
            // initiate a drag or navigate to focus.
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className={triggerClassName}
          >
            <span aria-hidden className="text-base leading-none">⋯</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          // Stop the dnd-kit sensors / tile click from firing when the user
          // interacts with the menu content.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenuItem
            data-vr="tile-info"
            disabled={busy}
            onSelect={() => setInfoOpen(true)}
          >
            <Info className="size-4" aria-hidden />
            <span>Info</span>
          </DropdownMenuItem>
          {canStop && (
            <DropdownMenuItem
              data-vr="tile-stop"
              disabled={busy}
              onSelect={() => void stop()}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              <Square className="size-4" aria-hidden />
              <span>Stop</span>
            </DropdownMenuItem>
          )}
          {canArchive && (
            <DropdownMenuItem
              data-vr="tile-archive"
              disabled={busy}
              // RUNNING-session archive also stops the pty — confirm before
              // committing. A stopped tile never reaches this branch (`canArchive`
              // is false there), so the desktop kebab's archive is always the
              // "destructive" variant; the confirm is non-negotiable.
              onSelect={() => void archive({ confirm: true })}
            >
              <Archive className="size-4" aria-hidden />
              <span>Archive</span>
            </DropdownMenuItem>
          )}
          {canMove && (
            <>
              {(canStop || canArchive) && <DropdownMenuSeparator />}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  data-vr="tile-move-to"
                  data-vr-move-to-submenu="true"
                >
                  <MoveRight className="size-4" aria-hidden />
                  <span>Move to</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent>
                    <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                      Move {sessionLabel}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {targets.map((sec) => (
                      <DropdownMenuItem
                        key={sec.groupId}
                        data-vr="tile-move-to-item"
                        data-vr-dest-group-id={sec.groupId}
                        onSelect={() => onMoveToGroup(sec.groupId)}
                      >
                        {sec.groupName}
                        {sec.sortMode !== 'custom' && (
                          <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                            {GROUP_SORT_LABEL[sec.sortMode]}
                          </span>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* FEAT-SESSION-INFO — same component as the focus-page title-click.
          Desktop forks to an anchored Popover (positions against the kebab
          trigger), mobile forks to the bottom Sheet. Cloning navigates to the
          new focus route via the morph navigation helper so the View
          Transitions handoff is consistent with tile-click navigation. */}
      <SessionInfoPanel
        name={sessionName}
        open={infoOpen}
        onOpenChange={setInfoOpen}
        triggerRef={infoAnchorRef}
        onNavigate={(name) => {
          setInfoOpen(false)
          navigateMorph(`/focus/${name}`)
        }}
      />
    </>
  )
}

// ── FullGridDropLine — the FULL-grid-width 2px horizontal drop indicator
//    rendered between group sections during group reorder. Width = 100% of
//    the grid, NOT one column — the visual articulation of "groups reorder
//    by row; columns don't matter." 8px terminal dot on the left margin
//    per the Atlassian line-indicator spec.
function FullGridDropLine({ reduce }: { reduce: boolean }) {
  return (
    <div
      data-vr="full-grid-drop-line"
      data-vr-drop-line="full"
      aria-hidden
      className="relative h-0.5 w-full"
    >
      <motion.div
        initial={reduce ? false : { scaleX: 0.6, opacity: 0 }}
        animate={{ scaleX: 1, opacity: 1 }}
        transition={reduce ? { duration: 0 } : springs.snappy}
        style={{ transformOrigin: 'left center' }}
        className="absolute inset-x-0 top-0 h-0.5 rounded-full bg-primary"
      />
      {/* 8px terminal dot on the left margin. */}
      <span
        aria-hidden
        className="absolute -left-1 -top-1 size-2 rounded-full bg-primary"
      />
    </div>
  )
}

// ── GapAddGroup — the hover-gap "+ Add group here" affordance ────────────────
function GapAddGroup({
  index,
  onPick,
  reduce,
}: {
  index: number
  onPick: () => void
  reduce: boolean
}) {
  // Desktop (`pointer: fine`) ONLY — mobile keeps the header "New group" path.
  // The hot-zone is invisible until hover (~20px high); on hover a full-width
  // 1px hairline + a small "+ Add group here" chip anchored on the LEFT fade
  // in. Click → onPick (parent opens the inline AddGroupInput).
  return (
    <div
      data-vr="gap-add-group"
      data-vr-gap-index={index}
      className="relative h-5 [@media(pointer:coarse)]:hidden"
    >
      <button
        type="button"
        aria-label={`Add a group at position ${index + 1}`}
        onClick={onPick}
        // The hot-zone is the entire 20px gap. The visible chrome
        // (hairline + chip) reveals on hover or focus-within.
        className="group/gap absolute inset-x-0 inset-y-0 flex items-center focus-visible:outline-none"
      >
        {/* Hairline — full-width 1px, fades in on hover. Duration source-of-
            truth: `tweens.gapReveal` in @/lib/springs (S10 — Tailwind class
            mirrors that token: 120ms ease-out). Under prefers-reduced-motion
            the colour swaps but no opacity tween (we drop the
            transition-opacity via the media query). */}
        <span
          aria-hidden
          className={
            'absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-primary/60 opacity-0 transition-opacity duration-[120ms] group-hover/gap:opacity-100 group-focus-visible/gap:opacity-100 motion-reduce:transition-none' +
            (reduce ? ' motion-reduce:opacity-100 motion-reduce:bg-primary/30' : '')
          }
        />
        {/* The chip on the LEFT (Notion's left-margin convention). */}
        <span
          aria-hidden
          className="relative ml-0 inline-flex items-center gap-1 rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground opacity-0 shadow-sm transition-opacity duration-[120ms] group-hover/gap:opacity-100 group-focus-visible/gap:opacity-100 motion-reduce:transition-none"
        >
          <Plus className="size-3" aria-hidden />
          Add group here
        </span>
      </button>
    </div>
  )
}

// ── Local helper — the existing TileSession coercion (the tile requires a
//    non-undefined updated_at; the API may omit it on partial deltas). ───────
function toTileSession(s: ApiSession): TileSession {
  return { ...s, updated_at: s.updated_at ?? '' }
}
