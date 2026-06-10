//! claude_config::install_hooks via FileTransport (remote hook install)
//!
//! Exercises the transport-aware refactor:
//!
//! 1. **Fresh install** through a `MockFileTransport` writes a settings.json
//!    with all 9 supermux marker entries and goes through the atomic-rename
//!    dance (`write(tmp)` → `rename(tmp, final)`).
//! 2. **Idempotent re-install** produces byte-identical content the second
//!    time around (no duplicates, no churn).
//! 3. **Coexistence** with a user's own non-marker hook leaves the foreign
//!    entry untouched and adds supermux's alongside it.
//! 4. **Atomicity transcript**: the mock records the EXACT op sequence
//!    (read → write(tmp) → rename(tmp, final)) so a future regression that
//!    forgets the temp sibling can't sneak through.
//!
//! These tests use a `MockFileTransport` to assert the transport invariants
//! without needing a real remote host. The same install_hooks code path is
//! exercised against `LocalFileTransport` by `claude_config`'s own
//! `#[cfg(test)] mod tests` — that suite is the golden-snapshot regression
//! for the local path and is untouched by the transport-aware refactor.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use supermux_server::claude_config;
use supermux_server::files::transport::{DirEntry, FileTransport, Stat};

/// One transport op the mock recorded, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Op {
    Read(PathBuf),
    Write(PathBuf, Vec<u8>),
    Rename(PathBuf, PathBuf),
    Stat(PathBuf),
}

/// In-memory transport that records every call. Behaves like a tiny
/// filesystem in a `HashMap<PathBuf, Vec<u8>>` — exactly enough for
/// install_hooks's read / write / stat / rename surface.
struct MockFileTransport {
    files: Mutex<std::collections::HashMap<PathBuf, Vec<u8>>>,
    ops: Mutex<Vec<Op>>,
}

impl MockFileTransport {
    fn new() -> Self {
        Self {
            files: Mutex::new(std::collections::HashMap::new()),
            ops: Mutex::new(Vec::new()),
        }
    }

    /// Seed a file (e.g. a user's pre-existing settings.json).
    fn seed(&self, path: &Path, content: &[u8]) {
        self.files
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), content.to_vec());
    }

    fn ops(&self) -> Vec<Op> {
        self.ops.lock().unwrap().clone()
    }

    fn read_final(&self, path: &Path) -> Option<Vec<u8>> {
        self.files.lock().unwrap().get(path).cloned()
    }
}

#[async_trait]
impl FileTransport for MockFileTransport {
    fn is_local(&self) -> bool {
        // Deliberately false — we want install_hooks to take the same code
        // path it would for a real remote, so the relative-path default for
        // settings_path fires.
        false
    }

    async fn read(&self, path: &Path) -> Result<Vec<u8>> {
        self.ops.lock().unwrap().push(Op::Read(path.to_path_buf()));
        self.files
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or_else(|| anyhow!("mock: no such file: {}", path.display()))
    }

    async fn write(&self, path: &Path, content: &[u8]) -> Result<()> {
        self.ops
            .lock()
            .unwrap()
            .push(Op::Write(path.to_path_buf(), content.to_vec()));
        self.files
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), content.to_vec());
        Ok(())
    }

    async fn list_dir(&self, _path: &Path) -> Result<Vec<DirEntry>> {
        Ok(vec![])
    }

    async fn stat(&self, path: &Path) -> Result<Stat> {
        self.ops.lock().unwrap().push(Op::Stat(path.to_path_buf()));
        let files = self.files.lock().unwrap();
        let bytes = files
            .get(path)
            .ok_or_else(|| anyhow!("mock: no such file: {}", path.display()))?;
        Ok(Stat {
            is_dir: false,
            size: bytes.len() as u64,
            modified: 0,
            readable: true,
            writable: true,
        })
    }

    async fn delete(&self, path: &Path) -> Result<()> {
        self.files.lock().unwrap().remove(path);
        Ok(())
    }

    async fn rename(&self, from: &Path, to: &Path) -> Result<()> {
        self.ops
            .lock()
            .unwrap()
            .push(Op::Rename(from.to_path_buf(), to.to_path_buf()));
        let mut files = self.files.lock().unwrap();
        let bytes = files
            .remove(from)
            .ok_or_else(|| anyhow!("mock rename: no such src: {}", from.display()))?;
        files.insert(to.to_path_buf(), bytes);
        Ok(())
    }
}

