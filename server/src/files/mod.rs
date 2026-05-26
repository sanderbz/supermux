//! Files browser + editor + uploader (TECH_PLAN §3.2.11, M7; feature-extract §3).
//!
//! Endpoints (all bearer-protected — merged into the protected router so the auth
//! layer wraps them; there is no localhost/loopback bypass):
//!
//! | Method | Path                       | Purpose                              |
//! |--------|----------------------------|--------------------------------------|
//! | GET    | `/api/ls`                  | list a directory                     |
//! | GET    | `/api/file`                | type-aware read                      |
//! | PUT    | `/api/file`                | write a text file (whitelisted ext)  |
//! | GET    | `/api/file/raw`            | byte stream w/ Range + ETag          |
//! | POST   | `/api/fs/upload`           | multipart upload (200 MB cap)        |
//! | DELETE | `/api/fs/delete`           | delete a file or directory           |
//! | POST   | `/api/upload`              | base64 single-file upload (20 MB) — images AND arbitrary files; returns the absolute path |
//! | GET    | `/api/uploads/{filename}`  | serve a previously uploaded file     |
//! | GET    | `/api/autocomplete/dir`    | dir typeahead                        |
//!
//! Every path flows through [`path_safe::resolve_safe`] before any filesystem
//! access, and reads/writes go through the `O_NOFOLLOW` helpers in
//! [`path_safe`] (TOCTOU defense). Destructive calls (`PUT`, `DELETE`) write an
//! `audit_log` row.

pub mod path_safe;
pub mod range;

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Query, State};
use axum::http::{header, HeaderMap, Response, StatusCode};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::db;
use crate::error::AppError;
use crate::state::AppState;

const CACHE_HEADER: &str = "private, max-age=3600, immutable";
const TEXT_LIMIT: usize = 200 * 1024; // 200 KB
const CSV_LIMIT: usize = 5 * 1024 * 1024; // 5 MB
const IMAGE_MAX: u64 = 5 * 1024 * 1024; // 5 MB
const PDF_MAX: u64 = 10 * 1024 * 1024; // 10 MB
const UPLOAD_MAX: usize = 20 * 1024 * 1024; // base64 single-file cap
const FS_UPLOAD_MAX: u64 = 200 * 1024 * 1024; // multipart cap

const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "heic", "heif",
];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "webm", "avi", "mkv", "m4v"];
const AUDIO_EXTS: &[&str] = &["mp3", "wav", "ogg", "m4a", "aac", "flac"];

/// Extensions accepted by `PUT /api/file` (feature-extract §3.3). Files with no
/// extension (`Dockerfile`, `Makefile`) are also writable — handled separately.
const WRITABLE_EXTS: &[&str] = &[
    "md", "markdown", "mdx", "txt", "json", "yml", "yaml", "toml", "ini", "cfg", "sh", "bash",
    "zsh", "py", "js", "ts", "jsx", "tsx", "mjs", "cjs", "css", "scss", "less", "html", "htm",
    "xml", "svg", "csv", "sql", "graphql", "proto", "go", "rs", "java", "rb", "php", "swift", "kt",
    "c", "cpp", "h", "cs", "r", "lua", "pl", "env", "gitignore", "dockerignore", "tf", "hcl",
    "conf", "log", "makefile",
];

