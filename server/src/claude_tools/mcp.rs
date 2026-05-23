//! MCP server mutators (plan §C.3): add (guided form OR raw JSON), remove,
//! enable/disable (project trust), and the OPT-IN live health check.
//!
//! **Write path = atomic JSON edit** of the smallest subtree (plan §C.4, open-
//! risk). For `user`/`local` we read→merge→write `~/.claude.json`; for `project`
//! we write `<cwd>/.mcp.json` — but ONLY with an explicit confirm flag, because
//! that file is git-tracked and its env values would be shared with everyone who
//! clones (plan §D.6). Project paths are jailed to the session's `cwd` via
//! [`path_safe::resolve_safe`].
//!
//! **Secrets are write-only.** `env`/`headers` values arrive raw on the way IN
//! (to be written to disk where Claude needs them) but NEVER round-trip back out
//! — the registry read masks them. We never log a raw value.
//!
//! **Health check is opt-in ONLY.** `POST /api/claude/mcp/{name}/check` shells
//! out to `claude mcp` (the one path that does a live probe). It is bounded by a
//! timeout and never runs on a plain list-read (plan §A, §D.7, open-risk).

use std::path::Path;
use std::time::Duration;

use axum::extract::{Path as AxPath, Query, State};
use axum::Json;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::error::AppError;
use crate::files::path_safe;
use crate::state::AppState;

use super::atomic::{
    claude_json_path, map_config_err, mcp_json_path, read_json_object, write_json_atomic,
};
use super::Scope;

/// MCP-name slug: no path separators / shell metacharacters, so a name can never
/// traverse out of a file or be smuggled into a CLI arg. Mirrors the skills.rs
/// slug discipline.
static MCP_NAME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_.-]+$").unwrap());

fn valid_mcp_name(name: &str) -> bool {
    name != "." && name != ".." && !name.is_empty() && name.len() <= 100 && MCP_NAME_RE.is_match(name)
}

// ── add ───────────────────────────────────────────────────────────────────────

/// `POST /api/claude/mcp` body. Accepts EITHER a guided form (name + transport +
/// command/args/env or url/headers) OR a raw `add-json`-shaped `config` blob.
#[derive(Debug, Deserialize)]
pub struct AddBody {
    pub name: String,
    /// `user` | `local` | `project`. The handler defaults a missing scope to
    /// `local` (when a cwd is given) else `user` — NEVER `project` implicitly.
    #[serde(default)]
    pub scope: Option<Scope>,
    /// Required for `local`/`project` scope (the session's working dir).
    #[serde(default)]
    pub cwd: Option<String>,

    // ── guided form ──
    /// `stdio` (default) | `http` | `sse`.
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<Map<String, Value>>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Option<Map<String, Value>>,

    // ── raw-JSON form (the "Paste JSON" tab) ──
    /// A full server object (`{ type, command, args, env, ... }`). When present it
    /// takes precedence over the guided fields.
    #[serde(default)]
    pub config: Option<Value>,

    /// MUST be `true` to write the git-tracked `<cwd>/.mcp.json` (project scope).
    /// Absent/false on a project write → a clear error telling the FE to show a
    /// loud "committed to git" warning first (plan §D.6).
    #[serde(default)]
    pub confirm_project_write: bool,
}

/// `POST /api/claude/mcp` — add (or replace) an MCP server in the chosen scope.
pub async fn add(
    State(state): State<AppState>,
    Json(body): Json<AddBody>,
) -> Result<Json<Value>, AppError> {
    if !valid_mcp_name(&body.name) {
        return Err(AppError::BadRequest(
            "invalid MCP name (allowed: letters, digits, '_', '.', '-')".into(),
        ));
    }

    // Default scope: local if a cwd is given, else user. NEVER project implicitly.
    let scope = body.scope.unwrap_or(if body.cwd.is_some() {
        Scope::Local
    } else {
        Scope::User
    });

    // Build the server object from the raw blob (if any) else the guided fields.
    let server = match &body.config {
        Some(cfg) => normalize_raw_config(cfg)?,
        None => build_guided_config(&body)?,
    };

    let restart_hint = true; // MCP changes need a fresh session (plan §A.1).

    match scope {
        Scope::User => {
            upsert_in_claude_json(&[], &body.name, server.clone()).await?;
            audit(&state, "mcp.add", "user", None, &body.name).await;
        }
        Scope::Local => {
            let cwd = require_cwd(&body.cwd)?;
            let key = project_key(&cwd);
            upsert_in_claude_json(&["projects", &key], &body.name, server.clone()).await?;
            audit(&state, "mcp.add", "local", Some(&cwd), &body.name).await;
        }
        Scope::Project => {
            // Git-tracked file → require an explicit confirm (plan §D.6).
            if !body.confirm_project_write {
                return Err(AppError::BadRequest(
                    ".mcp.json is committed to git — its env values would be shared with everyone \
                     who clones. Prefer 'local' or 'user' for secrets. Re-send with \
                     confirm_project_write=true to write it anyway."
                        .into(),
                ));
            }
            let cwd = require_cwd(&body.cwd)?;
            // Jail the write inside the session's cwd (canonicalize + blocklist).
            let target = mcp_json_path(&cwd);
            jail_check(&target, &cwd).await?;
            upsert_in_mcp_json(&cwd, &body.name, server.clone()).await?;
            audit(&state, "mcp.add", "project", Some(&cwd), &body.name).await;
        }
    }

    Ok(Json(json!({
        "ok": true,
        "name": body.name,
        "scope": scope,
        "restartHint": restart_hint,
    })))
}

