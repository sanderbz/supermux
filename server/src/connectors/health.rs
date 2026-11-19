//! Per-account "Test connection" probes + the honest health mapping (Slice 3).
//!
//! A connected account can go stale (an app-specific password revoked, a token
//! expired, an endpoint moved). The Installed tab must never paint a dead
//! connection green, so this module runs a **per-kind** liveness probe and returns
//! one of three honest verdicts — `ok` / `expired` / `error` — or declares the
//! connector **untestable** (leaving the stored health untouched rather than
//! faking a result).
//!
//! **The probes, by kind.**
//!   * **iCloud Mail** (the shipped agent-authored IMAP connector,
//!     [`crate::connectors::icloud`]): a real IMAP `LOGIN` to `imap.mail.me.com`
//!     with the sealed `ICLOUD_EMAIL` / `ICLOUD_APP_PW`. This genuinely validates
//!     the credential — a login that succeeds means the connector will work; a
//!     rejected login means the app-specific password is `expired`. Run through the
//!     SAME stdlib `imaplib` the connector's own server uses, so a green probe
//!     predicts a green runtime. Credentials travel via the child's ENV (never
//!     argv/logs), exactly like the launch path. The generic IMAP family
//!     (Gmail/Outlook/Fastmail, [`crate::connectors::imap_connector`]) runs the
//!     SAME script against the host its emit env names.
//!   * **URL (HTTP/SSE) MCP servers**: a real JSON-RPC `initialize` POST carrying
//!     the sealed bearer (`MCP_OAUTH_ACCESS_TOKEN`, or the card's `token_field`).
//!     ONLY a JSON-RPC result is `ok`; a `401`/`403` is `expired` ("Needs
//!     sign-in"); a `404`/`405` is "Not an MCP endpoint"; any 3xx is an error
//!     (never followed — the bearer is never forwarded). A 401 used to count as
//!     "reachable" (green); it does not any more. A green `initialize` is then
//!     followed by `notifications/initialized` + a real `tools/list` on the same
//!     session (`Mcp-Session-Id` echoed back), and the verdict reports the
//!     **`tool_count`** the server actually listed — "Server answered — 2 tools."
//!     A server that initializes but refuses `tools/list` with a 401/403 is
//!     `expired`; one that answers it with anything but a tool list stays `ok`
//!     (it is alive and authed) but says so plainly, with `tool_count: null`.
//!   * **Everything else** (stdio `command` MCPs — npx/uvx catalog servers with an
//!     opaque API key, a built-in with no credential): **untestable**. We refuse to
//!     spawn an arbitrary server just to guess, and we never invent a green — the
//!     row keeps whatever health it had and the UI says so plainly.
//!
//! **Secret hygiene.** The decrypted field-map is read here only to feed the probe
//! (IMAP env); it is never logged and never returned. `last_error` is a fixed,
//! human-readable string chosen by [`classify_imap`] / the reachability arm — never
//! the raw server response (which cannot carry a secret anyway, but we do not rely
//! on that).

use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;

use crate::db::connectors::Connector;

use super::icloud;

/// The stdlib-only `imaplib` probe, run via `python3 -c`. Reads the host + the
/// two credential fields from ENV (`IMAP_PROBE_HOST` / `IMAP_PROBE_USER` /
/// `IMAP_PROBE_PW`, never argv), attempts an IMAP `LOGIN`, and prints ONE verdict
/// token on its last line: `OK` (login accepted), `AUTH` (login rejected — the
/// app-specific password is bad/expired), or `CONN` (could not reach the server).
const IMAP_PROBE_PY: &str = r#"
import imaplib, os, socket, sys
socket.setdefaulttimeout(10)
host = os.environ.get("IMAP_PROBE_HOST", "")
email = os.environ.get("IMAP_PROBE_USER", "")
pw = os.environ.get("IMAP_PROBE_PW", "")
if not host or not email or not pw:
    print("CONN"); sys.exit(0)
try:
    M = imaplib.IMAP4_SSL(host, 993)
except Exception:
    print("CONN"); sys.exit(0)
try:
    M.login(email, pw)
    try:
        M.logout()
    except Exception:
        pass
    print("OK")
except imaplib.IMAP4.error:
    print("AUTH")
except Exception:
    print("CONN")
"#;

