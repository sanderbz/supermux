/**
 * The geometry every quiet pill in the chat header shares: the permission-mode
 * chip and the data-plane chip ("Not up to date" / "Offline") sit side by side
 * on the desktop header and must be the same pill.
 *
 * `inline-flex items-center` is load-bearing, not decoration. The mode chip is a
 * `<button>` (a flex box: its height is the 17.25px line box plus padding and
 * border = 25.25px), while the connection chip is a bare `<span>` inside a
 * `role=status` wrapper, an INLINE box whose vertical padding paints around the
 * glyphs' content area but does not grow the line (measured 21px). Same padding,
 * same font, a 4px height gap and a mismatched baseline. A flex box for both
 * makes them measure the same. No imports: `header-pill.tsx` is rendered by
 * `bun test`, which cannot resolve `@/` aliases.
 */
export const HEADER_CHIP_BASE =
  'inline-flex flex-none items-center rounded-full border-[0.5px] px-2 py-[3px] text-[11.5px] font-medium tracking-[0.1px]'
