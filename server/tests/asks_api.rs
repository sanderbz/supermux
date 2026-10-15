//! The asks API end to end, over a REAL socket: the decision hook is a
//! long-poll, and the behaviour that matters (an answer arriving while it
//! waits, the hook hanging up, the hold lapsing) only exists on a live
//! connection.
//!
//! Payloads are the shapes Claude Code 2.1.300 sent in a scratch session.

use std::time::Duration;

use serde_json::{json, Value};
use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

const BEARER: &str = "asks-test-bearer";
const TOKEN: &str = "asks-test-hook-token";
const SESSION: &str = "worker";

struct Rig {
    state: AppState,
    url: String,
    http: reqwest::Client,
    _task: tokio::task::JoinHandle<()>,
}

async fn rig_with(config_toml: &str) -> Rig {
    let dir = std::env::temp_dir().join(format!("supermux-asks-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("config.toml"), config_toml).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: BEARER.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        swarm_reaper: Default::default(),
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
    db::sessions::insert_minimal(&state.pool, SESSION, "/tmp", "claude")
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, SESSION, TOKEN)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = http::router(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Rig {
        state,
        url,
        http: reqwest::Client::new(),
        _task: task,
    }
}

async fn rig() -> Rig {
    rig_with("[asks]\nhook_grace_ms = 300\n").await
}

impl Rig {
    /// What Claude Code's decision hook does in an attended (interactive)
    /// session: stream the payload, read the body.
    fn decide(&self, event: &str, payload: Value) -> tokio::task::JoinHandle<(u16, String)> {
        self.decide_with(event, payload, "attempt=0&attended=1")
    }

    /// The same, with explicit query flags (`attempt`, `attended`).
    fn decide_with(
        &self,
        event: &str,
        payload: Value,
        flags: &str,
    ) -> tokio::task::JoinHandle<(u16, String)> {
        let req = self
            .http
            .post(format!(
                "{}/api/_internal/ask?event={event}&{flags}",
                self.url
            ))
            .header("Content-Type", "application/json")
            .header("X-Supermux-Hook-Token", TOKEN)
            .header("X-Supermux-Session", SESSION)
            .header("X-Supermux-Pane", "%1")
            .body(payload.to_string());
        tokio::spawn(async move {
            let r = req.send().await.expect("decide request");
            let code = r.status().as_u16();
            (code, r.text().await.unwrap_or_default())
        })
    }

    /// What the observe-only hook does.
    async fn observe(&self, event: &str, payload: Value) {
        let r = self
            .http
            .post(format!("{}/api/_internal/hook", self.url))
            .header("Content-Type", "application/json")
            .header("X-Supermux-Hook-Token", TOKEN)
            .body(
                json!({ "session": SESSION, "event": event, "pane": "%1", "payload": payload })
                    .to_string(),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let r = self
            .http
            .get(format!("{}{path}", self.url))
            .bearer_auth(BEARER)
            .send()
            .await
            .unwrap();
        let code = r.status().as_u16();
        (code, r.json().await.unwrap_or(Value::Null))
    }

    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        let r = self
            .http
            .post(format!("{}{path}", self.url))
            .bearer_auth(BEARER)
            .json(&body)
            .send()
            .await
            .unwrap();
        let code = r.status().as_u16();
        (code, r.json().await.unwrap_or(Value::Null))
    }

    async fn patch(&self, path: &str, body: Value) -> (u16, Value) {
        let r = self
            .http
            .patch(format!("{}{path}", self.url))
            .bearer_auth(BEARER)
            .json(&body)
            .send()
            .await
            .unwrap();
        let code = r.status().as_u16();
        (code, r.json().await.unwrap_or(Value::Null))
    }

    /// `supermux-task needs-input "<question>"` from `session`.
    async fn needs_input(&self, session: &str, token: &str, question: &str) {
        let resp = self
            .http
            .post(format!("{}/api/hook/board/needs-input", self.url))
            .header("Content-Type", "application/json")
            .header("X-Supermux-Hook-Token", token)
            .body(json!({ "session": session, "question": question }).to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
    }

    async fn add_session(&self, name: &str, token: &str) {
        db::sessions::insert_minimal(&self.state.pool, name, "/tmp", "claude")
            .await
            .unwrap();
        db::sessions::ensure_runtime(&self.state.pool, name, token)
            .await
            .unwrap();
    }

    async fn add_card(&self, id: &str, session: &str) {
        db::board::insert_issue(
            &self.state.pool,
            &db::board::NewIssue {
                id: id.into(),
                title: "ship it".into(),
                desc: String::new(),
                status: "doing".into(),
                session: Some(session.to_string()),
                creator: String::new(),
                due: None,
                due_time: None,
                owner_type: "agent".into(),
                pos: 0.0,
                notified: 0,
                board_id: "main".into(),
                team_task_id: None,
            },
        )
        .await
        .unwrap();
    }

    async fn open_asks(&self) -> Vec<Value> {
        let (code, v) = self.get("/api/asks").await;
        assert_eq!(code, 200, "{v}");
        v["data"]["asks"].as_array().cloned().unwrap_or_default()
    }

    /// Poll until exactly `n` open asks exist that satisfy `pred`.
    async fn wait_open(&self, n: usize, pred: impl Fn(&Value) -> bool) -> Vec<Value> {
        for _ in 0..100 {
            let asks: Vec<Value> = self
                .open_asks()
                .await
                .into_iter()
                .filter(|a| pred(a))
                .collect();
            if asks.len() == n {
                return asks;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!(
            "never saw {n} matching open asks: {:?}",
            self.open_asks().await
        );
    }

    async fn ask(&self, id: &str) -> Value {
        let (code, v) = self.get(&format!("/api/asks/{id}")).await;
        assert_eq!(code, 200, "{v}");
        v["data"].clone()
    }
}

fn bash_permission(cmd: &str) -> Value {
    json!({
        "session_id": "cc-1", "hook_event_name": "PermissionRequest", "permission_mode": "default",
        "tool_name": "Bash",
        "tool_input": { "command": cmd, "description": "Run the next step" },
        "permission_suggestions": [
            { "type": "addDirectories", "directories": ["/w"], "destination": "session" },
            { "type": "setMode", "mode": "acceptEdits", "destination": "session" }
        ]
    })
}

fn question_input() -> Value {
    json!({ "questions": [
        { "question": "Which fruits do you like?", "header": "Fruits", "multiSelect": true,
          "options": [ {"label":"Apple","description":"Apple"}, {"label":"Banana","description":"Banana"}, {"label":"Cherry","description":"Cherry"} ] },
        { "question": "Which color?", "header": "Color", "multiSelect": false,
          "options": [ {"label":"Red","description":"Red"}, {"label":"Green","description":"Green"} ] }
    ]})
}

#[tokio::test]
async fn a_permission_is_answered_through_the_waiting_hook() {
    let r = rig().await;
    let hook = r.decide("permission_request", bash_permission("touch probe1.txt"));
    let asks = r.wait_open(1, |a| a["answerable"] == json!(true)).await;
    let a = &asks[0];
    assert_eq!(a["kind"], json!("permission"));
    assert_eq!(a["session"], json!(SESSION));
    assert_eq!(a["detail"]["tool"], json!("Bash"));
    assert_eq!(a["detail"]["summary"], json!("⚡ Run the next step"));
    // The real command is visible LIVE, so a human approves what will run…
    assert_eq!(
        a["input"]["tool_input"]["command"],
        json!("touch probe1.txt")
    );
    assert_eq!(
        a["input"]["permission_suggestions"][0]["type"],
        json!("addDirectories")
    );
    // …but it is not what gets persisted.
    let row = db::asks::get(&r.state.pool, a["id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert!(!row.detail.contains("touch probe1.txt"), "{}", row.detail);

    let id = a["id"].as_str().unwrap().to_string();
    let (code, v) = r
        .post(
            &format!("/api/asks/{id}/answer"),
            json!({ "decision": "allow", "permissions": [0], "client": "phone" }),
        )
        .await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["data"]["state"], json!("answered"));
    assert_eq!(v["data"]["resolution"]["by"], json!("api"));
    assert_eq!(v["data"]["resolution"]["client"], json!("phone"));

    let (code, body) = hook.await.unwrap();
    assert_eq!(code, 200);
    let out: Value = serde_json::from_str(&body).expect("the hook prints a JSON decision");
    assert_eq!(
        out["hookSpecificOutput"]["hookEventName"],
        json!("PermissionRequest")
    );
    assert_eq!(
        out["hookSpecificOutput"]["decision"]["behavior"],
        json!("allow")
    );
    assert_eq!(
        out["hookSpecificOutput"]["decision"]["updatedPermissions"][0]["type"],
        json!("addDirectories")
    );

    // A second answer is a clean conflict, not a second decision.
    let (code, v) = r
        .post(
            &format!("/api/asks/{id}/answer"),
            json!({ "decision": "deny" }),
        )
        .await;
    assert_eq!(code, 409, "{v}");
    assert!(r.open_asks().await.is_empty());
}

#[tokio::test]
async fn a_multi_select_question_is_answered_with_labels() {
    let r = rig().await;
    // Claude raises the PreToolUse (observe hook) ~20ms before the PermissionRequest
    // (decision hook) for the same call: ONE ask, not two.
    r.observe(
        "pre_tool",
        json!({ "hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_use_id": "toolu_q1", "tool_input": question_input() }),
    )
    .await;
    let hook = r.decide(
        "permission_request",
        json!({ "hook_event_name": "PermissionRequest", "tool_name": "AskUserQuestion", "permission_mode": "default", "tool_input": question_input() }),
    );
    let asks = r.wait_open(1, |a| a["answerable"] == json!(true)).await;
    assert_eq!(
        r.open_asks().await.len(),
        1,
        "the two hooks of one call share one ask"
    );
    let a = &asks[0];
    assert_eq!(a["kind"], json!("question"));
    assert_eq!(a["detail"]["questions"].as_array().unwrap().len(), 2);
    assert_eq!(a["detail"]["questions"][0]["multi_select"], json!(true));
    let id = a["id"].as_str().unwrap().to_string();

    // A typo is refused; the hook keeps waiting.
    let (code, _) = r
        .post(
            &format!("/api/asks/{id}/answer"),
            json!({ "answers": { "0": ["Aple"], "1": "Red" } }),
        )
        .await;
    assert_eq!(code, 400);
    assert_eq!(r.ask(&id).await["answerable"], json!(true));

    let (code, v) = r
        .post(&format!("/api/asks/{id}/answer"), json!({ "answers": { "Which fruits do you like?": ["Cherry", "Apple"], "1": "Green" } }))
        .await;
    assert_eq!(code, 200, "{v}");
    let (_, body) = hook.await.unwrap();
    let out: Value = serde_json::from_str(&body).unwrap();
    let input = &out["hookSpecificOutput"]["decision"]["updatedInput"];
    assert_eq!(
        input["answers"]["Which fruits do you like?"],
        json!("Apple, Cherry")
    );
    assert_eq!(input["answers"]["Which color?"], json!("Green"));
    assert_eq!(input["questions"][1]["header"], json!("Color"));
}

#[tokio::test]
async fn an_answer_at_the_terminal_releases_the_hook_and_resolves_the_ask() {
    let r = rig().await;
    let payload = bash_permission("ls");
    // Every real hook payload carries Claude's session_id (part of the key).
    r.observe("pre_tool", json!({ "session_id": "cc-1", "tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": payload["tool_input"] }))
        .await;
    let hook = r.decide("permission_request", payload.clone());
    let id = r.wait_open(1, |a| a["answerable"] == json!(true)).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    // A parallel Bash call finishing does NOT close this pending one.
    r.observe("post_tool", json!({ "session_id": "cc-1", "tool_name": "Bash", "tool_use_id": "toolu_0", "tool_input": { "command": "pwd" } }))
        .await;
    assert_eq!(r.ask(&id).await["state"], json!("open"));
    // The human pressed "Yes" in the terminal: the tool ran.
    r.observe("post_tool", json!({ "session_id": "cc-1", "tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": payload["tool_input"] }))
        .await;
    let (code, body) = tokio::time::timeout(Duration::from_secs(5), hook)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (code, body.as_str()),
        (200, ""),
        "released with NO decision"
    );
    let a = r.ask(&id).await;
    assert_eq!(a["state"], json!("resolved"));
    assert_eq!(a["resolution"]["by"], json!("terminal"));
    assert_eq!(a["resolution"]["outcome"], json!("tool_ran"));
}

#[tokio::test]
async fn a_hook_that_hangs_up_cancels_its_ask_after_the_grace() {
    let r = rig().await;
    let hook = r.decide("permission_request", bash_permission("rm -rf build"));
    let id = r.wait_open(1, |a| a["answerable"] == json!(true)).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    // Claude Code kills the hook when the human says "No" (interrupt).
    hook.abort();
    let mut state = Value::Null;
    for _ in 0..60 {
        let a = r.ask(&id).await;
        if a["state"] != json!("open") {
            state = a;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(state["state"], json!("resolved"), "{state}");
    assert_eq!(state["resolution"]["by"], json!("hook"));
    assert_eq!(state["resolution"]["outcome"], json!("cancelled"));
}

#[tokio::test]
async fn a_reconnecting_hook_keeps_its_ask() {
    let r = rig_with("[asks]\nhook_grace_ms = 2000\n").await;
    let payload = bash_permission("make deploy");
    let first = r.decide("permission_request", payload.clone());
    let id = r.wait_open(1, |a| a["answerable"] == json!(true)).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    first.abort();
    tokio::time::sleep(Duration::from_millis(200)).await;
    // The retry (same payload) lands on the SAME ask.
    let second = r.decide("permission_request", payload);
    let again = r.wait_open(1, |a| a["answerable"] == json!(true)).await;
    assert_eq!(again[0]["id"], json!(id));
    tokio::time::sleep(Duration::from_millis(2300)).await;
    assert_eq!(
        r.ask(&id).await["state"],
        json!("open"),
        "the grace check must see the new waiter"
    );
    let (code, _) = r
        .post(
            &format!("/api/asks/{id}/answer"),
            json!({ "decision": "deny", "message": "no" }),
        )
        .await;
    assert_eq!(code, 200);
    let (_, body) = second.await.unwrap();
    assert!(body.contains("\"deny\""), "{body}");
}

#[tokio::test]
async fn the_hold_lapses_into_an_unanswerable_but_open_ask() {
    let r = rig_with("[asks]\nhold_secs = 1\n").await;
    let hook = r.decide("permission_request", bash_permission("echo hi"));
    let (code, body) = tokio::time::timeout(Duration::from_secs(5), hook)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((code, body.as_str()), (200, ""));
    let asks = r.wait_open(1, |a| a["answerable"] == json!(false)).await;
    let id = asks[0]["id"].as_str().unwrap();
    let (code, v) = r
        .post(
            &format!("/api/asks/{id}/answer"),
            json!({ "decision": "allow" }),
        )
        .await;
    assert_eq!(code, 409);
    assert!(
        v["error"]
            .as_str()
            .unwrap_or_default()
            .contains("ask_not_answerable"),
        "{v}"
    );
}

#[tokio::test]
async fn a_legacy_observe_hook_still_records_the_ask() {
    // A session whose settings.json predates the decision hook: the ask is
    // recorded and listed, but cannot be answered through the API.
    let r = rig().await;
    r.observe("permission_request", bash_permission("cargo test"))
        .await;
    let asks = r.wait_open(1, |_| true).await;
    assert_eq!(asks[0]["answerable"], json!(false));
    // The turn ending resolves it.
    r.observe("stop", json!({ "hook_event_name": "Stop" }))
        .await;
    assert!(r.open_asks().await.is_empty());
}

#[tokio::test]
async fn waiting_notifications_are_asks_and_a_new_prompt_resolves_them() {
    let r = rig().await;
    r.observe("notification", json!({ "notification_type": "idle_prompt", "message": "Claude is waiting for your input" }))
        .await;
    r.observe("notification", json!({ "notification_type": "idle_prompt", "message": "Claude is waiting for your input" }))
        .await;
    let asks = r.wait_open(1, |_| true).await;
    assert_eq!(asks[0]["kind"], json!("waiting"));
    assert_eq!(asks[0]["detail"]["notification_type"], json!("idle_prompt"));
    assert_eq!(asks[0]["answerable"], json!(true));
    r.observe(
        "user_prompt",
        json!({ "hook_event_name": "UserPromptSubmit", "prompt": "go on" }),
    )
    .await;
    assert!(r.open_asks().await.is_empty());
    // An auth_success notification is not an ask.
    r.observe(
        "notification",
        json!({ "notification_type": "auth_success", "message": "ok" }),
    )
    .await;
    assert!(r.open_asks().await.is_empty());
}

#[tokio::test]
async fn a_permission_prompt_notification_does_not_duplicate_the_dialog() {
    let r = rig().await;
    let hook = r.decide("permission_request", bash_permission("npm publish"));
    r.wait_open(1, |a| a["kind"] == json!("permission")).await;
    r.observe("notification", json!({ "notification_type": "permission_prompt", "message": "Claude needs your permission" }))
        .await;
    assert_eq!(r.open_asks().await.len(), 1);
    hook.abort();
}

#[tokio::test]
async fn since_replays_every_change_in_rev_order() {
    let r = rig().await;
    let (_, v) = r.get("/api/asks?since=0").await;
    let start = v["data"]["rev"].as_i64().unwrap();
    r.observe(
        "notification",
        json!({ "notification_type": "agent_needs_input", "message": "Pick a target" }),
    )
    .await;
    let id = r.wait_open(1, |_| true).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (code, v) = r
        .post(
            &format!("/api/asks/{id}/dismiss"),
            json!({ "client": "watch" }),
        )
        .await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["data"]["state"], json!("dismissed"));

    let (_, v) = r.get(&format!("/api/asks?since={start}")).await;
    let changes = v["data"]["asks"].as_array().unwrap();
    // The row's newest state, once (it is a snapshot feed, keyed by id).
    assert_eq!(changes.len(), 1, "{v}");
    assert_eq!(changes[0]["state"], json!("dismissed"));
    let end = v["data"]["rev"].as_i64().unwrap();
    assert!(end > start);
    let (_, v) = r.get(&format!("/api/asks?since={end}")).await;
    assert!(v["data"]["asks"].as_array().unwrap().is_empty());

    // Filters are validated.
    assert_eq!(r.get("/api/asks?state=bogus").await.0, 400);
    assert_eq!(r.get("/api/asks?kind=bogus").await.0, 400);
    assert_eq!(r.get("/api/asks/ask_nope").await.0, 404);
}

#[tokio::test]
async fn the_asks_api_needs_the_bearer_and_the_hook_needs_the_hook_token() {
    let r = rig().await;
    let unauth = r
        .http
        .get(format!("{}/api/asks", r.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), 401);
    let wrong = r
        .http
        .post(format!(
            "{}/api/_internal/ask?event=permission_request",
            r.url
        ))
        .header("X-Supermux-Hook-Token", "not-the-token")
        .header("X-Supermux-Session", SESSION)
        .body(bash_permission("x").to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 401);
    // The dashboard bearer is not a hook token.
    let bearer = r
        .http
        .post(format!(
            "{}/api/_internal/ask?event=permission_request",
            r.url
        ))
        .header("X-Supermux-Hook-Token", BEARER)
        .header("X-Supermux-Session", SESSION)
        .body(bash_permission("x").to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(bearer.status(), 401);
    assert!(r.open_asks().await.is_empty());
}

#[tokio::test]
async fn asks_survive_a_restart_and_lose_only_their_hook() {
    let r = rig().await;
    let hook = r.decide("permission_request", bash_permission("terraform apply"));
    let id = r.wait_open(1, |a| a["answerable"] == json!(true)).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    hook.abort();
    // The boot task of a fresh process: every attachment is from the old run.
    let n = db::asks::detach_all(&r.state.pool, chrono::Utc::now().timestamp_millis())
        .await
        .unwrap();
    assert!(n <= 1);
    let row = db::asks::get(&r.state.pool, &id).await.unwrap().unwrap();
    assert_eq!(row.hook_attached, 0);
    assert!(row.state == "open" || row.state == "resolved");
}

fn elicitation_payload() -> Value {
    json!({
        "hook_event_name": "Elicitation", "mcp_server_name": "probe-form", "message": "Confirm the release",
        "mode": "form", "elicitation_id": "el_1",
        "requested_schema": { "type": "object", "required": ["approver", "env"], "properties": {
            "approver": { "type": "string", "title": "Approver" },
            "env": { "type": "string", "enum": ["prod", "staging"] } } }
    })
}

#[tokio::test]
async fn an_mcp_form_is_answered_when_the_operator_opted_in() {
    let r = rig_with("[asks]\nelicitation_hold_secs = 30\nhook_grace_ms = 300\n").await;
    let hook = r.decide("elicitation", elicitation_payload());
    let asks = r.wait_open(1, |a| a["answerable"] == json!(true)).await;
    assert_eq!(asks[0]["kind"], json!("elicitation"));
    assert_eq!(asks[0]["detail"]["server"], json!("probe-form"));
    let id = asks[0]["id"].as_str().unwrap().to_string();
    let (code, _) = r
        .post(
            &format!("/api/asks/{id}/answer"),
            json!({ "action": "accept", "content": { "approver": "ops", "env": "qa" } }),
        )
        .await;
    assert_eq!(code, 400, "an out-of-list enum value is refused");
    let (code, v) = r
        .post(
            &format!("/api/asks/{id}/answer"),
            json!({ "action": "accept", "content": { "approver": "ops", "env": "staging" } }),
        )
        .await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["data"]["resolution"]["outcome"], json!("accept"));
    let (_, body) = hook.await.unwrap();
    let out: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        out,
        json!({ "hookSpecificOutput": { "hookEventName": "Elicitation", "action": "accept", "content": { "approver": "ops", "env": "staging" } } })
    );
}

#[tokio::test]
async fn by_default_an_mcp_form_is_recorded_but_left_to_the_terminal() {
    // Claude Code draws the form only after the Elicitation hook returns, so
    // by default the hook must return at once.
    let r = rig().await;
    let hook = r.decide("elicitation", elicitation_payload());
    let (code, body) = tokio::time::timeout(Duration::from_secs(3), hook)
        .await
        .expect("returns at once")
        .unwrap();
    assert_eq!((code, body.as_str()), (200, ""));
    let asks = r.wait_open(1, |_| true).await;
    assert_eq!(asks[0]["answerable"], json!(false));
    r.observe(
        "elicitation_result",
        json!({ "mcp_server_name": "probe-form", "action": "decline", "elicitation_id": "el_1" }),
    )
    .await;
    let a = r.ask(asks[0]["id"].as_str().unwrap()).await;
    assert_eq!(a["state"], json!("resolved"));
    assert_eq!(a["resolution"]["by"], json!("terminal"));
    assert_eq!(a["resolution"]["outcome"], json!("decline"));
}

#[tokio::test]
async fn a_board_needs_input_is_an_ask() {
    let r = rig().await;
    db::board::insert_issue(
        &r.state.pool,
        &db::board::NewIssue {
            id: "T-1".into(),
            title: "ship it".into(),
            desc: String::new(),
            status: "doing".into(),
            session: Some(SESSION.to_string()),
            creator: String::new(),
            due: None,
            due_time: None,
            owner_type: "agent".into(),
            pos: 0.0,
            notified: 0,
            board_id: "main".into(),
            team_task_id: None,
        },
    )
    .await
    .unwrap();
    let resp = r
        .http
        .post(format!("{}/api/hook/board/needs-input", r.url))
        .header("Content-Type", "application/json")
        .header("X-Supermux-Hook-Token", TOKEN)
        .body(json!({ "session": SESSION, "question": "Which region: eu or us?" }).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let asks = r.wait_open(1, |_| true).await;
    assert_eq!(asks[0]["kind"], json!("needs_input"));
    assert_eq!(asks[0]["issue_id"], json!("T-1"));
    assert_eq!(
        asks[0]["detail"]["question"],
        json!("Which region: eu or us?")
    );
    assert_eq!(asks[0]["answerable"], json!(true));
    // A text answer is required.
    let id = asks[0]["id"].as_str().unwrap().to_string();
    let (code, _) = r
        .post(
            &format!("/api/asks/{id}/answer"),
            json!({ "decision": "allow" }),
        )
        .await;
    assert_eq!(code, 400);
    // The agent raises needs-input MID-TURN: its tool finishing and the turn
    // ending must not close the question (found live: the Waiting→Active edge
    // of that same turn used to close it).
    r.observe(
        "post_tool",
        json!({ "tool_name": "Bash", "tool_input": { "command": "supermux-task needs-input" } }),
    )
    .await;
    r.observe("stop", json!({ "hook_event_name": "Stop" }))
        .await;
    assert_eq!(r.ask(&id).await["state"], json!("open"));
    // A new prompt is not necessarily the answer (a teammate's FYI, a scheduled
    // prompt): the ask follows the CARD, which still says "needs your input".
    r.observe(
        "user_prompt",
        json!({ "hook_event_name": "UserPromptSubmit", "prompt": "FYI from a teammate: CI is green" }),
    )
    .await;
    let a = r.ask(&id).await;
    assert_eq!(a["state"], json!("open"), "{a}");
    assert_eq!(a["answerable"], json!(true));
    // The human answering on the board closes it (and clears the card).
    db::board::patch_issue(
        &r.state.pool,
        "T-1",
        &[db::board::IssueField::AwaitingInput(0)],
    )
    .await
    .unwrap();
    supermux_server::asks::sync_needs_input(&r.state, "T-1", "board", "input_cleared").await;
    let a = r.ask(&id).await;
    assert_eq!(a["state"], json!("resolved"));
    assert_eq!(a["resolution"]["outcome"], json!("input_cleared"));

    // A second question on the card, then the agent finishes the card.
    let resp = r
        .http
        .post(format!("{}/api/hook/board/needs-input", r.url))
        .header("Content-Type", "application/json")
        .header("X-Supermux-Hook-Token", TOKEN)
        .body(json!({ "session": SESSION, "question": "Tag the release?" }).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let id2 = r.wait_open(1, |_| true).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(
        id2, id,
        "a new question after the first was resolved is a new ask"
    );
    let resp = r
        .http
        .post(format!("{}/api/hook/board/status", r.url))
        .header("Content-Type", "application/json")
        .header("X-Supermux-Hook-Token", TOKEN)
        .body(json!({ "session": SESSION, "status": "done" }).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(
        r.ask(&id2).await["resolution"]["outcome"],
        json!("issue_done")
    );
}

// ── review fixes ─────────────────────────────────────────────────────────────

/// A headless `claude -p` (or an SDK run) inside a supermux pane inherits the
/// pane's hook env, so its PermissionRequest reaches the decision endpoint. It
/// cannot show a dialog: waiting would hang it for up to `hold_secs` where
/// Claude would otherwise deny at once. It gets "no decision" immediately and
/// no ask.
#[tokio::test]
async fn an_unattended_request_gets_no_decision_at_once_and_no_ask() {
    let r = rig().await;
    for flags in [
        // `claude -p` on Claude Code 2.1.300.
        "attempt=0&attended=0&entry=other",
        // A hook command written before the attended flag existed.
        "attempt=0",
        // A Claude Code that exports neither variable and is not the CLI.
        "attempt=0&attended=&entry=other",
    ] {
        let hook = r.decide_with("permission_request", bash_permission("make ci"), flags);
        let (code, body) = tokio::time::timeout(Duration::from_secs(3), hook)
            .await
            .unwrap_or_else(|_| panic!("{flags}: must not wait"))
            .unwrap();
        assert_eq!((code, body.as_str()), (200, ""), "{flags}");
        let (_, v) = r.get("/api/asks?state=all").await;
        assert!(
            v["data"]["asks"].as_array().unwrap().is_empty(),
            "{flags}: an unattended request is not an ask: {v}"
        );
    }
    // The CLI entrypoint alone (a Claude Code without the attended variable)
    // counts as attended.
    let hook = r.decide_with(
        "permission_request",
        bash_permission("make ci"),
        "attempt=0&attended=&entry=cli",
    );
    let asks = r.wait_open(1, |a| a["answerable"] == json!(true)).await;
    assert!(!hook.is_finished());
    hook.abort();
    let _ = asks;
}

/// The lead and an in-process teammate (own Claude session id, the lead's pane
/// token) asking the very same command are two pending requests: two asks, two
/// hooks, and neither one's PostToolUse closes the other's.
#[tokio::test]
async fn the_same_command_from_the_lead_and_a_teammate_are_two_asks() {
    let r = rig().await;
    let mut lead_p = bash_permission("npm test");
    lead_p["session_id"] = json!("cc-lead");
    let mut mate_p = bash_permission("npm test");
    mate_p["session_id"] = json!("cc-mate");
    mate_p["agent_type"] = json!("general-purpose");
    let lead = r.decide("permission_request", lead_p.clone());
    let mate = r.decide("permission_request", mate_p.clone());
    let asks = r.wait_open(2, |a| a["answerable"] == json!(true)).await;
    assert!(
        !lead.is_finished(),
        "the teammate's request must not release the lead's hook"
    );
    let lead_id = asks
        .iter()
        .find(|a| a["detail"].get("agent_type").is_none())
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    // The teammate's call finishing does not touch the lead's ask.
    r.observe(
        "post_tool",
        json!({ "session_id": "cc-mate", "agent_type": "general-purpose", "tool_name": "Bash",
                "tool_use_id": "toolu_mate", "tool_input": mate_p["tool_input"] }),
    )
    .await;
    let mate_body = tokio::time::timeout(Duration::from_secs(3), mate)
        .await
        .unwrap()
        .unwrap()
        .1;
    assert_eq!(
        mate_body, "",
        "the teammate's hook is released with no decision"
    );
    let a = r.ask(&lead_id).await;
    assert_eq!(a["state"], json!("open"), "{a}");
    assert_eq!(a["answerable"], json!(true));
    // And an answer reaches exactly the lead's hook.
    let (code, v) = r
        .post(
            &format!("/api/asks/{lead_id}/answer"),
            json!({ "decision": "allow" }),
        )
        .await;
    assert_eq!(code, 200, "{v}");
    let (_, body) = lead.await.unwrap();
    assert!(body.contains("\"allow\""), "{body}");
}

/// The terminal answered "Yes" first; the hook stays connected while the tool
/// runs, so an API "deny" in that window is delivered (200) but cannot take
/// effect. The call's PostToolUse proves it ran: the ask is corrected to
/// `resolved` / `terminal` / `tool_ran`, keeping the API answer as
/// `overridden`, and `since` replays the correction.
#[tokio::test]
async fn a_deny_delivered_after_the_terminal_said_yes_is_corrected_when_the_tool_finishes() {
    let r = rig().await;
    let payload = bash_permission("python3 long_job.py");
    r.observe(
        "pre_tool",
        json!({ "session_id": "cc-1", "tool_name": "Bash", "tool_use_id": "toolu_9", "tool_input": payload["tool_input"] }),
    )
    .await;
    let hook = r.decide("permission_request", payload.clone());
    let id = r.wait_open(1, |a| a["answerable"] == json!(true)).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (code, v) = r
        .post(
            &format!("/api/asks/{id}/answer"),
            json!({ "decision": "deny", "message": "do not run this", "client": "phone" }),
        )
        .await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["data"]["state"], json!("answered"));
    let rev_after_answer = v["data"]["rev"].as_i64().unwrap();
    let (_, body) = hook.await.unwrap();
    assert!(body.contains("\"deny\""), "delivered: {body}");
    // …but the tool ran anyway (Claude took the terminal's "Yes").
    r.observe(
        "post_tool",
        json!({ "session_id": "cc-1", "tool_name": "Bash", "tool_use_id": "toolu_9",
                "tool_input": payload["tool_input"], "tool_response": { "stdout": "1" } }),
    )
    .await;
    let a = r.ask(&id).await;
    assert_eq!(a["state"], json!("resolved"), "{a}");
    assert_eq!(a["resolution"]["by"], json!("terminal"));
    assert_eq!(a["resolution"]["outcome"], json!("tool_ran"));
    assert_eq!(a["resolution"]["overridden"]["outcome"], json!("deny"));
    assert_eq!(a["resolution"]["overridden"]["client"], json!("phone"));
    let (_, v) = r.get(&format!("/api/asks?since={rev_after_answer}")).await;
    let changes = v["data"]["asks"].as_array().unwrap();
    assert_eq!(changes.len(), 1, "{v}");
    assert_eq!(changes[0]["state"], json!("resolved"));

    // A deny that DID take effect has no PostToolUse: it stays answered. And an
    // allow followed by its PostToolUse is simply what happened.
    let p2 = bash_permission("rm -rf build");
    r.observe(
        "pre_tool",
        json!({ "session_id": "cc-1", "tool_name": "Bash", "tool_use_id": "toolu_10", "tool_input": p2["tool_input"] }),
    )
    .await;
    let hook = r.decide("permission_request", p2.clone());
    let id2 = r.wait_open(1, |a| a["answerable"] == json!(true)).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (code, _) = r
        .post(
            &format!("/api/asks/{id2}/answer"),
            json!({ "decision": "allow" }),
        )
        .await;
    assert_eq!(code, 200);
    let _ = hook.await;
    r.observe(
        "post_tool",
        json!({ "session_id": "cc-1", "tool_name": "Bash", "tool_use_id": "toolu_10", "tool_input": p2["tool_input"] }),
    )
    .await;
    let a = r.ask(&id2).await;
    assert_eq!(a["state"], json!("answered"), "{a}");
    assert_eq!(a["resolution"]["outcome"], json!("allow"));
}

/// The same for a question: answers delivered through the API but a different
/// choice made at the terminal first → the finished call carries the
/// terminal's answers, and the ask is corrected. The API's own answers
/// arriving in the PostToolUse leave it answered.
#[tokio::test]
async fn a_question_answered_at_the_terminal_first_is_corrected() {
    let r = rig().await;
    for (terminal_won, tid) in [(true, "toolu_q7"), (false, "toolu_q8")] {
        let mut input = question_input();
        // A different call each round (the key hashes the input).
        input["questions"][1]["question"] = json!(format!("Which color ({tid})?"));
        r.observe(
            "pre_tool",
            json!({ "hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_use_id": tid, "tool_input": input }),
        )
        .await;
        let hook = r.decide(
            "permission_request",
            json!({ "hook_event_name": "PermissionRequest", "tool_name": "AskUserQuestion", "permission_mode": "default", "tool_input": input }),
        );
        let id = r.wait_open(1, |a| a["answerable"] == json!(true)).await[0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let (code, v) = r
            .post(
                &format!("/api/asks/{id}/answer"),
                json!({ "answers": { "0": ["Apple"], "1": "Red" } }),
            )
            .await;
        assert_eq!(code, 200, "{v}");
        let (_, body) = hook.await.unwrap();
        let sent: Value = serde_json::from_str(&body).unwrap();
        let mut finished = input.clone();
        finished["answers"] = if terminal_won {
            json!({ "Which fruits do you like?": "Banana", (format!("Which color ({tid})?")): "Green" })
        } else {
            sent["hookSpecificOutput"]["decision"]["updatedInput"]["answers"].clone()
        };
        r.observe(
            "post_tool",
            json!({ "tool_name": "AskUserQuestion", "tool_use_id": tid, "tool_input": finished }),
        )
        .await;
        let a = r.ask(&id).await;
        if terminal_won {
            assert_eq!(a["state"], json!("resolved"), "{a}");
            assert_eq!(a["resolution"]["by"], json!("terminal"));
            assert_eq!(a["resolution"]["overridden"]["outcome"], json!("answer"));
        } else {
            assert_eq!(a["state"], json!("answered"), "{a}");
        }
    }
}

/// An ask id names ONE question. A second needs-input on the card closes the
/// first as superseded (naming its successor) and opens a new ask; an answer
/// addressed to the old id is refused.
#[tokio::test]
async fn a_changed_question_is_a_new_ask_and_the_old_id_is_refused() {
    let r = rig().await;
    r.add_card("T-9", SESSION).await;
    r.needs_input(SESSION, TOKEN, "Drop the prod table? reply yes/no")
        .await;
    let first = r.wait_open(1, |_| true).await[0].clone();
    r.needs_input(SESSION, TOKEN, "Also delete all backups? reply yes/no")
        .await;
    let second = r.wait_open(1, |_| true).await[0].clone();
    assert_ne!(first["id"], second["id"]);
    assert_eq!(
        second["detail"]["question"],
        json!("Also delete all backups? reply yes/no")
    );
    let old = r.ask(first["id"].as_str().unwrap()).await;
    assert_eq!(old["state"], json!("resolved"));
    assert_eq!(old["resolution"]["outcome"], json!("superseded"));
    assert_eq!(old["resolution"]["superseded_by"], second["id"]);
    let (code, v) = r
        .post(
            &format!("/api/asks/{}/answer", first["id"].as_str().unwrap()),
            json!({ "text": "yes" }),
        )
        .await;
    assert_eq!(code, 409, "{v}");
    // The same question raised again is the same ask.
    r.needs_input(SESSION, TOKEN, "Also delete all backups? reply yes/no")
        .await;
    assert_eq!(r.wait_open(1, |_| true).await[0]["id"], second["id"]);

    // A needs-you notification with a new message: a new ask too.
    r.observe("notification", json!({ "notification_type": "agent_needs_input", "message": "Which database should I wipe?" }))
        .await;
    let w1 = r.wait_open(1, |a| a["kind"] == json!("waiting")).await[0]["id"].clone();
    r.observe("notification", json!({ "notification_type": "idle_prompt", "message": "Claude is waiting for your input" }))
        .await;
    let w2 = r.wait_open(1, |a| a["kind"] == json!("waiting")).await[0]["id"].clone();
    assert_ne!(w1, w2);
}

/// A re-raised dialog for the same call that offers OTHER "always allow"
/// choices is a new ask: `permissions: [0]` sent for the old id can never
/// apply an update the client did not see.
#[tokio::test]
async fn a_dialog_offering_other_choices_is_a_new_ask() {
    let r = rig().await;
    let first_hook = r.decide("permission_request", bash_permission("make deploy"));
    let seen = r.wait_open(1, |a| a["answerable"] == json!(true)).await[0].clone();
    assert_eq!(
        seen["input"]["permission_suggestions"][0]["type"],
        json!("addDirectories")
    );
    let mut p2 = bash_permission("make deploy");
    p2["permission_suggestions"] = json!([{ "type": "addRules", "rules": [{"toolName": "Bash"}], "behavior": "allow", "destination": "userSettings" }]);
    let second_hook = r.decide("permission_request", p2);
    let now = r
        .wait_open(1, |a| {
            a["answerable"] == json!(true) && a["id"] != seen["id"]
        })
        .await[0]
        .clone();
    let (code, _) = r
        .post(
            &format!("/api/asks/{}/answer", seen["id"].as_str().unwrap()),
            json!({ "decision": "allow", "permissions": [0] }),
        )
        .await;
    assert_eq!(code, 409, "the old id must not apply the new suggestion");
    let (_, b1) = tokio::time::timeout(Duration::from_secs(3), first_hook)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(b1, "", "the superseded hook is released with no decision");
    let (code, _) = r
        .post(
            &format!("/api/asks/{}/answer", now["id"].as_str().unwrap()),
            json!({ "decision": "allow", "permissions": [0] }),
        )
        .await;
    assert_eq!(code, 200);
    let (_, b2) = second_hook.await.unwrap();
    assert!(b2.contains("addRules"), "{b2}");
}

/// A needs-input answer goes to the agent that ASKED, on its card. Moving the
/// card to another session closes the question (`board` / `reassigned`); a
/// reassignment that bypassed the board API is refused at answer time, and
/// nothing is typed into the other session.
#[tokio::test]
async fn a_reassigned_card_closes_its_question_and_never_answers_another_agent() {
    let r = rig().await;
    r.add_session("other", "other-token").await;
    r.add_card("T-9", SESSION).await;
    r.needs_input(SESSION, TOKEN, "eu or us?").await;
    let id = r.wait_open(1, |_| true).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (code, v) = r
        .patch("/api/board/T-9", json!({ "session": "other" }))
        .await;
    assert_eq!(code, 200, "{v}");
    let a = r.ask(&id).await;
    assert_eq!(a["state"], json!("resolved"), "{a}");
    assert_eq!(a["resolution"]["by"], json!("board"));
    assert_eq!(a["resolution"]["outcome"], json!("reassigned"));

    // Back to the asker, a new question; then the link moves behind the API's
    // back. The answer is refused and the ask closed — never delivered.
    r.patch("/api/board/T-9", json!({ "session": SESSION }))
        .await;
    r.needs_input(SESSION, TOKEN, "staging or prod?").await;
    let id = r.wait_open(1, |_| true).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    db::board::patch_issue(
        &r.state.pool,
        "T-9",
        &[db::board::IssueField::Session(Some("other".into()))],
    )
    .await
    .unwrap();
    let (code, v) = r
        .post(&format!("/api/asks/{id}/answer"), json!({ "text": "prod" }))
        .await;
    assert_eq!(code, 409, "{v}");
    assert!(
        v["error"]
            .as_str()
            .unwrap_or_default()
            .contains("reassigned"),
        "{v}"
    );
    assert_eq!(
        r.ask(&id).await["resolution"]["outcome"],
        json!("reassigned")
    );
    let replies: Vec<(String,)> =
        sqlx::query_as("SELECT action FROM audit_log WHERE action = 'issue.reply'")
            .fetch_all(&r.state.pool)
            .await
            .unwrap();
    assert!(
        replies.is_empty(),
        "nothing was typed anywhere: {replies:?}"
    );
}

/// Closing, deleting or discarding the card from the board closes its
/// question; so does the card's "needs your input" state clearing behind the
/// API's back (refused at answer time).
#[tokio::test]
async fn closing_the_card_closes_its_question() {
    let r = rig().await;
    for (i, (action, outcome)) in [
        ("done", "issue_done"),
        ("delete", "issue_deleted"),
        ("discard", "issue_discarded"),
        ("cleared", "input_cleared"),
    ]
    .into_iter()
    .enumerate()
    {
        let card = format!("T-{}", 20 + i);
        r.add_card(&card, SESSION).await;
        r.needs_input(SESSION, TOKEN, &format!("question {i}?"))
            .await;
        let id = r.wait_open(1, |a| a["issue_id"] == json!(card)).await[0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        match action {
            "done" => {
                let (code, v) = r
                    .patch(&format!("/api/board/{card}"), json!({ "status": "done" }))
                    .await;
                assert_eq!(code, 200, "{v}");
            }
            "delete" => {
                let x = r
                    .http
                    .delete(format!("{}/api/board/{card}", r.url))
                    .bearer_auth(BEARER)
                    .send()
                    .await
                    .unwrap();
                assert_eq!(x.status(), 200);
            }
            "discard" => {
                let (code, v) = r
                    .post(&format!("/api/board/{card}/discard"), json!({}))
                    .await;
                assert_eq!(code, 200, "{v}");
            }
            _ => {
                db::board::patch_issue(
                    &r.state.pool,
                    &card,
                    &[db::board::IssueField::AwaitingInput(0)],
                )
                .await
                .unwrap();
                let (code, v) = r
                    .post(&format!("/api/asks/{id}/answer"), json!({ "text": "x" }))
                    .await;
                assert_eq!(code, 409, "{v}");
            }
        }
        let a = r.ask(&id).await;
        assert_eq!(a["state"], json!("resolved"), "{action}: {a}");
        assert_eq!(a["resolution"]["outcome"], json!(outcome), "{action}: {a}");
    }
}

/// Deleting a session closes its open asks — a rev and a `closed` frame each —
/// and the closed rows outlive the session row, so a client resuming with
/// `since` learns the ask is gone.
#[tokio::test]
async fn deleting_a_session_closes_its_asks_and_since_replays_it() {
    let r = rig().await;
    r.add_session("doomed", "doomed-token").await;
    let resp = r
        .http
        .post(format!("{}/api/_internal/hook", r.url))
        .header("Content-Type", "application/json")
        .header("X-Supermux-Hook-Token", "doomed-token")
        .body(
            json!({ "session": "doomed", "event": "notification", "pane": "",
                    "payload": { "notification_type": "agent_needs_input", "message": "Pick one" } })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let a = r.wait_open(1, |a| a["session"] == json!("doomed")).await[0].clone();
    let cursor = a["rev"].as_i64().unwrap();
    let mut sse = r.state.sse_tx.subscribe();
    let x = r
        .http
        .delete(format!("{}/api/sessions/doomed", r.url))
        .bearer_auth(BEARER)
        .send()
        .await
        .unwrap();
    assert_eq!(x.status(), 200, "{:?}", x.text().await);
    let (_, v) = r.get(&format!("/api/asks?since={cursor}")).await;
    let changes = v["data"]["asks"].as_array().unwrap();
    assert_eq!(changes.len(), 1, "{v}");
    assert_eq!(changes[0]["id"], a["id"]);
    assert_eq!(changes[0]["state"], json!("resolved"));
    assert_eq!(changes[0]["resolution"]["outcome"], json!("deleted"));
    assert!(v["data"]["rev"].as_i64().unwrap() > cursor);
    let mut saw_closed = false;
    while let Ok(ev) = sse.try_recv() {
        if ev.event == "asks" && ev.payload["op"] == json!("closed") {
            saw_closed = true;
        }
    }
    assert!(saw_closed, "a closed frame was published");
}

/// Two identical calls of one agent share a key (the PermissionRequest names
/// no tool_use_id). The FIRST finishing must not close the SECOND's pending
/// dialog: only the call the dialog is for (the latest PreToolUse with that
/// key) closes a hooked ask.
#[tokio::test]
async fn an_identical_earlier_call_finishing_leaves_the_pending_dialog_open() {
    let r = rig().await;
    let payload = bash_permission("npm test");
    let pre = |t: &str| json!({ "session_id": "cc-1", "tool_name": "Bash", "tool_use_id": t, "tool_input": payload["tool_input"] });
    // Call A was approved earlier and is still running; call B asks now.
    r.observe("pre_tool", pre("toolu_A")).await;
    r.observe("pre_tool", pre("toolu_B")).await;
    let hook = r.decide("permission_request", payload.clone());
    let id = r.wait_open(1, |a| a["answerable"] == json!(true)).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    r.observe("post_tool", pre("toolu_A")).await;
    let a = r.ask(&id).await;
    assert_eq!(a["state"], json!("open"), "{a}");
    assert_eq!(a["answerable"], json!(true));
    assert!(!hook.is_finished());
    // B itself finishing (its "Yes" at the terminal) closes it.
    r.observe("post_tool", pre("toolu_B")).await;
    let (_, body) = tokio::time::timeout(Duration::from_secs(3), hook)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(body, "");
    assert_eq!(r.ask(&id).await["resolution"]["outcome"], json!("tool_ran"));
}
