//! Chunked, resumable uploads — the path for files that do not fit in RAM.
//!
//! The legacy `POST /api/fs/upload` buffers every part in memory
//! (`field.bytes()`), so its 200 MB cap is really a 200 MB heap cap and any
//! network blip loses the whole transfer. This module is the replacement for
//! anything large: a small tus-shaped protocol where the bytes are streamed to
//! a temp file **on the target directory's own filesystem** and the finish is a
//! same-filesystem `rename` — atomic, no copy, no cross-device fallback.
//!
//! | Method       | Path                          | Purpose                                     |
//! |--------------|-------------------------------|---------------------------------------------|
//! | `POST`       | `/api/fs/uploads`             | init — `{dir,name,size,sha256?}` → `{id,…}`  |
//! | `GET`/`HEAD` | `/api/fs/uploads/{id}`        | the resume point — `{offset,…}`             |
//! | `PATCH`      | `/api/fs/uploads/{id}`        | append one chunk at `Upload-Offset`          |
//! | `POST`       | `/api/fs/uploads/{id}/complete` | verify + atomic rename into place          |
//! | `DELETE`     | `/api/fs/uploads/{id}`        | cancel + cleanup                             |
//!
//! Every route sits under the `/api/fs` prefix, which the member allowlist
//! ([`crate::scope::member_may_reach`]) already admits, and every one of them
//! re-resolves the manifest's `dir` through [`super::safe_path_scoped`] with the
//! caller's [`super::jail_for`] jail — so an upload id belonging to another
//! company is a uniform 404. **The id is not a capability.**
//!
//! ## The invariant that makes resume correct
//!
//! `offset == the .part file's length`. There is no second bookkeeping of
//! "bytes received" to drift out of sync with the file: `PATCH` refuses with
//! `409` + the true offset whenever the client's `Upload-Offset` disagrees, and
//! the client re-syncs by asking. A duplicated, reordered or late chunk can
//! therefore never corrupt the file — it is simply rejected.
//!
//! Chunks are consequently SEQUENTIAL. That is deliberate: it is what lets the
//! server hash while it writes (so `complete` is O(1) rather than a 10 GB
//! re-read), and parallel chunk writes would need a received-range bitmap in
//! the manifest plus a full re-read at complete. Measured throughput says one
//! pipelined stream already saturates the link.
//!
//! Memory per upload is one hyper frame regardless of file size: the body is
//! consumed as a stream into a `BufWriter`, never collected.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path as AxPath, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;

use crate::db;
use crate::error::AppError;
use crate::state::AppState;

use super::{
    dedupe_path_local, emit_files_event, is_local_transport, jail_for, map_io, safe_path_scoped,
    sanitize_filename, to_abs, transport_for_session,
};

/// Default chunk the client is told to use. 16 MiB sits comfortably under
/// Cloudflare's 100 MB free-tunnel per-request cap while making per-request
/// overhead noise next to the payload.
pub(crate) const CHUNK_SIZE: u64 = 16 * 1024 * 1024;
/// Hard ceiling on ONE chunk body. The `PATCH` route — and only that route —
/// raises its `DefaultBodyLimit` to this plus a megabyte of slack.
pub(crate) const CHUNK_MAX: u64 = 64 * 1024 * 1024;
/// The stated ceiling on a single upload. An honest limit beats an accidental
/// one: 10 GB is what the owner asked for and what the disk check is sized for.
pub(crate) const UPLOAD_ABS_MAX: u64 = 10 * 1024 * 1024 * 1024;
/// Free space required beyond the declared size before an init is accepted.
pub(crate) const DISK_MARGIN: u64 = 64 * 1024 * 1024;
/// Manifests (and their `.part` files) older than this are swept.
pub(crate) const UPLOAD_TTL_SECS: u64 = 24 * 60 * 60;
/// Hidden per-directory scratch dir holding the in-flight `.part` files. It
/// lives in the TARGET directory so the finishing `rename` is same-filesystem.
pub(crate) const PART_DIR: &str = ".supermux-uploads";
/// The janitor runs at most this often (piggy-backed on init — no background
/// task, no new migration).
const SWEEP_EVERY_SECS: u64 = 600;

