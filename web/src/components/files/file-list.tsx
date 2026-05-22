import { motion } from 'framer-motion'
import { ChevronRight, EllipsisVertical, Folder, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { FsEntry } from '@/lib/api'
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

export function FileList({
  dirPath,
  entries,
  selectedPath,
  onOpenDir,
  onOpenFile,
  onDelete,
}: FileListProps) {
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
