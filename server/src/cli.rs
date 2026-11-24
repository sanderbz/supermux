//! The `supermux-server` command line, and the one-server-per-data-dir lock.
//!
//! The binary runs as the server when started with NO arguments (the systemd
//! unit and the macOS LaunchAgent both start it that way), and as one of a few
//! lean helper processes when the first argument names a subcommand. Anything
//! else used to fall through into a full server boot (migrations, the boot
//! reconcile, connector seeding) against the live data dir, and only failed
//! later on the taken port. [`parse`] makes that fall-through impossible: an
//! unknown first argument is an error before any boot work.
//!
//! [`lock_data_dir`] is the second guard: the server takes an exclusive lock on
//! `<data_dir>/server.lock` before it touches anything else in the data dir, so
//! a second server on the same data dir exits before any side effect.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

/// What the first command-line argument asks this process to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    /// No argument: the server itself.
    Serve,
    /// `--version` / `-V`.
    Version,
    /// `--help` / `-h`.
    Help,
    /// `__edit`: the `$EDITOR` bridge.
    Edit,
    /// `__memory-recall`: the bot-memory recall hook.
    MemoryRecall,
    /// `__memory-save`: the `supermux-memory` write CLI.
    MemorySave,
    /// `__hook-cli`: the `supermux-{message,notify,task,schedule}` CLIs.
    HookCli,
    /// `pty-holder`: a native session's pty holder.
    PtyHolder,
    /// `swarm-reaper`: sweep leaked agent-team tmux servers once.
    SwarmReaper,
    /// Anything else. Never boots the server.
    Unknown(String),
}

/// Classify the first command-line argument (`argv[1]`). Only the first
/// argument decides; the rest belong to the subcommand.
pub fn parse(first: Option<&str>) -> Invocation {
    match first {
        None => Invocation::Serve,
        Some("--version" | "-V") => Invocation::Version,
        Some("--help" | "-h") => Invocation::Help,
        Some("__edit") => Invocation::Edit,
        Some("__memory-recall") => Invocation::MemoryRecall,
        Some("__memory-save") => Invocation::MemorySave,
        Some("__hook-cli") => Invocation::HookCli,
        Some("pty-holder") => Invocation::PtyHolder,
        Some("swarm-reaper") => Invocation::SwarmReaper,
        Some(other) => Invocation::Unknown(other.to_string()),
    }
}

/// `supermux-server <version>`: the same build metadata `GET /api/version`
/// reports (`git describe` tag, commit sha, build time, baked by `build.rs`).
pub fn version_line() -> String {
    use crate::updates::version::{BUILD_TIME, CURRENT_SHA, CURRENT_TAG};
    let mut line = format!("supermux-server {CURRENT_TAG}");
    if CURRENT_SHA != "dev" {
        line.push_str(&format!(" ({CURRENT_SHA}"));
        if !BUILD_TIME.is_empty() {
            line.push_str(&format!(", built {BUILD_TIME}"));
        }
        line.push(')');
    }
    line
}

/// Short usage text for `--help` and for an unknown argument.
pub const USAGE: &str = "\
Usage: supermux-server [--version | --help]

With no arguments, runs the supermux server on its data dir ($SUPERMUX_DATA_DIR,
default ~/.supermux; settings in <data_dir>/config.toml). One server per data dir.

Options:
  -V, --version         Print the version and exit
  -h, --help            Print this help and exit

Subcommands (started by the server itself, not meant to be run by hand):
  pty-holder ...        Pty holder for a native session
  swarm-reaper [--dry-run]
                        Sweep leaked Claude agent-team tmux servers once
  __edit <file>         $EDITOR bridge to the browser editor
  __memory-recall       Bot-memory recall hook
  __memory-save ...     Bot-memory write CLI (supermux-memory)
  __hook-cli ...        Bot hook CLIs (supermux-message/notify/task/schedule)
";

/// The data-dir lock file's name.
pub const LOCK_FILE: &str = "server.lock";

/// Proof that this process is the only server on its data dir. The lock is
/// tied to the open file, so it holds for as long as this value lives (keep it
/// for the life of the process) and is released by the kernel on exit, crash
/// included. The fd is close-on-exec, so spawned children (pty holders, tmux)
/// never inherit it and cannot keep it held after the server is gone.
#[derive(Debug)]
pub struct ServerLock {
    _file: File,
    path: PathBuf,
}

