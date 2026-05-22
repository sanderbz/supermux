//! Filesystem path safety (TECH_PLAN §3.2.11, §6.3; feature-extract §3.4).
//!
//! Two layers of defense:
//!
//!  1. **[`resolve_safe`]** — canonicalize the path (or, for not-yet-existing
//!     create targets, the nearest existing ancestor) so that `..`/symlink
//!     traversal collapses to a real absolute path, then reject it if it lands
//!     on a blocklisted secret (`/etc/shadow`, `~/.ssh`, …). Comparison is
//!     case-insensitive so the macOS HFS+/APFS `/ETC/SHADOW` trick is defeated.
//!
//!  2. **[`safe_open_read`] / [`safe_open_write`]** — open the resolved path with
//!     `O_NOFOLLOW` so that if the final component is swapped for a symlink in
//!     the TOCTOU window between resolve and open, the kernel refuses (`ELOOP`).
//!
//! `resolve_safe` is `async` (uses `tokio::fs::canonicalize`) so it never blocks
//! a tokio worker on a slow stat (Codex T0 fix). For a brand-new file the
//! parent — not the path — is canonicalized, so `PUT /api/file` to a path that
//! does not exist yet no longer 500s (Codex #3).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::error::AppError;

/// Exact absolute paths that are never readable/writable.
const BLOCKED: &[&str] = &[
    "/etc/shadow",
    "/etc/sudoers",
    "/etc/master.passwd",
    "/private/etc/shadow",
    "/private/etc/sudoers",
    "/private/etc/master.passwd",
    "/var/db/sudo",
    "/private/var/db/sudo",
];

/// Absolute prefixes that are never readable/writable.
const BLOCKED_PREFIXES: &[&str] = &[
    "/etc/ssh/",
    "/private/etc/ssh/",
    "/var/run/secrets/",
    "/run/secrets/",
];

/// Home-relative directories that are never readable/writable.
const HOME_BLOCKED: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".netrc",
    ".npmrc",
    ".docker",
    ".config/gcloud",
    ".config/gh",
];

/// Why a path was rejected.
#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("invalid path")]
    Invalid,
    #[error("path is blocked")]
    Blocked,
    #[error("path is outside the permitted root")]
    OutsideJail,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl From<PathError> for AppError {
    fn from(err: PathError) -> Self {
        match err {
            PathError::Blocked | PathError::OutsideJail => AppError::Forbidden(err.to_string()),
            PathError::Invalid => AppError::BadRequest(err.to_string()),
            // A canonicalize that fails because the path/parent does not exist is
            // a 404 to the client; anything else is internal.
            PathError::Io(io) => match io.kind() {
                std::io::ErrorKind::NotFound => AppError::NotFound("path not found".to_string()),
                std::io::ErrorKind::PermissionDenied => {
                    AppError::Forbidden("permission denied".to_string())
                }
                _ => AppError::Internal(io.into()),
            },
        }
    }
}

/// Resolve `input` to a real absolute path and verify it is not blocklisted.
///
/// `jail`, when set, additionally requires the result to live under that root
/// (used for per-session file views rooted at `CC_DIR`). M7's global browser
/// passes `None`.
pub async fn resolve_safe(input: &str, jail: Option<&Path>) -> Result<PathBuf, PathError> {
    let expanded = shellexpand::tilde(input).into_owned();
    if expanded.is_empty() || expanded.as_bytes().contains(&0) {
        return Err(PathError::Invalid);
    }
    let candidate = PathBuf::from(&expanded);
    if !candidate.is_absolute() {
        return Err(PathError::Invalid);
    }

    let abs = canonicalize_allowing_missing(&candidate).await?;

    // Case-insensitive blocklist (defeats macOS `/ETC/SHADOW`).
    let abs_lower = abs.to_string_lossy().to_lowercase();
    if BLOCKED.iter().any(|b| abs_lower == b.to_lowercase()) {
        return Err(PathError::Blocked);
    }
    if BLOCKED_PREFIXES
        .iter()
        .any(|b| abs_lower.starts_with(&b.to_lowercase()))
    {
        return Err(PathError::Blocked);
    }
    if let Some(home) = dirs::home_dir() {
        for rel in HOME_BLOCKED {
            if abs.starts_with(home.join(rel)) {
                return Err(PathError::Blocked);
            }
        }
    }

    if let Some(jail) = jail {
        let jail_canon = tokio::fs::canonicalize(jail).await.unwrap_or_else(|_| jail.to_path_buf());
        if !abs.starts_with(&jail_canon) {
            return Err(PathError::OutsideJail);
        }
    }

    Ok(abs)
}

/// Canonicalize an existing path; for a path that does not exist yet, find the
/// nearest existing ancestor, canonicalize *it* (collapsing any symlinks/`..`
/// in the existing portion), then re-append the missing tail — rejecting any
/// `.`/`..` component in that tail so a create target can never traverse out.
async fn canonicalize_allowing_missing(candidate: &Path) -> Result<PathBuf, PathError> {
    // Fast path: the whole path exists — canonicalize resolves symlinks and `..`.
    if tokio::fs::try_exists(candidate).await.unwrap_or(false) {
        return Ok(tokio::fs::canonicalize(candidate).await?);
    }

    // Walk up to the nearest existing ancestor, collecting the missing tail.
    let mut tail: Vec<&OsStr> = Vec::new();
    let mut cursor = candidate;
    loop {
        let name = cursor.file_name().ok_or(PathError::Invalid)?;
        if name == OsStr::new("..") || name == OsStr::new(".") {
            // A `..`/`.` in the *missing* portion cannot be canonicalized away,
            // so refuse it outright rather than risk a traversal.
            return Err(PathError::Invalid);
        }
        tail.push(name);

        let parent = cursor.parent().ok_or(PathError::Invalid)?;
        if tokio::fs::try_exists(parent).await.unwrap_or(false) {
            let mut base = tokio::fs::canonicalize(parent).await?;
            for comp in tail.iter().rev() {
                base.push(comp);
            }
            return Ok(base);
        }
        cursor = parent;
    }
}

/// Open `path` read-only with `O_NOFOLLOW` (refuse a final-component symlink).
pub async fn safe_open_read(path: &Path) -> std::io::Result<tokio::fs::File> {
    open_nofollow(tokio::fs::OpenOptions::new().read(true), path).await
}

/// Open `path` for truncating write/create with `O_NOFOLLOW`.
pub async fn safe_open_write(path: &Path) -> std::io::Result<tokio::fs::File> {
    open_nofollow(
        tokio::fs::OpenOptions::new().write(true).create(true).truncate(true),
        path,
    )
    .await
}

#[cfg(unix)]
async fn open_nofollow(
    opts: &mut tokio::fs::OpenOptions,
    path: &Path,
) -> std::io::Result<tokio::fs::File> {
    // `custom_flags` is an inherent method on tokio's unix `OpenOptions`.
    // O_NOFOLLOW only guards the *final* component — which is exactly the TOCTOU
    // window, because resolve_safe already canonicalized every parent.
    opts.custom_flags(nix::libc::O_NOFOLLOW).open(path).await
}

#[cfg(not(unix))]
async fn open_nofollow(
    opts: &mut tokio::fs::OpenOptions,
    path: &Path,
) -> std::io::Result<tokio::fs::File> {
    opts.open(path).await
}