/// How an account of a given connector can be probed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeKind {
    /// iCloud-style: an IMAP `LOGIN` validates the stored app-specific password.
    ImapAppPassword,
    /// The generic IMAP family (Gmail/Outlook/Fastmail): the same login probe
    /// against the `IMAP_HOST` the connector's emit env names.
    ImapMail,
    /// A URL-transport MCP: a JSON-RPC `initialize` with the sealed bearer.
    HttpInitialize,
    /// No cheap, honest liveness check exists (a stdio `command` MCP, or a
    /// connector with no credential to validate).
    Untestable,
}

/// The result of a probe — what to persist and what to tell the human.
#[derive(Debug, Clone)]
pub struct ProbeOutcome {
    /// The health to store: `Some("ok"|"expired"|"error")`, or `None` when the
    /// connector is untestable (the stored health is then LEFT AS IT WAS — no fake
    /// green, no spurious red).
    pub health: Option<&'static str>,
    /// A masked, human-readable reason to store in `last_error` (only when the
    /// verdict is not `ok`). `None` on success or when untestable.
    pub last_error: Option<String>,
    /// A short line for the immediate UI note (always present).
    pub message: String,
    /// False only for [`ProbeKind::Untestable`] — the caller then persists nothing.
    pub testable: bool,
    /// How many tools the server listed in a real `tools/list` (URL MCPs only).
    /// `None` when the probe never got that far (not `ok`, an IMAP probe, or a
    /// server that answered `initialize` but not `tools/list`). Never invented.
    pub tool_count: Option<u32>,
}

impl ProbeOutcome {
    fn ok(message: &str) -> Self {
        Self {
            health: Some("ok"),
            last_error: None,
            message: message.to_string(),
            testable: true,
            tool_count: None,
        }
    }
    fn expired(message: &str) -> Self {
        Self {
            health: Some("expired"),
            last_error: Some(message.to_string()),
            message: message.to_string(),
            testable: true,
            tool_count: None,
        }
    }
    fn error(message: &str) -> Self {
        Self {
            health: Some("error"),
            last_error: Some(message.to_string()),
            message: message.to_string(),
            testable: true,
            tool_count: None,
        }
    }
    fn untestable(message: &str) -> Self {
        Self { health: None, last_error: None, message: message.to_string(), testable: false, tool_count: None }
    }
}

/// Which probe (if any) applies to this connector. Pure — the routing decision is
/// unit-testable without any IO.
pub fn probe_kind(connector: &Connector) -> ProbeKind {
    // The one shipped IMAP connector validates its credential for real.
    if connector.id == icloud::ICLOUD_ID {
        return ProbeKind::ImapAppPassword;
    }
    if super::imap_connector::is_mail_connector(&connector.id) {
        return ProbeKind::ImapMail;
    }
    // A URL-transport MCP answers (or refuses) a JSON-RPC `initialize`.
    if emit_url(&connector.emit_json).is_some() {
        return ProbeKind::HttpInitialize;
    }
    // A stdio `command` MCP (or a no-credential built-in) has no honest cheap test.
    ProbeKind::Untestable
}

/// The `url` a connector's emit block launches against, when it is a URL-transport
/// MCP (`{ "url": "https://…" }`). `None` for a stdio `command` emit or malformed
/// JSON. Pure.
pub fn emit_url(emit_json: &str) -> Option<String> {
    let v: Value = serde_json::from_str(emit_json).ok()?;
    v.get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
        .map(str::to_string)
}

/// Map the IMAP probe's stdout (its last non-empty line is the verdict token) onto
/// an honest [`ProbeOutcome`]. Pure — the network half lives in [`imap_probe`].
pub fn classify_imap(stdout: &str) -> ProbeOutcome {
    classify_imap_for(stdout, "iCloud Mail", "imap.mail.me.com", Some("appleid.apple.com"))
}

/// [`classify_imap`] for any IMAP provider: `label` names it, `host` is the
/// IMAP host, `regen_at` where an app password is regenerated (when known).
pub fn classify_imap_for(stdout: &str, label: &str, host: &str, regen_at: Option<&str>) -> ProbeOutcome {
    let verdict = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    match verdict {
        "OK" => ProbeOutcome::ok(&format!("Signed in to {label} — the app password works.")),
        "AUTH" => ProbeOutcome::expired(&match regen_at {
            Some(r) => format!("{label} rejected the app-specific password — regenerate it at {r} and reconnect."),
            None => format!("{label} rejected the app-specific password — regenerate it and reconnect."),
        }),
        _ => ProbeOutcome::error(&format!("Couldn't reach {label} ({host}). Check the network and try again.")),
    }
}

