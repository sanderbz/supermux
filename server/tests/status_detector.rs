//! Golden-fixture tests for the status detector core.
//!
//! The crown-jewel reliability guarantee: 33 real-shaped `capture-pane`
//! snapshots are each classified to their expected status (encoded in the
//! filename, `<name>.<active|waiting|idle>.txt`), plus 5 corruption fixtures
//! that must be handled WITHOUT panicking. The classifications are also pinned by
//! an `insta` snapshot so the regex bank can never silently regress as it evolves
//! (the snapshot is committed at `tests/snapshots/`).
//!
//! Each fixture is run through `prepare_capture` (ANSI strip + last-30-lines)
//! exactly as the live detector loop does, then `StatusDetector::detect` with a
//! neutral heartbeat so the regex bank — not the PTY fallback — is the decider.

use std::time::{Duration, Instant};

use supermux_server::sessions::status::{prepare_capture, StatusDetector, TurnState};

/// A heartbeat in the neutral band (1.5s–30s): neither the `Active` window nor
/// the idle timeout fires, so a regex-matching fixture is decided solely by the
/// bank and a NON-matching one falls through to `Unknown` (a loud failure).
fn neutral_pty() -> Instant {
    Instant::now() - Duration::from_secs(10)
}

fn classify(capture: &str) -> &'static str {
    let prepared = prepare_capture(capture);
    let mut detector = StatusDetector::new();
    detector.detect(&prepared, neutral_pty(), TurnState::default(), false).as_str()
}

fn fixtures_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/status")
}

/// Read fixture bytes lossily — the binary-garbage corruption fixture is
/// intentionally not valid UTF-8 (the detector must survive lossy-decoded input).
fn read_lossy(path: &std::path::Path) -> String {
    let bytes = std::fs::read(path).expect("read fixture");
    String::from_utf8_lossy(&bytes).into_owned()
}

#[test]
fn golden_fixtures_classify_correctly() {
    let mut paths: Vec<std::path::PathBuf> = std::fs::read_dir(fixtures_dir())
        .expect("fixtures dir")
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("txt"))
        .collect();
    paths.sort();

    let mut table = String::new();
    let (mut golden, mut corrupt) = (0u32, 0u32);

    for path in &paths {
        let fname = path.file_name().unwrap().to_string_lossy().into_owned();
        let stem = fname.strip_suffix(".txt").expect("`.txt` suffix");
        let expected = stem.rsplit('.').next().expect("`<name>.<expected>` form");

        let got = classify(&read_lossy(path));
        table.push_str(&format!("{fname:<44} => {got}\n"));

        match expected {
            "active" | "waiting" | "idle" => {
                golden += 1;
                assert_eq!(got, expected, "fixture `{fname}` misclassified (got `{got}`)");
            }
            "corrupt" => {
                corrupt += 1;
                // Robustness only: any valid status is acceptable for garbage —
                // the contract is "no panic + deterministic" (pinned by insta).
                assert!(
                    matches!(got, "active" | "waiting" | "idle" | "stopped" | "unknown"),
                    "corruption fixture `{fname}` produced an invalid status `{got}`"
                );
            }
            other => panic!("fixture `{fname}` has an unrecognised token `{other}`"),
        }
    }

    assert_eq!(golden, 33, "expected exactly 33 golden fixtures");
    assert_eq!(corrupt, 5, "expected exactly 5 corruption fixtures");

    // Regression guard: pin every classification (committed snapshot).
    insta::assert_snapshot!("golden_classifications", table);
}
