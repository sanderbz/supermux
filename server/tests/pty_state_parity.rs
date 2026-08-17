//! **The pty-state parity contract — Rust half.**
//!
//! Twin of `web/tests/unit/pty-state-parity.test.ts`. Both read the SAME corpus,
//! `tests/fixtures/pty/claude-states.jsonl`, and both assert a verdict about the
//! same bytes.
//!
//! Why a shared corpus rather than two suites. There are two independent readers
//! of the live screen in this codebase:
//!
//! | plane | reader | who consumes it |
//! |---|---|---|
//! | server | `sessions::status` + `sessions::pty_state` | the roster, the tiles, push |
//! | web | `components/chat/peek-lens.ts` | the chat surface's cards and composer |
//!
//! Neither can see the other's mistakes. A limit banner taught to one and
//! forgotten on the other compiles clean in both languages, and produces the
//! worst possible outcome for a user: a roster row that says "blocked" beside a
//! chat header that says "Idle" with a green dot — or the reverse. The audit
//! caught the version of this where NEITHER plane knew (verify matrix finding 1,
//! screenshots `05-chat-limits.png` / `06-overview-limits.png`), and the fix is
//! only a fix if both planes keep agreeing.
//!
//! If you teach either reader a new screen, add a row here in the same commit.

use std::path::PathBuf;

use serde_json::Value;
use supermux_server::sessions::pty_state;
use supermux_server::sessions::status::{Status, StatusDetector, TurnState};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pty")
}

/// The corpus, minus its leading documentation object.
fn corpus() -> Vec<Value> {
    let path = fixtures().join("claude-states.jsonl");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("bad JSONL line {l:?}: {e}")))
        .filter(|v: &Value| v.get("_").is_none())
        .collect()
}

