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
use serde::{Deserialize, Serialize};

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
    /// May supermux manage Claude Code's status line on this host? **Default
    /// `false`.**
    ///
    /// The statusline tap ([`crate::sessions::chat::statusline`]) is the one
    /// thing the chat data plane writes into the user's own
    /// `~/.claude/settings.json` beyond the status hooks, and it is opt-in by
    /// construction: with this `false`, `POST /api/claude/statusline/install`
    /// refuses, and nothing in the session create/start path can reach the
    /// installer at all (pinned by `tests/statusline_optin.rs`). Turning it on
    /// only makes the explicit install endpoint available — it never installs
    /// anything by itself.
    ///
    /// `DELETE /api/claude/statusline` is deliberately NOT gated on this: taking
    /// our wrapper back out must stay possible after the flag is turned off.
    ///
    /// **WHAT TURNING IT ON BUYS, since the payload is finally read.** Until
    /// this change the tap fed `AppState::set_statusline` and nothing else —
    /// `AppState::statusline()` had zero call sites, so the snapshot was stored
    /// and never looked at. `SessionView::rate_limits` is now derived from it,
    /// which makes the tap the only source in this product of usage HEADROOM:
    /// the `five_hour` / `seven_day` `used_percentage` pair, i.e. the one signal
    /// that arrives BEFORE a session is cut off rather than after. Everything
    /// else supermux knows about limits (`SessionView::blocked`,
    /// `SessionView::limit_warning`) is read off the banner Claude Code prints
    /// once the damage is done.
    ///
    /// **The default stays `false`, and this change does not touch it.** Two
    /// reasons, both about consent rather than caution: the tap edits the user's
    /// own `~/.claude/settings.json`, and it is global to that Claude install
    /// rather than per-session — so it affects every `claude` the user runs,
    /// supermux's or not. The gauge is worth having; it is not worth taking
    /// without asking. To turn it on, set `statusline_tap = true` in
    /// `config.toml` and then `POST /api/claude/statusline/install` (the
    /// `mode=wrap` default preserves an existing status line; `mode=tap_only` is
    /// for a host that has none). `DELETE /api/claude/statusline` reverses it
    /// exactly, from the sidecar the installer wrote.
    ///
    /// A host without the tap loses nothing it had: `rate_limits` is simply
    /// absent from the wire, and every surface that reads it renders nothing
    /// (`web/src/lib/rate-limits.ts`).
    pub statusline_tap: bool,
    /// Portable agent-isolation policy for COMPANY sessions (companies §4.4).
    ///
    /// Parsed from `isolation_mode` in `config.toml` (`off` / `best-effort` /
    /// `strict-required`), default [`BestEffort`](crate::isolation::IsolationMode::BestEffort).
    /// The env override `SUPERMUX_ISOLATION_MODE` wins over the config file.
    /// Only company sessions (`company_id IS NOT NULL`) are ever confined; main/
    /// PA bots are never touched. `best-effort` fails open (a loud warning) when
    /// isolation is unavailable; `off` is the escape hatch.
    pub isolation_mode: crate::isolation::IsolationMode,
    /// P3a — the human identity plane (Google OIDC + cookie sessions).
    ///
    /// **Inert by default.** With no `google_client_id` and no `company_hosts`,
    /// the `/auth/*` routes refuse to start a flow and no human can exist, so the
    /// owner-bearer request path is byte-identical to before P3a. Secrets
    /// (`google_client_secret`, the cookie/CSRF keys) come from env or a
    /// mode-0600 file in `data_dir`, never `config.toml`-in-repo. See
    /// [`HumanAuthConfig`].
    pub human_auth: HumanAuthConfig,
}

