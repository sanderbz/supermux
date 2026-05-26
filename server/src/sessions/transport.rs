//! Transport abstraction for shelling commands locally OR over an SSH
//! ControlMaster (REMOTE_PLAN §RT1).
//!
//! **The seam.** Every `tmux` (and later `git`, `claude`, …) shell-out in the
//! sessions layer funnels through [`Transport::spawn_command`]. The local case
//! is the identity transform (`Command::new(program).args(args)`); the SSH case
//! prepends an `ssh -o ControlPath=… -- <program>` wrapper that re-uses a
//! persistent multiplexed connection (one per host, opened on first use by
//! `HostPool` in RT2). After the master is warm every call is sub-ms.
//!
//! **Why a `&'a Transport` field on `Tmux`.** The hot path here is local —
//! every caller of `Tmux::new(name)` continues to use a `&'static LOCAL`
//! reference, zero allocation per call. Remote sessions get an
//! `Arc<Transport>` from `HostPool` and pass `&*arc` instead. The lifetime
//! parameter on `Tmux<'a>` is reused (it already carried `&'a str` for the
//! name) so this is a refactor without new generic machinery.
//!
//! **Backwards compat.** `Tmux::new(name)` and `Tmux::for_pane(name, pane_id)`
//! retain their old signatures; both default to `&LOCAL`. New `_on` variants
//! take an explicit `&Transport` for the remote path (wired up in later
//! milestones). This means no callsite changes anywhere in `server/src`.

use std::path::PathBuf;

use tokio::process::Command;

/// A host row's primary key (DB-backed in RT4). For RT1 this is a placeholder
/// newtype — `HostPool` (RT2) and the `hosts` table (RT4) give it real
/// semantics. `Copy` because it's just an `i64`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct HostId(pub i64);

/// Where a shell-out runs. `Local` is the today-path (direct `Command::new`);
/// `Ssh` re-uses an existing SSH ControlMaster socket for sub-ms hops to a
/// remote host. The `control_path` is the unix socket the master listens on
/// (`~/.supermux/ssh-control/cm-<host_id>` per RT2's convention); the master
/// itself is managed by `HostPool` (RT2) — this enum is a *value* describing
/// where to dispatch, not a connection lifecycle.
#[derive(Debug, Clone)]
pub enum Transport {
    /// Run the command in this process's environment, on this host.
    Local,
    /// Run the command on a remote host via an established SSH ControlMaster.
    Ssh {
        /// Identifies the host in the `hosts` table (RT4).
        host_id: HostId,
        /// SSH target spec, e.g. `user@ml-rig.tailnet.ts.net` — passed
        /// verbatim as the last positional arg to `ssh`.
        ssh_target: String,
        /// Unix socket path the ControlMaster is listening on. Passed via
        /// `-o ControlPath=…`. The master is opened by `HostPool` (RT2)
        /// before any `Transport::Ssh` value is ever handed out, so by the
        /// time `spawn_command` runs the socket is ready.
        control_path: PathBuf,
    },
}

impl Transport {
    /// Build a [`tokio::process::Command`] that, when spawned, executes
    /// `program` with `args` either locally OR via the host's SSH
    /// ControlMaster. The returned `Command` is configured but NOT spawned —
    /// callers can still tweak `stdin/stdout/stderr` / env / cwd before
    /// `.output()` / `.spawn()`.
    ///
    /// **Local** is the identity transform: `Command::new(program).args(args)`.
    ///
    /// **Ssh** wraps the program as
    ///
    /// ```text
    /// ssh -o ControlPath=<path>
    ///     -o ControlMaster=auto
    ///     -o ControlPersist=600
    ///     -o BatchMode=yes
    ///     <ssh_target>
    ///     -- <program> <args…>
    /// ```
    ///
    /// `ControlMaster=auto` + a pre-existing socket means ssh re-uses the
    /// master — no new TCP handshake, no new auth. `BatchMode=yes` refuses
    /// any password prompt (we want a clean failure on a broken master, not
    /// a hung child). The `--` separator stops ssh from parsing `program` /
    /// `args` flags as its own.
    pub fn spawn_command(&self, program: &str, args: &[&str]) -> Command {
        match self {
            Transport::Local => {
                let mut cmd = Command::new(program);
                cmd.args(args);
                cmd
            }
            Transport::Ssh {
                ssh_target,
                control_path,
                ..
            } => {
                let mut cmd = Command::new("ssh");
                cmd.args([
                    "-o",
                    &format!("ControlPath={}", control_path.display()),
                    "-o",
                    "ControlMaster=auto",
                    "-o",
                    "ControlPersist=600",
                    "-o",
                    "BatchMode=yes",
                    ssh_target,
                    "--",
                    program,
                ]);
                cmd.args(args);
                cmd
            }
        }
    }

