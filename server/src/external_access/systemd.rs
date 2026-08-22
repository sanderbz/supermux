//! The connector-runtime seam: writing + starting the `cloudflared` user unit.
//!
//! The server runs the tunnel connector itself. Provisioning writes the connector
//! token 0600, writes `~/.config/systemd/user/cloudflared.service` (referencing
//! that token via `EnvironmentFile=`, NEVER inline), enables lingering and starts
//! the unit. All of that sits behind [`ConnectorHost`] so `provision-tunnel` is
//! testable WITHOUT a live `systemctl --user` — [`MockConnectorHost`] records the
//! plan and reports a chosen state.
//!
//! **Degrades gracefully.** This sandboxed box has no usable `systemctl --user`,
//! so [`RealConnectorHost`] returns [`ConnectorState::Unavailable`] with a reason
//! instead of panicking; the status endpoint surfaces that honestly and the UI
//! falls back to an "Advanced / run manually" copy block.

use std::path::PathBuf;

/// The outcome of trying to install + start the connector unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectorState {
    /// The user unit was written, enabled and started.
    Started,
    /// `systemd --user` (or `loginctl`) is unavailable in this environment; the
    /// reason is surfaced to the UI's manual-fallback block. Never a panic.
    Unavailable(String),
}

impl ConnectorState {
    pub fn is_started(&self) -> bool {
        matches!(self, ConnectorState::Started)
    }
}

/// Everything needed to write + run the connector unit for this box.
#[derive(Debug, Clone)]
pub struct ConnectorPlan {
    /// The connector run token (the secret). Written 0600 and referenced by the
    /// unit's `EnvironmentFile`, never placed inline in the unit.
    pub connector_token: String,
    /// Where the 0600 token env-file is written (`<data_dir>/cloudflared_token`).
    pub token_path: PathBuf,
    /// Where the user unit is written
    /// (`~/.config/systemd/user/cloudflared.service`).
    pub unit_path: PathBuf,
    /// The `cloudflared` binary path (`~/bin/cloudflared`).
    pub cloudflared_bin: PathBuf,
}

/// The mockable connector-runtime surface.
pub trait ConnectorHost: Send + Sync {
    /// Write the 0600 token env-file + the user unit and start it. Idempotent:
    /// re-running overwrites the token + unit and re-`enable --now`s.
    fn provision(&self, plan: &ConnectorPlan) -> ConnectorState;
    /// Is the connector unit currently active? Best-effort; `false` when it cannot
    /// be determined (used only to colour the status chip).
    fn is_active(&self) -> bool;
}

// ── real implementation ──────────────────────────────────────────────────────

/// Writes the token 0600, writes the user unit referencing it via
/// `EnvironmentFile=`, `loginctl enable-linger`, `systemctl --user enable --now`.
pub struct RealConnectorHost;

impl RealConnectorHost {
    fn systemctl_available() -> bool {
        // `systemctl --user` needs a user D-Bus session bus (advertised via
        // `XDG_RUNTIME_DIR`) plus the binary on PATH. On this sandboxed service
        // box there is no user bus, so we probe cheaply and degrade.
        std::env::var_os("XDG_RUNTIME_DIR").is_some() && which("systemctl").is_some()
    }

    /// The `EnvironmentFile`-based unit body. The token is NOT inline.
    fn unit_body(plan: &ConnectorPlan) -> String {
        format!(
            "[Unit]\n\
             Description=supermux cloudflared connector\n\
             After=network-online.target\n\
             Wants=network-online.target\n\
             \n\
             [Service]\n\
             Type=notify\n\
             EnvironmentFile={token_file}\n\
             ExecStart={bin} tunnel --no-autoupdate run --token ${{TUNNEL_TOKEN}}\n\
             Restart=on-failure\n\
             RestartSec=5\n\
             \n\
             [Install]\n\
             WantedBy=default.target\n",
            token_file = plan.token_path.display(),
            bin = plan.cloudflared_bin.display(),
        )
    }
}