/// Build the files sub-router. Returns a `Router<AppState>` (state-typed but not
/// yet provided) so it can be `.merge`d into the protected router *before* its
/// shared bearer-auth layer and single `.with_state` — the registry pattern in
/// `http.rs`. Every route here is therefore auth-protected; there is no
/// localhost/loopback bypass.
pub fn router_for() -> Router<AppState> {
    Router::new()
        .route("/api/ls", get(ls))
        .route("/api/file", get(get_file).put(put_file))
        .route("/api/file/raw", get(get_raw))
        .route(
            "/api/fs/upload",
            post(fs_upload).layer(DefaultBodyLimit::max((FS_UPLOAD_MAX + 1024 * 1024) as usize)),
        )
        .route("/api/fs/delete", delete(fs_delete))
        .route(
            "/api/upload",
            post(upload).layer(DefaultBodyLimit::max(UPLOAD_MAX * 2)),
        )
        .route("/api/uploads/{filename}", get(serve_upload))
        .route("/api/autocomplete/dir", get(autocomplete_dir))
        // FEAT-WHERE-PICKER: list the deploy-configured project dirs' immediate
        // subdirs with git-repo metadata, so the "Where" picker can render real
        // project rows with a tiny `git` tag (or a calm warning when a folder
        // isn't a git repo — teammates each need their own git worktree per the
        // official Agent Teams doc). Hidden entries are filtered.
        .route("/api/projects/repos", get(projects_repos))
}

// ──────────────────────────── query/body shapes ────────────────────────────

