//! Credential vault — AES-256-GCM sealing of a connector's secret field-map.
//!
//! **Posture (spec §6).** Secrets are WRITE-ONLY across the API: they arrive raw
//! on the way IN (POST a credential), are sealed here into `vault.fields_enc`,
//! and only ever come back out DECRYPTED at launch to be injected as an env var
//! into the granted session's `claude` child — never written into
//! `~/.claude.json` on disk, never logged, never surfaced to the agent
//! transcript. Any read path masks them with [`crate::claude_tools::MASKED`], the
//! same discipline the MCP manager already enforces.
//!
//! **Key management.** A single 32-byte key is derived once (OsRng) and persisted
//! `0600` in the data dir as `vault_key` — the exact posture `auth_token` uses
//! (`config.rs::resolve_auth_token`). It is loaded fresh on each [`Vault::open`]
//! (a cheap file read); nothing caches the raw key in a long-lived struct beyond
//! the operation that needs it.
//!
//! **Cipher.** AES-256-GCM via the already-vendored `openssl` crate (no new
//! dependency, no network at build time). Each seal draws a fresh 12-byte nonce;
//! the 16-byte GCM auth tag is appended to the ciphertext, so a tampered blob
//! fails to open. The plaintext is the credential map serialized as compact JSON.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use openssl::symm::{decrypt_aead, encrypt_aead, Cipher};
use rand::rngs::OsRng;
use rand::RngCore;

/// GCM nonce length (bytes). 96-bit nonces are the AES-GCM recommendation.
const NONCE_LEN: usize = 12;
/// GCM authentication-tag length (bytes) — the maximum for AES-GCM.
const TAG_LEN: usize = 16;
/// Raw key length for AES-256.
const KEY_LEN: usize = 32;

/// A sealed credential map: ciphertext (with the GCM tag appended) plus the nonce
/// it was sealed under. Maps 1:1 onto the `vault` row's `fields_enc` / `nonce`.
#[derive(Debug, Clone)]
pub struct Sealed {
    /// `ciphertext || tag` — what lands in `vault.fields_enc`.
    pub fields_enc: Vec<u8>,
    /// The per-secret 12-byte nonce — what lands in `vault.nonce`.
    pub nonce: Vec<u8>,
}

/// The vault: holds the loaded 32-byte key for the lifetime of one operation.
pub struct Vault {
    key: [u8; KEY_LEN],
}

impl Vault {
    /// Load (or, on first use, generate + persist `0600`) the vault key from
    /// `<data_dir>/vault_key`. Mirrors `config.rs::resolve_auth_token`.
    pub fn open(data_dir: &Path) -> Result<Self> {
        let key = load_or_create_key(&key_path(data_dir))?;
        Ok(Self { key })
    }

    /// Seal a credential field-map. The map is serialized to compact JSON, then
    /// AES-256-GCM encrypted under a fresh nonce; the tag is appended to the
    /// ciphertext.
    pub fn seal(&self, fields: &BTreeMap<String, String>) -> Result<Sealed> {
        let plaintext = serde_json::to_vec(fields).context("serializing credential map")?;
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let mut tag = [0u8; TAG_LEN];
        let mut ciphertext = encrypt_aead(
            Cipher::aes_256_gcm(),
            &self.key,
            Some(&nonce),
            &[], // no additional authenticated data
            &plaintext,
            &mut tag,
        )
        .map_err(|e| anyhow::anyhow!("aes-256-gcm seal failed: {e}"))?;
        ciphertext.extend_from_slice(&tag);
        Ok(Sealed {
            fields_enc: ciphertext,
            nonce: nonce.to_vec(),
        })
    }

    /// Open a sealed blob back into its credential field-map. Fails if the blob is
    /// truncated or the tag does not authenticate (tamper / wrong key).
    pub fn open_fields(&self, fields_enc: &[u8], nonce: &[u8]) -> Result<BTreeMap<String, String>> {
        if fields_enc.len() < TAG_LEN {
            bail!("vault blob too short to contain a GCM tag");
        }
        if nonce.len() != NONCE_LEN {
            bail!("vault nonce has the wrong length");
        }
        let split = fields_enc.len() - TAG_LEN;
        let (ciphertext, tag) = fields_enc.split_at(split);
        let plaintext = decrypt_aead(
            Cipher::aes_256_gcm(),
            &self.key,
            Some(nonce),
            &[],
            ciphertext,
            tag,
        )
        .map_err(|e| anyhow::anyhow!("aes-256-gcm open failed (tamper or wrong key): {e}"))?;
        let map: BTreeMap<String, String> =
            serde_json::from_slice(&plaintext).context("deserializing credential map")?;
        Ok(map)
    }
}

