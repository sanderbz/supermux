//! **The Claude-state parity contract — Rust half.**
//!
//! Twin of `web/tests/unit/chat-state-parity.test.ts`. Both read the SAME
//! corpus, `tests/fixtures/chat/claude-states.jsonl`, whose rows are verbatim
//! Claude Code payloads captured off this box together with what each plane
//! must make of them.
//!
//! Why a shared file rather than two suites, the same argument as
//! `wrapper_parity.rs`: the limit taxonomy is classified TWICE — the server
//! stamps it onto the wire entry from the transcript line, and the client
//! re-derives it from a `StopFailure` banner for the roster badge — and neither
//! language errors when the two drift. Before this corpus existed the six limit
//! buckets were classified by nobody at all: a session that was dead for the
//! next five hours arrived on the wire as `{kind:'assistant'}` and rendered
//! byte-identically to "You chose Apple!".
//!
//! Every row here FAILED before the states fix and passes after it. Adding a
//! state to either plane without adding a row is the drift this exists to
//! catch.

use std::path::PathBuf;

use serde_json::Value;
use supermux_server::sessions::chat::parser::{parse_line, ParsedLine};

/// The corpus, minus its leading documentation object.
fn corpus() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/chat/claude-states.jsonl");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let rows: Vec<Value> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("bad JSONL line: {e}")))
        .filter(|v: &Value| v.get("_").is_none())
        .collect();
    assert!(
        rows.len() >= 22,
        "the corpus is the contract — it must not shrink (got {})",
        rows.len()
    );
    rows
}

/// The FIRST entry of the row's line, which is the one every expectation is
/// written about (each corpus line carries exactly one interesting block).
fn parse_row(row: &Value) -> supermux_server::sessions::chat::model::ChatEntry {
    let name = row["name"].as_str().unwrap();
    let line = serde_json::to_string(&row["line"]).unwrap();
    match parse_line(&line, 0) {
        ParsedLine::Entry(mut e) => {
            assert!(!e.is_empty(), "{name}: produced no entry");
            e.remove(0)
        }
        other => panic!("{name}: not an entry — {other:?}"),
    }
}

#[test]
fn every_corpus_line_parses_to_its_recorded_kind_label_and_status() {
    for row in corpus() {
        let name = row["name"].as_str().unwrap();
        let want = &row["expect"];
        let got = parse_row(&row);

        let kind = serde_json::to_value(got.kind).unwrap();
        assert_eq!(
            kind.as_str().unwrap(),
            want["kind"].as_str().unwrap(),
            "kind mismatch — {name}"
        );
        if let Some(label) = want.get("label").and_then(Value::as_str) {
            assert_eq!(got.label.as_deref(), Some(label), "label mismatch — {name}");
        }
        if let Some(ok) = want.get("ok").and_then(Value::as_bool) {
            assert_eq!(got.ok, Some(ok), "ok mismatch — {name}");
        }
    }
}

#[test]
fn every_recorded_body_key_is_on_the_wire_with_that_exact_value() {
    // `expect.body` is a SUBSET: the row names the facts a surface needs and
    // says nothing about the rest, so a new body key never breaks the corpus
    // but a dropped one always does.
    for row in corpus() {
        let name = row["name"].as_str().unwrap();
        let Some(want) = row["expect"].get("body").and_then(Value::as_object) else {
            continue;
        };
        let got = parse_row(&row);
        for (key, value) in want {
            assert_eq!(
                got.body.get(key),
                Some(value),
                "body.{key} mismatch — {name} (whole body: {})",
                got.body
            );
        }
    }
}

#[test]
fn the_corpus_still_covers_every_limit_bucket_and_its_two_impostors() {
    // A corpus can rot by losing its adversarial rows while still passing. The
    // buckets are NOT interchangeable — waiting is the wrong answer to four of
    // the six — so name them, and name the two shapes that must not be read as
    // quota hits.
    let rows = corpus();
    let buckets: Vec<&str> = rows
        .iter()
        .filter_map(|r| r["expect"]["body"].get("limit").and_then(Value::as_str))
        .collect();
    for want in ["session_5h", "weekly", "opus", "model", "usage_credit"] {
        assert!(buckets.contains(&want), "no {want} limit row");
    }
    let classes: Vec<&str> = rows
        .iter()
        .filter_map(|r| r["expect"]["body"].get("class").and_then(Value::as_str))
        .collect();
    assert!(
        classes.contains(&"throttle"),
        "no server-side-throttle row — the state CC explicitly says is NOT your limit"
    );
    assert!(classes.contains(&"auth"), "no auth-death row");
    assert!(
        rows.iter()
            .any(|r| r["name"].as_str().unwrap().contains("merely talks about limits")),
        "no prose-that-mentions-a-limit control"
    );
    assert!(
        rows.iter()
            .any(|r| r["name"].as_str().unwrap().contains("quotes the refusal")),
        "no quoted-refusal control"
    );
}

#[test]
fn a_blocking_banner_is_marked_blocking_and_a_transient_one_is_not() {
    // The single bit the composer, the tile and the attention tier all read.
    // Getting it backwards on the throttle row would blank a working session's
    // composer for a condition that clears itself in seconds.
    for row in corpus() {
        let name = row["name"].as_str().unwrap();
        let Some(want) = row["expect"]["body"].get("blocked").and_then(Value::as_bool) else {
            continue;
        };
        let got = parse_row(&row);
        assert_eq!(
            got.body.get("blocked").and_then(Value::as_bool),
            Some(want),
            "blocked mismatch — {name}"
        );
    }
}