#[derive(Debug, Deserialize)]
struct LsQuery {
    path: String,
    #[serde(default)]
    hidden: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FileQuery {
    path: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PutBody {
    path: String,
    content: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeleteBody {
    path: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UploadBody {
    name: String,
    data: String,
}

#[derive(Debug, Deserialize)]
struct AutocompleteQuery {
    #[serde(default)]
    q: String,
    /// FEAT-WHERE-PICKER: when `hidden=0`, dotfile subdirs (`.git`, `.cache`,
    /// `.next`, …) are filtered from the typeahead. Default is unspecified
    /// (legacy behavior, hidden included) so any existing caller's contract is
    /// preserved byte-for-byte; the new "Where" picker passes `hidden=0`.
    #[serde(default)]
    hidden: Option<String>,
}

// ──────────────────────────────── handlers ─────────────────────────────────

/// `GET /api/ls` — list a directory's entries.
async fn ls(State(_state): State<AppState>, Query(q): Query<LsQuery>) -> Result<Json<Value>, AppError> {
    let abs = path_safe::resolve_safe(&to_abs(&q.path, None), None).await?;
    let show_hidden = is_truthy(q.hidden.as_deref());

    let mut rd = tokio::fs::read_dir(&abs).await.map_err(map_io)?;
    let mut entries: Vec<Value> = Vec::new();
    while let Some(entry) = rd.next_entry().await.map_err(map_io)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        entries.push(json!({
            "name": name,
            "type": if meta.is_dir() { "dir" } else { "file" },
            "size": meta.len(),
            "modified": mtime_unix(&meta),
        }));
    }
    // Directories first, then by name — a stable, predictable order.
    entries.sort_by(|a, b| {
        let ad = a["type"] == json!("dir");
        let bd = b["type"] == json!("dir");
        bd.cmp(&ad).then_with(|| {
            a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
        })
    });

    Ok(Json(json!({
        "path": abs.to_string_lossy(),
        "parent": abs.parent().map(|p| p.to_string_lossy().into_owned()),
        "entries": entries,
    })))
}

/// `GET /api/file` — read a file with a type-aware JSON envelope (§3.2).
async fn get_file(
    State(_state): State<AppState>,
    Query(q): Query<FileQuery>,
) -> Result<Json<Value>, AppError> {
    let abs = path_safe::resolve_safe(&to_abs(&q.path, q.cwd.as_deref()), None).await?;
    let meta = tokio::fs::metadata(&abs).await.map_err(map_io)?;
    if meta.is_dir() {
        return Err(AppError::BadRequest("path is a directory".into()));
    }
    let size = meta.len();
    let ext = extension_lower(&abs);
    let path_str = abs.to_string_lossy().into_owned();

    if IMAGE_EXTS.contains(&ext.as_str()) {
        if size > IMAGE_MAX {
            return Err(AppError::BadRequest("image exceeds 5 MB".into()));
        }
        let bytes = read_all(&abs).await?;
        let mime = mime_for(&abs);
        let data_url = format!("data:{mime};base64,{}", b64_standard().encode(&bytes));
        return Ok(Json(json!({
            "path": path_str, "is_image": true, "data_url": data_url, "mime": mime,
        })));
    }

    if ext == "pdf" {
        if size > PDF_MAX {
            return Err(AppError::BadRequest("pdf exceeds 10 MB".into()));
        }
        let bytes = read_all(&abs).await?;
        let data_url = format!("data:application/pdf;base64,{}", b64_standard().encode(&bytes));
        return Ok(Json(json!({ "path": path_str, "is_pdf": true, "data_url": data_url })));
    }

    if VIDEO_EXTS.contains(&ext.as_str()) {
        return Ok(Json(json!({
            "path": path_str, "is_video": true, "mime": mime_for(&abs),
            "size": size, "modified": mtime_unix(&meta),
        })));
    }

    if AUDIO_EXTS.contains(&ext.as_str()) {
        return Ok(Json(json!({
            "path": path_str, "is_audio": true, "mime": mime_for(&abs), "size": size,
        })));
    }

    // Binary sniff: a NUL byte in the first 8 KB.
    let head = read_head(&abs, 8192).await?;
    if head.contains(&0) {
        return Ok(Json(json!({
            "path": path_str, "is_binary": true, "size": size, "ext": ext,
        })));
    }

    // Text.
    let limit = if matches!(ext.as_str(), "csv" | "tsv") { CSV_LIMIT } else { TEXT_LIMIT };
    let (content, truncated) = read_text(&abs, limit).await?;
    Ok(Json(json!({
        "path": path_str,
        "content": content,
        "is_markdown": matches!(ext.as_str(), "md" | "markdown" | "mdx"),
        "is_csv": matches!(ext.as_str(), "csv" | "tsv"),
        "is_html": matches!(ext.as_str(), "html" | "htm"),
        "truncated": truncated,
    })))
}

/// `PUT /api/file` — write a whitelisted text file, creating parents as needed.
async fn put_file(
    State(state): State<AppState>,
    Json(body): Json<PutBody>,
) -> Result<Json<Value>, AppError> {
    let raw = to_abs(&body.path, body.cwd.as_deref());
    if !is_writable_target(Path::new(&raw)) {
        return Err(AppError::Forbidden("file extension is not writable".into()));
    }

    // resolve_safe canonicalizes the nearest existing ancestor, so a brand-new
    // (non-existent) target resolves without 500ing (Codex #3 regression).
    let abs = path_safe::resolve_safe(&raw, None).await?;
    if let Some(parent) = abs.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(map_io)?;
    }

    let mut f = path_safe::safe_open_write(&abs).await.map_err(map_io)?;
    f.write_all(body.content.as_bytes()).await.map_err(map_io)?;
    f.flush().await.map_err(map_io)?;

    db::audit::log(
        &state.pool,
        "user",
        "file.put",
        &abs.to_string_lossy(),
        json!({ "bytes": body.content.len() }),
    )
    .await
    .ok();

    Ok(Json(json!({ "ok": true, "path": abs.to_string_lossy() })))
}

/// `GET /api/file/raw` — stream bytes with Range + ETag (§3.7).
async fn get_raw(
    State(_state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<FileQuery>,
) -> Result<Response<Body>, AppError> {
    let abs = path_safe::resolve_safe(&to_abs(&q.path, q.cwd.as_deref()), None).await?;
    let meta = tokio::fs::metadata(&abs).await.map_err(map_io)?;
    if meta.is_dir() {
        return Err(AppError::BadRequest("path is a directory".into()));
    }
    let total = meta.len();
    let etag = range::etag(mtime_unix(&meta), total);
    let mime = mime_for(&abs);

    // Conditional GET.
    if let Some(inm) = header_str(&headers, header::IF_NONE_MATCH) {
        if inm.split(',').any(|t| t.trim() == etag) {
            return build(
                StatusCode::NOT_MODIFIED,
                &[(header::ETAG, &etag), (header::CACHE_CONTROL, CACHE_HEADER)],
                Body::empty(),
            );
        }
    }

    // Range request.
    if let Some(rh) = header_str(&headers, header::RANGE) {
        match range::parse_range(&rh, total) {
            Some(r) => {
                let mut f = path_safe::safe_open_read(&abs).await.map_err(map_io)?;
                f.seek(std::io::SeekFrom::Start(r.start)).await.map_err(map_io)?;
                let mut buf = vec![0u8; r.len() as usize];
                f.read_exact(&mut buf).await.map_err(map_io)?;
                let content_range = format!("bytes {}-{}/{}", r.start, r.end, total);
                let len = r.len().to_string();
                return build(
                    StatusCode::PARTIAL_CONTENT,
                    &[
                        (header::CONTENT_TYPE, &mime),
                        (header::CONTENT_RANGE, &content_range),
                        (header::ACCEPT_RANGES, "bytes"),
                        (header::CONTENT_LENGTH, &len),
                        (header::ETAG, &etag),
                        (header::CACHE_CONTROL, CACHE_HEADER),
                    ],
                    Body::from(buf),
                );
            }
            None => {
                let cr = format!("bytes */{total}");
                return build(
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    &[(header::CONTENT_RANGE, &cr)],
                    Body::empty(),
                );
            }
        }
    }

    // Full body.
    let bytes = read_all(&abs).await?;
    let len = total.to_string();
    build(
        StatusCode::OK,
        &[
            (header::CONTENT_TYPE, &mime),
            (header::ACCEPT_RANGES, "bytes"),
            (header::CONTENT_LENGTH, &len),
            (header::ETAG, &etag),
            (header::CACHE_CONTROL, CACHE_HEADER),
        ],
        Body::from(bytes),
    )
}

/// `POST /api/fs/upload` — multipart upload into a chosen directory.
async fn fs_upload(
    State(_state): State<AppState>,
    mut mp: Multipart,
) -> Result<Json<Value>, AppError> {
    let mut dir: Option<String> = None;
    let mut files: Vec<(String, bytes::Bytes)> = Vec::new();
    let mut total: u64 = 0;

    while let Some(field) = mp.next_field().await.map_err(|e| AppError::BadRequest(e.to_string()))? {
        match field.file_name().map(|s| s.to_string()) {
            None => {
                if field.name() == Some("dir") {
                    dir = Some(field.text().await.map_err(|e| AppError::BadRequest(e.to_string()))?);
                }
            }
            Some(fname) => {
                let data = field.bytes().await.map_err(|e| AppError::BadRequest(e.to_string()))?;
                total += data.len() as u64;
                if total > FS_UPLOAD_MAX {
                    return Err(AppError::BadRequest("upload exceeds 200 MB".into()));
                }
                files.push((fname, data));
            }
        }
    }

    let dir = dir.ok_or_else(|| AppError::BadRequest("missing `dir` field".into()))?;
    let dir_abs = path_safe::resolve_safe(&to_abs(&dir, None), None).await?;
    let dir_meta = tokio::fs::metadata(&dir_abs).await.map_err(map_io)?;
    if !dir_meta.is_dir() {
        return Err(AppError::BadRequest("`dir` is not a directory".into()));
    }

    let mut saved = Vec::new();
    for (raw_name, data) in files {
        let target = dedupe_path(&dir_abs, &sanitize_filename(&raw_name)).await;
        let mut f = path_safe::safe_open_write(&target).await.map_err(map_io)?;
        f.write_all(&data).await.map_err(map_io)?;
        f.flush().await.map_err(map_io)?;
        saved.push(json!({
            "name": target.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            "size": data.len(),
        }));
    }

    Ok(Json(json!({ "saved": saved })))
}

/// `DELETE /api/fs/delete` — remove a file (or a directory, recursively).
async fn fs_delete(
    State(state): State<AppState>,
    Json(body): Json<DeleteBody>,
) -> Result<Json<Value>, AppError> {
    let abs = path_safe::resolve_safe(&to_abs(&body.path, body.cwd.as_deref()), None).await?;
    let meta = tokio::fs::symlink_metadata(&abs).await.map_err(map_io)?;
    if meta.is_dir() {
        tokio::fs::remove_dir_all(&abs).await.map_err(map_io)?;
    } else {
        tokio::fs::remove_file(&abs).await.map_err(map_io)?;
    }

    db::audit::log(&state.pool, "user", "file.delete", &abs.to_string_lossy(), json!({}))
        .await
        .ok();

    Ok(Json(json!({ "ok": true, "deleted": abs.to_string_lossy() })))
}

/// `POST /api/upload` — base64 single-file upload to `<data_dir>/uploads/`.
///
/// Accepts BOTH images (screenshots) AND arbitrary files: when the filename
/// claims an image extension the bytes are magic-byte validated (a `.png` must
/// really be a PNG); any other extension is written as-is. The dedicated
/// "send a file/screenshot into the Claude Code session" flow uses this — the
/// returned absolute `path` is injected (quoted) into the terminal prompt so
/// Claude's Read/vision tool picks it up. Files land in the DATA DIR's
/// `uploads/` (never the session cwd), are purged after 24h, and are capped at
/// 20 MB; the client additionally guards images at ~5 MB (Claude's image cap).
async fn upload(
    State(state): State<AppState>,
    Json(body): Json<UploadBody>,
) -> Result<Json<Value>, AppError> {
    // Accept either a bare base64 payload or a `data:…;base64,<payload>` URL.
    let payload = match body.data.strip_prefix("data:") {
        Some(rest) => rest.split_once(',').map(|(_, b)| b).unwrap_or(rest),
        None => body.data.as_str(),
    };
    let bytes = b64_standard()
        .decode(payload.trim())
        .map_err(|_| AppError::BadRequest("invalid base64 payload".into()))?;
    if bytes.len() > UPLOAD_MAX {
        return Err(AppError::BadRequest("upload exceeds 20 MB".into()));
    }

    let safe_name = sanitize_filename(&body.name);
    let ext = extension_lower(Path::new(&safe_name));
    // Magic-byte validation rejects fake images (a .png that is not a PNG) but
    // ONLY when the filename claims an image type — arbitrary files (logs, PDFs,
    // archives, …) are accepted as-is.
    if IMAGE_EXTS.contains(&ext.as_str()) && !looks_like_image(&bytes) {
        return Err(AppError::BadRequest("file is not a valid image".into()));
    }

    let uploads = state.config.data_dir.join("uploads");
    tokio::fs::create_dir_all(&uploads).await.map_err(map_io)?;
    purge_old_uploads(&uploads).await; // best-effort housekeeping (>24h)

    let filename = format!("{}-{}", uuid::Uuid::new_v4().simple(), safe_name);
    let dest = uploads.join(&filename);
    tokio::fs::write(&dest, &bytes).await.map_err(map_io)?;

    Ok(Json(json!({
        "path": dest.to_string_lossy(),
        "name": safe_name,
        "url": format!("/api/uploads/{filename}"),
    })))
}

/// `GET /api/uploads/{filename}` — serve a previously uploaded file.
async fn serve_upload(
    State(state): State<AppState>,
    axum::extract::Path(filename): axum::extract::Path<String>,
) -> Result<Response<Body>, AppError> {
    // The filename is a single path component — reject any traversal attempt.
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err(AppError::BadRequest("invalid filename".into()));
    }
    let path = state.config.data_dir.join("uploads").join(&filename);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| AppError::NotFound("upload not found".into()))?;
    let mime = mime_for(&path);
    build(
        StatusCode::OK,
        &[
            (header::CONTENT_TYPE, &mime),
            (header::CACHE_CONTROL, "private, max-age=3600"),
        ],
        Body::from(bytes),
    )
}

/// `GET /api/autocomplete/dir` — directory typeahead, capped at 10 results.
///
/// FEAT-WHERE-PICKER: when `hidden=0` is passed, dotfile subdirs (`.git`, `.cache`)
/// are filtered out so the "Where" picker's free-text autocomplete never surfaces
/// noise the user has to scroll past. The default (no query param) preserves the
/// legacy "include everything" contract so existing consumers are byte-for-byte
/// unaffected.
async fn autocomplete_dir(
    State(_state): State<AppState>,
    Query(q): Query<AutocompleteQuery>,
) -> Json<Vec<String>> {
    let expanded = shellexpand::tilde(&q.q).into_owned();
    let p = Path::new(&expanded);
    let (dir, prefix) = if expanded.ends_with('/') {
        (p.to_path_buf(), String::new())
    } else {
        (
            p.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("/")),
            p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        )
    };
    // `hidden=0` / `false` / `no` opt-in to dotfile filtering. Anything else
    // (including the default `None`) leaves legacy behaviour intact.
    let filter_hidden = matches!(
        q.hidden.as_deref(),
        Some("0") | Some("false") | Some("no") | Some("off")
    );

