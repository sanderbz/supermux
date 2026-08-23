//! The wizard's non-secret companion config store: `<data_dir>/companies_config.toml`.
//!
//! The onboarding wizard NEVER edits the checked-in `config.toml`. Instead it
//! writes the non-secret bits it derives (`google_client_id`, the per-company
//! `[[company_hosts]]` entries, `owner_hosts`) into this companion file,
//! ATOMICALLY (temp + `fsync` + `rename`), and then asks
//! [`crate::state::AppState::reload_human_auth`] to hot-swap the in-memory
//! [`HumanAuthConfig`] so external access goes live WITHOUT a restart.
//!
//! Secrets never land here: the Google client secret lives 0600 at
//! `<data_dir>/google_client_secret` (the existing loader path) and the
//! Cloudflare / connector tokens at their own 0600 files.
//!
//! On boot [`boot_overlay`] merges any existing store over the file-based
//! baseline so a wizard-configured box comes back configured after a restart.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::{self, CompanyHost, HumanAuthConfig};

/// The companion file name under `data_dir`.
pub const STORE_FILE: &str = "companies_config.toml";

/// On-disk shape of the companion store. Every field optional/defaulted so a
/// partial file (or an absent one) is valid.
#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct CompaniesConfig {
    /// The single per-box Google OAuth Web-client id (non-secret).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub google_client_id: Option<String>,
    /// The operator's chosen base domain (a Cloudflare zone their token controls),
    /// e.g. `"example.com"`. Companies are reached at `<slug>.<base_domain>`.
    /// `None` ⇒ external access not configured (fail closed). Non-secret; the
    /// wizard's Domain step sets it. Absent key parses byte-identically to `None`
    /// (no migration), so an older store round-trips unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_domain: Option<String>,
    /// Per-company `host → company_id → redirect_uri` allowlist entries.
    #[serde(default)]
    pub company_hosts: Vec<CompanyHost>,
    /// Extra trusted owner-transport hosts.
    #[serde(default)]
    pub owner_hosts: Vec<String>,
    /// The active zero-config Cloudflare quick tunnel (ephemeral). `None` ⇒ no
    /// trial configured. There is at most ONE per box (a quick tunnel is a single
    /// hostname serving a single company); starting one for a different company
    /// replaces this. Absent key parses to `None` (no migration).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_tunnel: Option<QuickTunnel>,
    /// P2a — per-`(provider, company)` connector OAuth **apps** the box owns
    /// (`client_id` + requested `scopes`, both non-secret). The matching
    /// `client_secret` NEVER lands here — it lives 0600 in its own per-provider/
    /// company file (see `crate::connectors::oauth::client_secret_path`). Every
    /// field is defaulted, so an existing store (or one written by an older build)
    /// parses byte-identically with an empty list.
    #[serde(default)]
    pub oauth_apps: Vec<OauthApp>,
    /// Slice 3 — per-company Cloudflare **agent-inbox** records: the bot's own
    /// address on the connected domain (`agent@<base_domain>`) forwarding to a
    /// destination mailbox the owner reads. All fields non-secret (the CF token
    /// lives 0600 elsewhere). Defaulted, so an older store parses byte-identically
    /// with an empty list (no migration).
    #[serde(default)]
    pub agent_inboxes: Vec<AgentInbox>,
}

/// One company's Cloudflare agent-inbox: `agent@<domain>` forwarded to a
/// destination mailbox the bot reads (filtered via `MAIL_TO_FILTER`). NON-secret.
/// `verified` mirrors Cloudflare's destination-verification state (the owner must
/// click the link CF emails once) — refreshed each time the provision endpoint is
/// re-run. Keyed by `company_id` (one agent-inbox per company).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AgentInbox {
    pub company_id: i64,
    /// The bot's address, e.g. `agent@example.com`.
    pub address: String,
    /// The verified destination mailbox mail forwards to.
    pub destination: String,
    /// Whether Cloudflare has seen the owner verify the destination.
    #[serde(default)]
    pub verified: bool,
    /// The Cloudflare routing-rule tag, so a delete can remove exactly this rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_tag: Option<String>,
}