/// P3a human-identity configuration. `Default` is fully inert (`enabled()` is
/// false), so every existing `Config { .. }` literal and the no-config boot path
/// stay behavior-neutral.
#[derive(Debug, Clone, Default)]
pub struct HumanAuthConfig {
    /// Google OAuth 2.0 Web-application client id (non-secret). `None` ⇒ the
    /// login surface is inert.
    pub google_client_id: Option<String>,
    /// Google OAuth client secret. Resolution: `SUPERMUX_GOOGLE_CLIENT_SECRET`
    /// env → `<data_dir>/google_client_secret` (mode 0600) → `config.toml`. Kept
    /// out of the repo config the same way `auth_token` is.
    pub google_client_secret: Option<String>,
    /// The owner's real email. When set, a single `UPDATE human_users` on boot
    /// rebinds the seeded `owner@localhost` sentinel to it (per the 0032 header).
    pub owner_email: Option<String>,
    /// Per-host allowlist: `host → company_id → redirect_uri`. The single source
    /// of truth for (a) which company a tunnel Host serves and (b) the exact
    /// Google redirect URI for that Host. A login on a Host not listed here is refused.
    pub company_hosts: Vec<CompanyHost>,
    /// Optional allowlist of **trusted owner transports** — extra Hosts (beyond
    /// loopback and `*.ts.net`, which are always trusted) that may receive the
    /// spliced admin bearer when human-auth is enabled. Default empty. Matched
    /// case-insensitively, port-stripped — the same style as
    /// [`host_entry`](Self::host_entry). See
    /// `static_assets::should_splice_admin_token` (fail-closed splice).
    pub owner_hosts: Vec<String>,
    /// HMAC key that signs the session cookie (integrity pre-check before any DB
    /// hit). Generated + persisted mode 0600 in `data_dir` when human-auth is
    /// enabled; empty ⇒ disabled.
    pub cookie_key: Vec<u8>,
    /// HMAC key for the double-submit CSRF token hash. Same persistence as
    /// `cookie_key`.
    pub csrf_key: Vec<u8>,
    /// HMAC key that signs the stateless magic-link **invite** token
    /// (`/auth/invite?token=…`, the zero-config quick-tunnel path). A 3rd 0600
    /// key generated alongside `cookie_key`/`csrf_key`; empty ⇒ the invite
    /// surface cannot mint or verify a token (fail-closed). NEVER logged.
    pub invite_key: Vec<u8>,
    /// Session lifetime in seconds (cookie + `human_sessions.expires_at`).
    /// Default 12h.
    pub session_ttl_secs: i64,
    /// The operator's chosen base domain for company hosts — a Cloudflare zone
    /// their own token controls (e.g. `example.com`). Companies are reached at
    /// `<slug>.<base_domain>`. `None` ⇒ external access is not configured and
    /// everything **fails closed**: no external host is ever derived, no
    /// `company_hosts` entry is written, and the WS Origin gate rejects
    /// cross-site origins. `Default` (via `#[derive(Default)]`) is `None`, so
    /// every existing inert literal stays inert. Set by the wizard's Domain step
    /// (or pinned in `config.toml`); non-secret.
    pub base_domain: Option<String>,
}

impl HumanAuthConfig {
    /// True once the login surface has enough config to run a real flow: a Google
    /// client id, a secret, at least one allowlisted host, and the signing keys.
    pub fn enabled(&self) -> bool {
        self.google_client_id.is_some()
            && self.google_client_secret.is_some()
            && !self.company_hosts.is_empty()
            && !self.cookie_key.is_empty()
            && !self.csrf_key.is_empty()
    }

    /// True when the human surface can run WITHOUT Google — a zero-config
    /// quick-tunnel / magic-link invite trial: at least one allowlisted host plus
    /// the cookie + CSRF signing keys. Deliberately does NOT require a Google
    /// client (that is [`enabled`](Self::enabled)); the `/auth/invite` route
    /// authorizes via a signed [`invite_key`](Self::invite_key) token instead.
    pub fn invite_enabled(&self) -> bool {
        !self.company_hosts.is_empty()
            && !self.cookie_key.is_empty()
            && !self.csrf_key.is_empty()
    }

