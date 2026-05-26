//! Per-host bootstrap probe (REMOTE_PLAN.md RT8).
//!
//! Drives the small "is this host ready to run remote Claude sessions?"
//! checklist that `POST /api/hosts/{id}/bootstrap` returns to the frontend. We
//! shell out to `ssh` directly (rather than going through the [`Transport`]
//! abstraction) because we need ONE step before HostPool's ControlMaster is
//! even up — the FE onboarding flow runs this on a freshly-registered host
//! that the user just added.
//!
//! Every probe is **best-effort**: missing prerequisites turn into entries in
//! [`BootstrapReport::warnings`] rather than a 500, so the FE can render a
//! "missing X" checklist instead of an opaque error.
//!
//! [`Transport`]: crate::sessions::Transport

use serde::Serialize;
use tokio::process::Command;

/// Result of a `POST /api/hosts/{id}/bootstrap` probe. The FE renders this as a
/// per-host onboarding checklist; warnings explain anything the user still
/// needs to install / configure on the remote.
#[derive(Debug, Default, Serialize)]
pub struct BootstrapReport {
    /// True when `which tmux` printed a non-empty path.
    pub tmux_installed: bool,
    /// Version reported by `tmux -V` (e.g. `"3.4"`), or `""` if tmux missing.
    pub tmux_version: String,
    /// Status of the remote work dir: `"created"` (`mkdir -p` succeeded),
    /// `"missing"` (mkdir failed — SSH down, permission denied, etc.), or
    /// `"skipped"` (probe wasn't run).
    pub supermux_dir: String,
    /// True when `which claude` found the Claude CLI on PATH.
    pub claude_installed: bool,
    /// True when `{"public_key": ...}` was provided AND we appended a fresh
    /// line to `~/.ssh/authorized_keys` (false if already present or no key).
    pub authorized_key_added: bool,
    /// Human-readable warnings for missing prerequisites — drives the FE
    /// onboarding hints. Never sensitive (no error text from ssh stderr leaks
    /// here — that goes via tracing).
    pub warnings: Vec<String>,
}

/// SSH-out command builder shared by every probe in this module. `ssh_target`
/// has already been validated against [`crate::hosts::SSH_TARGET_RE`] by the
/// HTTP layer, so it's safe to pass as a positional arg; the remote command
/// payload is the only attack surface and we only ever invoke fixed literals
/// against a fixed-key authorized_keys path.
fn ssh_cmd(ssh_target: &str, ssh_key_path: Option<&str>) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new");
    if let Some(key) = ssh_key_path {
        cmd.arg("-i").arg(key);
    }
    cmd.arg(ssh_target);
    cmd
}

