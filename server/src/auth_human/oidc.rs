//! Google OpenID Connect: the token exchange + `id_token` verification, behind a
//! small [`OidcVerifier`] trait so the whole login flow is unit/integration
//! testable WITHOUT live Google.
//!
//! Security (design §3, rows 12–14):
//!   * PKCE S256 — the `code_verifier` is server-held; only the `code_challenge`
//!     ever leaves us, and the token exchange is server-side only.
//!   * `id_token` signature is verified against Google's JWKS, and `iss`, `aud`
//!     (== our client_id), `exp`, and a single-use `nonce` are all checked.
//!   * The verification core [`verify_id_token`] is a PURE function taking the
//!     JWKS as input (no network), so a generated keypair can drive the
//!     wrong-`aud`/`iss`/`nonce`/expired reject tests deterministically.

use async_trait::async_trait;
use base64::Engine;
use jwt_simple::prelude::*;
use serde::Deserialize;

/// Google's token + JWKS endpoints (overridable in tests via the real verifier's
/// constructor is unnecessary — tests use the mock).
pub const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const GOOGLE_JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
/// Both issuer spellings Google emits are accepted.
pub const GOOGLE_ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];
/// Small leeway for clock skew on `exp`/`nbf` in production verification.
const CLOCK_TOLERANCE_SECS: u64 = 120;

/// A verified human identity extracted from a validated `id_token`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedIdentity {
    /// Lowercased, verified email address.
    pub email: String,
    /// Google's stable subject id.
    pub sub: String,
}

/// Inputs to the code→identity exchange.
pub struct ExchangeParams<'a> {
    pub code: &'a str,
    pub pkce_verifier: &'a str,
    pub redirect_uri: &'a str,
    pub expected_nonce: &'a str,
}

#[derive(Debug, thiserror::Error)]
pub enum OidcError {
    #[error("oidc not configured")]
    NotConfigured,
    #[error("token exchange failed: {0}")]
    Exchange(String),
    #[error("jwks fetch failed: {0}")]
    Jwks(String),
    #[error("no id_token in token response")]
    NoIdToken,
    #[error("id_token header has no kid")]
    NoKid,
    #[error("no jwks key matches kid {0}")]
    UnknownKid(String),
    #[error("malformed jwk: {0}")]
    MalformedJwk(String),
    #[error("id_token verification failed: {0}")]
    Verify(String),
    #[error("email missing or unverified in id_token")]
    EmailUnverified,
}

/// One JSON Web Key (RSA) from Google's JWKS.
#[derive(Debug, Clone, Deserialize)]
pub struct Jwk {
    pub kid: String,
    /// base64url modulus.
    pub n: String,
    /// base64url exponent.
    pub e: String,
    #[serde(default)]
    pub alg: Option<String>,
}

/// Google's JWKS document (`{"keys":[...]}`).
#[derive(Debug, Clone, Deserialize)]
pub struct Jwks {
    pub keys: Vec<Jwk>,
}

impl Jwks {
    fn find(&self, kid: &str) -> Option<&Jwk> {
        self.keys.iter().find(|k| k.kid == kid)
    }
}

/// The subset of `id_token` custom claims we read.
#[derive(Debug, Clone, Deserialize)]
struct GoogleClaims {
    #[serde(default)]
    email: Option<String>,
    /// Google emits this as a bool OR the string "true".
    #[serde(default)]
    email_verified: Option<serde_json::Value>,
}

