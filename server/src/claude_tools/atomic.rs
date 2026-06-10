//! Atomic JSON config edits + path resolution shared by the registry reader and
//! the MCP mutators. This is the SAME read → refuse-if-unparseable → merge-own-
//! subtree → temp → fsync → `rename(2)` shape proven in [`crate::claude_config`],
//! lifted here so `~/.claude.json` and `<cwd>/.mcp.json` get the identical crash-
//! safe, non-clobbering treatment. A crash mid-write never
//! truncates the file; a file we cannot parse is left ALONE.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::error::AppError;

/// Resolve Claude's config directory: `$CLAUDE_CONFIG_DIR` (Claude Code's own
/// override — also what tests target) else `~/.claude`. Mirrors
/// [`crate::claude_config`]'s resolver so the hook installer, command seeder, and
/// this manager all stay in lockstep and tests can point them at a temp dir.
pub fn claude_config_dir() -> PathBuf {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        let d = d.trim();
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
}

/// `~/.claude.json` — the user+local MCP store. NOTE: this lives in `$HOME`, NOT
/// under the `.claude/` config dir (verified on this host). When
/// `$CLAUDE_CONFIG_DIR` is set (tests), we co-locate it there so the whole
/// manager can be exercised against a temp dir.
pub fn claude_json_path() -> PathBuf {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        let d = d.trim();
        if !d.is_empty() {
            return PathBuf::from(d).join(".claude.json");
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude.json")
}

/// `<cwd>/.mcp.json` — the project-scope (git-tracked) MCP file.
pub fn mcp_json_path(cwd: &str) -> PathBuf {
    Path::new(cwd).join(".mcp.json")
}

/// Read a JSON config file into a `Value`. A missing/empty file is `{}`; an
/// unparseable file is an ERROR (so we never overwrite a file we don't
/// understand). The returned value is guaranteed to be a JSON object.
pub async fn read_json_object(path: &Path) -> Result<Value> {
    if !tokio::fs::try_exists(path).await.unwrap_or(false) {
        return Ok(json!({}));
    }
    let text = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("reading {}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    let v: Value = serde_json::from_str(&text)
        .with_context(|| format!("{} is not valid JSON; refusing to touch it", path.display()))?;
    if !v.is_object() {
        anyhow::bail!("{} is not a JSON object; refusing to touch it", path.display());
    }
    Ok(v)
}

/// Atomically write `root` (a JSON object) to `path`: pretty-serialize → temp
/// sibling → `sync_all()` → `rename(2)` (atomic on POSIX). Identical discipline to
/// `claude_config::install_hooks_at`. Parent dirs are created as needed.
///
/// `read-merge-write the smallest possible subtree` (plan open-risk): callers
/// should mutate only their own `mcpServers`/enable-list subtree and re-read
/// immediately before write to keep the race window with a live `claude` tiny.
pub async fn write_json_atomic(path: &Path, root: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("creating parent of {}", path.display()))?;
    }
    let body = serde_json::to_string_pretty(root)? + "\n";
    let tmp = sibling_tmp(path);

    // The write+fsync+rename runs on a blocking thread: std `File::sync_all` is
    // the crash-safety primitive and is not exposed by tokio::fs ergonomically.
    let tmp_c = tmp.clone();
    let path_c = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut f = std::fs::File::create(&tmp_c)
            .with_context(|| format!("creating {}", tmp_c.display()))?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp_c, &path_c)
            .with_context(|| format!("renaming {} -> {}", tmp_c.display(), path_c.display()))?;
        Ok(())
    })
    .await
    .context("join atomic-write task")??;
    Ok(())
}

/// A unique temp sibling next to `path` so the `rename(2)` is same-filesystem
/// (atomic). The pid+nanos suffix avoids a collision between concurrent writers.
fn sibling_tmp(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config.json".into());
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    path.with_file_name(format!(".{name}.supermux-tmp-{nonce}"))
}

/// Replace every `env`/`headers` VALUE in one MCP server object with the masked
/// sentinel, IN PLACE, returning a deep clone safe to serialize to the client.
/// Only KEY names survive — the secret values never leave the server.
pub fn mask_mcp_secrets(server: &Value, masked: &str) -> Value {
    let mut out = server.clone();
    if let Some(obj) = out.as_object_mut() {
        for secret_field in ["env", "headers"] {
            if let Some(Value::Object(map)) = obj.get_mut(secret_field) {
                for (_k, v) in map.iter_mut() {
                    *v = Value::String(masked.to_string());
                }
            }
        }
    }
    out
}

/// Convert an anyhow error from the read/write helpers into the right `AppError`.
/// An unparseable-file refusal is a 409 Conflict (the client should not retry
/// blindly); anything else is internal.
pub fn map_config_err(e: anyhow::Error) -> AppError {
    let msg = e.to_string();
    if msg.contains("refusing to touch") {
        AppError::Conflict(msg)
    } else {
        AppError::Internal(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("supermux-ct-atomic-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn read_missing_is_empty_object() {
        let p = temp_dir().join("nope.json");
        let v = read_json_object(&p).await.unwrap();
        assert_eq!(v, json!({}));
    }

    #[tokio::test]
    async fn read_refuses_unparseable() {
        let dir = temp_dir();
        let p = dir.join("bad.json");
        std::fs::write(&p, "not { json").unwrap();
        let err = read_json_object(&p).await;
        assert!(err.is_err(), "unparseable file must error, not be silently reset");
        // Original bytes untouched.
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "not { json");
    }

    #[tokio::test]
    async fn write_then_read_roundtrips_and_is_atomic_no_tmp_left() {
        let dir = temp_dir();
        let p = dir.join("c.json");
        let v = json!({ "mcpServers": { "x": { "type": "stdio" } } });
        write_json_atomic(&p, &v).await.unwrap();
        let back = read_json_object(&p).await.unwrap();
        assert_eq!(back, v);
        // No leftover temp sibling.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("supermux-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "atomic write must leave no temp file: {leftovers:?}");
    }

    #[test]
    fn masking_replaces_only_values_keeps_keys() {
        let server = json!({
            "type": "stdio",
            "command": "npx",
            "args": ["pkg"],
            "env": { "API_KEY": "supersecret", "REGION": "eu" },
            "headers": { "Authorization": "Bearer raw-token" }
        });
        let masked = mask_mcp_secrets(&server, MASKED_FOR_TEST);
        // Non-secret fields survive verbatim.
        assert_eq!(masked["type"], json!("stdio"));
        assert_eq!(masked["command"], json!("npx"));
        assert_eq!(masked["args"], json!(["pkg"]));
        // Secret KEYS survive; secret VALUES are masked.
        assert_eq!(masked["env"]["API_KEY"], json!(MASKED_FOR_TEST));
        assert_eq!(masked["env"]["REGION"], json!(MASKED_FOR_TEST));
        assert_eq!(masked["headers"]["Authorization"], json!(MASKED_FOR_TEST));
        // No raw secret survives anywhere in the serialized form.
        let s = serde_json::to_string(&masked).unwrap();
        assert!(!s.contains("supersecret"), "raw env secret must not survive masking");
        assert!(!s.contains("raw-token"), "raw header secret must not survive masking");
    }

    const MASKED_FOR_TEST: &str = "••• set";
}