/// Replace-or-push an [`AgentInbox`] keyed by `company_id` (idempotent upsert).
pub fn upsert_agent_inbox(cfg: &mut CompaniesConfig, inbox: AgentInbox) {
    if let Some(existing) = cfg
        .agent_inboxes
        .iter_mut()
        .find(|a| a.company_id == inbox.company_id)
    {
        *existing = inbox;
    } else {
        cfg.agent_inboxes.push(inbox);
    }
}

/// Remove the [`AgentInbox`] for `company_id`. Returns whether one was removed.
pub fn remove_agent_inbox(cfg: &mut CompaniesConfig, company_id: i64) -> bool {
    let before = cfg.agent_inboxes.len();
    cfg.agent_inboxes.retain(|a| a.company_id != company_id);
    cfg.agent_inboxes.len() != before
}

/// The agent-inbox for `company_id`, if any (the read path's launch wiring +
/// status both go through this).
pub fn agent_inbox_for(cfg: &CompaniesConfig, company_id: i64) -> Option<&AgentInbox> {
    cfg.agent_inboxes.iter().find(|a| a.company_id == company_id)
}

/// A persisted record that a zero-config quick tunnel is configured for one
/// company. The URL is ephemeral (reclaimed by Cloudflare on restart), so this
/// only records the `(company_id, host)` binding + when it was created; the live
/// child handle lives in memory on [`super::ExternalAccess`]. The matching
/// `CompanyHost` entry (marked `ephemeral: true`) is what actually drives login /
/// WS-origin / cookie scoping.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct QuickTunnel {
    /// The single company this quick tunnel serves.
    pub company_id: i64,
    /// The public hostname (`<random>.trycloudflare.com`) — also the key of the
    /// ephemeral `CompanyHost` entry.
    pub host: String,
    /// Unix seconds when the trial was started.
    pub created_at: i64,
}

/// One registered connector-OAuth **app** (the box's own client for a provider).
/// NON-secret: the `client_secret` is stored separately 0600 and is never present
/// here or in any response. Keyed by `(provider, company_id)` — a `None`
/// `company_id` is the HQ/global app used when a company has no app of its own.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct OauthApp {
    /// `"github"` | `"google"` (validated to this set BEFORE any file path is
    /// built from it, so it can never traverse).
    pub provider: String,
    /// `None` = the HQ/global app; `Some(id)` = a per-company app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_id: Option<i64>,
    /// The OAuth client id (non-secret).
    pub client_id: String,
    /// Least-privilege scopes to request in the device grant.
    #[serde(default)]
    pub scopes: Vec<String>,
}

/// Replace-or-push an [`OauthApp`] keyed by `(provider, company_id)` — the
/// idempotent upsert behind `POST /api/oauth/apps`.
pub fn upsert_oauth_app(cfg: &mut CompaniesConfig, app: OauthApp) {
    if let Some(existing) = cfg
        .oauth_apps
        .iter_mut()
        .find(|a| a.provider == app.provider && a.company_id == app.company_id)
    {
        *existing = app;
    } else {
        cfg.oauth_apps.push(app);
    }
}

/// Remove the [`OauthApp`] for `(provider, company_id)`. Returns whether one was
/// removed.
pub fn remove_oauth_app(cfg: &mut CompaniesConfig, provider: &str, company_id: Option<i64>) -> bool {
    let before = cfg.oauth_apps.len();
    cfg.oauth_apps
        .retain(|a| !(a.provider == provider && a.company_id == company_id));
    cfg.oauth_apps.len() != before
}

/// The store path for a data dir.
pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(STORE_FILE)
}

/// Read the companion store, or `None` when it does not exist / is empty. A parse
/// error is surfaced (a corrupt store must not be silently ignored).
pub fn read(data_dir: &Path) -> Result<Option<CompaniesConfig>> {
    let p = path(data_dir);
    if !p.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&p).with_context(|| format!("reading {}", p.display()))?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    let cfg: CompaniesConfig =
        toml::from_str(&text).with_context(|| format!("parsing {}", p.display()))?;
    Ok(Some(cfg))
}

/// Read the store or a fresh default (never fails on absence).
pub fn read_or_default(data_dir: &Path) -> Result<CompaniesConfig> {
    Ok(read(data_dir)?.unwrap_or_default())
}

