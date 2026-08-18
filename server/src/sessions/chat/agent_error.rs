//! **What a blocked agent is, in one place.**
//!
//! Claude Code writes a quota/auth/server failure into the transcript as an
//! ORDINARY assistant line: `message.content` is one text block holding the
//! banner, and the only thing that says it is not prose sits on the LINE, not
//! in the message —
//!
//! ```json
//! {"type":"assistant","error":"rate_limit","isApiErrorMessage":true,
//!  "apiErrorStatus":429,"message":{"model":"<synthetic>",
//!  "content":[{"type":"text","text":"You've hit your session limit · resets 4:40am (Europe/Amsterdam)"}]}}
//! ```
//!
//! Until this module existed the parser read `message.content` and nothing
//! else, so a session that is dead for the next five hours arrived on the wire
//! byte-identical to "You chose Apple!" — green dot, "Idle" header, live
//! composer, no reset time (verify matrix, `limit.hit.*`: six `wrong` verdicts).
//!
//! ## Why the buckets are enumerated rather than "rate limited"
//!
//! The six limit buckets are **not** interchangeable. A 5-hour session limit
//! comes back this afternoon; a weekly limit does not; an Opus/Sonnet limit is
//! answered by `/model`; a usage-credit limit is answered by `/usage-credits`;
//! and Claude Code explicitly disambiguates a SERVER-side throttle from any of
//! them ("not your usage limit"). Collapsing those into one amber pill would
//! tell the reader to wait when the fix is one slash command — so the label map
//! is transcribed from the binary's own (`Kzt`, CC 2.1.227) and the classifier
//! is pinned by a shared fixture the TypeScript twin reads too
//! (`tests/fixtures/chat/claude-states.jsonl`, `agent-error.ts`).
//!
//! ## The reset clause is the whole answer
//!
//! `KZe(e,t) = "You've hit your ${label}${t}"` with `t = " · resets " + s`.
//! That suffix is the only place the "when can I work again" fact exists — the
//! transcript carries no structured field for it — so it is captured verbatim
//! rather than parsed into a timestamp: the string is already a local, tz-named
//! time ("4:40am (Europe/Amsterdam)", "Aug 17, 4am (Europe/Amsterdam)") and
//! re-deriving an instant from it would need CC's own clock and locale.

use serde_json::Value;

/// Coarse class — what KIND of blocked, for styling and for the badge.
pub const CLASS_LIMIT: &str = "limit";
pub const CLASS_THROTTLE: &str = "throttle";
pub const CLASS_AUTH: &str = "auth";
pub const CLASS_API: &str = "api";
pub const CLASS_ERROR: &str = "error";
/// `stop_reason: "refusal"` — the model's safeguards flagged the message and
/// the turn is DEAD. Its own class rather than `api`, because the two need
/// opposite things from the reader: an `api` failure is transient and CC retries
/// it by itself, a refusal never retries and the only way forward is a different
/// message or a different model (catalog `err.safeguards_refusal`, 844 matching
/// issues — it fires on ordinary security, biology and coding work).
pub const CLASS_REFUSAL: &str = "refusal";

/// The reset clause separator CC writes (`" · resets "`, U+00B7).
const RESETS: &str = "· resets ";

/// A classified agent-side failure banner.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AgentErrorInfo {
    /// `limit` | `throttle` | `auth` | `api` | `error`.
    pub class: String,
    /// The limit bucket, when `class == "limit"`: `session_5h`, `weekly`,
    /// `opus`, `sonnet`, `usage_credit`, `model`.
    pub limit: Option<String>,
    /// CC's own noun phrase for the bucket, verbatim (`session limit`,
    /// `weekly limit`, `Fable 5 limit`) — so a bucket this map does not know
    /// yet still shows the reader the words CC used.
    pub label: Option<String>,
    /// The verbatim `· resets …` clause (`4:40am (Europe/Amsterdam)`).
    pub resets_at: Option<String>,
    /// Does this stop the session until a human does something? A quota or an
    /// auth failure does; a 529 retry and a server-side throttle do not.
    pub blocking: bool,
}

