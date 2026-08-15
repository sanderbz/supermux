// The composer's DRAFT STORE and the insert seam (fase A4 T3).
//
// Split out of `use-composer.ts` for one reason, and it is a budget reason with
// a design consequence: `desktop-split.tsx` — which is in the ENTRY chunk —
// needs `composerSessionInput` to route its insert surfaces (snippets,
// attachments, the dock) into the chat composer, and importing the hook module
// for it would drag the whole composer behaviour out of the lazy chat chunk and
// into the hero path. This module is what the entry pays for: two Maps, the
// text arithmetic, and no React at all.
//
// WHY MODULE-LEVEL. The draft must survive the chat panel unmounting: toggling
// to Terminal and back is a remount, and losing half a typed message to a
// renderer toggle is the kind of small betrayal that stops people using a
// surface (master plan §6.2 carry-over). It is deliberately NOT the zustand UI
// store either — a draft is not app state, it is one surface's scratch paper,
// and putting it there would re-render the shell on every keystroke.

import type { SessionInput } from '../../lib/session-input'

import { insertAtCaret, type Selection } from './composer-insert'

/** The textarea's ceiling — the same 120px `ui/composer.tsx` caps the field at.
 *  Beyond it the field scrolls instead of growing, so the transcript never
 *  disappears behind a composer that ate the pane. */
export const COMPOSER_MAX_H = 120

const drafts = new Map<string, string>()
const listeners = new Map<string, Set<() => void>>()
/** Session → its mounted textarea (or null when the panel is not mounted). The
 *  caret lives on the DOM node, so an insert that arrives while the composer is
 *  unmounted still lands — at the end of the draft, which is where it belongs
 *  when nobody is looking at a caret. */
const fields = new Map<string, () => HTMLTextAreaElement | null>()

function emit(name: string): void {
  listeners.get(name)?.forEach((fn) => fn())
}

export function getDraft(name: string): string {
  return drafts.get(name) ?? ''
}

export function setDraft(name: string, value: string): void {
  if (getDraft(name) === value) return
  if (value === '') drafts.delete(name)
  else drafts.set(name, value)
  emit(name)
}

/** Subscribe to one session's draft (the hook's `useSyncExternalStore`). */
export function subscribeDraft(name: string, fn: () => void): () => void {
  const set = listeners.get(name) ?? new Set()
  set.add(fn)
  listeners.set(name, set)
  return () => {
    set.delete(fn)
    if (set.size === 0) listeners.delete(name)
  }
}

/** Register the mounted field. Returns the unbind, for the effect's cleanup. */
export function bindComposerField(
  name: string,
  get: () => HTMLTextAreaElement | null,
): () => void {
  fields.set(name, get)
  return () => {
    if (fields.get(name) === get) fields.delete(name)
  }
}

function fieldFor(name: string): HTMLTextAreaElement | null {
  return fields.get(name)?.() ?? null
}

/** Focus the React composer — the REST plane's "cursor" (`rest.ts` delegates
 *  `focus()` here through `composerSessionInput`). */
export function focusComposer(name: string): void {
  fieldFor(name)?.focus()
}

/**
 * Insert text at the composer's caret, from anywhere in the app.
 *
 * The caret is read from the live DOM node rather than from React state
 * because that is where it actually is; the selection is restored after the
 * controlled re-render (one frame later — React has not written the new value
 * to the node yet at the moment this returns).
 */
export function insertIntoComposer(
  name: string,
  text: string,
  /** Replace THIS range instead of the live selection (fase A4 T9: accepting a
   *  `@`/`/` pick overwrites the token that opened the popover, and the caret
   *  the DOM reports may already have moved on). */
  selection?: Selection,
): number {
  const el = fieldFor(name)
  const draft = getDraft(name)
  const sel: Selection =
    selection ??
    (el && el.selectionStart != null && el.selectionEnd != null
      ? { start: el.selectionStart, end: el.selectionEnd }
      : draft.length)
  const next = insertAtCaret(draft, sel, text)
  setDraft(name, next.draft)
  if (!el) return next.caret
  el.focus()
  const place = () => {
    const node = fieldFor(name)
    if (!node) return
    node.setSelectionRange(next.caret, next.caret)
    growTextarea(node)
  }
  if (typeof window !== 'undefined' && window.requestAnimationFrame) {
    window.requestAnimationFrame(place)
  } else {
    place()
  }
  return next.caret
}

/**
 * A `SessionInput` whose INSERT lands in the React composer.
 *
 * `submit` and `sendKey` still go to the session (the REST plane, passed in as
 * `base`) — only "put this text where the user can see and edit it" is
 * re-routed. That asymmetry is the point: the snippet panel's "Insert" means
 * *stage it*, its "Run" means *send it*, and both keep their meaning when the
 * chat renderer is the one mounted.
 */
export function composerSessionInput(
  name: string,
  base: SessionInput,
): SessionInput {
  return {
    submit: (text: string) => base.submit(text),
    insert: (text: string) => {
      insertIntoComposer(name, text)
      return Promise.resolve()
    },
    sendKey: (key) => base.sendKey(key),
    focus: () => focusComposer(name),
    blur: () => fieldFor(name)?.blur(),
  }
}

/** Auto-grow: reset, then take the content height, capped. Reading
 *  `scrollHeight` after the reset is what makes the field SHRINK again when a
 *  line is deleted. */
export function growTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_H)}px`
}