    /// The human surface is live by EITHER path — Google OIDC ([`enabled`](Self::enabled))
    /// OR the magic-link invite ([`invite_enabled`](Self::invite_enabled)). This is
    /// the predicate the admin-token splice keys off: once ANY human surface is
    /// live the box leaves "pre-P3a, splice everywhere" mode and the bearer is
    /// restricted to trusted owner transports only (see
    /// `static_assets::should_splice_admin_token`).
    pub fn human_surface_active(&self) -> bool {
        self.enabled() || self.invite_enabled()
    }

    /// Effective session TTL (seconds), falling back to 12h when unset/nonpositive.
    pub fn ttl_secs(&self) -> i64 {
        if self.session_ttl_secs > 0 {
            self.session_ttl_secs
        } else {
            12 * 60 * 60
        }
    }

    /// Resolve the [`CompanyHost`] entry for an inbound `Host` header (exact,
    /// case-insensitive host match). `None` ⇒ the Host is not allowlisted.
    pub fn host_entry(&self, host: &str) -> Option<&CompanyHost> {
        let host = host.trim().to_ascii_lowercase();
        // Compare against the host portion only (strip any :port the header carries).
        let bare = host.split(':').next().unwrap_or(&host);
        self.company_hosts.iter().find(|c| {
            let ch = c.host.trim().to_ascii_lowercase();
            let ch_bare = ch.split(':').next().unwrap_or(&ch);
            ch == host || ch_bare == bare
        })
    }

    /// True when `host` (a raw `Host` header value) matches a configured
    /// [`owner_hosts`](Self::owner_hosts) entry — case-insensitive, port-stripped,
    /// the same matching style as [`host_entry`](Self::host_entry). Used by the
    /// fail-closed admin-token splice to recognise an explicitly trusted owner
    /// transport beyond the always-trusted loopback / `*.ts.net` set.
    pub fn is_owner_host(&self, host: &str) -> bool {
        let host = host.trim().to_ascii_lowercase();
        let bare = host.split(':').next().unwrap_or(&host);
        self.owner_hosts.iter().any(|h| {
            let h = h.trim().to_ascii_lowercase();
            let h_bare = h.split(':').next().unwrap_or(&h);
            h == host || h_bare == bare
        })
    }
}

/// Derive the canonical tunnel host for a company slug under a chosen
/// `base_domain`: `<slug>.<base_domain>`.
///
/// The base domain is the operator's own Cloudflare zone (e.g. `example.com`),
/// picked in the wizard and stored on the companion config — there is NO
/// hardcoded suffix. This is a total pure formatter: it takes the (already
/// resolved + validated) base, so the "is external access configured?" decision
/// lives entirely at the handler boundary ([`crate::external_access`]'s
/// `require_base_domain`), never here.
///
/// Both slug and base are lower-cased for host legibility (DNS is
/// case-insensitive; the `companies.slug` charset — letters/digits/`_`/`.`/`-` —
/// already excludes any character illegal in a host label except `_`, which the
/// operator avoids in a slug meant to be tunneled).
pub fn company_canonical_host(slug: &str, base_domain: &str) -> String {
    format!(
        "{}.{}",
        slug.trim().to_ascii_lowercase(),
        base_domain.trim().to_ascii_lowercase()
    )
}

/// The exact Google redirect URI for a company's canonical host under
/// `base_domain`: `https://<slug>.<base_domain>/auth/callback`.
pub fn company_redirect_uri(slug: &str, base_domain: &str) -> String {
    format!(
        "https://{}/auth/callback",
        company_canonical_host(slug, base_domain)
    )
}

