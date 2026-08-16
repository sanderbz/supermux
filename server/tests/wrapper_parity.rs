//! **The classification parity contract — Rust half.**
//!
//! There are two independent user-line classifiers in this codebase:
//!
//! | plane | classifier |
//! |---|---|
//! | recall (`GET /recall?chat=true`) | `sessions::recall::classify_prompt_body` |
//! | chat WebSocket (what the shipped renderer rides) | `web/src/components/chat/wire-entries.ts::classifyPrompt` |
//!
//! The fabric spine taught only the first one about supermux's own wrappers, so
//! a delegated prompt and a scheduled fire were **invisible** in the renderer
//! that actually ships. Nothing in either language errors when the two disagree:
//! neither `match` on its kind enum is exhaustive — both have a `_` arm — so a
//! wrapper added to one plane and forgotten on the other compiles clean in Rust
//! *and* in TypeScript, demos green on the old plane, and renders nothing on the
//! new one.
//!
//! This corpus is the only guard. It lives in ONE file,
//! `tests/fixtures/chat/supermux-wrappers.jsonl`, and is read by this test and
//! by `web/tests/unit/chat-wrapper-parity.test.ts`. Both assert the same
//! `(kind, label, text)` triple for every line. Adding a wrapper arm to either
//! classifier without adding a corpus line is the drift this exists to catch.

use std::path::PathBuf;

use supermux_server::sessions::recall::{classify_prompt_body, Kind};

/// The corpus, minus its leading documentation object.
fn corpus() -> Vec<serde_json::Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/chat/supermux-wrappers.jsonl");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let rows: Vec<serde_json::Value> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("bad JSONL line {l:?}: {e}")))
        .filter(|v: &serde_json::Value| v.get("_").is_none())
        .collect();
    assert!(
        rows.len() >= 9,
        "the corpus is the contract — it must not shrink below the nine shapes \
         the fase enumerated (got {})",
        rows.len()
    );
    rows
}

/// `Kind` serialises snake_case, which is exactly the vocabulary the TS side
/// uses for `ClassifiedPrompt['kind']` — so the corpus can name kinds once.
fn wire_kind(k: Kind) -> String {
    serde_json::to_value(k).unwrap().as_str().unwrap().to_string()
}

#[test]
fn every_corpus_line_classifies_to_its_recorded_kind_label_and_text() {
    for row in corpus() {
        let name = row["name"].as_str().unwrap();
        let input = row["input"].as_str().unwrap();
        let got = classify_prompt_body(input);

        assert_eq!(
            wire_kind(got.kind),
            row["kind"].as_str().unwrap(),
            "kind mismatch — {name}"
        );
        assert_eq!(
            got.text,
            row["text"].as_str().unwrap(),
            "text mismatch — {name}"
        );
        assert_eq!(
            got.label.as_deref(),
            row.get("label").and_then(|l| l.as_str()),
            "label mismatch — {name}"
        );
    }
}

#[test]
fn the_corpus_survives_flag_matches_what_the_recall_plane_shows_by_default() {
    // `is_user_initiated` is the recall plane's calm-view filter; the TS half
    // asserts the same booleans against `wire-entries.ts`'s survives-filter.
    // The two filters ARE the thing that made the spine invisible, so the
    // corpus pins them together rather than each to itself.
    for row in corpus() {
        let name = row["name"].as_str().unwrap();
        let got = classify_prompt_body(row["input"].as_str().unwrap());
        assert_eq!(
            got.kind.is_user_initiated(),
            row["survives"].as_bool().unwrap(),
            "visibility mismatch — {name}"
        );
    }
}

#[test]
fn a_delegated_and_a_scheduled_prompt_are_user_initiated() {
    // The single assertion the whole parity fix exists for: if either of these
    // ever goes false, a colleague's handoff silently stops reaching the
    // transcript it was addressed to.
    assert!(Kind::Delegation.is_user_initiated());
    assert!(Kind::Schedule.is_user_initiated());
}

#[test]
fn the_corpus_covers_both_wrappers_a_nested_closer_a_pasted_wrapper_and_an_unknown_tag() {
    // A corpus can rot by losing its adversarial lines while still passing.
    // Name the shapes the fase enumerated so deleting one fails loudly.
    let rows = corpus();
    let kinds: Vec<&str> = rows.iter().map(|r| r["kind"].as_str().unwrap()).collect();
    let inputs: Vec<&str> = rows.iter().map(|r| r["input"].as_str().unwrap()).collect();

    assert!(kinds.contains(&"delegation"), "no delegation line");
    assert!(kinds.contains(&"schedule"), "no schedule line");
    assert!(
        inputs.iter().any(|i| i.matches("</supermux-delegation>").count() > 1),
        "no nested-closer line"
    );
    assert!(
        inputs
            .iter()
            .any(|i| i.contains("from=\"ceo\"")),
        "no human-pasted-wrapper line"
    );
    assert!(
        inputs.iter().any(|i| i.starts_with("<some-future-wrapper")),
        "no unknown-future-wrapper line"
    );
}
