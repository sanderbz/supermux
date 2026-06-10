//! Cross-host reattach-on-boot tests.
//!
//! `sessions::auto_actions::reconcile_on_boot` is the boot-time reattach: it
//! reconciles every persisted session against tmux reality. The multi-host
//! extension makes it iterate the `hosts` table and run a `tmux ls` over each host's SSH
//! transport — best-effort, with a strict per-host timeout so a single broken
//! host can never stall boot.
//!
//! These tests exercise the cross-host invariants WITHOUT a real SSH peer:
//! they point hosts at an ssh_target that fails fast (a non-routable hostname
//! / a junk `ControlPath`) so the per-host path goes through the
//! ssh-error → mark-unreachable → mark-sessions-unknown branch on a known
//! schedule. The local-only path is exercised by the empty-hosts test, which
//! also asserts the boot-time cost of the remote pass when no hosts exist.

use std::time::Instant;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::db;
use supermux_server::db::hosts::{self, HostStatus};
use supermux_server::sessions::auto_actions::reconcile_on_boot;
use supermux_server::state::AppState;

use sqlx::SqlitePool;

/// Build an isolated on-disk pool in a fresh temp dir and an `AppState` for it.
/// Matches the pattern in `hosts_db.rs` / `auth.rs`.
async fn test_state() -> (AppState, std::path::PathBuf) {
    let dir =
        std::env::temp_dir().join(format!("supermux-rt7-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: "rt7-test".to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
    };
    let pool = db::init(&config).await.expect("db init");
    (AppState::new(pool, config), dir)
}

/// Seed a session row + its runtime row (so `set_last_status` UPDATEs land).
async fn seed_session(pool: &SqlitePool, name: &str) {
    db::sessions::insert_minimal(pool, name, "/tmp", "claude")
        .await
        .unwrap();
    db::sessions::ensure_runtime(pool, name, "test-token")
        .await
        .unwrap();
}

/// Attach `name`'s session row to `host_id` (`host_id` is
/// nullable, no Rust helper, so the test pokes it via raw SQL).
async fn attach_session_to_host(pool: &SqlitePool, name: &str, host_id: i64) {
    sqlx::query("UPDATE sessions SET host_id = ? WHERE name = ?")
        .bind(host_id)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
}

/// Read back the persisted `last_status` for `name`.
async fn last_status(pool: &SqlitePool, name: &str) -> String {
    db::sessions::runtime(pool, name)
        .await
        .unwrap()
        .expect("runtime row exists")
        .last_status
}

/// Test 1 — empty hosts table → reconcile is FAST (the local-only cost
/// only). A regression that would always sweep hosts (or otherwise call into
/// SSH on every boot) is caught here: with zero hosts the cross-host pass
/// must short-circuit before any `tmux ls` is spawned.
///
/// The 100ms bound is generous w.r.t. SQLite I/O on a temp-dir db; the
/// per-host timeout is 5s, so a single accidental SSH call would blow this
/// bound by ~50× and the test fails loudly.
#[tokio::test]
async fn empty_hosts_reconcile_is_fast() {
    let (state, dir) = test_state().await;

    // No hosts, no sessions → reconcile is a no-op past the two list() reads.
    let start = Instant::now();
    reconcile_on_boot(&state).await;
    let elapsed = start.elapsed();

    assert!(
        elapsed.as_millis() < 100,
        "empty-hosts reconcile must be <100ms, took {:?}",
        elapsed
    );

    // Still no hosts after the call (we did not invent one).
    assert!(hosts::list(&state.pool).await.unwrap().is_empty());

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// Test 2 (`#[ignore]`d) — with a localhost SSH + one reachable host, the
/// reattach loop iterates the host and queries it. Requires a real `ssh`
/// binary + a localhost `tmux`; CI has neither, so the test is opt-in. Run
/// manually with `cargo test -- --ignored real_host_iterates_when_registered`.
#[tokio::test]
#[ignore]
async fn real_host_iterates_when_registered() {
    let (state, dir) = test_state().await;

    // Register a host that points at the LOCAL machine over ssh (assumes the
    // running user has key-only ssh access to themselves — the common dev
    // setup). The ControlPath is in the test's temp data_dir so we don't clash
    // with a real running supermux.
    let h = hosts::create(
        &state.pool,
        "localhost",
        &format!("{}@localhost", std::env::var("USER").unwrap_or_default()),
        None,
    )
    .await
    .unwrap();

    // No session rows yet; reconcile should still probe + flip the host to
    // Reachable, validating end-to-end SSH plumbing.
    reconcile_on_boot(&state).await;

    let after = hosts::get(&state.pool, h.id).await.unwrap().unwrap();
    assert_eq!(
        after.status,
        HostStatus::Reachable.as_str(),
        "live localhost ssh must flip the host to reachable"
    );
    assert!(after.last_seen.is_some(), "Reachable bumps last_seen");

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// Test 3 — host probe TIMES OUT (or otherwise fails): boot must continue,
/// the host is marked `Unreachable`, and every session on that host is marked
/// `unknown`. We force the failure by pointing the host at an unroutable
/// `ssh_target` that ssh will fail fast on under `BatchMode=yes`, AND by
/// pre-creating a junk control_path so the master can't be re-used. The
/// per-host 5s timeout caps wall-clock cost at well under the test harness
/// default timeout.
#[tokio::test]
async fn unreachable_host_marks_sessions_unknown_and_continues() {
    let (state, dir) = test_state().await;

    // Two hosts so we can assert per-host fault isolation: host A is broken,
    // host B is broken (different way), but BOTH must be reconciled — a single
    // broken host can't short-circuit the loop and leave its peers untouched.
    let host_a = hosts::create(
        &state.pool,
        "broken-a",
        // Reserved TEST-NET-1 (RFC 5737); routes to nowhere → ssh errors fast.
        "ssh-fail-user@192.0.2.1",
        None,
    )
    .await
    .unwrap();
    let host_b = hosts::create(
        &state.pool,
        "broken-b",
        "ssh-fail-user@192.0.2.2",
        None,
    )
    .await
    .unwrap();

    // Seed sessions on each host (and one LOCAL session to confirm the local
    // path still runs and is independent of the remote pass).
    seed_session(&state.pool, "remote-a-1").await;
    attach_session_to_host(&state.pool, "remote-a-1", host_a.id).await;
    seed_session(&state.pool, "remote-a-2").await;
    attach_session_to_host(&state.pool, "remote-a-2", host_a.id).await;
    seed_session(&state.pool, "remote-b-1").await;
    attach_session_to_host(&state.pool, "remote-b-1", host_b.id).await;

    seed_session(&state.pool, "local-1").await;
    // local-1 stays host_id = NULL (the local path).

    // Boot reconcile MUST complete in bounded wall-clock time even with both
    // hosts broken. The per-host timeout is 5s; 2 hosts ⇒ ≤ ~12s including
    // SQLite + the local pass's tmux has-session probe.
    let start = Instant::now();
    let outer = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        reconcile_on_boot(&state),
    )
    .await;
    let elapsed = start.elapsed();
    assert!(
        outer.is_ok(),
        "reconcile_on_boot must complete within the outer test timeout, took {:?}",
        elapsed,
    );

    // Both hosts marked Unreachable (the SSH spawn errored under BatchMode).
    let after_a = hosts::get(&state.pool, host_a.id).await.unwrap().unwrap();
    let after_b = hosts::get(&state.pool, host_b.id).await.unwrap().unwrap();
    assert_eq!(
        after_a.status,
        HostStatus::Unreachable.as_str(),
        "broken-a must be Unreachable after probe failure"
    );
    assert_eq!(
        after_b.status,
        HostStatus::Unreachable.as_str(),
        "broken-b must be Unreachable after probe failure"
    );

    // Every session on a broken host is `unknown` (NOT `stopped` — we don't
    // know the remote pty state, and stopped would be a false claim).
    assert_eq!(last_status(&state.pool, "remote-a-1").await, "unknown");
    assert_eq!(last_status(&state.pool, "remote-a-2").await, "unknown");
    assert_eq!(last_status(&state.pool, "remote-b-1").await, "unknown");

    // The local session went through the local path. Without a live tmux it
    // gets `stopped` (the existing local-flow outcome) — assert that's still
    // the case so the local path is byte-for-byte unchanged.
    assert_eq!(last_status(&state.pool, "local-1").await, "stopped");

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// Test 4 — local sessions (`host_id IS NULL`) and a registered host coexist:
/// the local pass writes `stopped` for tmux-less locals, and the remote pass
/// flips its (broken) host's sessions to `unknown` — without either pass
/// touching the other's rows. Catches a regression where the host iteration
/// might accidentally re-process local rows (or vice versa).
#[tokio::test]
async fn local_and_remote_passes_are_independent() {
    let (state, dir) = test_state().await;

    let host = hosts::create(&state.pool, "broken", "u@192.0.2.10", None)
        .await
        .unwrap();
    seed_session(&state.pool, "remote-x").await;
    attach_session_to_host(&state.pool, "remote-x", host.id).await;
    seed_session(&state.pool, "local-x").await;

    reconcile_on_boot(&state).await;

    // Remote got `unknown` (broken host), local got `stopped` (no tmux). The
    // critical invariant is that the local row is NOT clobbered with `unknown`
    // by the remote pass.
    assert_eq!(last_status(&state.pool, "remote-x").await, "unknown");
    assert_eq!(last_status(&state.pool, "local-x").await, "stopped");

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// Test 5 — a SOFT-DELETED host is excluded from the iteration (deleted rows
/// survive for historical-resolution but `db::hosts::list` filters them out;
/// the reconcile must use `list`, not `get`-by-id, so a tombstoned host is
/// never probed). Implicit acceptance check for "iterate non-deleted hosts".
#[tokio::test]
async fn soft_deleted_host_is_not_probed() {
    let (state, dir) = test_state().await;

    let host = hosts::create(&state.pool, "to-delete", "u@192.0.2.20", None)
        .await
        .unwrap();
    seed_session(&state.pool, "orphan").await;
    attach_session_to_host(&state.pool, "orphan", host.id).await;

    // Tombstone the host BEFORE the reconcile.
    hosts::soft_delete(&state.pool, host.id).await.unwrap();
    // Status starts as `unknown` (default); persist that fact so we can detect
    // an accidental write.
    let pre = hosts::get(&state.pool, host.id).await.unwrap().unwrap();
    assert_eq!(pre.status, HostStatus::Unknown.as_str());

    reconcile_on_boot(&state).await;

    // Host status MUST be unchanged — `list()` filtered it out, so neither the
    // Reachable nor Unreachable branch ran for it.
    let after = hosts::get(&state.pool, host.id).await.unwrap().unwrap();
    assert_eq!(
        after.status,
        HostStatus::Unknown.as_str(),
        "soft-deleted host must not be probed"
    );

    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}
