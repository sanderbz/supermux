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
//!     "reachable" (green); it does not any more.
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
}

impl ProbeOutcome {
    fn ok(message: &str) -> Self {
        Self { health: Some("ok"), last_error: None, message: message.to_string(), testable: true }
    }
    fn expired(message: &str) -> Self {
        Self {
            health: Some("expired"),
            last_error: Some(message.to_string()),
            message: message.to_string(),
            testable: true,
        }
    }
    fn error(message: &str) -> Self {
        Self {
            health: Some("error"),
            last_error: Some(message.to_string()),
            message: message.to_string(),
            testable: true,
        }
    }
    fn untestable(message: &str) -> Self {
        Self { health: None, last_error: None, message: message.to_string(), testable: false }
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

/// Does an HTTP body carry a JSON-RPC RESULT — plain JSON, or the first `data:`
/// line of an SSE stream? Pure.
pub fn body_is_jsonrpc_result(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body);
    let candidate: String = if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
        return v.get("result").is_some() && v.get("error").is_none();
    } else {
        text.lines()
            .find_map(|l| l.strip_prefix("data:"))
            .map(str::trim)
            .unwrap_or("")
            .to_string()
    };
    serde_json::from_str::<Value>(&candidate)
        .map(|v| v.get("result").is_some() && v.get("error").is_none())
        .unwrap_or(false)
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

/// The URL-transport probe: ONE JSON-RPC `initialize` POST with the bearer (when
/// any), no redirects, 8 s, body capped at 256 KiB. Mapped by [`classify_http`].
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
    let mut req = client
        .post(&url)
        .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(super::oauth_code::initialize_body("supermux-health").to_string());
    if let Some(b) = bearer {
        req = req.bearer_auth(b);
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let www = resp
                .headers()
                .get(reqwest::header::WWW_AUTHENTICATE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            if (300..400).contains(&status) {
                return classify_http(status, www.as_deref(), false);
            }
            let mut body: Vec<u8> = Vec::new();
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
            classify_http(status, www.as_deref(), body_is_jsonrpc_result(&body))
        }
        Err(e) if e.is_timeout() => ProbeOutcome::error("The endpoint timed out — it may be down."),
        Err(e) if e.is_connect() => {
            ProbeOutcome::error("Couldn't connect to the endpoint — check the URL and the network.")
        }
        Err(_) => ProbeOutcome::error("Couldn't reach the endpoint."),
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
