//! Compile-time version metadata, baked by `build.rs`.
//!
//! `build.rs` runs `git describe --tags --always --dirty` + `git rev-parse HEAD`
//! and sets `SUPERMUX_VERSION_TAG`/`_SHA`/`_BUILD_TIME` via `rustc-env`. We read
//! them here with `option_env!` so a build outside a git working tree (e.g. a
//! source tarball) falls through to the "dev" defaults instead of failing to
//! compile.

use serde::Serialize;

/// The tag this binary was built from (e.g. `v0.3.0`), or `"dev"` when there
/// is no git working tree at build time.
pub const CURRENT_TAG: &str = match option_env!("SUPERMUX_VERSION_TAG") {
    Some(v) => v,
    None => "dev",
};

/// The commit sha this binary was built from (40 chars), or `"dev"`.
pub const CURRENT_SHA: &str = match option_env!("SUPERMUX_VERSION_SHA") {
    Some(v) => v,
    None => "dev",
};

/// The ISO-8601 UTC build timestamp (e.g. `2026-05-28T01:23:45Z`), or empty.
pub const BUILD_TIME: &str = match option_env!("SUPERMUX_BUILD_TIME") {
    Some(v) => v,
    None => "",
};

/// Snapshot of the running binary's identity, sent down `/api/version`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VersionInfo {
    /// The tag, when this binary was built from a tagged commit. `None` for a
    /// "dev" build (untagged sha) so the UI can render it differently.
    pub tag: Option<String>,
    /// The commit sha (or "dev"). Always present; the UI shows it as a muted
    /// monospace string beside the tag.
    pub sha: String,
    /// ISO-8601 UTC build time. Empty when unavailable.
    pub build_time: String,
}

impl VersionInfo {
    /// The running binary's [`VersionInfo`], read off the compile-time consts.
    /// A tag string that looks like a git short sha (no `v`-prefix, no `-dirty`
    /// suffix) reads as "no tag"; we ONLY treat `vN.M.P[-suffix]` patterns as
    /// a tag, so a fresh checkout's `git describe --tags --always` returning a
    /// bare sha does not falsely advertise itself as a release.
    pub fn current() -> Self {
        let tag = parse_tag(CURRENT_TAG);
        Self {
            tag,
            sha: CURRENT_SHA.to_string(),
            build_time: BUILD_TIME.to_string(),
        }
    }
}

/// `Some("v0.3.0")` for a tagged build; `None` for a dev sha-only describe.
/// Matches `v\d+(\.\d+){2}(-.*)?`; we accept `-dirty`, `-rc1`, etc. as suffixes.
fn parse_tag(s: &str) -> Option<String> {
    if s == "dev" || s.is_empty() {
        return None;
    }
    let core = s.split('-').next().unwrap_or(s);
    let after_v = core.strip_prefix('v')?;
    let mut parts = after_v.split('.');
    let major = parts.next()?;
    let minor = parts.next()?;
    let patch = parts.next()?;
    // Each component must be all-digits; guards against `valpha` being misread.
    if [major, minor, patch].iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    {
        Some(s.to_string())
    } else {
        None
    }
}

/// Compare two semver-ish tag strings (`v0.3.0`, `v0.3.0-rc1`). Returns `true`
/// IFF `latest` is strictly newer than `current`. A non-tag input always
/// returns `false` (no false-positive "update available" for dev builds).
///
/// We deliberately do NOT pull in a semver crate: the tag format is fully under
/// our control (one tag per release, monotonically increasing) and a tiny
/// component-wise lexicographic compare on the digits is sufficient.
pub fn is_newer(current: Option<&str>, latest: Option<&str>) -> bool {
    let Some(latest) = latest else { return false };
    let Some(current) = current else {
        // A dev build with a real release available; we still don't auto-tag
        // it as "update available" because the dev probably has uncommitted
        // changes; the preflight will produce a clear `NotOnMain` / `Uncommitted`
        // reason anyway. Returning false here keeps the cosmetic state honest.
        return false;
    };
    let (cn, cpre, c_ahead) = parse_semver(current);
    let (ln, lpre, _) = parse_semver(latest);
    match cmp_components(&ln, &cn) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        // A describe-ahead build (`v0.4.20-1-g6a951b8`: master moved past the
        // tag) sits AT-OR-ABOVE its tag, so the same-core release is never an
        // update — offering it would be a downgrade.
        std::cmp::Ordering::Equal if c_ahead && cpre.is_empty() => false,
        // Same core (e.g. v0.3.0 vs v0.3.0-rc1). Per semver §11, a release
        // ranks ABOVE its pre-releases: `v0.3.0` is newer than `v0.3.0-rc1`.
        std::cmp::Ordering::Equal => match (cpre.is_empty(), lpre.is_empty()) {
            (true, true) => false,        // identical
            (true, false) => false,       // current=release, latest=pre → not newer
            (false, true) => true,        // current=pre, latest=release → upgrade
            (false, false) => lpre > cpre, // both pre-release: lexicographic on the suffix
        },
    }
}

