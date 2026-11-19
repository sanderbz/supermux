//! The keep-list-inverse: a source scan, not a behaviour test.
//!
//! Phase 4A deleted the scheduler. A deletion that only removes the UI is not a
//! deletion, and a deletion with no ratchet grows back the first time somebody
//! "restores" a capability from git history. This file is the ratchet.
//!
//! Four claims, in the order they matter:
//!
//! 1. The dragon strings — `execute_shell`, `execute_boot`, `bypass_permissions`,
//!    `done_pattern`, `command:` — do not appear anywhere under
//!    `server/src/workflows/`. Workflows sends prompts to agents. It does not
//!    run shells, it does not boot sessions, and it does not clamp permissions.
//! 2. `server/src/scheduler/` and `server/src/db/schedules.rs` are gone from
//!    disk, not merely unreferenced.
//! 3. The two legacy hook routes are STILL registered. Live panes hold footers
//!    naming those literal URLs, and a skill an agent already read teaches
//!    them. They are permanent.
//! 4. The `NotifCategory` DB values did not change. A renamed category silently
//!    un-mutes a user who muted it.

use std::path::{Path, PathBuf};

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::db::push::NotifCategory;
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use tower::ServiceExt;

/// `server/` — the crate root, resolved from the manifest so the test does not
/// care what the working directory is.
fn server_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Every `.rs` file under `dir`, recursively.
fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Lines of `file` that can actually execute — comment lines stripped. The doc
/// comments under `src/workflows/` name the deleted capabilities on purpose
/// ("`done_pattern` regex polling … deleted rather than ported"), and that prose
/// is the record of the removal, not a relapse.
fn code_lines(file: &Path) -> Vec<(usize, String)> {
    let body = std::fs::read_to_string(file).expect("read source");
    body.lines()
        .enumerate()
        .map(|(i, l)| (i + 1, l.to_string()))
        .filter(|(_, l)| {
            let t = l.trim_start();
            !(t.starts_with("//") || t.starts_with('*'))
        })
        .collect()
}

/// Names of capabilities, not of fields. There is no legitimate reason for any
/// of these to appear in workflow code at all — not even to refuse them, because
/// nothing in the new API can express them.
const ABSENT_EVERYWHERE: &[&str] = &[
    "execute_shell",
    "execute_boot",
    "worktree_is_dirty",
    "boot_session_name",
    "tail_anchor",
    "synth_expr",
    "done_action LIKE 'command:'",
    "starts_with(\"command:\")",
];

/// The units that DO something: they start runs, advance chains, finish them and
/// parse cadences. The dragon's field names must not reach any of them, even as
/// a variable. Refusing an old payload happens at the door (`mod.rs`, `hook.rs`)
/// and old rows are projected for read-only clients (`shim.rs`) — nowhere else.
const ACTING_UNITS: &[&str] = &["engine.rs", "complete.rs", "port.rs", "parser.rs"];

/// Field names the v1 API accepts only in order to refuse them by name.
const REFUSED_FIELDS: &[&str] = &[
    "kind",
    "command",
    "boot_dir",
    "boot_provider",
    "boot_worktree",
    "bypass_permissions",
    "_test_fire",
];

#[test]
fn the_dragon_capabilities_appear_nowhere_under_server_src_workflows() {
    let root = server_dir().join("src/workflows");
    assert!(root.is_dir(), "server/src/workflows must exist: {root:?}");

    let mut files = Vec::new();
    rust_files(&root, &mut files);
    assert!(!files.is_empty(), "no .rs files found under {root:?}");

    let mut hits: Vec<String> = Vec::new();
    for file in &files {
        for (n, line) in code_lines(file) {
            for needle in ABSENT_EVERYWHERE {
                if line.contains(needle) {
                    hits.push(format!("{}:{n}: {}", file.display(), line.trim()));
                }
            }
        }
    }
    assert!(hits.is_empty(), "the dragon is back:\n{}", hits.join("\n"));
}

