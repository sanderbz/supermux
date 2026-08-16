//! Chat WebSocket end-to-end tests (fase A2, Task 4).
//!
//! Drives the REAL router over a bound port: handshake parity with the terminal
//! socket, the server-side eligibility guard, the seed→live boundary under a
//! firehose, staleness transitions, and the two backlog REST routes.
//!
//! `$CLAUDE_CONFIG_DIR` is process-global (it is how the tailer resolves a
//! session's transcript), so the env-mutating tests serialise behind `ENV_LOCK`
//! — the same pattern `tests/recall_http.rs` uses.

use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::db::sessions::NewSession;
use supermux_server::sessions::chat::model::{ChatEntry, Kind};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as Msg;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tower::ServiceExt;

const TOKEN: &str = "chat-ws-secret";

/// `$CLAUDE_CONFIG_DIR` is process-global, so the tests that set it run one at
/// a time. An async mutex (not `std`) because the guard has to span the whole
/// test body — every one of these tests awaits while holding it.
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Harness {
    addr: SocketAddr,
    app: axum::Router,
    state: AppState,
    data_dir: PathBuf,
    claude_dir: PathBuf,
    work_dir: PathBuf,
}

impl Harness {
    /// `~/.claude/projects/<encoded cwd>/` for this harness' work dir.
    fn project_dir(&self) -> PathBuf {
        let resolved = std::fs::canonicalize(&self.work_dir).unwrap();
        let encoded: String = resolved
            .to_string_lossy()
            .chars()
            .map(|c| if c == '/' || c == '.' { '-' } else { c })
            .collect();
        self.claude_dir.join("projects").join(encoded)
    }

    fn cleanup(self) {
        for d in [self.data_dir, self.claude_dir, self.work_dir] {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("supermux-chatws-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

async fn spawn_harness() -> Harness {
    let data_dir = tmp("data");
    let claude_dir = tmp("claude");
    let work_dir = tmp("work");
    std::env::set_var("CLAUDE_CONFIG_DIR", &claude_dir);

    let config = Config {
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
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let served = app.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, served).await;
    });
    Harness { addr, app, state, data_dir, claude_dir, work_dir }
}

async fn make_session(h: &Harness, name: &str, provider: &str, host_id: Option<i64>) {
    db::sessions::create(
        &h.state.pool,
        &NewSession {
            name: name.to_string(),
            display_name: name.to_string(),
            dir: h.work_dir.to_string_lossy().to_string(),
            desc: String::new(),
            provider: provider.to_string(),
            creator: "test".to_string(),
            flags: String::new(),
            tags: "[]".to_string(),
            branch: String::new(),
            mcp: String::new(),
            worktree: false,
            worktree_repo: String::new(),
            host_id,
            runtime: "native".to_string(),
        },
    )
    .await
    .expect("create session");
}

fn text(s: &str) -> Msg {
    Msg::Text(s.to_owned())
}

async fn connect(addr: SocketAddr, name: &str) -> Ws {
    let url = format!("ws://{addr}/ws/sessions/{name}/chat");
    let (ws, _resp) = tokio_tungstenite::connect_async(url).await.expect("ws connect");
    ws
}

/// Connect + first-frame auth; returns the socket after `auth_ok`.
async fn connect_authed(addr: SocketAddr, name: &str) -> Ws {
    let mut ws = connect(addr, name).await;
    ws.send(text(&format!(r#"{{"type":"auth","token":"{TOKEN}"}}"#)))
        .await
        .unwrap();
    let first = next_json(&mut ws).await.expect("auth_ok");
    assert_eq!(first["type"], json!("auth_ok"), "got {first}");
    ws
}

/// Next JSON text frame (skips Ping/Pong/Binary). `None` on close/timeout.
async fn next_json(ws: &mut Ws) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return None;
        }
        match tokio::time::timeout(left, ws.next()).await {
            Ok(Some(Ok(Msg::Text(t)))) => {
                return Some(serde_json::from_str(&t).unwrap_or_else(|e| panic!("bad frame {t}: {e}")))
            }
            Ok(Some(Ok(Msg::Close(_)))) | Ok(Some(Err(_))) | Ok(None) => return None,
            Ok(Some(Ok(_))) => {}
            Err(_) => return None,
        }
    }
}

async fn read_close_code(ws: &mut Ws, timeout: Duration) -> Option<u16> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return None;
        }
        match tokio::time::timeout(left, ws.next()).await {
            Ok(Some(Ok(Msg::Close(Some(cf))))) => return Some(u16::from(cf.code)),
            Ok(Some(Ok(Msg::Close(None)))) => return None,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => return None,
            Err(_) => return None,
        }
    }
}

