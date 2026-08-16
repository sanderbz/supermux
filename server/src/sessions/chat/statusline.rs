//! Opt-in Claude **statusline tap** — wrap-don't-clobber, with an exact uninstall.
//!
//! Claude Code renders one global status line by running a shell command per
//! turn and printing its first stdout line above the composer. That command is a
//! SINGLE object slot (`statusLine: {type:"command", command, padding}`) — no
//! array, no chaining — so "installing a tap" can only mean *wrapping* whatever
//! command the user already had. Clobbering it is not an option, and neither is
//! guessing on the way back out.
//!
//! **Opt-in is a property of the build, not a promise.** Three independent
//! gates, in order:
//!   1. [`crate::config::Config::statusline_tap`] defaults to `false`; the
//!      install endpoint 403s until an operator sets it in `config.toml`.
//!   2. Installing happens ONLY through `POST /api/claude/statusline/install`.
//!      Nothing in the session create/start path reaches this module — pinned by
//!      `tests/statusline_optin.rs`, which boots create+start against a
//!      throwaway `CLAUDE_CONFIG_DIR` and asserts the settings file never grows
//!      a `statusLine` key.
//!   3. `DELETE /api/claude/statusline` is ALWAYS allowed, gate or no gate — you
//!      can always take our wrapper back out.
//!
//! **The wrap contract.**
//!   * Recognize only `type == "command"`; anything else is a hard refusal, never
//!     an overwrite (a future Claude statusline kind must survive us).
//!   * Mutate only `command`. `padding` and every unknown key ride through
//!     verbatim, as do all sibling top-level settings.
//!   * The wrapper tees stdin to the supermux tap, pipes the SAME stdin to the
//!     original, and passes the original's stdout AND its exit code through
//!     untouched (a nonzero exit hides the line — the tap must not change that).
//!   * The original command is recorded TWICE — marker-delimited inside the
//!     wrapper string, and in the `supermux-statusline.json` sidecar — so an
//!     uninstall never has to reconstruct anything.
//!
//! **Live findings this module is built on** (probed on THIS host against Claude
//! Code 2.1.232, Task 6 Step 1, throwaway `CLAUDE_CONFIG_DIR`):
//!   * A `statusLine` command that prints nothing and exits 0 costs **no blank
//!     row** and does not shift the composer — the captured pane is identical to
//!     a no-`statusLine` control. That is what makes [`Mode::TapOnly`] safe on a
//!     host (like this one) that has no status line of its own.
//!   * The statusline command inherits the pane env exactly: `$SUPERMUX_SESSION`,
//!     `$SUPERMUX_HOOK_TOKEN` and `$SUPERMUX_URL` all arrive with the values the
//!     pane was started with, so the tap authenticates the same way the hooks do.
//!   * The payload on stdin carries `model` as an **object** (`{id,
//!     display_name}`), a `context_window.used_percentage` that is **`null`**
//!     while the window is idle (not an int), no `rate_limits` at all on a fresh
//!     boot, and **no `permission_mode`** — mode comes from hook payloads, never
//!     from here. The tap is per-turn and event-driven; it is **never** a
//!     liveness signal.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::AppError;
use crate::files::transport::LocalFileTransport;
use crate::state::AppState;

/// Identifiability marker carried by every command this module writes. Its
/// presence is how a re-install finds the entry it owns; its position (first
/// token) is how an uninstall knows we are still the OUTERMOST wrapper.
pub const MARKER: &str = "supermux-statusline";

/// Opens the brace group holding the user's original command. Chosen so the
/// original can contain anything at all — `&`, quotes, newlines, its own braces
/// — because it is delimited by a sentinel + the string's own final `\n}`,
/// never by shell-significant punctuation we would have to escape.
const ORIG_SENTINEL: &str = "{ : supermux-statusline-orig\n";

/// Tail of a [`Mode::TapOnly`] command. Used only to recognise "there was no
/// original" when the sidecar is gone — never to parse anything.
const TAP_ONLY_TAIL: &str = "& exit 0";

/// Sidecar file name (in Claude's config dir) holding the pre-install
/// `statusLine` value verbatim.
const SIDECAR_FILE: &str = "supermux-statusline.json";

/// How to install the tap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Wrap the user's existing status line. REFUSES when there is none — we
    /// never silently invent a status line for a host that had none.
    Wrap,
    /// Tap only: consume the payload, print nothing, exit 0. Only legal when
    /// there is no original to drop. Safe because an empty stdout costs no row
    /// (live-verified, see the module docs).
    TapOnly,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Wrap => "wrap",
            Mode::TapOnly => "tap_only",
        }
    }
}

