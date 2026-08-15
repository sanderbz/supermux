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
import type { ComponentPropsWithRef, ReactNode } from 'react'

import { cn } from '../../../lib/utils'

import { MicIcon, PlusIcon } from './icons'

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
  field?: Omit<ComponentPropsWithRef<'textarea'>, 'className' | 'placeholder'> & {
    /** `data-*` hooks the renderer's own tests reach for. */
    [key: `data-${string}`]: string | undefined
  }
  className?: string
}

export function Composer({
  placeholder,
  size = 'desktop',
  readOnly,
  trailing,
  leading,
  field,
  className,
}: ComposerProps) {
  const mobile = size === 'mobile'
  return (
    <div
      className={cn(
        'sm-composer flex items-center rounded-full border-[0.5px] border-hairline bg-surface',
        'backdrop-blur-[60px] backdrop-saturate-[180%]',
        'shadow-[0_12px_34px_-18px_rgba(30,18,10,0.35)]',
        'transition-shadow duration-[220ms] ease-[cubic-bezier(.22,1,.36,1)]',
        'focus-within:shadow-[0_0_0_1px_color-mix(in_oklab,var(--sm-accent)_22%,transparent),0_12px_34px_-18px_rgba(30,18,10,0.35)]',
        mobile ? 'min-h-[52px] gap-3 pl-3 pr-[7px]' : 'min-h-[58px] gap-3 pl-3.5 pr-[9px]',
        className,
      )}
    >
      {leading ?? (
        <span aria-hidden className="grid size-[26px] flex-none place-items-center text-ink-2">
          <PlusIcon />
        </span>
      )}
      <textarea
        rows={1}
        placeholder={placeholder}
        aria-label={placeholder}
        readOnly={readOnly}
        {...field}
        className={cn(
          'min-w-0 flex-1 resize-none bg-transparent py-[7px] tracking-[-0.1px] text-ink outline-none',
          'max-h-[120px] placeholder:text-ink-2',
          mobile ? 'text-[14.5px]' : 'text-[15px]',
        )}
      />
      {trailing ?? (
        <span
          aria-hidden
          className={cn(
            'sm-mic grid flex-none place-items-center rounded-full',
            mobile ? 'size-9' : 'size-10',
          )}
        >
          <MicIcon />
        </span>
      )}
    </div>
  )
}