async fn get(app: &axum::Router, uri: &str) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

fn user_line(uuid: &str, textv: &str) -> String {
    json!({
        "type": "user",
        "uuid": uuid,
        "timestamp": "2026-01-01T00:00:00Z",
        "sessionId": "conv-a",
        "message": { "role": "user", "content": textv },
    })
    .to_string()
}

fn write_transcript(proj: &Path, conv: &str, lines: &[String]) {
    std::fs::create_dir_all(proj).unwrap();
    let mut f = std::fs::File::create(proj.join(format!("{conv}.jsonl"))).unwrap();
    for l in lines {
        writeln!(f, "{l}").unwrap();
    }
}

fn entry(uuid: &str, textv: &str) -> ChatEntry {
    ChatEntry {
        uuid: uuid.to_string(),
        kind: Kind::Assistant,
        ts_ms: 0,
        offset: 0,
        session_id: None,
        tool_use_id: None,
        label: None,
        ok: None,
        is_sidechain: false,
        agent_id: None,
        oversize: false,
        body: json!({ "text": textv }),
    }
}

// ── the handshake ───────────────────────────────────────────────────────────

#[tokio::test]
async fn rejects_bad_origin_and_missing_auth_exactly_like_the_terminal_ws() {
    let _g = ENV_LOCK.lock().await;
    let h = spawn_harness().await;
    make_session(&h, "chat-hs", "claude", None).await;

    // 1. A disallowed browser Origin → 1008, before any auth is even read.
    let url = format!("ws://{}/ws/sessions/chat-hs/chat", h.addr);
    let mut req = url.clone().into_client_request().unwrap();
    req.headers_mut()
        .insert("origin", "https://evil.example".parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    assert_eq!(
        read_close_code(&mut ws, Duration::from_secs(4)).await,
        Some(1008),
        "disallowed Origin must close 1008"
    );

    // 2. No first frame within the 2s auth window → 1008.
    let mut ws = connect(h.addr, "chat-hs").await;
    let started = tokio::time::Instant::now();
    assert_eq!(
        read_close_code(&mut ws, Duration::from_secs(5)).await,
        Some(1008),
        "missing auth frame must close 1008"
    );
    assert!(started.elapsed() < Duration::from_secs(4));

    // 3. Wrong token → 1008.
    let mut ws = connect(h.addr, "chat-hs").await;
    ws.send(text(r#"{"type":"auth","token":"WRONG"}"#)).await.unwrap();
    assert_eq!(
        read_close_code(&mut ws, Duration::from_secs(4)).await,
        Some(1008),
        "wrong token must close 1008"
    );

    h.cleanup();
}

#[tokio::test]
async fn ineligible_session_is_refused() {
    let _g = ENV_LOCK.lock().await;
    let h = spawn_harness().await;

    // A non-Claude provider.
    make_session(&h, "chat-codex", "codex", None).await;
    // A remote session (real hosts row — `host_id` is an enforced FK).
    let host = db::hosts::create(&h.state.pool, "box", "user@box", None)
        .await
        .expect("host");
    make_session(&h, "chat-remote", "claude", Some(host.id)).await;
    // A team lead — with a REAL on-disk roster: eligibility no longer trusts
    // the (pollution-prone) team_name column alone, it demands an actual
    // teammate in the roster. The harness already points CLAUDE_CONFIG_DIR at
    // its private `claude_dir`, so the fixture lands there, never in ~/.claude.
    let squad = h.claude_dir.join("teams").join("squad");
    std::fs::create_dir_all(&squad).unwrap();
    std::fs::write(
        squad.join("config.json"),
        r#"{"name":"squad","leadAgentId":"team-lead@squad","members":[
            {"agentId":"team-lead@squad","name":"team-lead","agentType":"team-lead"},
            {"agentId":"worker@squad","name":"worker","agentType":"claude"}]}"#,
    )
    .unwrap();
    make_session(&h, "chat-lead", "claude", None).await;
    db::sessions::set_team_name(&h.state.pool, "chat-lead", Some("squad"))
        .await
        .unwrap();
    // …and a session that does not exist at all.
    for name in ["chat-codex", "chat-remote", "chat-lead", "chat-ghost"] {
        let mut ws = connect_authed(h.addr, name).await;
        assert_eq!(
            read_close_code(&mut ws, Duration::from_secs(4)).await,
            Some(4404),
            "{name}: an ineligible session must be refused with the terminal 4404 \
             (auth PASSED — this is a 404, not an auth failure)"
        );
    }

    // The REST backlog routes are gated by the same guard.
    let (status, _) = get(&h.app, "/api/sessions/chat-codex/chat/history").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = get(&h.app, "/api/sessions/chat-lead/chat/entry/u1").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    h.cleanup();
}

#[tokio::test]
async fn an_eligible_session_seeds_from_its_transcript_and_reports_its_state() {
    let _g = ENV_LOCK.lock().await;
    let h = spawn_harness().await;
    let conv = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    write_transcript(
        &h.project_dir(),
        conv,
        &[user_line("u1", "hello"), user_line("u2", "world")],
    );
    make_session(&h, "chat-seed", "claude", None).await;
    db::sessions::track_cc_conversation_id(&h.state.pool, "chat-seed", conv)
        .await
        .unwrap();

    let mut ws = connect_authed(h.addr, "chat-seed").await;
    let seed = next_json(&mut ws).await.expect("seed frame");
    assert_eq!(seed["type"], json!("seed"));
    let uuids: Vec<&str> = seed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["uuid"].as_str().unwrap())
        .collect();
    assert_eq!(uuids, ["u1", "u2"], "the seed is the tailer's ring, in file order");
    assert_eq!(seed["has_more"], json!(false), "the ring starts at byte 0");

    let done = next_json(&mut ws).await.expect("seed_done frame");
    assert_eq!(done["type"], json!("seed_done"));
    assert_eq!(done["high_water"], json!(2), "the exact seed→live boundary");
    assert!(done["state"].is_string(), "seed_done always carries the tail state");

    h.cleanup();
}

