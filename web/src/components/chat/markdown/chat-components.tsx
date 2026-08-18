/**
 * The `variant="chat"` markdown map (fase A3 T5).
 * ─────────────────────────────────────────────────────────────────────────────
 * `files/markdown-viewer.tsx` types a DOCUMENT: 72ch column, chaptered
 * headings, 1.7 leading, generous vertical rhythm. A chat message is not a
 * document — it is a sentence someone said, and it lives inside a 648px bubble
 * whose own type is 15/1.45. So the two maps share a library and nothing else,
 * and this one is deliberately compact (master plan §4.2 P2):
 *
 *   h1-h6      15px/600 with 10px of air above — a chat heading is a sentence
 *              that leads, not a chapter
 *   p          the bubble's own 15/1.45, 8px between paragraphs, no top margin
 *              on the first (the bubble's padding already provides it)
 *   ul/ol      18px indent, 3px between items, markers in tertiary ink
 *   code       the `InlineCode` chip B0 already ships (JetBrainsMono 13.2 on
 *              `--sm-fill-soft`, radius 8) — one chip, one definition
 *   pre        `BubbleCode` — the fenced read of the approved Patch board
 *   a          the speaker's own pigment via `.sm-ink-accent`, underlined on
 *              hover only (a link is quiet until it is aimed at)
 *   table      a hairline grid that scrolls inside its own box, so a wide table
 *              never widens the bubble
 *   img        `CapturedFrameCard` at bubble width — the same warm object a
 *              tool-produced screenshot gets, because it is the same thing
 *   hr         a hairline
 *
 * MENTIONS: the chip pass from T3 runs here at the TEXT-NODE level, applied by
 * each prose component to its own direct string children — never recursively,
 * so a name inside `<code>` stays code and no run is chipped twice. The index is
 * the known-sessions map (`grouping.ts::mentionIndex`); there is no regex over
 * arbitrary words.
 *
 * NO COLOUR LITERALS: every surface here is a B0 token or a B0 primitive.
 *
 * The one `react-markdown` reference in this file is `import type` — erased
 * under `verbatimModuleSyntax`, so this module carries no runtime edge to the
 * markdown stack. The runtime edge lives in `chat-markdown.tsx`, which is
 * reached only through `React.lazy`.
 */
import * as React from 'react'
import type { Components } from 'react-markdown'
import type { Element } from 'hast'

import type { MarkPin } from '../../../brand/marks'
import { basename } from '../../../lib/path'
import { cn } from '../../../lib/utils'
import { mentionSegments } from '../grouping'
import {
  ACCENT_INK_CLASS,
  accentInkVarsForSeed,
  BubbleCode,
  CapturedFrameCard,
  CAPTURED_FRAME,
  CodeAdd,
  CodeDel,
  InlineCode,
  MentionChip,
} from '../ui'

/** Everything the map needs that is not in the markdown itself. */
export interface ChatMarkdownContext {
  /** The speaker's slug: its pigment colours the links, and its own name is
   *  never chipped inside its own bubble. */
  self?: string
  /** Lowercased known name → session slug. Absent = no chips at all. */
  mentions?: ReadonlyMap<string, string>
  pinFor?: (seed: string) => MarkPin | undefined
  surface?: 'desktop' | 'phone'
  /** Absolute path → fetchable URL, injected exactly as `TranscriptItem` does
   *  it (the API client reaches `@/env`, which the unit runner cannot resolve). */
  rawUrl?: (path: string) => string
  /** Go to a mentioned session (fase B4 T3.3). Injected, never a route: this
   *  module renders inside a lazy chunk and must not learn about the router.
   *  Absent → the chip is a `<span>`, exactly as in the non-markdown path. */
  onOpenSession?: (slug: string) => void
}

const EMPTY_INDEX: ReadonlyMap<string, string> = new Map()

/* ── the mention pass ────────────────────────────────────────────────────── */

/**
 * Replace known session names in this element's OWN string children with chips.
 *
 * Non-recursive on purpose: `react-markdown` gives every element its own
 * component, so `<strong>` chips its own text and `<code>` chips nothing. A
 * recursive walk would visit the same run twice and would reach into fenced
 * code, where a colleague's name is a variable, not a colleague.
 */