/// Classify a banner from its TEXT plus whatever the line's own error fields
/// said. Total: an unrecognised banner is still an `error`, never `None` — the
/// caller has already established that this line IS a failure.
///
/// `error_class` is the transcript's top-level `error` (`rate_limit`,
/// `server_error`, `authentication_failed`, …) and `status` its
/// `apiErrorStatus`. Both are hints: the TEXT wins where they disagree,
/// because the text is what CC decided to show the human and the class is a
/// coarser bucket (a server-side throttle is also `rate_limit`).
pub fn classify(text: &str, error_class: Option<&str>, status: Option<i64>) -> AgentErrorInfo {
    let t = text.trim();
    let lower = t.to_ascii_lowercase();
    let resets_at = reset_clause(t);

    // 1. THE DISAMBIGUATION CC ITSELF MAKES, and the reason this arm is first:
    //    a server-side throttle is a 429 with `error:"rate_limit"` too, and
    //    telling the owner he is out of quota when he is not is the one wrong
    //    answer this whole module exists to avoid.
    if lower.contains("not your usage limit") {
        return AgentErrorInfo {
            class: CLASS_THROTTLE.into(),
            resets_at,
            blocking: false,
            ..Default::default()
        };
    }

    // 1b. THE REFUSAL, checked before the API family because it arrives wearing
    //     that family's clothes: `API Error: {Model}'s safeguards flagged this
    //     message …`, which `lower.starts_with("api error:")` would otherwise
    //     classify as a transient 5xx. It is the opposite of transient — nothing
    //     retries, `stop_reason` was `refusal`, and the turn is over. Before this
    //     the whole line was dropped by the `isApiErrorMessage` path and the
    //     conversation simply stopped under a green Idle dot.
    if is_refusal_text(&lower) {
        return AgentErrorInfo {
            class: CLASS_REFUSAL.into(),
            resets_at,
            // NOT blocking, and the distinction is the useful half of this
            // classification. `blocking` gates the composer — it means "nothing
            // you send will be picked up". Here the opposite is true: sending
            // something else is precisely the remedy (CC's own advice is to edit
            // the last message or switch models with /model). A blanked composer
            // would take the fix away from the person who needs it.
            blocking: false,
            ..Default::default()
        };
    }

    // 2. Auth — dead until a human runs /login in the pty. A chat surface can
    //    never resolve it, so it must say so rather than badge "Error".
    if error_class == Some("authentication_failed") || is_auth_text(&lower) {
        return AgentErrorInfo {
            class: CLASS_AUTH.into(),
            resets_at,
            blocking: true,
            ..Default::default()
        };
    }

    // 3. The quota family.
    if let Some((limit, label)) = limit_bucket(t, &lower) {
        return AgentErrorInfo {
            class: CLASS_LIMIT.into(),
            limit: Some(limit.to_string()),
            label,
            resets_at,
            blocking: true,
        };
    }
    if error_class == Some("rate_limit") {
        // A rate_limit whose copy this map has not seen. Still a limit — and
        // still blocking — just without a bucket to name.
        return AgentErrorInfo {
            class: CLASS_LIMIT.into(),
            resets_at,
            blocking: true,
            ..Default::default()
        };
    }

    // 4. Transient API failures (529 Overloaded, 5xx, connection closed). The
    //    turn is damaged, the session is not blocked.
    if error_class == Some("server_error")
        || status.is_some_and(|s| (500..600).contains(&s))
        || lower.starts_with("api error:")
    {
        return AgentErrorInfo {
            class: CLASS_API.into(),
            resets_at,
            blocking: false,
            ..Default::default()
        };
    }

    AgentErrorInfo {
        class: CLASS_ERROR.into(),
        resets_at,
        blocking: false,
        ..Default::default()
    }
}

