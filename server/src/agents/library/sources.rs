//! Finite provider search paths for importing an existing skill into the Store.
//! A draft is returned to the owner for review before anything is installed.
use super::{bad, missing, validate, Files, Reply};
use crate::{
    claude_tools::atomic::claude_config_dir,
    db,
    scope::{self, OptCtx},
    state::AppState,
};
use axum::{
    extract::{Query, State},
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use tokio::{fs, io::AsyncReadExt};

#[derive(Deserialize)]
pub(super) struct SourceQuery {
    target: String,
    source: Option<String>,
    name: Option<String>,
}

async fn roots(
    state: &AppState,
    target: &str,
) -> Result<Vec<(&'static str, PathBuf)>, crate::error::AppError> {
    let mut paths = vec![("Claude · user", claude_config_dir().join("skills"))];
    if let Some(home) = dirs::home_dir() {
        paths.push(("Codex · user", home.join(".agents/skills")));
        let codex = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        paths.push(("Codex · config", codex.join("skills")));
    }
    if let Some(s) = db::sessions::get(&state.pool, target).await? {
        if s.host_id.is_none() {
            let cwd = Path::new(&s.dir);
            paths.push(("Claude · project", cwd.join(".claude/skills")));
            paths.push(("Codex · project", cwd.join(".agents/skills")));
            if !s.config_dir.is_empty() && s.provider == "claude" {
                paths.push(("Claude · account", Path::new(&s.config_dir).join("skills")));
            }
        }
    }
    Ok(paths)
}

pub(super) async fn browse(
    State(state): State<AppState>,
    ctx: OptCtx,
    Query(q): Query<SourceQuery>,
) -> Reply {
    scope::require_admin(ctx.0.as_ref(), "/api/agent-skills")?;
    let paths = roots(&state, &q.target).await?;
    if let (Some(source), Some(name)) = (&q.source, &q.name) {
        if !super::valid_name(name) {
            return Err(bad("Invalid skill name"));
        }
        let (_, root) = paths
            .iter()
            .find(|(id, _)| *id == source.as_str())
            .ok_or_else(missing)?;
        let files = read_folder(&root.join(name)).await?;
        validate(name, &files)?;
        return Ok(Json(json!({"files":files})));
    }
    let mut available = Vec::new();
    for (source, root) in paths {
        let mut entries = match fs::read_dir(root).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(anyhow::Error::from(e).into()),
        };
        while let Some(entry) = entries.next_entry().await.map_err(anyhow::Error::from)? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if super::valid_name(&name)
                && fs::metadata(entry.path().join("SKILL.md"))
                    .await
                    .is_ok_and(|m| m.is_file())
            {
                available.push((source, name));
            }
        }
    }
    available.sort();
    Ok(Json(json!(available)))
}

async fn read_folder(root: &Path) -> Result<Files, crate::error::AppError> {
    let mut pending = vec![PathBuf::new()];
    let mut files = Files::new();
    let mut remaining = 1_350_000;
    let mut visited = 0;
    while let Some(dir) = pending.pop() {
        let mut entries = fs::read_dir(root.join(&dir))
            .await
            .map_err(anyhow::Error::from)?;
        while let Some(entry) = entries.next_entry().await.map_err(anyhow::Error::from)? {
            let filename = entry.file_name();
            if filename == ".git" {
                continue;
            }
            visited += 1;
            if visited > 1024 {
                return Err(bad("Too many entries in the skill folder"));
            }
            let path = dir.join(filename);
            let kind = entry.file_type().await.map_err(anyhow::Error::from)?;
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() {
                let mut bytes = Vec::new();
                let file = fs::File::open(entry.path())
                    .await
                    .map_err(anyhow::Error::from)?;
                file.take(remaining + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(anyhow::Error::from)?;
                if bytes.len() as u64 > remaining || files.len() >= 512 {
                    return Err(bad("This skill exceeds the package limit"));
                }
                remaining -= bytes.len() as u64;
                let key = path
                    .to_str()
                    .ok_or_else(|| bad("Skill paths must be UTF-8"))?;
                files.insert(key.to_string(), STANDARD.encode(bytes));
            } else {
                return Err(bad(
                    "Import requires ordinary files and directories inside the skill",
                ));
            }
        }
    }
    Ok(files)
}
