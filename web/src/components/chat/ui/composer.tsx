/**
 * The composer — VISUAL SHELL. It does not submit.
 * ─────────────────────────────────────────────────────────────────────────────
 * The approved boards:
 *
 *   pill    height 58 (52 on the phone), radius full, `--sm-surface`,
 *           0.5px hairline, blur(60px) saturate(180%),
 *           shadow `0 12px 34px -18px rgba(30,18,10,.35)`,
 *           padding 0 9 0 14 (0 7 0 12 on the phone), gap 12
 *   focus   an accent ring at 22% ADDED to that shadow — the composer is the
 *           one place the focused session's colour touches a control, and it
 *           does so as a focus state, never as a fill (concept contract C7).
 *           220ms, because a focus ring that springs reads as a glitch.
 *   plus    26×26, secondary ink — attach / `@files` / `/commands`
 *   input   15px (14.5 on the phone), placeholder in secondary ink
 *   mic     40×40 (36 on the phone), the one inverted control (`.sm-mic`)
 *
 * Deliberately absent: Enter-to-send, Shift+Enter, the Stop-replaces-Send swap,
 * the `@`/`/` popovers, auto-grow. Those are input-plane behaviour and land with
 * the renderer slice; putting them here would make the design system own the
 * data plane. The `<textarea>` is real so `:focus-within` is real — the focus
 * ring is part of the spec and has to be verifiable on the bench.
 */
import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react'
import type * as React from 'react'

import { cn } from '../../../lib/utils'

import type { ComposerField } from '../composer-draft'
import { PlainEditable } from '../plain-editable'

import { MicIcon, PlusIcon } from './icons'

/**
 * The field's props, as a contract over BOTH hosts.
 *
 * Desktop keeps the `<textarea>`; the phone is a `contenteditable`
 * (`plain-editable.tsx`) because iOS draws its prev/next/Done form-assistant
 * bar above the keyboard for form controls and for nothing else. The three
 * handlers are therefore stated in terms of what the composer actually reads
 * off them — `target.value`, `currentTarget.selectionStart`, the key — instead
 * of in terms of a tag, so one `field={{…}}` object drives either host and
 * `use-composer.ts` never learns which one it got.
 */
export type ComposerFieldProps = Omit<
  ComponentPropsWithoutRef<'textarea'>,
  'className' | 'placeholder' | 'onChange' | 'onKeyDown' | 'onSelect'
> & {
  ref?: Ref<ComposerField | null>
  onChange?: (e: { target: ComposerField }) => void
  onKeyDown?: (e: React.KeyboardEvent<Element>) => void
  onSelect?: (e: { currentTarget: ComposerField }) => void
  /** `data-*` hooks the renderer's own tests reach for. */
  [key: `data-${string}`]: string | undefined
}

export interface ComposerProps {
  /** `Message Release Train` — the session's display name is part of the copy. */
  placeholder: string
  size?: 'desktop' | 'mobile'
  /**
   * The field accepts focus (so the ring is real) but no text.
   *
   * A3's surface cannot send a key yet, and a composer that swallows keystrokes
   * silently would be the one thing this design must never be — confidently
   * wrong. `readOnly` (not `disabled`) is the honest rung: the pill keeps the
   * boards' full contrast and its focus ring, and the caller reveals its own
   * "why" line on focus (`components/chat/composer-shell.tsx`).
   */
  readOnly?: boolean
  /** Rendered in place of the mic (a later slice swaps in Stop while Active). */
  trailing?: ReactNode
  /**
   * Rendered in place of the decorative `+` (fase A4 T3 gives it a real menu).
   * A SLOT, like `trailing`: the shell keeps owning the 26×26 cell and its ink,
   * the renderer owns what happens when it is tapped.
   */
  leading?: ReactNode
  /**
   * The field's own props — `value`/`onChange`/`onKeyDown`/`ref` when a renderer
   * has an input plane to wire them to (fase A4 T3). Absent, the shell renders
   * exactly what it always did: an uncontrolled, read-only field whose only job
   * is to make the focus ring real. `className` is not accepted; the pill's
   * typography is B0's, not the caller's.
   */
  field?: ComposerFieldProps
  /**
   * The pill is TALL right now — multi-line text, or a chip row above the field.
   * A stadium (`rounded-full`) at 100px reads as a giant pill, so the corner
   * softens to a fixed 26px radius only while grown; at rest (single line, no
   * chips) it stays `rounded-full` and the boards are byte-identical. Optional,
   * defaults false — an unwired caller renders exactly as before.
   */
  grown?: boolean
  className?: string
}

/** The field's typography, shared by both hosts so the swap is invisible: the
 *  pill's own metrics, and the 16px iOS no-zoom floor on the phone. */
