//! Stateless HMAC-signed magic-link invite tokens (the zero-config quick-tunnel
//! path, design §3.3).
//!
//! Google OIDC needs a stable, pre-registered redirect_uri; a quick-tunnel host
//! is random and changes on every restart, so the quick-tunnel path authorizes a
//! trial with a **stateless signed token** instead — no DB row, no migration.
//!
//! ```text
//! token = base64url(user_id ":" company_id ":" exp) "." hmac_hex(invite_key, payload)
//! ```
//!
//! Revocation is covered by deleting the `human_users` row (the consuming route
//! re-checks the row + its company on every hit); expiry is embedded + signed.
//! The token is a **bearer credential** — anyone holding it is that user until it
//! expires or is revoked — acceptable for a time-boxed, single-company trial and
//! stated plainly in the wizard. It is NEVER logged (the `token` query key is
//! already scrubbed by [`crate::log_redact`]).

use base64::Engine;

use super::{ct_eq, hmac_hex};

/// The verified claims carried by an invite token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteClaims {
    pub user_id: i64,
    pub company_id: i64,
    /// Unix-seconds expiry.
    pub exp: i64,
}

/// Base64url-no-pad encode the canonical `user_id:company_id:exp` payload.
fn encode_payload(user_id: i64, company_id: i64, exp: i64) -> String {
    let plain = format!("{user_id}:{company_id}:{exp}");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(plain.as_bytes())
}

/// Mint a signed invite token binding `(user_id, company_id)` with expiry `exp`.
/// `invite_key` is the box's 0600 HMAC key. The token is a bearer secret.
pub fn mint_invite_token(invite_key: &[u8], user_id: i64, company_id: i64, exp: i64) -> String {
    let payload = encode_payload(user_id, company_id, exp);
    let sig = hmac_hex(invite_key, &payload);
    format!("{payload}.{sig}")
}

/// Verify a token's HMAC (constant-time) AND that it has not expired at `now`,
/// returning the claims. `None` (a UNIFORM failure — no oracle) for: an empty
/// key, a malformed shape, a bad/tampered signature, an undecodable/ill-formed
/// payload, or an expired token.
pub fn verify_invite_token(invite_key: &[u8], token: &str, now: i64) -> Option<InviteClaims> {
    // An empty key can never authorize (fail-closed): the invite surface is not
    // provisioned.
    if invite_key.is_empty() {
        return None;
    }
    let (payload, sig) = token.rsplit_once('.')?;
    if payload.is_empty() || sig.is_empty() {
        return None;
    }
    // Constant-time HMAC compare (equal-length hex; differing lengths safely
    // reject) BEFORE trusting any byte of the payload.
    let expected = hmac_hex(invite_key, payload);
    if !ct_eq(&expected, sig) {
        return None;
    }
    // Signature is valid ⇒ decode + parse the authenticated payload.
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let plain = String::from_utf8(raw).ok()?;
    let mut parts = plain.split(':');
    let user_id: i64 = parts.next()?.parse().ok()?;
    let company_id: i64 = parts.next()?.parse().ok()?;
    let exp: i64 = parts.next()?.parse().ok()?;
    // Reject trailing junk (a well-formed payload has exactly three fields).
    if parts.next().is_some() {
        return None;
    }
    if exp <= now {
        return None;
    }
    Some(InviteClaims {
        user_id,
        company_id,
        exp,
    })
}

/// The default invite lifetime: 7 days (a trial is ephemeral anyway, §3.3).
pub const DEFAULT_INVITE_TTL_SECS: i64 = 7 * 24 * 60 * 60;

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"invite-key-invite-key-invite-key";

    #[test]
    fn mint_then_verify_roundtrips() {
        let now = 1_000;
        let exp = now + 100;
        let tok = mint_invite_token(KEY, 7, 42, exp);
        let claims = verify_invite_token(KEY, &tok, now).expect("valid token verifies");
        assert_eq!(
            claims,
            InviteClaims {
                user_id: 7,
                company_id: 42,
                exp
            }
        );
    }

    #[test]
    fn expired_token_is_rejected() {
        let exp = 1_000;
        let tok = mint_invite_token(KEY, 7, 42, exp);
        // now == exp ⇒ expired (strict `<=`).
        assert!(verify_invite_token(KEY, &tok, exp).is_none());
        assert!(verify_invite_token(KEY, &tok, exp + 1).is_none());
        // Still valid one second before expiry.
        assert!(verify_invite_token(KEY, &tok, exp - 1).is_some());
    }

    #[test]
    fn tampered_signature_is_rejected() {
        let tok = mint_invite_token(KEY, 7, 42, 9_999);
        let (payload, sig) = tok.rsplit_once('.').unwrap();
        // Flip the last signature char.
        let last = sig.chars().last().unwrap();
        let flipped = if last == 'a' { 'b' } else { 'a' };
        let bad = format!("{payload}.{}{flipped}", &sig[..sig.len() - 1]);
        assert!(verify_invite_token(KEY, &bad, 0).is_none());
    }

    #[test]
    fn tampered_payload_is_rejected() {
        // A different payload with the original signature ⇒ HMAC mismatch. Forge
        // a payload that claims a different company; the signature no longer fits.
        let tok = mint_invite_token(KEY, 7, 42, 9_999);
        let (_payload, sig) = tok.rsplit_once('.').unwrap();
        let forged_payload = encode_payload(7, 999, 9_999);
        let forged = format!("{forged_payload}.{sig}");
        assert!(verify_invite_token(KEY, &forged, 0).is_none());
    }

    #[test]
    fn wrong_key_is_rejected() {
        let tok = mint_invite_token(KEY, 7, 42, 9_999);
        assert!(verify_invite_token(b"different-key-different-key-diff!", &tok, 0).is_none());
    }

    #[test]
    fn empty_key_never_authorizes() {
        // Even a structurally valid token cannot verify against an empty key.
        let tok = mint_invite_token(KEY, 7, 42, 9_999);
        assert!(verify_invite_token(b"", &tok, 0).is_none());
    }

    #[test]
    fn malformed_tokens_are_rejected() {
        assert!(verify_invite_token(KEY, "no-dot-here", 0).is_none());
        assert!(verify_invite_token(KEY, ".", 0).is_none());
        assert!(verify_invite_token(KEY, "payload.", 0).is_none());
        assert!(verify_invite_token(KEY, ".sig", 0).is_none());
        // Valid signature over a non-":"-structured payload ⇒ parse fails.
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b"not-structured");
        let sig = hmac_hex(KEY, &payload);
        assert!(verify_invite_token(KEY, &format!("{payload}.{sig}"), 0).is_none());
    }
}
