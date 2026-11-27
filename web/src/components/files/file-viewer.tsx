import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import {
  ChevronLeft,
  Code2,
  Download,
  EllipsisVertical,
  Eye,
  LoaderCircle,
  RotateCcw,
  Save,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { filesApi, FsError } from '@/lib/api'
import type { FileMeta } from '@/lib/api'
import { useFileContent, useSaveFile } from '@/hooks/use-files'
import { extOf, isMarkdown, isWritable } from './file-types'
import type { CodeEditorHandle } from './code-editor'

// Lazy-load the CodeMirror editor (and its core bundle) so it only ships when a
// text file is actually opened — keeps the initial route bundle lean.
const CodeEditor = React.lazy(() =>
  import('./code-editor').then((m) => ({ default: m.CodeEditor })),
)

// Lazy-load the rendered-markdown viewer + its vendor-markdown chunk
// (react-markdown / remark-gfm / rehype-* / lowlight) — shipped only when the
// user actually opens a `.md` file. Vite's manualChunks splits this into
// `vendor-markdown` so the hero overview / focus route never pays for it.
const MarkdownViewer = React.lazy(() =>
  import('./markdown-viewer').then((m) => ({ default: m.MarkdownViewer })),
)

export interface FileViewerProps {
  path: string
  name: string
  /** Mobile drill-down back affordance (hidden on desktop). Omitted → none. */
  onBack?: () => void
  /** Omitted → the actions menu offers no Delete. */
  onRequestDelete?: (path: string) => void
  /**
   * Hosted inside a dialog or sheet rather than as a route pane (the chat's
   * file quick look). The header then owns no safe-area inset — the sheet
   * already sits below the notch, and `pt-safe` here would stack a second one
   * inside it — and the actions menu is dropped: the quick look's contract is
   * Close, Save and "Go to file", and the full Files view is one tap away for
   * everything else.
   */
  embedded?: boolean
  /** Trailing header controls, after the viewer's own (the quick look's
   *  "Go to file" and Close). */
  actions?: React.ReactNode
  /** Report the unsaved-draft flag UP. Files' liveness needs it: a `files` SSE
   *  frame for this path must NEVER refetch over a dirty buffer, and the route
   *  is where that decision is made. */
  onDirtyChange?: (dirty: boolean) => void
  /** The route observed a `files` frame for this exact path while the buffer
   *  was dirty. Nothing was refetched — this renders the honest banner and
   *  lets the user choose. */
  changedOnDisk?: boolean
}

/** Type-aware file viewer / editor. Render with a `key={path}` so editor
 *  draft state resets cleanly when a new file is opened. */
export function FileViewer({
  path,
  name,
  onBack,
  onRequestDelete,
  onDirtyChange,
  changedOnDisk,
  embedded = false,
  actions,
}: FileViewerProps) {
  const { data, isLoading, isError, error, refetch } = useFileContent(path)
  const save = useSaveFile()
  const reduce = useReducedMotion()
  const editorRef = React.useRef<CodeEditorHandle>(null)

  const isText = !!data && 'content' in data
  const truncated = isText && (data as { truncated?: boolean }).truncated === true
  const editable = isText && isWritable(name) && !truncated

  // Draft is null until the user edits; `value` then falls back to fresh server
  // content. After a successful save we reset to null so the refetched content
  // becomes the new baseline (no effect-based clobbering while typing).
  const [draft, setDraft] = React.useState<string | null>(null)
  const content = isText ? (data as { content: string }).content : ''
  const value = draft ?? content
  const dirty = isText && draft !== null && draft !== content

  // The `modified` the SERVER handed us with this content — the whole input to
  // the lost-update guard. Absent (an older payload) means we send no
  // `if_modified` and get the historical blind write, which is strictly what
  // happened before rather than a new failure mode.
  const modified = isText
    ? (data as { modified?: number }).modified
    : undefined

  // Lift the dirty flag so the route can honour it in the SSE handler.
  React.useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  React.useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  // A 409 from `PUT` is not a generic error: it means someone else (very
  // likely a bot) wrote this file after we read it. Distinguished here so the
  // banner can offer the only two honest choices — take theirs, or keep yours.
  const conflict =
    save.error instanceof FsError && save.error.status === 409
      ? save.error.message
      : null

  // Markdown surface mode. Opens in `preview` for `.md`/`.markdown`/
  // `.mdx`; the user flips to `source` (CodeMirror) to edit. The Preview
  // surface has no edit affordance, so the only way to dirty the buffer is
  // through Source — no auto-switch effect needed. FileViewer is keyed by
  // path upstream, so opening a different file resets this to `preview`.
  const md = isText && isMarkdown(name)
  const [mdMode, setMdMode] = React.useState<'preview' | 'source'>('preview')
  // Find targets the CodeMirror surface; in rendered-markdown mode the browser's
  // own find is what's on screen, so the button would lie.
  const renderMarkdownPreview = md && mdMode === 'preview'

  const onSave = (force = false) => {
    if (!dirty) return
    save.mutate(
      // `force` drops the guard deliberately — the user read the conflict
      // banner and chose to keep their version. Everything else sends it.
      { path, content: value, ifModified: force ? undefined : modified },
      { onSuccess: () => setDraft(null) },
    )
  }

  /** Take the version on disk, discarding the local draft. */
  const reloadFromDisk = () => {
    setDraft(null)
    save.reset()
    void refetch()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — glass bar with filename + actions. On mobile a file-open
          state hides the files toolbar (which used to carry the safe-area inset),
          so this viewer header owns the top inset via `pt-safe` (reset at `sm`
          once the desktop SideNav owns the chrome) to clear the notch. */}
      {/* min-h (not h) so the notch inset (pt-safe) ADDS to the bar height
          rather than eating into a fixed 56px — otherwise the back button, filename
          and actions are squished under the Dynamic Island in the iOS standalone
          PWA. Desktop resets pt-safe (sm:pt-0), where min-h-14 == h-14. */}
      <header
        className={cn(
          'glass flex shrink-0 items-center gap-1 border-b border-hairline px-2 sm:pt-0',
          embedded ? 'min-h-[var(--sm-toolbar-min-h)]' : 'safe-header',
        )}
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to files"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
          >
            <ChevronLeft className="size-5" />
          </button>
        )}
        <div className="flex min-w-0 flex-1 flex-col px-1">
          <span className="truncate text-sm font-medium" title={path}>
            {name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {save.isPending
              ? 'Saving…'
              : dirty
                ? 'Unsaved changes'
                : !isText
                  ? typeLabel(data)
                  : md
                    ? mdMode === 'preview'
                      ? 'Rendered'
                      : editable
                        ? 'Editable source'
                        : 'Source'
                    : editable
                      ? 'Editable'
                      : truncated
                        ? 'Read-only (truncated)'
                        : 'Read-only'}
          </span>
        </div>

        {/* Preview ↔ Source segmented control — only on markdown files. The
            button widths match the icon-only header buttons so the toolbar
            keeps its rhythm on narrow phones. */}
        {md && (
          <div
            role="group"
            aria-label="Markdown view"
            className="mr-1 flex h-9 items-center rounded-lg border border-border bg-card p-0.5"
          >
            <button
              type="button"
              aria-pressed={mdMode === 'preview'}
              onClick={() => setMdMode('preview')}
              title="Rendered preview"
              className={cn(
                'flex h-8 items-center gap-1 rounded-md px-2 text-[12px] font-medium transition-colors',
                mdMode === 'preview'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Eye className="size-3.5" />
              <span className="hidden sm:inline">Preview</span>
            </button>
            <button
              type="button"
              aria-pressed={mdMode === 'source'}
              onClick={() => setMdMode('source')}
              title="Markdown source"
              className={cn(
                'flex h-8 items-center gap-1 rounded-md px-2 text-[12px] font-medium transition-colors',
                mdMode === 'source'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Code2 className="size-3.5" />
              <span className="hidden sm:inline">Source</span>
            </button>
          </div>
        )}

        {editable && (
          <>
            {dirty && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDraft(null)}
                aria-label="Revert changes"
                className="size-11"
              >
                <RotateCcw className="size-4" />
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => onSave()}
              disabled={!dirty || save.isPending}
              className="h-11 gap-1.5 px-3"
            >
              <Save className="size-4" />
              Save
            </Button>
          </>
        )}

        {/* FIND — the whole point of this button is the PHONE. `Mod-f` already
            opens CodeMirror's search panel on a desktop keyboard; a phone has
            no `Mod-f`, and even on desktop nothing on screen said the panel
            existed. This is the affordance, not the feature. */}
        {isText && !renderMarkdownPreview && (
          <button
            type="button"
            aria-label="Find in file"
            onClick={() => editorRef.current?.openSearch()}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Search className="size-4" />
          </button>
        )}

        {!embedded && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="File actions"
                className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <EllipsisVertical className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => window.open(filesApi.rawUrl(path), '_blank')}
              >
                <Download className="size-4" />
                Open raw
              </DropdownMenuItem>
              {onRequestDelete && (
                <DropdownMenuItem
                  onClick={() => onRequestDelete(path)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {actions}
      </header>

      {/* CONFLICT / CHANGED-ON-DISK — the honest half of the lost-update guard.
          `conflict` is a 409 the server just returned; `changedOnDisk` is a
          `files` frame the route observed for this exact path while the buffer
          was dirty (nothing was refetched — that is the point). Both offer the
          only two truthful choices: take what is on disk, or keep yours and
          overwrite deliberately. There is no third option where both survive. */}
      {(conflict || (changedOnDisk && dirty)) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-warning/10 px-4 py-2 text-xs text-warning">
          <TriangleAlert className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {conflict
              ? `Not saved — ${conflict}. Someone (probably a bot) wrote this file after you opened it.`
              : 'This file changed on disk while you were editing it.'}
          </span>
          <button
            type="button"
            onClick={reloadFromDisk}
            className="h-8 shrink-0 rounded-md border border-warning/40 px-2 font-medium transition-colors hover:bg-warning/20"
          >
            Reload
          </button>
          {dirty && (
            <button
              type="button"
              onClick={() => onSave(true)}
              disabled={save.isPending}
              className="h-8 shrink-0 rounded-md border border-warning/40 px-2 font-medium transition-colors hover:bg-warning/20"
            >
              Keep mine
            </button>
          )}
        </div>
      )}

      {/* Body. */}
      <div className="relative min-h-0 flex-1">
        {isLoading ? (
          <Centered>
            <LoaderCircle className="size-6 animate-spin text-muted-foreground" />
          </Centered>
        ) : isError && !data ? (
          // A failed BACKGROUND refetch keeps the last good payload: showing
          // the error card then would unmount the editor out from under a
          // draft. Only a read with nothing in hand is an error screen.
          <ErrorCard message={(error as Error)?.message ?? 'Failed to open file.'} />
        ) : data ? (
          <motion.div
            key={path}
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={springs.cardExpand}
            className="h-full min-h-0"
          >
            <FileBody
              data={data}
              name={name}
              path={path}
              editable={editable}
              truncated={truncated}
              value={value}
              onChange={setDraft}
              renderMarkdown={renderMarkdownPreview}
              editorRef={editorRef}
            />
          </motion.div>
        ) : null}
      </div>
    </div>
  )
}

function FileBody({
  data,
  name,
  path,
  editable,
  truncated,
  value,
  onChange,
  renderMarkdown,
  editorRef,
}: {
  data: FileMeta
  name: string
  path: string
  editable: boolean
  truncated: boolean
  value: string
  onChange: (v: string) => void
  renderMarkdown: boolean
  editorRef: React.RefObject<CodeEditorHandle | null>
}) {
  if ('is_image' in data) {
    // `/api/file/raw`, NOT the envelope's base64 `data_url`. Strictly better
    // than raising the 5 MB `IMAGE_MAX`: it removes that ceiling entirely,
    // drops the 33% base64 bloat, and makes previews browser-cacheable (the
    // endpoint already serves Range + ETag + `private, max-age=3600,
    // immutable`). `rawUrl` carries the `?_token=` fallback because an <img>
    // cannot set an Authorization header. `get_file`'s image branch is
    // untouched server-side — other callers may still rely on the envelope.
    return (
      <Centered className="bg-muted/30 p-6">
        <img
          src={filesApi.rawUrl(path)}
          alt={name}
          className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
        />
      </Centered>
    )
  }

  if ('is_pdf' in data) {
    return (
      <embed
        src={data.data_url}
        type="application/pdf"
        className="h-full w-full"
      />
    )
  }

  if ('is_video' in data) {
    return (
      <Centered className="bg-black p-4">
        <video
          src={filesApi.rawUrl(path)}
          controls
          className="max-h-full max-w-full rounded-lg"
        />
      </Centered>
    )
  }

  if ('is_audio' in data) {
    return (
      <Centered className="p-8">
        <audio src={filesApi.rawUrl(path)} controls className="w-full max-w-md" />
      </Centered>
    )
  }

  if ('is_binary' in data) {
    return (
      <Centered className="gap-4 p-8 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Download className="size-6" />
        </div>
        <p className="max-w-xs text-sm text-muted-foreground">
          Binary file ({data.ext || 'unknown'} · {data.size} bytes). No inline
          preview.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(filesApi.rawUrl(path), '_blank')}
        >
          Open raw
        </Button>
      </Centered>
    )
  }

  // Text — either the CodeMirror editor (Source mode + every non-markdown
  // file), or the rendered MarkdownViewer when the user is reading a `.md` /
  // `.markdown` / `.mdx` in Preview mode. We pass the LATEST draft `value`
  // (not the server `content`) into the renderer so unsaved edits show their
  // typeset form live the moment the user toggles back to Preview.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {truncated && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-warning/10 px-4 py-2 text-xs text-warning">
          <TriangleAlert className="size-4 shrink-0" />
          Showing the first 1 MB — saving is disabled for truncated files.
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <React.Suspense
          fallback={
            <Centered>
              <LoaderCircle className="size-6 animate-spin text-muted-foreground" />
            </Centered>
          }
        >
          {renderMarkdown ? (
            <MarkdownViewer source={value} basePath={path} />
          ) : (
            <CodeEditor
              ref={editorRef}
              name={name}
              value={value}
              editable={editable}
              onChange={onChange}
            />
          )}
        </React.Suspense>
      </div>
    </div>
  )
}

function typeLabel(data: FileMeta | undefined): string {
  if (!data) return ''
  if ('is_image' in data) return 'Image'
  if ('is_pdf' in data) return 'PDF'
  if ('is_video' in data) return 'Video'
  if ('is_audio' in data) return 'Audio'
  if ('is_binary' in data) return `Binary · ${extOf(data.ext) || data.ext}`
  return 'Text'
}

function Centered({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex h-full min-h-0 w-full items-center justify-center overflow-auto',
        className,
      )}
    >
      {children}
    </div>
  )
}

function ErrorCard({ message }: { message: string }) {
  return (
    <Centered className="gap-4 p-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlert className="size-6" />
      </div>
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
    </Centered>
  )
}