function withMentions(children: React.ReactNode, ctx: ChatMarkdownContext): React.ReactNode {
  const index = ctx.mentions ?? EMPTY_INDEX
  if (index.size === 0) return children
  return React.Children.map(children, (child) => {
    if (typeof child !== 'string') return child
    const segments = mentionSegments(child, index, ctx.self)
    if (segments.length === 1 && 'text' in segments[0]) return child
    return segments.map((segment, i) =>
      'text' in segment ? (
        <React.Fragment key={i}>{segment.text}</React.Fragment>
      ) : (
        <MentionChip
          key={i}
          seed={segment.seed}
          pin={ctx.pinFor?.(segment.seed)}
          name={segment.label}
          onClick={
            ctx.onOpenSession ? () => ctx.onOpenSession?.(segment.seed) : undefined
          }
        />
      ),
    )
  })
}

/* ── small helpers ───────────────────────────────────────────────────────── */

/** A paragraph whose only content is an image — the frame replaces the `<p>`,
 *  because a `CapturedFrameCard` is a block and `<div>` inside `<p>` is a
 *  browser-closed paragraph and a broken layout. */
function isLoneImage(node: Element | undefined): boolean {
  if (!node) return false
  const meaningful = node.children.filter(
    (child) => !(child.type === 'text' && child.value.trim() === ''),
  )
  return meaningful.length === 1 && meaningful[0].type === 'element' && meaningful[0].tagName === 'img'
}

/**
 * Fenced vs inline — `react-markdown` emits both as `code`, and an unlabelled
 * fence carries no `language-*` class to tell them apart. `chat-markdown.tsx`'s
 * `rehypeMarkFences` stamps the real ones with `sm-fence` while their `<pre>`
 * parent is still in hand; `language-*` is accepted too, so a caller that skips
 * the plugin still gets labelled fences right.
 */
function isFenced(className: string | undefined): boolean {
  return !!className && /\b(?:sm-fence|language-)/.test(className)
}

/* ── the diff read ───────────────────────────────────────────────────────── */

/** Every string under a react node, in order — the fence's source text. */
function plainText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (React.isValidElement(node)) {
    return plainText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}

/**
 * Is this fence a DIFF?
 *
 * `board-patch-focused.png` gives the one fenced block the approved design
 * contains, and it is a diff drawn in exactly two inks: the removed line in
 * tertiary, the added line at full strength — B0's `CodeDel` / `CodeAdd`. That
 * read is worth more than syntax colour here (it is the shape of the change, and
 * the surface's rule is quiet chrome, loud content), so a fence that IS a diff
 * gets it.
 *
 * The test is deliberately strict: at least two non-empty lines, every one of
 * them opening with `+`, `-` or a space, and at least one of each sign. Rust
 * that happens to start a line with a minus does not qualify, because the rest
 * of the block will not.
 */
function diffLines(text: string): string[] | null {
  const lines = text.replace(/\n$/, '').split('\n')
  const meaningful = lines.filter((l) => l.trim() !== '')
  if (meaningful.length < 2) return null
  if (!meaningful.every((l) => /^[-+ ]/.test(l))) return null
  if (!meaningful.some((l) => l.startsWith('+')) || !meaningful.some((l) => l.startsWith('-'))) {
    return null
  }
  return lines
}

/** The diff, in the boards' two inks. A function, not a component: this module
 *  is a component MAP, and a second component export costs it fast refresh. */
function diffNodes(lines: readonly string[]): React.ReactNode {
  return lines.map((line, i) =>
    line.startsWith('-') ? (
      <CodeDel key={i}>{`${line}\n`}</CodeDel>
    ) : (
      <CodeAdd key={i}>{`${line}\n`}</CodeAdd>
    ),
  )
}

/* ── the map ─────────────────────────────────────────────────────────────── */

