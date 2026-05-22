//! Runtime configuration (TECH_PLAN §3.2.2).
//!
//! Loaded once at startup and passed everywhere via `Arc<Config>` in
//! [`crate::state::AppState`]. Resolution order:
//!   1. Built-in defaults.
//!   2. `AMUX3_DATA_DIR` env var (else `~/.amux-v3`) — where `config.toml`,
//!      `data.db`, and `auth_token` live. The deploy systemd unit (§8.3) sets
//!      this; the e2e smoke harness (M24a) sets it for isolation so a test run
//!      never touches the real user's `~/.amux-v3`.
//!   3. `<data_dir>/config.toml` (partial override, all keys optional).
//!   4. `AMUX3_BIND` env var overrides the `bind` address (e.g. `127.0.0.1:0`
//!      for an ephemeral test port).
//!   5. `AMUX3_AUTH_TOKEN` env var, else `config.toml` value, else
//!      `<data_dir>/auth_token` file (generated mode 0o600 on first start).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;

/// Fully-resolved configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Data directory, default `~/.amux-v3`. Holds `data.db`, `auth_token`, logs.
    pub data_dir: PathBuf,
    /// Primary bind address, default `127.0.0.1:8823`.
    pub bind: SocketAddr,
    /// Extra bind addresses (e.g. a Tailscale IP). Reserved for a later milestone.
    pub extra_binds: Vec<SocketAddr>,
    /// TLS cert/key configuration. Reserved for a later milestone.
    pub tls: TlsConfig,
    /// Dashboard bearer token. Constant-time compared on every request.
    pub auth_token: String,
    /// Per-provider default flags.
    pub provider_defaults: ProviderDefaults,
    /// Live-stream WebSocket tuning (§3.2.7/§3.2.9).
    pub ws: WsConfig,
}

/// `[ws]` config block (TECH_PLAN §3.2.7). Both knobs raised from v1 per CEO #6:
/// a single multi-device PWA user (phone + laptop + tabs + Capacitor + TV +
/// collaborator) easily exceeds the old caps of 8/256.
#[derive(Debug, Clone, Deserialize)]
pub struct WsConfig {
    /// Per-session pty `broadcast::Sender` capacity (slow-subscriber buffer).
    #[serde(default = "default_broadcast_capacity")]
    pub broadcast_capacity: usize,
    /// Max concurrent WS subscribers per session; the 33rd (default) → close 1013.
    #[serde(default = "default_subscribers_per_session")]
    pub subscribers_per_session: usize,
}

fn default_broadcast_capacity() -> usize {
    1024
}

fn default_subscribers_per_session() -> usize {
    32
}

impl Default for WsConfig {
    fn default() -> Self {
        Self {
            broadcast_capacity: default_broadcast_capacity(),
            subscribers_per_session: default_subscribers_per_session(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct TlsConfig {
    pub cert_path: Option<PathBuf>,
    pub key_path: Option<PathBuf>,
    /// Generate a self-signed cert when no cert/key paths are given.
    #[serde(default)]
    pub self_signed: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProviderDefaults {
    #[serde(default)]
    pub claude_flags: String,
    #[serde(default)]
    pub codex_flags: String,
    #[serde(default)]
    pub default_model: String,
}

/// On-disk `config.toml` shape — every field optional so a partial file is valid.
#[derive(Debug, Default, Deserialize)]
struct RawConfig {
    data_dir: Option<PathBuf>,
    bind: Option<SocketAddr>,
    #[serde(default)]
    extra_binds: Vec<SocketAddr>,
    #[serde(default)]
    tls: TlsConfig,
    auth_token: Option<String>,
    #[serde(default)]
    provider_defaults: ProviderDefaults,
    #[serde(default)]
    ws: WsConfig,
}

fn default_data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".amux-v3")
}

fn default_bind() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 8823))
}

/// Load and resolve configuration, creating `data_dir` and the auth-token file
/// if needed.
pub fn load() -> Result<Config> {
    // `AMUX3_DATA_DIR` (deploy unit §8.3 + e2e isolation) wins over the default,
    // so `config.toml`/`auth_token` are read from there before anything else.
    let provisional_data_dir = env_path("AMUX3_DATA_DIR").unwrap_or_else(default_data_dir);
    let cfg_path = provisional_data_dir.join("config.toml");

    let raw: RawConfig = if cfg_path.exists() {
        let text = std::fs::read_to_string(&cfg_path)
            .with_context(|| format!("reading {}", cfg_path.display()))?;
        toml::from_str(&text).with_context(|| format!("parsing {}", cfg_path.display()))?
    } else {
        RawConfig::default()
    };

    // `AMUX3_DATA_DIR` (if set) takes precedence over a `config.toml` data_dir.
    let data_dir = env_path("AMUX3_DATA_DIR")
        .or(raw.data_dir)
        .unwrap_or(provisional_data_dir);
    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("creating data dir {}", data_dir.display()))?;

    let auth_token = resolve_auth_token(&data_dir, raw.auth_token)?;

    // `AMUX3_BIND` overrides the configured bind (ephemeral `:0` in e2e tests).
    let bind = match std::env::var("AMUX3_BIND") {
        Ok(s) if !s.trim().is_empty() => s
            .trim()
            .parse()
            .with_context(|| format!("parsing AMUX3_BIND={s}"))?,
        _ => raw.bind.unwrap_or_else(default_bind),
    };

    Ok(Config {
        data_dir,
        bind,
        extra_binds: raw.extra_binds,
        tls: raw.tls,
        auth_token,
        provider_defaults: raw.provider_defaults,
        ws: raw.ws,
    })
}

/// Read a non-empty filesystem path from an env var, trimming surrounding space.
fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key).ok().and_then(|v| {
        let t = v.trim();
        (!t.is_empty()).then(|| PathBuf::from(t))
    })
}

/// Resolve the dashboard bearer token.
///
/// Priority: `AMUX3_AUTH_TOKEN` env → `config.toml` value → `auth_token` file →
/// freshly generated token persisted to `<data_dir>/auth_token` (mode 0o600).
fn resolve_auth_token(data_dir: &Path, from_file_cfg: Option<String>) -> Result<String> {
    if let Ok(env_tok) = std::env::var("AMUX3_AUTH_TOKEN") {
        let env_tok = env_tok.trim().to_string();
        if !env_tok.is_empty() {
            return Ok(env_tok);
        }
    }
    if let Some(tok) = from_file_cfg {
        let tok = tok.trim().to_string();
        if !tok.is_empty() {
            return Ok(tok);
        }
    }

    let token_path = data_dir.join("auth_token");
    if token_path.exists() {
        let tok = std::fs::read_to_string(&token_path)
            .with_context(|| format!("reading {}", token_path.display()))?;
        let tok = tok.trim().to_string();
        if !tok.is_empty() {
            return Ok(tok);
        }
    }

    let token = generate_token();
    write_token_0600(&token_path, &token)
        .with_context(|| format!("writing {}", token_path.display()))?;
    Ok(token)
}

/// 32 random bytes, base64url (no padding).
fn generate_token() -> String {
    let mut buf = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// Write `token` to `path` with `0o600` permissions on Unix.
fn write_token_0600(path: &Path, token: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(token.as_bytes())?;
        f.write_all(b"\n")?;
        f.flush()?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, format!("{token}\n"))?;
    }
    Ok(())
}