fn value_is_true(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::String(s) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// **Pure** id_token verification: signature (against `jwks`), `iss` ∈
/// `allowed_issuers`, `aud` == `audience`, `exp` (with a small tolerance unless
/// `artificial_now` overrides the clock), and a single-use `nonce`. On success
/// returns the verified, lowercased email + subject.
///
/// `artificial_now` (unix secs) is a test seam: it pins the verification clock so
/// the expired-token case is deterministic. Production passes `None`.
pub fn verify_id_token(
    token: &str,
    jwks: &Jwks,
    allowed_issuers: &[&str],
    audience: &str,
    expected_nonce: &str,
    artificial_now: Option<u64>,
) -> Result<VerifiedIdentity, OidcError> {
    // 1. Peek the header → kid, select the matching JWKS key.
    let meta = Token::decode_metadata(token).map_err(|e| OidcError::Verify(e.to_string()))?;
    let kid = meta.key_id().ok_or(OidcError::NoKid)?.to_string();
    let jwk = jwks.find(&kid).ok_or_else(|| OidcError::UnknownKid(kid.clone()))?;

    // 2. Rebuild the RSA public key from the JWKS n/e components.
    let n = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(jwk.n.trim())
        .map_err(|e| OidcError::MalformedJwk(format!("n: {e}")))?;
    let e = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(jwk.e.trim())
        .map_err(|e| OidcError::MalformedJwk(format!("e: {e}")))?;
    let key = RS256PublicKey::from_components(&n, &e)
        .map_err(|e| OidcError::MalformedJwk(e.to_string()))?;

    // 3. Verify signature + registered claims in one shot.
    let issuers: std::collections::HashSet<String> =
        allowed_issuers.iter().map(|s| s.to_string()).collect();
    let mut audiences = std::collections::HashSet::new();
    audiences.insert(audience.to_string());

    let options = VerificationOptions {
        allowed_issuers: Some(issuers),
        allowed_audiences: Some(audiences),
        required_nonce: Some(expected_nonce.to_string()),
        time_tolerance: Some(Duration::from_secs(CLOCK_TOLERANCE_SECS)),
        artificial_time: artificial_now.map(Duration::from_secs),
        ..Default::default()
    };

    let claims = key
        .verify_token::<GoogleClaims>(token, Some(options))
        .map_err(|e| OidcError::Verify(e.to_string()))?;

    // 4. Require a verified email.
    let email = claims.custom.email.unwrap_or_default();
    let verified = claims
        .custom
        .email_verified
        .as_ref()
        .map(value_is_true)
        .unwrap_or(false);
    if email.is_empty() || !verified {
        return Err(OidcError::EmailUnverified);
    }
    let sub = claims.subject.unwrap_or_default();
    Ok(VerifiedIdentity {
        email: email.trim().to_ascii_lowercase(),
        sub,
    })
}

/// The mockable seam: exchange an auth code + PKCE verifier for a verified
/// identity. The real impl talks to Google; the test double is deterministic.
#[async_trait]
pub trait OidcVerifier: Send + Sync {
    async fn exchange_and_verify(
        &self,
        params: ExchangeParams<'_>,
    ) -> Result<VerifiedIdentity, OidcError>;
}

/// Real Google verifier: server-side token exchange (reqwest) + JWKS fetch +
/// [`verify_id_token`].
pub struct GoogleOidcVerifier {
    client_id: Option<String>,
    client_secret: Option<String>,
    http: reqwest::Client,
}

impl GoogleOidcVerifier {
    pub fn new(client_id: Option<String>, client_secret: Option<String>) -> Self {
        Self {
            client_id,
            client_secret,
            http: reqwest::Client::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    id_token: Option<String>,
}

#[async_trait]
impl OidcVerifier for GoogleOidcVerifier {
    async fn exchange_and_verify(
        &self,
        params: ExchangeParams<'_>,
    ) -> Result<VerifiedIdentity, OidcError> {
        let (client_id, client_secret) = match (&self.client_id, &self.client_secret) {
            (Some(id), Some(secret)) => (id, secret),
            _ => return Err(OidcError::NotConfigured),
        };

        // 1. Server-side code exchange (PKCE verifier, never the browser).
        let form = [
            ("grant_type", "authorization_code"),
            ("code", params.code),
            ("code_verifier", params.pkce_verifier),
            ("redirect_uri", params.redirect_uri),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
        ];
        let resp = self
            .http
            .post(GOOGLE_TOKEN_URL)
            .form(&form)
            .send()
            .await
            .map_err(|e| OidcError::Exchange(e.to_string()))?;
        if !resp.status().is_success() {
            let code = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(OidcError::Exchange(format!("{code}: {body}")));
        }
        let tokens: TokenResponse = resp
            .json()
            .await
            .map_err(|e| OidcError::Exchange(e.to_string()))?;
        let id_token = tokens.id_token.ok_or(OidcError::NoIdToken)?;

        // 2. Fetch Google's JWKS.
        let jwks: Jwks = self
            .http
            .get(GOOGLE_JWKS_URL)
            .send()
            .await
            .map_err(|e| OidcError::Jwks(e.to_string()))?
            .json()
            .await
            .map_err(|e| OidcError::Jwks(e.to_string()))?;

        // 3. Verify (production clock).
        verify_id_token(
            &id_token,
            &jwks,
            &GOOGLE_ISSUERS,
            client_id,
            params.expected_nonce,
            None,
        )
    }
}

// ── PKCE (S256) ───────────────────────────────────────────────────────────────

/// Generate a PKCE `code_verifier` (43–128 chars, high entropy) and its S256
/// `code_challenge = base64url(sha256(verifier))`.
pub fn generate_pkce() -> (String, String) {
    use rand::RngCore;
    let mut raw = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    let challenge = pkce_challenge(&verifier);
    (verifier, challenge)
}

/// Derive the S256 challenge for a given verifier (pure — testable round-trip).
pub fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

// ── Test double ───────────────────────────────────────────────────────────────

/// Deterministic verifier for tests: a fixed table of `code → identity`, and it
/// asserts the PKCE verifier + nonce the flow passes match what was registered,
/// so the state/nonce/PKCE round-trip is exercised without live Google.
#[derive(Default)]
pub struct MockOidcVerifier {
    /// code → (identity, expected_verifier, expected_nonce)
    pub table: std::sync::Mutex<
        std::collections::HashMap<String, (VerifiedIdentity, Option<String>, Option<String>)>,
    >,
}

impl MockOidcVerifier {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a code that resolves to `email`, optionally binding the exact
    /// PKCE verifier and nonce the callback must present.
    pub fn insert(
        &self,
        code: &str,
        email: &str,
        expected_verifier: Option<&str>,
        expected_nonce: Option<&str>,
    ) {
        self.table.lock().unwrap().insert(
            code.to_string(),
            (
                VerifiedIdentity {
                    email: email.to_ascii_lowercase(),
                    sub: format!("sub-{email}"),
                },
                expected_verifier.map(|s| s.to_string()),
                expected_nonce.map(|s| s.to_string()),
            ),
        );
    }
}

#[async_trait]
impl OidcVerifier for MockOidcVerifier {
    async fn exchange_and_verify(
        &self,
        params: ExchangeParams<'_>,
    ) -> Result<VerifiedIdentity, OidcError> {
        let table = self.table.lock().unwrap();
        let (identity, exp_verifier, exp_nonce) = table
            .get(params.code)
            .ok_or_else(|| OidcError::Exchange("unknown code".into()))?;
        if let Some(v) = exp_verifier {
            if v != params.pkce_verifier {
                return Err(OidcError::Exchange("pkce verifier mismatch".into()));
            }
        }
        if let Some(n) = exp_nonce {
            if n != params.expected_nonce {
                return Err(OidcError::Verify("nonce mismatch".into()));
            }
        }
        Ok(identity.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jwt_simple::prelude::*;
    use serde::Serialize;
    use std::time::{SystemTime, UNIX_EPOCH};

    const KID: &str = "test-kid-1";
    const CLIENT: &str = "client-123.apps.googleusercontent.com";
    const NONCE: &str = "nonce-abcdef";

    fn b64u(bytes: &[u8]) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    }

    fn now_secs() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
    }

    /// A keypair + a JWKS document exposing its public key under `KID`.
    fn keypair_and_jwks() -> (RS256KeyPair, Jwks) {
        let kp = RS256KeyPair::generate(2048).unwrap().with_key_id(KID);
        let comps = kp.public_key().to_components();
        let jwks = Jwks {
            keys: vec![Jwk {
                kid: KID.to_string(),
                n: b64u(&comps.n),
                e: b64u(&comps.e),
                alg: Some("RS256".to_string()),
            }],
        };
        (kp, jwks)
    }

    #[derive(Serialize)]
    struct EmailClaims {
        email: String,
        email_verified: bool,
    }

    fn sign(
        kp: &RS256KeyPair,
        email: &str,
        email_verified: bool,
        iss: &str,
        aud: &str,
        nonce: &str,
        valid_secs: u64,
    ) -> String {
        let claims = Claims::with_custom_claims(
            EmailClaims {
                email: email.to_string(),
                email_verified,
            },
            Duration::from_secs(valid_secs),
        )
        .with_issuer(iss)
        .with_audience(aud)
        .with_nonce(nonce);
        kp.sign(claims).unwrap()
    }

    #[test]
    fn valid_id_token_is_accepted() {
        let (kp, jwks) = keypair_and_jwks();
        let token = sign(&kp, "Alice@Acme.test", true, GOOGLE_ISSUERS[0], CLIENT, NONCE, 3600);
        let id = verify_id_token(&token, &jwks, &GOOGLE_ISSUERS, CLIENT, NONCE, None).unwrap();
        assert_eq!(id.email, "alice@acme.test"); // lowercased
    }

    #[test]
    fn wrong_audience_is_rejected() {
        let (kp, jwks) = keypair_and_jwks();
        let token = sign(&kp, "a@acme.test", true, GOOGLE_ISSUERS[0], "some-other-client", NONCE, 3600);
        let err = verify_id_token(&token, &jwks, &GOOGLE_ISSUERS, CLIENT, NONCE, None);
        assert!(matches!(err, Err(OidcError::Verify(_))), "wrong aud must reject: {err:?}");
    }

    #[test]
    fn wrong_issuer_is_rejected() {
        let (kp, jwks) = keypair_and_jwks();
        let token = sign(&kp, "a@acme.test", true, "https://evil.example", CLIENT, NONCE, 3600);
        let err = verify_id_token(&token, &jwks, &GOOGLE_ISSUERS, CLIENT, NONCE, None);
        assert!(matches!(err, Err(OidcError::Verify(_))), "wrong iss must reject: {err:?}");
    }

    #[test]
    fn wrong_nonce_is_rejected() {
        let (kp, jwks) = keypair_and_jwks();
        let token = sign(&kp, "a@acme.test", true, GOOGLE_ISSUERS[0], CLIENT, "attacker-nonce", 3600);
        let err = verify_id_token(&token, &jwks, &GOOGLE_ISSUERS, CLIENT, NONCE, None);
        assert!(matches!(err, Err(OidcError::Verify(_))), "wrong nonce must reject: {err:?}");
    }

    #[test]
    fn expired_id_token_is_rejected() {
        let (kp, jwks) = keypair_and_jwks();
        // Valid for 10s from real-now; verify with the clock pinned 1h ahead.
        let token = sign(&kp, "a@acme.test", true, GOOGLE_ISSUERS[0], CLIENT, NONCE, 10);
        let future = now_secs() + 3600;
        let err = verify_id_token(&token, &jwks, &GOOGLE_ISSUERS, CLIENT, NONCE, Some(future));
        assert!(matches!(err, Err(OidcError::Verify(_))), "expired must reject: {err:?}");
    }

    #[test]
    fn bad_signature_is_rejected() {
        // Sign with kp1, but publish kp2's key under the same kid → sig mismatch.
        let kp1 = RS256KeyPair::generate(2048).unwrap().with_key_id(KID);
        let kp2 = RS256KeyPair::generate(2048).unwrap().with_key_id(KID);
        let comps = kp2.public_key().to_components();
        let jwks = Jwks {
            keys: vec![Jwk {
                kid: KID.to_string(),
                n: b64u(&comps.n),
                e: b64u(&comps.e),
                alg: Some("RS256".to_string()),
            }],
        };
        let token = sign(&kp1, "a@acme.test", true, GOOGLE_ISSUERS[0], CLIENT, NONCE, 3600);
        let err = verify_id_token(&token, &jwks, &GOOGLE_ISSUERS, CLIENT, NONCE, None);
        assert!(matches!(err, Err(OidcError::Verify(_))), "bad sig must reject: {err:?}");
    }

    #[test]
    fn unknown_kid_is_rejected() {
        let (kp, mut jwks) = keypair_and_jwks();
        jwks.keys[0].kid = "some-other-kid".to_string();
        let token = sign(&kp, "a@acme.test", true, GOOGLE_ISSUERS[0], CLIENT, NONCE, 3600);
        let err = verify_id_token(&token, &jwks, &GOOGLE_ISSUERS, CLIENT, NONCE, None);
        assert!(matches!(err, Err(OidcError::UnknownKid(_))), "unknown kid must reject: {err:?}");
    }

    #[test]
    fn unverified_email_is_rejected() {
        let (kp, jwks) = keypair_and_jwks();
        let token = sign(&kp, "a@acme.test", false, GOOGLE_ISSUERS[0], CLIENT, NONCE, 3600);
        let err = verify_id_token(&token, &jwks, &GOOGLE_ISSUERS, CLIENT, NONCE, None);
        assert!(matches!(err, Err(OidcError::EmailUnverified)), "unverified email must reject: {err:?}");
    }

    #[test]
    fn email_verified_as_string_true_is_accepted() {
        // Google sometimes emits email_verified as the string "true".
        #[derive(Serialize)]
        struct StrClaims {
            email: String,
            email_verified: String,
        }
        let (kp, jwks) = keypair_and_jwks();
        let claims = Claims::with_custom_claims(
            StrClaims {
                email: "a@acme.test".to_string(),
                email_verified: "true".to_string(),
            },
            Duration::from_secs(3600),
        )
        .with_issuer(GOOGLE_ISSUERS[0])
        .with_audience(CLIENT)
        .with_nonce(NONCE);
        let token = kp.sign(claims).unwrap();
        let id = verify_id_token(&token, &jwks, &GOOGLE_ISSUERS, CLIENT, NONCE, None).unwrap();
        assert_eq!(id.email, "a@acme.test");
    }

    #[test]
    fn pkce_generate_roundtrips() {
        let (verifier, challenge) = generate_pkce();
        assert_eq!(pkce_challenge(&verifier), challenge);
        assert_ne!(verifier, challenge);
        assert!(verifier.len() >= 43);
    }

    #[tokio::test]
    async fn mock_verifier_enforces_pkce_and_nonce() {
        let mock = MockOidcVerifier::new();
        mock.insert("code-1", "bob@acme.test", Some("the-verifier"), Some("the-nonce"));
        // Correct verifier + nonce → identity.
        let ok = mock
            .exchange_and_verify(ExchangeParams {
                code: "code-1",
                pkce_verifier: "the-verifier",
                redirect_uri: "https://acme.test/auth/callback",
                expected_nonce: "the-nonce",
            })
            .await
            .unwrap();
        assert_eq!(ok.email, "bob@acme.test");
        // Wrong verifier → reject.
        let bad = mock
            .exchange_and_verify(ExchangeParams {
                code: "code-1",
                pkce_verifier: "WRONG",
                redirect_uri: "https://acme.test/auth/callback",
                expected_nonce: "the-nonce",
            })
            .await;
        assert!(bad.is_err());
    }
}