/// Run the connector's probe against a decrypted credential field-map (env-var name
/// → value), returning the honest verdict. Never panics; a probe that cannot run
/// degrades to `error` (or `untestable`), never to a fake `ok`.
pub async fn run_probe(connector: &Connector, secrets: &BTreeMap<String, String>) -> ProbeOutcome {
    match probe_kind(connector) {
        ProbeKind::ImapAppPassword => {
            let email = secrets.get(icloud::ENV_EMAIL).cloned().unwrap_or_default();
            let pw = secrets.get(icloud::ENV_APP_PW).cloned().unwrap_or_default();
            imap_probe("imap.mail.me.com", &email, &pw, |out| classify_imap(out)).await
        }
        ProbeKind::ImapMail => {
            let host = serde_json::from_str::<Value>(&connector.emit_json)
                .ok()
                .and_then(|v| v.get("env")?.get("IMAP_HOST")?.as_str().map(str::to_string))
                .unwrap_or_default();
            let email = secrets.get(super::imap_connector::ENV_ADDRESS).cloned().unwrap_or_default();
            let pw = secrets.get(super::imap_connector::ENV_APP_PW).cloned().unwrap_or_default();
            let label = connector.display_name.clone();
            let h = host.clone();
            imap_probe(&host, &email, &pw, move |out| classify_imap_for(out, &label, &h, None)).await
        }
        ProbeKind::HttpInitialize => http_probe(&connector.emit_json, &bearer_for(connector, secrets)).await,
        ProbeKind::Untestable => ProbeOutcome::untestable(
            "This connector type can't be tested automatically — supermux can't verify its credential without running it.",
        ),
    }
}

/// The IMAP login probe: run [`IMAP_PROBE_PY`] under `python3` with the host +
/// the two fields injected as ENV (never argv/logs), bounded by a hard timeout.
async fn imap_probe(
    host: &str,
    email: &str,
    pw: &str,
    classify: impl FnOnce(&str) -> ProbeOutcome,
) -> ProbeOutcome {
    if host.trim().is_empty() {
        return ProbeOutcome::error("This mail connector names no IMAP host to test.");
    }
    if email.trim().is_empty() || pw.trim().is_empty() {
        return ProbeOutcome::error("No stored mail credential to test — reconnect the account.");
    }

    let mut cmd = tokio::process::Command::new("python3");
    cmd.arg("-c")
        .arg(IMAP_PROBE_PY)
        .env("IMAP_PROBE_HOST", host)
        .env("IMAP_PROBE_USER", email)
        .env("IMAP_PROBE_PW", pw)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    match tokio::time::timeout(Duration::from_secs(15), cmd.output()).await {
        Ok(Ok(out)) => classify(&String::from_utf8_lossy(&out.stdout)),
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "mail test: could not spawn python3 probe");
            ProbeOutcome::error("Couldn't run the connection test on the server.")
        }
        Err(_) => ProbeOutcome::error("The mail connection test timed out."),
    }
}

/// The card's declared `token_field` (Lane B): the manifest's persisted auth
/// descriptor, else the curated catalog's. `None` for every other lane.
pub fn token_field_for(connector: &Connector) -> Option<String> {
    let from_source = serde_json::from_str::<Value>(&connector.source_json)
        .ok()
        .and_then(|v| v.get("auth")?.get("token_field")?.as_str().map(str::to_string))
        .filter(|s| !s.is_empty());
    from_source.or_else(|| {
        super::catalog::curated_auth(&connector.id)
            .and_then(|a| a.get("token_field")?.as_str().map(str::to_string))
            .filter(|s| !s.is_empty())
    })
}

/// The bearer a URL probe sends: the brokered OAuth access token, else the value
/// of the card's `token_field` (a PAT-style remote), else none.
pub fn bearer_for(connector: &Connector, secrets: &BTreeMap<String, String>) -> Option<String> {
    if let Some(t) = secrets.get(super::oauth_code::ACCESS_TOKEN_FIELD).filter(|s| !s.is_empty()) {
        return Some(t.clone());
    }
    let field = token_field_for(connector)?;
    secrets.get(&field).filter(|s| !s.is_empty()).cloned()
}

