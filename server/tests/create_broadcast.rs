//! Wave-8 residual (codex verify-3, item 2): `sessions::create` must BROADCAST a
//! full-row `sessions` SSE, not just return its row over HTTP.
//!
//! The cross-tab recreate edge: tab A hard-deletes a name (arming a 15s
//! removal-tombstone in its client), then tab B recreates the SAME name within
//! that TTL. Before the fix, `create` emitted no full-row SSE at all — the only
//! cross-tab signal was the LATER `start` broadcast's thin `{name,status}`
//! delta, which carries no identity columns. The client's tombstone
//! discriminator (web wave-7 #110) only clears on a row that proves it is
//! authoritative by carrying `dir` + `provider`; a partial cannot, so tab A
//! rejected the recreate and stranded the tile until the tombstone expired.
//!
//! The fix mirrors `unarchive`'s broadcast: on create success, serialize the
//! full `SessionView` and send it as a `sessions` delta. This asserts that
//! broadcast reaches subscribers AND that its row carries `dir` + `provider`
//! (i.e. is a full authoritative row, distinct in shape from the `{name,status}`
//! start delta). Without the fix, no `sessions` delta carrying those identity
//! columns ever reaches a subscriber and this fails.

use std::path::PathBuf;
use std::time::Duration;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::sessions::{self, CreateInput};
use supermux_server::state::AppState;
use supermux_server::db;

const TOKEN: &str = "create-broadcast-token";

fn temp_config() -> (Config, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-create-bc-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
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
        human_auth: Default::default(),
    };
    (config, dir)
}

async fn new_state() -> (AppState, PathBuf) {
    let (config, dir) = temp_config();
    let pool = db::init(&config).await.expect("db init");
    (AppState::new(pool, config), dir)
}

fn create_input(name: &str, dir: &std::path::Path) -> CreateInput {
    CreateInput {
        name: name.to_string(),
        display_name: None,
        dir: Some(dir.display().to_string()),
        desc: None,
        provider: Some("claude".to_string()),
        creator: Some("test".to_string()),
        flags: None,
        tags: None,
        branch: None,
        mcp: None,
        worktree: None,
        host_id: None,
        bypass_permissions: None,
        // Native + local: no tmux/pty is actually launched by `create`; it only
        // inserts the row and spawns the in-memory detector/steering loops.
        runtime: Some("native".to_string()),
        model: None,
        company_id: None,
    }
}

#[tokio::test]
async fn create_broadcasts_a_full_row_sessions_delta_with_identity_columns() {
    let (state, dir) = new_state().await;

    // Subscribe BEFORE the create so we catch its own broadcast.
    let mut rx = state.sse_tx.subscribe();

    let view = sessions::create(&state, create_input("fresh", &dir))
        .await
        .expect("create");
    assert_eq!(view.name, "fresh");
    assert_eq!(view.provider, "claude");

    // Drain up to ~2s: the create path spawns background loops whose first ticks
    // may interleave; we only need the full-row `sessions` delta itself.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let mut saw_full_row = false;
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(100), rx.recv()).await {
            Ok(Ok(ev)) if ev.event == "sessions" => {
                let deltas = ev
                    .payload
                    .get("delta")
                    .and_then(|d| d.as_array())
                    .cloned()
                    .unwrap_or_default();
                for d in deltas {
                    if d.get("name").and_then(|n| n.as_str()) != Some("fresh") {
                        continue;
                    }
                    // The discriminator: an authoritative full row carries BOTH
                    // identity columns. The `{name,status}` start delta carries
                    // NEITHER, so this is what distinguishes the two shapes.
                    let has_dir = d.get("dir").and_then(|v| v.as_str()).is_some();
                    let has_provider =
                        d.get("provider").and_then(|v| v.as_str()) == Some("claude");
                    if has_dir && has_provider {
                        saw_full_row = true;
                        break;
                    }
                }
                if saw_full_row {
                    break;
                }
            }
            Ok(Ok(_)) => continue,
            Ok(Err(_)) | Err(_) => continue,
        }
    }

    assert!(
        saw_full_row,
        "expected a `sessions` SSE delta carrying a FULL row (dir + provider) on \
         create — without it a cross-tab recreate within the 15s removal-tombstone \
         TTL never clears the other tab's tombstone",
    );
}