const FIELD =
  'min-w-0 flex-1 bg-transparent py-[7px] tracking-[-0.1px] text-ink outline-none max-h-[120px] overflow-y-auto'

export function Composer({
  placeholder,
  size = 'desktop',
  readOnly,
  trailing,
  leading,
  field,
  grown,
  className,
}: ComposerProps) {
  const mobile = size === 'mobile'
  // The ref is the ONE prop the two hosts cannot share verbatim: React types it
  // by the tag it lands on. `HTMLTextAreaElement` satisfies `ComposerField`, so
  // narrowing it for the textarea branch is sound — it really is a textarea.
  const {
    ref: fieldRef,
    value,
    onChange,
    onKeyDown,
    onSelect,
    spellCheck,
    enterKeyHint,
    role,
    // Pulled OUT of `rest` so it reaches BOTH hosts the same way. `field.readOnly`
    // is how the live composer says "this session is blocked" (`composer.tsx`);
    // the textarea used to pick it up off the `rest` spread, but the
    // contenteditable maps editability to `contentEditable`, not to a `readonly`
    // attribute — a `readonly` left on `rest` would be an inert no-op on the div
    // and a blocked phone composer would stay typable. OR-ed with B0's own
    // `readOnly` (the A3 read-only preview) so either source disables either host.
    readOnly: fieldReadOnly,
    ...rest
  } = field ?? ({} as ComposerFieldProps)
  const effectiveReadOnly = readOnly || fieldReadOnly
  const fieldRest = { ...rest, value, onChange, onKeyDown, onSelect, spellCheck, enterKeyHint, role }
  const fieldParts = {
    ref: fieldRef,
    value: typeof value === 'string' ? value : '',
    onChange,
    onKeyDown,
    onSelect,
    spellCheck: spellCheck ?? true,
    enterKeyHint,
    role,
    rest: rest as Record<string, unknown>,
  }
  return (
    <div
      className={cn(
        // `items-end`, not `items-center`: the `+`, the growing field and the
        // send/mic disc all sit on the LAST line's baseline, so the side discs
        // stay pinned to the bottom edge as the field grows up — the exact
        // ChatGPT / Claude / Grok geometry. The vertical breathing that
        // `items-center` used to do moves into symmetric `py`, so the
        // single-line rest state keeps its 58/52px height (disc 40 + 9 + 9 = 58)
        // and the discs do not shift.
        'sm-composer flex items-end border-[0.5px] border-hairline bg-surface',
        grown ? 'rounded-[26px]' : 'rounded-full',
        'backdrop-blur-[60px] backdrop-saturate-[180%]',
        'shadow-[var(--sm-popover-shadow)]',
        'sm-t-morph',
        'focus-within:shadow-[0_0_0_1px_color-mix(in_oklab,var(--sm-accent)_22%,transparent),var(--sm-popover-shadow)]',
        mobile
          ? 'min-h-[52px] gap-3 pl-3 pr-[7px] py-1.5'
          : 'min-h-[58px] gap-3 pl-3.5 pr-[9px] py-[9px]',
        className,
      )}
    >
      {leading ?? (
        // `self-center`: the row is `items-end` (so the live composer's discs
        // bottom-anchor as the field grows), but this decorative fallback `+`
        // is a 26px glyph, not a 40px disc — keeping it centered holds the
        // read-only boards byte-identical.
        <span aria-hidden className="grid size-[26px] flex-none place-items-center self-center text-ink-2">
          <PlusIcon />
        </span>
      )}
      {mobile ? (
        // THE PHONE IS A CONTENTEDITABLE, and the reason is one sentence: iOS
        // Safari draws the prev/next/Done form-assistant strip above the
        // keyboard for `<input>`/`<textarea>` and for nothing else, so the only
        // way to be rid of it — the way WhatsApp Web and Slack are rid of it —
        // is for the message box not to be a form control. Everything the
        // textarea did comes back through `plain-editable.tsx`; the typography
        // below is byte-identical, 16px floor included.
        <PlainEditable
          {...fieldParts}
          placeholder={placeholder}
          readOnly={effectiveReadOnly}
          className={cn(FIELD, 'overflow-y-auto whitespace-pre-wrap break-words', 'text-[16px]')}
        />
      ) : (
        <textarea
          rows={1}
          placeholder={placeholder}
          aria-label={placeholder}
          readOnly={effectiveReadOnly}
          {...fieldRest}
          ref={fieldRef as Ref<HTMLTextAreaElement>}
          className={cn(FIELD, 'resize-none placeholder:text-ink-2', 'text-[15px]')}
        />
      )}
      {trailing ?? (
        <span
          aria-hidden
          className={cn(
            'sm-mic grid flex-none place-items-center self-center rounded-full',
            mobile ? 'size-9' : 'size-10',
          )}
        >
          <MicIcon />
        </span>
      )}
    </div>
  )
}