/// The JSON-RPC `result` an HTTP body carries — plain JSON, or the first `data:`
/// line of an SSE stream. `None` for an `error` response, a non-JSON body, or an
/// empty one. Pure.
pub fn jsonrpc_result(body: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(body);
    let parsed: Option<Value> = serde_json::from_str::<Value>(text.trim()).ok().or_else(|| {
        let line = text.lines().find_map(|l| l.strip_prefix("data:")).map(str::trim)?;
        serde_json::from_str::<Value>(line).ok()
    });
    let mut v = parsed?;
    if v.get("error").is_some() {
        return None;
    }
    let obj = v.as_object_mut()?;
    obj.remove("result")
}

/// Does an HTTP body carry a JSON-RPC RESULT — plain JSON, or the first `data:`
/// line of an SSE stream? Pure.
pub fn body_is_jsonrpc_result(body: &[u8]) -> bool {
    jsonrpc_result(body).is_some()
}

/// The number of tools a `tools/list` result body names (`result.tools[]`).
/// `None` when the body is not a tool-list result. Pure — never guesses.
pub fn tool_count_from_body(body: &[u8]) -> Option<u32> {
    let r = jsonrpc_result(body)?;
    let tools = r.get("tools")?.as_array()?;
    u32::try_from(tools.len()).ok()
}

/// The JSON-RPC `tools/list` request the probe sends after a green `initialize`.
pub fn tools_list_body() -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} })
}

/// The `notifications/initialized` notification (no `id`) that MCP requires
/// between `initialize` and the first request on a session.
pub fn initialized_notification_body() -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
}

/// Fold a `tools/list` reply into an already-green `initialize` outcome. Pure.
/// A 401/403 here is a sign-in problem (`expired`); a real tool list is green
/// WITH its count; anything else (an `error`, a non-JSON body, a 5xx) stays `ok`
/// — the server did answer `initialize` with the bearer — but the message says the
/// tools could not be listed and `tool_count` stays `None` (never invented).
pub fn classify_tools_list(status: u16, body: &[u8]) -> ProbeOutcome {
    match status {
        401 | 403 => ProbeOutcome::expired("Signed in, but the server refused to list its tools — sign in again."),
        200..=299 => match tool_count_from_body(body) {
            Some(0) => {
                let mut o = ProbeOutcome::ok("Server answered — it lists no tools.");
                o.tool_count = Some(0);
                o
            }
            Some(1) => {
                let mut o = ProbeOutcome::ok("Server answered — 1 tool.");
                o.tool_count = Some(1);
                o
            }
            Some(n) => {
                let mut o = ProbeOutcome::ok(&format!("Server answered — {n} tools."));
                o.tool_count = Some(n);
                o
            }
            None => ProbeOutcome::ok("Server answered, but wouldn't list its tools."),
        },
        _ => ProbeOutcome::ok(&format!("Server answered, but wouldn't list its tools (HTTP {status}).")),
    }
}

/// Pure mapping of an `initialize` POST's `(status, body_ok)` onto the honest
/// verdict. Only a 2xx WITH a JSON-RPC result is green.
pub fn classify_http(status: u16, www_authenticate: Option<&str>, body_ok: bool) -> ProbeOutcome {
    match status {
        300..=399 => ProbeOutcome::error("Not an MCP endpoint (redirected)"),
        200..=299 if body_ok => ProbeOutcome::ok("Server answered."),
        200..=299 => ProbeOutcome::error("Server answered, but not as an MCP server"),
        401 | 403 => {
            let _ = www_authenticate;
            ProbeOutcome::expired("Needs sign-in")
        }
        404 | 405 => ProbeOutcome::error(&format!("Not an MCP endpoint (HTTP {status})")),
        _ => ProbeOutcome::error(&format!("Server error {status}")),
    }
}

/// One bounded JSON-RPC POST: status, `WWW-Authenticate`, `Mcp-Session-Id`, and
/// the body (capped at 256 KiB; an SSE stream is cut after its first `data:`
/// result). `Err` carries the honest probe verdict for a transport failure.
struct JsonRpcReply {
    status: u16,
    www_authenticate: Option<String>,
    session_id: Option<String>,
    body: Vec<u8>,
}