/// The default settings path install_hooks picks when transport.is_local() is
/// false and no override is given. Mirrors the resolver in claude_config.rs.
fn default_remote_settings_path() -> PathBuf {
    PathBuf::from(".claude/settings.json")
}

/// The temp sibling install_hooks writes to before the atomic rename.
fn tmp_sibling(path: &Path) -> PathBuf {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path.file_name().unwrap().to_string_lossy();
    dir.join(format!("{name}.supermux-tmp"))
}

#[tokio::test]
async fn fresh_install_writes_marker_entry_via_transport() {
    let mock = MockFileTransport::new();

    claude_config::install_hooks("remote-sess", "hook-tok-fresh", &mock, None)
        .await
        .expect("install_hooks must succeed against a clean mock");

    // The final settings file landed at the default remote path.
    let final_path = default_remote_settings_path();
    let bytes = mock.read_final(&final_path).expect("final settings exist");
    let v: Value = serde_json::from_slice(&bytes).expect("written body must be valid JSON");

    // All 9 events have exactly one supermux-marked entry.
    let hooks = v["hooks"].as_object().expect("hooks is an object");
    let events = [
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Notification",
        "Stop",
        "SubagentStop",
        "SessionStart",
        "SessionEnd",
        "StopFailure",
    ];
    for ev in events {
        let arr = hooks[ev].as_array().unwrap_or_else(|| panic!("{ev} is array"));
        assert_eq!(arr.len(), 1, "{ev}: one entry expected on a fresh install");
        let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("supermux-hook"), "{ev}: marker present");
        assert!(
            cmd.contains("$SUPERMUX_HOOK_TOKEN"),
            "{ev}: per-session token referenced via env, not embedded literally"
        );
        // The hook_token "hook-tok-fresh" must NEVER appear in the file
        // (§6.5: token travels via tmux pane env, not settings.json).
        assert!(
            !cmd.contains("hook-tok-fresh"),
            "{ev}: per-session token must never be written into settings.json"
        );
    }
}

#[tokio::test]
async fn fresh_install_records_atomic_write_then_rename() {
    let mock = MockFileTransport::new();

    claude_config::install_hooks("remote-sess", "tok", &mock, None)
        .await
        .unwrap();

    let final_path = default_remote_settings_path();
    let tmp = tmp_sibling(&final_path);
    let ops = mock.ops();

    // Find indices of the write(tmp) and rename(tmp, final) ops.
    let write_idx = ops
        .iter()
        .position(|op| matches!(op, Op::Write(p, _) if p == &tmp))
        .expect("must record a write to the temp sibling");
    let rename_idx = ops
        .iter()
        .position(|op| matches!(op, Op::Rename(f, t) if f == &tmp && t == &final_path))
        .expect("must record a rename(tmp -> final)");

    assert!(
        write_idx < rename_idx,
        "atomic dance broken: tmp write must precede the rename (ops = {ops:?})"
    );

    // NO direct write to the final path — every write goes through the temp
    // sibling so a crash mid-write never leaves a truncated settings.json.
    assert!(
        !ops
            .iter()
            .any(|op| matches!(op, Op::Write(p, _) if p == &final_path)),
        "must NEVER write directly to {} — only via tmp + rename (ops = {ops:?})",
        final_path.display()
    );
}

#[tokio::test]
async fn reinstall_is_byte_for_byte_idempotent() {
    let mock = MockFileTransport::new();

    claude_config::install_hooks("remote-sess", "tok", &mock, None)
        .await
        .unwrap();
    let final_path = default_remote_settings_path();
    let after_first = mock.read_final(&final_path).expect("first install wrote a file");

    claude_config::install_hooks("remote-sess", "tok", &mock, None)
        .await
        .unwrap();
    let after_second = mock.read_final(&final_path).expect("second install still has a file");

    assert_eq!(
        after_first, after_second,
        "re-install must produce byte-identical settings.json (no duplicate entries, no churn)"
    );

    // And the JSON view: every event still has exactly ONE marked entry.
    let v: Value = serde_json::from_slice(&after_second).unwrap();
    for ev in [
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Notification",
        "Stop",
        "SubagentStop",
        "SessionStart",
        "SessionEnd",
        "StopFailure",
    ] {
        let arr = v["hooks"][ev].as_array().unwrap();
        assert_eq!(arr.len(), 1, "{ev}: re-install must not duplicate");
    }
}

