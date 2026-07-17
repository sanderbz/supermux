//! Runtime configuration.
//!
//! Loaded once at startup and passed everywhere via `Arc<Config>` in
//! [`crate::state::AppState`]. Resolution order:
//!   1. Built-in defaults.
//!   2. `SUPERMUX_DATA_DIR` env var (else `~/.supermux`) — where `config.toml`,
//!      `data.db`, and `auth_token` live. The deploy systemd unit sets
//!      this; the e2e smoke harness sets it for isolation so a test run
//!      never touches the real user's `~/.supermux`.
//!   3. `<data_dir>/config.toml` (partial override, all keys optional).
//!   4. `SUPERMUX_BIND` env var overrides the `bind` address (e.g. `127.0.0.1:0`
//!      for an ephemeral test port).
//!   5. `SUPERMUX_AUTH_TOKEN` env var, else `config.toml` value, else
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
    /// Data directory, default `~/.supermux`. Holds `data.db`, `auth_token`, logs.
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
    /// Live-stream WebSocket tuning.
    pub ws: WsConfig,
    /// URL the REMOTE host's Claude `SettingsHook` curl
    /// dials back to. `127.0.0.1:8823` is the local-session default and is
    /// useless for a Claude process running on a different machine — it would
    /// just hit the REMOTE's own loopback. When unset, the lifecycle resolver
    /// falls back to `extra_binds` (first non-loopback) and finally `bind`,
    /// in that order. The env override `SUPERMUX_REMOTE_URL` takes precedence
    /// over both — used by ad-hoc reverse-tunnel smoke tests
    /// (`ssh -R 8823:127.0.0.1:8823 host` + `SUPERMUX_REMOTE_URL=http://127.0.0.1:8823`).
    /// Local sessions are unaffected.
    pub remote_callback_url: Option<String>,
    /// VAPID JWT `sub` claim for web push (`mailto:<contact>` URL). RFC 8292
    /// requires this; Apple's APNs (iPhone Safari/PWA) is strict and rejects
    /// bogus values like `mailto:user@localhost` with 400 BadRequest. When
    /// unset, falls back to a clearly-flagged `mailto:noreply@example.com`
    /// sentinel — fine for local dev, but `init_vapid` logs a warning so an
    /// operator with real iPhone subscribers knows to set this. The env
    /// override `SUPERMUX_PUSH_SUB` takes precedence.
    pub push_sub: Option<String>,
    /// Optional GitHub Personal Access Token used ONLY by the in-UI updater
    /// when fetching `releases/latest`. The default (anonymous) request works
    /// for every user on the public `sanderbz/supermux` repo. Two cases need
    /// a token:
    ///   1. A user self-hosting their own PRIVATE fork — GitHub returns 404
    ///      to anonymous requests, surfacing as "Couldn't reach GitHub".
    ///   2. A shared-IP deployment hitting the 60-req/hour unauthenticated
    ///      rate limit. Authenticated requests get 5,000 req/hour.
    /// Resolution order: `SUPERMUX_GITHUB_TOKEN` env (preferred — never lands
    /// in a config file), else `github_token` in `config.toml`. Quiet by
    /// design: no UI, no warning if unset, no prompt. See
    /// `docs/SELF_HOST_DEV.md` "Advanced — private repos / rate limits".
    pub github_token: Option<String>,
    /// Extra hostnames to allow as WebSocket `Origin` headers. The
    /// built-in allowlist covers `localhost`, private-LAN IPs, `*.ts.net`, and
    /// the server's own bind IPs. Add entries here for reverse-proxy deployments
    /// where the browser-facing hostname is none of the above — e.g.
    /// `extra_origins = ["myhost.internal", "supermux.corp.example.com"]`.
    /// Exact hostname match only (no wildcards). The scheme is ignored; only
    /// the host part of the `Origin` header is compared.
    pub extra_origins: Vec<String>,
}