/// Validate + normalize a raw `add-json`-shaped server object: it must be an
/// object, transport must be one we understand, and stdio needs a command / http
/// needs a url. Never echoes secrets.
fn normalize_raw_config(cfg: &Value) -> Result<Value, AppError> {
    let obj = cfg
        .as_object()
        .ok_or_else(|| AppError::BadRequest("config must be a JSON object".into()))?;
    let transport = obj.get("type").and_then(Value::as_str).unwrap_or("stdio");
    validate_transport(transport)?;
    match transport {
        "stdio" => {
            if obj.get("command").and_then(Value::as_str).unwrap_or("").is_empty() {
                return Err(AppError::BadRequest("stdio MCP requires a 'command'".into()));
            }
        }
        _ => {
            if obj.get("url").and_then(Value::as_str).unwrap_or("").is_empty() {
                return Err(AppError::BadRequest(format!("{transport} MCP requires a 'url'")));
            }
        }
    }
    Ok(cfg.clone())
}

/// Build a server object from the guided-form fields.
fn build_guided_config(body: &AddBody) -> Result<Value, AppError> {
    let transport = body.transport.as_deref().unwrap_or("stdio");
    validate_transport(transport)?;
    let mut obj = Map::new();
    obj.insert("type".into(), Value::String(transport.to_string()));

    match transport {
        "stdio" => {
            let command = body
                .command
                .as_deref()
                .filter(|c| !c.is_empty())
                .ok_or_else(|| AppError::BadRequest("stdio MCP requires a 'command'".into()))?;
            obj.insert("command".into(), Value::String(command.to_string()));
            if let Some(args) = &body.args {
                obj.insert("args".into(), json!(args));
            }
            if let Some(env) = &body.env {
                obj.insert("env".into(), Value::Object(env.clone()));
            }
        }
        _ => {
            let url = body
                .url
                .as_deref()
                .filter(|u| !u.is_empty())
                .ok_or_else(|| AppError::BadRequest(format!("{transport} MCP requires a 'url'")))?;
            obj.insert("url".into(), Value::String(url.to_string()));
            if let Some(headers) = &body.headers {
                obj.insert("headers".into(), Value::Object(headers.clone()));
            }
        }
    }
    Ok(Value::Object(obj))
}

fn validate_transport(t: &str) -> Result<(), AppError> {
    if matches!(t, "stdio" | "http" | "sse") {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!(
            "unknown transport '{t}' (expected stdio|http|sse)"
        )))
    }
}

// ── remove ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ScopeQuery {
    #[serde(default)]
    pub scope: Option<Scope>,
    #[serde(default)]
    pub cwd: Option<String>,
}

