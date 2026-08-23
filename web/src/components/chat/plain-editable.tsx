/**
 * The phone composer's field — a contenteditable that behaves like a textarea.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, and it is the whole reason: iOS Safari draws a FORM
 * ASSISTANT above the keyboard for `<input>` and `<textarea>` — the dark strip
 * with the grey ‹ › chevrons and a Done button, sitting between the QuickType
 * suggestions and the keys. It costs ~44pt of a 390×844 screen on every single
 * keystroke, it is not stylable, and there is no attribute, meta tag or CSS
 * property that turns it off. WhatsApp, Messenger and Slack on the web all show
 * no such bar, and they all do the same thing: the message box is not a form
 * control at all. iOS renders the form-navigation accessory ONLY for form
 * controls; a `contenteditable` host gets the keyboard and nothing above it.
 *
 * That is the technique, and it is the only one — which is why this file is
 * worth its length. It cannot be verified in this repo: the bar is a UIKit
 * artifact of the real device, so no headless browser (Chromium OR WebKit on
 * Linux) can render it. What CAN be verified offline is everything the swap
 * must not break, and that is what the tests pin.
 *
 * WHAT THE TEXTAREA GAVE US, AND HOW EACH PIECE COMES BACK.
 *
 *   value / onChange     the element carries a real `value` accessor (see
 *                        `augment`), so `use-composer.ts` reads `e.target.value`
 *                        exactly as before and nothing upstream knows.
 *   selectionStart/End   mapped from the live DOM Range to a CHARACTER offset
 *                        over the field's plain text — the `@`/`/` picker reads
 *                        the trigger at the caret, so this has to be exact.
 *   setSelectionRange    the inverse map. `insertIntoComposer` places the caret
 *                        after a pick with it.
 *   auto-grow            unchanged: `growTextarea` still writes `style.height`
 *                        from `scrollHeight`, which a block div reports the same
 *                        way a textarea does.
 *   Enter / Shift+Enter  unchanged: `use-composer`'s `onKeyDown` runs first and
 *                        `preventDefault`s a submit; a `newline` intent falls
 *                        through to the browser, which breaks the line itself.
 *   paste as plain text  `plaintext-only` does it natively; the explicit `paste`
 *                        handler is the fallback for engines that quietly
 *                        degrade the keyword to plain `true`.
 *   16px                 kept by the caller (`ui/composer.tsx`). It is the iOS
 *                        no-zoom floor for contenteditables exactly as it is for
 *                        fields — the swap does not buy an exemption.
 *   placeholder          CSS, off `data-placeholder` + `data-empty`, because an
 *                        editable host is never `:empty` (browsers park a `<br>`
 *                        in it).
 *
 * THE ONE THING THAT IS GENUINELY DIFFERENT: there is no native "Done", because
 * the bar that carried it is gone. That is BUG 2's second half and it lives in
 * `use-tap-to-dismiss.ts` — a plain tap in the transcript blurs the field, which
 * is what WhatsApp does and what every user of a chat app already expects.
 */
import * as React from 'react'

import { cn } from '../../lib/utils'

import type { ComposerField } from './composer-draft'

/** Elements that start a new line when the engine wraps typed text in them.
 *  WebKit's `plaintext-only` normally keeps a single text node with real `\n`
 *  (we set `white-space: pre-wrap`), but Blink has historically produced
 *  `<div>` blocks and `<br>`s, and an engine is allowed to change its mind. The
 *  reader below is written so it does not care which. */
const BLOCK = /^(DIV|P|LI|UL|OL|BLOCKQUOTE|PRE|H[1-6]|SECTION|ARTICLE)$/

/** A plain-text reading of an editable host, plus the map back to the DOM. */
interface TextMap {
  text: string
  /** Every text node, with the character index its content starts at. */
  segments: { node: Text; start: number }[]
  /** Where each node's content begins / ends, for element-anchored ranges. */
  starts: Map<Node, number>
  ends: Map<Node, number>
}

/**
 * THE TRAILING SCAFFOLDING, which every engine adds and no draft should carry.
 *
 * An editable host has to keep the caret reachable on the line AFTER the last
 * one, so it parks something there: Blink appends a bare `\n` to the text node
 * (`ab` + Shift+Enter reads as `"ab\n\n"`), WebKit has historically appended a
 * `<br>`. Either way it is one line break of scaffolding, not content — a
 * textarea holding the same draft has `"ab\n"` — and counting it would put a
 * phantom newline on the end of every multi-line message, and arm the
 * `draft.trim()` send gate on a box the user only pressed Enter in.
 *
 * The two forms are ALTERNATIVES, never both, so exactly one is dropped: the
 * bogus `<br>` if there is one, otherwise a single trailing `\n`.
 */
function bogusTrailingBr(root: HTMLElement): Node | null {
  let node: Node | null = root
  while (node && node.lastChild) node = node.lastChild
  return node && node.nodeName === 'BR' ? node : null
}

