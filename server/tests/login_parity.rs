//! **The /login classification parity contract — Rust half.**
//!
//! Twin of `web/tests/unit/login-lens-parity.test.ts`. Both read the SAME corpus
//! — `tests/fixtures/login/cases.jsonl` plus the capture files beside it — and
//! assert the same `(stage, flow, url, options, message, email)` reading for
//! every case.
//!
//! Why the corpus is shared rather than duplicated: `/login` is detected TWICE
//! in this codebase, once server-side (`sessions::login::read_login`, which is
//! what makes the roster dot honest and what the freeze hangs off) and once
//! client-side (`web/src/components/chat/login-lens.ts`, which draws the card).
//! Neither is exhaustive — both fall through to "no login here" by design, so
//! that a Claude Code release which reworded a line degrades to the ordinary
//! terminal instead of to a card that answers the wrong prompt. The cost of that
//! design is that a shape taught to one plane and forgotten on the other
//! compiles clean in both languages and is invisible until a user is stuck at a
//! sign-in screen on a phone.
//!
//! The three `negative-*` cases are the point of the file as much as the
//! positives are: a login in the SCROLLBACK, a login the assistant is talking
//! ABOUT, and an ordinary idle composer must all read as no login at all.

use std::path::PathBuf;

use serde_json::Value;
use supermux_server::sessions::login::{read_login, read_provider_auth, reassemble_url, Stage};
use supermux_server::sessions::status::{Status, StatusDetector, TurnState};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/login")
}

fn corpus() -> Vec<Value> {
    let path = fixtures().join("cases.jsonl");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
    let rows: Vec<Value> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("bad JSONL line {l:?}: {e}")))
        .filter(|v: &Value| v.get("_").is_none())
        .collect();
    assert!(
        rows.len() >= 18,
        "the corpus is the contract — it must not shrink (got {})",
        rows.len()
    );
    rows
}

fn capture(row: &Value) -> String {
    let file = row["file"].as_str().expect("case has a file");
    std::fs::read_to_string(fixtures().join(file)).unwrap_or_else(|e| panic!("read {file}: {e}"))
}

fn name(row: &Value) -> &str {
    row["name"].as_str().unwrap()
}

#[test]
fn every_case_classifies_exactly_as_the_corpus_says() {
    for row in corpus() {
        let cap = capture(&row);
        let got = read_login(&cap);
        let want_stage = row["stage"].as_str();

        match (want_stage, &got) {
            (None, Some(s)) => panic!(
                "{}: expected NO login sighting, got {:?}",
                name(&row),
                s.stage
            ),
            (Some(w), None) => panic!("{}: expected stage {w}, got no sighting", name(&row)),
            (None, None) => continue,
            (Some(w), Some(s)) => {
                assert_eq!(s.stage.as_str(), w, "{}: stage", name(&row));
                if let Some(f) = row["flow"].as_str() {
                    assert_eq!(s.flow.as_str(), f, "{}: flow", name(&row));
                }
                match row.get("url").and_then(Value::as_str) {
                    Some(u) => assert_eq!(s.url.as_deref(), Some(u), "{}: url", name(&row)),
                    None => assert_eq!(s.url, None, "{}: url should be absent", name(&row)),
                }
                if let Some(opts) = row.get("options").and_then(Value::as_array) {
                    let want: Vec<&str> = opts.iter().map(|o| o.as_str().unwrap()).collect();
                    assert_eq!(s.options, want, "{}: options", name(&row));
                }
                if let Some(m) = row.get("message").and_then(Value::as_str) {
                    assert_eq!(s.message.as_deref(), Some(m), "{}: message", name(&row));
                }
                if let Some(e) = row.get("email").and_then(Value::as_str) {
                    assert_eq!(s.email.as_deref(), Some(e), "{}: email", name(&row));
                }
            }
        }
    }
}

/// The URL is what the whole card is for, and it arrives hard-wrapped by a grid
/// whose width nothing records. Every width in the corpus must rebuild the exact
/// same string — including 52, which is what a phone in portrait gives you.
#[test]
fn the_url_survives_every_wrap_width_byte_for_byte() {
    let mut seen: Vec<(String, String)> = Vec::new();
    for row in corpus() {
        let Some(want) = row.get("url").and_then(Value::as_str) else {
            continue;
        };
        // Through the real path (`read_login`), not the raw helper: one of these
        // captures is the colour-true channel, and stripping is part of the
        // contract rather than something the caller is expected to remember.
        let got = read_login(&capture(&row))
            .and_then(|s| s.url)
            .unwrap_or_else(|| panic!("{}: no URL reassembled at all", name(&row)));
        assert_eq!(got, want, "{}: reassembled URL", name(&row));
        seen.push((name(&row).to_string(), got));
    }
    // The account flow's URL is the same string at every width; the design flow
    // differs by one scope. Both must be represented, and there must be more
    // than one width in the file or this test proves nothing.
    assert!(
        seen.len() >= 5,
        "the wrap-width sweep needs several widths, got {seen:?}"
    );
}