fn capture_of(row: &Value) -> String {
    let name = row["capture"].as_str().expect("capture");
    let path = fixtures().join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Classify with a FRESH detector and a heartbeat in the neutral band, so the
/// capture alone decides: a held prior status would mask a non-matching input
/// and give a false pass. `has_hooks = false` because every screen in this
/// corpus is one a session reaches with no live turn — a startup gate has never
/// fired a hook at all, and a limit banner arrives on the turn that just ended.
fn classify(capture: &str, provider: &str) -> Status {
    let mut d = StatusDetector::for_provider(provider);
    let pty = std::time::Instant::now() - std::time::Duration::from_secs(10);
    d.detect(capture, pty, TurnState::default(), false)
}

#[test]
fn the_corpus_is_present_and_covers_the_families_the_audit_named() {
    let rows = corpus();
    assert!(
        rows.len() >= 10,
        "the pty corpus lost rows: {} left",
        rows.len()
    );
    let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    // A corpus rots by losing its adversarial rows while still passing, so the
    // ones that carry the findings are named.
    for want in [
        "ask_user_question",
        "trust_folder",
        "apikey_approval",
        "first_run_onboarding",
        "codex_hooks_review",
        "limit_weekly",
        "limit_used_pct",
        "idle_control",
        // The PTY-07 must-families.
        "session_paused_overage",
        "session_paused_refusal",
        "stream_stalled",
        "safeguards_refusal",
        "armed_esc_clear",
        "armed_ctrl_c",
    ] {
        assert!(ids.contains(&want), "corpus lost `{want}`");
    }
}

#[test]
fn every_row_classifies_to_the_status_the_corpus_records() {
    for row in corpus() {
        let id = row["id"].as_str().unwrap();
        let provider = row.get("provider").and_then(Value::as_str).unwrap_or("claude");
        let want = row["server"]["status"].as_str().unwrap();
        let got = classify(&capture_of(&row), provider);
        assert_eq!(got.as_str(), want, "status for `{id}`");
    }
}

#[test]
fn every_row_reads_the_block_and_the_warning_the_corpus_records() {
    for row in corpus() {
        let id = row["id"].as_str().unwrap();
        let state = pty_state::read(&capture_of(&row));
        let want = &row["server"];

        match want["blocked"].as_object() {
            None => assert_eq!(state.blocked, None, "`{id}` must not read as blocked"),
            Some(exp) => {
                let got = state
                    .blocked
                    .as_ref()
                    .unwrap_or_else(|| panic!("`{id}` should read as blocked"));
                assert_eq!(got.kind, exp["kind"].as_str().unwrap(), "kind for `{id}`");
                assert_eq!(
                    got.wedge,
                    exp.get("wedge").and_then(Value::as_str),
                    "wedge for `{id}`"
                );
                assert_eq!(
                    got.dialog,
                    exp.get("dialog").and_then(Value::as_str),
                    "dialog for `{id}`"
                );
                if let Some(text) = exp.get("text").and_then(Value::as_str) {
                    assert_eq!(got.text, text, "text for `{id}`");
                }
            }
        }

        assert_eq!(
            state.warning.as_deref(),
            want["warning"].as_str(),
            "warning for `{id}`"
        );
        assert_eq!(
            state.stalled.as_deref(),
            want.get("stalled").and_then(Value::as_str),
            "stalled for `{id}`"
        );
    }
}

/// The two paused modals, executable.
///
/// `waiting` is the whole point: a paused session has no `Stop` hook to end its
/// turn, so the machine holds `Active` and then hands it a green `Idle` — the
/// state the catalog describes as "the session sits paused while supermux shows
/// Idle". And the block rides beside the status, like every other condition
/// here, because the roster reads that field.
#[test]
fn a_paused_consent_modal_is_waiting_and_blocked_and_names_which_dialog() {
    let mut seen = 0;
    for row in corpus() {
        let id = row["id"].as_str().unwrap();
        let Some(dialog) = row["server"]["blocked"].get("dialog").and_then(Value::as_str) else {
            continue;
        };
        let capture = capture_of(&row);
        assert_eq!(classify(&capture, "claude"), Status::Waiting, "{id}");
        assert_eq!(pty_state::paused_dialog(&capture), Some(Some(dialog)), "{id}");
        seen += 1;
    }
    assert_eq!(seen, 2, "both paused consent modals stay covered");
}

/// A stalled stream is ACTIVE — the one reading in this file that keeps a
/// session busy rather than making it stop. The turn is live and resumes by
/// itself; the failure being pinned is the surface going quiet under it.
#[test]
fn a_stalled_stream_keeps_the_turn_alive_and_blocks_nothing() {
    let mut seen = 0;
    for row in corpus() {
        let id = row["id"].as_str().unwrap();
        if row["server"].get("stalled").and_then(Value::as_str).is_none() {
            continue;
        }
        let capture = capture_of(&row);
        assert_eq!(classify(&capture, "claude"), Status::Active, "{id}");
        assert!(pty_state::is_stalled(&capture), "{id}");
        assert_eq!(pty_state::read(&capture).blocked, None, "{id}");
        seen += 1;
    }
    assert_eq!(seen, 1, "the stalled row is still in the corpus");
}

/// The negative half of `generic.armed_keys` on this plane: an armed screen is
/// an ORDINARY screen. It must not read as blocked, as a wedge or as a warning —
/// the arming is a fact about the KEYBOARD, and a reader that turned it into a
/// condition would grey out sessions that are working perfectly.
#[test]
fn an_armed_screen_is_not_a_blocked_session() {
    for row in corpus() {
        let id = row["id"].as_str().unwrap();
        if !id.starts_with("armed_") {
            continue;
        }
        let state = pty_state::read(&capture_of(&row));
        assert_eq!(state.blocked, None, "{id}");
        assert_eq!(state.warning, None, "{id}");
    }
}

/// The finding, executable: a limit-hit session reads `idle` AND blocked.
///
/// It is pinned rather than merely allowed, because the temptation on reading
/// this code is to "fix" the status instead — and that fix is unreachable. The
/// hook turn state machine outranks every bank, and a limit-hit turn ends with a
/// `Stop`, so `classify` returns `Idle` for it no matter what the banks learn.
/// The condition has to live beside the status, which is why it does.
#[test]
fn a_limit_hit_session_is_idle_and_blocked_at_the_same_time() {
    for row in corpus() {
        let id = row["id"].as_str().unwrap();
        if !id.starts_with("limit_") || row["server"]["blocked"].is_null() {
            continue;
        }
        let capture = capture_of(&row);
        assert_eq!(classify(&capture, "claude"), Status::Idle, "{id}");
        assert_eq!(
            pty_state::read(&capture).blocked.unwrap().kind,
            "limit",
            "{id}"
        );
    }
}

/// Every startup gate reads `waiting`, and that is the ONLY reason a session
/// parked before its first turn is visible at all: no transcript exists, no hook
/// has fired, and the tile would otherwise read `Starting` → `Idle` forever.
#[test]
fn every_startup_wedge_pre_empts_the_status_to_waiting() {
    let mut seen = 0;
    for row in corpus() {
        let id = row["id"].as_str().unwrap();
        let Some(wedge) = row["server"]["blocked"]
            .get("wedge")
            .and_then(Value::as_str)
        else {
            continue;
        };
        let provider = row.get("provider").and_then(Value::as_str).unwrap_or("claude");
        let capture = capture_of(&row);
        assert_eq!(classify(&capture, provider), Status::Waiting, "{id}");
        assert_eq!(pty_state::startup_wedge(&capture), Some(wedge), "{id}");
        seen += 1;
    }
    assert_eq!(seen, 4, "all four must-priority startup gates stay covered");
}