async fn post_jsonrpc(
    client: &reqwest::Client,
    url: &str,
    bearer: &Option<String>,
    session_id: &Option<String>,
    body: Value,
) -> Result<JsonRpcReply, ProbeOutcome> {
    let mut req = client
        .post(url)
        .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string());
    if let Some(b) = bearer {
        req = req.bearer_auth(b);
    }
    if let Some(sid) = session_id {
        req = req.header("Mcp-Session-Id", sid);
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let header = |name: &str| {
                resp.headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string)
            };
            let www_authenticate = header("www-authenticate");
            let session_id = header("mcp-session-id");
            let mut body: Vec<u8> = Vec::new();
            if !(300..400).contains(&status) {
                let mut resp = resp;
                while let Ok(Some(chunk)) = resp.chunk().await {
                    body.extend_from_slice(&chunk);
                    if body.len() >= 256 * 1024 {
                        break;
                    }
                    // An SSE stream may never close: one `data:` line is enough.
                    if body_is_jsonrpc_result(&body) {
                        break;
                    }
                }
            }
            Ok(JsonRpcReply { status, www_authenticate, session_id, body })
        }
        Err(e) if e.is_timeout() => Err(ProbeOutcome::error("The endpoint timed out — it may be down.")),
        Err(e) if e.is_connect() => {
            Err(ProbeOutcome::error("Couldn't connect to the endpoint — check the URL and the network."))
        }
        Err(_) => Err(ProbeOutcome::error("Couldn't reach the endpoint.")),
    }
}

