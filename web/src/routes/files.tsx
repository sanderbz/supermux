import * as React from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowDownUp,
  Eye,
  EyeOff,
  FolderOpen,
  TriangleAlert,
  Upload,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { EmptyStatePlaceholder } from '@/components/empty-state'
import { Breadcrumb } from '@/components/files/breadcrumb'
import { FileList } from '@/components/files/file-list'
import { FileViewer } from '@/components/files/file-viewer'
import { Dropzone } from '@/components/files/dropzone'
import {
  HOME_PATH,
  useDeleteFile,
  useDirListing,
  useSessionDir,
  useUploadFiles,
} from '@/hooks/use-files'
import type { FsEntry } from '@/lib/api'

type SortKey = 'name' | 'size' | 'modified'
type SortDir = 'asc' | 'desc'

interface Selected {
  path: string
  name: string
}

export function Files() {
  const { name } = useParams<{ name?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const sessionDir = useSessionDir(name)

  const pathParam = searchParams.get('path')
  const currentPath = pathParam ?? sessionDir.data ?? HOME_PATH

  const [showHidden, setShowHidden] = React.useState(false)
  const [sortKey, setSortKey] = React.useState<SortKey>('name')
  const [sortDir, setSortDir] = React.useState<SortDir>('asc')
  const [selected, setSelected] = React.useState<Selected | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null)

  const listing = useDirListing(currentPath, showHidden)
  const upload = useUploadFiles()
  const del = useDeleteFile()
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Resolved absolute dir the server reported (drives breadcrumb + child paths).
  const dirPath = listing.data?.path ?? currentPath
  const sessionResolving = !!name && pathParam == null && sessionDir.isLoading

  const navigateTo = React.useCallback(
    (path: string) => {
      setSelected(null)
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('path', path)
        return next
      })
    },
    [setSearchParams],
  )

  const sorted = React.useMemo(() => {
    const entries = listing.data?.entries ?? []
    const dir = sortDir === 'asc' ? 1 : -1
    return [...entries].sort((a, b) => {
      // Directories always group first; sort applies within each group.
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      const cmp =
        sortKey === 'name'
          ? a.name.localeCompare(b.name)
          : sortKey === 'size'
            ? a.size - b.size
            : a.modified - b.modified
      return cmp * dir
    })
  }, [listing.data, sortKey, sortDir])

  const onUploadFiles = (files: File[]) => {
    if (!files.length) return
    upload.mutate({ dir: dirPath, files })
  }

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    const target = pendingDelete
    del.mutate(target, {
      onSuccess: () => {
        if (selected?.path === target) setSelected(null)
        setPendingDelete(null)
      },
      onSettled: () => setPendingDelete(null),
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Toolbar — breadcrumb + controls. Hidden on mobile while a file is open.
          R5: the shared mobile top bar was removed, so this header owns the
          safe-area top inset on mobile (≤md). ios-pwa: use the shared
          `safe-header` utility (min-h 56px + additive padding-top:env(top)) so
          the inset GROWS the box instead of eating into a fixed h-14 and tucking
          the toolbar under the notch / Dynamic Island; `sm:pt-0` resets it once
          the desktop SideNav owns the chrome. When a file is open the header is
          hidden on mobile and the viewer below carries the inset instead. */}
      <header
        className={cn(
          'glass safe-header shrink-0 items-center gap-1 border-b border-border px-2 sm:pt-0',
          selected ? 'hidden md:flex' : 'flex',
        )}
      >
        <Breadcrumb path={dirPath} onNavigate={navigateTo} />

        <div className="flex shrink-0 items-center gap-0.5">
          <ToolbarButton
            label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
            onClick={() => setShowHidden((v) => !v)}
            active={showHidden}
          >
            {showHidden ? (
              <Eye className="size-4" />
            ) : (
              <EyeOff className="size-4" />
            )}
          </ToolbarButton>

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Sort"
                    className="flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <ArrowDownUp className="size-4" />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Sort</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={sortKey === 'name'}
                onSelect={(e) => {
                  e.preventDefault()
                  onSort('name')
                }}
              >
                Name {sortKey === 'name' ? arrow(sortDir) : ''}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={sortKey === 'size'}
                onSelect={(e) => {
                  e.preventDefault()
                  onSort('size')
                }}
              >
                Size {sortKey === 'size' ? arrow(sortDir) : ''}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={sortKey === 'modified'}
                onSelect={(e) => {
                  e.preventDefault()
                  onSort('modified')
                }}
              >
                Last modified {sortKey === 'modified' ? arrow(sortDir) : ''}
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ToolbarButton
            label="Upload files"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="size-4" />
          </ToolbarButton>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              onUploadFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
        </div>
      </header>

      {/* Split: list (sidebar on desktop / full on mobile) + viewer. */}
      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            'min-h-0 w-full flex-col border-border md:flex md:w-80 md:shrink-0 md:border-r lg:w-96',
            selected ? 'hidden md:flex' : 'flex',
          )}
        >
          <Dropzone
            onFiles={onUploadFiles}
            disabled={listing.isError}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {sessionResolving || listing.isLoading ? (
              <ListSkeleton />
            ) : listing.isError ? (
              <ListError
                message={
                  (listing.error as Error)?.message ??
                  'Could not list this directory.'
                }
                onHome={() => navigateTo(HOME_PATH)}
              />
            ) : sorted.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <EmptyStatePlaceholder
                  icon={<FolderOpen />}
                  message="Nothing here. Drop files to upload, or go up a level."
                  cta={
                    listing.data?.parent
                      ? {
                          label: 'Go up',
                          onClick: () => navigateTo(listing.data!.parent!),
                        }
                      : undefined
                  }
                />
              </div>
            ) : (
              <FileList
                dirPath={dirPath}
                entries={sorted}
                selectedPath={selected?.path ?? null}
                onOpenDir={navigateTo}
                onOpenFile={(entry: FsEntry, path) =>
                  setSelected({ path, name: entry.name })
                }
                onDelete={(path) => setPendingDelete(path)}
              />
            )}
          </Dropzone>
        </div>

        {/* Viewer — full screen on mobile when selected, main pane on desktop. */}
        <div
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col',
            selected ? 'flex' : 'hidden md:flex',
          )}
        >
          {selected ? (
            <FileViewer
              key={selected.path}
              path={selected.path}
              name={selected.name}
              onBack={() => setSelected(null)}
              onRequestDelete={(path) => setPendingDelete(path)}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <p className="max-w-xs text-sm text-muted-foreground">
                Select a file to view or edit it.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation. */}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this item?</DialogTitle>
            <DialogDescription>
              This removes{' '}
              <span className="font-mono text-foreground">
                {pendingDelete ? baseName(pendingDelete) : ''}
              </span>{' '}
              from disk. It can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={del.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ToolbarButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            'flex size-11 items-center justify-center rounded-lg transition-colors hover:bg-accent hover:text-foreground',
            active ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3" aria-hidden>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-md bg-muted/40" />
      ))}
    </div>
  )
}

function ListError({
  message,
  onHome,
}: {
  message: string
  onHome: () => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlert className="size-6" />
      </div>
      <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" onClick={onHome}>
        Go to home directory
      </Button>
    </div>
  )
}

function arrow(dir: SortDir): string {
  return dir === 'asc' ? '↑' : '↓'
}

function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
