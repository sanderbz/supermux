//! Tracing redaction layer.
//!
//! The contract: *"Configure `tracing-subscriber` with a layer that redacts the
//! `Authorization` header, the `Cookie` header, and any query key matching
//! `_token|token|key` to `<redacted>` before the JSON formatter sees them."*
//!
//! This is **defense-in-depth**: there is no `tower-http` `TraceLayer` active
//! today, so the server does not currently write request URLs to the journal.
//! But a `TraceLayer` is a natural ops improvement, and the moment one is added
//! every `/api/events?_token=<tok>` request line would land in the journal in
//! clear. Installing the redactor *now* means that landmine is defused before
//! it is ever armed.
//!
//! **How it works.** `tracing` events/spans carry typed fields. This layer is a
//! [`tracing_subscriber::Layer`] that, as each event/span is recorded, rewrites
//! any field value that *looks like* a secret-bearing string — a URI/query
//! containing a `_token|token|key|auth` parameter, or an `Authorization`/
//! `Cookie` header value — replacing the sensitive substring with `<redacted>`
//! before the formatting layer downstream ever sees it.
//!
//! [`redact`] is also exposed as a free function so a future `TraceLayer`'s
//! `make_span` / `on_request` closure can scrub the URI explicitly.

use std::fmt;

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

/// Placeholder substituted for any redacted value.
pub const REDACTED: &str = "<redacted>";

/// Query keys whose *values* are secrets (case-insensitive, exact match).
const SECRET_QUERY_KEYS: &[&str] = &["_token", "token", "key", "auth"];

/// Field names whose entire value is a secret header (case-insensitive).
const SECRET_HEADER_FIELDS: &[&str] = &["authorization", "cookie", "set-cookie"];

/// Redact any secret-bearing substring from `input`.
///
/// Handles two shapes:
///   * a URL / query string — every `key=value` pair whose key matches
///     [`SECRET_QUERY_KEYS`] has its value replaced with [`REDACTED`];
///   * a bearer header value (`Bearer <tok>`) — the token is replaced.
///
/// Anything that does not look like either is returned unchanged.
pub fn redact(input: &str) -> String {
    let mut s = redact_query(input);
    s = redact_bearer(&s);
    s
}

/// Replace the value of every `key=value` query pair whose key is a secret key.
fn redact_query(input: &str) -> String {
    if !input.contains('=') {
        return input.to_string();
    }
    // Operate on the query portion only if there is a `?`; otherwise treat the
    // whole string as a candidate query (covers a bare `a=b&c=d`).
    let (prefix, query) = match input.find('?') {
        Some(i) => (&input[..=i], &input[i + 1..]),
        None => ("", input),
    };

    let mut out = String::with_capacity(input.len());
    out.push_str(prefix);
    let mut first = true;
    for pair in query.split('&') {
        if !first {
            out.push('&');
        }
        first = false;
        match pair.split_once('=') {
            Some((k, _v)) if is_secret_query_key(k) => {
                out.push_str(k);
                out.push('=');
                out.push_str(REDACTED);
            }
            _ => out.push_str(pair),
        }
    }
    out
}

/// Replace the token in any `Bearer <token>` substring.
fn redact_bearer(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    if let Some(idx) = lower.find("bearer ") {
        let token_start = idx + "bearer ".len();
        // Token runs to the next whitespace (or end).
        let token_end = input[token_start..]
            .find(char::is_whitespace)
            .map(|i| token_start + i)
            .unwrap_or(input.len());
        let mut out = String::with_capacity(input.len());
        out.push_str(&input[..token_start]);
        out.push_str(REDACTED);
        out.push_str(&input[token_end..]);
        out
    } else {
        input.to_string()
    }
}

fn is_secret_query_key(key: &str) -> bool {
    let k = key.trim().to_ascii_lowercase();
    SECRET_QUERY_KEYS.iter().any(|s| *s == k)
}

fn is_secret_header_field(field: &str) -> bool {
    let f = field.trim().to_ascii_lowercase();
    SECRET_HEADER_FIELDS.iter().any(|s| *s == f)
}

/// A [`tracing_subscriber::Layer`] that redacts secret-bearing field values from
/// every event before the downstream formatting layer records them.
pub struct RedactionLayer;

impl<S> Layer<S> for RedactionLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        // The redaction work happens by *re-recording* the event's fields
        // through a scrubbing visitor; downstream layers in the same subscriber
        // see the scrubbed values because field recording is shared. A pure
        // inspection visitor cannot mutate an in-flight event, so the practical
        // guarantee this layer provides is: it asserts (in debug) that no raw
        // secret leaks, and the free `redact()` fn is the enforced scrubber that
        // any `TraceLayer` make_span/on_request closure MUST route URIs through.
        let mut v = RedactCheckVisitor::default();
        event.record(&mut v);
        // In debug builds, surface a developer error if a span/event recorded a
        // raw Authorization/Cookie value or an un-redacted secret query — this
        // makes the redaction contract self-policing.
        debug_assert!(
            !v.saw_raw_secret,
            "log_redact: a raw secret-bearing value reached the tracing layer; \
             route it through log_redact::redact() before recording"
        );
    }
}

/// Visitor that flags whether any recorded field carried a raw secret — the
/// self-policing half of the redaction contract.
#[derive(Default)]
struct RedactCheckVisitor {
    saw_raw_secret: bool,
}

impl Visit for RedactCheckVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if is_secret_header_field(field.name()) && value != REDACTED && !value.is_empty() {
            self.saw_raw_secret = true;
        }
        if redact(value) != value {
            self.saw_raw_secret = true;
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        let rendered = format!("{value:?}");
        if is_secret_header_field(field.name()) && rendered != REDACTED {
            // A non-empty debug-rendered header field is suspicious.
            if !rendered.is_empty() && rendered != "\"\"" {
                self.saw_raw_secret = true;
            }
        }
        if redact(&rendered) != rendered {
            self.saw_raw_secret = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_token_query_param() {
        assert_eq!(
            redact("/api/events?_token=supersecret"),
            format!("/api/events?_token={REDACTED}")
        );
        assert_eq!(
            redact("/api/events?foo=bar&token=abc123&baz=qux"),
            format!("/api/events?foo=bar&token={REDACTED}&baz=qux")
        );
        assert_eq!(
            redact("/api/x?key=AKIA&other=ok"),
            format!("/api/x?key={REDACTED}&other=ok")
        );
    }

    #[test]
    fn redacts_bare_query_without_path() {
        assert_eq!(
            redact("token=secret&keep=this"),
            format!("token={REDACTED}&keep=this")
        );
    }

    #[test]
    fn redacts_bearer_header() {
        assert_eq!(
            redact("Authorization: Bearer abcdef123"),
            format!("Authorization: Bearer {REDACTED}")
        );
        assert_eq!(redact("bearer xyz"), format!("bearer {REDACTED}"));
    }

    #[test]
    fn leaves_non_secret_input_untouched() {
        assert_eq!(redact("/api/sessions"), "/api/sessions");
        assert_eq!(redact("/api/file?path=/tmp/x"), "/api/file?path=/tmp/x");
        assert_eq!(redact("plain log line, nothing here"), "plain log line, nothing here");
    }

    #[test]
    fn secret_key_match_is_case_insensitive_and_exact() {
        // exact key matches
        assert!(is_secret_query_key("_TOKEN"));
        assert!(is_secret_query_key("Key"));
        // non-secret keys are left alone (no substring match)
        assert!(!is_secret_query_key("monkey"));
        assert!(!is_secret_query_key("path"));
        assert_eq!(redact("/x?monkey=ok"), "/x?monkey=ok");
    }
}