    let mut out = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
                let name = entry.file_name().to_string_lossy().into_owned();
                // Skip dotfiles when filtering is on AND the user isn't already
                // typing a leading dot (a typed `.gi` still surfaces `.gitignore`-
                // like results — the filter is about default noise, not about
                // hiding what the user is explicitly searching for).
                if filter_hidden && name.starts_with('.') && !prefix.starts_with('.') {
                    continue;
                }
                if name.starts_with(&prefix) {
                    out.push(entry.path().to_string_lossy().into_owned());
                }
            }
        }
    }
    out.sort();
    out.truncate(10);
    Json(out)
}

// ── FEAT-WHERE-PICKER: project repos endpoint ─────────────────────────────────
//
// The "Where" picker (web/src/components/session-tile/where-picker.tsx) renders
// the deploy-configured project subdirs as primary candidates. Each row needs:
//   - the absolute path (what becomes `dir` on session/team create),
//   - a short display name (the basename),
//   - whether the folder is a git repo — Agent Teams teammates each get their
//     own git worktree (per https://code.claude.com/docs/en/agent-teams), so
//     a non-repo folder would FAIL on `start-a-team`. The UI surfaces this as
//     a calm amber hint, not a blocker.
//
// Source: the FIRST entry in `SUPERMUX_PROJECT_DIRS` (matches the existing
// `_SUPERMUX_PROJECT_DIR` runtime config the frontend already reads — one source
// of truth, no schema drift). Hidden subdirs are filtered. Capped at 200 to
// keep payloads sane on huge project roots.

