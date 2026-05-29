// Rendered Markdown viewer for the Files route (M-MD).
//
// Lazy-loaded sibling to the CodeMirror editor: when the user is reading a
// `.md`/`.markdown`/`.mdx` file we ship a *typeset* surface that fits the
// app's typography (SF-Pro sizing, theme tokens, glass surfaces, no third-
// party CSS, no @tailwindcss/typography). The editor remains one Source-mode
// click away — the toggle lives in the FileViewer header.
//
// Stack:
//   • `react-markdown` for the React-native tree (no innerHTML, no string
//     interop) — every node is a component we control so styles are
//     end-to-end driven by Tailwind utilities + CSS variables.
//   • `remark-gfm` for GitHub-flavoured tables, task lists, strikethrough,
//     autolinks — the realistic README baseline.
//   • `rehype-slug` so each heading gets a stable id (`<h2 id="install">`),
//     letting `[link](#install)` jump within the viewer.
//   • `rehype-highlight` (lowlight + highlight.js core) for code-block
//     syntax colours, themed below via `.hljs-*` selectors mapped to the
//     same theme tokens the rest of the app uses (no imported hljs stylesheet
//     — keeps light/dark switching one variable away, with zero FOUC).
//
// We deliberately do NOT enable `rehype-raw` / a sanitizer: react-markdown's
// default rejects raw HTML, which is the safest stance for arbitrary repo
// markdown. If a doc embeds raw HTML it shows as escaped text — visible, but
// never injected into the DOM.
//
// Relative image paths are rewritten to the authenticated `/api/file/raw`
// endpoint resolved against the document's parent dir, so `![](./diagram.png)`
// in `~/proj/docs/README.md` loads `<data_dir>/proj/docs/diagram.png` through
// the same path-safety gate as every other file fetch.
//
// VISUAL: reading-width-clamped at desktop (`max-w-[72ch]` centred), edge-to-
// edge at mobile, with generous vertical rhythm. Buttons / interactive bits
// honour the ≥44pt tap target (links inherit by virtue of their typography
// padding around block elements).

import * as React from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeSlug from 'rehype-slug'

import { cn } from '@/lib/utils'
import { filesApi } from '@/lib/api'

export interface MarkdownViewerProps {
  /** Raw markdown source. */
  source: string
  /** Absolute path of the document being rendered. Used as the base for
   *  rewriting relative image / link references. */
  basePath: string
}

/** Compute the parent directory of an absolute file path. `/a/b/c.md` → `/a/b`.
 *  Falls back to `/` for a root-level file. */
function parentDir(absPath: string): string {
  const slash = absPath.lastIndexOf('/')
  if (slash <= 0) return '/'
  return absPath.slice(0, slash)
}

/** Resolve a (possibly relative) markdown link/image href against the document's
 *  parent dir. Absolute URLs (`http(s):`, `mailto:`, `data:`) pass through;
 *  anchors (`#foo`) and absolute paths (`/abs/...`) pass through; everything
 *  else is joined to `base`. Path traversal segments (`..`, `.`) are folded so
 *  the resolved path stays canonical — the backend then re-validates the
 *  result with its own path-safety check before serving any bytes. */
function resolveHref(href: string | undefined, base: string): string | undefined {
  if (!href) return href
  if (/^([a-z][a-z0-9+.-]*:|#|mailto:|tel:|data:)/i.test(href)) return href
  if (href.startsWith('/')) return href
  const parts = `${base}/${href}`.split('/')
  const stack: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') stack.pop()
    else stack.push(p)
  }
  return '/' + stack.join('/')
}

/** True for URLs the browser should open in a new tab. Same-origin links and
 *  anchors stay in-app. */
function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href) && !href.startsWith(window.location.origin)
}