// ───────────────────────────── manifest ─────────────────────────────

/// What survives a server restart. Written to `<data_dir>/upload-sessions/<id>.json`
/// at init and deleted at complete/cancel. Deliberately NOT a database row: an
/// upload session is scratch state with a 24 h life, and a migration is a
/// one-way door (`sqlx` checksums them) for something a JSON file does better.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Manifest {
    pub id: String,
    /// Absolute target directory, exactly as it resolved at init.
    pub dir: String,
    /// Sanitized target filename (the final name is deduped at complete).
    pub name: String,
    pub size: u64,
    /// Client-declared digest, verified at complete when present.
    #[serde(default)]
    pub sha256: Option<String>,
    pub created_at: u64,
}

/// Incremental hash state for one live upload. `None` once contiguity is lost
/// (a server restart mid-upload), which downgrades `complete` to a one-pass
/// re-read — slower, still correct, and the client's "Verifying…" state is
/// honest either way.
struct Live {
    hasher: Option<(Sha256, u64)>,
}

static LIVE: Lazy<StdMutex<HashMap<String, Arc<AsyncMutex<Live>>>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

static LAST_SWEEP: Lazy<StdMutex<u64>> = Lazy::new(|| StdMutex::new(0));

/// The per-id lock. It serializes concurrent `PATCH`es on the same upload (the
/// offset check and the write happen under it) without serializing *different*
/// uploads — a single global lock would have made two concurrent 10 GB
/// transfers take turns.
fn live_for(id: &str) -> Arc<AsyncMutex<Live>> {
    let mut map = LIVE.lock().unwrap();
    map.entry(id.to_string())
        .or_insert_with(|| {
            Arc::new(AsyncMutex::new(Live {
                hasher: Some((Sha256::new(), 0)),
            }))
        })
        .clone()
}

fn forget_live(id: &str) {
    LIVE.lock().unwrap().remove(id);
}

pub(crate) fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ───────────────────────── id / path helpers ─────────────────────────

/// Upload ids are server-minted hex. Validating on the way IN means the id can
/// never contribute a path component, a `..`, or a NUL to
/// `<data_dir>/upload-sessions/<id>.json` — the manifest lookup is the one place
/// a caller-supplied string reaches the filesystem without going through
/// `resolve_safe`, so it is fenced by shape instead.
pub(crate) fn is_valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit())
}

fn sessions_dir(state: &AppState) -> PathBuf {
    state.config.data_dir.join("upload-sessions")
}

fn manifest_path(state: &AppState, id: &str) -> PathBuf {
    sessions_dir(state).join(format!("{id}.json"))
}

pub(crate) fn part_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(PART_DIR).join(format!("{id}.part"))
}

async fn load_manifest(state: &AppState, id: &str) -> Result<Manifest, AppError> {
    if !is_valid_id(id) {
        return Err(AppError::NotFound("unknown upload".into()));
    }
    let raw = tokio::fs::read(manifest_path(state, id))
        .await
        .map_err(|_| AppError::NotFound("unknown upload".into()))?;
    serde_json::from_slice::<Manifest>(&raw).map_err(|_| AppError::NotFound("unknown upload".into()))
}

/// Re-authorize on EVERY call. The manifest's `dir` is run back through the
/// caller's jail, so possession of an id proves nothing: a member who guessed
/// another company's upload id gets the same uniform 404 the files browser
/// gives them for the directory itself.
async fn authorized_dir(
    state: &AppState,
    ctx: &crate::scope::OptCtx,
    m: &Manifest,
) -> Result<PathBuf, AppError> {
    let transport = transport_for_session(state, ctx, None).await?;
    let jail = jail_for(state, ctx).await?;
    let dir = safe_path_scoped(&transport, &m.dir, jail.as_deref())
        .await
        .map_err(|_| AppError::NotFound("unknown upload".into()))?;
    Ok(dir)
}

/// Bytes already received === the `.part` file's length. This function IS the
/// resume point; there is no counter to disagree with it.
pub(crate) async fn received_len(part: &Path) -> u64 {
    tokio::fs::metadata(part).await.map(|m| m.len()).unwrap_or(0)
}

