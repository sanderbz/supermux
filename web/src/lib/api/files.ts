// Files (M20) — real client for the M7 backend file browser/editor/uploader.
//
// Envelope: M7 success bodies are RAW JSON (`{ path, entries }`, …); only ERRORS
// use the `{ ok:false, error }` envelope (§3.4). `fsRequest` returns the parsed
// body directly and lifts `error` on a non-2xx so the UI can surface path-safety
// failures (403 "refusing to follow symlink", etc.) gracefully — never a crash.

import { apiToken, apiUrl } from './client'

// ── M0 stub domain types (legacy skeleton; pre-date the M7 contract) ───────────
//
// The `FileEntry`/`FileContent` stub types pre-date the M7 contract and are
// intentionally left untouched; the `Fs*` types below match what M7 returns.

export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: string
}

export interface FileContent {
  path: string
  content: string
  encoding?: 'utf8' | 'base64'
}

// ── M7 wire types ─────────────────────────────────────────────────────────────

export interface FsEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  /** Unix epoch seconds (server `mtime`). */
  modified: number
}

export interface FsListing {
  path: string
  parent: string | null
  entries: FsEntry[]
}

/** Type-tagged read result, discriminated by the `is_*` flags M7 sets (§3.2). */
export type FileMeta =
  | { path: string; is_image: true; data_url: string; mime: string }
  | { path: string; is_pdf: true; data_url: string }
  | {
      path: string
      is_video: true
      mime: string
      size: number
      modified: number
    }
  | { path: string; is_audio: true; mime: string; size: number }
  | { path: string; is_binary: true; size: number; ext: string }
  | {
      path: string
      content: string
      is_markdown?: boolean
      is_csv?: boolean
      is_html?: boolean
      truncated?: boolean
    }

/** A request that failed; carries the HTTP status so callers can branch on 403
 *  (path-safety / symlink refusal) vs 404 vs 400 (too-large). */
export class FsError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'FsError'
    this.status = status
  }
}

async function fsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  const token = apiToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init?.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, headers })
  } catch {
    throw new FsError('Can’t reach amux-server.', 0)
  }
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status}).`
    throw new FsError(message, res.status)
  }
  return body as T
}

export const filesApi = {
  /** `GET /api/ls` — directory listing (dirs first, then by name). */
  ls: (path: string, hidden = false): Promise<FsListing> =>
    fsRequest(
      `/api/ls?path=${encodeURIComponent(path)}${hidden ? '&hidden=1' : ''}`,
    ),

  /** `GET /api/file` — type-aware read. */
  readFile: (path: string): Promise<FileMeta> =>
    fsRequest(`/api/file?path=${encodeURIComponent(path)}`),

  /** `PUT /api/file` — write a whitelisted text file. */
  writeFile: (
    path: string,
    content: string,
  ): Promise<{ ok: boolean; path: string }> =>
    fsRequest('/api/file', {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),

  /** `DELETE /api/fs/delete`. */
  deleteFile: (path: string): Promise<{ ok: boolean; deleted: string }> =>
    fsRequest('/api/fs/delete', {
      method: 'DELETE',
      body: JSON.stringify({ path }),
    }),

  /** `POST /api/fs/upload` — multipart upload of one or more files into `dir`. */
  uploadFiles: (
    dir: string,
    files: File[],
  ): Promise<{ saved: { name: string; size: number }[] }> => {
    const form = new FormData()
    form.append('dir', dir)
    for (const f of files) form.append('file', f, f.name)
    return fsRequest('/api/fs/upload', { method: 'POST', body: form })
  },

  /** Authenticated direct-GET URL for `<video>`/`<audio>` (Range-served by M7).
   *  Media elements cannot set an Authorization header, so this uses the
   *  `?_token=` fallback the auth layer accepts (server/src/auth.rs). The token
   *  is read from `window` at runtime — never embedded in source. */
  rawUrl: (path: string): string => {
    const token = apiToken()
    const q = `path=${encodeURIComponent(path)}${
      token ? `&_token=${encodeURIComponent(token)}` : ''
    }`
    return apiUrl(`/api/file/raw?${q}`)
  },
}

/** Resolve a session's working dir for the `/files/:name` root scope. Hits the
 *  M2/M3 sessions endpoint directly (the typed `api.getSession` is filled in by
 *  M12); returns null if it can't be resolved, so Files falls back to $HOME. */
export async function getSessionDir(name: string): Promise<string | null> {
  try {
    const body = await fsRequest<Record<string, unknown>>(
      `/api/sessions/${encodeURIComponent(name)}`,
    )
    const inner = body.data as Record<string, unknown> | undefined
    const dir = (body.dir ?? inner?.dir) as string | undefined
    return dir ?? null
  } catch {
    return null
  }
}