#[tokio::test]
async fn seed_then_live_is_strictly_consecutive_under_a_firehose() {
    let _g = ENV_LOCK.lock().await;
    let h = spawn_harness().await;
    let conv = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    write_transcript(&h.project_dir(), conv, &[user_line("u0", "seed")]);
    make_session(&h, "chat-fire", "claude", None).await;
    db::sessions::track_cc_conversation_id(&h.state.pool, "chat-fire", conv)
        .await
        .unwrap();

    // A first client makes the tailer run its (resetting) first pass, so the
    // direct publishes below cannot race the cursor rebuild. It also puts the
    // transcript's own entry at seq 0.
    let mut warm = connect_authed(h.addr, "chat-fire").await;
    let _ = next_json(&mut warm).await.expect("seed");
    let _ = next_json(&mut warm).await.expect("seed_done");

    // The firehose, in two gated phases so the attach is PROVABLY mid-stream:
    // 1000 entries land before the client attaches and 1000 after. Anything
    // less deterministic can pass vacuously — a writer that finishes first
    // makes the whole run a seed with no live segment to be consecutive with.
    // (Phase size ≤ the 1024-deep broadcast, so a healthy client cannot Lagged.)
    let (phase1_tx, phase1_rx) = tokio::sync::oneshot::channel::<()>();
    let (go_tx, go_rx) = tokio::sync::oneshot::channel::<()>();
    let store = h.state.chat_store_for("chat-fire");
    let writer = tokio::spawn(async move {
        let s = store.clone();
        tokio::task::spawn_blocking(move || {
            for i in 0..1_000u64 {
                s.publish(vec![entry(&format!("f{i}"), "x")]);
            }
        })
        .await
        .unwrap();
        phase1_tx.send(()).unwrap();
        go_rx.await.unwrap();
        tokio::task::spawn_blocking(move || {
            for i in 1_000..2_000u64 {
                store.publish(vec![entry(&format!("f{i}"), "x")]);
            }
        })
        .await
        .unwrap();
    });
    phase1_rx.await.unwrap();

    let mut ws = connect_authed(h.addr, "chat-fire").await;
    let seed = next_json(&mut ws).await.expect("seed");
    let done = next_json(&mut ws).await.expect("seed_done");
    let high_water = done["high_water"].as_u64().unwrap();
    assert_eq!(
        high_water, 1_001,
        "the boundary is exactly what phase 1 published (1 transcript entry + 1000)"
    );

    let mut seen: Vec<u64> = seed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["seq"].as_u64().unwrap())
        .collect();
    let seeded = seen.len();
    assert!(seeded > 0, "phase 1 must be visible in the seed");
    assert!(
        seen.iter().all(|s| *s < high_water),
        "the seed carries exactly seq < high_water"
    );

    // Phase 2 streams live, across the boundary this client already crossed.
    go_tx.send(()).unwrap();
    while seen.last().copied().unwrap_or(0) < 2_000 {
        let Some(frame) = next_json(&mut ws).await else { break };
        if frame["type"] != json!("entry") {
            assert_ne!(frame["type"], json!("resync"), "a healthy client must not lag");
            continue;
        }
        let seq = frame["entry"]["seq"].as_u64().unwrap();
        assert!(seq >= high_water, "a live frame below the boundary would duplicate the seed");
        seen.push(seq);
    }
    writer.await.unwrap();

    assert_eq!(
        seen.len() - seeded,
        1_000,
        "every phase-2 entry arrived live — the run really did cross the boundary"
    );
    for pair in seen.windows(2) {
        assert_eq!(
            pair[1],
            pair[0] + 1,
            "gap or duplicate across the seed→live boundary at {pair:?}"
        );
    }
    assert_eq!(
        seen.last().copied(),
        Some(2_000),
        "the client observed every entry up to the last published one"
    );

    h.cleanup();
}