// ── the generated commands ───────────────────────────────────────────────────

/// The tap half, shared by both modes: slurp stdin, then POST it in the
/// BACKGROUND with a hard 1 s bound.
///
/// The 16 KB `head -c` (the same clip the hook pipe uses, so both live layers
/// truncate identically) applies to what we POST — **not** to what the wrapped
/// original receives. Capping the buffer itself would hand the user's own
/// status line a byte-truncated, therefore invalid, JSON document the moment
/// Claude's payload outgrew 16 KB, and the wrapper's whole contract is that the
/// original sees the same stdin it would have seen without us. Every fd of the curl is
/// redirected away from the wrapper's own stdout: Claude reads that stdout to
/// the pipe's EOF, so a lingering background writer would hold the status line
/// open. Nothing here can print, and nothing here can fail the command.
fn tap_prelude() -> String {
    format!(
        ": {MARKER}; D=$(head -c 1048576); \
         [ -n \"$SUPERMUX_SESSION\" ] && printf '%s' \"$D\" | head -c 16384 | \
         curl -fsS -o /dev/null --max-time 1 -X POST \
         -H \"Content-Type: application/json\" \
         -H \"X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN\" \
         \"$SUPERMUX_URL/api/_internal/statusline?session=$SUPERMUX_SESSION\" \
         --data-binary @- >/dev/null 2>&1 "
    )
}

/// Wrap `original`: tap, then feed the SAME payload to the original inside a
/// brace group whose closing `\n}` is the last thing in the string. The group's
/// exit status is the original's, and it is the wrapper's last command, so the
/// original's exit code is the wrapper's exit code with no `exit $?` needed.
pub fn wrap_command(original: &str) -> String {
    format!(
        "{}& printf '%s' \"$D\" | {ORIG_SENTINEL}{original}\n}}",
        tap_prelude()
    )
}

/// Tap without an original: consume, post, print nothing, exit 0.
pub fn tap_only_command() -> String {
    format!("{}{TAP_ONLY_TAIL}", tap_prelude())
}

/// Is `cmd` a supermux wrapper AND still the outermost one? Only then may we
/// unwrap it — if someone else wrapped US, their command is the truth.
fn is_ours(cmd: &str) -> bool {
    cmd.starts_with(&format!(": {MARKER};"))
}

/// The original command embedded in one of OUR wrappers, exactly as written.
/// `None` for a tap-only wrapper (there was no original) or a hand-mangled one.
fn embedded_original(cmd: &str) -> Option<&str> {
    let start = cmd.find(ORIG_SENTINEL)? + ORIG_SENTINEL.len();
    // Our own closing brace is by construction the LAST thing in the string, so
    // an original that itself ends in "\n}" cannot confuse this.
    let end = cmd.len().checked_sub(2)?;
    if !cmd.ends_with("\n}") || end < start {
        return None;
    }
    Some(&cmd[start..end])
}

// ── the pure install / uninstall core (unit-tested; no I/O) ──────────────────

/// Return `settings` with supermux's statusline tap installed.
///
/// Pure: takes and returns a parsed settings value, so every branch is testable
/// without touching a real `~/.claude/settings.json`. Errors are refusals — on
/// any error the caller writes nothing at all.
pub fn install(settings: &Value, mode: Mode) -> Result<Value> {
    let obj = settings
        .as_object()
        .context("settings root is not a JSON object")?;

    // What is there now, unwrapped down to the user's own command (if any).
    let original: Option<String> = match obj.get("statusLine") {
        None => None,
        Some(v) => {
            let o = v
                .as_object()
                .ok_or_else(|| anyhow!("`statusLine` is not an object — refusing to overwrite it"))?;
            match o.get("type").and_then(Value::as_str) {
                Some("command") => {}
                other => bail!(
                    "`statusLine.type` is {other:?}, not \"command\" — refusing to overwrite a \
                     statusline shape supermux does not understand"
                ),
            }
            // `type` alone is not enough to prove we understand the slot. A
            // `command` that is not a string (an argv array, an object, or
            // simply absent) used to read as `""` — "the user had nothing" —
            // and got overwritten by the wrapper, with the uninstall then
            // restoring that `""`. Refuse, exactly like an unknown `type`.
            let cmd = match o.get("command") {
                Some(Value::String(s)) => s.as_str(),
                other => bail!(
                    "`statusLine.command` is {other:?}, not a string — refusing to overwrite a \
                     statusline shape supermux does not understand"
                ),
            };
            if is_ours(cmd) {
                embedded_original(cmd).map(str::to_string)
            } else if cmd.contains(MARKER) {
                bail!(
                    "`statusLine.command` carries the supermux marker but another tool is now the \
                     outermost wrapper — refusing to touch it"
                );
            } else {
                Some(cmd.to_string())
            }
        }
    };

    let mut out = settings.clone();
    let root = out.as_object_mut().expect("checked above");
    match (mode, original) {
        (Mode::Wrap, Some(orig)) => {
            root["statusLine"]["command"] = json!(wrap_command(&orig));
        }
        (Mode::Wrap, None) => bail!(
            "wrap mode needs an existing `statusLine` command to wrap; this host has none. \
             Use mode=tap_only to install a print-nothing tap instead."
        ),
        (Mode::TapOnly, None) => {
            let cmd = json!(tap_only_command());
            match root.get_mut("statusLine") {
                // Idempotent re-install over our own tap-only wrapper.
                Some(sl) => sl["command"] = cmd,
                None => {
                    root.insert("statusLine".into(), json!({"type":"command","command":cmd}));
                }
            }
        }
        (Mode::TapOnly, Some(_)) => bail!(
            "tap_only would drop the existing `statusLine` command; use mode=wrap to keep it"
        ),
    }
    Ok(out)
}

