/**
 * Assistant prose, typeset (fase A3 T5) — the ONE module that imports the
 * markdown stack.
 * ─────────────────────────────────────────────────────────────────────────────
 * It is reached exclusively through `React.lazy(() => import('./markdown/
 * chat-markdown'))` in `transcript-item.tsx`, which is what keeps
 * `react-markdown` + `remark`/`rehype`/`lowlight` in the `vendor-markdown` chunk
 * `vite.config.ts` already splits out, off the hero path. `tests/unit/
 * chat-surface.test.tsx` walks the panel's static import graph and fails if that
 * edge ever becomes a plain import.
 *
 * TWO DECISIONS THAT ARE NOT COSMETIC:
 *
 * 1. SOFT BREAKS ARE HARD BREAKS (`remarkHardBreaks`, below). CommonMark folds a
 *    single newline into a space; the Suspense fallback renders the same text
 *    with `whitespace-pre-wrap`, which does not. Without this plugin the chunk
 *    landing would RE-FLOW the bubble — every wrapped line would move — and the
 *    scroll position under it with it. The plugin makes the two renders agree
 *    line for line, so the swap changes glyph styling and not block height
 *    (plan §T5.3). It is 20 lines of mdast walk rather than a new dependency
 *    (`remark-breaks` is not installed and A3 adds no deps).
 *
 * 2. HIGHLIGHTING IS OPT-IN PER FENCE. `rehype-highlight` runs only when the
 *    source actually declares a fence language, and with `detect: false` so it
 *    never guesses at an undeclared block: a message that is only prose pays
 *    nothing for `lowlight`'s grammars beyond the chunk it already loaded, and
 *    an undeclared fence stays honest monospace instead of being coloured as
 *    somebody's guess at a language.
 *
 * Everything about how it LOOKS is next door in `chat-components.tsx`.
 */
import * as React from 'react'
import type { Root as HastRoot } from 'hast'
import type { Root } from 'mdast'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import { chatComponents, type ChatMarkdownContext } from './chat-components'

export interface ChatMarkdownProps extends ChatMarkdownContext {
  /** The message, as the agent wrote it. */
  text: string
}

/* ── soft break → hard break ─────────────────────────────────────────────── */

/** The shape this walk needs — mdast's own types, minus everything unused. */
interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
}

/** Split every `text` node's embedded newlines into explicit `break` nodes. */
function hardenBreaks(node: MdNode): void {
  const children = node.children
  if (!children) return
  let changed = false
  const out: MdNode[] = []
  for (const child of children) {
    if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('\n')) {
      changed = true
      const parts = child.value.split('\n')
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) out.push({ type: 'break' })
        if (parts[i] !== '') out.push({ type: 'text', value: parts[i] })
      }
      continue
    }
    out.push(child)
    // `code` / `inlineCode` are leaves carrying a `value`, never children, so a
    // fenced block is never reached by this walk — its newlines stay its own.
    hardenBreaks(child)
  }
  if (changed) node.children = out
}

function remarkHardBreaks() {
  return (tree: Root): undefined => {
    hardenBreaks(tree as unknown as MdNode)
  }
}

/* ── inline code vs a fence ──────────────────────────────────────────────── */

/**
 * `<code>` alone cannot tell you which one it is.
 *
 * A fenced block with no language and a span of inline code produce the SAME
 * hast element — `<code>text</code>` — and differ only in their parent. The
 * component map never sees a parent, so a naive `className` check gives an
 * unlabelled fence the inline chip's pill, inside a `<pre>`. This marks the real
 * ones on the tree, where the parent is still in hand, and `chat-components.tsx`
 * reads the marker.
 */
const FENCE_CLASS = 'sm-fence'

interface HastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

function markFences(node: HastNode): void {
  const children = node.children
  if (!children) return
  for (const child of children) {
    if (node.tagName === 'pre' && child.type === 'element' && child.tagName === 'code') {
      const properties = (child.properties ??= {})
      const existing = properties.className
      properties.className = Array.isArray(existing)
        ? [...existing, FENCE_CLASS]
        : existing
          ? [String(existing), FENCE_CLASS]
          : [FENCE_CLASS]
    }
    markFences(child)
  }
}

function rehypeMarkFences() {
  return (tree: HastRoot): undefined => {
    markFences(tree as unknown as HastNode)
  }
}

/* ── the fence probe ─────────────────────────────────────────────────────── */

/** ```rust / ~~~ts — a fence that names its language. Bare ``` does not match. */
const DECLARED_FENCE = /^ {0,3}(?:```|~~~)[ \t]*[A-Za-z][\w+#.-]*\s*$/m

const REMARK_PLUGINS = [remarkGfm, remarkHardBreaks]

export function ChatMarkdown({ text, ...ctx }: ChatMarkdownProps) {
  const { self, mentions, pinFor, surface, rawUrl, onOpenSession } = ctx
  const components = React.useMemo(
    () => chatComponents({ self, mentions, pinFor, surface, rawUrl, onOpenSession }),
    [self, mentions, pinFor, surface, rawUrl, onOpenSession],
  )
  return (
    <div className="min-w-0 break-words">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={
          DECLARED_FENCE.test(text)
            ? [rehypeMarkFences, [rehypeHighlight, { detect: false, ignoreMissing: true }]]
            : [rehypeMarkFences]
        }
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export default ChatMarkdown