impl ServerLock {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LockError {
    #[error("another supermux-server is running on this data dir (lock {0} is held)")]
    Held(PathBuf),
    #[error("could not take the server lock {0}: {1}")]
    Io(PathBuf, std::io::Error),
}

/// Take the exclusive, non-blocking server lock on `<data_dir>/server.lock`.
/// [`LockError::Held`] when another process already holds it.
pub fn lock_data_dir(data_dir: &Path) -> Result<ServerLock, LockError> {
    let path = data_dir.join(LOCK_FILE);
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| LockError::Io(path.clone(), e))?;
    // SAFETY: `flock` on a valid fd we own; no memory is passed.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        return Err(if err.raw_os_error() == Some(libc::EWOULDBLOCK) {
            LockError::Held(path)
        } else {
            LockError::Io(path, err)
        });
    }
    // Diagnostics only: who holds it. The lock, not the content, is the guard.
    let _ = file.set_len(0);
    let _ = writeln!(file, "{}", std::process::id());
    Ok(ServerLock { _file: file, path })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_argument_serves() {
        assert_eq!(parse(None), Invocation::Serve);
    }

    #[test]
    fn version_and_help_flags() {
        assert_eq!(parse(Some("--version")), Invocation::Version);
        assert_eq!(parse(Some("-V")), Invocation::Version);
        assert_eq!(parse(Some("--help")), Invocation::Help);
        assert_eq!(parse(Some("-h")), Invocation::Help);
    }

    #[test]
    fn every_existing_subcommand_still_dispatches() {
        assert_eq!(parse(Some("__edit")), Invocation::Edit);
        assert_eq!(parse(Some("__memory-recall")), Invocation::MemoryRecall);
        assert_eq!(parse(Some("__memory-save")), Invocation::MemorySave);
        assert_eq!(parse(Some("__hook-cli")), Invocation::HookCli);
        assert_eq!(parse(Some("pty-holder")), Invocation::PtyHolder);
        assert_eq!(parse(Some("swarm-reaper")), Invocation::SwarmReaper);
    }

    #[test]
    fn anything_else_is_unknown_and_never_serves() {
        for arg in ["", "--versio", "version", "-v", "serve", "--port", "PTY-HOLDER", "--"] {
            assert_eq!(parse(Some(arg)), Invocation::Unknown(arg.to_string()), "{arg:?}");
        }
    }

    #[test]
    fn version_line_names_the_binary_and_the_build_tag() {
        let line = version_line();
        assert!(line.starts_with("supermux-server "), "{line}");
        assert!(line.contains(crate::updates::version::CURRENT_TAG), "{line}");
    }

    #[test]
    fn usage_lists_every_subcommand() {
        for sub in ["pty-holder", "swarm-reaper", "__edit", "__memory-recall", "__memory-save", "__hook-cli"] {
            assert!(USAGE.contains(sub), "{sub}");
        }
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("supermux-lock-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_second_lock_on_the_same_data_dir_fails_until_the_first_is_dropped() {
        let dir = temp_dir();
        let first = lock_data_dir(&dir).expect("first lock");
        assert_eq!(first.path(), dir.join(LOCK_FILE));
        let pid = std::fs::read_to_string(dir.join(LOCK_FILE)).unwrap();
        assert_eq!(pid.trim(), std::process::id().to_string());

        match lock_data_dir(&dir) {
            Err(LockError::Held(p)) => assert_eq!(p, dir.join(LOCK_FILE)),
            other => panic!("second lock must fail as Held, got {other:?}"),
        }

        drop(first);
        lock_data_dir(&dir).expect("lock is free again once the holder is gone");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn different_data_dirs_do_not_contend() {
        let (a, b) = (temp_dir(), temp_dir());
        let _la = lock_data_dir(&a).expect("lock a");
        let _lb = lock_data_dir(&b).expect("lock b");
        let _ = std::fs::remove_dir_all(a);
        let _ = std::fs::remove_dir_all(b);
    }
}