/// Remove supermux's tap using only what the settings value itself carries.
pub fn uninstall(settings: &Value) -> Result<Value> {
    uninstall_with(settings, None)
}

/// Remove supermux's tap, falling back to the `sidecar` (as written by
/// [`sidecar_for`]) when the wrapper's embedded original is gone.
///
/// Every "not ours" case is a NO-OP that returns the settings unchanged — a
/// foreign status line, or one where another tool has become the outermost
/// wrapper, is never restored over.
pub fn uninstall_with(settings: &Value, sidecar: Option<&Value>) -> Result<Value> {
    let obj = settings
        .as_object()
        .context("settings root is not a JSON object")?;
    let Some(sl) = obj.get("statusLine") else {
        return Ok(settings.clone()); // nothing installed
    };
    let Some(slo) = sl.as_object() else {
        return Ok(settings.clone()); // not a shape we wrote
    };
    let cmd = slo.get("command").and_then(Value::as_str).unwrap_or("");
    if !cmd.contains(MARKER) || !is_ours(cmd) {
        // Foreign, or ours-but-no-longer-outermost: leave it exactly alone.
        return Ok(settings.clone());
    }

    let mut out = settings.clone();
    let root = out.as_object_mut().expect("checked above");
    if let Some(orig) = embedded_original(cmd) {
        root["statusLine"]["command"] = json!(orig);
        return Ok(out);
    }
    if let Some(sc) = sidecar {
        match sc.get("original") {
            Some(v) if !v.is_null() => {
                root.insert("statusLine".into(), v.clone());
            }
            _ => {
                root.remove("statusLine");
            }
        }
        return Ok(out);
    }
    if cmd.ends_with(TAP_ONLY_TAIL) {
        // We invented the whole slot; removing it restores the pre-install state.
        root.remove("statusLine");
        return Ok(out);
    }
    bail!(
        "the supermux wrapper has lost its embedded original and no {SIDECAR_FILE} sidecar is \
         present — refusing to guess what the original `statusLine` command was"
    )
}

/// The sidecar to write alongside an install: the pre-install `statusLine`
/// value, verbatim, so an uninstall can restore it even if the wrapper string is
/// later hand-edited. Records `null` when there was nothing to preserve.
pub fn sidecar_for(settings_before: &Value, mode: Mode) -> Value {
    // If we are re-installing over ourselves, the ORIGINAL is what our current
    // wrapper carries, never the wrapper itself.
    let original = match settings_before.get("statusLine") {
        Some(sl) => {
            let cmd = sl.get("command").and_then(Value::as_str).unwrap_or("");
            if is_ours(cmd) {
                match embedded_original(cmd) {
                    Some(orig) => {
                        let mut restored = sl.clone();
                        restored["command"] = json!(orig);
                        restored
                    }
                    None => Value::Null,
                }
            } else {
                sl.clone()
            }
        }
        None => Value::Null,
    };
    json!({
        "marker": MARKER,
        "mode": mode.as_str(),
        "installed_at_ms": chrono::Utc::now().timestamp_millis(),
        "original": original,
    })
}

// ── file-level install/uninstall (local host only) ───────────────────────────

/// Path of the sidecar next to the settings file.
fn sidecar_path(settings_path: &Path) -> PathBuf {
    settings_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(SIDECAR_FILE)
}

