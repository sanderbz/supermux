import * as React from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownUp,
  CheckSquare,
  Eye,
  EyeOff,
  FolderOpen,
  Plus,
  TriangleAlert,
  Upload,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { agentHref } from '@/lib/agent-href'
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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useToast } from '@/components/ui/use-toast'
import { EmptyStatePlaceholder } from '@/components/empty-state'
import { Breadcrumb } from '@/components/files/breadcrumb'
import { childPath, FileList } from '@/components/files/file-list'
import { FileViewer } from '@/components/files/file-viewer'
import { Dropzone } from '@/components/files/dropzone'
import { DirPickerSheet } from '@/components/files/dir-picker-sheet'
import { downloadEntry } from '@/components/files/download'
import { HqProjects } from '@/components/files/hq-projects'
import { NameSheet } from '@/components/files/name-sheet'
import {
  NewEntrySheet,
  type NewEntryKind,
} from '@/components/files/new-entry-sheet'
import { SelectBar } from '@/components/files/select-bar'
import { SendToBotSheet } from '@/components/files/send-to-bot-sheet'
import { SpaceCrumb } from '@/components/files/space-crumb'
import { UploadTray, useUploads } from '@/components/files/upload-tray'
import { SpacesGrid } from '@/components/files/spaces-grid'
import { spaceCards, spacesSkipTarget } from '@/components/files/spaces'
import { uploads } from '@/lib/upload/manager'
import { useIsMember } from '@/stores/viewer-store'
import { attachmentSentence } from '@/components/chat/composer-insert'
import { insertIntoComposer } from '@/components/chat/composer-draft'
import {
  HOME_PATH,
  useCopyEntry,
  useDeleteFile,
  useDirListing,
  useFilesLive,
  useMkdir,
  useMoveEntry,
  useSaveFile,
  useSessionDir,
} from '@/hooks/use-files'
import { useSessions } from '@/hooks/use-sessions'
import { useLastActiveSession } from '@/stores/board-create-session-store'
import { useFilesActivityStore } from '@/stores/files-activity-store'
import { useUI } from '@/stores/ui-store'
import { useCompanies } from '@/hooks/use-companies'
import {
  companyFilesRoot,
  confineToCompanyRoot,
  inCompanyScope,
} from '@/lib/companies'
import { mapWithLimit } from '@/lib/concurrency'
import {
  bulkTarget,
  duplicateName,
  summarizeBulk,
  type BulkVerb,
} from '@/lib/files-bulk'
import { filesApi, FsError, projectsApi, type FsEntry } from '@/lib/api'

type SortKey = 'name' | 'size' | 'modified'
type SortDir = 'asc' | 'desc'

/** One entry the row menu / bulk bar acts on. */
interface Target {
  path: string
  name: string
  isDir: boolean
}

/** The destination sheet's live intent. */
interface PickerIntent {
  verb: 'move' | 'copy'
  targets: Target[]
}