/// The URL-transport probe: a JSON-RPC `initialize` POST with the bearer (when
/// any), no redirects, 8 s per request, body capped at 256 KiB, mapped by
/// [`classify_http`]. ONLY when that is green: `notifications/initialized` + a real
/// `tools/list` on the same session, folded in by [`classify_tools_list`] so the
/// verdict carries the tool count the server actually returned.
pub async fn http_probe(emit_json: &str, bearer: &Option<String>) -> ProbeOutcome {
    let Some(url) = emit_url(emit_json) else {
        return ProbeOutcome::untestable("This connector has no reachable URL to test.");
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("supermux-connector-health/1")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = %e, "http test: client build failed");
            return ProbeOutcome::error("Couldn't run the connection test on the server.");
        }
    };

    // 1. initialize — the health verdict.
    let init = match post_jsonrpc(
        &client,
        &url,
        bearer,
        &None,
        super::oauth_code::initialize_body("supermux-health"),
    )
    .await
    {
        Ok(r) => r,
        Err(outcome) => return outcome,
    };
    let verdict = classify_http(init.status, init.www_authenticate.as_deref(), body_is_jsonrpc_result(&init.body));
    if verdict.health != Some("ok") {
        return verdict;
    }

    // 2. notifications/initialized — required by the protocol before any request;
    //    its reply carries nothing we need (a transport failure here is not a
    //    verdict: the server already answered `initialize`).
    let session = init.session_id.clone();
    let _ = post_jsonrpc(&client, &url, bearer, &session, initialized_notification_body()).await;

    // 3. tools/list — the count the human sees.
    match post_jsonrpc(&client, &url, bearer, &session, tools_list_body()).await {
        Ok(r) => classify_tools_list(r.status, &r.body),
        Err(_) => ProbeOutcome::ok("Server answered, but wouldn't list its tools."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn connector(id: &str, emit: Value) -> Connector {
        Connector {
            id: id.to_string(),
            kind: "mcp_catalog".to_string(),
            display_name: id.to_string(),
            icon: String::new(),
            description: String::new(),
            tools_json: "[]".to_string(),
            credentials_json: "[]".to_string(),
            emit_json: emit.to_string(),
            source_json: "{}".to_string(),
            created_at: 0,
        }
    }

    #[test]
    fn probe_kind_routes_icloud_url_and_stdio() {
        // The shipped IMAP connector → a real credential-validating login probe.
        let ic = connector(icloud::ICLOUD_ID, json!({ "command": "python3", "args": ["s.py"] }));
        assert_eq!(probe_kind(&ic), ProbeKind::ImapAppPassword);

        // A URL-transport MCP → a JSON-RPC initialize.
        let url = connector("remote-mcp", json!({ "url": "https://mcp.example.com/sse" }));
        assert_eq!(probe_kind(&url), ProbeKind::HttpInitialize);

        // The generic IMAP family → the same login probe as iCloud.
        let gm = connector("gmail-imap", json!({ "command": "python3", "env": { "IMAP_HOST": "imap.gmail.com" } }));
        assert_eq!(probe_kind(&gm), ProbeKind::ImapMail);

        // A stdio command MCP (the npx/uvx catalog shape) → untestable.
        let stdio = connector("pmcp-notion", json!({ "command": "npx", "args": ["-y", "notion"] }));
        assert_eq!(probe_kind(&stdio), ProbeKind::Untestable);

        // A built-in with an empty emit → untestable (nothing to probe).
        let builtin = connector("shared-browser", json!({}));
        assert_eq!(probe_kind(&builtin), ProbeKind::Untestable);
    }

    #[test]
    fn emit_url_extracts_only_http_urls() {
        assert_eq!(
            emit_url(&json!({ "url": "https://a.example/sse" }).to_string()).as_deref(),
            Some("https://a.example/sse")
        );
        assert_eq!(
            emit_url(&json!({ "url": "http://localhost:9/x" }).to_string()).as_deref(),
            Some("http://localhost:9/x")
        );
        // A stdio command carries no url.
        assert_eq!(emit_url(&json!({ "command": "npx" }).to_string()), None);
        // A non-http scheme is not a reachability target.
        assert_eq!(emit_url(&json!({ "url": "stdio://x" }).to_string()), None);
        // Malformed JSON is safe.
        assert_eq!(emit_url("not json"), None);
    }

    #[test]
    fn classify_imap_maps_verdicts_honestly() {
        // A successful login is the ONLY green.
        assert_eq!(classify_imap("OK\n").health, Some("ok"));
        assert!(classify_imap("OK\n").last_error.is_none());

        // A rejected app password is EXPIRED — never green.
        let expired = classify_imap("AUTH\n");
        assert_eq!(expired.health, Some("expired"));
        assert_ne!(expired.health, Some("ok"), "expired must NEVER read ok");
        assert!(expired.last_error.is_some());

        // A connection failure is an error, not a guess.
        assert_eq!(classify_imap("CONN\n").health, Some("error"));

        // Noise before the verdict is ignored (last non-empty line wins); an empty
        // or unknown output degrades to error (honest — we did not confirm health).
        assert_eq!(classify_imap("warning: x\nOK\n").health, Some("ok"));
        assert_eq!(classify_imap("").health, Some("error"));
        assert_eq!(classify_imap("garbage").health, Some("error"));

        // Every testable verdict is marked testable so the caller persists it.
        assert!(classify_imap("OK").testable);
        assert!(classify_imap("AUTH").testable);
        assert!(classify_imap("CONN").testable);
    }

    #[test]
    fn classify_http_is_honest() {
        // A 3xx is never followed and never green.
        assert_eq!(classify_http(302, None, false).health, Some("error"));
        // A 401 is NOT "reachable" any more — it is a sign-in problem.
        let e = classify_http(401, Some("Bearer"), false);
        assert_eq!(e.health, Some("expired"));
        assert_eq!(e.last_error.as_deref(), Some("Needs sign-in"));
        assert_eq!(classify_http(403, None, false).health, Some("expired"));
        // Only a 2xx WITH a JSON-RPC result is green.
        let ok = classify_http(200, None, true);
        assert_eq!(ok.health, Some("ok"));
        assert_eq!(ok.message, "Server answered.");
        assert_eq!(classify_http(200, None, false).health, Some("error"));
        assert!(classify_http(404, None, false).last_error.unwrap().contains("Not an MCP endpoint"));
        assert!(classify_http(405, None, false).last_error.unwrap().contains("405"));
        assert!(classify_http(503, None, false).last_error.unwrap().contains("503"));
    }

    #[test]
    fn jsonrpc_result_detection_json_and_sse() {
        assert!(body_is_jsonrpc_result(br#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}"#));
        assert!(!body_is_jsonrpc_result(br#"{"jsonrpc":"2.0","id":1,"error":{"code":-32600}}"#));
        assert!(body_is_jsonrpc_result(b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n"));
        assert!(!body_is_jsonrpc_result(b"<html>"));
        assert!(!body_is_jsonrpc_result(b""));
    }

    #[test]
    fn bearer_prefers_the_oauth_token_then_the_token_field() {
        let mut secrets = BTreeMap::new();
        secrets.insert("GITHUB_TOKEN".to_string(), "pat".to_string());
        let gh = connector("pmcp-github", json!({ "url": "https://api.githubcopilot.com/mcp/" }));
        assert_eq!(token_field_for(&gh).as_deref(), Some("GITHUB_TOKEN"));
        assert_eq!(bearer_for(&gh, &secrets).as_deref(), Some("pat"));
        secrets.insert(super::super::oauth_code::ACCESS_TOKEN_FIELD.to_string(), "oauth".to_string());
        assert_eq!(bearer_for(&gh, &secrets).as_deref(), Some("oauth"));
        let plain = connector("remote-x", json!({ "url": "https://x.example/mcp" }));
        assert_eq!(bearer_for(&plain, &BTreeMap::new()), None);
    }

    #[test]
    fn tool_count_is_parsed_from_a_real_tools_list_only() {
        // A real tools/list result → its exact length (JSON and SSE framings).
        let two = br#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo"},{"name":"whoami"}]}}"#;
        assert_eq!(tool_count_from_body(two), Some(2));
        let sse = b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"a\"}]}}\n\n";
        assert_eq!(tool_count_from_body(sse), Some(1));
        assert_eq!(tool_count_from_body(br#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#), Some(0));
        // An initialize result, an error, or garbage is NOT a tool count.
        assert_eq!(tool_count_from_body(br#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"x"}}"#), None);
        assert_eq!(tool_count_from_body(br#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601}}"#), None);
        assert_eq!(tool_count_from_body(b"<html>"), None);
        assert_eq!(tool_count_from_body(b""), None);
    }

    #[test]
    fn classify_tools_list_reports_the_real_count_and_never_invents_one() {
        let two = br#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo"},{"name":"whoami"}]}}"#;
        let ok = classify_tools_list(200, two);
        assert_eq!(ok.health, Some("ok"));
        assert_eq!(ok.tool_count, Some(2));
        assert_eq!(ok.message, "Server answered — 2 tools.");
        assert!(ok.last_error.is_none());

        let one = classify_tools_list(200, br#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"x"}]}}"#);
        assert_eq!(one.tool_count, Some(1));
        assert_eq!(one.message, "Server answered — 1 tool.");

        let none = classify_tools_list(200, br#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#);
        assert_eq!(none.tool_count, Some(0));
        assert!(none.message.contains("no tools"));

        // A server that will not list its tools is still alive+authed (ok) but the
        // count is unknown — not zero, not guessed.
        let refused = classify_tools_list(200, br#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601}}"#);
        assert_eq!(refused.health, Some("ok"));
        assert_eq!(refused.tool_count, None);
        assert!(refused.message.contains("wouldn't list its tools"));
        let five = classify_tools_list(500, b"");
        assert_eq!(five.health, Some("ok"));
        assert_eq!(five.tool_count, None);
        assert!(five.message.contains("500"));

        // A 401/403 on tools/list is a sign-in problem — never green.
        let exp = classify_tools_list(401, b"");
        assert_eq!(exp.health, Some("expired"));
        assert_eq!(exp.tool_count, None);
        assert!(exp.last_error.is_some());
        assert_eq!(classify_tools_list(403, b"").health, Some("expired"));
    }

    /// A minimal in-process streamable-HTTP MCP server: `initialize` → a result
    /// with an `Mcp-Session-Id`; `notifications/initialized` → 202; `tools/list`
    /// → two tools. Records every request's (method, bearer, session id) so the
    /// test can assert what the probe actually sent. Handles keep-alive.
    async fn mock_mcp(
        require_bearer: Option<&'static str>,
        tools_list_status: u16,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<(String, Option<String>, Option<String>)>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buf: Vec<u8> = Vec::new();
                    loop {
                        // Read one request: headers, then Content-Length bytes.
                        let head_end = loop {
                            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                break i + 4;
                            }
                            let mut tmp = [0u8; 4096];
                            match sock.read(&mut tmp).await {
                                Ok(0) | Err(_) => return,
                                Ok(n) => buf.extend_from_slice(&tmp[..n]),
                            }
                        };
                        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                        let hdr = |name: &str| {
                            head.lines()
                                .find(|l| l.to_ascii_lowercase().starts_with(&format!("{name}:")))
                                .map(|l| l[name.len() + 1..].trim().to_string())
                        };
                        let len: usize = hdr("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                        while buf.len() < head_end + len {
                            let mut tmp = [0u8; 4096];
                            match sock.read(&mut tmp).await {
                                Ok(0) | Err(_) => return,
                                Ok(n) => buf.extend_from_slice(&tmp[..n]),
                            }
                        }
                        let body: Value = serde_json::from_slice(&buf[head_end..head_end + len]).unwrap_or(Value::Null);
                        buf.drain(..head_end + len);
                        let method = body.get("method").and_then(Value::as_str).unwrap_or("").to_string();
                        let bearer = hdr("authorization").and_then(|a| a.strip_prefix("Bearer ").map(str::to_string));
                        let sid = hdr("mcp-session-id");
                        log.lock().unwrap().push((method.clone(), bearer.clone(), sid.clone()));

                        let (status, reply): (u16, String) = if require_bearer.is_some() && bearer.as_deref() != require_bearer {
                            (401, r#"{"error":"unauthorized"}"#.to_string())
                        } else if method == "initialize" {
                            (200, r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"mock","version":"1"}}}"#.to_string())
                        } else if method == "notifications/initialized" {
                            (202, String::new())
                        } else if method == "tools/list" {
                            (tools_list_status, r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object"}},{"name":"whoami","inputSchema":{"type":"object"}}]}}"#.to_string())
                        } else {
                            (200, r#"{"jsonrpc":"2.0","id":9,"error":{"code":-32601,"message":"no"}}"#.to_string())
                        };
                        let reason = match status { 200 => "OK", 202 => "Accepted", 401 => "Unauthorized", _ => "X" };
                        let resp = format!(
                            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nMcp-Session-Id: sess-42\r\nWWW-Authenticate: Bearer\r\nContent-Length: {}\r\n\r\n{reply}",
                            reply.len()
                        );
                        if sock.write_all(resp.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        (url, seen)
    }

    #[tokio::test]
    async fn http_probe_runs_a_real_tools_list_on_the_session_and_reports_the_count() {
        let (url, seen) = mock_mcp(Some("at-1"), 200).await;
        let emit = json!({ "type": "http", "url": url }).to_string();
        let out = http_probe(&emit, &Some("at-1".to_string())).await;
        assert_eq!(out.health, Some("ok"), "{}", out.message);
        assert_eq!(out.tool_count, Some(2), "the count comes from the server's real tools/list");
        assert_eq!(out.message, "Server answered — 2 tools.");
        assert!(out.last_error.is_none());

        // The probe sent initialize → notifications/initialized → tools/list, every
        // one with the bearer, and the two follow-ups on the server's session id.
        let calls = seen.lock().unwrap().clone();
        let methods: Vec<&str> = calls.iter().map(|c| c.0.as_str()).collect();
        assert_eq!(methods, vec!["initialize", "notifications/initialized", "tools/list"]);
        assert!(calls.iter().all(|c| c.1.as_deref() == Some("at-1")), "bearer on every call");
        assert_eq!(calls[0].2, None, "no session before initialize answered");
        assert_eq!(calls[1].2.as_deref(), Some("sess-42"));
        assert_eq!(calls[2].2.as_deref(), Some("sess-42"));
    }

    #[tokio::test]
    async fn http_probe_without_the_bearer_is_expired_and_never_lists_tools() {
        let (url, seen) = mock_mcp(Some("at-1"), 200).await;
        let emit = json!({ "url": url }).to_string();
        let out = http_probe(&emit, &None).await;
        assert_eq!(out.health, Some("expired"));
        assert_eq!(out.tool_count, None);
        // A refused initialize stops the probe: no tools/list is attempted.
        let methods: Vec<String> = seen.lock().unwrap().iter().map(|c| c.0.clone()).collect();
        assert_eq!(methods, vec!["initialize".to_string()]);
    }

    #[tokio::test]
    async fn http_probe_tools_list_refusal_keeps_ok_without_a_count() {
        // The server answers initialize but 500s tools/list: alive + authed, count
        // unknown — the message says so; tool_count is NOT invented.
        let (url, _seen) = mock_mcp(None, 500).await;
        let emit = json!({ "url": url }).to_string();
        let out = http_probe(&emit, &None).await;
        assert_eq!(out.health, Some("ok"));
        assert_eq!(out.tool_count, None);
        assert!(out.message.contains("wouldn't list its tools"), "{}", out.message);
    }

    #[tokio::test]
    async fn untestable_connector_persists_nothing() {
        // A stdio command MCP yields an untestable outcome: no health to store, so
        // the row keeps whatever it had (no fake green).
        let stdio = connector("pmcp-notion", json!({ "command": "npx" }));
        let outcome = run_probe(&stdio, &BTreeMap::new()).await;
        assert!(!outcome.testable);
        assert_eq!(outcome.health, None);
        assert!(outcome.last_error.is_none());
        assert!(!outcome.message.is_empty());
    }

    #[tokio::test]
    async fn imap_probe_without_credentials_is_an_error_not_green() {
        // No stored fields → the probe cannot even attempt a login; it must report
        // an honest error, never ok.
        let ic = connector(icloud::ICLOUD_ID, json!({ "command": "python3" }));
        let outcome = run_probe(&ic, &BTreeMap::new()).await;
        assert!(outcome.testable);
        assert_eq!(outcome.health, Some("error"));
        assert_ne!(outcome.health, Some("ok"));
    }
}
