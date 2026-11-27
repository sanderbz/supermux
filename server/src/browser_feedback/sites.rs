//! The "All websites" browser-control guards: the blocklist and its matching.
//!
//! An `all`-scope binding may drive the controlled tab to any http(s) website
//! EXCEPT the sites below and the Supermux server itself. The list is defined
//! once here and sent to the extension in the control `ready` frame; the
//! extension ships the same default only as a fallback for a missing list.
//! Matching is by host: the listed domain itself and every subdomain, on a
//! label boundary, case-insensitively, after IDN-to-punycode normalization.

use crate::error::AppError;

/// Hard lifetime of an `all`-scope binding, from the claim. Not extended by
/// use; after it the binding authorizes nothing and must be paired again.
pub const ALL_SITES_TTL_SECS: i64 = 24 * 60 * 60;

/// First list, owner can amend. Domains only (no scheme, port or path).
pub const BLOCKED_SITES: &[&str] = &[
    // Google account / payments
    "accounts.google.com",
    "myaccount.google.com",
    "passwords.google.com",
    "pay.google.com",
    "payments.google.com",
    "admin.google.com",
    "chromewebstore.google.com",
    // Apple / Microsoft account management (not idmsa.apple.com: App Store
    // Connect sign-in needs it)
    "appleid.apple.com",
    "account.apple.com",
    "login.live.com",
    "account.microsoft.com",
    "account.live.com",
    // Banks / payments
    "ing.nl",
    "abnamro.nl",
    "rabobank.nl",
    "snsbank.nl",
    "asnbank.nl",
    "regiobank.nl",
    "knab.nl",
    "triodos.nl",
    "bunq.com",
    "revolut.com",
    "wise.com",
    "paypal.com",
    "americanexpress.com",
    "icscards.nl",
    "adyen.com",
    "mollie.com",
    "stripe.com",
    // Brokers / crypto
    "degiro.nl",
    "degiro.com",
    "bitvavo.com",
    "coinbase.com",
    "binance.com",
    "kraken.com",
    // Government / identity
    "digid.nl",
    "mijn.belastingdienst.nl",
    "mijnoverheid.nl",
    // Password managers
    "1password.com",
    "bitwarden.com",
    "lastpass.com",
];

/// The Supermux server's own address(es). A named host is blocked on every
/// port; a loopback or IP host only on the server's own port, so local dev
/// servers on other ports stay usable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfHost {
    pub host: String,
    pub port: Option<u16>,
}
impl SelfHost {
    /// Wire form for the extension: `host` or `host:port`.
    pub fn wire(&self) -> String {
        match self.port {
            Some(port) if self.host.contains(':') => format!("[{}]:{port}", self.host),
            Some(port) => format!("{}:{port}", self.host),
            None => self.host.clone(),
        }
    }
}

fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_end_matches('.')
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}

/// True when `host` is `domain` or a subdomain of it (label boundary).
pub fn host_matches(host: &str, domain: &str) -> bool {
    let host = normalize_host(host);
    let domain = normalize_host(domain);
    !domain.is_empty()
        && (host == domain
            || host
                .strip_suffix(&domain)
                .is_some_and(|prefix| prefix.ends_with('.')))
}

pub fn host_blocked(host: &str) -> bool {
    BLOCKED_SITES.iter().any(|d| host_matches(host, d))
}

fn is_ip_or_loopback(host: &str) -> bool {
    let host = normalize_host(host);
    host == "localhost" || host.ends_with(".localhost") || host.parse::<std::net::IpAddr>().is_ok()
}

/// Parse a `Host` header / `host[:port]` into a [`SelfHost`].
pub fn self_host(raw: &str, default_port: Option<u16>) -> Option<SelfHost> {
    let url = url::Url::parse(&format!("http://{}", raw.trim())).ok()?;
    let host = normalize_host(url.host_str()?);
    if host.is_empty() {
        return None;
    }
    let port = if is_ip_or_loopback(&host) {
        Some(url.port().or(default_port)?)
    } else {
        None
    };
    Some(SelfHost { host, port })
}

/// Why a URL may not be controlled under an `all`-scope binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Not http(s), embedded credentials, or not parseable.
    Invalid,
    /// On the blocklist or the Supermux server itself.
    Blocked,
}

/// Checks one URL for an `all`-scope binding; returns its ASCII origin.
pub fn allowed_url(raw: &str, self_hosts: &[SelfHost]) -> Result<String, Refusal> {
    if raw.len() > 8192 || raw.chars().any(char::is_control) {
        return Err(Refusal::Invalid);
    }
    let url = url::Url::parse(raw).map_err(|_| Refusal::Invalid)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Refusal::Invalid);
    }
    // `url` already lowercases and punycodes the host (IDN-safe).
    let host = url.host_str().ok_or(Refusal::Invalid)?;
    let port = url.port_or_known_default();
    if host_blocked(host)
        || self_hosts
            .iter()
            .any(|s| normalize_host(host) == s.host && s.port.is_none_or(|p| Some(p) == port))
    {
        return Err(Refusal::Blocked);
    }
    Ok(url.origin().ascii_serialization())
}