    /// True for the local transport — useful when callers can take a faster
    /// in-process path (e.g. `std::fs::*` instead of an SFTP roundtrip) and
    /// don't want to match the whole enum.
    pub fn is_local(&self) -> bool {
        matches!(self, Transport::Local)
    }
}

/// Static `Transport::Local` for the common case. Zero-cost: callers thread in
/// `&LOCAL` instead of materialising a fresh enum each time. Safe to hand
/// `&'static LOCAL` across threads — `Transport::Local` is a unit-ish variant
/// with no interior mutability, so `&LOCAL` is trivially `Send + Sync`.
pub static LOCAL: Transport = Transport::Local;

#[cfg(test)]
mod tests {
    //! `spawn_command` is the load-bearing contract: the local path MUST be
    //! `Command::new(program).args(args)` byte-for-byte (no regression for
    //! today's callers) and the ssh path MUST produce the exact argv that
    //! re-uses an existing ControlMaster. We exercise both by inspecting the
    //! resulting `Command`'s `std` mirror — that's the only stable way to
    //! read back program + args without actually spawning a child.

    use super::*;

    fn argv_of(cmd: &Command) -> (String, Vec<String>) {
        let std_cmd = cmd.as_std();
        let program = std_cmd.get_program().to_string_lossy().to_string();
        let args = std_cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        (program, args)
    }

    #[test]
    fn local_is_identity() {
        let cmd = LOCAL.spawn_command("tmux", &["has-session", "-t", "supermux-foo"]);
        let (prog, args) = argv_of(&cmd);
        assert_eq!(prog, "tmux");
        assert_eq!(args, vec!["has-session", "-t", "supermux-foo"]);
    }

    #[test]
    fn local_with_no_args() {
        let cmd = LOCAL.spawn_command("true", &[]);
        let (prog, args) = argv_of(&cmd);
        assert_eq!(prog, "true");
        assert!(args.is_empty());
    }

    #[test]
    fn ssh_wraps_with_controlmaster_options() {
        let t = Transport::Ssh {
            host_id: HostId(7),
            ssh_target: "user@ml-rig".to_string(),
            control_path: PathBuf::from("/tmp/cm-7"),
        };
        let cmd = t.spawn_command("tmux", &["has-session", "-t", "supermux-foo"]);
        let (prog, args) = argv_of(&cmd);
        assert_eq!(prog, "ssh");
        assert_eq!(
            args,
            vec![
                "-o",
                "ControlPath=/tmp/cm-7",
                "-o",
                "ControlMaster=auto",
                "-o",
                "ControlPersist=600",
                "-o",
                "BatchMode=yes",
                "user@ml-rig",
                "--",
                "tmux",
                "has-session",
                "-t",
                "supermux-foo",
            ]
        );
    }

    #[test]
    fn is_local_predicate() {
        assert!(LOCAL.is_local());
        assert!(Transport::Local.is_local());
        let remote = Transport::Ssh {
            host_id: HostId(1),
            ssh_target: "x@y".into(),
            control_path: PathBuf::from("/tmp/cm-1"),
        };
        assert!(!remote.is_local());
    }
}
