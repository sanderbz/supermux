# Large, resumable uploads (up to 10 GB) — design note

Date: 2026-09-02 · branch `feat/large-resumable-uploads`

## What is broken today (measured, on `origin/main` 35f7bdc4)

| Path | Cap | How the body is handled |
|---|---|---|
| `POST /api/fs/upload` (Files browser drop / Upload button) | **200 MB** — `FS_UPLOAD_MAX`, enforced by `DefaultBodyLimit::max(200 MiB + 1 MiB)` *and* a running `total` check in the handler | **Fully buffered in RAM.** `field.bytes().await` collects each part into a `bytes::Bytes`, all parts are held in a `Vec<(String, Bytes)>`, and only then written out. A 200 MB upload is 200 MB of server heap; two at once is 400 MB. |
| `POST /api/upload` (composer attachment, base64) | 20 MB (`UPLOAD_MAX`) | base64 string in a JSON body — ~1.37× expansion, also fully buffered |

So the owner's "max of 10 MB ofzo" is really 200 MB, but it is a *memory-priced* 200 MB with no progress, no resume, and a request that dies whole on any network blip. On a phone over a tunnel that fails long before 200 MB. Cloudflare's free tunnel also caps a single request at 100 MB, so on a tunnelled install the real ceiling is ~100 MB.

There is no progress UI at all: `useUploadFiles` is a plain `useMutation` around one `fetch`, so the user gets a spinner-less nothing until the whole file lands.

## Protocol (ours, small, tus-shaped)

All routes live under `/api/fs/uploads` — the `/api/fs` prefix is already on the member allowlist (`scope.rs::member_may_reach`), so **no fence change is needed** and a member is confined by the same `company_jail` every other files route uses.

| Verb | Path | Body / headers | Returns |
|---|---|---|---|
| `POST` | `/api/fs/uploads` | `{dir, name, size, sha256?}` | `{id, offset:0, chunk_size, name}` |
| `GET`/`HEAD` | `/api/fs/uploads/{id}` | — | `{id, offset, size, name, dir}` — **the resume point** |
| `PATCH` | `/api/fs/uploads/{id}` | raw bytes, `Upload-Offset: <n>` (or `Content-Range: bytes a-b/total`) | `{offset}` after the write |
| `POST` | `/api/fs/uploads/{id}/complete` | `{sha256?}` | `{path, name, size, sha256}` |
| `DELETE` | `/api/fs/uploads/{id}` | — | `{ok:true}` — cancel + cleanup |

Rules:

- **Offset is the file length.** The `.part` file's size *is* the resume point; there is no second source of truth to drift. `PATCH` refuses (`409` + the true offset) when `Upload-Offset` ≠ current length, so a duplicate/late chunk can never corrupt the file and the client just re-syncs.
- **Chunks are sequential.** Deliberate: the offset-equals-length invariant is what makes resume trivially correct, and it is what lets the server hash *while writing* so `complete` is O(1). Parallel chunk writes would need a received-range bitmap in the manifest and a full re-read at complete. Measured throughput (below) says a single pipelined stream already saturates the link, so the complexity buys nothing here. Documented as a deliberate omission, not an oversight.
- **Nothing is buffered.** The `PATCH` body is consumed as a `Body` stream frame by frame into a `BufWriter<File>` (1 MiB buffer). Peak memory per upload is one hyper frame, regardless of file size. No `fsync` per chunk; one `flush` + `sync_all` at `complete`.
- **Body limit is raised for the chunk route only** (`DefaultBodyLimit::max(64 MiB + 1 MiB)`); every other route keeps its current limit. Default chunk is **16 MiB** — under Cloudflare's 100 MB free-tunnel request cap with room to spare, big enough that per-request overhead is noise.
- **Temp file is on the target filesystem**: `<dir>/.supermux-uploads/<id>.part`. Finishing is a same-fs `rename` — atomic, no copy, no cross-device fallback. The hidden dir is removed when it empties.
- **The manifest lives in the data dir**: `<data_dir>/upload-sessions/<id>.json` = `{id, dir, name, size, sha256?, created_at}`. It survives a server restart, so an interrupted 8 GB upload resumes after a deploy. Every call re-resolves `dir` through `safe_path_scoped` + `jail_for`, so an upload id from another company is a uniform 404 — the id is not a capability.
- **Disk-space refusal at init**: `statvfs` on the target dir; if `available < size + 64 MiB margin` the init is refused with **507** and an honest sentence naming both numbers. Better to say no in the first 50 ms than to die at 90%.
- **Janitor**: manifests (and their `.part` files) older than 24 h are swept. Runs at most once per 10 minutes, piggy-backed on init — no new background task, no new migration.
- **Hash**: sha256 is fed incrementally in memory as bytes are written (`Sha256` per live upload in a registry). `complete` uses that state → O(1). If the state is gone (server restarted mid-upload) `complete` falls back to streaming the `.part` file once; the client's "Verifying…" state is honest either way. When the client supplied a `sha256` at init or complete, a mismatch is a **409** and the `.part` is kept for a retry, never renamed into place.
- **Remote (SSH) transports are refused** at init with a plain sentence. The chunked path is local-FS only; the existing multipart route stays for that case (and for tiny files).
- **10 GB cap** (`UPLOAD_ABS_MAX`) at init — a stated, honest ceiling rather than an accidental one.

Path safety, dedupe (`name_1.ext`), the audit-log row and the `files` SSE frame are the *existing* helpers, reused verbatim.

## Client

`web/src/lib/upload/manager.ts` (lazy, pulled in only by the Files route's chunk):

- A queue of files, each `queued → initializing → uploading → verifying → done | failed | cancelled`.
- One **XHR per chunk** (not `fetch`) — `xhr.upload.onprogress` is the only way to get real byte-level progress for a request body in a browser.
- Speed = bytes/s over a 5 s sliding window; ETA = remaining ÷ speed. Both are smoothed and both go blank rather than lie when the window is empty.
- Retry with exponential backoff (1 s → 30 s, 6 attempts). Every retry starts by **asking the server for its offset** (`GET …/{id}`) rather than assuming — the server is the authority.
- Cancel per file (`DELETE`), retry per file, cancel-all.
- Survives SPA navigation: the manager is a module singleton, not component state.
- Survives a reload *partially and honestly*: in-progress uploads are persisted to `localStorage` (`id, name, size, dir, offset`). A `File` handle cannot be persisted by any browser, so on reload the tray shows "Resume — pick the same file" and validates `name + size` before continuing. It never silently resumes onto the wrong bytes.

## UI

- Drag-and-drop on the folder view and the Upload button both feed the manager (multi-select). No modal — browsing continues.
- A collapsible **upload tray** docked bottom-right on desktop / full-width sheet above the tab bar on a phone: per-file name, size, progress bar, speed, ETA, state, cancel/retry. Overall header line ("3 files · 42% · 18 MB/s"). Done items tick and fade after 4 s.
- Verifying is its own visible state, so a 10 GB file does not look frozen at 100%.
- Errors are the server's sentence (disk full, permission, network), never "Upload failed".
- Mobile-first, safe-area padded, dark/light, reuses the app's existing primitives.

## Gates / budget

The upload UI must be **off the hero path**: the Files route is already `React.lazy`, so the manager, store and tray land in its chunk. `BUDGET_ENTRY_JS` must not move. `BUDGET_APP_JS` is ratcheted per this file's documented policy (measured × 1.02) with the measurement recorded inline.
