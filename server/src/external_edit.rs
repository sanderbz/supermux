//! "Edit in native editor" — the `$EDITOR` browser bridge + its server endpoints.
//!
//! ## Why this is clean (Claude owns the contract)
//! Claude Code has a built-in `chat:externalEditor` action (Ctrl+G). When
//! triggered it writes its CURRENT in-progress input buffer to a temp `.md` file,
//! spawns `$EDITOR` (/`$VISUAL`) as a CHILD process, BLOCKS until that process
//! exits, then reads the file back and replaces its live buffer with the contents.
//! So supermux never scrapes terminal cells or replays keystrokes: it just points
//! `$EDITOR` at a bridge that lifts the buffer into a browser-native editor sheet
//! and writes the edited text back to the same temp file. Zero model tokens.
//!
//! ## The bridge (`run_bridge`) — a hidden `__edit` subcommand of THIS binary
//! `main.rs` dispatches `argv[1] == "__edit"` here BEFORE starting the server, so
//! the bridge is the exact same version as the server (no separate file to ship /
//! version-skew). Installed as `$EDITOR` via a tiny wrapper script
//! ([`install_bridge_script`]) so a path-with-spaces never shell-splits.
//!
//! Flow, end to end:
//!   1. Claude (Ctrl+G) → writes the buffer to `<tmp>.md` → spawns the bridge with
//!      that path as the last argv.
//!   2. The bridge reads the file + the per-pane env (`SUPERMUX_URL` /
//!      `SUPERMUX_SESSION` / `SUPERMUX_HOOK_TOKEN`, injected by
//!      `sessions::lifecycle`) and POSTs `{session, buffer}` to
//!      `/api/_internal/external-edit/open` (hook-token auth) → `{requestId}`.
//!   3. The open handler stores a [`PendingEdit`] + publishes an `external-edit`
//!      SSE event so the focused browser opens the sheet pre-filled with `buffer`.
//!   4. The bridge long-polls `/api/_internal/external-edit/result` (the server
//!      holds it open until the browser submits, or a server-side timeout).
//!   5. The dashboard's "Done"/"Cancel" hits
//!      `POST /api/sessions/{name}/external-edit/submit` (BEARER auth), which
//!      resolves the pending edit → the long-poll returns `{text}` | `{cancelled}`.
//!   6. On `{text}` the bridge OVERWRITES the temp file + exits 0; on cancel /
//!      timeout / ANY error it leaves the file UNCHANGED + exits 0 (Claude reads
//!      back the original = a no-op). A bridge bug can never corrupt or wedge
//!      Claude's buffer.
//!
//! ## Auth (mirrors `hooks.rs`)
//! `open` + `result` use the per-session `X-Supermux-Hook-Token` (NOT the dashboard
//! bearer — the bridge runs inside the pane, which never holds the bearer),
//! constant-time-compared against `session_runtime.hook_token`. `submit` is a
//! dashboard→server call and rides the bearer like every other `/api/sessions/*`
//! route. Tokens + buffer contents are never logged at info level.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db;
use crate::error::AppError;
use crate::state::{AppState, EditResult, SseEvent};

/// Header the bridge sets to its per-session `$SUPERMUX_HOOK_TOKEN` (same header
/// `hooks.rs` uses — one auth model for every in-pane callback).
const HOOK_TOKEN_HEADER: &str = "X-Supermux-Hook-Token";

/// How long the server holds the `/result` long-poll open before answering
/// `{cancelled:true}` (the user never opened the sheet, or closed the tab). The
/// bridge ALSO bounds its own client request below this so it can never hang
/// forever even if the server is unreachable.
const RESULT_TIMEOUT: Duration = Duration::from_secs(600); // 10 min

/// The bridge's client-side cap on each HTTP call. Comfortably above
/// [`RESULT_TIMEOUT`] so the server's own timeout (which returns a clean
/// `{cancelled}`) wins in the normal case, but bounded so an unreachable /
/// half-open server can never wedge the blocked Claude pane.
const BRIDGE_CLIENT_TIMEOUT: Duration = Duration::from_secs(660); // 11 min

// ════════════════════════════════════════════════════════════════════════════
//  Part 1 — the `$EDITOR` bridge (`supermux __edit <file>`)
// ════════════════════════════════════════════════════════════════════════════

/// Run the `$EDITOR` bridge for the temp file Claude handed us (the `__edit`
/// subcommand). `file` is the LAST argv after `__edit`.
///
/// ROBUSTNESS CONTRACT: this ALWAYS returns `Ok(())` and exits 0. Any failure
/// (missing env, network down, server error, malformed response, write error)
/// leaves the temp file UNCHANGED so Claude reads back the original buffer — a
/// no-op edit. A bridge fault must never corrupt the buffer or wedge the pane.
pub async fn run_bridge(file: Option<String>) -> anyhow::Result<()> {
    if let Err(e) = bridge_inner(file).await {
        // stderr only (the user may see it if they peek), never the buffer text.
        eprintln!("supermux-edit: {e} — leaving the file unchanged");
    }
    Ok(())
}

