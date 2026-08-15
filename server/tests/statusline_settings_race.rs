//! **The two writers of `~/.claude/settings.json` must not clobber each other.**
//!
//! INTEGRATION REGRESSION — this interaction only exists once the hardening
//! branch and the A2 chat data plane are in the same tree, so neither branch
//! could have tested it:
//!
//!   * hardening made `claude_config`'s installer take a per-path write lock,
//!     because the merge is read→modify→write and `install_hooks` runs on every
//!     session start from independent tasks (HTTP start, scheduler, board
//!     dispatch, teams);
//!   * A2 added a SECOND writer against that very same file — the opt-in
//!     statusline tap, which wraps the `statusLine` key — and it went through
//!     `read_settings_or_empty` + `atomic_write_json` WITHOUT that lock.
//!
//! Interleaved, the loser's merge is discarded by the winner's rename. Both
//! outcomes are user-visible damage: a session boots with no `hooks` at all (the
//! turn state machine goes dark and the dashboard falls back to PTY guessing),
//! or the tap's wrapper disappears while its sidecar records it as installed —
//! and the next uninstall then deletes that sidecar, i.e. the last copy of the
//! user's own statusline command.
//!
//! The test drives the REAL entry points concurrently against a throwaway
//! `CLAUDE_CONFIG_DIR` and asserts every writer's contribution survived. Single
//! test on purpose: it sets the env var for THIS test binary's process (cargo
//! gives each integration file its own), so there is no cross-test env race.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use supermux_server::claude_config;
use supermux_server::files::transport::LocalFileTransport;
use supermux_server::sessions::chat::statusline;

fn read(path: &PathBuf) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

/// A settings.json with the shape a real user has: their own statusline, plus
/// keys an unlocked writer's stale read would silently drop.
const USER_SETTINGS: &str = r#"{
  "model": "opus",
  "statusLine": { "type": "command", "command": "~/bin/my-statusline" },
  "env": { "MY_VAR": "1" }
}"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_statusline_install_and_a_hook_install_keep_both_merges() {
    let cfg = std::env::temp_dir().join(format!("sm-slrace-cfg-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&cfg).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &cfg);
    let path = cfg.join("settings.json");
    fs::write(&path, USER_SETTINGS).unwrap();

    // Both real entry points, at the same time, against the same file. Six
    // rounds because losing the race is a timing accident: one pass proves
    // nothing, and pre-fix this fails well within them.
    for _ in 0..6 {
        let hooks = tokio::spawn(async {
            claude_config::install_hooks("racer", "tok-racer", &LocalFileTransport, None).await
        });
        let tap = tokio::spawn(async { statusline::install_local(statusline::Mode::Wrap).await });
        hooks.await.unwrap().expect("hook install must succeed");
        tap.await.unwrap().expect("statusline install must succeed");

        let v = read(&path);
        assert!(
            v["hooks"]["PreToolUse"].is_array(),
            "the hook install's merge was lost: {v}"
        );
        assert!(
            v["statusLine"]["command"]
                .as_str()
                .is_some_and(|c| c.contains("supermux")),
            "the statusline tap's merge was lost: {v}"
        );
        assert_eq!(v["model"], serde_json::json!("opus"), "user key lost: {v}");
        assert_eq!(v["env"]["MY_VAR"], serde_json::json!("1"), "user env lost: {v}");

        // Back to the pre-tap state for the next round; the uninstall takes the
        // same lock and must restore the user's own command from the wrapper.
        let out = statusline::uninstall_local().await.expect("uninstall");
        assert!(!out.still_installed, "uninstall left the tap behind");
        let v = read(&path);
        assert_eq!(
            v["statusLine"]["command"],
            serde_json::json!("~/bin/my-statusline"),
            "the user's own statusline was not restored: {v}"
        );
        assert!(
            v["hooks"]["PreToolUse"].is_array(),
            "the uninstall dropped the hooks: {v}"
        );
    }

    // No temp file may outlive the writers — a leftover is a partially-written
    // settings.json sitting next to the real one.
    let leftovers: Vec<String> = fs::read_dir(&cfg)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("supermux-tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");

    fs::remove_dir_all(&cfg).ok();
}