/// Install the tap into the LOCAL `~/.claude/settings.json` (honouring
/// `$CLAUDE_CONFIG_DIR`). Writes the sidecar FIRST — if the settings write then
/// fails we have a recoverable extra file, whereas the reverse order could leave
/// a wrapper with no recorded original. Atomic-rename via the same transport
/// core [`crate::claude_config`] uses.
pub async fn install_local(mode: Mode) -> Result<PathBuf> {
    let t = LocalFileTransport;
    let path = crate::claude_config::local_settings_path();
    // Same per-path lock the hook installer holds. `install_hooks` runs on every
    // session start from independent tasks (HTTP start, scheduler, board
    // dispatch, teams); this is a read→modify→write of the SAME file, so
    // without the shared lock an overlapping install drops one of the two
    // merges — the user's `statusLine` or supermux's hooks.
    let lock = crate::claude_config::settings_write_lock(&path);
    let _guard = lock.lock().await;
    let before = crate::claude_config::read_settings_or_empty(&t, &path).await?;
    let after = install(&before, mode)?;
    let sidecar = sidecar_for(&before, mode);
    crate::claude_config::atomic_write_json(&t, &sidecar_path(&path), &sidecar).await?;
    crate::claude_config::atomic_write_json(&t, &path, &after).await?;
    Ok(path)
}

/// Does this settings value still carry a command bearing our [`MARKER`] —
/// anywhere in it, outermost or not? This is "is the tap still live", NOT "is it
/// ours to remove": a foreign command that wrapped ours still runs our POST
/// every turn, so it still counts as installed.
fn marker_present(settings: &Value) -> bool {
    settings
        .get("statusLine")
        .and_then(|sl| sl.get("command"))
        .and_then(Value::as_str)
        .is_some_and(|c| c.contains(MARKER))
}

/// What a file-level uninstall actually did.
///
/// `changed` and `still_installed` are independent on purpose: [`uninstall_with`]
/// is a deliberate NO-OP when another tool has become the outermost wrapper of
/// ours, and that case is `changed: false, still_installed: true` — the caller
/// must not report it as a successful removal.
#[derive(Debug, Clone)]
pub struct UninstallOutcome {
    pub path: PathBuf,
    /// Did we write a new settings file?
    pub changed: bool,
    /// Is a command carrying our marker STILL in the settings file afterwards?
    pub still_installed: bool,
}

/// Remove the tap from the LOCAL settings file, consulting the sidecar when the
/// wrapper's embedded original is missing.
///
/// Two things are conditional on having actually removed something, because
/// [`uninstall_with`] no-ops rather than clobbering a wrapper we are not the
/// outermost of:
///   * the settings file is written only when the value CHANGED — a no-op must
///     not renormalize the key order and formatting of a file we did not touch;
///   * the sidecar is deleted only once our marker is provably gone from the
///     settings. It is the last surviving copy of the user's own command, and
///     the case that needs it most is exactly the case where our wrapper is
///     still buried inside somebody else's.
pub async fn uninstall_local() -> Result<UninstallOutcome> {
    let t = LocalFileTransport;
    let path = crate::claude_config::local_settings_path();
    // See `install_local`: the same shared per-path lock, for the same reason.
    let lock = crate::claude_config::settings_write_lock(&path);
    let _guard = lock.lock().await;
    let before = crate::claude_config::read_settings_or_empty(&t, &path).await?;
    let sc_path = sidecar_path(&path);
    let sidecar = tokio::fs::read_to_string(&sc_path)
        .await
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let after = uninstall_with(&before, sidecar.as_ref())?;
    let changed = after != before;
    if changed {
        crate::claude_config::atomic_write_json(&t, &path, &after).await?;
    }
    let still_installed = marker_present(&after);
    if !still_installed {
        let _ = tokio::fs::remove_file(&sc_path).await;
    }
    Ok(UninstallOutcome {
        path,
        changed,
        still_installed,
    })
}

// ── the ingest snapshot ──────────────────────────────────────────────────────

/// One session's latest statusline payload, in memory only (never persisted —
/// same rule as the hook payloads).
///
/// Every field is optional because the payload legitimately varies by version
/// and by lifecycle point: `used_percentage` is `null` on an idle window,
/// `rate_limits` is absent on a fresh boot, and `permission_mode` does not exist
/// in this payload at all (live-verified on 2.1.232 — mode comes from the hooks).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Statusline {
    pub model_id: Option<String>,
    pub model_display: Option<String>,
    pub version: Option<String>,
    /// `context_window.used_percentage`. `None` means "not reported", which is
    /// NOT the same as 0 % — the idle window reports `null`.
    pub context_pct: Option<f64>,
    pub cost_usd: Option<f64>,
    pub exceeds_200k: bool,
    /// `rate_limits`, carried opaquely: its internals drift across versions and
    /// nothing server-side reads into them.
    pub rate_limits: Option<Value>,
    /// Server-clock ms — the ONLY clock domain the UI compares in. The payload
    /// has no timestamp of its own, and this is a per-turn event, never a
    /// liveness signal.
    pub at_ms: i64,
}