export function MarkdownViewer({ source, basePath }: MarkdownViewerProps) {
  const baseDir = React.useMemo(() => parentDir(basePath), [basePath])

  // Pure-derived render-node overrides. Memoised on `baseDir` so React-Markdown
  // doesn't see a fresh `components` reference on every parent rerender and
  // re-mount its subtree.
  const components: Components = React.useMemo(
    () => ({
      h1: (props) => (
        <h1
          {...props}
          className="mt-0 scroll-mt-16 text-[1.65rem] font-semibold leading-tight tracking-tight text-foreground sm:text-[1.875rem]"
        />
      ),
      h2: (props) => (
        <h2
          {...props}
          className="mt-8 scroll-mt-16 border-b border-border/60 pb-2 text-[1.3rem] font-semibold leading-snug tracking-tight text-foreground sm:text-[1.45rem]"
        />
      ),
      h3: (props) => (
        <h3
          {...props}
          className="mt-6 scroll-mt-16 text-[1.1rem] font-semibold leading-snug text-foreground sm:text-[1.2rem]"
        />
      ),
      h4: (props) => (
        <h4
          {...props}
          className="mt-5 scroll-mt-16 text-[1rem] font-semibold text-foreground"
        />
      ),
      h5: (props) => (
        <h5
          {...props}
          className="mt-4 scroll-mt-16 text-[0.95rem] font-semibold uppercase tracking-wide text-muted-foreground"
        />
      ),
      h6: (props) => (
        <h6
          {...props}
          className="mt-4 scroll-mt-16 text-[0.85rem] font-semibold uppercase tracking-wide text-muted-foreground"
        />
      ),
      p: (props) => (
        <p
          {...props}
          className="my-3 text-[15px] leading-[1.7] text-foreground/90"
        />
      ),
      a: ({ href, children, ...rest }) => {
        const resolved = resolveHref(href, baseDir)
        const external = !!resolved && isExternal(resolved)
        return (
          <a
            {...rest}
            href={resolved}
            target={external ? '_blank' : undefined}
            rel={external ? 'noopener noreferrer' : undefined}
            className="font-medium text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary"
          >
            {children}
          </a>
        )
      },
      ul: (props) => (
        <ul
          {...props}
          className="my-3 ml-5 list-disc space-y-1.5 text-[15px] leading-[1.7] marker:text-muted-foreground/60 [&_ul]:my-1 [&_ul]:ml-5"
        />
      ),
      ol: (props) => (
        <ol
          {...props}
          className="my-3 ml-5 list-decimal space-y-1.5 text-[15px] leading-[1.7] marker:text-muted-foreground/60 [&_ol]:my-1 [&_ol]:ml-5"
        />
      ),
      li: (props) => <li {...props} className="pl-1" />,
      // GFM task lists land as `<input type="checkbox" disabled>` inside <li>.
      // We restyle them to read native rather than browser-default.
      input: ({ type, checked, ...rest }) =>
        type === 'checkbox' ? (
          <input
            type="checkbox"
            checked={checked}
            readOnly
            disabled
            className="mr-1.5 size-3.5 -translate-y-px cursor-default rounded border-border accent-primary disabled:opacity-100"
            {...rest}
          />
        ) : (
          <input type={type} checked={checked} {...rest} />
        ),
      blockquote: (props) => (
        <blockquote
          {...props}
          className="my-4 border-l-2 border-primary/40 bg-muted/30 px-4 py-2 italic text-muted-foreground [&>p]:my-1.5"
        />
      ),
      hr: (props) => (
        <hr {...props} className="my-6 border-0 border-t border-border" />
      ),
      strong: (props) => (
        <strong {...props} className="font-semibold text-foreground" />
      ),
      em: (props) => <em {...props} className="italic" />,
      del: (props) => (
        <del {...props} className="text-muted-foreground" />
      ),
      // Inline `code` vs fenced `pre > code` — react-markdown emits both
      // through this same component, distinguished by parent. Inline gets a
      // muted background pill; fenced is left bare so the `<pre>` styling
      // owns the surface.
      code: ({ className, children, ...rest }) => {
        const inline = !className?.includes('language-')
        if (inline) {
          return (
            <code
              {...rest}
              className="rounded bg-muted px-[0.35em] py-[0.15em] font-mono text-[0.875em] text-foreground"
            >
              {children}
            </code>
          )
        }
        return (
          <code {...rest} className={cn('font-mono text-[13px]', className)}>
            {children}
          </code>
        )
      },
      pre: ({ children, ...rest }) => {
        // Extract the fenced language (the `language-foo` class rehype-highlight
        // preserves) for a small badge in the top-right.
        const lang = languageOf(children)
        return (
          <div className="group relative my-4">
            {lang && (
              <span
                aria-hidden
                className="pointer-events-none absolute right-2 top-2 select-none rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground/80 opacity-0 transition-opacity group-hover:opacity-100"
              >
                {lang}
              </span>
            )}
            <pre
              {...rest}
              className="overflow-x-auto rounded-lg border border-border bg-card p-3.5 text-[13px] leading-[1.55]"
            >
              {children}
            </pre>
          </div>
        )
      },
      table: (props) => (
        <div className="my-4 overflow-x-auto rounded-lg border border-border">
          <table
            {...props}
            className="w-full border-collapse text-left text-[14px]"
          />
        </div>
      ),
      thead: (props) => (
        <thead {...props} className="bg-muted/40 text-foreground" />
      ),
      th: (props) => (
        <th
          {...props}
          className="border-b border-border px-3 py-2 text-left font-semibold"
        />
      ),
      td: (props) => (
        <td
          {...props}
          className="border-b border-border/60 px-3 py-2 align-top last:border-b-0"
        />
      ),
      img: ({ src, alt, ...rest }) => {
        const resolved = resolveHref(typeof src === 'string' ? src : undefined, baseDir)
        // Repo-relative paths route through `/api/file/raw?...&_token=...` so
        // the same auth gate that protects the rest of the file API protects
        // every embedded image. Off-origin URLs pass through unchanged.
        const finalSrc =
          resolved && resolved.startsWith('/') && !resolved.startsWith('//')
            ? filesApi.rawUrl(resolved)
            : resolved
        return (
          <img
            {...rest}
            src={finalSrc}
            alt={alt ?? ''}
            loading="lazy"
            className="my-4 max-w-full rounded-lg border border-border/60 shadow-sm"
          />
        )
      },
    }),
    [baseDir],
  )

  return (
    <div className="h-full min-h-0 overflow-auto px-4 py-5 sm:px-8 sm:py-8">
      <article className="mx-auto max-w-[72ch] break-words">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug, [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
          components={components}
        >
          {source}
        </ReactMarkdown>
      </article>
    </div>
  )
}

/** Pull the `language-foo` class out of the first child element of a `<pre>`
 *  (which is the fenced `<code>` rehype-highlight tagged). Returns the bare
 *  language slug (`"rust"` / `"ts"`) or `null` when no fence language was set. */
function languageOf(children: React.ReactNode): string | null {
  const arr = React.Children.toArray(children)
  for (const c of arr) {
    if (
      React.isValidElement(c) &&
      typeof (c.props as { className?: unknown }).className === 'string'
    ) {
      const cls = (c.props as { className: string }).className
      const m = /\blanguage-([\w+-]+)\b/.exec(cls)
      if (m) return m[1]
    }
  }
  return null
}
