//! Runtime configuration (TECH_PLAN §3.2.2).
//!
//! Loaded once at startup and passed everywhere via `Arc<Config>` in
//! [`crate::state::AppState`]. Resolution order:
//!   1. Built-in defaults.
//!   2. `~/.amux-v3/config.toml` (partial override, all keys optional).
//!   3. `AMUX3_AUTH_TOKEN` env var, else `~/.amux-v3/auth_token` file
//!      (generated mode 0o600 on first start).

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
    // Start from defaults so we know data_dir before reading the optional file.
    let provisional_data_dir = default_data_dir();
    let cfg_path = provisional_data_dir.join("config.toml");

    let raw: RawConfig = if cfg_path.exists() {
        let text = std::fs::read_to_string(&cfg_path)
            .with_context(|| format!("reading {}", cfg_path.display()))?;
        toml::from_str(&text).with_context(|| format!("parsing {}", cfg_path.display()))?
    } else {
        RawConfig::default()
    };

    let data_dir = raw.data_dir.unwrap_or(provisional_data_dir);
    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("creating data dir {}", data_dir.display()))?;

    let auth_token = resolve_auth_token(&data_dir, raw.auth_token)?;

    Ok(Config {
        data_dir,
        bind: raw.bind.unwrap_or_else(default_bind),
        extra_binds: raw.extra_binds,
        tls: raw.tls,
        auth_token,
        provider_defaults: raw.provider_defaults,
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
