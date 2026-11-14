//! The host-wide Claude login switch (`[provider_defaults] claude_accounts_dir`).
//!
//! A host can hold several Claude logins, one config dir per login:
//!
//! ```text
//! <claude_accounts_dir>/
//!   ACTIVE              one line: the label new starts boot on
//!   gmail/              a CLAUDE_CONFIG_DIR: its own .credentials.json,
//!   icloud/             .claude.json and settings.json; `projects/` etc.
//!   work -> ~/.claude   linked back into the daemon's own Claude home
//! ```
//!
//! A Claude session that has NO `config_dir` of its own boots on the label in
//! `ACTIVE`. The file is read at every start, so switching the host is one write
//! to `ACTIVE`: every new session and every restart picks it up, and nothing that
//! is already running is touched. A session with an explicit `config_dir` keeps
//! it: an explicit choice always beats the host default.
//!
//! Two rules keep a switch from costing anything:
//!
//! * **A label that resolves to the daemon's own Claude home is "no export".**
//!   With `CLAUDE_CONFIG_DIR=~/.claude` Claude Code reads `~/.claude/.claude.json`,
//!   not `~/.claude.json`, so exporting it would boot that login without its
//!   onboarding and trust state. Leaving the variable unset is the same login.
//! * **The account dir must share the transcript tree.** Resume finds a
//!   conversation under `<config_dir>/projects`. If the account's `projects`
//!   is not the daemon's (normally a symlink into `~/.claude/projects`), a
//!   restart there would come up without its conversation, so the default is
//!   skipped with a warning instead.
//!
//! Anything unexpected (no `ACTIVE`, a bad label, a missing dir) also means
//! "no export": the host simply keeps its default login.

use std::path::{Path, PathBuf};

/// The file in `claude_accounts_dir` naming the active label.
pub const ACTIVE_FILE: &str = "ACTIVE";

/// A label is one plain path segment: `[A-Za-z0-9._-]{1,64}`, not `.`/`..`.
pub fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 64
        && label != "."
        && label != ".."
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Do `a` and `b` resolve to the same transcript tree (`<dir>/projects`)?
/// False when either side does not exist.
pub fn shares_transcripts(a: &Path, b: &Path) -> bool {
    match (
        std::fs::canonicalize(a.join("projects")),
        std::fs::canonicalize(b.join("projects")),
    ) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// The Claude config dir a session with config dir `config_dir` really reads:
/// its own dir, or the daemon's default home when it has none.
pub fn effective_home(config_dir: &str, default_home: &Path) -> PathBuf {
    let d = config_dir.trim();
    if d.is_empty() {
        default_home.to_path_buf()
    } else {
        PathBuf::from(d)
    }
}

/// Resolve the host default for a session WITHOUT its own `config_dir`.
///
/// `Some(dir)` is the directory to export as `CLAUDE_CONFIG_DIR`; `None` means
/// "export nothing" (the daemon's own login), see the module docs for when.
pub fn host_default_config_dir(accounts_dir: &Path, default_home: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(accounts_dir.join(ACTIVE_FILE)).ok()?;
    let label = raw.trim();
    if label.is_empty() {
        return None;
    }
    if !valid_label(label) {
        tracing::warn!(label = %label, "claude_accounts_dir: ACTIVE holds an invalid label; using the default login");
        return None;
    }
    let dir = accounts_dir.join(label);
    // The same charset + must-exist check `config_dir` gets on create/PATCH: the
    // value is single-quoted into the launch line.
    let dir_str = match crate::sessions::valid_config_dir(&dir.to_string_lossy()) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(label = %label, error = %e, "claude_accounts_dir: active account dir unusable; using the default login");
            return None;
        }
    };
    // The active label IS the daemon's own home: no export (module docs).
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(&dir), std::fs::canonicalize(default_home)) {
        if a == b {
            return None;
        }
    }
    if !shares_transcripts(&dir, default_home) {
        tracing::warn!(label = %label, dir = %dir_str, "claude_accounts_dir: active account does not share the transcript tree (projects/); using the default login so no conversation is lost");
        return None;
    }
    Some(dir_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "supermux-claude-account-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// A daemon home with `projects/`, and an accounts dir whose `gmail` shares it.
    fn layout() -> (PathBuf, PathBuf) {
        let home = tmp("home");
        std::fs::create_dir_all(home.join("projects")).unwrap();
        let accts = tmp("accts");
        let gmail = accts.join("gmail");
        std::fs::create_dir_all(&gmail).unwrap();
        std::os::unix::fs::symlink(home.join("projects"), gmail.join("projects")).unwrap();
        std::os::unix::fs::symlink(&home, accts.join("work")).unwrap();
        (home, accts)
    }

    #[test]
    fn the_active_label_becomes_the_export() {
        let (home, accts) = layout();
        std::fs::write(accts.join(ACTIVE_FILE), "gmail\n").unwrap();
        assert_eq!(
            host_default_config_dir(&accts, &home).as_deref(),
            Some(accts.join("gmail").to_str().unwrap())
        );
    }

    #[test]
    fn a_label_that_is_the_daemon_home_exports_nothing() {
        let (home, accts) = layout();
        std::fs::write(accts.join(ACTIVE_FILE), "work").unwrap();
        assert_eq!(host_default_config_dir(&accts, &home), None);
    }

    #[test]
    fn no_or_bad_active_file_keeps_the_default_login() {
        let (home, accts) = layout();
        assert_eq!(host_default_config_dir(&accts, &home), None, "no ACTIVE");
        for bad in ["", "  \n", "../gmail", "..", "gm ail", "missing"] {
            std::fs::write(accts.join(ACTIVE_FILE), bad).unwrap();
            assert_eq!(host_default_config_dir(&accts, &home), None, "ACTIVE={bad:?}");
        }
    }

    #[test]
    fn an_account_without_the_shared_transcripts_is_skipped() {
        let (home, accts) = layout();
        std::fs::create_dir_all(accts.join("lonely/projects")).unwrap();
        std::fs::write(accts.join(ACTIVE_FILE), "lonely").unwrap();
        assert_eq!(host_default_config_dir(&accts, &home), None);
        assert!(shares_transcripts(&accts.join("gmail"), &home));
        assert!(!shares_transcripts(&accts.join("lonely"), &home));
    }

    #[test]
    fn labels_are_one_plain_segment() {
        for ok in ["gmail", "internet-ventures", "a.b_c", "x"] {
            assert!(valid_label(ok), "{ok}");
        }
        for bad in ["", ".", "..", "a/b", "a b", "ä", &"x".repeat(65)] {
            assert!(!valid_label(bad), "{bad}");
        }
    }

    #[test]
    fn effective_home_falls_back_to_the_daemon_home() {
        let home = PathBuf::from("/h/.claude");
        assert_eq!(effective_home("", &home), home);
        assert_eq!(effective_home("  ", &home), home);
        assert_eq!(effective_home("/x/acct", &home), PathBuf::from("/x/acct"));
    }
}