impl Statusline {
    /// Parse one statusline payload leniently. `None` only when the payload is
    /// not a JSON object at all (a clipped/alien body is a no-op, never a panic).
    pub fn from_payload(raw: &Value) -> Option<Self> {
        let o = raw.as_object()?;
        let model = o.get("model");
        let sub = |parent: &str, key: &str| -> Option<f64> {
            o.get(parent)?.get(key)?.as_f64()
        };
        Some(Self {
            model_id: model
                .and_then(|m| m.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string),
            model_display: model
                .and_then(|m| m.get("display_name"))
                .and_then(Value::as_str)
                .map(str::to_string),
            version: o.get("version").and_then(Value::as_str).map(str::to_string),
            context_pct: sub("context_window", "used_percentage"),
            cost_usd: sub("cost", "total_cost_usd"),
            exceeds_200k: o
                .get("exceeds_200k_tokens")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            rate_limits: o.get("rate_limits").filter(|v| !v.is_null()).cloned(),
            at_ms: chrono::Utc::now().timestamp_millis(),
        })
    }

    /// Does this differ from `other` in any field a client renders? `at_ms` is
    /// excluded on purpose: the tap fires every turn, and re-broadcasting an
    /// identical line to every connected client would be a fan-out storm for a
    /// stamp nobody shows.
    pub fn differs_from(&self, other: &Self) -> bool {
        self.model_id != other.model_id
            || self.model_display != other.model_display
            || self.version != other.version
            || self.context_pct != other.context_pct
            || self.cost_usd != other.cost_usd
            || self.exceeds_200k != other.exceeds_200k
            || self.rate_limits != other.rate_limits
    }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct InstallQuery {
    /// `wrap` (default) or `tap_only`.
    #[serde(default)]
    mode: Option<Mode>,
}

/// `POST /api/claude/statusline/install?mode=wrap|tap_only` (bearer-protected).
///
/// The ONLY route that can write a `statusLine` key. Gated on
/// `config.statusline_tap` so the capability is off until an operator turns it
/// on for the host.
pub async fn install_handler(
    State(state): State<AppState>,
    Query(q): Query<InstallQuery>,
) -> Result<axum::Json<Value>, AppError> {
    if !state.config.statusline_tap {
        return Err(AppError::Forbidden(
            "the statusline tap is disabled on this host; set `statusline_tap = true` in \
             config.toml to allow installing it"
                .into(),
        ));
    }
    let mode = q.mode.unwrap_or(Mode::Wrap);
    let path = install_local(mode)
        .await
        .map_err(|e| AppError::BadRequest(format!("statusline install: {e:#}")))?;
    Ok(axum::Json(json!({
        "ok": true,
        "data": { "installed": true, "mode": mode.as_str(), "settings_path": path.display().to_string() }
    })))
}

/// `DELETE /api/claude/statusline` (bearer-protected). Deliberately NOT gated on
/// `statusline_tap`: removing our wrapper must stay possible after the flag is
/// turned back off.
///
/// `installed` is the state AFTER the call, not an assumption: when another tool
/// has become the outermost wrapper of ours we leave their command exactly alone
/// (see [`uninstall_with`]) and the tap is therefore still live. Saying
/// `installed: false` there would be a lie an operator acts on, so that case
/// answers `installed: true, changed: false` with the reason.
pub async fn uninstall_handler(
    State(_state): State<AppState>,
) -> Result<axum::Json<Value>, AppError> {
    let out = uninstall_local()
        .await
        .map_err(|e| AppError::BadRequest(format!("statusline uninstall: {e:#}")))?;
    let mut data = json!({
        "installed": out.still_installed,
        "changed": out.changed,
        "settings_path": out.path.display().to_string(),
    });
    if out.still_installed {
        data["detail"] = json!(
            "another tool is now the outermost `statusLine` wrapper, so supermux's tap was left \
             in place rather than clobbering their command — unwrap it there first"
        );
    }
    Ok(axum::Json(json!({ "ok": true, "data": data })))
}

#[derive(Debug, Deserialize)]
pub struct IngestQuery {
    session: String,
}

/// `POST /api/_internal/statusline?session=<name>` — the tap's inbound side.
///
/// Auth is the per-session `X-Supermux-Hook-Token`, exactly like
/// `/api/_internal/hook` (the statusline command runs inside the pane and never
/// holds the dashboard bearer). Body is the raw Claude payload, parsed
/// LENIENTLY: the `head -c 16384` cap can clip it mid-JSON and a clipped body
/// must be a no-op, never a 400 that shows up as a broken status line.
pub async fn ingest_handler(
    State(state): State<AppState>,
    Query(q): Query<IngestQuery>,
    headers: HeaderMap,
    raw: axum::body::Bytes,
) -> Result<axum::Json<Value>, AppError> {
    crate::hooks::verify_hook_token(&state, &q.session, &headers).await?;
    if let Some(next) = serde_json::from_slice::<Value>(&raw)
        .ok()
        .as_ref()
        .and_then(Statusline::from_payload)
    {
        // Change-gated: an unchanged line (the common case — the model and
        // version don't move between turns) must not fan a `sessions` delta out
        // to every connected client once per turn per session.
        let payload = json!({ "delta": [{ "name": q.session, "statusline": next.clone() }] });
        if state.set_statusline(&q.session, next) {
            let _ = state.sse_tx.send(crate::state::SseEvent {
                event: "sessions".to_string(),
                payload,
            });
        }
    }
    Ok(axum::Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings_with(v: serde_json::Value) -> serde_json::Value {
        let mut root = json!({ "theme": "dark", "hooks": { "Stop": [] } });
        for (k, val) in v.as_object().unwrap() {
            root.as_object_mut().unwrap().insert(k.clone(), val.clone());
        }
        root
    }

    #[test]
    fn install_then_uninstall_round_trips_the_settings_value_exactly() {
        for original in [
            json!({"type":"command","command":"~/bin/mystatus.sh","padding":0}),
            json!({"type":"command","command":"echo hi","padding":2,"futureKey":{"a":[1,2]}}),
        ] {
            let before = settings_with(json!({ "statusLine": original }));
            let after_install = install(&before, Mode::Wrap).unwrap();
            assert_ne!(
                after_install["statusLine"]["command"],
                before["statusLine"]["command"]
            );
            assert_eq!(
                after_install["statusLine"]["padding"],
                before["statusLine"]["padding"]
            );
            assert_eq!(after_install["theme"], before["theme"]);
            let after_uninstall = uninstall(&after_install).unwrap();
            assert_eq!(after_uninstall, before, "uninstall must be EXACT");
        }
    }

    #[test]
    fn install_is_idempotent_and_never_double_wraps() {
        let base = settings_with(json!({
            "statusLine": {"type":"command","command":"~/bin/mystatus.sh","padding":0}
        }));
        let a = install(&base, Mode::Wrap).unwrap();
        let b = install(&a, Mode::Wrap).unwrap();
        assert_eq!(a, b);
        assert_eq!(uninstall(&b).unwrap(), base);
    }

    #[test]
    fn refuses_a_non_command_statusline_instead_of_clobbering_it() {
        let weird = settings_with(json!({"statusLine": {"type":"future_kind","spec":{}}}));
        assert!(install(&weird, Mode::Wrap).is_err());
        assert!(install(&weird, Mode::TapOnly).is_err());
        assert_eq!(
            weird,
            settings_with(json!({"statusLine": {"type":"future_kind","spec":{}}})),
            "a refused install must not mutate the input"
        );
    }

    #[test]
    fn refuses_a_non_string_command_instead_of_silently_destroying_it() {
        // `type == "command"` alone does not prove we understand the slot. A
        // `command` that is an argv array (or absent) used to read through
        // `as_str().unwrap_or("")` as "the user had nothing": wrap mode
        // overwrote it, and the uninstall then "restored" the empty string,
        // reporting success while the user's command was gone.
        for weird in [
            json!({"type":"command","command":["/usr/bin/mystatus","--fancy"],"padding":0}),
            json!({"type":"command","command":{"exec":"mystatus"}}),
            // No `command` key at all: installing used to INJECT one.
            json!({"type":"command","cmd":"/usr/bin/mystatus"}),
        ] {
            let before = settings_with(json!({ "statusLine": weird }));
            assert!(
                install(&before, Mode::Wrap).is_err(),
                "wrap must refuse a non-string command: {before}"
            );
            assert!(install(&before, Mode::TapOnly).is_err());
            assert_eq!(
                uninstall(&before).unwrap(),
                before,
                "and uninstall must leave a shape we never wrote exactly alone"
            );
        }
    }

    #[test]
    fn wrap_mode_refuses_when_there_is_no_original_statusline() {
        assert!(install(&settings_with(json!({})), Mode::Wrap).is_err());
    }

    #[test]
    fn tap_only_is_allowed_when_there_is_no_original_and_removes_cleanly() {
        // Empirically settled (Task 6 Step 1, Claude Code 2.1.232 on this host):
        // a `statusLine` command that prints nothing and exits 0 costs NO blank
        // row and does not shift the composer — the pane is byte-identical to a
        // no-`statusLine` control. So tap-only is safe on a host with no original.
        let before = settings_with(json!({}));
        let after = install(&before, Mode::TapOnly).unwrap();
        assert_eq!(after["statusLine"]["type"], json!("command"));
        assert!(after["statusLine"]["command"]
            .as_str()
            .unwrap()
            .contains(MARKER));
        assert_eq!(
            uninstall(&after).unwrap(),
            before,
            "uninstalling a tap-only install must remove the key we invented"
        );
    }

    #[test]
    fn tap_only_refuses_to_drop_an_existing_original() {
        let before = settings_with(json!({
            "statusLine": {"type":"command","command":"~/bin/mystatus.sh"}
        }));
        assert!(install(&before, Mode::TapOnly).is_err());
    }

    #[test]
    fn uninstall_of_a_foreign_wrapper_is_a_no_op_not_a_clobber() {
        // Someone else's tool wrapped OUR wrapper: the marker is no longer
        // outermost. We must leave their command alone and report, never
        // "restore" over it.
        let ours = install(
            &settings_with(json!({"statusLine":{"type":"command","command":"echo mine"}})),
            Mode::Wrap,
        )
        .unwrap();
        let ours_cmd = ours["statusLine"]["command"].as_str().unwrap().to_string();
        let theirs = settings_with(json!({
            "statusLine": {"type":"command","command": format!("their-tap | ( {ours_cmd} )")}
        }));
        assert_eq!(
            uninstall(&theirs).unwrap(),
            theirs,
            "a wrapper we are not the outermost of must be left exactly alone"
        );
    }

    #[test]
    fn uninstall_without_the_embedded_original_falls_back_to_the_sidecar() {
        // Belt+braces: the original command is stored BOTH inside the wrapper
        // command string (marker-delimited) and in the sidecar.
        let original = json!({"type":"command","command":"~/bin/mystatus.sh","padding":1});
        let before = settings_with(json!({ "statusLine": original }));
        let sidecar = sidecar_for(&before, Mode::Wrap);
        let mut mangled = install(&before, Mode::Wrap).unwrap();
        // A user hand-edited the wrapper and lost the embedded original.
        mangled["statusLine"]["command"] =
            json!(format!(": {MARKER}; D=$(head -c 16384); exit 0"));
        assert!(
            uninstall(&mangled).is_err(),
            "without the embedded original AND without the sidecar we must refuse, \
             never guess"
        );
        assert_eq!(uninstall_with(&mangled, Some(&sidecar)).unwrap(), before);
    }

    #[test]
    fn the_wrapper_passes_stdout_and_exit_code_through_unchanged() {
        // Actually RUN the generated command in `sh` (the shape used by
        // `permission_request_command_is_inert_emits_no_stdout` in
        // claude_config.rs): stdin JSON in → the original's stdout out,
        // byte-identical; exit 3 stays 3; and with the supermux URL unreachable
        // the wrapper still exits fast.
        let cmd = wrap_command("printf 'STATUS-LINE-OUT'; exit 3");
        let started = std::time::Instant::now();
        let out = run_sh(&cmd, r#"{"model":{"id":"m"}}"#);
        assert_eq!(String::from_utf8_lossy(&out.stdout), "STATUS-LINE-OUT");
        assert_eq!(out.status.code(), Some(3), "the original's exit code must survive");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "an unreachable supermux must never stall the status line"
        );
    }

    #[test]
    fn the_wrapper_tees_the_same_stdin_to_the_original() {
        let payload = r#"{"model":{"id":"claude-opus-5[1m]"},"version":"2.1.232"}"#;
        let out = run_sh(&wrap_command("cat"), payload);
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            payload,
            "the original must see the SAME stdin the tap consumed"
        );
        assert_eq!(out.status.code(), Some(0));
    }

    #[test]
    fn a_payload_over_the_post_cap_still_reaches_the_original_whole() {
        // The 16 KB clip is what we POST, not what we forward. Capping the
        // buffer itself handed the user's own status line a byte-truncated —
        // therefore invalid — JSON document as soon as Claude's payload grew
        // past 16 KB (`rate_limits`/`workspace` are version-drifting fields).
        let payload = format!(r#"{{"pad":"{}"}}"#, "x".repeat(40_000));
        let out = run_sh(&wrap_command("cat"), &payload);
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).len(),
            payload.len(),
            "the original must receive the payload WHOLE, not the tap's 16 KB clip"
        );
        assert_eq!(out.status.code(), Some(0));
    }