export function Files() {
  const { name } = useParams<{ name?: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { toast } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  // App-wide "last-active session" — still written by a `/files/:name` deep
  // link so the rest of the app follows, but it is no longer what `/files`
  // LANDS on: the landing is the Spaces grid now (§4.1), not a directory.
  const [lastActive, setLastActive] = useLastActiveSession()
  const { sessions } = useSessions()

  const effectiveName = name
  const sessionDir = useSessionDir(effectiveName)

  // Companies (Bot Mode): a selected company ROOTS the browser at its `root_dir`
  // AND CONFINES navigation to it (owner-lens — not the security boundary; the
  // server-side member files-jail from P3b is separate and unchanged). While a
  // company is active the company root takes PRECEDENCE over the remembered
  // session dir and any path outside the root (an old `?path=`, a walked-up
  // crumb) CLAMPS back to the root so the owner sees ONLY that company's files.
  // HQ (activeCompany null) — and a stale id that fails open to null — is
  // byte-identical to before: HOME_PATH, unrestricted, sessionDir fallback intact.
  const activeCompany = useUI((s) => s.activeCompany)
  const setActiveCompany = useUI((s) => s.setActiveCompany)
  const { companies } = useCompanies()
  const companyRoot = companyFilesRoot(activeCompany, companies)

  const pathParam = searchParams.get('path')
  const viewParam = searchParams.get('view')
  const selectParam = searchParams.get('select')

  // HQ's landing CONTENTS (owner decision D1) — the `SUPERMUX_PROJECT_DIRS`
  // subdir list, NOT `$HOME`. Deliberately not member-reachable: a scoped human
  // gets `{root:'', entries:[]}`, and never renders HQ at all.
  const projects = useQuery({
    queryKey: ['files', 'projects'],
    queryFn: projectsApi.list,
    staleTime: 60_000,
    retry: false,
  })
  const projectEntries = projects.data?.entries ?? []

  // A one-card chooser is condescending — see `spacesSkipTarget` for exactly
  // what this client can observe and what it deliberately does not claim.
  //
  // Held at null WHILE THE PROJECTS QUERY IS IN FLIGHT: an in-flight query looks
  // exactly like an empty one, so deciding on it would route a two-space owner
  // into a company for a frame and then bounce them back to the grid.
  const skipTarget = projects.isLoading
    ? null
    : spacesSkipTarget(companies, projectEntries.length)

  // ── which surface? ──────────────────────────────────────────────────────
  // `?path=` → a directory. `?view=hq` → HQ's projects list. `?view=spaces` →
  // the grid, explicitly. Nothing → the grid, unless a session deep link or the
  // skip rule names a directory. Three states, one param each: no surface can
  // be reached two ways, so Back always undoes exactly one step.
  // Precedence: an explicit `?path=` is always a directory; otherwise an
  // explicit `?view=` wins over the `/files/:name` session param, so "All
  // spaces" works from a session deep link instead of being out-voted by the
  // `:name` still in the URL.
  // A live company scope OPENS that company's drive directly — not the all-spaces
  // chooser. Selecting a company in the nav must land you IN its files (the owner
  // bug: Files showed every space regardless of scope). `companyRoot !== null`
  // means a real company is active (HQ / a stale id fail open to null → the grid,
  // unchanged: HQ sees everything). An explicit `?view=` still wins, so "All
  // spaces" / HQ remain reachable on demand; `requestedPath` already defaults to
  // `companyRoot`, so this drops the owner straight into that company's root.
  const wantsDirectory =
    pathParam != null || (!viewParam && (companyRoot !== null || !!name || !!skipTarget))
  const showHq = !wantsDirectory && viewParam === 'hq'
  const showSpaces = !wantsDirectory && !showHq && !projects.isLoading

  const requestedPath =
    pathParam ??
    (companyRoot !== null
      ? companyRoot
      : (sessionDir.data ?? skipTarget ?? HOME_PATH))
  const currentPath = wantsDirectory
    ? confineToCompanyRoot(requestedPath, companyRoot)
    : ''

  // Mirror the URL-driven session into the shared cell so a deep link
  // (`/files/foo`) or a focus→files breadcrumb persists the pick.
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
  const [pendingDelete, setPendingDelete] = React.useState<Target[] | null>(null)

  // Multi-select (§4.5). A toolbar toggle, never a long-press.
  const [selectMode, setSelectMode] = React.useState(false)
  const [checked, setChecked] = React.useState<ReadonlySet<string>>(new Set())
  const [bulkBusy, setBulkBusy] = React.useState(false)

  // Sheets.
  const [newOpen, setNewOpen] = React.useState(false)
  const [renameTarget, setRenameTarget] = React.useState<Target | null>(null)
  const [picker, setPicker] = React.useState<PickerIntent | null>(null)
  const [sendTarget, setSendTarget] = React.useState<Target | null>(null)

  // The viewer's unsaved-draft flag, lifted so liveness can honour it: a
  // refetch under a dirty buffer is the data loss the 409 guard exists to
  // prevent, arriving through the back door.
  const [viewerDirty, setViewerDirty] = React.useState(false)

  const listing = useDirListing(currentPath, showHidden, wantsDirectory)
  const del = useDeleteFile()
  const mkdir = useMkdir()
  const move = useMoveEntry()
  const copy = useCopyEntry()
  const save = useSaveFile()
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Resolved absolute dir the server reported (drives breadcrumb + child paths).
  const dirPath = listing.data?.path ?? currentPath
  const entries = React.useMemo(
    () => listing.data?.entries ?? [],
    [listing.data],
  )

  // ── `?select=` — the viewer is a LINKABLE state now (§4.6) ──────────────
  // Basename only, never a full path: a crafted link can only ever select
  // something inside the directory the listing already resolved, and a name
  // that isn't in `entries` is ignored rather than erroring.
  const selected = React.useMemo(() => {
    if (!selectParam || !wantsDirectory) return null
    const hit = entries.find((e) => e.name === selectParam && e.type !== 'dir')
    return hit ? { path: childPath(dirPath, hit.name), name: hit.name } : null
  }, [selectParam, entries, dirPath, wantsDirectory])

  const setSelected = React.useCallback(
    (next: string | null) => {
      // PUSHED, not replaced: the whole point of putting the viewer in the URL
      // is that browser Back closes it. A replace would make Back leave Files
      // entirely, which is what it did before there was a param at all.
      setSearchParams((prev) => {
        const p = new URLSearchParams(prev)
        if (next) p.set('select', next)
        else p.delete('select')
        return p
      })
    },
    [setSearchParams],
  )

  // Liveness (§3): the company-stamped `files` frame. Returns the open file's
  // path when it changed on disk under a DIRTY draft — we never refetch over
  // one, so the viewer surfaces it and the user decides.
  const changedOnDisk = useFilesLive(
    {
      dirPath: wantsDirectory ? dirPath : null,
      openPath: selected?.path ?? null,
      dirty: viewerDirty,
    },
    companies,
  )

  const activity = useFilesActivityStore((s) => s.bySpace)
  // An invited colleague has NO HQ space: they are fenced to one company
  // server-side (`server/src/scope.rs` — the files jail included), so an HQ card
  // would be a door that opens on a 404. The owner keeps it, unchanged.
  const isMember = useIsMember()
  const cards = React.useMemo(
    () => spaceCards(companies, sessions, activity, { includeHq: !isMember }),
    [companies, sessions, activity, isMember],
  )

  // Bots offered by "Send to bot" and the crumb's secondary group: the ACTIVE
  // space only, so a company's file can never be handed to a bot outside it.
  const spaceSessions = React.useMemo(
    () => sessions.filter((s) => inCompanyScope(s.company_id, activeCompany)),
    [sessions, activeCompany],
  )

  const goto = React.useCallback(
    (next: Record<string, string | null>) => {
      setSearchParams((prev) => {
        const p = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(next)) {
          if (v === null) p.delete(k)
          else p.set(k, v)
        }
        return p
      })
    },
    [setSearchParams],
  )

  /** Navigate to a SPACE, dropping any `/files/:name` still in the path. A
   *  space pick is a scope change; leaving the session segment behind would
   *  keep resolving that bot's dir underneath the new space. */
  const gotoSpace = React.useCallback(
    (next: Record<string, string>) => {
      const p = new URLSearchParams(next)
      navigate(`/files${p.size ? `?${p}` : ''}`)
    },
    [navigate],
  )

  const navigateTo = React.useCallback(
    (path: string) => {
      // Confine every navigation to the active company's root (breadcrumb floor,
      // Go-up, deep link) so a request outside it lands back at the root, never
      // out of the company. A null root (HQ) is a pass-through.
      goto({
        path: confineToCompanyRoot(path, companyRoot),
        select: null,
        view: null,
      })
    },
    [goto, companyRoot],
  )

  const sorted = React.useMemo(() => {
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
  }, [entries, sortKey, sortDir])

  // Uploads go through the CHUNKED, RESUMABLE manager (`lib/upload/manager`),
  // not a single buffered multipart POST: the old path held every byte in
  // server memory, capped at 200 MB, showed no progress, and lost the whole
  // transfer on any blip. The manager is a module singleton, so a 9 GB upload
  // keeps running while the person browses elsewhere in the app.
  const onUploadFiles = (files: File[]) => {
    if (!files.length) return
    uploads.enqueue(dirPath, files)
  }

  // The `files` SSE frame already refreshes the listing when a file lands, but
  // that stream can be scoped or briefly down; a completed upload must never
  // leave the directory it went into looking empty.
  const uploadItems = useUploads()
  const doneCount = uploadItems.filter((u) => u.state === 'done').length
  React.useEffect(() => {
    if (doneCount > 0) void qc.invalidateQueries({ queryKey: ['files', 'ls'] })
  }, [doneCount, qc])

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  // ── the bulk fan-out (§4.5) ─────────────────────────────────────────────
  // No server batch endpoint: N single verbs at concurrency 4, then ONE toast
  // that reports partial failure AS partial. Nothing is rolled back — the items
  // that succeeded really did move, and pretending otherwise would be a second
  // lie on top of the first.
  const runBulk = React.useCallback(
    async (
      verb: BulkVerb,
      targets: readonly Target[],
      fn: (t: Target) => Promise<unknown>,
    ) => {
      if (targets.length === 0) return
      setBulkBusy(true)
      // `mapWithLimit` settles every item and never rejects, so there is no
      // catch here to swallow — the outcome IS the result array.
      const results = await mapWithLimit(targets, 4, fn)
      setBulkBusy(false)
      const summary = summarizeBulk(verb, results)
      toast({
        message: summary.message,
        tone: summary.tone,
        duration: summary.failed ? 6000 : 3000,
      })
      // Both this and the incoming SSE frames converge on the same key, which
      // is idempotent.
      void qc.invalidateQueries({ queryKey: ['files', 'ls'] })
      if (summary.failed === 0) {
        setSelectMode(false)
        setChecked(new Set())
      }
    },
    [qc, toast],
  )

  const checkedTargets = React.useMemo<Target[]>(
    () =>
      sorted
        .map((e) => ({
          path: childPath(dirPath, e.name),
          name: e.name,
          isDir: e.type === 'dir',
        }))
        .filter((t) => checked.has(t.path)),
    [sorted, dirPath, checked],
  )

  const toggleChecked = (path: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const exitSelect = () => {
    setSelectMode(false)
    setChecked(new Set())
  }

  const targetOf = (entry: FsEntry, path: string): Target => ({
    path,
    name: entry.name,
    isDir: entry.type === 'dir',
  })

  // ── row actions ─────────────────────────────────────────────────────────

  const onCreate = (kind: NewEntryKind, entryName: string) => {
    const target = childPath(dirPath, entryName)
    const done = (message: string) => {
      setNewOpen(false)
      toast({ message })
    }
    const fail = (e: unknown) =>
      toast({
        message: `Couldn’t create “${entryName}” — ${(e as Error).message}`,
        tone: 'error',
        duration: 5000,
      })
    if (kind === 'folder') {
      mkdir.mutate(target, {
        onSuccess: () => done(`Created ${entryName}`),
        onError: fail,
      })
    } else {
      // `if_modified: 0` is the server's "I am creating a NEW file" assertion:
      // it 409s on an existing path instead of silently truncating it. No new
      // endpoint — `put_file` already creates parents.
      save.mutate(
        { path: target, content: '', ifModified: 0 },
        { onSuccess: () => done(`Created ${entryName}`), onError: fail },
      )
    }
  }

  const onRenameSubmit = (nextName: string) => {
    const t = renameTarget
    if (!t) return
    move.mutate(
      { from: t.path, to: childPath(dirPath, nextName) },
      {
        onSuccess: () => {
          setRenameTarget(null)
          if (selected?.name === t.name) setSelected(nextName)
          toast({ message: `Renamed to ${nextName}` })
        },
        onError: (e) =>
          toast({
            message: `Rename failed — ${(e as Error).message}`,
            tone: 'error',
            duration: 5000,
          }),
      },
    )
  }

  /** Duplicate — `POST /api/fs/copy` with a client-proposed name and the 409
   *  ladder. The upload path's silent dedupe is deliberately NOT reused: it
   *  renames without telling you, which is the clobber-adjacent surprise the
   *  409 exists to prevent. Here every attempt is a name the user can read in
   *  the toast. */
  const onDuplicate = async (entry: FsEntry, path: string) => {
    const MAX = 20
    for (let attempt = 1; attempt <= MAX; attempt += 1) {
      const proposed = duplicateName(entry.name, attempt)
      try {
        await filesApi.copy(path, childPath(dirPath, proposed))
        void qc.invalidateQueries({ queryKey: ['files', 'ls'] })
        toast({ message: `Duplicated to ${proposed}` })
        return
      } catch (e) {
        if (e instanceof FsError && e.status === 409) continue
        toast({
          message: `Duplicate failed — ${(e as Error).message}`,
          tone: 'error',
          duration: 5000,
        })
        return
      }
    }
    toast({
      message: `Couldn’t find a free name after ${MAX} tries — rename some copies first.`,
      tone: 'error',
      duration: 6000,
    })
  }

  const onPickDestination = (destDir: string) => {
    const intent = picker
    if (!intent) return
    setPicker(null)
    void runBulk(intent.verb, intent.targets, (t) =>
      intent.verb === 'move'
        ? filesApi.move(t.path, bulkTarget(destDir, t.name))
        : filesApi.copy(t.path, bulkTarget(destDir, t.name)),
    )
  }

  const confirmDelete = () => {
    const targets = pendingDelete
    if (!targets) return
    setPendingDelete(null)
    if (targets.length === 1) {
      const only = targets[0]!
      del.mutate(only.path, {
        onSuccess: () => {
          if (selected?.path === only.path) setSelected(null)
        },
        onError: (e) =>
          toast({
            message: `Delete failed — ${(e as Error).message}`,
            tone: 'error',
            duration: 5000,
          }),
      })
      return
    }
    void runBulk('delete', targets, (t) => filesApi.deleteFile(t.path))
  }

  const onSendPick = (session: string) => {
    const t = sendTarget
    setSendTarget(null)
    if (!t) return
    // The canonical wire format, already pinned byte-identical to
    // `buildAttachmentPrompt` — do not re-derive it a third time.
    insertIntoComposer(session, attachmentSentence([t.path]))
    navigate(agentHref(session))
  }

  // ── space navigation ────────────────────────────────────────────────────

  const openSpace = (id: number | null, path: string | null) => {
    // Set the app-wide scope FIRST so roster, overview and switcher follow the
    // same pick — Files is not a private lens on companies.
    setActiveCompany(id)
    exitSelect()
    if (path) gotoSpace({ path })
    else gotoSpace({ view: 'hq' })
  }

  const onPickSession = (next: string) => {
    setLastActive(next)
    navigate(`/files/${encodeURIComponent(next)}`)
  }

  const sessionResolving =
    companyRoot === null && !!effectiveName && pathParam == null && sessionDir.isLoading

  const header = (
    // Toolbar — space crumb + path + controls. Hidden on mobile while a file is
    // open. The shared mobile top bar was removed, so this header owns the
    // safe-area top inset on mobile (≤md) via the shared `safe-header` utility
    // (min-h 56px + additive padding-top:env(top)) so the inset GROWS the box
    // instead of tucking the toolbar under the notch; `sm:pt-0` resets it once
    // the desktop SideNav owns the chrome.
    <header
      className={cn(
        'glass safe-header shrink-0 items-center gap-1 border-b border-hairline px-2 sm:pt-0',
        selected ? 'hidden md:flex' : 'flex',
      )}
    >
      <SpaceCrumb
        activeCompany={activeCompany}
        companies={companies}
        sessions={spaceSessions}
        onPickSpace={(id) =>
          openSpace(id, id === null ? null : companyFilesRoot(id, companies))
        }
        onShowSpaces={() => {
          exitSelect()
          gotoSpace({ view: 'spaces' })
        }}
        onPickSession={onPickSession}
        allowHq={!isMember}
      />
      {wantsDirectory && (
        <Breadcrumb path={dirPath} onNavigate={navigateTo} floor={companyRoot} />
      )}
      {!wantsDirectory && <span className="min-w-0 flex-1" />}

      <div className="flex shrink-0 items-center gap-0.5">
        {/* View options. `Show hidden` and `Select` live INSIDE the sort menu
            rather than as their own header buttons: at 390px the space crumb
            (which replaced the 8rem SessionPicker) plus five 44px buttons plus
            a path crumb does not fit, and the two least-used controls are the
            ones that move. Both are still one tap from a 44px trigger. */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="View options"
                  disabled={!wantsDirectory}
                  className="flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <ArrowDownUp className="size-4" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>View options</TooltipContent>
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
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={showHidden}
              onSelect={(e) => {
                e.preventDefault()
                setShowHidden(!showHidden)
              }}
            >
              {showHidden ? (
                <Eye className="size-4" />
              ) : (
                <EyeOff className="size-4" />
              )}
              Hidden files
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem
              onClick={() => {
                setChecked(new Set())
                setSelectMode((v) => !v)
              }}
            >
              <CheckSquare className="size-4" />
              {selectMode ? 'Done selecting' : 'Select…'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ToolbarButton
          label="New folder or file"
          onClick={() => setNewOpen(true)}
          disabled={!wantsDirectory}
        >
          <Plus className="size-4" />
        </ToolbarButton>

        <ToolbarButton
          label="Upload files"
          onClick={() => fileInputRef.current?.click()}
          disabled={!wantsDirectory}
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
  )

  return (
    // `gk-files` — the Grok-skin hook (desktop-only re-skin in grok-mode.css,
    // scoped `[data-grok]` + `@media(min-width:768px)`). Inert off grok and on
    // mobile: the class name alone paints nothing, so the base app and every
    // phone breakpoint stay byte-identical.
    <div className="gk-files flex h-full min-h-0 flex-col overflow-hidden">
      {header}

      {showSpaces ? (
        <SpacesGrid
          cards={cards}
          activeCompany={activeCompany}
          onOpen={(card) => openSpace(card.id, card.path)}
        />
      ) : showHq ? (
        <HqProjects
          root={projects.data?.root ?? ''}
          entries={projectEntries}
          onOpen={(p) => navigateTo(p)}
          onOpenHome={() => navigateTo(HOME_PATH)}
        />
      ) : !wantsDirectory ? (
        <ListSkeleton />
      ) : (
        /* Split: list (sidebar on desktop / full on mobile) + viewer. */
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
              className={cn(
                'min-h-0 flex-1 overflow-y-auto',
                // The bottom bar is fixed, so the last row would otherwise be
                // trapped under it on a phone.
                // Room for whichever fixed-bottom surface is up: the select
                // bar, or the upload tray while uploads are listed.
                (selectMode || uploadItems.length > 0) && 'pb-24',
              )}
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
                  onOpenFile={(entry: FsEntry) => setSelected(entry.name)}
                  onDelete={(path, isDir) =>
                    setPendingDelete([
                      { path, name: baseName(path), isDir },
                    ])
                  }
                  onRename={(entry, path) =>
                    setRenameTarget(targetOf(entry, path))
                  }
                  onMove={(entry, path) =>
                    setPicker({ verb: 'move', targets: [targetOf(entry, path)] })
                  }
                  onCopy={(entry, path) =>
                    setPicker({ verb: 'copy', targets: [targetOf(entry, path)] })
                  }
                  onDuplicate={(entry, path) => void onDuplicate(entry, path)}
                  onSendToBot={(entry, path) =>
                    setSendTarget(targetOf(entry, path))
                  }
                  selectMode={selectMode}
                  selectedPaths={checked}
                  onToggleSelect={toggleChecked}
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
                onRequestDelete={(path) =>
                  setPendingDelete([
                    { path, name: baseName(path), isDir: false },
                  ])
                }
                onDirtyChange={setViewerDirty}
                changedOnDisk={changedOnDisk === selected.path}
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
      )}

      {selectMode && wantsDirectory && !selected && (
        <SelectBar
          count={checked.size}
          busy={bulkBusy}
          canCopy={checkedTargets.length > 0 && checkedTargets.every((t) => !t.isDir)}
          onMove={() => setPicker({ verb: 'move', targets: checkedTargets })}
          onCopy={() => setPicker({ verb: 'copy', targets: checkedTargets })}
          onDownload={() =>
            void runBulk('download', checkedTargets, (t) =>
              t.isDir
                ? Promise.reject(
                    new Error('downloading a folder isn’t supported yet'),
                  )
                : downloadEntry(t.path, t.name),
            )
          }
          onDelete={() => setPendingDelete(checkedTargets)}
          onCancel={exitSelect}
        />
      )}

      <UploadTray />

      <NewEntrySheet
        key={newOpen ? 'new-open' : 'new-closed'}
        open={newOpen}
        onOpenChange={setNewOpen}
        dirPath={dirPath}
        onCreate={onCreate}
        pending={mkdir.isPending || save.isPending}
      />

      <NameSheet
        key={renameTarget?.path ?? 'rename-closed'}
        open={renameTarget !== null}
        onOpenChange={(o) => !o && setRenameTarget(null)}
        title="Rename"
        description={renameTarget?.path}
        initial={renameTarget?.name ?? ''}
        submitLabel="Rename"
        validate={(v) =>
          v.includes('/') ? 'A name can’t contain “/”. Use Move… instead.' : null
        }
        onSubmit={onRenameSubmit}
        pending={move.isPending}
      />

      <DirPickerSheet
        key={picker ? `${picker.verb}:${dirPath}` : 'picker-closed'}
        open={picker !== null}
        onOpenChange={(o) => !o && setPicker(null)}
        title={picker?.verb === 'copy' ? 'Copy to…' : 'Move to…'}
        actionLabel={picker?.verb === 'copy' ? 'Copy here' : 'Move here'}
        startDir={dirPath}
        floor={companyRoot}
        // You cannot move a folder into itself; the server refuses it too, but
        // greying the row is the honest version of that answer.
        forbidden={picker?.targets.filter((t) => t.isDir).map((t) => t.path)}
        onPick={onPickDestination}
        pending={bulkBusy || move.isPending || copy.isPending}
      />

      <SendToBotSheet
        open={sendTarget !== null}
        onOpenChange={(o) => !o && setSendTarget(null)}
        fileName={sendTarget?.name ?? ''}
        sessions={spaceSessions}
        onPick={onSendPick}
      />

      {/* Delete confirmation — one dialog for a row and for a selection. */}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingDelete && pendingDelete.length > 1
                ? `Delete ${pendingDelete.length} items?`
                : 'Delete this item?'}
            </DialogTitle>
            <DialogDescription>
              {pendingDelete && pendingDelete.length > 1 ? (
                <>
                  This removes {pendingDelete.length} items from disk. It can’t
                  be undone.
                </>
              ) : (
                <>
                  This removes{' '}
                  <span className="font-mono text-foreground">
                    {pendingDelete?.[0]?.name ?? ''}
                  </span>{' '}
                  from disk. It can’t be undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={del.isPending || bulkBusy}
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
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
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
          disabled={disabled}
          className={cn(
            'flex size-11 items-center justify-center rounded-lg transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40',
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