/// `v0.3.0-rc1` → ([0, 3, 0], "rc1", false). The pre-release suffix is empty
/// for a plain release tag. The bool is true when the suffix carried a
/// git-describe ahead-marker (`-N-g<sha>`): the build is N commits PAST the
/// tag, not a pre-release of it. `-dirty` is build metadata, stripped either
/// way.
fn parse_semver(tag: &str) -> (Vec<u64>, String, bool) {
    let bare = tag.trim_start_matches('v');
    let (core, pre) = match bare.split_once('-') {
        Some((c, p)) => (c, p.to_string()),
        None => (bare, String::new()),
    };
    let components = core
        .split('.')
        .filter_map(|p| p.parse::<u64>().ok())
        .collect();
    let (pre, ahead) = strip_describe_metadata(&pre);
    (components, pre, ahead)
}

/// `git describe --tags --dirty` appends `-N-g<sha>` when HEAD is N commits
/// past the tag and `-dirty` when the tree has local edits. Strip both from a
/// pre-release suffix; report whether the ahead-marker was present.
fn strip_describe_metadata(pre: &str) -> (String, bool) {
    let mut parts: Vec<&str> = if pre.is_empty() { Vec::new() } else { pre.split('-').collect() };
    if parts.last() == Some(&"dirty") {
        parts.pop();
    }
    let mut ahead = false;
    if let [.., n, g] = parts.as_slice() {
        let is_count = !n.is_empty() && n.chars().all(|c| c.is_ascii_digit());
        let is_gsha = g.len() > 1
            && g.starts_with('g')
            && g[1..].chars().all(|c| c.is_ascii_hexdigit());
        if is_count && is_gsha {
            ahead = true;
            parts.truncate(parts.len() - 2);
        }
    }
    (parts.join("-"), ahead)
}

fn cmp_components(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    for i in 0..a.len().max(b.len()) {
        let av = a.get(i).copied().unwrap_or(0);
        let bv = b.get(i).copied().unwrap_or(0);
        match av.cmp(&bv) {
            std::cmp::Ordering::Equal => continue,
            o => return o,
        }
    }
    std::cmp::Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tag_accepts_release_tags() {
        assert_eq!(parse_tag("v0.3.0"), Some("v0.3.0".into()));
        assert_eq!(parse_tag("v1.2.3-rc1"), Some("v1.2.3-rc1".into()));
        assert_eq!(parse_tag("v0.2.0-dirty"), Some("v0.2.0-dirty".into()));
    }

    #[test]
    fn parse_tag_rejects_bare_sha_and_dev() {
        assert_eq!(parse_tag("b373091"), None);
        assert_eq!(parse_tag("dev"), None);
        assert_eq!(parse_tag(""), None);
        assert_eq!(parse_tag("v0.3"), None); // only two components
        assert_eq!(parse_tag("valpha"), None);
    }

    #[test]
    fn is_newer_recognises_a_real_upgrade() {
        assert!(is_newer(Some("v0.2.0"), Some("v0.3.0")));
        assert!(is_newer(Some("v0.2.0"), Some("v0.2.1")));
        assert!(is_newer(Some("v0.3.0-rc1"), Some("v0.3.0")));
        assert!(!is_newer(Some("v0.3.0"), Some("v0.3.0")));
        assert!(!is_newer(Some("v0.3.0"), Some("v0.2.9")));
    }

    #[test]
    fn describe_ahead_build_is_not_older_than_its_tag() {
        // A deploy from master 1 commit past the v0.4.20 tag describes as
        // `v0.4.20-1-g6a951b8`. The v0.4.20 release is OLDER, not an update.
        assert!(!is_newer(Some("v0.4.20-1-g6a951b8"), Some("v0.4.20")));
        assert!(!is_newer(Some("v0.4.20-1-g6a951b8-dirty"), Some("v0.4.20")));
        // ...but a genuinely newer release still advertises.
        assert!(is_newer(Some("v0.4.20-1-g6a951b8"), Some("v0.4.21")));
        // A dirty build of the tag itself is the same version, not an upgrade.
        assert!(!is_newer(Some("v0.4.20-dirty"), Some("v0.4.20")));
        // Real pre-releases keep semver §11 ordering (release > its pre).
        assert!(is_newer(Some("v0.3.0-rc1"), Some("v0.3.0")));
        // Describe-ahead of a pre-release tag still upgrades to the release.
        assert!(is_newer(Some("v0.3.0-rc1-2-gabc1234"), Some("v0.3.0")));
    }

    #[test]
    fn dev_build_never_advertises_update() {
        // The preflight surfaces the dev-state reasons separately; the bare
        // version-vs-version compare should stay conservative.
        assert!(!is_newer(None, Some("v0.3.0")));
    }
}