#[test]
fn the_dragon_field_names_never_reach_the_units_that_act() {
    let root = server_dir().join("src/workflows");
    let mut hits: Vec<String> = Vec::new();
    for unit in ACTING_UNITS {
        let file = root.join(unit);
        assert!(file.is_file(), "{unit} must exist under src/workflows");
        for (n, line) in code_lines(&file) {
            for needle in ["bypass_permissions", "done_pattern", "boot_dir", "boot_provider"] {
                if line.contains(needle) {
                    hits.push(format!("{unit}:{n}: {}", line.trim()));
                }
            }
        }
    }
    assert!(
        hits.is_empty(),
        "a dragon field reached a unit that acts on it:\n{}",
        hits.join("\n")
    );
}

#[test]
fn the_two_doors_still_refuse_every_dragon_field_by_name() {
    // The mirror image of the two tests above: the field names that DO survive
    // in `mod.rs`/`hook.rs` survive only inside a rejection tuple. Delete the
    // tuple and an old payload starts being silently dropped instead of
    // answered — which is how a capability comes back as a no-op nobody notices.
    let root = server_dir().join("src/workflows");
    for door in ["mod.rs", "hook.rs"] {
        let body = std::fs::read_to_string(root.join(door)).expect("read source");
        for field in REFUSED_FIELDS {
            assert!(
                body.contains(&format!("(\"{field}\", ")),
                "{door} no longer refuses '{field}' by name"
            );
        }
    }
    // `done_action`, `watch` and `done_pattern` are bearer-path-only: the hook
    // never accepted them, so only the bearer door names them.
    let mod_rs = std::fs::read_to_string(root.join("mod.rs")).expect("read source");
    for field in ["done_action", "watch", "done_pattern"] {
        assert!(
            mod_rs.contains(&format!("(\"{field}\", ")),
            "mod.rs no longer refuses '{field}' by name"
        );
    }
}

#[test]
fn the_scheduler_module_and_its_db_layer_are_gone() {
    let server = server_dir();
    for gone in [
        "src/scheduler",
        "src/scheduler/mod.rs",
        "src/scheduler/runner.rs",
        "src/scheduler/watch.rs",
        "src/db/schedules.rs",
    ] {
        let path = server.join(gone);
        assert!(!path.exists(), "{gone} still exists on disk");
    }

    // And no module declaration survives to resurrect it.
    for (file, decl) in [("src/lib.rs", "pub mod scheduler;"), ("src/db/mod.rs", "pub mod schedules;")] {
        let body = std::fs::read_to_string(server.join(file)).expect("read source");
        assert!(!body.contains(decl), "{file} still declares `{decl}`");
    }
}

const TOKEN: &str = "wf-removals-bearer";

struct Harness {
    app: axum::Router,
    data_dir: PathBuf,
}

async fn spawn_harness() -> Harness {
    let data_dir = std::env::temp_dir().join(format!("supermux-wfrm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let config = Config {
        swarm_reaper: Default::default(),
        data_dir: data_dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: WsConfig::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        statusline_tap: false,
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        company_isolation: Vec::new(),
        human_auth: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state);
    Harness { app, data_dir }
}

#[tokio::test]
async fn the_two_legacy_hook_routes_are_still_registered() {
    let h = spawn_harness().await;
    // No hook token: the answer must be "who are you", never "no such route".
    // 404 here would mean a live pane's footer stopped working.
    for uri in ["/api/hook/schedule/done", "/api/hook/schedule/create"] {
        let resp = h
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        assert_ne!(status, StatusCode::NOT_FOUND, "{uri} is no longer registered");
        assert_ne!(status, StatusCode::METHOD_NOT_ALLOWED, "{uri} no longer accepts POST");
        // Unauthenticated garbage: the route answers "who are you" (401) or
        // "that is not a payload" (400). Either proves it is still wired.
        assert!(
            status == StatusCode::UNAUTHORIZED || status == StatusCode::BAD_REQUEST,
            "{uri} answered {status}"
        );
    }
    let _ = std::fs::remove_dir_all(&h.data_dir);
}

#[test]
fn the_notif_category_db_values_are_unchanged() {
    // These are the strings sitting in `push_prefs` rows on every deployed
    // install. They are frozen; only the human labels moved to "Workflow …".
    assert_eq!(NotifCategory::ScheduleError.as_str(), "schedule_error");
    assert_eq!(NotifCategory::ScheduleFinished.as_str(), "schedule_finished");
}
