//! Filesystem path safety.
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
//! a tokio worker on a slow stat. For a brand-new file the
//! parent — not the path — is canonicalized, so `PUT /api/file` to a path that
//! does not exist yet no longer 500s.
//!
//! ## Transport-aware variant
//!
//! [`resolve_safe_remote`] is the remote-transport companion to
//! [`resolve_safe`]: it does NOT canonicalize against the local filesystem
//! (the path lives on a different host), but the blocklist still applies via
//! a case-insensitive text compare on the EXPANDED path. The blocklist is
//! the same set of rules that [`resolve_safe`] enforces, so a remote
//! `/ETC/SHADOW` is refused the same way a local one is.

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
/// (used for per-session file views rooted at `CC_DIR`). The global browser
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

/// Transport-aware blocklist check for a path that lives on a REMOTE host.
/// We cannot canonicalize the path against our local FS — the file
/// is on a different machine — so this enforces the blocklist via a
/// case-insensitive prefix/exact compare on the expanded input. The exact
/// list mirrors what [`resolve_safe`] enforces locally, so a remote
/// `/ETC/SHADOW` request is refused the same way a local one is.
///
/// NOTE: this function itself does NOT resolve symlinks on the remote host.
/// The remote shell (e.g. `cat <path>`) WILL follow them, so an attacker who
/// can place a symlink at `/tmp/innocent -> /etc/shadow` on the remote host
/// could otherwise bypass this check. That's why the SSH call site in
/// `files::mod::safe_path` runs `readlink -f` over the warm ControlMaster
/// BEFORE handing the path here (H2). On older BSD `readlink` lacking `-f`
/// the call site logs and falls back to the literal path — the blocklist
/// still runs. A protocol-level SFTP rewrite (future work) would let us
/// LSTAT + REALPATH over SFTP and skip the readlink shell-out.
pub fn resolve_safe_remote(input: &str) -> Result<PathBuf, PathError> {
    let expanded = shellexpand::tilde(input).into_owned();
    if expanded.is_empty() || expanded.as_bytes().contains(&0) {
        return Err(PathError::Invalid);
    }
    let candidate = PathBuf::from(&expanded);
    if !candidate.is_absolute() {
        return Err(PathError::Invalid);
    }

    // Refuse any `.`/`..` component so a relative-ish bit can't squeeze in.
    for comp in candidate.components() {
        match comp {
            std::path::Component::CurDir | std::path::Component::ParentDir => {
                return Err(PathError::Invalid);
            }
            _ => {}
        }
    }

    let lower = expanded.to_lowercase();
    if BLOCKED.iter().any(|b| lower == b.to_lowercase()) {
        return Err(PathError::Blocked);
    }
    if BLOCKED_PREFIXES
        .iter()
        .any(|b| lower.starts_with(&b.to_lowercase()))
    {
        return Err(PathError::Blocked);
    }
    // For HOME_BLOCKED we use a heuristic: the remote home is most often
    // `/root` or `/home/<user>`. If the path matches `<anything>/<home-blocked>`
    // we treat it as blocked. This over-blocks slightly (any directory named
    // `.ssh` anywhere) but errs on the side of safety.
    //
    // For multi-segment rels like `.config/gcloud` we match the SEQUENCE as a
    // contiguous sub-slice of the path's components — a per-component scan
    // would let `~/foo/.config/something/gcloud` slip through because it sees
    // `.config` and `gcloud` independently. Single-segment rels (`.ssh`,
    // `.aws`, …) keep the existing any-component heuristic.
    let lower_path = std::path::Path::new(&lower);
    let comps: Vec<String> = lower_path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    for rel in HOME_BLOCKED {
        let rel_lower = rel.to_lowercase();
        let needle_tail = format!("/{}", rel_lower);
        let segs: Vec<&str> = rel_lower.split('/').collect();
        let seq_hit = segs.len() > 1
            && comps
                .windows(segs.len())
                .any(|w| w.iter().zip(segs.iter()).all(|(a, b)| a == b));
        let single_hit = segs.len() == 1 && comps.iter().any(|c| c == segs[0]);
        if lower.ends_with(&needle_tail) || seq_hit || single_hit {
            return Err(PathError::Blocked);
        }
    }
    Ok(candidate)
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

// H2 NOTE: `resolve_safe_remote` runs the blocklist against the literal path
// the user provided. A remote shell happily follows symlinks (`~/safe-link
// -> ~/.ssh`), so a blocklisted dir could be reached via a symlinked alias.
// The fix lives at the SSH transport call site (`files::mod::safe_path`):
// before this function runs, the caller does ONE `readlink -f -- "$path"`
// hop over the warm ControlMaster and passes the RESOLVED path here. If
// `readlink -f` is unavailable (older BSD `readlink`), the caller logs and
// falls back to the literal path — never silently allows.

#[cfg(test)]
mod tests {
    use super::*;

    // H1: a nested `.config/.../gcloud` must NOT slip past the windowed match
    // (the old per-component scan saw `.config` and `gcloud` independently).
    #[test]
    fn remote_blocks_nested_config_gcloud_sequence() {
        // Direct adjacent sequence — the documented bypass.
        let err = resolve_safe_remote("/home/u/foo/.config/gcloud/creds.json").unwrap_err();
        assert!(matches!(err, PathError::Blocked));
        // Same shape for `.config/gh`.
        let err = resolve_safe_remote("/home/u/.config/gh/hosts.yml").unwrap_err();
        assert!(matches!(err, PathError::Blocked));
        // Non-adjacent must NOT match (`.config/something/gcloud` is allowed
        // because the SEQUENCE `.config/gcloud` isn't a contiguous sub-slice).
        let ok = resolve_safe_remote("/home/u/.config/something/gcloud-notes.txt");
        assert!(ok.is_ok());
        // Single-segment rels still trip on any component.
        let err = resolve_safe_remote("/home/u/.ssh/id_ed25519").unwrap_err();
        assert!(matches!(err, PathError::Blocked));
    }
}