#[tokio::test]
async fn preserves_foreign_hooks_and_other_keys() {
    let mock = MockFileTransport::new();
    let settings_path = default_remote_settings_path();

    // Seed a user-owned settings.json: an unrelated top-level key, a foreign
    // Stop hook, and a foreign PreToolUse matcher supermux must not touch.
    let seed = json!({
        "model": "opus",
        "hooks": {
            "Stop": [ { "matcher": "Bash", "hooks": [ { "type":"command", "command":"echo mine" } ] } ],
            "PreToolUse": [ { "matcher": "*", "hooks": [ { "type":"command", "command":"echo user-pretool" } ] } ]
        }
    });
    let seed_bytes = serde_json::to_vec_pretty(&seed).unwrap();
    mock.seed(&settings_path, &seed_bytes);

    claude_config::install_hooks("remote-sess", "tok", &mock, None)
        .await
        .unwrap();

    let bytes = mock.read_final(&settings_path).unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();

    // Unrelated top-level key survives.
    assert_eq!(
        v["model"],
        json!("opus"),
        "user's top-level keys are coexistence-safe"
    );

    // Foreign Stop hook survives untouched; supermux's marked entry sits
    // alongside (the §3.5 idempotency predicate keys only on matcher="*" +
    // marker — so "matcher=Bash" is foreign and pass-through).
    let stop = v["hooks"]["Stop"].as_array().unwrap();
    assert_eq!(stop.len(), 2, "user Stop + supermux Stop both present");
    assert!(
        stop.iter()
            .any(|e| e["hooks"][0]["command"] == json!("echo mine")),
        "user's foreign Stop hook is preserved verbatim"
    );
    assert_eq!(
        stop.iter()
            .filter(|e| {
                e["matcher"] == json!("*")
                    && e["hooks"][0]["command"]
                        .as_str()
                        .map(|c| c.contains("supermux-hook"))
                        .unwrap_or(false)
            })
            .count(),
        1,
        "exactly one marker-bearing entry was added"
    );

    // User's own `*`-matcher PreToolUse (no marker) is foreign → preserved;
    // supermux adds its own `*`-matcher entry alongside.
    let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
    assert_eq!(pre.len(), 2, "user's *-matcher kept + supermux added");
    assert!(
        pre.iter()
            .any(|e| e["hooks"][0]["command"] == json!("echo user-pretool")),
        "user's unmarked *-matcher PreToolUse is preserved"
    );
}

#[tokio::test]
async fn explicit_settings_path_override_is_honored() {
    let mock = MockFileTransport::new();
    let custom = PathBuf::from("/var/lib/claude/settings.json");

    claude_config::install_hooks("remote-sess", "tok", &mock, Some(&custom))
        .await
        .unwrap();

    // Final lands at the explicit override, NOT the default remote path.
    assert!(
        mock.read_final(&custom).is_some(),
        "settings written at the explicit override path"
    );
    assert!(
        mock.read_final(&default_remote_settings_path()).is_none(),
        "default remote path should NOT have been written when override is supplied"
    );

    // Temp sibling lived in the SAME directory (so the rename is same-fs,
    // and therefore atomic). Verify via the recorded ops.
    let tmp = tmp_sibling(&custom);
    let ops = mock.ops();
    assert!(
        ops.iter()
            .any(|op| matches!(op, Op::Write(p, _) if p == &tmp)),
        "tmp sibling lives in the same dir as the final (atomic rename invariant), ops = {ops:?}",
    );
    assert!(
        ops.iter()
            .any(|op| matches!(op, Op::Rename(f, t) if f == &tmp && t == &custom)),
        "rename(tmp -> final) is recorded, ops = {ops:?}",
    );
}

#[tokio::test]
async fn empty_hook_token_refused() {
    let mock = MockFileTransport::new();
    let err = claude_config::install_hooks("sess", "", &mock, None).await;
    assert!(err.is_err(), "empty hook token must be rejected up front");
    // And nothing was written.
    assert!(
        mock.read_final(&default_remote_settings_path()).is_none(),
        "no settings file should have been created"
    );
}
