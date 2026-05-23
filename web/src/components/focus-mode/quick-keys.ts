// Quick-keys library — the curated tap-to-send catalog + selection model
// (R5 quick-keys, see skill/review/quick-keys-library.plan.md).
//
// Replaces the "type the special key" model of the old Specials sheet with a
// curated library of the most-used Claude-Code actions. Each entry maps to the
// EXISTING send path (no new wire):
//   • kind 'key'   → term.sendKey(payload)        (named key → keyToBytes bytes)
//   • kind 'text'  → term.send(payload + '\r')    (a typed reply + Enter)
//   • kind 'slash' → term.send(payload + '\r')    (run a slash command)
//   • kind 'snippet'→term.send(payload + '\r')    (run a snippet body)
//
// The STATIC half (Control + Replies) lives here as constants. The DYNAMIC half
// (Slash + Snippets) is merged in at render from the live query hooks, so the
// catalog always reflects the live command/snippet sets with zero extra fetch.
//
// Persistence: an ordered list of entry ids in the server pref `quick_keys`
// (allowlisted in server/src/prefs.rs), parsed/serialized exactly like
// overview_layout — opaque blob, SSE-synced, 404-as-unset graceful fallback.

import type { LucideIcon } from 'lucide-react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  Delete,
  Square,
  Eraser,
  ListRestart,
} from 'lucide-react'

import type { SlashCommand, SnippetRow } from '@/lib/api'

export type QuickKind = 'key' | 'text' | 'slash' | 'snippet'

export type QuickGroup = 'control' | 'replies' | 'slash' | 'snippets'

export interface QuickEntry {
  /** Stable id — `key:<Name>` / `text:<slug>` / `slash:<cmd>` / `snippet:<id>`.
   *  Stable so a selection survives a catalog edit; slash/snippet ids dedupe
   *  against the live lists. */
  id: string
  /** Chip face, sentence-case (e.g. "Interrupt", "Continue"). */
  label: string
  kind: QuickKind
  /** What gets sent (see the send-path table at the top). */
  payload: string
  /** Optional leading glyph (mostly for 'key' entries). */
  icon?: LucideIcon
  /** Picker grouping only. */
  group: QuickGroup
}

/** Section labels for the grouped chip grid + picker, in display order. */
export const GROUP_LABELS: Record<QuickGroup, string> = {
  control: 'Control',
  replies: 'Replies',
  slash: 'Commands',
  snippets: 'Snippets',
}

export const GROUP_ORDER: QuickGroup[] = ['control', 'replies', 'slash', 'snippets']

// ── Static catalog: Control (kind 'key') ──────────────────────────────────────
// Every payload is a name `keyToBytes` already understands (use-live-term.ts) —
// no new key names introduced.

export const CONTROL_ENTRIES: QuickEntry[] = [
  { id: 'key:Esc', label: 'Interrupt', kind: 'key', payload: 'Esc', icon: Square, group: 'control' },
  { id: 'key:Ctrl-C', label: 'Stop', kind: 'key', payload: 'Ctrl-C', icon: Square, group: 'control' },
  { id: 'key:Tab', label: 'Cycle mode', kind: 'key', payload: 'Tab', group: 'control' },
  { id: 'key:Enter', label: 'Enter', kind: 'key', payload: 'Enter', icon: CornerDownLeft, group: 'control' },
  { id: 'key:Ctrl-U', label: 'Clear line', kind: 'key', payload: 'Ctrl-U', icon: Eraser, group: 'control' },
  { id: 'key:Up', label: 'Up', kind: 'key', payload: 'Up', icon: ArrowUp, group: 'control' },
  { id: 'key:Down', label: 'Down', kind: 'key', payload: 'Down', icon: ArrowDown, group: 'control' },
  { id: 'key:Left', label: 'Left', kind: 'key', payload: 'Left', icon: ArrowLeft, group: 'control' },
  { id: 'key:Right', label: 'Right', kind: 'key', payload: 'Right', icon: ArrowRight, group: 'control' },
  { id: 'key:BackTab', label: 'Cycle back', kind: 'key', payload: 'BackTab', group: 'control' },
  { id: 'key:Backspace', label: 'Backspace', kind: 'key', payload: 'Backspace', icon: Delete, group: 'control' },
  { id: 'key:PageUp', label: 'Scroll up', kind: 'key', payload: 'PageUp', group: 'control' },
  { id: 'key:PageDown', label: 'Scroll down', kind: 'key', payload: 'PageDown', icon: ListRestart, group: 'control' },
]

// ── Static catalog: Common replies (kind 'text', sent as payload + '\r') ──────

