/**
 * The chat's file quick look — a file Claude named, opened over the chat.
 * ─────────────────────────────────────────────────────────────────────────────
 * Claude points at files all day: the plan it wrote, the generated report, the
 * `.env` the user has to fill in with a key that must never travel through the
 * chat. Before this, following one meant leaving the conversation for Files,
 * walking the tree folder by folder, and finding the way back through Home —
 * with the reading position lost on the way.
 *
 * So a path in an assistant bubble (`chat/markdown/file-path.ts` decides which)
 * opens THIS, and nothing navigates:
 *
 *   · desktop (fine pointer) — a centred Radix dialog, roomy enough to edit in
 *     (`ResponsiveSheet`'s desktop shell is a 448px side panel: too narrow for
 *     an editor, so the fork is made here and the sheet only sees phones);
 *   · phone (`pointer: coarse`) — `ResponsiveSheet`'s bottom sheet at full
 *     height, NOT dismissible while the buffer is dirty: a sheet that can be
 *     flicked away over an unsaved edit is a data-loss gesture (see the dirty
 *     guard below).
 *
 * The body is the Files route's own `FileViewer` in its `embedded` mode, so
 * markdown previews, images display, and text opens in the same CodeMirror
 * editor with the same save path — including the 409 lost-update guard against
 * a bot that wrote the file after it was opened. The actions are the three the
 * job needs: Save (the viewer's own), "Go to file" (the full Files view, at this
 * file), and Close.
 *
 * CONFINEMENT IS THE SERVER'S. The quick look reads through the same
 * `GET /api/file` as Files, so the member files-jail, the blocklist and the
 * symlink refusal all apply unchanged; a refusal is shown as a sentence, never a
 * crash. The company LENS (`confineToCompanyRoot`) is an interface clamp, not a
 * security boundary, and the Files route applies it to any `?path=` — so "Go to
 * file" is disabled, with the reason, for a file the active company's Files view
 * would clamp away rather than landing the user somewhere else.
 *
 * Reached only through `React.lazy` from `chat-panel.tsx`: this module, the
 * viewer, CodeMirror and the markdown viewer load on the first click and never
 * on the chat's hero path.
 */
import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { FolderOpen, TriangleAlert, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { FsError } from '@/lib/api'
import { basename } from '@/lib/path'
import { companyFilesRoot, confineToCompanyRoot } from '@/lib/companies'
import { useCompanies } from '@/hooks/use-companies'
import { useFileContent } from '@/hooks/use-files'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useUI } from '@/stores/ui-store'
import { DialogOverlay, DialogPortal } from '@/components/ui/dialog'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { FileViewer } from './file-viewer'

export interface FileQuickLookProps {
  /** As resolved from the chat: absolute, or `~/…` (the server expands it). */
  path: string
  open: boolean
  onClose: () => void
  /** The close has finished (exit animation done, focus restored): the
   *  caller can unmount, so a closed quick look stops refetching on focus. */
  onClosed?: () => void
  /** Leave the chat for the full Files view. `isDir` when the path turned out
   *  to be a folder, so the caller opens the folder instead of selecting in it. */
  onGoToFile: (path: string, isDir: boolean) => void
}

/** The header's square icon control — the viewer's own Find button, so the
 *  quick look's two additions read as part of the same toolbar. */
const ICON_BUTTON =
  'flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40'

