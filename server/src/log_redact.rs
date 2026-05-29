//! Log-redaction primitive.
//!
//! The contract: *"Before any URL/query containing a `_token|token|key|auth`
//! parameter, or an `Authorization: Bearer …` header value, is written to the
//! log stream, route it through [`redact`] so the secret substring is replaced
//! with `<redacted>`."*
//!
//! This is **defense-in-depth**: there is no `tower-http` `TraceLayer` active
//! today, so the server does not currently write request URLs to the journal.
//! But a `TraceLayer` is a natural ops improvement, and the moment one is added
//! every `/api/events?_token=<tok>` request line would land in the journal in
//! clear. Having the scrubber ready *now* means that landmine can be defused
//! the instant the `TraceLayer` is wired up — its `make_span` / `on_request`
//! closure simply pipes the URI through [`redact`].
//!
//! A previous revision shipped a `tracing_subscriber::Layer` that *claimed* to
//! scrub fields in flight. It did not: re-recording an in-flight event's fields
//! through a visitor cannot mutate what downstream layers see, so the layer was
//! a no-op in release builds (only `debug_assert!` fired in debug). It was
//! removed in favour of explicit call sites wrapping sensitive values with
//! [`redact`] — auditable and not load-bearing on tracing internals.

/// Placeholder substituted for any redacted value.
pub const REDACTED: &str = "<redacted>";

/// Query keys whose *values* are secrets (case-insensitive, exact match).
const SECRET_QUERY_KEYS: &[&str] = &["_token", "token", "key", "auth"];

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
