//! `HostPool` integration tests (REMOTE_PLAN §RT2,
//! /opt/projects/supermux-remote-ssh/plan/REMOTE_PLAN.md).
//!
//! The localhost-ssh test is `#[ignore]` by default: many CI environments
//! (and the orchestrator's sandbox) don't have a usable
//! `ssh -o BatchMode=yes -o ConnectTimeout=1 localhost true`. Run it
//! explicitly when an authorized localhost ssh agent + key is set up:
//!
//! ```sh
//! cargo test --test host_pool -- --ignored host_pool_localhost
//! ```
//!
//! The always-running test pins the cheapest contract: an unknown `host_id`
//! → `Err` (no panics, no hangs, no spurious ssh process).

use std::path::PathBuf;

use sqlx::SqlitePool;
use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::db;
use supermux_server::db::hosts;
use supermux_server::sessions::host_pool::HostPool;
use supermux_server::sessions::transport::Transport;

/// Build an isolated on-disk SQLite pool + fresh temp data dir for the test.
/// Mirrors the `test_pool` helper in `hosts_db.rs` so both test files share
/// the same fixture shape.
async fn test_pool() -> (SqlitePool, PathBuf) {
    let dir = std::env::temp_dir()
        .join(format!("supermux-host-pool-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: TlsConfig::default(),
        auth_token: "host-pool-test".to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
    };
    let pool = db::init(&config).await.expect("db init");
    (pool, dir)
}

#[tokio::test]
async fn transport_for_nonexistent_host_returns_err() {
    // The cheapest acceptance bullet: an unknown id must Err immediately —
    // no spawn, no hang, no panic. This runs in every CI without ssh.
    let (pool, dir) = test_pool().await;
    let hp = HostPool::new(pool.clone(), &dir);

    let err = hp
        .transport_for(424242)
        .await
        .expect_err("transport_for must Err on a non-existent host_id");
    let msg = format!("{err}");
    assert!(
        msg.contains("424242") || msg.to_lowercase().contains("not found"),
        "error must mention the missing id / 'not found'; got: {msg}"
    );

    pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// Localhost ssh round-trip — gated behind `#[ignore]` because the
/// orchestrator's sandboxed runners don't have ssh-localhost preconfigured.
/// Run with: `cargo test --test host_pool -- --ignored host_pool_localhost`.
///
/// Pre-conditions for this to pass on a developer machine:
///   * `sshd` running locally on port 22 (or wherever `~/.ssh/config` maps),
///   * a key pair in `~/.ssh/` whose public half is in
///     `~/.ssh/authorized_keys`,
///   * `BatchMode=yes` works (no passphrase / agent-loaded key).
///
/// We do a small precheck via `ssh -o BatchMode=yes -o ConnectTimeout=2
/// localhost true` and skip if it fails, so a misconfigured dev box just
/// reports "skipped" rather than a confusing failure.
#[tokio::test]
#[ignore]
async fn host_pool_localhost() {
    // Skip cleanly if ssh-localhost isn't usable.
    let probe = tokio::process::Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=2",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "localhost",
            "true",
        ])
        .output()
        .await;
    let usable = matches!(probe, Ok(o) if o.status.success());
    if !usable {
        eprintln!("skipping host_pool_localhost: ssh-localhost not usable");
        return;
    }

    let (pool, dir) = test_pool().await;
    let hp = HostPool::new(pool.clone(), &dir);

    // Register a host pointing at 127.0.0.1 via ssh.
    let host = hosts::create(&pool, "loopback", "localhost", None)
        .await
        .expect("create host");

    // First call: cold — must spawn a master and hand back a Transport::Ssh.
    let t1 = hp
        .transport_for(host.id)
        .await
        .expect("transport_for must succeed against localhost ssh");
    match &*t1 {
        Transport::Ssh {
            host_id,
            ssh_target,
            control_path,
        } => {
            assert_eq!(host_id.0, host.id, "host id round-trips");
            assert_eq!(ssh_target, "localhost");
            assert!(
                control_path.starts_with(dir.join("ssh-control")),
                "control_path is under data_dir/ssh-control: {control_path:?}"
            );
        }
        Transport::Local => panic!("expected Transport::Ssh, got Local"),
    }

    // Second call: warm — must succeed without re-spawning. We can't directly
    // observe "no new process" without ps, but a successful `-O check` under
    // the per-host mutex proves the master is still up after the first call.
    let t2 = hp
        .transport_for(host.id)
        .await
        .expect("second transport_for must succeed (master is warm)");
    assert!(matches!(&*t2, Transport::Ssh { .. }));

    // Verify the explicit health-check path.
    hp.verify(host.id)
        .await
        .expect("verify must succeed against a live master");

    // Tear down so we don't leave a master running between test invocations.
    hp.tear_down(host.id).await.expect("tear_down");

    pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}
