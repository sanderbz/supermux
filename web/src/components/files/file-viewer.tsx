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
import { filesApi } from '@/lib/api'
import type { FileMeta } from '@/lib/api'
import { useFileContent, useSaveFile } from '@/hooks/use-files'
import { extOf, isMarkdown, isWritable } from './file-types'

// Lazy-load the CodeMirror editor (and its core bundle) so it only ships when a
// text file is actually opened — keeps the initial route bundle lean (M29).
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
  /** Mobile drill-down back affordance (hidden on desktop). */
  onBack: () => void
  onRequestDelete: (path: string) => void
}

/** Type-aware file viewer / editor (§M20). Render with a `key={path}` so editor
 *  draft state resets cleanly when a new file is opened. */
export function FileViewer({
  path,
  name,
  onBack,
  onRequestDelete,
}: FileViewerProps) {
  const { data, isLoading, isError, error } = useFileContent(path)
  const save = useSaveFile()
  const reduce = useReducedMotion()

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

  // Markdown surface mode (M-MD). Opens in `preview` for `.md`/`.markdown`/
  // `.mdx`; the user flips to `source` (CodeMirror) to edit. The Preview
  // surface has no edit affordance, so the only way to dirty the buffer is
  // through Source — no auto-switch effect needed. FileViewer is keyed by
  // path upstream, so opening a different file resets this to `preview`.
  const md = isText && isMarkdown(name)
  const [mdMode, setMdMode] = React.useState<'preview' | 'source'>('preview')

  const onSave = () => {
    if (!dirty) return
    save.mutate(
      { path, content: value },
      { onSuccess: () => setDraft(null) },
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — glass bar with filename + actions. R5: on mobile a file-open
          state hides the files toolbar (which used to carry the safe-area inset),
          so this viewer header owns the top inset via `pt-safe` (reset at `sm`
          once the desktop SideNav owns the chrome) to clear the notch. */}
      {/* SD-6: min-h (not h) so the notch inset (pt-safe) ADDS to the bar height
          rather than eating into a fixed 56px — otherwise the back button, filename
          and actions are squished under the Dynamic Island in the iOS standalone
          PWA. Desktop resets pt-safe (sm:pt-0), where min-h-14 == h-14. */}
      <header className="glass flex min-h-14 shrink-0 items-center gap-1 border-b border-border px-2 pt-safe sm:pt-0">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to files"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
        >
          <ChevronLeft className="size-5" />
        </button>
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
              onClick={onSave}
              disabled={!dirty || save.isPending}
              className="h-11 gap-1.5 px-3"
            >
              <Save className="size-4" />
              Save
            </Button>
          </>
        )}

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
            <DropdownMenuItem
              onClick={() => onRequestDelete(path)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Body. */}
      <div className="relative min-h-0 flex-1">
        {isLoading ? (
          <Centered>
            <LoaderCircle className="size-6 animate-spin text-muted-foreground" />
          </Centered>
        ) : isError ? (
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
              renderMarkdown={md && mdMode === 'preview'}
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
}: {
  data: FileMeta
  name: string
  path: string
  editable: boolean
  truncated: boolean
  value: string
  onChange: (v: string) => void
  renderMarkdown: boolean
}) {
  if ('is_image' in data) {
    return (
      <Centered className="bg-muted/30 p-6">
        <img
          src={data.data_url}
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
          Showing the first 200 KB — saving is disabled for truncated files.
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
