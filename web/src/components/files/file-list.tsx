import * as React from 'react'
import { motion } from 'framer-motion'
import {
  ChevronRight,
  Download,
  EllipsisVertical,
  Folder,
  Share2,
  Trash2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { filesApi, type FsEntry } from '@/lib/api'
import { formatBytes, formatMtime, iconForEntry } from './file-types'

/** Join a directory with a child name, collapsing the root-slash case. */
export function childPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

export interface FileListProps {
  dirPath: string
  entries: FsEntry[]
  selectedPath: string | null
  onOpenDir: (path: string) => void
  onOpenFile: (entry: FsEntry, path: string) => void
  onDelete: (path: string, isDir: boolean) => void
}

/** Detected once per mount: does this browser support sharing files via the Web
 *  Share API? iOS Safari and Android Chrome on HTTPS contexts return true here;
 *  desktop browsers usually false (Chrome desktop on HTTPS does support it). We
 *  probe with a tiny text File so we hide the menu item only when the API genuinely
 *  can't accept files (some browsers expose share() for text/url but not files). */
function detectCanShareFiles(): boolean {
  if (typeof navigator === 'undefined') return false
  if (typeof navigator.share !== 'function') return false
  if (typeof navigator.canShare !== 'function') return false
  try {
    const probe = new File([''], 'probe.txt', { type: 'text/plain' })
    return navigator.canShare({ files: [probe] })
  } catch {
    return false
  }
}

export function FileList({
  dirPath,
  entries,
  selectedPath,
  onOpenDir,
  onOpenFile,
  onDelete,
}: FileListProps) {
  const { toast } = useToast()
  const [canShareFiles] = React.useState(detectCanShareFiles)

  const handleDownload = async (path: string, name: string) => {
    try {
      const res = await fetch(filesApi.rawUrl(path))
      if (!res.ok) throw new Error(`download failed (${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Defer revoke so the browser has time to start the download stream.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      toast({
        message: `Download failed — ${(e as Error).message}`,
        tone: 'error',
        duration: 4000,
      })
    }
  }

  const handleShare = async (path: string, name: string) => {
    try {
      const res = await fetch(filesApi.rawUrl(path))
      if (!res.ok) throw new Error(`fetch failed (${res.status})`)
      const blob = await res.blob()
      const file = new File(
        [blob],
        name,
        { type: blob.type || 'application/octet-stream' },
      )
      const data: ShareData = { files: [file], title: name }
      // canShare with the real file: some types are blocked by the OS share sheet
      // even when the API exists (e.g. .exe on iOS). Surface that as a clean toast.
      if (navigator.canShare && !navigator.canShare(data)) {
        throw new Error('this file type can’t be shared')
      }
      await navigator.share(data)
    } catch (e) {
      // User dismissed the share sheet → silent, not an error.
      if ((e as { name?: string })?.name === 'AbortError') return
      toast({
        message: `Share failed — ${(e as Error).message}`,
        tone: 'error',
        duration: 4000,
      })
    }
  }

  return (
    <ul className="flex flex-col gap-0.5 p-2">
      {entries.map((entry) => {
        const path = childPath(dirPath, entry.name)
        const isDir = entry.type === 'dir'
        const selected = !isDir && path === selectedPath
        const Icon = isDir ? Folder : iconForEntry(entry)
        return (
          <li key={entry.name} className="relative flex items-stretch">
            {selected && (
              <motion.span
                layoutId="file-selection"
                transition={springs.snappy}
                className="absolute inset-0 rounded-lg bg-accent"
              />
            )}
            <motion.button
              type="button"
              whileTap={{ scale: 0.985 }}
              transition={springs.buttonPress}
              onClick={() =>
                isDir ? onOpenDir(path) : onOpenFile(entry, path)
              }
              className={cn(
                'relative flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 text-left transition-colors',
                selected
                  ? 'text-foreground'
                  : 'hover:bg-accent active:bg-accent',
              )}
            >
              <Icon
                className={cn(
                  'size-5 shrink-0',
                  isDir ? 'text-primary' : 'text-muted-foreground',
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{entry.name}</span>
                {!isDir && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {formatBytes(entry.size)}
                    {entry.modified ? ` · ${formatMtime(entry.modified)}` : ''}
                  </span>
                )}
              </span>
              {isDir && (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
              )}
            </motion.button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Actions for ${entry.name}`}
                  className="relative flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <EllipsisVertical className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!isDir && (
                  <>
                    <DropdownMenuItem
                      onClick={() => void handleDownload(path, entry.name)}
                    >
                      <Download className="size-4" />
                      Download
                    </DropdownMenuItem>
                    {canShareFiles && (
                      <DropdownMenuItem
                        onClick={() => void handleShare(path, entry.name)}
                      >
                        <Share2 className="size-4" />
                        Share…
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem
                  onClick={() => onDelete(path, isDir)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        )
      })}
    </ul>
  )
}