    #[test]
    fn the_tap_only_wrapper_emits_nothing_and_exits_zero() {
        let out = run_sh(&tap_only_command(), r#"{"version":"2.1.232"}"#);
        assert!(
            out.stdout.is_empty(),
            "tap-only must print nothing; got {:?}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert_eq!(out.status.code(), Some(0));
    }

    /// Run a generated statusline command exactly as Claude does: `sh -c`, the
    /// event JSON on stdin, the pane env supplying the tap's auth. The URL is a
    /// closed port so curl fails instantly.
    fn run_sh(cmd: &str, stdin: &str) -> std::process::Output {
        use std::io::Write;
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .env("SUPERMUX_URL", "http://127.0.0.1:1")
            .env("SUPERMUX_HOOK_TOKEN", "t")
            .env("SUPERMUX_SESSION", "s")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn sh");
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        drop(child.stdin.take());
        child.wait_with_output().expect("run the statusline command")
    }

    #[test]
    fn the_wrapper_posts_to_the_tap_with_the_per_session_hook_token() {
        let cmd = wrap_command("true");
        assert!(cmd.contains("$SUPERMUX_HOOK_TOKEN"), "must use the hook token");
        assert!(
            !cmd.contains("$SUPERMUX_TOKEN"),
            "must NOT leak the dashboard bearer into settings.json"
        );
        assert!(cmd.contains("/api/_internal/statusline?session=$SUPERMUX_SESSION"));
        assert!(cmd.contains("--max-time 1"), "must bound curl");
        assert!(cmd.contains("head -c 16384"), "must size-cap the payload");
    }

    // ── the ingest payload (live-captured shape, Claude Code 2.1.232) ────────

    #[test]
    fn parses_the_live_statusline_payload_including_a_null_used_percentage() {
        // Captured live in Task 6 Step 1 on 2.1.232: `model` is an OBJECT,
        // `context_window.used_percentage` is `null` while the window is idle
        // (NOT an int), `rate_limits` is absent, and `permission_mode` does not
        // exist in this payload at all.
        let raw = json!({
            "session_id": "72a819d8-0e4d-40f4-bce8-aec8033a75fd",
            "version": "2.1.232",
            "model": {"id": "claude-opus-5[1m]", "display_name": "Opus 5 (1M context)"},
            "cost": {"total_cost_usd": 0.0, "total_duration_ms": 857},
            "context_window": {"context_window_size": 1000000, "used_percentage": null},
            "exceeds_200k_tokens": false
        });
        let s = Statusline::from_payload(&raw).expect("the live shape must parse");
        assert_eq!(s.model_id.as_deref(), Some("claude-opus-5[1m]"));
        assert_eq!(s.model_display.as_deref(), Some("Opus 5 (1M context)"));
        assert_eq!(s.version.as_deref(), Some("2.1.232"));
        assert_eq!(s.context_pct, None, "a null used_percentage is not 0%");
        assert_eq!(s.cost_usd, Some(0.0));
        assert!(!s.exceeds_200k);
    }

    #[test]
    fn a_truncated_or_alien_payload_is_a_no_op_never_a_panic() {
        // The tap's `head -c 16384` can clip mid-JSON, exactly like the hook pipe.
        assert!(Statusline::from_payload(&json!({"model": "a-string-not-an-object"})).is_some());
        assert!(Statusline::from_payload(&json!(["not", "an", "object"])).is_none());
        let s = Statusline::from_payload(&json!({})).unwrap();
        assert!(s.model_id.is_none() && s.context_pct.is_none());
    }

    #[test]
    fn the_snapshot_is_change_gated_so_a_per_turn_tap_is_not_an_sse_storm() {
        let a = Statusline::from_payload(&json!({"version":"2.1.232"})).unwrap();
        let b = Statusline::from_payload(&json!({"version":"2.1.232"})).unwrap();
        let c = Statusline::from_payload(&json!({"version":"2.1.233"})).unwrap();
        assert!(!a.differs_from(&b), "an identical statusline must not re-broadcast");
        assert!(a.differs_from(&c));
    }
}