/// `DELETE /api/claude/mcp/{name}?scope=&cwd=` — remove a server from its file.
pub async fn remove(
    State(state): State<AppState>,
    AxPath(name): AxPath<String>,
    Query(q): Query<ScopeQuery>,
) -> Result<Json<Value>, AppError> {
    if !valid_mcp_name(&name) {
        return Err(AppError::BadRequest("invalid MCP name".into()));
    }
    let scope = q.scope.unwrap_or(if q.cwd.is_some() {
        Scope::Local
    } else {
        Scope::User
    });

    let removed = match scope {
        Scope::User => remove_in_claude_json(&[], &name).await?,
        Scope::Local => {
            let cwd = require_cwd(&q.cwd)?;
            let key = project_key(&cwd);
            remove_in_claude_json(&["projects", &key], &name).await?
        }
        Scope::Project => {
            let cwd = require_cwd(&q.cwd)?;
            let target = mcp_json_path(&cwd);
            jail_check(&target, &cwd).await?;
            remove_in_mcp_json(&cwd, &name).await?
        }
    };

    if !removed {
        return Err(AppError::NotFound(format!("MCP server '{name}' in {} scope", scope.cli_flag())));
    }
    audit(&state, "mcp.remove", scope.cli_flag(), q.cwd.as_deref(), &name).await;
    Ok(Json(json!({ "ok": true, "name": name, "scope": scope, "restartHint": true })))
}

// ── enable / disable (project trust) ──────────────────────────────────────────

/// `POST /api/claude/mcp/{name}/disable?cwd=` — mark a project `.mcp.json` server
/// as not-trusted in `projects[<cwd>].disabledMcpjsonServers`.
pub async fn disable(
    State(state): State<AppState>,
    AxPath(name): AxPath<String>,
    Query(q): Query<ScopeQuery>,
) -> Result<Json<Value>, AppError> {
    set_enabled(&state, &name, &q, false).await
}

/// `POST /api/claude/mcp/{name}/enable?cwd=` — trust a project `.mcp.json` server.
pub async fn enable(
    State(state): State<AppState>,
    AxPath(name): AxPath<String>,
    Query(q): Query<ScopeQuery>,
) -> Result<Json<Value>, AppError> {
    set_enabled(&state, &name, &q, true).await
}

/// Enable/disable applies to PROJECT (`.mcp.json`) servers only — the trust state
/// lives in `~/.claude.json` → `projects[<cwd>].enabled/disabledMcpjsonServers`.
async fn set_enabled(
    state: &AppState,
    name: &str,
    q: &ScopeQuery,
    enabled: bool,
) -> Result<Json<Value>, AppError> {
    if !valid_mcp_name(name) {
        return Err(AppError::BadRequest("invalid MCP name".into()));
    }
    let cwd = require_cwd(&q.cwd)?;
    let key = project_key(&cwd);

    let path = claude_json_path();
    let mut root = read_json_object(&path).await.map_err(map_config_err)?;
    let proj = ensure_path(&mut root, &["projects", &key]);

    // Move `name` into the right list, removing it from the other.
    let (add_to, remove_from) = if enabled {
        ("enabledMcpjsonServers", "disabledMcpjsonServers")
    } else {
        ("disabledMcpjsonServers", "enabledMcpjsonServers")
    };
    list_remove(proj, remove_from, name);
    list_add(proj, add_to, name);

    write_json_atomic(&path, &root).await.map_err(map_config_err)?;
    audit(
        state,
        if enabled { "mcp.enable" } else { "mcp.disable" },
        "project",
        Some(&cwd),
        name,
    )
    .await;
    Ok(Json(json!({ "ok": true, "name": name, "enabled": enabled, "restartHint": true })))
}

// ── opt-in health check (shells out to `claude mcp`) ──────────────────────────

/// Located once at first use. `None` if the `claude` CLI is not installed.
static CLAUDE_BIN: Lazy<Option<std::path::PathBuf>> = Lazy::new(|| which::which("claude").ok());

/// `POST /api/claude/mcp/{name}/check` — OPT-IN live health probe. Shells out to
/// `claude mcp get <name>` (the one path that does a live connection check),
/// bounded by a timeout. NEVER called on a plain list-read. Returns
/// `{ connected, status, detail }`.
pub async fn check(
    AxPath(name): AxPath<String>,
    Query(q): Query<ScopeQuery>,
) -> Result<Json<Value>, AppError> {
    if !valid_mcp_name(&name) {
        return Err(AppError::BadRequest("invalid MCP name".into()));
    }
    let bin = CLAUDE_BIN
        .as_deref()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("claude CLI not found on PATH")))?;

    // `claude mcp get <name>` does a live probe and prints status; bound it so a
    // hung stdio server can never wedge the request (plan open-risk).
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("mcp").arg("get").arg(&name);
    if let Some(cwd) = q.cwd.as_deref().filter(|s| !s.is_empty()) {
        // Run in the project dir so local/project-scoped servers resolve.
        cmd.current_dir(cwd);
    }
    cmd.stdin(std::process::Stdio::null());

    let run = tokio::time::timeout(Duration::from_secs(15), cmd.output()).await;
    match run {
        Err(_) => Ok(Json(json!({
            "ok": true,
            "connected": false,
            "status": "timeout",
            "detail": "health check timed out after 15s",
        }))),
        Ok(Err(e)) => Err(AppError::Internal(anyhow::anyhow!("spawning claude mcp get: {e}"))),
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let combined = format!("{stdout}{}", String::from_utf8_lossy(&out.stderr));
            let lc = combined.to_lowercase();
            // The CLI prints a "Connected"/"Needs authentication"/"Failed" line.
            let (connected, status) = if lc.contains("✓ connected") || lc.contains("connected") {
                (true, "connected")
            } else if lc.contains("needs authentication") || lc.contains("authenticate") {
                (false, "needs_auth")
            } else if out.status.success() {
                (true, "ok")
            } else {
                (false, "failed")
            };
            // Surface only a short, non-secret status line — never the raw config.
            let detail = combined.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
            Ok(Json(json!({
                "ok": true,
                "connected": connected,
                "status": status,
                "detail": detail,
            })))
        }
    }
}