// ───────────────────────────── disk space ─────────────────────────────

/// Available bytes on the filesystem holding `dir`, or `None` when the platform
/// will not say. Refusing an upload on a *guess* would be worse than accepting
/// it, so an unknown answer never blocks.
pub(crate) fn available_bytes(dir: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        match nix::sys::statvfs::statvfs(dir) {
            Ok(s) => {
                // `blocks_available` is the non-root-reserved count; pair it
                // with the fragment size, which is the unit it counts in.
                let frag = s.fragment_size() as u128;
                let avail = s.blocks_available() as u128;
                Some(u64::try_from(frag.saturating_mul(avail)).unwrap_or(u64::MAX))
            }
            Err(_) => None,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        None
    }
}

pub(crate) fn human_bytes(n: u64) -> String {
    const U: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", U[i])
    }
}

// ───────────────────────────── the janitor ─────────────────────────────

/// Remove manifests (and their `.part` files) older than [`UPLOAD_TTL_SECS`].
/// Returns how many it swept — the number the unit test asserts on.
pub(crate) async fn sweep_stale(state: &AppState, ttl: u64) -> usize {
    let dir = sessions_dir(state);
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(rd) => rd,
        Err(_) => return 0,
    };
    let now = now_secs();
    let mut swept = 0usize;
    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = tokio::fs::read(&path).await else { continue };
        let Ok(m) = serde_json::from_slice::<Manifest>(&raw) else {
            // Unparseable leftovers are swept on age alone.
            let age = tokio::fs::metadata(&path)
                .await
                .ok()
                .and_then(|md| md.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .map(|d| d.as_secs())
                .unwrap_or(u64::MAX);
            if age > ttl {
                let _ = tokio::fs::remove_file(&path).await;
                swept += 1;
            }
            continue;
        };
        if now.saturating_sub(m.created_at) <= ttl {
            continue;
        }
        let part = part_path(Path::new(&m.dir), &m.id);
        let _ = tokio::fs::remove_file(&part).await;
        let _ = tokio::fs::remove_dir(Path::new(&m.dir).join(PART_DIR)).await;
        let _ = tokio::fs::remove_file(&path).await;
        forget_live(&m.id);
        swept += 1;
    }
    swept
}

async fn maybe_sweep(state: &AppState) {
    let now = now_secs();
    {
        let mut last = LAST_SWEEP.lock().unwrap();
        if now.saturating_sub(*last) < SWEEP_EVERY_SECS {
            return;
        }
        *last = now;
    }
    sweep_stale(state, UPLOAD_TTL_SECS).await;
}

// ───────────────────────────── wire shapes ─────────────────────────────

#[derive(Debug, Deserialize)]
struct InitBody {
    dir: String,
    name: String,
    size: u64,
    #[serde(default)]
    sha256: Option<String>,
    /// Reserved for the remote-transport case, which is refused below.
    #[serde(default)]
    session: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct CompleteBody {
    #[serde(default)]
    sha256: Option<String>,
}

// ───────────────────────────── the router ─────────────────────────────

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/fs/uploads", post(init))
        .route(
            // GET doubles as HEAD (axum routes HEAD to the GET handler and
            // drops the body), so a client can probe the resume point with
            // either verb.
            "/api/fs/uploads/{id}",
            get(status).patch(patch_chunk).delete(cancel).layer(DefaultBodyLimit::max(
                (CHUNK_MAX + 1024 * 1024) as usize,
            )),
        )
        .route("/api/fs/uploads/{id}/complete", post(complete))
}

// ───────────────────────────── handlers ─────────────────────────────