export function chatComponents(ctx: ChatMarkdownContext): Components {
  // Same width on both surfaces: `CapturedFrameCard` is `max-w-full`, so the
  // phone clamps it to the bubble rather than to an artboard constant.
  const frameWidth = CAPTURED_FRAME.width
  // A link wears the SPEAKER's pigment, the same mechanic a mention chip uses
  // (`accent-ink.ts`): the surface accent is the FOCUSED session, and a
  // colleague's bubble must not borrow it. No speaker, no pigment — the link
  // falls back to full-strength ink, which is what `.sm-ink-accent` resolves to
  // when the two custom properties are unset.
  const linkInk = ctx.self
    ? { className: ACCENT_INK_CLASS, style: accentInkVarsForSeed(ctx.self, ctx.pinFor?.(ctx.self)) }
    : {}

  const heading = 'mt-[10px] text-[15px] font-semibold leading-[1.35] tracking-[-0.1px] first:mt-0'

  return {
    // Every level renders at ONE size — the sentence that leads. The tag is
    // kept as written (a message's outline is the author's, not ours); only the
    // type is chat type.
    h1: ({ node: _node, className, children, ...rest }) => (
      <h1 {...rest} className={cn(heading, className)}>
        {withMentions(children, ctx)}
      </h1>
    ),
    h2: ({ node: _node, className, children, ...rest }) => (
      <h2 {...rest} className={cn(heading, className)}>
        {withMentions(children, ctx)}
      </h2>
    ),
    h3: ({ node: _node, className, children, ...rest }) => (
      <h3 {...rest} className={cn(heading, className)}>
        {withMentions(children, ctx)}
      </h3>
    ),
    h4: ({ node: _node, className, children, ...rest }) => (
      <h4 {...rest} className={cn(heading, className)}>
        {withMentions(children, ctx)}
      </h4>
    ),
    h5: ({ node: _node, className, children, ...rest }) => (
      <h5 {...rest} className={cn(heading, className)}>
        {withMentions(children, ctx)}
      </h5>
    ),
    h6: ({ node: _node, className, children, ...rest }) => (
      <h6 {...rest} className={cn(heading, className)}>
        {withMentions(children, ctx)}
      </h6>
    ),
    p: ({ node, className, children, ...rest }) =>
      isLoneImage(node) ? (
        <>{children}</>
      ) : (
        <p {...rest} className={cn('mt-2 break-words first:mt-0', className)}>
          {withMentions(children, ctx)}
        </p>
      ),
    a: ({ node: _node, href, className, children, ...rest }) => {
      const external = !!href && /^https?:/i.test(href)
      return (
        <a
          {...rest}
          {...linkInk}
          href={href}
          target={external ? '_blank' : undefined}
          rel={external ? 'noopener noreferrer' : undefined}
          className={cn(
            linkInk.className,
            'underline decoration-transparent underline-offset-2',
            'sm-t-hover hover:decoration-current',
            className,
          )}
        >
          {withMentions(children, ctx)}
        </a>
      )
    },
    strong: ({ node: _node, className, children, ...rest }) => (
      <strong {...rest} className={cn('font-semibold', className)}>
        {withMentions(children, ctx)}
      </strong>
    ),
    em: ({ node: _node, className, children, ...rest }) => (
      <em {...rest} className={cn('italic', className)}>
        {withMentions(children, ctx)}
      </em>
    ),
    del: ({ node: _node, className, children, ...rest }) => (
      <del {...rest} className={cn('text-ink-2 line-through', className)}>
        {withMentions(children, ctx)}
      </del>
    ),
    ul: ({ node: _node, className, ...rest }) => (
      <ul
        {...rest}
        className={cn('mt-2 ml-[18px] list-disc first:mt-0 marker:text-ink-3', className)}
      />
    ),
    ol: ({ node: _node, className, ...rest }) => (
      <ol
        {...rest}
        className={cn('mt-2 ml-[18px] list-decimal first:mt-0 marker:text-ink-3', className)}
      />
    ),
    li: ({ node: _node, className, children, ...rest }) => (
      <li
        {...rest}
        // A GFM task item carries its own state marker (the checkbox below), so
        // it does not also get a bullet — two markers on one line read as a
        // rendering accident. `remark-gfm` labels the item for us.
        className={cn(
          'mt-[3px] break-words first:mt-0',
          className?.includes('task-list-item') && 'list-none',
          className,
        )}
      >
        {withMentions(children, ctx)}
      </li>
    ),
    // GFM task lists arrive as a disabled checkbox inside the `<li>`. Neutral
    // ink, never the accent: a checkbox in transcribed prose is a record of a
    // state, not an affordance (concept contract C7).
    input: ({ node: _node, type, checked, className, ...rest }) =>
      type === 'checkbox' ? (
        <input
          {...rest}
          type="checkbox"
          checked={!!checked}
          readOnly
          disabled
          className={cn('mr-1.5 size-3.5 -translate-y-px cursor-default', className)}
        />
      ) : (
        <input {...rest} type={type} className={className} />
      ),
    blockquote: ({ node: _node, className, ...rest }) => (
      <blockquote
        {...rest}
        className={cn('mt-2 border-l-2 border-hairline pl-3 text-ink-2 first:mt-0', className)}
      />
    ),
    hr: ({ node: _node, className, ...rest }) => (
      <hr {...rest} className={cn('my-3 border-0 border-t border-hairline', className)} />
    ),
    code: ({ node: _node, className, children, ...rest }) =>
      isFenced(className) ? (
        // Inside `<pre>`: the block owns the surface, so the code element only
        // carries the language class `rehype-highlight` hangs its spans on.
        <code {...rest} className={className}>
          {children}
        </code>
      ) : (
        <InlineCode>{children}</InlineCode>
      ),
    pre: ({ node: _node, className, children }) => {
      // A diff is drawn as a diff (the approved Patch board), whatever language
      // the author labelled the fence with — `rehype-highlight`'s spans are
      // discarded for it, because two inks say more about a change than six
      // token colours do.
      const diff = diffLines(plainText(children))
      return (
        <BubbleCode
          className={cn(
            // ON THE PHONE THE FENCE WRAPS (daily-driver QA #18).
            //
            // Measured on the live instance: `clientWidth 228` against a
            // `scrollWidth` of up to 540, with `overflow-x: auto` and NO visible
            // scrollbar — touch platforms draw overlay scrollbars, which appear
            // while you scroll and are therefore invisible to somebody deciding
            // whether there is anything to scroll to. `wget -c
            // https://example.com,` and `find / -type f -size +500M :` simply
            // stopped mid-command (`29-back-from-background.png`).
            //
            // A hint would be one more thing to draw and to explain. Wrapping is
            // the honest version of the same fix: nothing is off screen, so
            // there is nothing to hint at. `[overflow-wrap:anywhere]` is what
            // makes it work on the offender — a long URL or path has no space in
            // it to break at.
            //
            // The desktop keeps the scroll: a 648px bubble holds most lines, a
            // pointer device draws a real scrollbar, and column-aligned output
            // (`ls -la`, a table) is worth more than a guaranteed fit.
            ctx.surface === 'phone'
              ? 'whitespace-pre-wrap [overflow-wrap:anywhere]'
              : 'overflow-x-auto',
            className,
          )}
        >
          {diff ? diffNodes(diff) : children}
        </BubbleCode>
      )
    },
    table: ({ node: _node, className, ...rest }) => (
      <div className="mt-2 max-w-full overflow-x-auto rounded-[10px] border-[0.5px] border-hairline">
        <table
          {...rest}
          // The rule between rows belongs to the ROW, not to a cell: `last:` on
          // a `td` is the last cell of its row (the right-hand column), which
          // would erase that column's horizontal rules and keep a doubled edge
          // under the last row. Scoped here, where the last row is knowable.
          className={cn(
            'w-full border-collapse text-left text-[13.4px] leading-[1.5]',
            '[&_tr:last-child_td]:border-b-0',
            className,
          )}
        />
      </div>
    ),
    th: ({ node: _node, className, children, ...rest }) => (
      <th
        {...rest}
        className={cn('border-b-[0.5px] border-hairline px-2.5 py-1.5 font-semibold', className)}
      >
        {withMentions(children, ctx)}
      </th>
    ),
    td: ({ node: _node, className, children, ...rest }) => (
      <td
        {...rest}
        className={cn('border-b-[0.5px] border-hairline px-2.5 py-1.5 align-top', className)}
      >
        {withMentions(children, ctx)}
      </td>
    ),
    img: ({ node: _node, src, alt }) => {
      const path = typeof src === 'string' ? src : undefined
      // Only an ABSOLUTE path can be turned into a fetchable URL; anything else
      // (a relative path, no path at all) renders B0's honest warm placeholder
      // rather than a broken image icon.
      const resolved =
        path && path.startsWith('/') ? (ctx.rawUrl ? ctx.rawUrl(path) : undefined) : path
      return (
        <CapturedFrameCard
          caption={alt?.trim() || (path ? basename(path) : 'image')}
          src={resolved}
          alt={alt ?? undefined}
          width={frameWidth}
        />
      )
    },
  }
}