/// Atomically persist `cfg` to `<data_dir>/companies_config.toml` via a temp file
/// + `fsync` + `rename` (crash-safe, never a torn read). The temp file is created
/// mode 0600 like every other file the server writes under the data dir; the
/// store itself carries no secret but a conservative mode costs nothing.
pub fn write_atomic(data_dir: &Path, cfg: &CompaniesConfig) -> Result<()> {
    std::fs::create_dir_all(data_dir)
        .with_context(|| format!("creating data dir {}", data_dir.display()))?;
    let final_path = path(data_dir);
    let tmp_path = data_dir.join(format!("{STORE_FILE}.tmp-{}", std::process::id()));
    let body = toml::to_string_pretty(cfg).context("serializing companies_config.toml")?;

    {
        use std::io::Write;
        #[cfg(unix)]
        let mut f = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&tmp_path)
                .with_context(|| format!("creating {}", tmp_path.display()))?
        };
        #[cfg(not(unix))]
        let mut f = std::fs::File::create(&tmp_path)
            .with_context(|| format!("creating {}", tmp_path.display()))?;
        f.write_all(body.as_bytes())?;
        f.flush()?;
        f.sync_all()?; // fsync the bytes before the rename
    }

    std::fs::rename(&tmp_path, &final_path)
        .with_context(|| format!("renaming into {}", final_path.display()))?;
    Ok(())
}

/// Assemble a live [`HumanAuthConfig`] from a `baseline` (the file-based
/// `config.toml` config) merged with the companion `store`:
///   * `google_client_id` — store wins when present, else baseline.
///   * `google_client_secret` — re-resolved env → `<data_dir>/google_client_secret`
///     → baseline (secrets never live in the store).
///   * `company_hosts` — the UNION of baseline + store, de-duplicated by host
///     (store entry wins on a collision so a re-derived redirect can update it).
///   * `owner_hosts` — union of baseline + store.
///   * `owner_email`, `session_ttl_secs` — carried from baseline.
///   * `cookie_key` / `csrf_key` — reused from the baseline when already present;
///     otherwise generated + persisted 0600 (a box that gained a Google client
///     purely through the wizard had empty keys at boot).
pub fn assemble(
    data_dir: &Path,
    baseline: &HumanAuthConfig,
    store: &CompaniesConfig,
) -> Result<HumanAuthConfig> {
    let google_client_id = store
        .google_client_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| baseline.google_client_id.clone());

    // base_domain: store wins when present (the wizard's choice), else the
    // config.toml baseline. Trimmed + lower-cased so a blank never derives a
    // bogus `<slug>.` host; empty ⇒ None (fail-closed unset).
    let base_domain = store
        .base_domain
        .clone()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .or_else(|| baseline.base_domain.clone());

    let google_client_secret = std::env::var("SUPERMUX_GOOGLE_CLIENT_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| config::read_secret_file(&data_dir.join("google_client_secret")))
        .or_else(|| baseline.google_client_secret.clone());

    // Union company_hosts, store winning per host (case-insensitive host key).
    let mut hosts: Vec<CompanyHost> = baseline.company_hosts.clone();
    for sh in &store.company_hosts {
        let key = sh.host.trim().to_ascii_lowercase();
        if let Some(existing) = hosts
            .iter_mut()
            .find(|h| h.host.trim().to_ascii_lowercase() == key)
        {
            *existing = sh.clone();
        } else {
            hosts.push(sh.clone());
        }
    }

    let mut owner_hosts = baseline.owner_hosts.clone();
    for oh in &store.owner_hosts {
        if !owner_hosts.iter().any(|h| h.eq_ignore_ascii_case(oh)) {
            owner_hosts.push(oh.clone());
        }
    }

    // Signing keys (cookie + CSRF + invite): reuse the baseline's when all three
    // are present, else generate (a wizard that flips human-auth from inert →
    // configured must not leave empty keys, which would keep the surface dead).
    // The surface is "wanted" by EITHER path — a Google client id (OIDC) OR at
    // least one allowlisted host (the zero-config quick-tunnel/invite path, which
    // has no Google). `ensure_signing_keys` read-or-generates the 0600 files, so
    // it returns the keys the quick-tunnel provision endpoint already wrote.
    let surface_wants_keys = google_client_id.is_some() || !hosts.is_empty();
    let (cookie_key, csrf_key, invite_key) = if !baseline.cookie_key.is_empty()
        && !baseline.csrf_key.is_empty()
        && !baseline.invite_key.is_empty()
    {
        (
            baseline.cookie_key.clone(),
            baseline.csrf_key.clone(),
            baseline.invite_key.clone(),
        )
    } else if surface_wants_keys {
        config::ensure_signing_keys(data_dir)?
    } else {
        (
            baseline.cookie_key.clone(),
            baseline.csrf_key.clone(),
            baseline.invite_key.clone(),
        )
    };

    Ok(HumanAuthConfig {
        google_client_id,
        google_client_secret,
        owner_email: baseline.owner_email.clone(),
        company_hosts: hosts,
        owner_hosts,
        cookie_key,
        csrf_key,
        invite_key,
        session_ttl_secs: baseline.session_ttl_secs,
        base_domain,
    })
}