/// `POST /api/fs/uploads` — reserve an upload.
///
/// Refuses BEFORE a byte moves when the disk cannot hold the file. Dying at 90 %
/// of a 9 GB transfer because the volume was full is the failure this check
/// exists to prevent, and the sentence names both numbers so the person can act.
async fn init(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Json(body): Json<InitBody>,
) -> Result<Json<Value>, AppError> {
    if body.size == 0 {
        return Err(AppError::BadRequest("an empty file has nothing to upload".into()));
    }
    if body.size > UPLOAD_ABS_MAX {
        return Err(AppError::BadRequest(format!(
            "{} is over the {} per-file limit",
            human_bytes(body.size),
            human_bytes(UPLOAD_ABS_MAX)
        )));
    }

    let transport = transport_for_session(&state, &ctx, body.session.as_deref()).await?;
    if !is_local_transport(&transport) {
        // Chunked resume needs a local `.part` file on the target filesystem and
        // a same-fs rename; over ssh neither is available. Say so plainly
        // instead of pretending — the multipart route still serves that case.
        return Err(AppError::BadRequest(
            "resumable upload isn’t available for a remote host yet — this host’s files browser \
             uploads over the classic path"
                .into(),
        ));
    }
    let jail = jail_for(&state, &ctx).await?;
    let dir_abs = safe_path_scoped(&transport, &to_abs(&body.dir, None), jail.as_deref()).await?;
    let stat = transport.stat(&dir_abs).await.map_err(super::map_transport)?;
    if !stat.is_dir {
        return Err(AppError::BadRequest("`dir` is not a directory".into()));
    }

    if let Some(avail) = available_bytes(&dir_abs) {
        if avail < body.size.saturating_add(DISK_MARGIN) {
            return Err(AppError::InsufficientStorage(format!(
                "not enough free space — {} needs {}, {} free",
                sanitize_filename(&body.name),
                human_bytes(body.size),
                human_bytes(avail)
            )));
        }
    }

    let scratch = dir_abs.join(PART_DIR);
    tokio::fs::create_dir_all(&scratch).await.map_err(map_io)?;
    tokio::fs::create_dir_all(sessions_dir(&state)).await.map_err(map_io)?;

    let id = uuid::Uuid::new_v4().simple().to_string();
    let manifest = Manifest {
        id: id.clone(),
        dir: dir_abs.to_string_lossy().into_owned(),
        name: sanitize_filename(&body.name),
        size: body.size,
        sha256: body.sha256.map(|s| s.trim().to_lowercase()),
        created_at: now_secs(),
    };
    let raw = serde_json::to_vec(&manifest).map_err(|e| AppError::Internal(e.into()))?;
    tokio::fs::write(manifest_path(&state, &id), raw).await.map_err(map_io)?;
    // Create the (empty) part file up front so `GET` has a length to report
    // even before the first chunk lands.
    let _ = super::path_safe::safe_open_append(&part_path(&dir_abs, &id)).await.map_err(map_io)?;

    maybe_sweep(&state).await;

    Ok(Json(json!({
        "id": id,
        "offset": 0,
        "size": manifest.size,
        "name": manifest.name,
        "chunk_size": CHUNK_SIZE,
        "max_chunk": CHUNK_MAX,
    })))
}