#[tokio::test]
async fn staleness_state_is_sent_on_seed_done_and_on_every_transition() {
    let _g = ENV_LOCK.lock().await;
    let h = spawn_harness().await;
    let conv = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    std::fs::create_dir_all(h.project_dir()).unwrap();
    make_session(&h, "chat-state", "claude", None).await;
    db::sessions::track_cc_conversation_id(&h.state.pool, "chat-state", conv)
        .await
        .unwrap();

    // No transcript for the tracked conversation → never "an empty chat".
    let mut ws = connect_authed(h.addr, "chat-state").await;
    let _seed = next_json(&mut ws).await.expect("seed");
    let done = next_json(&mut ws).await.expect("seed_done");
    assert_eq!(
        done["state"], json!("reconnecting"),
        "a missing transcript is reported, never rendered as a complete chat"
    );

    // The transcript appears → the next tailer pass must announce the change.
    write_transcript(&h.project_dir(), conv, &[user_line("u1", "hi")]);
    let mut saw_live = false;
    for _ in 0..12 {
        let Some(frame) = next_json(&mut ws).await else { break };
        if frame["type"] == json!("state") && frame["state"] == json!("live") {
            saw_live = true;
            break;
        }
    }
    assert!(saw_live, "a staleness transition must be pushed, not polled for");

    h.cleanup();
}