// ── ~/.claude.json subtree editors (read → merge own subtree → atomic write) ──

/// Upsert `name → server` under `claude.json` at `path` (`[]` = top-level
/// `mcpServers`, `["projects", key]` = that project's `mcpServers`).
async fn upsert_in_claude_json(path: &[&str], name: &str, server: Value) -> Result<(), AppError> {
    let file = claude_json_path();
    let mut root = read_json_object(&file).await.map_err(map_config_err)?;
    let parent = ensure_path(&mut root, path);
    let servers = ensure_object_field(parent, "mcpServers");
    servers.insert(name.to_string(), server);
    write_json_atomic(&file, &root).await.map_err(map_config_err)
}

/// Remove `name` from the `mcpServers` map under `claude.json` at `path`.
/// Returns true if it existed.
async fn remove_in_claude_json(path: &[&str], name: &str) -> Result<bool, AppError> {
    let file = claude_json_path();
    let mut root = read_json_object(&file).await.map_err(map_config_err)?;
    let Some(parent) = get_path_mut(&mut root, path) else {
        return Ok(false);
    };
    let removed = parent
        .as_object_mut()
        .and_then(|o| o.get_mut("mcpServers"))
        .and_then(|m| m.as_object_mut())
        .map(|m| m.remove(name).is_some())
        .unwrap_or(false);
    if removed {
        write_json_atomic(&file, &root).await.map_err(map_config_err)?;
    }
    Ok(removed)
}

// ── <cwd>/.mcp.json editors ───────────────────────────────────────────────────

async fn upsert_in_mcp_json(cwd: &str, name: &str, server: Value) -> Result<(), AppError> {
    let file = mcp_json_path(cwd);
    let mut root = read_json_object(&file).await.map_err(map_config_err)?;
    let servers = ensure_object_field(&mut root, "mcpServers");
    servers.insert(name.to_string(), server);
    write_json_atomic(&file, &root).await.map_err(map_config_err)
}

async fn remove_in_mcp_json(cwd: &str, name: &str) -> Result<bool, AppError> {
    let file = mcp_json_path(cwd);
    let mut root = read_json_object(&file).await.map_err(map_config_err)?;
    let removed = root
        .as_object_mut()
        .and_then(|o| o.get_mut("mcpServers"))
        .and_then(|m| m.as_object_mut())
        .map(|m| m.remove(name).is_some())
        .unwrap_or(false);
    if removed {
        write_json_atomic(&file, &root).await.map_err(map_config_err)?;
    }
    Ok(removed)
}

// ── small JSON-pointer helpers (object-only, create-as-needed) ────────────────

/// Navigate (creating intermediate objects) to the object at `path`, returning a
/// mutable ref to it. The root is assumed to be an object.
fn ensure_path<'a>(root: &'a mut Value, path: &[&str]) -> &'a mut Value {
    let mut cur = root;
    for key in path {
        let obj = cur.as_object_mut().expect("ensure_path on a non-object");
        cur = obj
            .entry((*key).to_string())
            .or_insert_with(|| json!({}));
        if !cur.is_object() {
            *cur = json!({});
        }
    }
    cur
}

/// Like [`ensure_path`] but read-only: `None` if any segment is missing.
fn get_path_mut<'a>(root: &'a mut Value, path: &[&str]) -> Option<&'a mut Value> {
    let mut cur = root;
    for key in path {
        cur = cur.as_object_mut()?.get_mut(*key)?;
    }
    Some(cur)
}