export function FileQuickLook({ path, open, onClose, onClosed, onGoToFile }: FileQuickLookProps) {
  const coarse = useMediaQuery('(pointer: coarse)')
  const name = basename(path)

  // The SAME query key the viewer reads, so this is the viewer's own fetch,
  // not a second one. It is here for the two things the viewer does not
  // surface: the resolved absolute path ("Go to file" needs a directory, and a
  // `~/` path only becomes one on the server) and the failure, which the quick
  // look explains in its own words.
  const file = useFileContent(path)
  const resolved = file.data?.path ?? path
  // Only a failure with NOTHING in hand is the quick look's to explain. A
  // background refetch that fails (focus regained on a flaky phone network —
  // `retry: false`) keeps the last good payload, and swapping the viewer out
  // for an error card then would unmount the editor and throw the draft away.
  const failed = file.isError && !file.data
  const isDir =
    failed &&
    file.error instanceof FsError &&
    file.error.status === 400 &&
    // Coupled to the server's wording: `get_file`'s "path is a directory".
    /directory/i.test(file.error.message)

  // The company lens — see the module comment. `resolved` is absolute once the
  // read succeeded; before that a `~/` path cannot be compared, and the button
  // stays enabled (the route clamps it anyway, which is the honest worst case).
  const activeCompany = useUI((s) => s.activeCompany)
  const { companies } = useCompanies()
  const companyRoot = companyFilesRoot(activeCompany, companies)
  const target = isDir ? resolved : parentDir(resolved)
  const outsideLens =
    companyRoot !== null && target.startsWith('/') && confineToCompanyRoot(target, companyRoot) !== target

  // THE DIRTY GUARD. The quick look is one Escape, one backdrop click or one
  // flick away from closing, and every one of those over an unsaved buffer
  // would silently throw the edit away — the `.env` key the user just pasted.
  // So a close with a dirty buffer is refused and asks instead, inline: a
  // nested confirm dialog would sit UNDER the phone sheet (z 50 vs the sheet's
  // 60), and one more modal is one more thing to dismiss.
  const [dirty, setDirty] = React.useState(false)
  const [asking, setAsking] = React.useState<null | 'close' | 'go'>(null)
  const keepRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (asking) keepRef.current?.focus()
  }, [asking])
  React.useEffect(() => {
    if (!dirty) setAsking(null)
  }, [dirty])

  const leave = (intent: 'close' | 'go') => {
    if (intent === 'close') onClose()
    else onGoToFile(resolved, isDir)
  }
  const request = (intent: 'close' | 'go') => {
    if (dirty) setAsking(intent)
    else leave(intent)
  }

  const actions = (
    <>
      <button
        type="button"
        onClick={() => request('go')}
        disabled={outsideLens}
        aria-label={isDir ? 'Open folder in Files' : 'Go to file in Files'}
        title={
          outsideLens
            ? 'Outside this company’s files — switch to HQ to browse it'
            : isDir
              ? 'Open folder in Files'
              : 'Go to file in Files'
        }
        className={cn(ICON_BUTTON, 'w-auto gap-1.5 px-2.5 text-[13px] font-medium')}
      >
        <FolderOpen className="size-4" />
        <span className="hidden sm:inline">{isDir ? 'Open folder' : 'Go to file'}</span>
      </button>
      <button type="button" onClick={() => request('close')} aria-label="Close" className={ICON_BUTTON}>
        <X className="size-4" />
      </button>
    </>
  )

  const body = (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-quicklook">
      {asking && (
        <div
          role="alertdialog"
          aria-labelledby="quicklook-unsaved"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          <TriangleAlert className="size-4 shrink-0" />
          <span id="quicklook-unsaved" className="min-w-0 flex-1">
            {name} has unsaved changes.
          </span>
          <button
            ref={keepRef}
            type="button"
            onClick={() => setAsking(null)}
            className="h-8 shrink-0 rounded-md border border-warning/40 px-2 font-medium transition-colors hover:bg-warning/20"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={() => leave(asking)}
            className="h-8 shrink-0 rounded-md border border-warning/40 px-2 font-medium transition-colors hover:bg-warning/20"
          >
            Discard
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {failed ? (
          <QuickLookError path={path} name={name} error={file.error} actions={actions} isDir={isDir} />
        ) : (
          <FileViewer
            key={path}
            path={path}
            name={name}
            embedded
            onDirtyChange={setDirty}
            actions={actions}
          />
        )}
      </div>
    </div>
  )

  // FOCUS GOES BACK TO THE LINK. Radix returns it to a `Dialog.Trigger`, and
  // this dialog has none — its opener is a span in a chat bubble — so left
  // alone, focus would fall to `<body>` and a keyboard reader would be thrown
  // out of the transcript. The opener is whatever held focus as the quick look
  // opened (the link focuses itself on click for exactly this), read in a
  // layout effect: before Radix's own mount effect moves focus inside.
  const opener = React.useRef<HTMLElement | null>(null)
  React.useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement) opener.current = document.activeElement
  }, [open, path])
  const onCloseAutoFocus = (event: Event) => {
    if (opener.current?.isConnected) {
      event.preventDefault()
      opener.current.focus({ preventScroll: true })
    }
    onClosed?.()
  }
  // Escape inside CodeMirror's search panel closes the PANEL. Radix listens in
  // the capture phase, so without this the first Escape after a find would
  // close the whole quick look instead. Both shells get it.
  const onEscapeKeyDown = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement | null)?.closest?.('.cm-panels')) event.preventDefault()
  }

  const onOpenChange = (next: boolean) => {
    if (!next) request('close')
  }
  const title = <span className="sr-only">{name}</span>

  if (coarse) {
    return (
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        title={name}
        description={path}
        // The viewer's own toolbar names the file and carries the actions; a
        // second title bar above it would say the same thing twice.
        hideHeader
        dismissible={!dirty}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={onEscapeKeyDown}
      >
        {/* An editor wants the whole sheet, not a cap: the sheet's own
            ceiling (visible height less the notch) less its grab handle
            (6 + 5px), its top hairline and its home-indicator pad.
            `data-vaul-no-drag`: a vertical swipe in here is scrolling a file
            or moving a caret, never "dismiss" — the handle still drags. */}
        <div
          data-vaul-no-drag
          className="h-[calc(var(--vvh,92vh)-var(--safe-top,0px)-12px-var(--kb-safe-bottom,0px))]"
        >
          {body}
        </div>
      </ResponsiveSheet>
    )
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={onEscapeKeyDown}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden',
            'h-[min(720px,calc(100dvh-96px))] w-[min(920px,calc(100vw-48px))]',
            'rounded-[14px] border border-hairline bg-card shadow-lg outline-none',
            'duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          )}
        >
          <DialogPrimitive.Title asChild>{title}</DialogPrimitive.Title>
          {body}
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  )
}