const PROJECTS_CAP: usize = 200;

#[derive(Debug, serde::Serialize)]
struct ProjectRepo {
    /// Absolute path to the subdir — what the picker stores in the dir field.
    path: String,
    /// Last path component (the basename) — what the row shows prominently.
    name: String,
    /// True when `<path>/.git` exists, either as a DIRECTORY (regular repo) or
    /// as a FILE (git worktree pointer — the `gitdir:` redirect file). Both
    /// satisfy "this folder is inside a git work tree", which is what the
    /// Agent Teams teammate-worktree path requires.
    is_git_repo: bool,
}

#[derive(Debug, serde::Serialize)]
struct ProjectRepos {
    /// The root scanned (the first `SUPERMUX_PROJECT_DIRS` entry). Empty when
    /// the env var is unset — the picker then hides the Projects section and
    /// nudges the user to "Use another folder".
    root: String,
    /// Truncated repo entries (alphabetical), capped at [`PROJECTS_CAP`].
    entries: Vec<ProjectRepo>,
}

/// `GET /api/projects/repos` — list immediate subdirs of the first
/// `SUPERMUX_PROJECT_DIRS` entry with git-repo metadata. Hidden entries
/// filtered; alphabetical; capped at [`PROJECTS_CAP`].
async fn projects_repos(State(_state): State<AppState>) -> Json<ProjectRepos> {
    let root = std::env::var("SUPERMUX_PROJECT_DIRS")
        .ok()
        .and_then(|s| s.split(':').next().map(str::to_string))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();

    if root.is_empty() {
        return Json(ProjectRepos {
            root: String::new(),
            entries: Vec::new(),
        });
    }

    let expanded = shellexpand::tilde(&root).into_owned();
    let root_path = Path::new(&expanded);

    let mut entries: Vec<ProjectRepo> = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(root_path).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let ft = entry.file_type().await.ok();
            if !ft.map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let git_marker = path.join(".git");
            // Git worktrees use a `.git` FILE (containing `gitdir: …`), not a
            // directory. `try_exists` is true for both, which is what we want —
            // we just need to know the folder is inside a git work tree.
            let is_git_repo = tokio::fs::try_exists(&git_marker).await.unwrap_or(false);
            entries.push(ProjectRepo {
                path: path.to_string_lossy().into_owned(),
                name,
                is_git_repo,
            });
        }
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries.truncate(PROJECTS_CAP);

    Json(ProjectRepos {
        root: root_path.to_string_lossy().into_owned(),
        entries,
    })
}