/** Read the field as plain text, recording the map back to DOM positions. */
function readMap(root: HTMLElement): TextMap {
  const map: TextMap = { text: '', segments: [], starts: new Map(), ends: new Map() }
  const bogus = bogusTrailingBr(root)
  const walk = (parent: Node): void => {
    map.starts.set(parent, map.text.length)
    for (const child of Array.from(parent.childNodes)) {
      map.starts.set(child, map.text.length)
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child as Text
        map.segments.push({ node: text, start: map.text.length })
        map.text += text.data
      } else if (child.nodeName === 'BR') {
        if (child !== bogus) map.text += '\n'
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (BLOCK.test(child.nodeName) && map.text.length > 0 && !map.text.endsWith('\n')) {
          map.text += '\n'
        }
        walk(child)
      }
      map.ends.set(child, map.text.length)
    }
    map.ends.set(parent, map.text.length)
  }
  walk(root)
  // The Blink form of the same scaffolding (see `bogusTrailingBr`). Only when
  // there was no bogus `<br>` to drop — an engine does one or the other.
  if (bogus === null && map.text.endsWith('\n')) map.text = map.text.slice(0, -1)
  return map
}

/** A DOM position (the pair a Range carries) → a character offset. */
function offsetOf(map: TextMap, node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    const seg = map.segments.find((s) => s.node === node)
    if (!seg) return map.text.length
    // Clamped to the TRIMMED length: a caret parked on the scaffolding line is
    // the end of the draft, not one past it.
    return Math.min(seg.start + Math.min(offset, (node as Text).data.length), map.text.length)
  }
  // An element anchor: `offset` is a CHILD INDEX, so the position is where that
  // child starts — or, past the last child, where the element ends.
  const child = node.childNodes[offset]
  if (child) return map.starts.get(child) ?? map.text.length
  return map.ends.get(node) ?? map.text.length
}

/** A character offset → the DOM position to put a Range boundary at. */
function positionOf(root: HTMLElement, map: TextMap, index: number): [Node, number] {
  const want = Math.max(0, Math.min(index, map.text.length))
  for (const seg of map.segments) {
    const end = seg.start + seg.node.data.length
    if (want <= end) return [seg.node, Math.max(0, want - seg.start)]
  }
  const last = map.segments[map.segments.length - 1]
  if (last) return [last.node, last.node.data.length]
  return [root, 0]
}

/**
 * Write `text` into the host so that reading it back gives `text` again.
 *
 * The round trip is not free: `readMap` drops one trailing line break as
 * scaffolding, so writing a draft that genuinely ends in a newline has to put
 * the scaffolding back — otherwise the controlled sync below would see a
 * mismatch on every render and rewrite the field forever.
 */
function writeText(root: HTMLElement, text: string): void {
  root.textContent = text.endsWith('\n') ? `${text}\n` : text
}

/**
 * Give the host the four textarea members the rest of the composer calls.
 *
 * Defined ON THE NODE rather than on a wrapper object because that is what the
 * callers hold: `composer-draft.ts` publishes a `() => ref.current` getter to
 * the whole app, and `insertIntoComposer` reaches through it from the snippet
 * drawer, the dock and the `@`/`/` picker. A wrapper would have to be threaded
 * through every one of those seams; four properties are not.
 */
function augment(root: HTMLElement, caret: { current: number }): void {
  const selectionIn = (): Range | null => {
    const sel = typeof window === 'undefined' ? null : window.getSelection?.()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    return root.contains(range.startContainer) ? range : null
  }
  Object.defineProperties(root, {
    value: {
      configurable: true,
      get: () => readMap(root).text,
      set: (next: string) => {
        if (readMap(root).text === next) return
        writeText(root, next)
      },
    },
    selectionStart: {
      configurable: true,
      get: () => {
        const range = selectionIn()
        if (!range) return caret.current
        return offsetOf(readMap(root), range.startContainer, range.startOffset)
      },
    },
    selectionEnd: {
      configurable: true,
      get: () => {
        const range = selectionIn()
        if (!range) return caret.current
        return offsetOf(readMap(root), range.endContainer, range.endOffset)
      },
    },
    setSelectionRange: {
      configurable: true,
      value: (start: number, end: number) => {
        const sel = typeof window === 'undefined' ? null : window.getSelection?.()
        if (!sel) return
        const map = readMap(root)
        const range = document.createRange()
        const [sn, so] = positionOf(root, map, start)
        const [en, eo] = positionOf(root, map, end)
        range.setStart(sn, so)
        range.setEnd(en, eo)
        sel.removeAllRanges()
        sel.addRange(range)
        caret.current = Math.min(start, end)
      },
    },
  })
}