/// Ensure `parent[field]` is an object and return it.
fn ensure_object_field<'a>(parent: &'a mut Value, field: &str) -> &'a mut Map<String, Value> {
    let obj = parent.as_object_mut().expect("ensure_object_field on non-object");
    let slot = obj.entry(field.to_string()).or_insert_with(|| json!({}));
    if !slot.is_object() {
        *slot = json!({});
    }
    slot.as_object_mut().unwrap()
}

/// Add `name` to the string array `parent[field]` (creating it), de-duped.
fn list_add(parent: &mut Value, field: &str, name: &str) {
    let obj = parent.as_object_mut().expect("list_add on non-object");
    let slot = obj.entry(field.to_string()).or_insert_with(|| json!([]));
    if !slot.is_array() {
        *slot = json!([]);
    }
    let arr = slot.as_array_mut().unwrap();
    if !arr.iter().any(|v| v.as_str() == Some(name)) {
        arr.push(Value::String(name.to_string()));
    }
}

/// Remove `name` from the string array `parent[field]` if present.
fn list_remove(parent: &mut Value, field: &str, name: &str) {
    if let Some(arr) = parent
        .as_object_mut()
        .and_then(|o| o.get_mut(field))
        .and_then(|v| v.as_array_mut())
    {
        arr.retain(|v| v.as_str() != Some(name));
    }
}

// ── misc helpers ──────────────────────────────────────────────────────────────

fn require_cwd(cwd: &Option<String>) -> Result<String, AppError> {
    cwd.as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::BadRequest("this scope requires a 'cwd'".into()))
}

/// Claude keys the projects map by the RESOLVED absolute path. Canonicalize when
/// possible (so we hit the same key Claude wrote) and fall back to the raw cwd.
fn project_key(cwd: &str) -> String {
    std::fs::canonicalize(cwd)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| cwd.to_string())
}

/// Confirm a project write target stays inside the session's cwd jail (plan
/// §C.4): canonicalize cwd, then verify `<cwd>/.mcp.json` resolves under it. Uses
/// the shared [`path_safe::resolve_safe`] jail.
async fn jail_check(target: &Path, cwd: &str) -> Result<(), AppError> {
    let cwd_abs = path_safe::resolve_safe(cwd, None).await?;
    // resolve_safe canonicalizes the nearest existing ancestor for a not-yet-
    // existing `.mcp.json`, and rejects anything that escapes the cwd jail.
    path_safe::resolve_safe(&target.to_string_lossy(), Some(&cwd_abs)).await?;
    Ok(())
}

