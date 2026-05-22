//! Property test (REQUIRED gate, TECH_PLAN §7.1 / §3.2.11): `resolve_safe`
//! never escapes its jail under random Unicode-normalization, `..`-stacks, and
//! `//`-collapses.
//!
//! Strategy: build a path from random components rooted (textually) at a jail
//! dir, then assert that whenever `resolve_safe(_, Some(jail))` returns `Ok`,
//! the resolved absolute path is still under the (canonicalized) jail. Any path
//! that would escape must come back as an error, never a silently-accepted path.

use std::path::{Path, PathBuf};

use amux_server::files::path_safe::resolve_safe;
use proptest::prelude::*;

/// Random path components: traversal tokens, separators, unicode, and dotfiles.
fn component() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("..".to_string()),
        Just(".".to_string()),
        Just("".to_string()),       // yields `//` collapses when joined
        Just("/".to_string()),
        "[a-zA-Z0-9_.-]{1,8}",
        Just("é".to_string()),
        Just("café".to_string()),
        Just("ﬁle".to_string()),    // unicode ligature (normalization)
        Just("..%2f".to_string()),
        Just("nested".to_string()),
    ]
}

fn run<T, F: std::future::Future<Output = T>>(fut: F) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(fut)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, ..ProptestConfig::default() })]

    #[test]
    fn resolve_safe_never_escapes_jail(parts in proptest::collection::vec(component(), 0..14)) {
        run(async move {
            let jail_raw = std::env::temp_dir().join(format!("amux-jail-{}", uuid::Uuid::new_v4()));
            tokio::fs::create_dir_all(&jail_raw).await.unwrap();
            let jail = tokio::fs::canonicalize(&jail_raw).await.unwrap();

            // Build a textual path under the jail from the random parts.
            let mut s = jail.to_string_lossy().into_owned();
            for p in &parts {
                s.push('/');
                s.push_str(p);
            }

            if let Ok(abs) = resolve_safe(&s, Some(&jail)).await {
                prop_assert!(
                    abs.starts_with(&jail),
                    "escaped jail: input={s:?} resolved={abs:?} jail={jail:?}"
                );
            }

            let _ = tokio::fs::remove_dir_all(&jail_raw).await;
            Ok(())
        })?;
    }
}

/// A handful of explicit traversal attacks must each be rejected (Err), proving
/// the property test isn't vacuously passing on all-error inputs.
#[test]
fn explicit_traversals_are_rejected() {
    run(async {
        let jail_raw = std::env::temp_dir().join(format!("amux-jail-x-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&jail_raw).await.unwrap();
        let jail = tokio::fs::canonicalize(&jail_raw).await.unwrap();

        // An existing file just outside the jail.
        let outside = jail.parent().unwrap().join(format!("outside-{}.txt", uuid::Uuid::new_v4()));
        tokio::fs::write(&outside, b"secret").await.unwrap();

        let escape = format!("{}/../{}", jail.display(), outside.file_name().unwrap().to_string_lossy());
        let res = resolve_safe(&escape, Some(&jail)).await;
        assert!(res.is_err(), "`..` escape must be rejected, got {res:?}");

        let _ = tokio::fs::remove_file(&outside).await;
        let _ = tokio::fs::remove_dir_all(&jail_raw).await;
    });
}

/// Sanity: a legitimate in-jail target (even if not-yet-existing) resolves OK.
#[test]
fn in_jail_target_resolves() {
    run(async {
        let jail_raw = std::env::temp_dir().join(format!("amux-jail-ok-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&jail_raw).await.unwrap();
        let jail = tokio::fs::canonicalize(&jail_raw).await.unwrap();

        let target = format!("{}/sub/new.txt", jail.display());
        let abs: PathBuf = resolve_safe(&target, Some(&jail)).await.expect("should resolve");
        assert!(abs.starts_with(&jail));
        assert!(abs.ends_with(Path::new("sub/new.txt")));

        let _ = tokio::fs::remove_dir_all(&jail_raw).await;
    });
}