export interface PlainEditableProps {
  /** The draft. Applied to the DOM only when it actually diverges — writing on
   *  every render would fight the IME and eat the caret mid-word. */
  value: string
  placeholder: string
  /** The pill's own typography, from `ui/composer.tsx`. */
  className?: string
  readOnly?: boolean
  onChange?: (e: { target: ComposerField }) => void
  onKeyDown?: (e: React.KeyboardEvent<Element>) => void
  /** Caret moves. There is no `select` event on an editable host, so this is
   *  driven off `selectionchange` while the field has focus. */
  onSelect?: (e: { currentTarget: ComposerField }) => void
  spellCheck?: React.HTMLAttributes<HTMLElement>['spellCheck']
  enterKeyHint?: React.HTMLAttributes<HTMLElement>['enterKeyHint']
  role?: string
  /** `aria-*` / `data-*` the composer already sets on the field. */
  rest?: Record<string, unknown>
  ref?: React.Ref<ComposerField | null>
}

export function PlainEditable({
  value,
  placeholder,
  className,
  readOnly,
  onChange,
  onKeyDown,
  onSelect,
  spellCheck = true,
  enterKeyHint,
  role,
  rest,
  ref,
}: PlainEditableProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const caret = React.useRef(0)
  // Latest-callback refs so the mount-time listeners below always call the
  // CURRENT prop without rebinding. The sync happens in a passive effect (not
  // during render — react-hooks/refs forbids writing a ref while rendering);
  // both `.current`s are read only from event handlers that fire after commit,
  // so an after-render write is on time.
  const onChangeRef = React.useRef(onChange)
  const onSelectRef = React.useRef(onSelect)
  React.useEffect(() => {
    onChangeRef.current = onChange
    onSelectRef.current = onSelect
  })

  // The node has to answer `value` / `selectionStart` BEFORE anything reads it,
  // and `bindComposerField` (in `use-composer.ts`) publishes the getter in an
  // effect — so this is a layout effect, one commit earlier.
  React.useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    augment(host, caret)
  }, [])

  // Hand the augmented node up as the composer's field.
  React.useImperativeHandle(ref, () => hostRef.current as unknown as ComposerField, [])

  // CONTROLLED, BUT ONLY WHEN IT DIVERGES. In the ordinary typing loop the
  // store already holds what the DOM holds (the input handler wrote it), so
  // this is a no-op and the caret, the IME's marked text and iOS's autocorrect
  // underline all survive. It fires for real on the paths that change the draft
  // from OUTSIDE the field: a `@`-pick, a snippet, dictation, a restored draft
  // after a renderer toggle, and the clear after a send.
  React.useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (readMap(host).text === value) return
    writeText(host, value)
    // Nothing else knows where the caret should be after an outside write, and
    // the end of the draft is where it belongs — `insertIntoComposer` moves it
    // to the exact spot a frame later when it has one to name.
    caret.current = value.length
  }, [value])

  // Caret tracking. `selectionchange` is a DOCUMENT event (there is no `select`
  // on an editable host), so it is bound only while this field owns the caret.
  React.useEffect(() => {
    const host = hostRef.current
    if (!host || typeof document === 'undefined') return
    const onSelectionChange = () => {
      if (document.activeElement !== host) return
      const field = host as unknown as ComposerField
      caret.current = field.selectionStart ?? caret.current
      onSelectRef.current?.({ currentTarget: field })
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  const handleInput = React.useCallback(() => {
    const host = hostRef.current
    if (!host) return
    const field = host as unknown as ComposerField
    caret.current = field.selectionStart ?? field.value.length
    onChangeRef.current?.({ target: field })
  }, [])

  // PASTE IS PLAIN TEXT. `contenteditable="plaintext-only"` promises this, and
  // WebKit keeps the promise — but an engine that does not recognise the keyword
  // falls back to plain `true`, and then a paste from a webpage brings its
  // markup, its fonts and its colours into the composer. One handler closes
  // that door for every engine, and it costs nothing where the keyword works.
  const handlePaste = React.useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData?.getData('text/plain')
    if (text == null) return
    e.preventDefault()
    // `insertText` keeps the browser's own undo stack intact, which a manual
    // range splice would throw away.
    document.execCommand('insertText', false, text)
  }, [])

  const empty = value.length === 0
  return (
    <div
      {...rest}
      ref={hostRef}
      // `plaintext-only` is the point: it gives the box the keyboard, the
      // caret, autocorrect and dictation, while refusing rich text, nested
      // blocks and every other editable-host surprise. `readOnly` maps to a
      // non-editable host — the blocked composer stays selectable and copyable,
      // which is the promise `composer.tsx` makes about it.
      contentEditable={readOnly ? false : 'plaintext-only'}
      suppressContentEditableWarning
      role={role ?? 'textbox'}
      aria-multiline="true"
      aria-label={placeholder}
      data-placeholder={placeholder}
      data-empty={empty ? '' : undefined}
      spellCheck={spellCheck}
      autoCapitalize="sentences"
      autoCorrect="on"
      enterKeyHint={enterKeyHint}
      onInput={handleInput}
      onKeyDown={onKeyDown}
      onPaste={handlePaste}
      className={cn('sm-plain-editable', className)}
    />
  )
}
