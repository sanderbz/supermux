/**
 * Per-message export/share primitives — the pure plane behind `<MessageActions>`.
 * ─────────────────────────────────────────────────────────────────────────────
 * Every function here takes the message's RAW MARKDOWN (`item.text`, exactly as
 * the agent wrote it) and does one thing to it. No React, no DOM component tree,
 * no serialization of the rendered bubble — the string IS the source of truth,
 * so `.md` is lossless and `.html` is the same markdown run back through the
 * chat's own renderer.
 *
 * WHY THE HTML PATH IS DYNAMIC-IMPORTED. `react-dom/server` is not in the
 * client bundle today (nothing renders to a string at runtime), and the
 * markdown stack (`react-markdown` + remark/rehype/lowlight) lives behind the
 * ONE lazy edge `transcript-item.tsx` guards. Statically importing either here
 * would drag both onto the hero path and trip the entry-size budget. So the two
 * heavy helpers (`messageToHtml`, `downloadHtml`) `await import(...)` the render
 * stack only when the user actually picks "Export as HTML" — the common Copy /
 * Share / Export-.md actions cost nothing.
 *
 * The pure string helpers (`toHtmlDocument`, `canShareText`, `messageFilename`)
 * are unit-testable in `bun test` with no DOM.
 */

/** The generic share title — honest and generic; there is no per-message URL
 *  yet, so this is the whole of the payload's provenance. */
export const SHARE_TITLE = 'Message from Claude'

/* ── capability probe ─────────────────────────────────────────────────────── */

/** Does this browser expose the Web Share API for text? iOS Safari / Android
 *  Chrome return true; desktop Chrome/Firefox return false → the caller simply
 *  does not render Share (Copy is the fallback). Text share needs `navigator.
 *  share` only — `canShare` is a files-only gate, so we do NOT probe it here. */
export function canShareText(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}

/* ── clipboard ────────────────────────────────────────────────────────────── */

/**
 * Copy `text` verbatim. Resolves `true` only on a REAL success — `writeText`
 * rejects under a denied permission or an insecure context, and the caller must
 * never flash a ✓ it did not earn (the `session-info-panel` copy rule).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/* ── native share ─────────────────────────────────────────────────────────── */

/** The outcome of a share attempt — `dismissed` is the user closing the sheet
 *  (silent, never an error), `error` is a real failure worth a toast. */
export type ShareResult = 'shared' | 'dismissed' | 'unsupported' | 'error'

/**
 * Hand `text` to the OS share sheet. Mirrors the `file-list` idiom: `AbortError`
 * (the user dismissed) is silent; any other rejection is surfaced so the caller
 * can toast it. No `url` — there is no per-message permalink yet.
 */
export async function shareText(text: string, title = SHARE_TITLE): Promise<ShareResult> {
  if (!canShareText()) return 'unsupported'
  try {
    await navigator.share({ text, title })
    return 'shared'
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return 'dismissed'
    return 'error'
  }
}

/* ── downloads ────────────────────────────────────────────────────────────── */

/**
 * The `file-list` download idiom, verbatim: object URL → a synthetic `<a
 * download>` → click → revoke on a timer so the browser has time to start the
 * stream. Kept in one place so both export formats share it.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Save the raw markdown as a `.md` file — lossless, the string as-is. */
export function downloadMarkdown(text: string, filename = messageFilename(text, 'md')): void {
  downloadBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), filename)
}

/**
 * Save a standalone `.html` document. The body is the SAME markdown run through
 * the chat's own renderer (visual parity), produced by `messageToHtml` — which
 * lazy-loads the render stack, so this is async.
 */
export async function downloadHtml(
  text: string,
  filename = messageFilename(text, 'html'),
): Promise<void> {
  const doc = await messageToHtml(text)
  downloadBlob(new Blob([doc], { type: 'text/html;charset=utf-8' }), filename)
}

/* ── html rendering (lazy) ────────────────────────────────────────────────── */

/**
 * Render the message's markdown to a full, openable HTML document.
 *
 * DYNAMIC on purpose (see file header): `react-dom/server` and the markdown
 * chunk are imported only here, only when HTML export is picked. The body is
 * `<ChatMarkdown text=… />` — the exact component the bubble uses — so the
 * export reads like the message did; chips degrade to plain text (no roster is
 * injected), which is correct for a file that leaves the app.
 */
export async function messageToHtml(text: string, title = SHARE_TITLE): Promise<string> {
  const [{ renderToStaticMarkup }, { ChatMarkdown }, { createElement }] = await Promise.all([
    import('react-dom/server'),
    import('./markdown/chat-markdown'),
    import('react'),
  ])
  const body = renderToStaticMarkup(createElement(ChatMarkdown, { text }))
  return toHtmlDocument(body, title)
}

/**
 * Wrap a rendered HTML fragment in a minimal, self-contained document — doctype,
 * UTF-8, a readable system-font stylesheet, and code/quote basics — so the saved
 * file opens and reads on its own. Pure and synchronous; the heavy render is the
 * caller's job.
 */
export function toHtmlDocument(bodyHtml: string, title = SHARE_TITLE): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">\
<meta name="viewport" content="width=device-width, initial-scale=1">\
<title>${escapeHtml(title)}</title><style>\
:root{color-scheme:light dark}\
body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;max-width:720px;margin:2.5rem auto;padding:0 1.25rem;color:#1a1a1a;background:#fff}\
@media(prefers-color-scheme:dark){body{color:#e8e8e8;background:#16171a}a{color:#6ea8fe}}\
pre{overflow:auto;padding:.9rem 1rem;border-radius:10px;background:rgba(127,127,127,.14)}\
code{font:.9em/1.5 ui-monospace,SFMono-Regular,"JetBrains Mono",Menlo,monospace}\
pre code{font-size:.85em}\
blockquote{margin:.6rem 0;padding-left:1rem;border-left:3px solid rgba(127,127,127,.4);opacity:.85}\
a{color:#2563eb}\
table{border-collapse:collapse}th,td{border:1px solid rgba(127,127,127,.35);padding:.35rem .6rem}\
img{max-width:100%}\
</style></head><body>
${bodyHtml}
</body></html>
`
}

/* ── filenames ────────────────────────────────────────────────────────────── */

/** `message-<hash>.<ext>` — a short, deterministic id from the text (no
 *  `Math.random`, so the same message always names the same file). */
export function messageFilename(text: string, ext: 'md' | 'html'): string {
  return `message-${shortHash(text)}.${ext}`
}

/** A tiny FNV-1a hash → 6-char base36 slug. Not cryptographic; just enough to
 *  keep two exported messages from colliding on disk. */
function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(0, 6)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