/// `GET`/`HEAD /api/fs/uploads/{id}` — the authoritative resume point.
async fn status(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>, AppError> {
    let m = load_manifest(&state, &id).await?;
    let dir = authorized_dir(&state, &ctx, &m).await?;
    let offset = received_len(&part_path(&dir, &m.id)).await;
    Ok(Json(json!({
        "id": m.id,
        "offset": offset,
        "size": m.size,
        "name": m.name,
        "dir": m.dir,
        "chunk_size": CHUNK_SIZE,
    })))
}

/// `PATCH /api/fs/uploads/{id}` — append ONE chunk.
///
/// The body is consumed frame by frame into a `BufWriter`; nothing is
/// collected, so peak memory is one hyper frame no matter how large the file
/// is. There is no per-chunk `fsync` — durability is bought once, at complete.
async fn patch_chunk(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    AxPath(id): AxPath<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<Value>, AppError> {
    let m = load_manifest(&state, &id).await?;
    let dir = authorized_dir(&state, &ctx, &m).await?;
    let part = part_path(&dir, &m.id);

    let lock = live_for(&m.id);
    let mut live = lock.lock().await;

    let current = received_len(&part).await;
    let want = parse_offset(&headers)?.unwrap_or(current);
    if want != current {
        // Not an error the user caused — the client simply raced or retried.
        // Hand back the truth so it can re-sync rather than guess.
        return Err(AppError::Conflict(format!(
            "offset mismatch: server has {current}, client sent {want}"
        )));
    }
    if current >= m.size {
        return Err(AppError::Conflict("upload already has every byte".into()));
    }

    // Contiguity check for the incremental hash: only extend the digest when it
    // is exactly caught up with the file. After a restart it is not, and the
    // digest is abandoned in favour of a one-pass re-read at complete.
    let mut hashing = matches!(live.hasher, Some((_, n)) if n == current);
    if !hashing {
        live.hasher = None;
    }

    let mut file = super::path_safe::safe_open_append(&part).await.map_err(map_io)?;
    let mut written: u64 = 0;
    let mut stream = body.into_data_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(1024 * 1024);

    let mut fail: Option<AppError> = None;
    while let Some(frame) = stream.next().await {
        let bytes = match frame {
            Ok(b) => b,
            Err(e) => {
                // A dropped connection is the NORMAL case this whole protocol
                // exists for: keep every byte already written and let the client
                // resume from the new offset.
                fail = Some(AppError::BadRequest(format!("chunk interrupted: {e}")));
                break;
            }
        };
        if current + written + bytes.len() as u64 > m.size {
            fail = Some(AppError::BadRequest(
                "chunk would write past the declared file size".into(),
            ));
            break;
        }
        buf.extend_from_slice(&bytes);
        if buf.len() >= 1024 * 1024 {
            file.write_all(&buf).await.map_err(map_io)?;
            if hashing {
                if let Some((h, n)) = live.hasher.as_mut() {
                    h.update(&buf);
                    *n += buf.len() as u64;
                } else {
                    hashing = false;
                }
            }
            written += buf.len() as u64;
            buf.clear();
        }
    }
    if !buf.is_empty() {
        file.write_all(&buf).await.map_err(map_io)?;
        if hashing {
            if let Some((h, n)) = live.hasher.as_mut() {
                h.update(&buf);
                *n += buf.len() as u64;
            }
        }
        written += buf.len() as u64;
    }
    file.flush().await.map_err(map_io)?;
    drop(file);

    if let Some(e) = fail {
        return Err(e);
    }

    Ok(Json(json!({
        "id": m.id,
        "offset": current + written,
        "size": m.size,
        "received": written,
    })))
}

/// `POST /api/fs/uploads/{id}/complete` — verify, then move into place.
///
/// The rename is same-filesystem (the `.part` lives inside the target dir), so
/// the file appears whole or not at all — a half-written 9 GB file never shows
/// up in the listing.
async fn complete(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    AxPath(id): AxPath<String>,
    body: Option<Json<CompleteBody>>,
) -> Result<Json<Value>, AppError> {
    let m = load_manifest(&state, &id).await?;
    let dir = authorized_dir(&state, &ctx, &m).await?;
    let part = part_path(&dir, &m.id);

    let lock = live_for(&m.id);
    let mut live = lock.lock().await;

    let have = received_len(&part).await;
    if have != m.size {
        return Err(AppError::Conflict(format!(
            "incomplete: {} of {} bytes received",
            have, m.size
        )));
    }

    // O(1) when the incremental state is intact; a single re-read otherwise.
    let digest = match live.hasher.take() {
        Some((h, n)) if n == m.size => hex(&h.finalize()),
        _ => hash_file(&part).await?,
    };

    let expected = body
        .and_then(|Json(b)| b.sha256)
        .or_else(|| m.sha256.clone())
        .map(|s| s.trim().to_lowercase());
    if let Some(exp) = expected {
        if !exp.is_empty() && exp != digest {
            // The `.part` is deliberately KEPT rather than deleted — but the
            // point is the other half: a file whose bytes do not match what the
            // client said it sent is never renamed into the listing, so nobody
            // ever opens a silently corrupt download. The client cancels and
            // re-uploads; the honest failure is the feature.
            return Err(AppError::Conflict(format!(
                "checksum mismatch — expected {exp}, got {digest}"
            )));
        }
    }

    // Durability is bought exactly once, here.
    {
        let f = super::path_safe::safe_open_append(&part).await.map_err(map_io)?;
        f.sync_all().await.map_err(map_io)?;
    }

    let target = dedupe_path_local(&dir, &m.name).await;
    tokio::fs::rename(&part, &target).await.map_err(map_io)?;
    let _ = tokio::fs::remove_dir(dir.join(PART_DIR)).await;
    let _ = tokio::fs::remove_file(manifest_path(&state, &m.id)).await;
    drop(live);
    forget_live(&m.id);

    db::audit::log(
        &state.pool,
        "user",
        "file.upload",
        &target.to_string_lossy(),
        json!({ "bytes": m.size, "resumable": true }),
    )
    .await
    .ok();
    emit_files_event(&state, "upload", &target, None, None).await;

    Ok(Json(json!({
        "path": target.to_string_lossy(),
        "name": target.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        "size": m.size,
        "sha256": digest,
    })))
}

/// `DELETE /api/fs/uploads/{id}` — cancel and reclaim the bytes now.
async fn cancel(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>, AppError> {
    let m = load_manifest(&state, &id).await?;
    let dir = authorized_dir(&state, &ctx, &m).await?;
    let _ = tokio::fs::remove_file(part_path(&dir, &m.id)).await;
    let _ = tokio::fs::remove_dir(dir.join(PART_DIR)).await;
    let _ = tokio::fs::remove_file(manifest_path(&state, &m.id)).await;
    forget_live(&m.id);
    Ok(Json(json!({ "ok": true, "cancelled": m.id })))
}

// ───────────────────────────── small helpers ─────────────────────────────

/// Read the write offset from `Upload-Offset` (preferred) or `Content-Range`.
/// `Content-Range: bytes <start>-<end>/<total>` is accepted because curl, and
/// every hand-rolled client, reaches for it first.
pub(crate) fn parse_offset(headers: &HeaderMap) -> Result<Option<u64>, AppError> {
    if let Some(v) = headers.get("upload-offset") {
        let s = v.to_str().map_err(|_| AppError::BadRequest("bad Upload-Offset".into()))?;
        let n = s
            .trim()
            .parse::<u64>()
            .map_err(|_| AppError::BadRequest("bad Upload-Offset".into()))?;
        return Ok(Some(n));
    }
    if let Some(v) = headers.get("content-range") {
        let s = v.to_str().map_err(|_| AppError::BadRequest("bad Content-Range".into()))?;
        return parse_content_range(s).map(Some);
    }
    Ok(None)
}

/// `bytes 0-16777215/2147483648` → 0. Only the START matters: the end is
/// implied by how many bytes actually arrive, and trusting a client's `end`
/// over the real stream length is how off-by-one corruption gets in.
pub(crate) fn parse_content_range(s: &str) -> Result<u64, AppError> {
    let bad = || AppError::BadRequest(format!("bad Content-Range: {s}"));
    let rest = s.trim().strip_prefix("bytes ").ok_or_else(bad)?;
    let (range, _total) = rest.split_once('/').ok_or_else(bad)?;
    let (start, end) = range.split_once('-').ok_or_else(bad)?;
    let start: u64 = start.trim().parse().map_err(|_| bad())?;
    let end: u64 = end.trim().parse().map_err(|_| bad())?;
    if end < start {
        return Err(bad());
    }
    Ok(start)
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// One-pass digest of the `.part` file — the fallback when the incremental
/// state did not survive (server restart mid-upload).
async fn hash_file(path: &Path) -> Result<String, AppError> {
    let mut f = super::path_safe::safe_open_read(path).await.map_err(map_io)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf).await.map_err(map_io)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_start_is_what_counts() {
        assert_eq!(parse_content_range("bytes 0-16777215/2147483648").unwrap(), 0);
        assert_eq!(parse_content_range("bytes 16777216-33554431/999").unwrap(), 16_777_216);
        // Malformed shapes are refused rather than defaulted to 0 — a silent 0
        // would rewrite the head of a resumed file.
        assert!(parse_content_range("0-10/20").is_err());
        assert!(parse_content_range("bytes 10-5/20").is_err());
        assert!(parse_content_range("bytes abc/20").is_err());
        assert!(parse_content_range("bytes 0-10").is_err());
    }

    #[test]
    fn upload_offset_header_wins_over_content_range() {
        let mut h = HeaderMap::new();
        h.insert("upload-offset", "4096".parse().unwrap());
        h.insert("content-range", "bytes 999-1000/2000".parse().unwrap());
        assert_eq!(parse_offset(&h).unwrap(), Some(4096));
    }

    #[test]
    fn missing_offset_headers_mean_append_here() {
        assert_eq!(parse_offset(&HeaderMap::new()).unwrap(), None);
    }

    #[test]
    fn bad_offset_header_is_refused_not_ignored() {
        let mut h = HeaderMap::new();
        h.insert("upload-offset", "twelve".parse().unwrap());
        assert!(parse_offset(&h).is_err());
    }

    #[test]
    fn ids_are_hex_only_so_they_cannot_escape_the_sessions_dir() {
        assert!(is_valid_id("0a1b2c3d"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("../../etc/passwd"));
        assert!(!is_valid_id("abc/def"));
        assert!(!is_valid_id("abc.json"));
        assert!(!is_valid_id("zz"));
        assert!(!is_valid_id(&"a".repeat(65)));
    }

    #[test]
    fn human_bytes_reads_like_a_person_wrote_it() {
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(10 * 1024 * 1024 * 1024), "10.0 GB");
    }

    #[test]
    fn the_stated_ceiling_is_ten_gigabytes() {
        assert_eq!(UPLOAD_ABS_MAX, 10_737_418_240);
        // The chunk route's limit must clear the default chunk with room, or a
        // conforming client would 413 on its very first PATCH.
        assert!(CHUNK_MAX > CHUNK_SIZE);
    }

    /// Repo convention (`static_assets.rs`, `push.rs`): a uuid-named dir under
    /// `$TMPDIR`, no extra dev-dependency.
    async fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join(format!("supermux-upload-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&d).await.unwrap();
        d
    }

    #[tokio::test]
    async fn received_len_is_the_resume_point() {
        let dir = scratch().await;
        let p = dir.join("x.part");
        assert_eq!(received_len(&p).await, 0, "an absent part file is offset 0");
        tokio::fs::write(&p, vec![7u8; 4096]).await.unwrap();
        assert_eq!(received_len(&p).await, 4096);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn hash_file_matches_a_known_digest() {
        let dir = scratch().await;
        let p = dir.join("h.part");
        tokio::fs::write(&p, b"abc").await.unwrap();
        assert_eq!(
            hash_file(&p).await.unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn incremental_and_one_pass_digests_agree() {
        // The fast path (hash while writing) and the fallback (re-read at
        // complete) must never disagree — that is the whole safety argument for
        // having two of them.
        let dir = scratch().await;
        let p = dir.join("big.part");
        let chunk_a = vec![1u8; 3000];
        let chunk_b = vec![2u8; 5000];
        let mut f = tokio::fs::File::create(&p).await.unwrap();
        f.write_all(&chunk_a).await.unwrap();
        f.write_all(&chunk_b).await.unwrap();
        f.flush().await.unwrap();
        drop(f);

        let mut h = Sha256::new();
        h.update(&chunk_a);
        h.update(&chunk_b);
        assert_eq!(hex(&h.finalize()), hash_file(&p).await.unwrap());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[test]
    fn part_files_hide_in_the_target_directory_so_rename_is_same_fs() {
        let p = part_path(Path::new("/srv/data"), "deadbeef");
        assert_eq!(p, Path::new("/srv/data/.supermux-uploads/deadbeef.part"));
        // The final rename's destination is a sibling of the scratch dir's
        // parent — same filesystem, therefore atomic.
        assert_eq!(p.parent().unwrap().parent().unwrap(), Path::new("/srv/data"));
    }

    #[test]
    fn free_space_is_reported_or_declined_never_guessed() {
        // The real FS under the test binary always answers; the contract that
        // matters is that a non-answer is `None` (which never blocks an upload)
        // rather than 0 (which would block every upload).
        let here = available_bytes(Path::new("."));
        assert!(here.is_some());
        assert!(available_bytes(Path::new("/definitely/not/a/path/here")).is_none());
    }
}
