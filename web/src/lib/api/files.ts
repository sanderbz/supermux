// Files — real client for the backend file browser/editor/uploader.
//
// Envelope: success bodies are RAW JSON (`{ path, entries }`, …); only ERRORS
// use the `{ ok:false, error }` envelope. `fsRequest` returns the parsed
// body directly and lifts `error` on a non-2xx so the UI can surface path-safety
// failures (403 "refusing to follow symlink", etc.) gracefully — never a crash.

import { apiToken, apiUrl } from './client'

// ── Stub domain types (legacy skeleton; pre-date the live contract) ──────────
//
// The `FileEntry`/`FileContent` stub types pre-date the live contract and are
// intentionally left untouched; the `Fs*` types below match what the backend returns.

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

// ── Wire types ────────────────────────────────────────────────────────────────

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

/** Type-tagged read result, discriminated by the `is_*` flags the backend sets. */
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
    throw new FsError('Can’t reach supermux-server.', 0)
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

  /** Authenticated direct-GET URL for `<video>`/`<audio>` (Range-served by the backend).
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

// ── Prompt-attachment upload ("send a file/screenshot into the session") ───────
//
// The dedicated upload path for dropping a file/screenshot into a Claude Code
// session: bytes go to the DATA DIR's `uploads/` (never the session cwd) via the
// base64 `POST /api/upload` endpoint, which returns the ABSOLUTE saved path. That
// path is then injected (quoted, prose-free) into the terminal prompt — an
// absolute path is what reliably lets Claude's Read/vision tool locate the file
// over a remote pty; the user writes their own wording around it.

/** Server response for a single `POST /api/upload`. */
export interface UploadResult {
  /** Absolute on-disk path under `<data_dir>/uploads/` (injected, quoted). */
  path: string
  /** Sanitized display name (original filename, path-safed). */
  name: string
  /** Authenticated `/api/uploads/<id>` URL (unused by the prompt flow). */
  url: string
}

/** ~5 MB — Claude's per-image cap. The client guards images here so the user
 *  gets a friendly error instead of a model-side failure after upload. */
export const IMAGE_PROMPT_MAX = 5 * 1024 * 1024

/** Read a File as a base64 string (no `data:` prefix — the server accepts both,
 *  but a bare payload keeps the request smaller). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new FsError('Couldn’t read the file.', 0))
    reader.onload = () => {
      const result = String(reader.result)
      // `data:<mime>;base64,<payload>` → keep only the payload.
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

/** Upload ONE file for prompt-injection. Guards images at ~5 MB client-side
 *  (Claude's cap) with a friendly message; the server enforces the 20 MB hard
 *  cap + path-safety + magic-byte validation for images. Resolves to the
 *  absolute saved path. */
export async function uploadForPrompt(file: File): Promise<UploadResult> {
  if (file.type.startsWith('image/') && file.size > IMAGE_PROMPT_MAX) {
    throw new FsError(
      `“${file.name}” is over 5 MB — too large for Claude to view.`,
      400,
    )
  }
  const data = await fileToBase64(file)
  return fsRequest<UploadResult>('/api/upload', {
    method: 'POST',
    body: JSON.stringify({ name: file.name, data }),
  })
}

/** Build the no-trailing-Enter prompt text injected after upload: JUST the
 *  quoted absolute path(s) — no prose, no verb. The user writes their own
 *  wording around it; the absolute path is what Claude needs to locate the file
 *  in the data dir's `uploads/`. A trailing space separates the path(s) from
 *  whatever the user types next before they hit Enter. */
export function buildAttachmentPrompt(paths: string[]): string {
  if (paths.length === 0) return ''
  const quoted = paths.map((p) => `"${p}"`)
  return `${quoted.join(' ')} `
}

/** Resolve a session's working dir for the `/files/:name` root scope. Hits the
 *  sessions endpoint directly (the typed `api.getSession` is filled in elsewhere);
 *  returns null if it can't be resolved, so Files falls back to $HOME. */
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
