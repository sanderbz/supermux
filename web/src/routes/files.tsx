import * as React from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowDownUp,
  Eye,
  EyeOff,
  FolderOpen,
  TriangleAlert,
  Upload,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton'
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
import { SessionPicker } from '@/components/session/session-picker'
import {
  HOME_PATH,
  useDeleteFile,
  useDirListing,
  useSessionDir,
  useUploadFiles,
} from '@/hooks/use-files'
import { useSessions } from '@/hooks/use-sessions'
import { useLastActiveSession } from '@/stores/board-create-session-store'
import { useUI } from '@/stores/ui-store'
import { useCompanies } from '@/hooks/use-companies'
import { companyFilesRoot, confineToCompanyRoot } from '@/lib/companies'
import type { FsEntry } from '@/lib/api'

type SortKey = 'name' | 'size' | 'modified'
type SortDir = 'asc' | 'desc'

interface Selected {
  path: string
  name: string
}

export function Files() {
  const { name } = useParams<{ name?: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  // App-wide "last-active session" — the picker's persistent fallback. When the
  // route lands without a `:name` (sidebar Files click) we follow this so the
  // listing opens the session the user was last on instead of $HOME. See
  // stores/board-create-session-store.ts.
  const [lastActive, setLastActive] = useLastActiveSession()
  const { sessions } = useSessions()

  // The effective session for the listing: the explicit URL param wins; absent,
  // the last-active session (only if it still exists in the live list — a
  // stopped/archived session would resolve to a dead dir). Empty string = the
  // user explicitly picked "Home" last time → stay at $HOME.
  const lastActiveExists = lastActive
    ? sessions.some((s) => s.name === lastActive)
    : false
  const effectiveName = name ?? (lastActiveExists ? lastActive! : undefined)
  const sessionDir = useSessionDir(effectiveName)

  // Companies (Bot Mode): a selected company ROOTS the browser at its `root_dir`
  // AND CONFINES navigation to it (owner-lens — not the security boundary; the
  // server-side member files-jail from P3b is separate and unchanged). While a
  // company is active the company root takes PRECEDENCE over the remembered
  // session dir, the last-active-session fallback is suppressed, and any path
  // outside the root (an old `?path=`, a walked-up crumb) CLAMPS back to the root
  // so the owner sees ONLY that company's files. HQ (activeCompany null) — and a
  // stale id that fails open to null — is byte-identical to before: HOME_PATH,
  // unrestricted, sessionDir fallback intact.
  const activeCompany = useUI((s) => s.activeCompany)
  const { companies } = useCompanies()
  const companyRoot = companyFilesRoot(activeCompany, companies)

  const pathParam = searchParams.get('path')
  // With a company active: root at `companyRoot` (precedence over sessionDir),
  // then confine. HQ: the historical resolution, and `confineToCompanyRoot` with
  // a null root is a pass-through, so HQ stays exactly as it was.
  const requestedPath =
    companyRoot !== null
      ? (pathParam ?? companyRoot)
      : (pathParam ?? sessionDir.data ?? HOME_PATH)
  const currentPath = confineToCompanyRoot(requestedPath, companyRoot)

  // Mirror the URL-driven session into the shared cell so a deep link
  // (`/files/foo`) or a focus→files breadcrumb persists the pick. The route's
  // own redirect-from-fallback would otherwise compete with itself.
  React.useEffect(() => {
    if (name && name !== lastActive) setLastActive(name)
  }, [name, lastActive, setLastActive])

  // Persisted across reloads (was local React state that reset every mount —
  // hiding `.claude` etc. the user actually wants to open from here). Default
  // ON (see stores/ui-store.ts).
  const showHidden = useUI((s) => s.showHidden)
  const setShowHidden = useUI((s) => s.setShowHidden)
  const [sortKey, setSortKey] = React.useState<SortKey>('name')
  const [sortDir, setSortDir] = React.useState<SortDir>('asc')
  const [selected, setSelected] = React.useState<Selected | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null)

  const listing = useDirListing(currentPath, showHidden)
  const upload = useUploadFiles()
  const del = useDeleteFile()
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Picker change: navigate to /files/{name} (or /files for Home) and persist
  // the choice. Clear `?path=` so the next listing starts at the session's
  // root rather than wherever we last drilled into.
  const onPickSession = React.useCallback(
    (next: string) => {
      setLastActive(next)
      const target = next ? `/files/${encodeURIComponent(next)}` : '/files'
      navigate(target, { replace: true })
    },
    [navigate, setLastActive],
  )

  const pickerValue = name ?? (lastActiveExists ? lastActive! : '')

  // Resolved absolute dir the server reported (drives breadcrumb + child paths).
  const dirPath = listing.data?.path ?? currentPath
  // With a company active we root at `companyRoot` immediately (no sessionDir
  // read), so the session-resolving skeleton only applies at HQ.
  const sessionResolving =
    companyRoot === null && !!effectiveName && pathParam == null && sessionDir.isLoading

  const navigateTo = React.useCallback(
    (path: string) => {
      setSelected(null)
      // Confine every navigation to the active company's root (breadcrumb floor,
      // Go-up, deep link) so a request outside it lands back at the root, never
      // out of the company. A null root (HQ) is a pass-through.
      const target = confineToCompanyRoot(path, companyRoot)
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('path', target)
        return next
      })
    },
    [setSearchParams, companyRoot],
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
    // `gk-files` — the Grok-skin hook (desktop-only re-skin in grok-mode.css,
    // scoped `[data-grok]` + `@media(min-width:768px)`). Inert off grok and on
    // mobile: the class name alone paints nothing, so the base app and every
    // phone breakpoint stay byte-identical.
    <div className="gk-files flex h-full min-h-0 flex-col overflow-hidden">
      {/* Toolbar — breadcrumb + controls. Hidden on mobile while a file is open.
          The shared mobile top bar was removed, so this header owns the
          safe-area top inset on mobile (≤md). ios-pwa: use the shared
          `safe-header` utility (min-h 56px + additive padding-top:env(top)) so
          the inset GROWS the box instead of eating into a fixed h-14 and tucking
          the toolbar under the notch / Dynamic Island; `sm:pt-0` resets it once
          the desktop SideNav owns the chrome. When a file is open the header is
          hidden on mobile and the viewer below carries the inset instead. */}
      <header
        className={cn(
          'glass safe-header shrink-0 items-center gap-1 border-b border-hairline px-2 sm:pt-0',
          selected ? 'hidden md:flex' : 'flex',
        )}
      >
        <SessionPicker
          value={pickerValue}
          onChange={onPickSession}
          sessions={sessions}
          allowEmpty
          emptyLabel="Home"
          ariaLabel="Files for session"
          menuLabel="Open files for"
          className="ml-1 mr-1 shrink-0 max-w-[8rem] sm:max-w-[12rem]"
        />
        <Breadcrumb path={dirPath} onNavigate={navigateTo} floor={companyRoot} />

        <div className="flex shrink-0 items-center gap-0.5">
          <ToolbarButton
            label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
            onClick={() => setShowHidden(!showHidden)}
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
                onHome={() => navigateTo(companyRoot ?? HOME_PATH)}
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
  // B5/T11.1 — one of seven idioms, now the shared primitive. The REGION is
  // what changed behaviourally: these bars are `aria-hidden`, so before this a
  // screen-reader user was told nothing at all while the directory loaded.
  return (
    <SkeletonRegion label="Loading files…" className="flex flex-col gap-2 p-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-9 bg-muted/40" />
      ))}
    </SkeletonRegion>
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