pub fn refusal_error(refusal: Refusal) -> AppError {
    match refusal {
        Refusal::Invalid => AppError::BadRequest(
            "navigation requires an http or https URL without embedded credentials".into(),
        ),
        Refusal::Blocked => AppError::Forbidden(
            "blocked_site: this website is on the browser-control blocklist (accounts, payments, banks, government, password managers, or Supermux itself)".into(),
        ),
    }
}

/// The server's own hosts from configuration plus the request `Host` the
/// extension used to reach this server.
pub fn server_hosts(
    config: &crate::config::Config,
    auth: &crate::config::HumanAuthConfig,
    request_host: Option<&str>,
) -> Vec<SelfHost> {
    let mut hosts = Vec::new();
    let mut push = |h: Option<SelfHost>| {
        if let Some(h) = h {
            if !hosts.contains(&h) {
                hosts.push(h);
            }
        }
    };
    let mut binds = vec![config.bind];
    binds.extend(config.extra_binds.iter().copied());
    for bind in binds {
        let port = Some(bind.port());
        if bind.ip().is_unspecified() || bind.ip().is_loopback() {
            for loopback in ["localhost", "127.0.0.1", "[::1]"] {
                push(self_host(loopback, port));
            }
        }
        if !bind.ip().is_unspecified() {
            push(self_host(&bind.to_string(), port));
        }
    }
    for name in auth
        .owner_hosts
        .iter()
        .chain(config.extra_origins.iter())
        .chain(auth.company_hosts.iter().map(|c| &c.host))
    {
        push(self_host(name, None));
    }
    if let Some(host) = request_host {
        let default = if config.tls.cert_path.is_some() || config.tls.self_signed {
            443
        } else {
            80
        };
        push(self_host(host, Some(default)));
    }
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_listed_domains_and_subdomains_but_not_lookalikes() {
        for url in [
            "https://paypal.com/",
            "https://www.paypal.com/signin",
            "https://WWW.PayPal.COM./x",
            "https://accounts.google.com/",
            "http://a.b.mijn.belastingdienst.nl/",
            "https://ing.nl:8443/",
        ] {
            assert_eq!(allowed_url(url, &[]), Err(Refusal::Blocked), "{url}");
        }
        for url in [
            "https://notpaypal.com/",
            "https://paypal.com.evil.test/",
            "https://paypal.co/",
            "https://belastingdienst.nl/",
            "https://idmsa.apple.com/",
            "https://google.com/",
            "https://mail.google.com/",
            "https://example.com/",
        ] {
            assert!(allowed_url(url, &[]).is_ok(), "{url}");
        }
    }

    #[test]
    fn idn_is_compared_in_punycode_and_lookalike_unicode_is_not_the_bank() {
        // A Cyrillic "а" in paypal is a different (punycode) host: not blocked
        // as paypal.com, and the comparison never sees raw Unicode.
        let origin = allowed_url("https://pаypal.com/", &[]).unwrap();
        assert!(origin.starts_with("https://xn--"), "{origin}");
        // Full-width / uppercase forms normalize to the listed ASCII domain.
        assert_eq!(
            allowed_url("https://ＰＡＹＰＡＬ.com/", &[]),
            Err(Refusal::Blocked)
        );
    }

    #[test]
    fn only_http_https_without_userinfo() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "chrome://settings",
            "data:text/html,x",
            "https://user:pw@example.com/",
            "https://user@example.com/",
            "ftp://example.com/",
        ] {
            assert_eq!(allowed_url(url, &[]), Err(Refusal::Invalid), "{url}");
        }
    }

    #[test]
    fn the_supermux_server_itself_is_blocked() {
        let hosts = vec![
            self_host("mac.tail1234.ts.net", None).unwrap(),
            self_host("127.0.0.1:8823", None).unwrap(),
            self_host("localhost:8823", None).unwrap(),
        ];
        for url in [
            "https://mac.tail1234.ts.net/",
            "https://MAC.tail1234.ts.net:8443/chat",
            "http://127.0.0.1:8823/",
            "http://localhost:8823/api",
        ] {
            assert_eq!(allowed_url(url, &hosts), Err(Refusal::Blocked), "{url}");
        }
        // Local dev servers on other ports stay usable.
        assert!(allowed_url("http://localhost:3000/", &hosts).is_ok());
        assert!(allowed_url("http://other.tail1234.ts.net/", &hosts).is_ok());
    }

    #[test]
    fn self_host_wire_form_round_trips_ipv6() {
        let h = self_host("[::1]:8823", None).unwrap();
        assert_eq!(h.wire(), "[::1]:8823");
        assert_eq!(
            self_host("Mac.Example.COM:443", None).unwrap().wire(),
            "mac.example.com"
        );
    }
}
