/**
 * The per-message action bar — Copy · Share · More, under an assistant bubble.
 * ─────────────────────────────────────────────────────────────────────────────
 * MOUNTED as a stable SIBLING of the bubble (never inside `<Prose>`), so it
 * cannot re-mount or re-render the memoised markdown subtree — the selection-
 * and-memo safety the whole design turns on (`transcript-item.tsx` §mount). Its
 * own state (the copied flash, the open menu) lives here and touches nothing
 * above it.
 *
 * TWO SURFACES, one component:
 *   · DESKTOP — the bar is HIDDEN at rest and revealed by CSS only
 *     (`group-hover` / `group-focus-within` on the row wrapper). No React state
 *     drives the reveal, so hovering a message never re-renders it and never
 *     fights text selection. Keyboard-reachable, `focus-visible` rings, a
 *     tooltip + `aria-label` per control. The `⋯` opens a Radix dropdown.
 *   · PHONE (`surface==='phone'`) — no hover, so the bar is PERSISTENT but quiet
 *     (low opacity, 44pt targets). The `⋯` opens the shared Vaul sheet.
 *
 * The source for every action is the RAW MARKDOWN string (`text`) — see
 * `message-export.ts`. Share renders only where `navigator.share` exists.
 *
 * SKIN HOOKS: the bar carries `data-msg-actions` (+ `data-surface`) and each
 * button `data-msg-action`, so `grok-mode.css` restyles rest/hover opacity and
 * tint under `[data-grok]` with no change here; the default app already reads in
 * both themes via semantic tokens.
 */
import * as React from 'react'
import { Check, Copy, FileCode, FileText, MoreHorizontal, Share2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ToastContext } from '@/components/ui/use-toast'

import {
  canShareText,
  copyText,
  downloadHtml,
  downloadMarkdown,
  shareText,
} from '../message-export'
import { MessageActionsSheet } from '../message-actions-sheet'

export interface MessageActionsProps {
  /** The message, exactly as the agent wrote it — the source for every action. */
  text: string
  /** Desktop (hover-reveal) or phone (persistent, 44pt, Vaul sheet). */
  surface?: 'desktop' | 'phone'
}

export function MessageActions({ text, surface = 'desktop' }: MessageActionsProps) {
  const phone = surface === 'phone'
  // Detected once per mount — the button is simply absent where the API is not.
  const [shareable] = React.useState(canShareText)
  const [copied, setCopied] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // Toast is optional: read the context directly so the bar renders in benches /
  // static tests with no <ToastProvider> (useToast would throw there).
  const toastApi = React.useContext(ToastContext)
  const toast = toastApi?.toast

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const onCopy = React.useCallback(() => {
    void copyText(text).then((ok) => {
      if (!ok) return // never a false ✓ in an insecure context / denied clipboard
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    })
  }, [text])

  const onShare = React.useCallback(() => {
    void shareText(text).then((r) => {
      // `dismissed` (user closed the sheet) is silent; only a real failure toasts.
      if (r === 'error') toast?.({ message: 'Couldn’t share this message', tone: 'error', duration: 4000 })
    })
  }, [text, toast])

  const onExportMarkdown = React.useCallback(() => {
    try {
      downloadMarkdown(text)
    } catch {
      toast?.({ message: 'Couldn’t export the file', tone: 'error', duration: 4000 })
    }
  }, [text, toast])

  const onExportHtml = React.useCallback(() => {
    void downloadHtml(text).catch(() =>
      toast?.({ message: 'Couldn’t export the file', tone: 'error', duration: 4000 }),
    )
  }, [text, toast])

  const btn = (extra?: string) =>
    cn(
      'inline-flex items-center justify-center rounded-lg text-ink-3 transition-colors',
      'hover:bg-muted/60 hover:text-ink',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      phone ? 'size-11' : 'size-8',
      extra,
    )
  const iconCls = phone ? 'size-[19px]' : 'size-[15px]'

  return (
    <div
      data-msg-actions
      data-surface={surface}
      // Desktop: hidden until the row is hovered or focused, or the menu is open
      // (so the trigger doesn't vanish under the open dropdown). Phone: always
      // present, quietly. `group-*/msg` keys off the wrapper in transcript-item.
      className={cn(
        '-ml-1 mt-1 flex items-center gap-0.5',
        phone
          ? 'opacity-70'
          : cn(
              'transition-opacity duration-100',
              menuOpen
                ? 'opacity-100'
                : 'opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100',
            ),
      )}
    >
      {/* COPY — primary, flips to a check for ~1.5s. */}
      <button
        type="button"
        data-msg-action="copy"
        onClick={onCopy}
        aria-label={copied ? 'Copied' : 'Copy message'}
        title={copied ? 'Copied' : 'Copy'}
        className={btn()}
      >
        {copied ? (
          <Check className={cn(iconCls, 'text-status-active-ink')} aria-hidden />
        ) : (
          <Copy className={iconCls} aria-hidden />
        )}
        <span className="sr-only" aria-live="polite">
          {copied ? 'Copied' : ''}
        </span>
      </button>

      {/* SHARE — only where the OS share sheet exists. */}
      {shareable && (
        <button
          type="button"
          data-msg-action="share"
          onClick={onShare}
          aria-label="Share message"
          title="Share"
          className={btn()}
        >
          <Share2 className={iconCls} aria-hidden />
        </button>
      )}

      {/* MORE — desktop dropdown / phone sheet, both over the same three exports. */}
      {phone ? (
        <>
          <button
            type="button"
            data-msg-action="more"
            onClick={() => setSheetOpen(true)}
            aria-label="More actions"
            title="More"
            className={btn()}
          >
            <MoreHorizontal className={iconCls} aria-hidden />
          </button>
          <MessageActionsSheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            onCopyMarkdown={onCopy}
            onExportMarkdown={onExportMarkdown}
            onExportHtml={onExportHtml}
          />
        </>
      ) : (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-msg-action="more"
              aria-label="More actions"
              title="More"
              className={btn()}
            >
              <MoreHorizontal className={iconCls} aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-52" data-msg-actions-menu>
            <DropdownMenuItem onSelect={onCopy}>
              <Copy aria-hidden />
              Copy as Markdown
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onExportMarkdown}>
              <FileText aria-hidden />
              Export as Markdown (.md)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onExportHtml}>
              <FileCode aria-hidden />
              Export as HTML (.html)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

export default MessageActions