#[tokio::test]
async fn a_tailer_that_exits_closes_its_sockets_instead_of_stranding_them() {
    // Nothing restarts a tailer for an existing lease, and the WS `Err(_)` arm
    // that was supposed to catch this is unreachable: the lease itself owns the
    // handle that owns the `watch::Sender`, so `changed()` never errors while
    // the socket is up. A session whose row disappears therefore used to leave
    // the client ping-ponging forever against a conversation that had silently
    // stopped updating.
    let _g = ENV_LOCK.lock().await;
    let h = spawn_harness().await;
    let conv = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    write_transcript(&h.project_dir(), conv, &[user_line("u1", "hi")]);
    make_session(&h, "chat-gone", "claude", None).await;
    db::sessions::track_cc_conversation_id(&h.state.pool, "chat-gone", conv)
        .await
        .unwrap();

    let mut ws = connect_authed(h.addr, "chat-gone").await;
    let _ = next_json(&mut ws).await.expect("seed");
    let _ = next_json(&mut ws).await.expect("seed_done");

    // The row goes away under the running tailer.
    sqlx::query("DELETE FROM sessions WHERE name = ?")
        .bind("chat-gone")
        .execute(&h.state.pool)
        .await
        .unwrap();

    let code = read_close_code(&mut ws, Duration::from_secs(10)).await;
    assert_eq!(
        code,
        Some(4404),
        "a tailer that gave up for good must CLOSE the socket terminally"
    );

    h.cleanup();
}

#[tokio::test]
async fn unknown_client_frame_is_ignored_not_fatal() {
    let _g = ENV_LOCK.lock().await;
    let h = spawn_harness().await;
    let conv = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    write_transcript(&h.project_dir(), conv, &[user_line("u1", "hi")]);
    make_session(&h, "chat-frames", "claude", None).await;
    db::sessions::track_cc_conversation_id(&h.state.pool, "chat-frames", conv)
        .await
        .unwrap();

    let mut ws = connect_authed(h.addr, "chat-frames").await;
    let _ = next_json(&mut ws).await.expect("seed");
    let _ = next_json(&mut ws).await.expect("seed_done");

    // A2 is READ-ONLY: an input frame, a resize, a second auth and outright
    // garbage are all ignored — never applied, never fatal.
    for frame in [
        r#"{"type":"input","data":"rm -rf /"}"#,
        r#"{"type":"resize","cols":80,"rows":24}"#,
        r#"{"type":"auth","token":"WRONG"}"#,
        "not json at all",
    ] {
        ws.send(text(frame)).await.unwrap();
    }

    // The socket is still live: a freshly published entry still arrives.
    h.state
        .chat_store_for("chat-frames")
        .publish(vec![entry("after", "still here")]);
    let mut got = None;
    for _ in 0..5 {
        let Some(f) = next_json(&mut ws).await else { break };
        if f["type"] == json!("entry") {
            got = f["entry"]["uuid"].as_str().map(str::to_string);
            break;
        }
    }
    assert_eq!(got.as_deref(), Some("after"), "the socket survived the unknown frames");

    h.cleanup();
}

