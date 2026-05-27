//! Integration tests for the `FileTransport` trait (REMOTE_PLAN §RT6).
//!
//! Three slices:
//!
//! 1. **Local impl round-trip.** Direct trait-level reads/writes/lists/stats
//!    against a temp dir. A regression net for [`LocalFileTransport`].
//! 2. **Path-safety regression on the remote side.** `resolve_safe_remote` is
//!    new; we assert it blocks `/etc/shadow` (exact match), `/ETC/SHADOW`
//!    (case-insensitive, matches the macOS test in `tests/files.rs`), and
//!    relative inputs the same way `resolve_safe` does.
//! 3. **Localhost SSH round-trip (#[ignore]).** Real shell out across an
//!    actual ControlMaster — only runs when a local sshd is reachable for the
//!    invoking user. Mirrors the gating pattern used by
//!    `tests/host_pool_ssh.rs`. Skipped by default in CI.

use std::path::PathBuf;
use std::sync::Arc;

use supermux_server::files::path_safe;
use supermux_server::files::transport::{
    FileTransport, LocalFileTransport, SshFileTransport,
};
use supermux_server::sessions::host_pool::HostPool;
use supermux_server::sessions::transport::HostId;

fn tmp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "supermux-rt6-{tag}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

// ─────────────────────────── Local impl round-trip ─────────────────────────

#[tokio::test]
async fn local_full_roundtrip_read_write_list_stat_rename_delete() {
    let dir = tmp_dir("local-rt");
    let t: Arc<dyn FileTransport> = Arc::new(LocalFileTransport);

    let a = dir.join("hello.txt");
    let b = dir.join("renamed.txt");

    // write + read
    t.write(&a, b"hi rt6\n").await.unwrap();
    assert_eq!(t.read(&a).await.unwrap(), b"hi rt6\n");

    // stat
    let s = t.stat(&a).await.unwrap();
    assert!(!s.is_dir);
    assert_eq!(s.size, b"hi rt6\n".len() as u64);

    // list
    let mut entries = t.list_dir(&dir).await.unwrap();
    entries.sort_by(|x, y| x.name.cmp(&y.name));
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "hello.txt");
    assert!(!entries[0].is_dir);

    // rename + delete
    t.rename(&a, &b).await.unwrap();
    assert!(t.stat(&a).await.is_err());
    assert!(t.stat(&b).await.is_ok());
    t.delete(&b).await.unwrap();
    assert!(t.stat(&b).await.is_err());

    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn local_write_creates_parents_atomically() {
    let dir = tmp_dir("local-mkparents");
    let t: Arc<dyn FileTransport> = Arc::new(LocalFileTransport);
    let deep = dir.join("a/b/c/d/leaf.toml");
    t.write(&deep, b"x = 1\n").await.unwrap();
    assert_eq!(t.read(&deep).await.unwrap(), b"x = 1\n");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn local_is_local_marker_is_true() {
    let t = LocalFileTransport;
    assert!(t.is_local());
}

// ───────────────────────── Remote path-safety regression ────────────────────

#[test]
fn remote_blocks_etc_shadow_exact() {
    let err = path_safe::resolve_safe_remote("/etc/shadow")
        .expect_err("must block exact /etc/shadow");
    assert!(matches!(err, path_safe::PathError::Blocked));
}

#[test]
fn remote_blocks_etc_shadow_case_insensitive() {
    // Mirrors `put_to_uppercase_etc_shadow_is_403` in tests/files.rs — the
    // macOS APFS case-fold trick must be defeated on remote inputs too.
    let err = path_safe::resolve_safe_remote("/ETC/SHADOW")
        .expect_err("must block case-folded /ETC/SHADOW");
    assert!(matches!(err, path_safe::PathError::Blocked));
}

#[test]
fn remote_blocks_etc_ssh_prefix() {
    let err = path_safe::resolve_safe_remote("/etc/ssh/sshd_config")
        .expect_err("must block /etc/ssh/* prefix");
    assert!(matches!(err, path_safe::PathError::Blocked));
}

#[test]
fn remote_blocks_home_ssh_anywhere_in_path() {
    let err = path_safe::resolve_safe_remote("/home/dev/.ssh/id_rsa")
        .expect_err("must block .ssh anywhere");
    assert!(matches!(err, path_safe::PathError::Blocked));
}

#[test]
fn remote_rejects_relative_path() {
    let err = path_safe::resolve_safe_remote("relative/path")
        .expect_err("relative path must be invalid");
    assert!(matches!(err, path_safe::PathError::Invalid));
}

#[test]
fn remote_rejects_dot_dot_traversal() {
    let err = path_safe::resolve_safe_remote("/home/x/../../etc/shadow")
        .expect_err("dot-dot must be refused");
    assert!(matches!(err, path_safe::PathError::Invalid));
}

#[test]
fn remote_rejects_nul_byte() {
    let err = path_safe::resolve_safe_remote("/tmp/foo\0bar")
        .expect_err("NUL byte must be invalid");
    assert!(matches!(err, path_safe::PathError::Invalid));
}

#[test]
fn remote_accepts_normal_absolute_path() {
    let p = path_safe::resolve_safe_remote("/var/log/syslog").unwrap();
    assert_eq!(p, std::path::Path::new("/var/log/syslog"));
}

// ─────────────────── Localhost SSH round-trip (#[ignore]) ──────────────────

/// Build a HostPool against an ephemeral sqlite + temp data dir. The pool
/// itself is local — it just constructs the SSH argv, so we don't need a
/// remote machine to exercise its surface.
async fn make_pool() -> (Arc<HostPool>, sqlx::SqlitePool, PathBuf) {
    let dir = tmp_dir("hp");
    let config = supermux_server::config::Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        tls: Default::default(),
        auth_token: "rt6-test".to_string(),
        provider_defaults: Default::default(),
        ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
    };
    let pool = supermux_server::db::init(&config).await.expect("init pool");
    let hp = HostPool::new(pool.clone(), &dir);
    (hp, pool, dir)
}