// ──────────────────────────────── helpers ──────────────────────────────────

/// Make an absolute path string from a possibly-relative input + optional cwd.
fn to_abs(path: &str, cwd: Option<&str>) -> String {
    let expanded = shellexpand::tilde(path).into_owned();
    let p = Path::new(&expanded);
    if p.is_absolute() {
        return expanded;
    }
    let base = match cwd {
        Some(c) => shellexpand::tilde(c).into_owned(),
        None => dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default(),
    };
    Path::new(&base).join(&expanded).to_string_lossy().into_owned()
}

fn is_truthy(v: Option<&str>) -> bool {
    matches!(v, Some("1") | Some("true") | Some("yes"))
}

fn extension_lower(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

/// `PUT` is allowed for a whitelisted extension or an extension-less file
/// (`Dockerfile`, `Makefile`). Dotfiles like `.gitignore` have no `extension()`
/// per `std::path`, so they pass via the extension-less branch.
fn is_writable_target(p: &Path) -> bool {
    match p.extension().and_then(|e| e.to_str()) {
        None => true,
        Some(ext) => WRITABLE_EXTS.contains(&ext.to_lowercase().as_str()),
    }
}

fn mime_for(p: &Path) -> String {
    mime_guess::from_path(p).first_or_octet_stream().to_string()
}

fn mtime_unix(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn b64_standard() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn header_str(headers: &HeaderMap, name: header::HeaderName) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
}

/// Build a response from a status, header pairs, and body.
fn build(
    status: StatusCode,
    headers: &[(header::HeaderName, &str)],
    body: Body,
) -> Result<Response<Body>, AppError> {
    let mut b = Response::builder().status(status);
    for (name, value) in headers {
        b = b.header(name, *value);
    }
    b.body(body).map_err(|e| AppError::Internal(anyhow::Error::new(e)))
}

async fn read_all(path: &Path) -> Result<Vec<u8>, AppError> {
    let mut f = path_safe::safe_open_read(path).await.map_err(map_io)?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).await.map_err(map_io)?;
    Ok(buf)
}

