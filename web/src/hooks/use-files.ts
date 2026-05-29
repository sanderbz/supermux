// useFiles — TanStack Query bindings for the file browser.
//
// Files is NOT a live-streaming surface, so there is no SSE/polling here — the
// cache is the source of truth and mutations (save / upload / delete) invalidate
// the relevant keys. This honours the anti-vision rule (no 3s polling) while
// keeping listings fresh after writes.

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { filesApi, getSessionDir } from '@/lib/api'
import type { FileMeta, FsListing } from '@/lib/api'

/** The home-directory sentinel the backend expands to $HOME. */
export const HOME_PATH = '~'

const lsKey = (path: string, hidden: boolean) =>
  ['files', 'ls', path, hidden] as const
const fileKey = (path: string) => ['files', 'file', path] as const

/** List a directory. Returns the resolved absolute `path` + `parent` + entries. */
export function useDirListing(path: string, hidden: boolean) {
  return useQuery<FsListing>({
    queryKey: lsKey(path, hidden),
    queryFn: () => filesApi.ls(path, hidden),
    // Listings change off-app (other agents write files); a short stale window
    // keeps re-navigation snappy without polling.
    staleTime: 5_000,
    retry: false,
  })
}

/** Read a single file's type-aware payload. Disabled until a file is selected. */
export function useFileContent(path: string | null) {
  return useQuery<FileMeta>({
    queryKey: fileKey(path ?? ''),
    queryFn: () => filesApi.readFile(path as string),
    enabled: !!path,
    staleTime: 0,
    retry: false,
  })
}

/** Resolve the `/files/:name` session root → its working dir (or null). */
export function useSessionDir(name: string | undefined) {
  return useQuery<string | null>({
    queryKey: ['files', 'session-dir', name ?? null],
    queryFn: () => (name ? getSessionDir(name) : Promise.resolve(null)),
    enabled: !!name,
    staleTime: 60_000,
    retry: false,
  })
}

/** Save (PUT) a text file, then refresh its cached content. */
export function useSaveFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      filesApi.writeFile(path, content),
    onSuccess: (_data, { path }) => {
      qc.invalidateQueries({ queryKey: fileKey(path) })
      qc.invalidateQueries({ queryKey: ['files', 'ls'] })
    },
  })
}

/** Upload one or more files into `dir`, then refresh listings. */
export function useUploadFiles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ dir, files }: { dir: string; files: File[] }) =>
      filesApi.uploadFiles(dir, files),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files', 'ls'] }),
  })
}

/** Delete a file or directory, then refresh listings. */
export function useDeleteFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (path: string) => filesApi.deleteFile(path),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files', 'ls'] }),
  })
}
