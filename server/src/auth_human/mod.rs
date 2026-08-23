//! P3a — the human identity plane.
//!
//! The first request identity that is NOT the owner bearer: a non-owner human
//! colleague authenticated via Google OIDC, carried by a Secure/HttpOnly cookie
//! backed by `human_sessions`, scoped (in later slices) to exactly one company.
//!
//! Modules:
//!   * [`oidc`]    — the mockable Google OIDC verifier + pure `id_token` checks.
//!   * [`flow`]    — the ephemeral `state`/PKCE/nonce store binding a callback to
//!                   its initiation.
//!   * [`router`]  — the PUBLIC `/auth/*` surface (login / callback / logout / me),
//!                   merged OUTSIDE the bearer layer.
//!   * [`middleware`] — the `AuthContext` resolver that supersedes the bearer-only
//!                   `auth_middleware`, plus CSRF enforcement on cookie-borne
//!                   state-changing requests.
//!
//! **Inert by default.** With no `google_client_id`/`company_hosts` configured
//! ([`crate::config::HumanAuthConfig::enabled`] is false), the `/auth/*` routes
//! refuse and the cookie path is never consulted, so the owner-bearer path is
//! byte-identical to before P3a.

pub mod flow;
pub mod invite;
pub mod middleware;
pub mod oidc;
pub mod router;

use std::sync::{Arc, Mutex};

use base64::Engine;
use constant_time_eq::constant_time_eq;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

pub use middleware::{auth_context_middleware, resolve_cookie_identity, AuthContext};
pub use oidc::OidcVerifier;

use crate::config::HumanAuthConfig;

/// The HttpOnly session cookie name.
pub const SESSION_COOKIE: &str = "supermux_hsess";
/// The readable (non-HttpOnly) CSRF companion cookie name (double-submit).
pub const CSRF_COOKIE: &str = "supermux_csrf";
/// The CSRF request header (compared to the readable cookie value server-side).
pub const CSRF_HEADER: &str = "x-supermux-csrf";

/// Per-process human-auth runtime state, held on `AppState` behind an `Arc`.
///
/// Holds the ephemeral flow store and the (swappable, for tests) OIDC verifier.
/// Keys/config live on `state.config.human_auth`.
pub struct HumanAuth {
    pub flows: flow::FlowStore,
    verifier: Mutex<Arc<dyn OidcVerifier>>,
}

impl HumanAuth {
    /// Build from config. Uses the real Google verifier; tests swap it via
    /// [`HumanAuth::set_verifier`].
    pub fn new(cfg: &HumanAuthConfig) -> Self {
        let verifier: Arc<dyn OidcVerifier> = Arc::new(oidc::GoogleOidcVerifier::new(
            cfg.google_client_id.clone(),
            cfg.google_client_secret.clone(),
        ));
        Self {
            flows: flow::FlowStore::new(),
            verifier: Mutex::new(verifier),
        }
    }

    pub fn verifier(&self) -> Arc<dyn OidcVerifier> {
        self.verifier.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Swap the OIDC verifier (test seam — inject a [`oidc::MockOidcVerifier`]).
    pub fn set_verifier(&self, v: Arc<dyn OidcVerifier>) {
        *self.verifier.lock().unwrap_or_else(|e| e.into_inner()) = v;
    }
}

type HmacSha256 = Hmac<Sha256>;

// ── token & hash primitives ───────────────────────────────────────────────────

/// SHA-256 hex of a string (the only form of the session token that touches the DB).
pub fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    hex(&digest)
}