#[tokio::test]
async fn a_reseed_after_the_conversation_moved_issues_a_cursor_the_history_route_accepts() {
    // `conv` used to be captured once, before the loop, and reused for every
    // later seed — including the "conversation changed" re-seed that exists
    // precisely because the tailer retargeted to a DIFFERENT conversation. The
    // fresh seed's `next_before` was therefore stamped `<old-conv>:<offset>`,
    // which `history_handler` compares against the current row and 409s. The
    // client obeys the 409 by re-seeding over the same socket… and gets the
    // same stale cursor: scroll-back broken for the life of that socket.
    let _g = ENV_LOCK.lock().await;
    let h = spawn_harness().await;
    let old = "11111111-1111-1111-1111-111111111111";
    let new = "22222222-2222-2222-2222-222222222222";
    write_transcript(&h.project_dir(), old, &[user_line("old1", "before")]);
    make_session(&h, "chat-moved", "claude", None).await;
    db::sessions::track_cc_conversation_id(&h.state.pool, "chat-moved", old)
        .await
        .unwrap();

    let mut ws = connect_authed(h.addr, "chat-moved").await;
    let _ = next_json(&mut ws).await.expect("seed");
    let _ = next_json(&mut ws).await.expect("seed_done");

    // `/clear`: a new conversation file, and the hook moves the pointer. More
    // lines than the ring holds, so the fresh seed really does carry a cursor.
    let lines: Vec<String> = (0..600).map(|i| user_line(&format!("n{i}"), "after")).collect();
    write_transcript(&h.project_dir(), new, &lines);
    db::sessions::track_cc_conversation_id(&h.state.pool, "chat-moved", new)
        .await
        .unwrap();
    h.state.wake_chat_pointer("chat-moved");

    // Wall-clock bounded rather than frame-count bounded: the re-seed waits on
    // a tailer pass that runs on the shared blocking pool, which is slow under
    // a loaded `cargo test`.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut cursor = None;
    while cursor.is_none() && tokio::time::Instant::now() < deadline {
        let Some(frame) = next_json(&mut ws).await else { continue };
        if frame["type"] == json!("seed") {
            if let Some(c) = frame["next_before"].as_str() {
                cursor = Some(c.to_string());
            }
        }
    }
    let cursor = cursor.expect("the re-seed must carry a paging cursor");
    assert!(
        cursor.starts_with(new),
        "the cursor must carry the CURRENT conversation id, got {cursor}"
    );

    let (status, body) = get(
        &h.app,
        &format!("/api/sessions/chat-moved/chat/history?before={cursor}&limit=5"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the server's own freshly-issued cursor must not 409: {body}"
    );
    assert!(!body["data"]["entries"].as_array().unwrap().is_empty());

    h.cleanup();
}

// ── the backlog REST routes ─────────────────────────────────────────────────

#[tokio::test]
async fn history_cursor_from_a_different_conversation_is_409_not_spliced() {
    let _g = ENV_LOCK.lock().await;
    let h = spawn_harness().await;
    let conv = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    let lines: Vec<String> = (0..6).map(|i| user_line(&format!("u{i}"), "hello")).collect();
    write_transcript(&h.project_dir(), conv, &lines);
    make_session(&h, "chat-hist", "claude", None).await;
    db::sessions::track_cc_conversation_id(&h.state.pool, "chat-hist", conv)
        .await
        .unwrap();

    // A cursor from THIS conversation pages backwards.
    let (status, body) = get(
        &h.app,
        &format!("/api/sessions/chat-hist/chat/history?before={conv}:1000000&limit=3"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body was {body}");
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["data"]["entries"].as_array().unwrap().len(), 3);
    assert_eq!(body["data"]["has_more"], json!(true));

    // A cursor from ANOTHER conversation is a 409 so the client re-seeds
    // instead of splicing two conversations together.
    let (status, body) = get(
        &h.app,
        "/api/sessions/chat-hist/chat/history?before=ffffffff-0000-0000-0000-000000000000:512",
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "body was {body}");
    assert_eq!(body["ok"], json!(false));

    // A malformed cursor is a 400, not a silent full re-read.
    let (status, _) = get(
        &h.app,
        "/api/sessions/chat-hist/chat/history?before=garbage",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    h.cleanup();
}

#[tokio::test]
async fn fetch_full_resolves_a_truncated_entry_by_uuid_over_http() {
    let _g = ENV_LOCK.lock().await;
    let h = spawn_harness().await;
    let conv = "99999999-9999-9999-9999-999999999999";
    let big = "q".repeat(64 * 1024);
    write_transcript(
        &h.project_dir(),
        conv,
        &[user_line("small", "hi"), user_line("big", &big)],
    );
    make_session(&h, "chat-full", "claude", None).await;
    db::sessions::track_cc_conversation_id(&h.state.pool, "chat-full", conv)
        .await
        .unwrap();

    let (status, body) = get(&h.app, "/api/sessions/chat-full/chat/entry/big").await;
    assert_eq!(status, StatusCode::OK, "body was {body}");
    assert_eq!(body["data"]["uuid"], json!("big"));
    assert_eq!(
        body["data"]["body"]["text"].as_str().map(str::len),
        Some(64 * 1024),
        "fetch-full is the escape hatch for a truncated entry"
    );

    let (status, _) = get(&h.app, "/api/sessions/chat-full/chat/entry/nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    h.cleanup();
}