/// A URL that ends exactly at the right margin is followed by whatever the TUI
/// drew next. Each of the four shapes that CAN be told apart from a wrap must
/// close the join.
///
/// (The fifth shape — a bare unindented single word of URL characters — cannot
/// be told apart from a wrap by anything in the grid, and `reassemble_url`'s
/// doc-comment says so. Asserting otherwise would be asserting a lie.)
#[test]
fn reassembly_stops_at_every_row_a_wrap_could_not_have_produced() {
    let width = 40;
    let url = "https://claude.com/cai/oauth/authorize?a=1";
    let base: Vec<String> = url
        .as_bytes()
        .chunks(width)
        .map(|c| String::from_utf8(c.to_vec()).unwrap())
        .collect();
    // Pad the last row to the margin: that is what makes the NEXT row a
    // candidate continuation at all.
    let mut rows = base.clone();
    let last = rows.len() - 1;
    while rows[last].len() < width {
        rows[last].push('x');
    }
    let full = format!("{}{}", &url[..], "x".repeat(rows[last].len() - (url.len() % width)));

    for stopper in [
        "",                             // a blank row
        "  indented continuation",      // the TUI's next element
        "two words",                    // prose
        "❯ ",                           // the composer
    ] {
        let mut with = rows.clone();
        with.push(stopper.into());
        let refs: Vec<&str> = with.iter().map(String::as_str).collect();
        let got = reassemble_url(&refs).unwrap();
        assert_eq!(
            got, full,
            "a row shaped {stopper:?} must close the join, not extend it"
        );
    }
}

/// `claude.ai` is not an authorize host any more. A lens that still allowlists it
/// (and only it) renders a card with no link on it.
#[test]
fn the_authorize_host_is_claude_dot_com() {
    let lines = ["https://claude.ai/oauth/authorize?x=1"];
    assert_eq!(reassemble_url(&lines), None);
    let lines = ["https://claude.com/cai/oauth/authorize?x=1"];
    assert!(reassemble_url(&lines).is_some());
}

/// The other providers. supermux does not DRIVE the other providers' device flows
/// — their lifecycles are their own, and a half-automation that gets the timing
/// wrong is worse than nothing — but a session sitting on one is blocked, and
/// the card has to be able to name it, show the link and show the one-time code.
#[test]
fn a_codex_device_auth_screen_is_detected_and_readable() {
    for row in corpus() {
        let Some(want) = row.get("provider_auth") else {
            continue;
        };
        let got = read_provider_auth(&capture(&row))
            .unwrap_or_else(|| panic!("{}: no provider auth sighting", name(&row)));
        assert_eq!(
            serde_json::to_value(&got).unwrap()["kind"],
            want["kind"],
            "{}: kind",
            name(&row)
        );
        if let Some(u) = want.get("url").and_then(Value::as_str) {
            assert_eq!(got.url.as_deref(), Some(u), "{}: url", name(&row));
        }
        if let Some(c) = want.get("code").and_then(Value::as_str) {
            assert_eq!(got.code.as_deref(), Some(c), "{}: one-time code", name(&row));
        }
        // And a Claude login must never be read as a provider device-auth, or
        // the wrong card is drawn on the one flow this app CAN complete.
        assert!(read_login(&capture(&row)).is_none(), "{}: not a claude login", name(&row));
    }
}

/// The roster dot. Before this feature a session parked on the paste prompt
/// classified through the ordinary banks: no ACTIVE marker, no WAITING marker,
/// no IDLE marker — so it held whatever it was, and after the 15-minute turn
/// safety window lapsed it read a green Idle. It is the most blocked a session
/// can be.
#[test]
fn a_login_screen_reads_as_waiting_not_idle() {
    for row in corpus() {
        let cap = capture(&row);
        let want_waiting = row["waiting"].as_bool().unwrap_or(false);
        let got = StatusDetector::new().detect(
            &cap,
            std::time::Instant::now() - std::time::Duration::from_secs(10),
            TurnState::default(),
            false,
        );
        if want_waiting {
            assert_eq!(got, Status::Waiting, "{}: status", name(&row));
        } else {
            assert_ne!(
                got,
                Status::Waiting,
                "{}: must NOT read as waiting — nothing is blocking",
                name(&row)
            );
        }
    }
}

/// The turn state machine outranks the regex banks, and a `/login` is usually
/// reached FROM a turn that died on a 401 — so an open turn would otherwise pin
/// the session Active while it sits on a credential prompt. The login read has
/// to pre-empt it, the way the user-interrupt marker does.
#[test]
fn a_login_screen_pre_empts_an_open_turn() {
    let cap = capture(&corpus().into_iter().find(|r| name(r) == "paste-prompt-w80").unwrap());
    let mut turn = TurnState::default();
    turn.apply(
        std::time::Instant::now(),
        supermux_server::sessions::status::HookEvent::UserPromptSubmit,
    );
    let got = StatusDetector::new().detect(&cap, std::time::Instant::now(), turn, true);
    assert_eq!(got, Status::Waiting);
}

/// `/design-login` prints the byte-identical prompt string. A card that cannot
/// tell them apart tells the user they are signing in to their account when they
/// are authorising a design credential.
#[test]
fn design_login_is_not_mistaken_for_an_account_login() {
    let rows = corpus();
    let design = rows.iter().find(|r| name(r) == "design-login").unwrap();
    let account = rows.iter().find(|r| name(r) == "paste-prompt-w80").unwrap();
    let d = read_login(&capture(design)).unwrap();
    let a = read_login(&capture(account)).unwrap();
    assert_eq!(d.stage, Stage::PastePrompt);
    assert_eq!(a.stage, Stage::PastePrompt);
    assert_ne!(d.flow, a.flow);
}