/// One `host → company_id → redirect_uri` allowlist entry (`[[company_hosts]]`
/// in `config.toml`).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompanyHost {
    /// Public tunnel hostname a company's colleagues reach (canonical form
    /// `<slug>.<base_domain>`, P3d). Also feeds the WS Origin allowlist.
    pub host: String,
    /// The company this Host serves. A cookie minted for a different company is
    /// rejected on this Host.
    pub company_id: i64,
    /// The exact redirect URI registered with Google for this Host
    /// (`https://<host>/auth/callback`).
    pub redirect_uri: String,
    /// EPHEMERAL marker: `true` for a Cloudflare quick-tunnel host
    /// (`<random>.trycloudflare.com`) whose URL changes on every restart. Absent
    /// in an older store ⇒ `false` (a permanent domain host), so an existing
    /// store round-trips byte-identically (no migration). Never an owner transport.
    #[serde(default)]
    pub ephemeral: bool,
}

impl CompanyHost {
    /// Does this entry map the CANONICAL layout for `(slug, company_id)` under the
    /// configured `base_domain`? A valid P3d tunnel entry has
    /// `host == <slug>.<base_domain>`,
    /// `redirect_uri == https://<slug>.<base_domain>/auth/callback`, and
    /// `company_id == expected_company_id`. Host/redirect are compared
    /// case-insensitively (DNS + scheme are case-folding). A wrong `base_domain`
    /// therefore de-canonicalises the entry (correctly signalling a re-derive is
    /// needed). Used by the provisioner doc/test and the status handler.
    pub fn is_canonical_for(&self, slug: &str, expected_company_id: i64, base_domain: &str) -> bool {
        let want_host = company_canonical_host(slug, base_domain);
        let want_redirect = company_redirect_uri(slug, base_domain);
        self.company_id == expected_company_id
            && self.host.trim().eq_ignore_ascii_case(&want_host)
            && self.redirect_uri.trim().eq_ignore_ascii_case(&want_redirect)
    }
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
    /// See [`Config::statusline_tap`]. Absent key = OFF.
    #[serde(default)]
    statusline_tap: bool,
    /// See [`Config::isolation_mode`]. Absent key = the safe default
    /// (`best-effort`), resolved by [`crate::isolation::IsolationMode::parse`].
    #[serde(default)]
    isolation_mode: Option<String>,
    // ── P3a human identity plane (all optional; absent ⇒ inert) ──
    #[serde(default)]
    google_client_id: Option<String>,
    /// Secret preferred from env/file; a `config.toml` value is a last resort.
    #[serde(default)]
    google_client_secret: Option<String>,
    #[serde(default)]
    owner_email: Option<String>,
    #[serde(default)]
    company_hosts: Vec<CompanyHost>,
    #[serde(default)]
    owner_hosts: Vec<String>,
    #[serde(default)]
    human_session_ttl_secs: Option<i64>,
    /// See [`HumanAuthConfig::base_domain`]. Absent ⇒ `None` (external access
    /// unconfigured; the wizard sets it on the companion store instead).
    #[serde(default)]
    base_domain: Option<String>,
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

    // Assemble the P3a human-auth config before moving `data_dir` into `Config`.
    let human_auth = resolve_human_auth(
        &data_dir,
        raw.google_client_id,
        raw.google_client_secret,
        raw.owner_email,
        raw.company_hosts,
        raw.owner_hosts,
        raw.human_session_ttl_secs,
        raw.base_domain,
    )?;

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
        statusline_tap: raw.statusline_tap,
        // Env override (handy for ad-hoc deploys with no config file) wins over
        // config.toml; both resolve through the same lenient parser, so a typo
        // falls back to `best-effort` rather than silently disabling the sandbox.
        isolation_mode: crate::isolation::IsolationMode::parse(
            &std::env::var("SUPERMUX_ISOLATION_MODE")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .or(raw.isolation_mode)
                .unwrap_or_default(),
        ),
        human_auth,
    })
}