impl ConnectorHost for RealConnectorHost {
    fn provision(&self, plan: &ConnectorPlan) -> ConnectorState {
        // 1. Write the token env-file 0600 (KEY=VALUE the unit's EnvironmentFile reads).
        let env_line = format!("TUNNEL_TOKEN={}", plan.connector_token);
        if let Err(e) = crate::config::write_token_0600(&plan.token_path, &env_line) {
            return ConnectorState::Unavailable(format!("writing connector token: {e}"));
        }
        // 2. Write the unit.
        if let Some(dir) = plan.unit_path.parent() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                return ConnectorState::Unavailable(format!("creating unit dir: {e}"));
            }
        }
        if let Err(e) = std::fs::write(&plan.unit_path, Self::unit_body(plan)) {
            return ConnectorState::Unavailable(format!("writing unit: {e}"));
        }
        // 3. Enable + start — only if systemd --user is actually usable.
        if !Self::systemctl_available() {
            return ConnectorState::Unavailable(
                "systemd --user is unavailable on this host (no user session bus); \
                 run cloudflared manually from the token file"
                    .to_string(),
            );
        }
        let _ = run(&["loginctl", "enable-linger"]);
        let _ = run(&["systemctl", "--user", "daemon-reload"]);
        match run(&["systemctl", "--user", "enable", "--now", "cloudflared.service"]) {
            Ok(true) => ConnectorState::Started,
            Ok(false) => ConnectorState::Unavailable("systemctl enable --now failed".to_string()),
            Err(e) => ConnectorState::Unavailable(format!("systemctl: {e}")),
        }
    }

    fn is_active(&self) -> bool {
        matches!(
            run(&["systemctl", "--user", "is-active", "cloudflared.service"]),
            Ok(true)
        )
    }
}

/// Run a command, returning `Ok(true)` on exit-0, `Ok(false)` on non-zero, `Err`
/// if it could not be spawned. Never panics.
fn run(args: &[&str]) -> std::io::Result<bool> {
    let (cmd, rest) = args.split_first().expect("non-empty argv");
    let status = std::process::Command::new(cmd).args(rest).status()?;
    Ok(status.success())
}

/// Minimal `which`: is `bin` on `PATH`?
fn which(bin: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|p| p.join(bin))
            .find(|p| p.is_file())
    })
}

// ── test double ──────────────────────────────────────────────────────────────

/// Records the provisioning plan and reports a chosen [`ConnectorState`], so
/// `provision-tunnel` is testable without touching systemd. Still writes the
/// token + unit files (so the 0600 + no-inline-secret invariants are asserted),
/// but never shells out.
#[cfg(test)]
pub struct MockConnectorHost {
    pub state: ConnectorState,
    pub active: bool,
    pub provisions: std::sync::atomic::AtomicUsize,
    pub last_plan: std::sync::Mutex<Option<ConnectorPlan>>,
}

#[cfg(test)]
impl Default for MockConnectorHost {
    fn default() -> Self {
        Self {
            state: ConnectorState::Started,
            active: true,
            provisions: std::sync::atomic::AtomicUsize::new(0),
            last_plan: std::sync::Mutex::new(None),
        }
    }
}

#[cfg(test)]
impl MockConnectorHost {
    pub fn provision_count(&self) -> usize {
        self.provisions.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The unit body the real host would write for the recorded plan — used by
    /// tests to assert `EnvironmentFile=` + no inline secret.
    pub fn recorded_unit_body(&self) -> Option<String> {
        self.last_plan
            .lock()
            .unwrap()
            .as_ref()
            .map(RealConnectorHost::unit_body)
    }
}

#[cfg(test)]
impl ConnectorHost for MockConnectorHost {
    fn provision(&self, plan: &ConnectorPlan) -> ConnectorState {
        self.provisions
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // Write ONLY the 0600 token env-file (under the test's data dir) so the
        // secret-handling invariant can be asserted against a real file. The unit
        // is deliberately NOT written to `plan.unit_path` (the real
        // `~/.config/systemd/user/...`) so the test never touches the actual home;
        // the unit body is asserted via `unit_body(plan)` from `last_plan` instead.
        let env_line = format!("TUNNEL_TOKEN={}", plan.connector_token);
        let _ = crate::config::write_token_0600(&plan.token_path, &env_line);
        *self.last_plan.lock().unwrap() = Some(plan.clone());
        self.state.clone()
    }

    fn is_active(&self) -> bool {
        self.active
    }
}