/** `/a/b/c.md` → `/a/b`; `/c.md` → `/`. */
function parentDir(path: string): string {
  const slash = path.lastIndexOf('/')
  if (slash < 0) return path
  return slash === 0 ? '/' : path.slice(0, slash)
}

/**
 * Why the file did not open, in words.
 *
 * The status is what the files API already distinguishes (`FsError`): a 404 is
 * a path with nothing at it — commonly a file Claude MEANT to write — and a 403
 * is the server's confinement (the member jail, the blocklist, a refused
 * symlink), which the quick look states and never works around.
 */
function QuickLookError({
  path,
  name,
  error,
  actions,
  isDir,
}: {
  path: string
  name: string
  error: unknown
  actions: React.ReactNode
  isDir: boolean
}) {
  const status = error instanceof FsError ? error.status : -1
  const detail = error instanceof Error ? error.message : ''
  const [heading, sentence] = isDir
    ? ['This is a folder', 'The quick look opens files. Open the folder in Files to see what is in it.']
    : status === 404
      ? ['File not found', 'Nothing exists at this path. It may have been moved or deleted, or not written yet.']
      : status === 403
        ? ['Can’t open this file here', `Files is not allowed to read this path (${detail}).`]
        : status === 0
          ? ['Can’t reach supermux-server', 'Check the connection and try again.']
          : ['Couldn’t open this file', detail || 'The server could not read it.']
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="glass flex min-h-[var(--sm-toolbar-min-h)] shrink-0 items-center gap-1 border-b border-hairline px-2">
        <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium" title={path}>
          {name}
        </span>
        {actions}
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <TriangleAlert className="size-6" />
        </div>
        <p className="text-sm font-medium text-foreground">{heading}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{sentence}</p>
        <code className="max-w-full break-all rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          {path}
        </code>
      </div>
    </div>
  )
}

export default FileQuickLook