async fn read_head(path: &Path, n: usize) -> Result<Vec<u8>, AppError> {
    let mut f = path_safe::safe_open_read(path).await.map_err(map_io)?;
    let mut buf = vec![0u8; n];
    let read = f.read(&mut buf).await.map_err(map_io)?;
    buf.truncate(read);
    Ok(buf)
}

/// Read up to `limit` bytes as lossy UTF-8; the second tuple element is `true`
/// when the file was longer than `limit` (and thus truncated).
async fn read_text(path: &Path, limit: usize) -> Result<(String, bool), AppError> {
    let mut f = path_safe::safe_open_read(path).await.map_err(map_io)?;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut chunk).await.map_err(map_io)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > limit {
            break;
        }
    }
    let truncated = buf.len() > limit;
    if truncated {
        buf.truncate(limit);
    }
    Ok((String::from_utf8_lossy(&buf).into_owned(), truncated))
}

/// Replace any character outside `[\w.\- ]` with `_` (feature-extract §3.5).
fn sanitize_filename(name: &str) -> String {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^\w.\- ]").unwrap());
    // Defend against a path component sneaking in via the filename.
    let base = Path::new(name)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let cleaned = RE.replace_all(base.trim(), "_").into_owned();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

/// Pick a non-colliding path in `dir`, appending `_N` before the extension.
async fn dedupe_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
        return candidate;
    }
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().into_owned());
    for i in 1..10_000 {
        let trial = match &ext {
            Some(e) => format!("{stem}_{i}.{e}"),
            None => format!("{stem}_{i}"),
        };
        let path = dir.join(&trial);
        if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
            return path;
        }
    }
    dir.join(format!("{}-{}", uuid::Uuid::new_v4().simple(), name))
}

