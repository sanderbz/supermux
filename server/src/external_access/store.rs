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
    /// Per-company `host → company_id → redirect_uri` allowlist entries.
    #[serde(default)]
    pub company_hosts: Vec<CompanyHost>,
    /// Extra trusted owner-transport hosts.
    #[serde(default)]
    pub owner_hosts: Vec<String>,
    /// P2a — per-`(provider, company)` connector OAuth **apps** the box owns
    /// (`client_id` + requested `scopes`, both non-secret). The matching
    /// `client_secret` NEVER lands here — it lives 0600 in its own per-provider/
    /// company file (see `crate::connectors::oauth::client_secret_path`). Every
    /// field is defaulted, so an existing store (or one written by an older build)
    /// parses byte-identically with an empty list.
    #[serde(default)]
    pub oauth_apps: Vec<OauthApp>,
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

    // Signing keys: reuse the baseline's when present, else generate (a wizard
    // that flips human-auth from inert → configured must not leave empty keys,
    // which would keep `enabled()` false and the login surface dead).
    let (cookie_key, csrf_key) = if !baseline.cookie_key.is_empty()
        && !baseline.csrf_key.is_empty()
    {
        (baseline.cookie_key.clone(), baseline.csrf_key.clone())
    } else if google_client_id.is_some() {
        config::ensure_signing_keys(data_dir)?
    } else {
        (baseline.cookie_key.clone(), baseline.csrf_key.clone())
    };

    Ok(HumanAuthConfig {
        google_client_id,
        google_client_secret,
        owner_email: baseline.owner_email.clone(),
        company_hosts: hosts,
        owner_hosts,
        cookie_key,
        csrf_key,
        session_ttl_secs: baseline.session_ttl_secs,
    })
}

/// Merge any on-disk store over the boot `baseline` (a no-op when the file is
/// absent — the common case, so every existing install and unit test boots
/// byte-identically). A corrupt store falls back to the baseline with a warning
/// rather than failing the boot.
pub fn boot_overlay(data_dir: &Path, baseline: HumanAuthConfig) -> HumanAuthConfig {
    match read(data_dir) {
        Ok(Some(store)) => match assemble(data_dir, &baseline, &store) {
            Ok(cfg) => cfg,
            Err(e) => {
                tracing::warn!(error = %e, "companies_config overlay failed; using file baseline");
                baseline
            }
        },
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
            company_hosts: vec![CompanyHost {
                host: company_canonical_host("acme"),
                company_id: 7,
                redirect_uri: company_redirect_uri("acme"),
            }],
            owner_hosts: vec![],
            oauth_apps: vec![],
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
        assert_eq!(got.company_hosts.len(), 1);
        assert_eq!(got.company_hosts[0].company_id, 7);
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
            company_hosts: vec![CompanyHost {
                host: company_canonical_host("acme"),
                company_id: 7,
                redirect_uri: company_redirect_uri("acme"),
            }],
            owner_hosts: vec![],
            oauth_apps: vec![],
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
}