export const REPLY_ENTRIES: QuickEntry[] = [
  { id: 'text:continue', label: 'Continue', kind: 'text', payload: 'continue', group: 'replies' },
  { id: 'text:go-on', label: 'Go on', kind: 'text', payload: 'go on', group: 'replies' },
  { id: 'text:stop', label: 'Stop', kind: 'text', payload: 'stop', group: 'replies' },
  { id: 'text:yes', label: 'Yes', kind: 'text', payload: 'yes', group: 'replies' },
  { id: 'text:no', label: 'No', kind: 'text', payload: 'no', group: 'replies' },
  { id: 'text:y', label: 'Y', kind: 'text', payload: 'y', group: 'replies' },
  { id: 'text:n', label: 'N', kind: 'text', payload: 'n', group: 'replies' },
  { id: 'text:1', label: '1', kind: 'text', payload: '1', group: 'replies' },
  { id: 'text:2', label: '2', kind: 'text', payload: '2', group: 'replies' },
  { id: 'text:3', label: '3', kind: 'text', payload: '3', group: 'replies' },
]

/** The static (always-available) half of the catalog. */
export const STATIC_ENTRIES: QuickEntry[] = [...CONTROL_ENTRIES, ...REPLY_ENTRIES]

/** Default selection — useful with ZERO setup (noob-proof). 12 chips covering
 *  the most common phone actions: interrupt a runaway agent, accept/cycle modes,
 *  nav a menu, answer a yes/no or numbered prompt, continue. Slash/snippets
 *  start empty (discoverable via Edit; snippets may not exist on a fresh
 *  install). Lives here next to the catalog. */
export const DEFAULT_QUICK_SELECTION: string[] = [
  'key:Esc',
  'key:Ctrl-C',
  'key:Tab',
  'key:Up',
  'key:Down',
  'key:Enter',
  'text:continue',
  'text:stop',
  'text:1',
  'text:2',
  'text:yes',
  'text:no',
]

/** Pref key in the server's `prefs` table (allowlisted server-side). */
export const QUICK_KEYS_PREF_KEY = 'quick_keys'

// ── Dynamic catalog builders ──────────────────────────────────────────────────

/** Build the live Slash-command entries from `useSlashCommands()`. */
export function slashEntries(commands: ReadonlyArray<SlashCommand>): QuickEntry[] {
  return commands.map((c) => ({
    id: `slash:${c.cmd}`,
    label: c.cmd,
    kind: 'slash' as const,
    payload: c.cmd,
    group: 'slash' as const,
  }))
}

/** Build the live Snippet entries from `useSnippets()`. */
export function snippetEntries(snippets: ReadonlyArray<SnippetRow>): QuickEntry[] {
  return snippets.map((s) => ({
    id: `snippet:${s.id}`,
    label: s.title,
    kind: 'snippet' as const,
    payload: s.body,
    group: 'snippets' as const,
  }))
}

/** Merge static + live into the full ordered catalog (Control → Replies →
 *  Slash → Snippets), the universe the Edit picker offers. */
export function buildCatalog(
  commands: ReadonlyArray<SlashCommand>,
  snippets: ReadonlyArray<SnippetRow>,
): QuickEntry[] {
  return [...STATIC_ENTRIES, ...slashEntries(commands), ...snippetEntries(snippets)]
}

/** Resolve an ordered id list into entries against the live catalog, dropping
 *  ids whose source vanished (a deleted snippet, a renamed command) — same
 *  reconcile philosophy as `reconcileCustomLayout`. Order is preserved (the id
 *  order IS the chip order). Pure; never mutates inputs. */
export function resolveSelection(
  ids: ReadonlyArray<string>,
  catalog: ReadonlyArray<QuickEntry>,
): QuickEntry[] {
  const byId = new Map(catalog.map((e) => [e.id, e]))
  const out: QuickEntry[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    const entry = byId.get(id)
    if (entry) {
      seen.add(id)
      out.push(entry)
    }
  }
  return out
}

// ── parse / serialize the opaque pref blob (modeled on overview-layout.ts) ────

export interface QuickKeysPref {
  /** Ordered entry ids — the order IS the chip order. */
  selected: string[]
}

/** Parse the opaque pref string. Defensive against any malformed value; falls
 *  back to the default selection so the panel is never empty. A null/unset value
 *  (404-as-unset from getPref) also yields the default. */
export function parseQuickKeys(raw: string | null | undefined): QuickKeysPref {
  if (!raw) return { selected: [...DEFAULT_QUICK_SELECTION] }
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return { selected: [...DEFAULT_QUICK_SELECTION] }
  }
  if (!obj || typeof obj !== 'object') return { selected: [...DEFAULT_QUICK_SELECTION] }
  const o = obj as Record<string, unknown>
  if (!Array.isArray(o.selected)) return { selected: [...DEFAULT_QUICK_SELECTION] }
  const selected = o.selected.filter((id): id is string => typeof id === 'string')
  // An explicitly-empty selection IS a valid choice (the user toggled all off),
  // so we keep it as-is rather than re-seeding the default.
  return { selected }
}

export function serializeQuickKeys(pref: QuickKeysPref): string {
  return JSON.stringify(pref)
}