/// `[ws]` config block. Both knobs are sized so a single multi-device PWA user
/// (phone + laptop + tabs + Capacitor + TV + collaborator) easily fits — the
/// older caps of 8/256 were too tight.
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
    pub kimi_flags: String,
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
    /// See [`Config::remote_callback_url`].
    #[serde(default)]
    remote_callback_url: Option<String>,
    /// See [`Config::push_sub`].
    #[serde(default)]
    push_sub: Option<String>,
    /// See [`Config::github_token`].
    #[serde(default)]
    github_token: Option<String>,
    /// See [`Config::extra_origins`].
    #[serde(default)]
    extra_origins: Vec<String>,
}

fn default_data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".supermux")
}

fn default_bind() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 8823))
}

/// Load and resolve configuration, creating `data_dir` and the auth-token file
/// if needed.
pub fn load() -> Result<Config> {
    // `SUPERMUX_DATA_DIR` (deploy unit + e2e isolation) wins over the default,
    // so `config.toml`/`auth_token` are read from there before anything else.
    let provisional_data_dir = env_path("SUPERMUX_DATA_DIR").unwrap_or_else(default_data_dir);
    let cfg_path = provisional_data_dir.join("config.toml");

    let raw: RawConfig = if cfg_path.exists() {
        let text = std::fs::read_to_string(&cfg_path)
            .with_context(|| format!("reading {}", cfg_path.display()))?;
        toml::from_str(&text).with_context(|| format!("parsing {}", cfg_path.display()))?
    } else {
        RawConfig::default()
    };

    // `SUPERMUX_DATA_DIR` (if set) takes precedence over a `config.toml` data_dir.
    let data_dir = env_path("SUPERMUX_DATA_DIR")
        .or(raw.data_dir)
        .unwrap_or(provisional_data_dir);
    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("creating data dir {}", data_dir.display()))?;

    let auth_token = resolve_auth_token(&data_dir, raw.auth_token)?;

    // `SUPERMUX_BIND` overrides the configured bind (ephemeral `:0` in e2e tests).
    let bind = match std::env::var("SUPERMUX_BIND") {
        Ok(s) if !s.trim().is_empty() => s
            .trim()
            .parse()
            .with_context(|| format!("parsing SUPERMUX_BIND={s}"))?,
        _ => raw.bind.unwrap_or_else(default_bind),
    };

    // SUPERMUX_PUSH_SUB env override wins over config.toml — handy for ad-hoc
    // deploys that don't ship a config file.
    let push_sub = std::env::var("SUPERMUX_PUSH_SUB")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or(raw.push_sub);

    // GitHub token for the in-UI updater (see `Config::github_token`).
    // Env wins so an operator's PAT NEVER lands on disk inadvertently. If
    // only `config.toml` provides it, re-export to env so `release::fetch_latest`
    // — which reads `std::env::var` directly — sees a single source of truth
    // without us threading an Arc<Config> through the release cache.
    let github_token = std::env::var("SUPERMUX_GITHUB_TOKEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            raw.github_token
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    // Mirror config.toml → env so the release fetcher only has
                    // one place to look. Safe: we only set the var when it
                    // was unset (env branch above would have short-circuited).
                    // SAFETY: `set_var` may race with concurrent reads on
                    // platforms with non-atomic env tables; this runs once at
                    // startup before any task is spawned.
                    unsafe { std::env::set_var("SUPERMUX_GITHUB_TOKEN", s); }
                    s.to_string()
                })
        });

    Ok(Config {
        data_dir,
        bind,
        extra_binds: raw.extra_binds,
        tls: raw.tls,
        auth_token,
        provider_defaults: raw.provider_defaults,
        ws: raw.ws,
        remote_callback_url: raw.remote_callback_url,
        push_sub,
        github_token,
        extra_origins: raw.extra_origins,
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
/// Priority: `SUPERMUX_AUTH_TOKEN` env → `config.toml` value → `auth_token` file →
/// freshly generated token persisted to `<data_dir>/auth_token` (mode 0o600).
fn resolve_auth_token(data_dir: &Path, from_file_cfg: Option<String>) -> Result<String> {
    if let Ok(env_tok) = std::env::var("SUPERMUX_AUTH_TOKEN") {
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