/// Merge any on-disk store over the boot `baseline` (a no-op when the file is
/// absent — the common case, so every existing install and unit test boots
/// byte-identically). A corrupt store falls back to the baseline with a warning
/// rather than failing the boot.
pub fn boot_overlay(data_dir: &Path, baseline: HumanAuthConfig) -> HumanAuthConfig {
    match read(data_dir) {
        Ok(Some(mut store)) => {
            // A quick tunnel is a supervised child that does NOT survive a restart,
            // and Cloudflare reclaims its `*.trycloudflare.com` hostname the moment
            // the child dies. So on boot any EPHEMERAL company_host + the
            // quick_tunnel record are stale — a dead entry that would keep an
            // unreachable host allowlisted. Drop them (and persist the cleanup so
            // the store never grows a graveyard of dead ephemeral hosts). The owner
            // re-creates a temporary link from the wizard when they want one.
            let had_ephemeral =
                store.quick_tunnel.is_some() || store.company_hosts.iter().any(|h| h.ephemeral);
            if had_ephemeral {
                store.company_hosts.retain(|h| !h.ephemeral);
                store.quick_tunnel = None;
                if let Err(e) = write_atomic(data_dir, &store) {
                    tracing::warn!(error = %e, "could not persist quick-tunnel boot cleanup");
                }
            }
            match assemble(data_dir, &baseline, &store) {
                Ok(cfg) => cfg,
                Err(e) => {
                    tracing::warn!(error = %e, "companies_config overlay failed; using file baseline");
                    baseline
                }
            }
        }
        Ok(None) => baseline,
        Err(e) => {
            tracing::warn!(error = %e, "reading companies_config failed; using file baseline");
            baseline
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{company_canonical_host, company_redirect_uri};

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("supermux-ea-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn write_then_read_roundtrips_atomically() {
        let d = tmp();
        let cfg = CompaniesConfig {
            google_client_id: Some("cid.apps.googleusercontent.com".into()),
            base_domain: Some("example.com".into()),
            company_hosts: vec![CompanyHost {
                host: company_canonical_host("acme", "example.com"),
                company_id: 7,
                redirect_uri: company_redirect_uri("acme", "example.com"),
                ephemeral: false,
            }],
            owner_hosts: vec![],
            oauth_apps: vec![],
            quick_tunnel: None,
            agent_inboxes: vec![],
        };
        write_atomic(&d, &cfg).unwrap();
        // No temp file left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "atomic rename left a temp file");
        let got = read(&d).unwrap().unwrap();
        assert_eq!(got.google_client_id.as_deref(), Some("cid.apps.googleusercontent.com"));
        assert_eq!(got.base_domain.as_deref(), Some("example.com"));
        assert_eq!(got.company_hosts.len(), 1);
        assert_eq!(got.company_hosts[0].company_id, 7);
        assert_eq!(got.company_hosts[0].host, "acme.example.com");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn oauth_apps_upsert_remove_and_roundtrip() {
        let d = tmp();
        let mut cfg = CompaniesConfig::default();
        // Upsert two apps for the same provider, different scope.
        upsert_oauth_app(
            &mut cfg,
            OauthApp {
                provider: "github".into(),
                company_id: None,
                client_id: "gh-global".into(),
                scopes: vec!["repo".into()],
            },
        );
        upsert_oauth_app(
            &mut cfg,
            OauthApp {
                provider: "github".into(),
                company_id: Some(7),
                client_id: "gh-c7".into(),
                scopes: vec!["repo".into(), "read:org".into()],
            },
        );
        assert_eq!(cfg.oauth_apps.len(), 2);
        // Upsert same (provider, company_id) REPLACES, does not duplicate.
        upsert_oauth_app(
            &mut cfg,
            OauthApp {
                provider: "github".into(),
                company_id: Some(7),
                client_id: "gh-c7-rotated".into(),
                scopes: vec!["repo".into()],
            },
        );
        assert_eq!(cfg.oauth_apps.len(), 2);
        assert_eq!(
            cfg.oauth_apps
                .iter()
                .find(|a| a.company_id == Some(7))
                .unwrap()
                .client_id,
            "gh-c7-rotated"
        );
        // Persist + re-read: the array round-trips through the companion TOML.
        write_atomic(&d, &cfg).unwrap();
        let got = read(&d).unwrap().unwrap();
        assert_eq!(got.oauth_apps.len(), 2);
        // Remove the global app; the company one survives.
        let mut got = got;
        assert!(remove_oauth_app(&mut got, "github", None));
        assert!(!remove_oauth_app(&mut got, "github", None)); // idempotent
        assert_eq!(got.oauth_apps.len(), 1);
        assert_eq!(got.oauth_apps[0].company_id, Some(7));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn config_without_oauth_apps_parses_to_empty() {
        // A store written by an OLDER build (no `oauth_apps` key) parses fine.
        let d = tmp();
        std::fs::write(
            path(&d),
            "google_client_id = \"cid.apps.googleusercontent.com\"\n",
        )
        .unwrap();
        let got = read(&d).unwrap().unwrap();
        assert!(got.oauth_apps.is_empty());
        assert_eq!(got.google_client_id.as_deref(), Some("cid.apps.googleusercontent.com"));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn boot_overlay_is_noop_without_a_store_file() {
        let d = tmp();
        let baseline = HumanAuthConfig::default();
        let merged = boot_overlay(&d, baseline.clone());
        assert_eq!(merged.google_client_id, baseline.google_client_id);
        assert!(merged.company_hosts.is_empty());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn assemble_generates_keys_when_client_id_appears() {
        let d = tmp();
        // Inert baseline (no keys), store brings a google_client_id.
        let baseline = HumanAuthConfig::default();
        let store = CompaniesConfig {
            google_client_id: Some("cid.apps.googleusercontent.com".into()),
            base_domain: Some("example.com".into()),
            company_hosts: vec![CompanyHost {
                host: company_canonical_host("acme", "example.com"),
                company_id: 7,
                redirect_uri: company_redirect_uri("acme", "example.com"),
                ephemeral: false,
            }],
            owner_hosts: vec![],
            oauth_apps: vec![],
            quick_tunnel: None,
            agent_inboxes: vec![],
        };
        std::env::set_var("SUPERMUX_GOOGLE_CLIENT_SECRET", "shh");
        let merged = assemble(&d, &baseline, &store).unwrap();
        std::env::remove_var("SUPERMUX_GOOGLE_CLIENT_SECRET");
        assert!(!merged.cookie_key.is_empty(), "keys generated");
        assert!(!merged.csrf_key.is_empty());
        assert_eq!(merged.google_client_id.as_deref(), Some("cid.apps.googleusercontent.com"));
        assert!(merged.enabled(), "surface is live after assemble");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn assemble_carries_base_domain_store_wins() {
        let d = tmp();
        // Baseline has no base domain; the store (wizard's choice) provides one.
        let baseline = HumanAuthConfig::default();
        let store = CompaniesConfig {
            base_domain: Some("example.com".into()),
            ..Default::default()
        };
        let merged = assemble(&d, &baseline, &store).unwrap();
        assert_eq!(merged.base_domain.as_deref(), Some("example.com"));

        // Store unset falls back to the baseline (config.toml pin).
        let baseline = HumanAuthConfig {
            base_domain: Some("baseline.test".into()),
            ..Default::default()
        };
        let store = CompaniesConfig::default();
        let merged = assemble(&d, &baseline, &store).unwrap();
        assert_eq!(merged.base_domain.as_deref(), Some("baseline.test"));

        // Store wins over the baseline when both are set.
        let store = CompaniesConfig {
            base_domain: Some("store.test".into()),
            ..Default::default()
        };
        let merged = assemble(&d, &baseline, &store).unwrap();
        assert_eq!(merged.base_domain.as_deref(), Some("store.test"));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn store_without_quick_tunnel_or_ephemeral_parses_back_compat() {
        // An OLDER store (no `quick_tunnel`, a `[[company_hosts]]` with no
        // `ephemeral` key) parses byte-identically: quick_tunnel None, ephemeral
        // false. The no-migration back-compat contract.
        let d = tmp();
        std::fs::write(
            path(&d),
            "google_client_id = \"cid.apps.googleusercontent.com\"\n\
             [[company_hosts]]\n\
             host = \"acme.example.com\"\n\
             company_id = 7\n\
             redirect_uri = \"https://acme.example.com/auth/callback\"\n",
        )
        .unwrap();
        let got = read(&d).unwrap().unwrap();
        assert!(got.quick_tunnel.is_none(), "absent quick_tunnel ⇒ None");
        assert_eq!(got.company_hosts.len(), 1);
        assert!(!got.company_hosts[0].ephemeral, "absent ephemeral ⇒ false");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn quick_tunnel_record_and_ephemeral_host_roundtrip() {
        let d = tmp();
        let mut cfg = CompaniesConfig::default();
        cfg.company_hosts.push(CompanyHost {
            host: "calm-frog.trycloudflare.com".into(),
            company_id: 3,
            redirect_uri: "https://calm-frog.trycloudflare.com/auth/callback".into(),
            ephemeral: true,
        });
        cfg.quick_tunnel = Some(QuickTunnel {
            company_id: 3,
            host: "calm-frog.trycloudflare.com".into(),
            created_at: 1234,
        });
        write_atomic(&d, &cfg).unwrap();
        let got = read(&d).unwrap().unwrap();
        assert_eq!(got.quick_tunnel.unwrap().company_id, 3);
        assert!(got.company_hosts[0].ephemeral);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn agent_inbox_upsert_remove_and_roundtrip() {
        let d = tmp();
        let mut cfg = CompaniesConfig::default();
        upsert_agent_inbox(
            &mut cfg,
            AgentInbox {
                company_id: 7,
                address: "agent@example.com".into(),
                destination: "owner@example.com".into(),
                verified: false,
                rule_tag: Some("rule-tag-abc".into()),
            },
        );
        assert_eq!(cfg.agent_inboxes.len(), 1);
        // Upsert same company REPLACES (e.g. re-provision flips verified true).
        upsert_agent_inbox(
            &mut cfg,
            AgentInbox {
                company_id: 7,
                address: "agent@example.com".into(),
                destination: "owner@example.com".into(),
                verified: true,
                rule_tag: Some("rule-tag-abc".into()),
            },
        );
        assert_eq!(cfg.agent_inboxes.len(), 1, "upsert replaces, never duplicates");
        assert!(agent_inbox_for(&cfg, 7).unwrap().verified);

        // Persist + re-read: the record round-trips through the companion TOML.
        write_atomic(&d, &cfg).unwrap();
        let got = read(&d).unwrap().unwrap();
        assert_eq!(got.agent_inboxes.len(), 1);
        let a = agent_inbox_for(&got, 7).unwrap();
        assert_eq!(a.address, "agent@example.com");
        assert_eq!(a.destination, "owner@example.com");
        assert_eq!(a.rule_tag.as_deref(), Some("rule-tag-abc"));

        // Remove is idempotent; a foreign company is untouched.
        let mut got = got;
        assert!(remove_agent_inbox(&mut got, 7));
        assert!(!remove_agent_inbox(&mut got, 7));
        assert!(got.agent_inboxes.is_empty());
        assert!(agent_inbox_for(&got, 7).is_none());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn config_without_agent_inboxes_parses_to_empty() {
        // A store written by an OLDER build (no `agent_inboxes` key) parses fine.
        let d = tmp();
        std::fs::write(
            path(&d),
            "google_client_id = \"cid.apps.googleusercontent.com\"\n",
        )
        .unwrap();
        let got = read(&d).unwrap().unwrap();
        assert!(got.agent_inboxes.is_empty(), "absent key ⇒ empty (no migration)");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn config_without_base_domain_parses_to_none() {
        // A store written by an OLDER build (no `base_domain` key) parses fine
        // with `None` — the no-migration back-compat contract.
        let d = tmp();
        std::fs::write(
            path(&d),
            "google_client_id = \"cid.apps.googleusercontent.com\"\n",
        )
        .unwrap();
        let got = read(&d).unwrap().unwrap();
        assert!(got.base_domain.is_none(), "absent key ⇒ None (fail-closed)");
        let _ = std::fs::remove_dir_all(d);
    }
}
