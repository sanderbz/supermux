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
//!     argv/logs), exactly like the launch path.
//!   * **URL (HTTP/SSE) MCP servers**: a bounded reachability GET. Any HTTP
//!     response (even 401/404/405) means the endpoint is up → `ok`; a
//!     DNS/connect/timeout failure → `error`. This is an honest *reachability*
//!     check, not a token-validity check (the design's sanctioned best-effort for
//!     an arbitrary catalog MCP).
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

/// The stdlib-only `imaplib` probe, run via `python3 -c`. Reads the two credential
/// fields from ENV (never argv), attempts an IMAP `LOGIN`, and prints ONE verdict
/// token on its last line: `OK` (login accepted), `AUTH` (login rejected — the
/// app-specific password is bad/expired), or `CONN` (could not reach the server).
const IMAP_PROBE_PY: &str = r#"
import imaplib, os, socket, sys
socket.setdefaulttimeout(10)
email = os.environ.get("ICLOUD_EMAIL", "")
pw = os.environ.get("ICLOUD_APP_PW", "")
if not email or not pw:
    print("CONN"); sys.exit(0)
try:
    M = imaplib.IMAP4_SSL("imap.mail.me.com", 993)
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
    /// A URL-transport MCP: probe endpoint reachability.
    HttpReachable,
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
    // A URL-transport MCP can at least be reached.
    if emit_url(&connector.emit_json).is_some() {
        return ProbeKind::HttpReachable;
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
    let verdict = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    match verdict {
        "OK" => ProbeOutcome::ok("Signed in to iCloud Mail — the app password works."),
        "AUTH" => ProbeOutcome::expired(
            "iCloud rejected the app-specific password — regenerate it at appleid.apple.com and reconnect.",
        ),
        _ => ProbeOutcome::error("Couldn't reach iCloud Mail (imap.mail.me.com). Check the network and try again."),
    }
}

/// Run the connector's probe against a decrypted credential field-map (env-var name
/// → value), returning the honest verdict. Never panics; a probe that cannot run
/// degrades to `error` (or `untestable`), never to a fake `ok`.
pub async fn run_probe(connector: &Connector, secrets: &BTreeMap<String, String>) -> ProbeOutcome {
    match probe_kind(connector) {
        ProbeKind::ImapAppPassword => imap_probe(secrets).await,
        ProbeKind::HttpReachable => http_probe(&connector.emit_json).await,
        ProbeKind::Untestable => ProbeOutcome::untestable(
            "This connector type can't be tested automatically — supermux can't verify its credential without running it.",
        ),
    }
}

/// The IMAP login probe: run [`IMAP_PROBE_PY`] under `python3` with the two iCloud
/// fields injected as ENV (never argv/logs), bounded by a hard timeout.
async fn imap_probe(secrets: &BTreeMap<String, String>) -> ProbeOutcome {
    let email = secrets.get(icloud::ENV_EMAIL).cloned().unwrap_or_default();
    let pw = secrets.get(icloud::ENV_APP_PW).cloned().unwrap_or_default();
    if email.trim().is_empty() || pw.trim().is_empty() {
        return ProbeOutcome::error("No stored iCloud credential to test — reconnect the account.");
    }

    let mut cmd = tokio::process::Command::new("python3");
    cmd.arg("-c")
        .arg(IMAP_PROBE_PY)
        .env("ICLOUD_EMAIL", email)
        .env("ICLOUD_APP_PW", pw)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    match tokio::time::timeout(Duration::from_secs(15), cmd.output()).await {
        Ok(Ok(out)) => classify_imap(&String::from_utf8_lossy(&out.stdout)),
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "icloud test: could not spawn python3 probe");
            ProbeOutcome::error("Couldn't run the connection test on the server.")
        }
        Err(_) => ProbeOutcome::error("The iCloud connection test timed out."),
    }
}

/// The reachability probe for a URL-transport MCP: a bounded GET. Any HTTP response
/// (including 4xx) counts as reachable → `ok`; a transport failure → `error`.
async fn http_probe(emit_json: &str) -> ProbeOutcome {
    let Some(url) = emit_url(emit_json) else {
        return ProbeOutcome::untestable("This connector has no reachable URL to test.");
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("supermux-connector-health/1")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = %e, "http test: client build failed");
            return ProbeOutcome::error("Couldn't run the connection test on the server.");
        }
    };
    match client.get(&url).send().await {
        // Any HTTP status means the endpoint answered — it is up and reachable.
        Ok(_) => ProbeOutcome::ok("Endpoint is reachable."),
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

        // A URL-transport MCP → reachability.
        let url = connector("remote-mcp", json!({ "url": "https://mcp.example.com/sse" }));
        assert_eq!(probe_kind(&url), ProbeKind::HttpReachable);

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
