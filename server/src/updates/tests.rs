//! Unit tests for the updates module that don't need a full HTTP stack.
//! End-to-end JSON-shape tests live in `tests/updates_preflight.rs`.

use super::preflight::{self, BlockedReason, InstallMode};
use super::release::LatestRelease;

#[test]
fn no_latest_release_surfaces_a_clear_reason() {
    let snap = preflight::run_preflight(None);
    assert!(!snap.update_available);
    assert!(
        snap.blocked_reasons
            .iter()
            .any(|r| matches!(r, BlockedReason::NoLatestRelease { .. })),
        "expected NoLatestRelease, got {:?}",
        snap.blocked_reasons
    );
}

#[test]
fn install_mode_serialises_as_tagged_union() {
    // The frontend switches on `kind`. Pin the shape.
    let mode = InstallMode::Systemd { path_unit_present: true };
    let json = serde_json::to_value(&mode).unwrap();
    assert_eq!(json["kind"], "systemd");
    assert_eq!(json["path_unit_present"], true);

    let bare = InstallMode::BareBinary;
    let json = serde_json::to_value(&bare).unwrap();
    assert_eq!(json["kind"], "bare_binary");
}

#[test]
fn blocked_reasons_carry_actionable_messages() {
    // Pin a couple of representative payloads so a refactor can't strip the
    // human-readable copy (the UI renders these verbatim).
    let r = BlockedReason::UncommittedChanges {
        count: 3,
        message: "The clone has 3 uncommitted changes. Commit or stash them.".into(),
    };
    let json = serde_json::to_value(&r).unwrap();
    assert_eq!(json["kind"], "uncommitted_changes");
    assert_eq!(json["count"], 3);
    assert!(json["message"].as_str().unwrap().contains("uncommitted"));

    let r = BlockedReason::ManualUpdateRequired {
        command: "cd /repo && bash scripts/update.sh".into(),
        message: "Run this on the server: `cd /repo && bash scripts/update.sh`".into(),
    };
    let json = serde_json::to_value(&r).unwrap();
    assert_eq!(json["kind"], "manual_update_required");
    assert!(json["command"].as_str().unwrap().contains("update.sh"));

    // NoRepoDir: eligible install but no source clone. The frontend renders the
    // command as a code block (same path as manual_update_required), so pin both
    // the tag and that the command survives serde.
    let r = BlockedReason::NoRepoDir {
        command: "bash scripts/deploy.sh".into(),
        message: "No source clone on the server. Deploy from your workstation: `bash scripts/deploy.sh`.".into(),
    };
    let json = serde_json::to_value(&r).unwrap();
    assert_eq!(json["kind"], "no_repo_dir");
    assert!(json["command"].as_str().unwrap().contains("deploy.sh"));
    assert!(json["message"].as_str().unwrap().contains("clone"));
}

#[test]
fn latest_release_round_trips_via_serde() {
    let rel = LatestRelease {
        tag: "v0.3.0".into(),
        sha: "main".into(),
        body: "- new updater\n- bug fixes".into(),
        html_url: "https://github.com/sanderbz/supermux/releases/tag/v0.3.0".into(),
        published_at: Some("2026-05-28T01:00:00Z".into()),
    };
    let json = serde_json::to_string(&rel).unwrap();
    let parsed: LatestRelease = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, rel);
}

// (GitHub wire-format → `LatestRelease` conversion lives in `release.rs`'s
// `GithubReleaseWire`; tests there pin the field-rename behaviour.)