/// Assemble the P3a [`HumanAuthConfig`]. Secrets and signing keys follow the
/// same env→file precedence as `auth_token`; the signing keys are generated +
/// persisted mode 0600 in `data_dir` **only** when the login surface is actually
/// configured (a `google_client_id` is present), so an install that never
/// enables human-auth writes no new files and stays byte-identical.
fn resolve_human_auth(
    data_dir: &Path,
    google_client_id: Option<String>,
    google_client_secret_cfg: Option<String>,
    owner_email: Option<String>,
    company_hosts: Vec<CompanyHost>,
    owner_hosts: Vec<String>,
    ttl_secs: Option<i64>,
    base_domain: Option<String>,
) -> Result<HumanAuthConfig> {
    let google_client_id = google_client_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Trim + drop empties so a blank `base_domain = ""` in config.toml stays
    // "unset" (fail-closed) rather than deriving `<slug>.` hosts.
    let base_domain = base_domain
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());

    // Secret: env → <data_dir>/google_client_secret (0600) → config.toml.
    let google_client_secret = std::env::var("SUPERMUX_GOOGLE_CLIENT_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| read_secret_file(&data_dir.join("google_client_secret")))
        .or_else(|| {
            google_client_secret_cfg
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });

    let owner_email = owner_email
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Generate/persist the cookie + CSRF + invite signing keys only when the
    // surface is configured — a Google client id (OIDC path) OR at least one
    // allowlisted host (the quick-tunnel/invite path can have no Google). Else
    // leave them empty (inert), so an install that never enables human-auth
    // writes no new files and stays byte-identical.
    let (cookie_key, csrf_key, invite_key) =
        if google_client_id.is_some() || !company_hosts.is_empty() {
            ensure_signing_keys(data_dir)?
        } else {
            (Vec::new(), Vec::new(), Vec::new())
        };

    Ok(HumanAuthConfig {
        google_client_id,
        google_client_secret,
        owner_email,
        company_hosts,
        owner_hosts,
        cookie_key,
        csrf_key,
        invite_key,
        session_ttl_secs: ttl_secs.unwrap_or(0),
        base_domain,
    })
}

/// Read a trimmed non-empty secret from a 0600 file, or `None`.
pub(crate) fn read_secret_file(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The 0600 basename of the magic-link invite HMAC key.
pub const INVITE_KEY_FILE: &str = "human_invite_key";

/// Ensure the human-auth cookie + CSRF + invite signing keys exist under
/// `data_dir`, generating + persisting them mode 0600 on first use. Reused by the
/// onboarding wizard's hot-reload path when a box that had no `google_client_id`
/// at boot (so empty keys) gains one via `POST /api/external-access/google`, and
/// by the zero-config quick-tunnel provision path (which has no Google at all).
/// Returns `(cookie_key, csrf_key, invite_key)`.
pub(crate) fn ensure_signing_keys(data_dir: &Path) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    Ok((
        resolve_or_generate_key(&data_dir.join("human_cookie_key"))?,
        resolve_or_generate_key(&data_dir.join("human_csrf_key"))?,
        resolve_or_generate_key(&data_dir.join(INVITE_KEY_FILE))?,
    ))
}