/// Run `ssh <target> -- <remote_cmd>` and return the trimmed stdout on success,
/// or `Err(stderr-snippet)` on a non-zero exit / spawn failure. Always treats
/// the remote command as the LITERAL argv after `--` — no shell on this side.
async fn run_ssh(
    ssh_target: &str,
    ssh_key_path: Option<&str>,
    remote_argv: &[&str],
) -> Result<String, String> {
    let mut cmd = ssh_cmd(ssh_target, ssh_key_path);
    cmd.arg("--");
    for a in remote_argv {
        cmd.arg(a);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("ssh spawn failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(err);
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Run the full bootstrap probe. Order matters: tmux first (the gating
/// prereq), then the supermux work dir, then claude (a soft requirement —
/// only a warning when missing), then authorized_keys append (only when a
/// public key was supplied + already passes [`crate::hosts::valid_public_key`]
/// validation in the HTTP layer).
///
/// `public_key`, if `Some`, MUST have been validated by
/// [`crate::hosts::valid_public_key`] — this function trusts that no newlines
/// or shell metacharacters are present.
pub async fn run(
    ssh_target: &str,
    ssh_key_path: Option<&str>,
    public_key: Option<&str>,
) -> BootstrapReport {
    let mut report = BootstrapReport::default();

    // ── tmux ──────────────────────────────────────────────────────────────
    match run_ssh(ssh_target, ssh_key_path, &["which", "tmux"]).await {
        Ok(path) if !path.is_empty() => {
            report.tmux_installed = true;
            // Version probe is best-effort; "no version" isn't fatal.
            if let Ok(ver) = run_ssh(ssh_target, ssh_key_path, &["tmux", "-V"]).await {
                // `tmux -V` prints e.g. `tmux 3.4` — keep the version token only.
                report.tmux_version = ver
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or(ver.as_str())
                    .to_string();
            }
        }
        Ok(_) => {
            // which printed an empty line → tmux NOT on PATH.
            report
                .warnings
                .push("tmux not found on remote PATH — install tmux >= 3.0".into());
        }
        Err(err) => {
            report
                .warnings
                .push(format!("ssh probe for tmux failed: {err}"));
        }
    }

    // ── supermux work dir ─────────────────────────────────────────────────
    match run_ssh(
        ssh_target,
        ssh_key_path,
        &["mkdir", "-p", "$HOME/.supermux-remote"],
    )
    .await
    {
        Ok(_) => report.supermux_dir = "created".into(),
        Err(err) => {
            report.supermux_dir = "missing".into();
            report
                .warnings
                .push(format!("could not create ~/.supermux-remote: {err}"));
        }
    }

    // ── claude CLI ────────────────────────────────────────────────────────
    match run_ssh(ssh_target, ssh_key_path, &["which", "claude"]).await {
        Ok(path) if !path.is_empty() => {
            report.claude_installed = true;
        }
        _ => {
            report.claude_installed = false;
            report.warnings.push(
                "claude CLI not found on remote PATH — install before running Claude sessions"
                    .into(),
            );
        }
    }

    // ── optional public-key install ───────────────────────────────────────
    if let Some(key) = public_key {
        match append_authorized_key(ssh_target, ssh_key_path, key).await {
            Ok(added) => {
                report.authorized_key_added = added;
                if !added {
                    report
                        .warnings
                        .push("public key already present in ~/.ssh/authorized_keys".into());
                }
            }
            Err(err) => report
                .warnings
                .push(format!("authorized_keys install failed: {err}")),
        }
    }

    report
}

/// Append `public_key` to the remote `~/.ssh/authorized_keys`, deduplicating
/// with `grep -F` first. Returns `Ok(true)` when a new line was added,
/// `Ok(false)` when the key was already present.
///
/// `public_key` is validated upstream — see [`crate::hosts::valid_public_key`]
/// — so it carries no newlines, no shell meta, and starts with a known
/// algorithm token.
///
/// **Why base64.** OpenSSH's client flattens every argv element after the
/// target with single spaces (no quoting) and hands the whole thing to the
/// remote `$SHELL -c "<flattened>"`. The naive `ssh ... -- sh -c <script> sh
/// <pubkey>` pattern therefore does NOT pass `pubkey` as `"$1"` to an inner
/// `sh -c` — the remote outer shell word-splits everything. To defeat that
/// without trusting the remote shell with raw user-controlled bytes we
/// base64-encode the key here (charset `[A-Za-z0-9+/=]`, no shell metas) and
/// embed the encoded literal inside a single-quoted shell context. The remote
/// shell decodes it via `base64 -d` into a real variable that we then quote
/// normally — so even a comment with spaces or unusual ASCII survives intact.
async fn append_authorized_key(
    ssh_target: &str,
    ssh_key_path: Option<&str>,
    public_key: &str,
) -> Result<bool, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let key_b64 = STANDARD.encode(public_key.as_bytes());
    // Single-quoted base64 token: the only `'` in the script body bounds the
    // literal, and base64's charset cannot contain `'`, so the literal cannot
    // escape its quotes. Newlines and `;` between statements are preserved
    // across OpenSSH's argv-flatten.
    let script = format!(
        r#"set -eu
key=$(printf %s '{key_b64}' | base64 -d)
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
if grep -Fq -- "$key" "$HOME/.ssh/authorized_keys"; then
  echo dup
else
  printf '%s\n' "$key" >> "$HOME/.ssh/authorized_keys"
  echo added
fi
"#
    );
    let out = run_ssh(ssh_target, ssh_key_path, &[&script]).await?;
    Ok(out.lines().last().unwrap_or("").trim() == "added")
}