/// Read the line-level error fields off a transcript object and, when they say
/// this line is a failure, classify it. `None` for an ordinary assistant line.
///
/// The discriminators are exactly the ones CC sets (`isApiErrorMessage` is the
/// authoritative one; `error` alone is accepted because 2.1.197-era lines carry
/// it without the boolean).
pub fn from_line(obj: &serde_json::Map<String, Value>, text: &str) -> Option<AgentErrorInfo> {
    let flagged = obj
        .get("isApiErrorMessage")
        .or_else(|| obj.get("is_api_error_message"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let class = obj.get("error").and_then(Value::as_str).filter(|s| !s.is_empty());
    let status = obj
        .get("apiErrorStatus")
        .or_else(|| obj.get("api_error_status"))
        .and_then(Value::as_i64);
    if !flagged && class.is_none() && status.is_none() {
        return None;
    }
    Some(classify(text, class, status))
}

/// Classify a failure banner off a line too big to parse (over `MAX_LINE_BYTES`),
/// from its RAW bytes. Same discriminators as [`from_line`], read by substring
/// scan instead of a JSON walk: a 950 KB line is deliberately never handed to
/// serde, so an oversized failure would otherwise reach the wire as a coarse
/// `Kind::Assistant` with a null body — byte-identical to prose — and a
/// quota-blocked session would look healthy (verify matrix, `limit.hit.oversize`).
///
/// `None` for a line that carries none of the failure discriminators, so an
/// ordinary oversized assistant/user line keeps its existing placeholder.
pub fn from_oversize_line(line: &str) -> Option<AgentErrorInfo> {
    let flagged = line.contains("\"isApiErrorMessage\":true")
        || line.contains("\"is_api_error_message\":true");
    let class = scan_string(line, "error");
    let status = scan_i64(line, "apiErrorStatus").or_else(|| scan_i64(line, "api_error_status"));
    if !flagged && class.is_none() && status.is_none() {
        return None;
    }
    // The banner text (`message.content[0].text`) holds the bucket + reset copy;
    // a bounded scan is enough — the banner is short even when `errorDetails`
    // is what pushed the line over the cap.
    let text = scan_string(line, "text").unwrap_or_default();
    Some(classify(&text, class.as_deref(), status))
}

/// Read a bounded `"<key>":"<value>"` string out of raw bytes (first hit). The
/// value is capped in CHARS, not bytes, so a multi-byte value can never be
/// clipped mid-codepoint (the line may be 1 MB and is never fully parsed).
fn scan_string(line: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let i = line.find(&needle)? + needle.len();
    let rest = &line[i..];
    let end = rest.find('"')?;
    let val: String = rest[..end].chars().take(512).collect();
    (!val.is_empty()).then_some(val)
}

/// Read a bounded `"<key>":<number>` integer out of raw bytes (first hit).
fn scan_i64(line: &str, key: &str) -> Option<i64> {
    let needle = format!("\"{key}\":");
    let i = line.find(&needle)? + needle.len();
    let rest = line[i..].trim_start();
    let end = rest
        .find(|c: char| !c.is_ascii_digit() && c != '-')
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// `"… · resets 4:40am (Europe/Amsterdam)"` → `Some("4:40am (Europe/Amsterdam)")`.
fn reset_clause(text: &str) -> Option<String> {
    let at = text.find(RESETS)? + RESETS.len();
    let rest = text[at..].trim();
    let clause = rest.lines().next().unwrap_or(rest).trim();
    (!clause.is_empty()).then(|| clause.trim_end_matches('.').to_string())
}

/// The two shapes CC's refusal renderer emits, both anchored on the phrase that
/// only a refusal produces. Deliberately NOT anchored on `api error:` alone —
/// that prefix is shared with every transient failure — and deliberately narrow
/// enough that an assistant *explaining* safeguards is not one: the discriminator
/// is CC's own sentence, and the caller has already established from
/// `isApiErrorMessage` that this line is a failure banner rather than prose.
fn is_refusal_text(lower: &str) -> bool {
    lower.contains("safeguards flagged this message")
        || (lower.contains("can't help with this") && lower.contains("start a new session"))
        || (lower.contains("can’t help with this") && lower.contains("start a new session"))
}

fn is_auth_text(lower: &str) -> bool {
    lower.contains("run /login")
        || lower.contains("session expired")
        || lower.contains("session has expired")
        || lower.contains("401 invalid api key")
        || lower.contains("sign in again")
}

/// The bucket + CC's own noun phrase, from the banner copy.
///
/// Two templates produce the whole family:
///   `You've hit your {label}[ · resets {t}]`   (KZe + the Kzt label map)
///   `You've reached your {model} limit. …`     (the model-scoped variant)
/// plus the credit-exhaustion copy, which does not use "hit your … limit" at
/// all and so needs its own tokens.
fn limit_bucket(text: &str, lower: &str) -> Option<(&'static str, Option<String>)> {
    // Credit exhaustion first: "You're out of usage credits" carries no "limit"
    // noun, and "monthly spend limit" is a credit limit rather than a plan one.
    if lower.contains("out of usage credit")
        || lower.contains("monthly spend limit")
        || lower.contains("requires usage credits")
        || lower.contains("usage credits are required")
        || lower.contains("out of usage ")
        || lower.contains("usage allocation has been disabled")
    {
        return Some(("usage_credit", None));
    }

    let label = noun_phrase(text)?;
    let l = label.to_ascii_lowercase();
    let bucket = if l.starts_with("session limit") {
        "session_5h"
    } else if l.starts_with("weekly limit") {
        "weekly"
    } else if l.starts_with("opus limit") {
        "opus"
    } else if l.starts_with("sonnet limit") {
        "sonnet"
    } else if l.starts_with("usage credit limit") {
        "usage_credit"
    } else {
        // `seven_day_overage_included` renders the MODEL's name ("Fable 5
        // limit"), and CC resolves some buckets at runtime — so an unknown
        // noun phrase is a model-scoped limit carrying its own words, not an
        // unknown error.
        "model"
    };
    Some((bucket, Some(label)))
}

/// The `{label}` slot of the two banner templates, verbatim and clipped at the
/// clause that follows it.
fn noun_phrase(text: &str) -> Option<String> {
    const HEADS: [&str; 4] = [
        "You've hit your ",
        "You’ve hit your ",
        "You've reached your ",
        "You’ve reached your ",
    ];
    let (_, rest) = HEADS.iter().find_map(|h| text.split_once(h))?;
    // The label ends at the reset clause, at the sentence, or at the line.
    let mut end = rest.len();
    for stop in [" ·", " \u{00b7}", ". ", "\n"] {
        if let Some(i) = rest.find(stop) {
            end = end.min(i);
        }
    }
    let label = rest[..end].trim().trim_end_matches('.').trim();
    // "limit" is the noun every template ends on; a slot without it is not one
    // of these banners (`You've hit your stride`).
    if label.is_empty() || !label.to_ascii_lowercase().ends_with("limit") {
        return None;
    }
    Some(label.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_five_hour_banner_names_its_bucket_and_keeps_the_reset_clause() {
        let got = classify(
            "You've hit your session limit · resets 4:40am (Europe/Amsterdam)",
            Some("rate_limit"),
            Some(429),
        );
        assert_eq!(got.class, CLASS_LIMIT);
        assert_eq!(got.limit.as_deref(), Some("session_5h"));
        assert_eq!(got.label.as_deref(), Some("session limit"));
        assert_eq!(got.resets_at.as_deref(), Some("4:40am (Europe/Amsterdam)"));
        assert!(got.blocking);
    }

    #[test]
    fn a_server_side_throttle_is_not_a_quota_hit() {
        // CC writes this with the SAME error class and status as a real quota
        // hit and then says in prose that it is not one. Reading the class and
        // ignoring the sentence is how "you are out of quota" gets shown to
        // somebody who is not.
        let got = classify(
            "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
            Some("rate_limit"),
            Some(429),
        );
        assert_eq!(got.class, CLASS_THROTTLE);
        assert_eq!(got.limit, None);
        assert!(!got.blocking, "a throttle clears on its own");
    }

    #[test]
    fn an_unknown_bucket_keeps_ccs_own_words() {
        let got = classify(
            "You've hit your Fable 5 limit · resets Aug 17, 4am (Europe/Amsterdam)",
            Some("rate_limit"),
            Some(429),
        );
        assert_eq!(got.limit.as_deref(), Some("model"));
        assert_eq!(got.label.as_deref(), Some("Fable 5 limit"));
        assert_eq!(got.resets_at.as_deref(), Some("Aug 17, 4am (Europe/Amsterdam)"));
    }

    #[test]
    fn line_level_fields_are_what_makes_a_banner_a_banner() {
        let plain: serde_json::Map<String, Value> =
            serde_json::from_str(r#"{"type":"assistant"}"#).unwrap();
        assert!(from_line(&plain, "You chose Apple!").is_none());

        let flagged: serde_json::Map<String, Value> = serde_json::from_str(
            r#"{"type":"assistant","error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429}"#,
        )
        .unwrap();
        let got = from_line(&flagged, "You've hit your weekly limit · resets 2pm (Europe/Amsterdam)")
            .expect("a flagged line is a banner");
        assert_eq!(got.limit.as_deref(), Some("weekly"));
    }

    #[test]
    fn from_oversize_line_recovers_the_block_from_raw_bytes() {
        // #7 (HIGH): the same banner reduced by size-truncation. from_oversize_line
        // reads the discriminators + banner text out of raw bytes (no serde), so
        // an oversized failure keeps its class/bucket/reset instead of degrading
        // to prose.
        let banner = "You've hit your session limit \u{00b7} resets 4:40am (Europe/Amsterdam)";
        let line = format!(
            r#"{{"type":"assistant","error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,"message":{{"content":[{{"type":"text","text":"{banner}"}}]}},"errorDetails":"{}"}}"#,
            "x".repeat(4096)
        );
        let got = from_oversize_line(&line).expect("a flagged oversized line is a banner");
        assert_eq!(got.class, CLASS_LIMIT);
        assert!(got.blocking);
        assert_eq!(got.limit.as_deref(), Some("session_5h"));
        assert_eq!(got.resets_at.as_deref(), Some("4:40am (Europe/Amsterdam)"));

        // A throttle wearing the same 429/rate_limit clothes must NOT be blocking.
        let throttle = r#"{"type":"assistant","error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,"message":{"content":[{"type":"text","text":"API Error: temporarily limiting requests (not your usage limit)"}]}}"#;
        assert!(!from_oversize_line(throttle).unwrap().blocking);

        // No discriminators → not a banner, so ordinary oversized prose is left alone.
        let prose = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"here is a long answer"}]}}"#;
        assert!(from_oversize_line(prose).is_none());

        // A rate_limit whose banner text is beyond the 512-char scan window is
        // still blocking from the class alone.
        let no_text = r#"{"type":"assistant","error":"rate_limit","isApiErrorMessage":true}"#;
        let got = from_oversize_line(no_text).expect("flagged");
        assert_eq!(got.class, CLASS_LIMIT);
        assert!(got.blocking);
    }

    #[test]
    fn a_safeguards_refusal_is_a_dead_turn_and_not_a_retryable_api_error() {
        let got = classify(
            "API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Fable 5.",
            None,
            None,
        );
        assert_eq!(got.class, CLASS_REFUSAL);
        // The composer must stay live: sending something ELSE is the remedy.
        assert!(!got.blocking);
        // The second form of the same builder.
        assert_eq!(
            classify(
                "API Error: Fable 5 can't help with this. Start a new session to continue.",
                None,
                None
            )
            .class,
            CLASS_REFUSAL
        );
    }

    #[test]
    fn an_ordinary_api_error_is_still_an_api_error() {
        // The refusal arm sits in front of the API arm, so this is the control:
        // the prefix they share must not drag a 529 into the refusal class.
        let got = classify(
            "API Error: 529 {\"type\":\"overloaded_error\"}",
            Some("server_error"),
            Some(529),
        );
        assert_eq!(got.class, CLASS_API);
    }

    #[test]
    fn prose_that_merely_mentions_a_limit_is_not_classified_as_one() {
        // `noun_phrase` is anchored on CC's template and ends on the word
        // "limit" — otherwise an assistant explaining rate limits to the user
        // would blank the composer.
        assert_eq!(classify("You've hit your stride today", None, None).class, CLASS_ERROR);
        let plain: serde_json::Map<String, Value> =
            serde_json::from_str(r#"{"type":"assistant"}"#).unwrap();
        assert!(from_line(&plain, "You've hit your weekly limit").is_none());
    }
}