/// Localhost SFTP/SSH end-to-end smoke. Gated `#[ignore]` so CI never runs
/// it — opt in with `cargo test -- --ignored ssh_localhost_roundtrip`.
///
/// Prerequisites: passwordless SSH to `localhost` for the invoking user
/// (`ssh -o BatchMode=yes localhost true` must exit 0). The test creates a
/// host row pointing at `localhost`, warms a master, and round-trips a
/// write/read/stat/delete via the SshFileTransport.
#[tokio::test]
#[ignore = "requires passwordless localhost ssh"]
async fn ssh_localhost_roundtrip() {
    // Sanity: only proceed if BatchMode SSH to localhost works.
    let probe = tokio::process::Command::new("ssh")
        .args(["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "localhost", "true"])
        .status()
        .await
        .expect("spawn ssh probe");
    if !probe.success() {
        eprintln!("SKIP: passwordless ssh to localhost is not configured");
        return;
    }

    let (hp, pool, data_dir) = make_pool().await;
    let host = supermux_server::db::hosts::create(&pool, "localhost-rt6", "localhost", None)
        .await
        .expect("create host row");

    let t = SshFileTransport::new(hp.clone(), HostId(host.id));

    // Write to a temp path; read it back.
    let target = std::env::temp_dir().join(format!(
        "supermux-rt6-ssh-{}.txt",
        uuid::Uuid::new_v4().simple()
    ));
    let payload = b"hello from RT6 over SSH\n";
    t.write(&target, payload).await.expect("ssh write");
    let got = t.read(&target).await.expect("ssh read");
    assert_eq!(got, payload, "round-trip bytes match");

    // Stat — file should exist and report the right size.
    let s = t.stat(&target).await.expect("ssh stat");
    assert!(!s.is_dir);
    assert_eq!(s.size, payload.len() as u64);

    // Delete the file and confirm stat now errors.
    t.delete(&target).await.expect("ssh delete");
    assert!(t.stat(&target).await.is_err());

    hp.tear_down(host.id).await.ok();
    pool.close().await;
    let _ = std::fs::remove_dir_all(data_dir);
}
