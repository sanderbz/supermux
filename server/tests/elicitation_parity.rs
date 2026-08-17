//! **The MCP-elicitation parity contract — Rust half.**
//!
//! Twin of `web/tests/unit/chat-elicitation-parity.test.ts`. Both read the SAME
//! corpus, `tests/fixtures/hooks/elicitation.jsonl`, whose rows are `Elicitation`
//! hook payloads in Claude Code 2.1.227's documented shape together with the
//! typed form each must become and the exact complaint each value set must
//! raise.
//!
//! Why a shared file rather than two suites — the same argument as
//! `state_parity.rs`: the form is validated TWICE. The browser validates while
//! somebody types (a required field that only fails on submit is a form nobody
//! finishes), and the server validates again before an answer could ever be
//! delivered to a third-party MCP server. Neither language errors when the two
//! drift, and a "This field is required" that one plane enforces and the other
//! does not is a card that says the answer went through when it did not.
//!
//! Every row here FAILED before the hook-form wave, in the strongest sense
//! available: `Elicitation` was not in the installed hook set at all, so no
//! plane in this codebase had ever seen one of these payloads.

use std::path::PathBuf;

use serde_json::{Map, Value};
use supermux_server::sessions::elicitation::{self, ElicitationAsk};

/// The corpus, minus its leading documentation object.
fn corpus() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/hooks/elicitation.jsonl");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let rows: Vec<Value> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("bad JSONL line: {e}")))
        .filter(|v: &Value| v.get("_").is_none())
        .collect();
    assert!(
        rows.len() >= 7,
        "the corpus is the contract — it must not shrink (got {})",
        rows.len()
    );
    rows
}

fn ask_of(row: &Value) -> Option<ElicitationAsk> {
    elicitation::parse(&row["payload"])
}

#[test]
fn every_payload_parses_to_the_ask_the_corpus_records() {
    for row in corpus() {
        let name = row["name"].as_str().unwrap();
        let got = ask_of(&row);
        let Some(want) = row["expect"].as_object() else {
            // `expect: null` — the ask must be REFUSED. An unattributed
            // third-party prompt has no safe rendering.
            assert!(got.is_none(), "{name}: must be refused, got {got:?}");
            continue;
        };
        let got = got.unwrap_or_else(|| panic!("{name}: should parse"));
        for (key, value) in want {
            match key.as_str() {
                "fields" => continue,
                _ => {
                    let mine = serde_json::to_value(&got).unwrap();
                    assert_eq!(mine.get(key), Some(value), "{key} mismatch — {name}");
                }
            }
        }
    }
}

#[test]
fn every_recorded_field_key_is_on_the_wire_with_that_exact_value() {
    // `expect.fields[i]` is a SUBSET per field: the row names the facts a form
    // renderer needs and says nothing about the rest, so a new key never breaks
    // the corpus but a dropped one always does. The ORDER is asserted whole —
    // a form whose controls move between renders cannot be filled in twice.
    for row in corpus() {
        let name = row["name"].as_str().unwrap();
        let Some(want_fields) = row["expect"].get("fields").and_then(Value::as_array) else {
            continue;
        };
        let got = ask_of(&row).unwrap_or_else(|| panic!("{name}: should parse"));
        let mine = serde_json::to_value(&got.fields).unwrap();
        let mine = mine.as_array().unwrap();
        assert_eq!(mine.len(), want_fields.len(), "field count — {name}");
        for (i, want) in want_fields.iter().enumerate() {
            for (key, value) in want.as_object().unwrap() {
                let got = mine[i].get(key);
                assert!(
                    got.is_some_and(|g| same(g, value)),
                    "fields[{i}].{key} mismatch — {name}: got {got:?}, want {value} \
                     (whole field: {})",
                    mine[i]
                );
            }
        }
    }
}

#[test]
fn every_value_set_raises_exactly_the_complaints_the_corpus_records() {
    for row in corpus() {
        let name = row["name"].as_str().unwrap();
        let Some(cases) = row.get("cases").and_then(Value::as_array) else {
            continue;
        };
        let Some(ask) = ask_of(&row) else { continue };
        for case in cases {
            let why = case["why"].as_str().unwrap();
            let content: Map<String, Value> = case["content"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            let got: Vec<(String, String)> = elicitation::validate(&ask.fields, &content)
                .into_iter()
                .map(|p| (p.field, p.message))
                .collect();
            let want: Vec<(String, String)> = case["problems"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| {
                    (
                        p[0].as_str().unwrap().to_string(),
                        p[1].as_str().unwrap().to_string(),
                    )
                })
                .collect();
            assert_eq!(got, want, "{name} — {why}");
        }
    }
}

/// JSON equality, except that a bound reaches the wire as an `f64` — `5.0`
/// where the corpus writes `5`. Both planes read it as the same number
/// (`JSON.parse("5.0") === 5`), so the corpus is written the way a schema author
/// writes it and the comparison is the one that matters.
fn same(got: &Value, want: &Value) -> bool {
    match (got.as_f64(), want.as_f64()) {
        (Some(a), Some(b)) => a == b,
        _ => got == want,
    }
}

/// A corpus rots by losing its adversarial rows while still passing. These four
/// carry the findings, so they are named.
#[test]
fn the_corpus_still_covers_the_cases_that_carry_the_finding() {
    let rows = corpus();
    assert!(
        rows.iter().any(|r| r["expect"].is_null()),
        "no unattributed-ask row — the one payload that must be REFUSED"
    );
    assert!(
        rows.iter().any(|r| {
            r["expect"]["fields"]
                .as_array()
                .is_some_and(|f| f.iter().any(|x| x["kind"] == "unsupported"))
        }),
        "no unrenderable-property row"
    );
    assert!(
        rows.iter().any(|r| {
            r["expect"]["fields"]
                .as_array()
                .is_some_and(|f| f.is_empty())
        }),
        "no schema-less confirmation row"
    );
    let all_cases: Vec<&Value> = rows
        .iter()
        .filter_map(|r| r.get("cases").and_then(Value::as_array))
        .flatten()
        .collect();
    assert!(
        all_cases.iter().any(|c| c["content"]
            .as_object()
            .is_some_and(|o| o.values().any(|v| v == &Value::Bool(false) || v == &Value::from(0)))),
        "no false/zero row — the values a naive `if (!value)` would call blank"
    );
}