/// The fallible core of [`run_bridge`]; its `Err` is swallowed by the caller so the
/// process still exits 0 with the temp file untouched.
async fn bridge_inner(file: Option<String>) -> anyhow::Result<()> {
    let path = file.ok_or_else(|| anyhow::anyhow!("no file path argument"))?;
    let buffer = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("reading {path}: {e}"))?;

    let url = env_required("SUPERMUX_URL")?;
    let session = env_required("SUPERMUX_SESSION")?;
    let token = env_required("SUPERMUX_HOOK_TOKEN")?;
    let base = url.trim_end_matches('/');

    // Accept invalid certs for this loopback self-call: `SUPERMUX_URL` may be the
    // https self-signed bind. Safe because this is the server calling its OWN bind —
    // the connection never leaves the host. (Strictly more permissive than the
    // status-hook curl, which does not pass -k; justified here by the loopback.)
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(BRIDGE_CLIENT_TIMEOUT)
        .build()
        .map_err(|e| anyhow::anyhow!("building http client: {e}"))?;

    // 1. Open: hand the server the current buffer; get back a request id.
    let open: OpenResponse = client
        .post(format!("{base}/api/_internal/external-edit/open"))
        .header(HOOK_TOKEN_HEADER, &token)
        .json(&json!({ "session": session, "buffer": buffer }))
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("open request: {e}"))?
        .error_for_status()
        .map_err(|e| anyhow::anyhow!("open status: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("open response: {e}"))?;

    // 2. Long-poll for the result (server holds it open until submit / timeout).
    let result: ResultResponse = client
        .get(format!("{base}/api/_internal/external-edit/result"))
        .query(&[("session", session.as_str()), ("requestId", open.request_id.as_str())])
        .header(HOOK_TOKEN_HEADER, &token)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("result request: {e}"))?
        .error_for_status()
        .map_err(|e| anyhow::anyhow!("result status: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("result response: {e}"))?;

    // 3. On saved text, overwrite the temp file (Claude reads it back as the new
    //    buffer). On cancel/timeout, leave it UNCHANGED → Claude's buffer is the
    //    original (a no-op). NEVER write on a cancel.
    if !result.cancelled {
        if let Some(text) = result.text {
            std::fs::write(&path, text)
                .map_err(|e| anyhow::anyhow!("writing {path}: {e}"))?;
        }
    }
    Ok(())
}

/// Read an env var, erroring if it's missing/empty. The bridge needs all three of
/// `SUPERMUX_URL`/`SUPERMUX_SESSION`/`SUPERMUX_HOOK_TOKEN` (injected per-pane by
/// `sessions::lifecycle`); a missing one means this isn't a supermux pane → no-op.
fn env_required(key: &str) -> anyhow::Result<String> {
    std::env::var(key)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("{key} is not set"))
}

#[derive(Deserialize)]
struct OpenResponse {
    #[serde(rename = "requestId")]
    request_id: String,
}

#[derive(Deserialize)]
struct ResultResponse {
    /// The edited buffer text (present on a save).
    #[serde(default)]
    text: Option<String>,
    /// True when the user dismissed the sheet or the long-poll timed out.
    #[serde(default)]
    cancelled: bool,
}

// ── bridge-script installer ───────────────────────────────────────────────────

/// Write (idempotently) the `<data_dir>/bin/supermux-edit` wrapper that
/// `sessions::lifecycle` exports as `$EDITOR`/`$VISUAL`, and return its path.
///
/// The wrapper `exec`s the CURRENTLY-RUNNING binary with the `__edit` subcommand
/// so the bridge is always version-matched to the server (no separate artifact).
/// A wrapper SCRIPT (rather than `$EDITOR="<binary> __edit"`) avoids any shell
/// word-splitting ambiguity when the binary path contains spaces. Best-effort:
/// returns the intended path even if the write fails (the launch command still
/// points at it; the next start retries) — but logs a warning.
pub fn install_bridge_script(data_dir: &Path) -> PathBuf {
    let bin_dir = data_dir.join("bin");
    let script = bin_dir.join("supermux-edit");

    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        // Fallback to the bare name on PATH if current_exe somehow fails (it
        // effectively never does on Linux); the bridge still resolves at run time.
        .unwrap_or_else(|_| "supermux-server".to_string());

    // `exec` so the wrapper does not linger as an extra process while Claude
    // blocks on its child; `"$@"` forwards Claude's temp-file path verbatim.
    let contents = format!("#!/bin/sh\nexec \"{exe}\" __edit \"$@\"\n");

    if let Err(e) = write_executable(&bin_dir, &script, &contents) {
        tracing::warn!(
            path = %script.display(),
            error = %e,
            "could not install the external-edit bridge script — edit-in-native-editor may be unavailable until the next start",
        );
    }
    script
}

/// Create `dir`, write `path` with `contents`, and chmod it 0o755. Idempotent: a
/// re-write of identical contents is harmless. Skips the write when the file is
/// already byte-identical so a hot loop never churns the inode.
fn write_executable(dir: &Path, path: &Path, contents: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let up_to_date = std::fs::read_to_string(path)
        .map(|cur| cur == contents)
        .unwrap_or(false);
    if !up_to_date {
        std::fs::write(path, contents)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

// ════════════════════════════════════════════════════════════════════════════
//  Part 2 — the server endpoints
// ════════════════════════════════════════════════════════════════════════════

/// The hook-token-authed sub-router (`open` + `result`). Merged at the top level
/// of `http::router` ALONGSIDE `hooks::router_for` — NO bearer layer (auth is the
/// per-session hook token, validated in the handlers).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/_internal/external-edit/open", post(open_handler))
        .route("/api/_internal/external-edit/result", get(result_handler))
        .with_state(state)
}

/// Constant-time validation of the per-session hook token (mirrors `hooks.rs`).
/// A missing session row OR a mismatched/empty token → 401 (no existence oracle,
/// no timing oracle). The DB row is the source of truth (survives restart).
async fn validate_hook_token(
    state: &AppState,
    session: &str,
    headers: &HeaderMap,
) -> Result<(), AppError> {
    let expected = db::sessions::runtime(&state.pool, session)
        .await?
        .map(|rt| rt.hook_token)
        .ok_or(AppError::Unauthorized)?;
    let presented = headers
        .get(HOOK_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if expected.is_empty()
        || !constant_time_eq::constant_time_eq(expected.as_bytes(), presented.as_bytes())
    {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

#[derive(Deserialize)]
struct OpenBody {
    /// The supermux session name (`$SUPERMUX_SESSION`); scopes the token check.
    session: String,
    /// Claude's current in-progress input buffer (may be empty — Ctrl+G with
    /// nothing typed opens an empty sheet = compose-fresh).
    #[serde(default)]
    buffer: String,
}

/// `POST /api/_internal/external-edit/open` (hook-token auth). The bridge calls
/// this with the current buffer; we mint a request id, register the pending edit,
/// publish the `external-edit` SSE event (so the focused browser opens the sheet),
/// and return `{requestId}`. The bridge then long-polls `/result`.
async fn open_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<OpenBody>,
) -> Result<Json<Value>, AppError> {
    validate_hook_token(&state, &body.session, &headers).await?;

    let request_id = uuid::Uuid::new_v4().to_string();

    // If no dashboard is connected to the SSE stream, nobody can open the editor
    // sheet — so DON'T register the edit. The bridge's immediate `/result` long-poll
    // then finds no slot and returns `{cancelled}` at once, so Claude's Ctrl+G
    // unblocks instantly instead of blocking on the child `$EDITOR` until the
    // RESULT_TIMEOUT. (A connected-but-not-focused client is the residual case the
    // generous timeout still backstops.)
    if state.sse_tx.receiver_count() == 0 {
        return Ok(Json(json!({ "requestId": request_id })));
    }

    // Register BEFORE we emit the SSE. This resolves+supersedes any prior in-flight
    // edit for the session (one per session — Claude is blocked while editing). The
    // registry holds BOTH channel halves, so a `submit` that races the bridge's
    // `/result` long-poll still finds the sender; `/result` takes the receiver.
    state.register_edit(&body.session, request_id.clone());

    // Tell the focused browser to open the editor sheet pre-filled with the buffer.
    // The buffer rides the SSE payload (the dashboard origin is already trusted —
    // bearer-gated `/api/events`); we deliberately do NOT log it.
    let _ = state.sse_tx.send(SseEvent {
        event: "external-edit".to_string(),
        payload: json!({
            "session": body.session,
            "requestId": request_id,
            "buffer": body.buffer,
        }),
    });

    Ok(Json(json!({ "requestId": request_id })))
}

#[derive(Deserialize)]
struct ResultQuery {
    session: String,
    #[serde(rename = "requestId")]
    request_id: String,
}

/// `GET /api/_internal/external-edit/result` (hook-token auth). The long-poll: the
/// bridge waits here until the dashboard submits (resolving the pending edit's
/// oneshot) or the server-side [`RESULT_TIMEOUT`] elapses. Returns `{text}` on a
/// save or `{cancelled:true}` on a cancel/timeout/superseded edit.
async fn result_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ResultQuery>,
) -> Result<Json<Value>, AppError> {
    validate_hook_token(&state, &q.session, &headers).await?;

    // Take THIS edit's receiver to await. The open handler registered the slot with
    // both halves; we take the receiver (the sender stays in the registry for a
    // pending `submit` to resolve). A no/stale slot means the edit was already
    // resolved, superseded, or never opened → a no-op (leave the file unchanged).
    let rx = match state.take_edit_receiver(&q.session, &q.request_id) {
        Some(rx) => rx,
        None => return Ok(Json(json!({ "cancelled": true }))),
    };

    match tokio::time::timeout(RESULT_TIMEOUT, rx).await {
        // Saved text → write-back.
        Ok(Ok(EditResult::Text(text))) => Ok(Json(json!({ "text": text }))),
        // Cancelled, or the sender was dropped (session forgotten) → no-op.
        Ok(Ok(EditResult::Cancelled)) | Ok(Err(_)) => {
            Ok(Json(json!({ "cancelled": true })))
        }
        // Server-side timeout: clear the slot (if still ours) and no-op.
        Err(_) => {
            state.clear_edit_if(&q.session, &q.request_id);
            Ok(Json(json!({ "cancelled": true })))
        }
    }
}

// ── the dashboard-side submit (bearer auth) ───────────────────────────────────

#[derive(Deserialize)]
pub struct SubmitBody {
    #[serde(rename = "requestId")]
    pub request_id: String,
    /// The edited text (present on "Done"/"Save").
    #[serde(default)]
    pub text: Option<String>,
    /// True when the user dismissed the sheet (Cancel / tap-away).
    #[serde(default)]
    pub cancelled: bool,
}

/// `POST /api/sessions/{name}/external-edit/submit` (BEARER auth — a dashboard→
/// server call, merged into the protected router by `sessions::router_for`).
/// Resolves the session's in-flight edit IFF `request_id` matches: sends
/// `Text(text)` or `Cancelled` on the pending oneshot (waking the bridge's
/// `/result` long-poll). A stale/missing `request_id` (the edit already resolved,
/// timed out, or was superseded) returns 409 — the dashboard can drop the sheet.
pub async fn submit(state: &AppState, name: &str, body: SubmitBody) -> Result<(), AppError> {
    let result = if body.cancelled {
        EditResult::Cancelled
    } else {
        // No text + not cancelled is treated as an empty save (write back ""):
        // an empty buffer is a legitimate edit (the user cleared the prompt).
        EditResult::Text(body.text.unwrap_or_default())
    };
    if state.resolve_edit(name, &body.request_id, result) {
        Ok(())
    } else {
        Err(AppError::Conflict(
            "no matching in-flight edit (already resolved or expired)".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_script_is_executable_and_idempotent() {
        let dir = std::env::temp_dir()
            .join(format!("supermux-bridge-test-{}", uuid::Uuid::new_v4()));
        let script = install_bridge_script(&dir);

        // The script exists, is under <data_dir>/bin, and exec's the `__edit`
        // subcommand of some binary with the forwarded args.
        let body = std::fs::read_to_string(&script).expect("script written");
        assert!(body.starts_with("#!/bin/sh\n"), "must be a /bin/sh script");
        assert!(body.contains("__edit \"$@\""), "must forward to the __edit subcommand");
        assert!(script.ends_with(PathBuf::from("bin/supermux-edit")));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&script).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755, "must be chmod 0o755");
        }

        // Idempotent: re-installing the SAME contents is a no-op (no error).
        let again = install_bridge_script(&dir);
        assert_eq!(again, script);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn env_required_rejects_missing_and_blank() {
        // A unique key that is definitely unset.
        let key = format!("SUPERMUX_EDIT_TEST_{}", uuid::Uuid::new_v4().simple());
        assert!(env_required(&key).is_err(), "unset → err");

        std::env::set_var(&key, "   ");
        assert!(env_required(&key).is_err(), "blank → err");

        std::env::set_var(&key, "https://127.0.0.1:8823");
        assert_eq!(env_required(&key).unwrap(), "https://127.0.0.1:8823");
        std::env::remove_var(&key);
    }

    #[test]
    fn result_response_parses_both_shapes() {
        let text: ResultResponse = serde_json::from_str(r#"{"text":"hi"}"#).unwrap();
        assert_eq!(text.text.as_deref(), Some("hi"));
        assert!(!text.cancelled);

        let cancelled: ResultResponse = serde_json::from_str(r#"{"cancelled":true}"#).unwrap();
        assert!(cancelled.cancelled);
        assert!(cancelled.text.is_none());
    }
}