/// Write an audit row. NEVER includes secret values — only the name + scope + dir.
async fn audit(state: &AppState, action: &str, scope: &str, cwd: Option<&str>, name: &str) {
    crate::db::audit::log(
        &state.pool,
        "user",
        action,
        name,
        json!({ "scope": scope, "cwd": cwd }),
    )
    .await
    .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_slug_rejects_traversal_and_meta() {
        assert!(!valid_mcp_name("../x"));
        assert!(!valid_mcp_name("a/b"));
        assert!(!valid_mcp_name("a b"));
        assert!(!valid_mcp_name("a;rm -rf"));
        assert!(!valid_mcp_name("."));
        assert!(!valid_mcp_name(".."));
        assert!(valid_mcp_name("chrome-devtools"));
        assert!(valid_mcp_name("dataforseo_1.0"));
    }

    #[test]
    fn guided_stdio_requires_command() {
        let body = AddBody {
            name: "x".into(),
            scope: None,
            cwd: None,
            transport: Some("stdio".into()),
            command: None,
            args: None,
            env: None,
            url: None,
            headers: None,
            config: None,
            confirm_project_write: false,
        };
        assert!(build_guided_config(&body).is_err());
    }

    #[test]
    fn guided_stdio_builds_full_config() {
        let mut env = Map::new();
        env.insert("API_KEY".into(), json!("secret"));
        let body = AddBody {
            name: "x".into(),
            scope: None,
            cwd: None,
            transport: Some("stdio".into()),
            command: Some("npx".into()),
            args: Some(vec!["pkg@latest".into()]),
            env: Some(env),
            url: None,
            headers: None,
            config: None,
            confirm_project_write: false,
        };
        let cfg = build_guided_config(&body).unwrap();
        assert_eq!(cfg["type"], json!("stdio"));
        assert_eq!(cfg["command"], json!("npx"));
        assert_eq!(cfg["args"], json!(["pkg@latest"]));
        assert_eq!(cfg["env"]["API_KEY"], json!("secret")); // raw IN (write-only)
    }

    #[test]
    fn guided_http_requires_url() {
        let body = AddBody {
            name: "x".into(),
            scope: None,
            cwd: None,
            transport: Some("http".into()),
            command: None,
            args: None,
            env: None,
            url: None,
            headers: None,
            config: None,
            confirm_project_write: false,
        };
        assert!(build_guided_config(&body).is_err());
    }

    #[test]
    fn raw_config_validates_transport_and_command() {
        assert!(normalize_raw_config(&json!({ "type": "stdio", "command": "npx" })).is_ok());
        assert!(normalize_raw_config(&json!({ "type": "stdio" })).is_err()); // no command
        assert!(normalize_raw_config(&json!({ "type": "http", "url": "https://x" })).is_ok());
        assert!(normalize_raw_config(&json!({ "type": "weird", "command": "x" })).is_err());
        assert!(normalize_raw_config(&json!("not an object")).is_err());
    }

    #[test]
    fn ensure_path_creates_nested_objects() {
        let mut root = json!({});
        let leaf = ensure_path(&mut root, &["projects", "/abs/dir"]);
        *leaf = json!({ "mcpServers": {} });
        assert!(root["projects"]["/abs/dir"]["mcpServers"].is_object());
    }

    #[test]
    fn list_add_remove_are_deduped() {
        let mut p = json!({});
        list_add(&mut p, "enabledMcpjsonServers", "a");
        list_add(&mut p, "enabledMcpjsonServers", "a"); // dup ignored
        list_add(&mut p, "enabledMcpjsonServers", "b");
        assert_eq!(p["enabledMcpjsonServers"], json!(["a", "b"]));
        list_remove(&mut p, "enabledMcpjsonServers", "a");
        assert_eq!(p["enabledMcpjsonServers"], json!(["b"]));
    }

    /// `CLAUDE_CONFIG_DIR` is a process-global, so the two tests that set it must
    /// not run concurrently (cargo runs tests multi-threaded by default). This
    /// mutex serializes them; a poisoned lock is fine to recover from here.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    // End-to-end: add → registry-shaped read of the file → remove, against a
    // CLAUDE_CONFIG_DIR temp dir, proving the atomic editors round-trip and that
    // the on-disk env value is RAW (write-only) while the read path masks it.
    #[tokio::test]
    async fn user_scope_add_and_remove_roundtrip() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let dir = std::env::temp_dir().join(format!("supermux-ct-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Point both ~/.claude.json and the config dir at the temp dir.
        std::env::set_var("CLAUDE_CONFIG_DIR", &dir);

        let server = json!({ "type": "stdio", "command": "npx", "env": { "K": "raw-secret" } });
        upsert_in_claude_json(&[], "demo", server).await.unwrap();

        let file = claude_json_path();
        let root = read_json_object(&file).await.unwrap();
        // On disk the secret is RAW (Claude needs it); masking happens on the way out.
        assert_eq!(root["mcpServers"]["demo"]["env"]["K"], json!("raw-secret"));

        let removed = remove_in_claude_json(&[], "demo").await.unwrap();
        assert!(removed);
        let root2 = read_json_object(&file).await.unwrap();
        assert!(root2["mcpServers"].get("demo").is_none());

        std::env::remove_var("CLAUDE_CONFIG_DIR");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn enable_disable_moves_between_lists() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let dir = std::env::temp_dir().join(format!("supermux-ct-en-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", &dir);

        // Use a cwd that exists so project_key canonicalizes deterministically.
        let cwd = dir.to_string_lossy().into_owned();
        let key = project_key(&cwd);

        // disable then enable; assert it lands in the right list each time.
        let path = claude_json_path();
        let mut root = read_json_object(&path).await.unwrap();
        let proj = ensure_path(&mut root, &["projects", &key]);
        list_add(proj, "disabledMcpjsonServers", "srv");
        list_remove(proj, "enabledMcpjsonServers", "srv");
        write_json_atomic(&path, &root).await.unwrap();

        let r = read_json_object(&path).await.unwrap();
        assert_eq!(r["projects"][&key]["disabledMcpjsonServers"], json!(["srv"]));

        std::env::remove_var("CLAUDE_CONFIG_DIR");
        std::fs::remove_dir_all(&dir).ok();
    }
}