/// `<data_dir>/vault_key`.
fn key_path(data_dir: &Path) -> PathBuf {
    data_dir.join("vault_key")
}

/// Load the 32-byte key from `path` (base64), or generate + persist it `0600` on
/// first use. Same load-or-create posture as the dashboard `auth_token`.
fn load_or_create_key(path: &Path) -> Result<[u8; KEY_LEN]> {
    use base64::Engine as _;
    let engine = base64::engine::general_purpose::STANDARD;
    if path.exists() {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading {}", path.display()))?;
        let raw = engine
            .decode(text.trim())
            .with_context(|| format!("decoding {} (corrupt vault key?)", path.display()))?;
        let key: [u8; KEY_LEN] = raw
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("{} is not a 32-byte key", path.display()))?;
        return Ok(key);
    }
    let mut key = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut key);
    write_key_0600(path, &engine.encode(key))
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(key)
}

/// Write the base64 key to `path` with `0600` perms on Unix (mirrors
/// `config.rs::write_token_0600`).
fn write_key_0600(path: &Path, b64: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
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
        f.write_all(b64.as_bytes())?;
        f.write_all(b"\n")?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, format!("{b64}\n"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("supermux-vault-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn sample() -> BTreeMap<String, String> {
        let mut m = BTreeMap::new();
        m.insert("ICLOUD_APP_PW".to_string(), "hunter2-secret".to_string());
        m.insert("ICLOUD_USER".to_string(), "me@icloud.com".to_string());
        m
    }

    #[test]
    fn seal_open_roundtrips() {
        let dir = temp_dir();
        let v = Vault::open(&dir).unwrap();
        let sealed = v.seal(&sample()).unwrap();
        let back = v.open_fields(&sealed.fields_enc, &sealed.nonce).unwrap();
        assert_eq!(back, sample());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ciphertext_is_never_plaintext_on_disk() {
        let dir = temp_dir();
        let v = Vault::open(&dir).unwrap();
        let sealed = v.seal(&sample()).unwrap();
        // The raw secret must not appear anywhere in the sealed bytes.
        assert!(
            !sealed.fields_enc.windows(14).any(|w| w == b"hunter2-secret"),
            "raw secret must never appear in the sealed blob"
        );
        // Nonce + tag give a ciphertext strictly longer than the plaintext bytes.
        assert!(sealed.nonce.len() == NONCE_LEN);
        assert!(sealed.fields_enc.len() > TAG_LEN);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tamper_fails_to_open() {
        let dir = temp_dir();
        let v = Vault::open(&dir).unwrap();
        let mut sealed = v.seal(&sample()).unwrap();
        // Flip a ciphertext byte — the GCM tag must reject it.
        sealed.fields_enc[0] ^= 0xff;
        assert!(v.open_fields(&sealed.fields_enc, &sealed.nonce).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn key_persists_across_opens() {
        let dir = temp_dir();
        let v1 = Vault::open(&dir).unwrap();
        let sealed = v1.seal(&sample()).unwrap();
        // A fresh open must load the SAME persisted key and decrypt what v1 sealed.
        let v2 = Vault::open(&dir).unwrap();
        let back = v2.open_fields(&sealed.fields_enc, &sealed.nonce).unwrap();
        assert_eq!(back, sample());
        // The key file exists and is 0600 on unix.
        let kp = key_path(&dir);
        assert!(kp.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&kp).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "vault key must be 0600");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn distinct_nonces_across_seals() {
        let dir = temp_dir();
        let v = Vault::open(&dir).unwrap();
        let a = v.seal(&sample()).unwrap();
        let b = v.seal(&sample()).unwrap();
        assert_ne!(a.nonce, b.nonce, "each seal must draw a fresh nonce");
        assert_ne!(a.fields_enc, b.fields_enc, "same plaintext must not seal identically");
        std::fs::remove_dir_all(&dir).ok();
    }
}