/// Magic-byte sniff for the common image formats.
fn looks_like_image(b: &[u8]) -> bool {
    b.starts_with(&[0x89, 0x50, 0x4E, 0x47]) // PNG
        || b.starts_with(&[0xFF, 0xD8, 0xFF]) // JPEG
        || b.starts_with(b"GIF87a")
        || b.starts_with(b"GIF89a")
        || (b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP") // WebP
        || b.starts_with(b"BM") // BMP
        || b.starts_with(&[0x00, 0x00, 0x01, 0x00]) // ICO
        || b.starts_with(b"<svg")
        || b.starts_with(b"<?xml") // SVG
        || looks_like_heif(b) // HEIC/HEIF (iOS camera/library)
}

/// HEIC/HEIF magic-byte sniff. These are ISO-BMFF (MP4-family) files whose first
/// box is an `ftyp` box: a 4-byte big-endian box size, then the literal `ftyp`
/// at bytes 4..8, then a 4-byte major brand. iOS photos use a `heic`/`heix`/
/// `mif1`/`msf1`/`heif` brand. We accept the file if the major brand OR any of
/// the listed compatible brands (which follow, 4 bytes each, from offset 16) is
/// a known HEIF brand — so a `.heic` Apple photo is treated as image content and
/// passes validation instead of slipping through as a generic file.
fn looks_like_heif(b: &[u8]) -> bool {
    if b.len() < 12 || &b[4..8] != b"ftyp" {
        return false;
    }
    const HEIF_BRANDS: &[&[u8; 4]] = &[
        b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"heif", b"mif1", b"msf1",
    ];
    let is_brand = |brand: &[u8]| HEIF_BRANDS.iter().any(|wanted| brand == &wanted[..]);
    // Major brand at 8..12, then compatible-brand list from 16 onward (within the
    // ftyp box). Checking a bounded prefix is enough to recognise Apple's photos.
    if is_brand(&b[8..12]) {
        return true;
    }
    let mut off = 16;
    while off + 4 <= b.len() && off < 64 {
        if is_brand(&b[off..off + 4]) {
            return true;
        }
        off += 4;
    }
    false
}

/// Best-effort: remove uploaded files older than 24h (feature-extract §3.5).
async fn purge_old_uploads(dir: &Path) {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 3600);
    while let Ok(Some(entry)) = rd.next_entry().await {
        if let Ok(meta) = entry.metadata().await {
            if meta.is_file() {
                if let Ok(modified) = meta.modified() {
                    if modified < cutoff {
                        let _ = tokio::fs::remove_file(entry.path()).await;
                    }
                }
            }
        }
    }
}

/// Map an IO error to the right HTTP status. An `O_NOFOLLOW` refusal (`ELOOP`)
/// is a 403 — a symlink was in the final position at open time.
fn map_io(e: std::io::Error) -> AppError {
    #[cfg(unix)]
    if e.raw_os_error() == Some(nix::libc::ELOOP) {
        return AppError::Forbidden("refusing to follow symlink".into());
    }
    match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound("path not found".into()),
        std::io::ErrorKind::PermissionDenied => AppError::Forbidden("permission denied".into()),
        _ => AppError::Internal(e.into()),
    }
}