/// Read a persisted 32-byte signing key from `path` (base64url), or generate one
/// and persist it mode 0600. Returns the raw key bytes.
fn resolve_or_generate_key(path: &Path) -> Result<Vec<u8>> {
    if path.exists() {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading {}", path.display()))?;
        let raw = raw.trim();
        if !raw.is_empty() {
            if let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw) {
                if bytes.len() >= 32 {
                    return Ok(bytes);
                }
            }
        }
    }
    let mut buf = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf);
    write_token_0600(path, &encoded)
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(buf.to_vec())
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
pub(crate) fn write_token_0600(path: &Path, token: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::fs::PermissionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        // `.mode()` only takes effect when the file is CREATED; on an existing file
        // `truncate(true)` reuses its (possibly loosened) perms. Re-tighten to 0600
        // explicitly so a pre-existing secret file is re-secured on every rewrite.
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_host_is_slug_dot_example_com() {
        assert_eq!(
            company_canonical_host("acme", "example.com"),
            "acme.example.com"
        );
        // Slug + base both lower-cased for host legibility.
        assert_eq!(
            company_canonical_host("Acme", "Example.com"),
            "acme.example.com"
        );
        assert_eq!(
            company_canonical_host("  beta  ", "example.com"),
            "beta.example.com"
        );
    }

    #[test]
    fn canonical_redirect_uri_is_https_callback() {
        assert_eq!(
            company_redirect_uri("acme", "example.com"),
            "https://acme.example.com/auth/callback"
        );
    }

    #[test]
    fn company_host_maps_slug_to_company_and_redirect() {
        // A correctly hand-edited `[[company_hosts]]` block for (slug=acme, id=7)
        // under the configured base domain `example.com`.
        let entry = CompanyHost {
            host: "acme.example.com".to_string(),
            company_id: 7,
            redirect_uri: "https://acme.example.com/auth/callback".to_string(),
            ephemeral: false,
        };
        assert!(entry.is_canonical_for("acme", 7, "example.com"));
        // Case-insensitive host/redirect match (DNS + scheme fold case).
        let mixed = CompanyHost {
            host: "ACME.example.com".to_string(),
            company_id: 7,
            redirect_uri: "https://ACME.example.com/auth/callback".to_string(),
            ephemeral: false,
        };
        assert!(mixed.is_canonical_for("acme", 7, "example.com"));

        // Wrong company id → not canonical (host↔company binding must be exact).
        assert!(!entry.is_canonical_for("acme", 8, "example.com"));
        // Wrong slug (host serves a different company's domain) → not canonical.
        assert!(!entry.is_canonical_for("beta", 7, "example.com"));
        // Wrong BASE domain → not canonical (a base change de-canonicalises the
        // entry, which is the correct re-derive signal). Fail-closed.
        assert!(!entry.is_canonical_for("acme", 7, "other.test"));
        // A stray redirect host → not canonical (open-redirect / mis-registration).
        let bad_redirect = CompanyHost {
            host: "acme.example.com".to_string(),
            company_id: 7,
            redirect_uri: "https://evil.example/auth/callback".to_string(),
            ephemeral: false,
        };
        assert!(!bad_redirect.is_canonical_for("acme", 7, "example.com"));
    }

    #[test]
    fn host_entry_resolves_canonical_company_host() {
        let cfg = HumanAuthConfig {
            google_client_id: Some("cid".to_string()),
            google_client_secret: Some("sec".to_string()),
            company_hosts: vec![CompanyHost {
                host: company_canonical_host("acme", "example.com"),
                company_id: 42,
                redirect_uri: company_redirect_uri("acme", "example.com"),
                ephemeral: false,
            }],
            cookie_key: vec![1; 32],
            csrf_key: vec![1; 32],
            base_domain: Some("example.com".to_string()),
            ..Default::default()
        };
        // The canonical host resolves to its company; a stray host does not.
        let e = cfg
            .host_entry("acme.example.com")
            .expect("canonical host resolves");
        assert_eq!(e.company_id, 42);
        assert!(cfg.host_entry("beta.example.com").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn write_token_0600_re_tightens_a_preexisting_loose_file() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{SystemTime, UNIX_EPOCH};

        // Unique path in the OS temp dir (no tempfile dep in this crate).
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "supermux_token_test_{}_{nanos}",
            std::process::id()
        ));
        // Pre-create the file with LOOSE 0644 perms (a world-readable secret).
        std::fs::write(&path, b"stale\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644,
            "precondition: file starts world-readable"
        );

        // Rewriting must re-tighten the existing file back to 0600.
        write_token_0600(&path, "fresh-secret").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "secret file must be re-secured to 0600");
        // Content was rewritten (truncated + new token + newline).
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "fresh-secret\n"
        );

        let _ = std::fs::remove_file(&path);
    }
}