/// HMAC-SHA256 hex of `msg` under `key`.
pub fn hmac_hex(key: &[u8], msg: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(msg.as_bytes());
    hex(&mac.finalize().into_bytes())
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Constant-time equality of two equal-length hex strings.
pub fn ct_eq(a: &str, b: &str) -> bool {
    constant_time_eq(a.as_bytes(), b.as_bytes())
}

/// Mint a fresh opaque 256-bit token (base64url) — the value stored ONLY as its
/// sha256 in the DB and set (HMAC-signed) in the cookie.
pub fn mint_opaque_token() -> String {
    use rand::RngCore;
    let mut raw = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
}

// ── cookie value = "<token>.<hmac(token)>" (integrity pre-check pre-DB) ────────

/// Wrap an opaque token into the signed cookie value.
pub fn sign_cookie(cookie_key: &[u8], token: &str) -> String {
    let sig = hmac_hex(cookie_key, token);
    format!("{token}.{sig}")
}

/// Verify a cookie value's HMAC and return the inner token (the value hashed for
/// the DB lookup). `None` ⇒ malformed or bad signature (rejected before any DB hit).
pub fn verify_cookie(cookie_key: &[u8], value: &str) -> Option<String> {
    let (token, sig) = value.rsplit_once('.')?;
    if token.is_empty() || sig.is_empty() {
        return None;
    }
    let expected = hmac_hex(cookie_key, token);
    if ct_eq(&expected, sig) {
        Some(token.to_string())
    } else {
        None
    }
}

// ── CSRF (double-submit) ───────────────────────────────────────────────────────

/// The stored CSRF hash for a freshly minted csrf token (HMAC under `csrf_key`).
pub fn csrf_hash(csrf_key: &[u8], csrf_token: &str) -> String {
    hmac_hex(csrf_key, csrf_token)
}

/// Constant-time verify a presented CSRF header value against the stored hash.
pub fn csrf_matches(csrf_key: &[u8], presented: &str, stored_hash: &str) -> bool {
    if presented.is_empty() || stored_hash.is_empty() {
        return false;
    }
    ct_eq(&csrf_hash(csrf_key, presented), stored_hash)
}

// ── cookie header parsing ──────────────────────────────────────────────────────

/// Read one named cookie's value from a raw `Cookie:` header string.
pub fn cookie_value<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    for part in cookie_header.split(';') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') {
            if k.trim() == name {
                return Some(v.trim());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_is_stable_and_64_chars() {
        let h = sha256_hex("abc");
        assert_eq!(h.len(), 64);
        // Known SHA-256("abc").
        assert_eq!(
            h,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn cookie_sign_roundtrips_and_rejects_tamper() {
        let key = b"0123456789abcdef0123456789abcdef";
        let token = mint_opaque_token();
        let cookie = sign_cookie(key, &token);
        assert_eq!(verify_cookie(key, &cookie).as_deref(), Some(token.as_str()));
        // Flip a signature byte → rejected.
        let mut bad = cookie.clone();
        let last = bad.pop().unwrap();
        bad.push(if last == 'a' { 'b' } else { 'a' });
        assert_eq!(verify_cookie(key, &bad), None);
        // Wrong key → rejected.
        assert_eq!(verify_cookie(b"different-key-different-keyxxxxxx", &cookie), None);
        // No dot → rejected.
        assert_eq!(verify_cookie(key, "no-signature-here"), None);
    }

    #[test]
    fn csrf_double_submit_constant_time() {
        let key = b"csrf-key-csrf-key-csrf-key-csrf!!";
        let token = mint_opaque_token();
        let stored = csrf_hash(key, &token);
        assert!(csrf_matches(key, &token, &stored));
        assert!(!csrf_matches(key, "wrong", &stored));
        assert!(!csrf_matches(key, "", &stored));
        assert!(!csrf_matches(key, &token, ""));
    }

    #[test]
    fn cookie_value_parses_multiple() {
        let hdr = "foo=bar; supermux_hsess=abc.def; other=1";
        assert_eq!(cookie_value(hdr, SESSION_COOKIE), Some("abc.def"));
        assert_eq!(cookie_value(hdr, "foo"), Some("bar"));
        assert_eq!(cookie_value(hdr, "missing"), None);
    }

    #[test]
    fn pkce_challenge_roundtrip() {
        // RFC 7636 appendix B known vector.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = oidc::pkce_challenge(verifier);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}
