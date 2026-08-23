//! Agent→app hook endpoints (the bot-reachable capability surface, fase C).
//!
//! Two routes a running bot can call with its OWN per-session
//! `$SUPERMUX_HOOK_TOKEN` — the same auth the board + scheduler hooks use, NOT
//! the dashboard bearer (which a bot never holds). Both are mounted OUTSIDE the
//! bearer layer in `http::router`, and both are SCOPE-LOCKED so a bot can only
//! act on its own pane / its own company:
//!
//! ## `POST /api/hook/notify` — ping THIS bot's human
//!
//! Body `{ session, title, body }`. The token authenticates `session`; the push
//! goes to the dashboard owner and deep-links to `/focus/<session>`. A bot may
//! notify ONLY about its own pane (the token binds the session — presenting
//! another session's name with your token 401s), the title/body are length-capped
//! and sanitised (they land in a web-push payload as data, never as markup), and
//! a small per-session rate limit stops a loop from spamming the phone. Secrets
//! are never logged.
//!
//! ## `POST /api/hook/delegate` — message a SAME-COMPANY peer
//!
//! Body `{ session, to, prompt }`. Closes the auth-model gap the audit flagged:
//! `/api/agents/delegate` is bearer-only, so a bot's hook token 401s there and a
//! bot could not message a peer at all. This route authenticates `session` (the
//! `from`), FORCES `from` to that authenticated session (a payload `from` is
//! impossible — there is no such field), and funnels into the SAME
//! `delegate::deliver_delegation` the bearer route uses, so the company gate
//! (`delegation_gate_allows`), the wrapper-markup refusal, the size cap and the
//! delegation-edge/audit bookkeeping are ONE implementation. A company bot may
//! reach only its own company; a cross-company (or company→main) `to` collapses
//! to a uniform 404 — byte-identical to a nonexistent slug, so a bot cannot even
//! probe another company's roster. The bearer route is untouched.
//!
//! Bodies are read `Content-Type`-agnostically via [`crate::extract::LenientJson`]
//! (the docs a bot copies use `curl -d`, which defaults to
//! `application/x-www-form-urlencoded`) — see that extractor's module doc for why
//! this is not a CSRF hole (the auth header is not CORS-simple).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db;
use crate::error::AppError;
use crate::extract::LenientJson;
use crate::state::AppState;

/// Header the bot sets to its per-session `$SUPERMUX_HOOK_TOKEN`.
const HOOK_TOKEN_HEADER: &str = "X-Supermux-Hook-Token";

/// The bot→app hook sub-router. Merged at the top level of `http::router` (NO
/// bearer layer — auth is the per-session hook token, validated per handler).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/hook/notify", post(notify_handler))
        .route("/api/hook/delegate", post(delegate_handler))
        .with_state(state)
}

/// Constant-time validate the presented hook token against `session`'s stored
/// token. 401 on any mismatch / missing row. Identical to the board + scheduler
/// hook auth (the DB is the source of truth; a leaked bearer can't drive this,
/// and session A's token can't authenticate as session B).
async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    session: &str,
) -> Result<(), AppError> {
    let expected = db::sessions::runtime(&state.pool, session)
        .await?
        .map(|rt| rt.hook_token)
        .ok_or(AppError::Unauthorized)?;
    let presented = headers
        .get(HOOK_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if expected.is_empty()
        || !constant_time_eq::constant_time_eq(expected.as_bytes(), presented.as_bytes())
    {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

// ── notify ───────────────────────────────────────────────────────────────────

/// The largest title / body this endpoint accepts, in characters. A push
/// notification is a glance, not a document; anything past this is refused (400)
/// rather than truncated so a bot learns the shape. Generous — a real "I need
/// you / I'm done" ping is a sentence.
const NOTIFY_TITLE_MAX_CHARS: usize = 120;
const NOTIFY_BODY_MAX_CHARS: usize = 600;

/// Per-session rate limit: at most [`NOTIFY_MAX_IN_WINDOW`] notifications per
/// [`NOTIFY_WINDOW`]. A bot pinging its human is legitimate; a bot in a loop
/// pinging every second is a denial-of-service against the phone. Over the limit
/// is a 429 the bot can act on (back off), never a silent drop.
const NOTIFY_MAX_IN_WINDOW: usize = 5;
const NOTIFY_WINDOW: Duration = Duration::from_secs(60);

/// In-memory sliding-window counter, keyed by session. Process-local (a restart
/// resets it — acceptable for a courtesy rate limit, not a security boundary;
/// the security boundary is the per-session token + own-pane scope). The lock is
/// only ever held for a tiny push/prune, never across an `.await`.
static NOTIFY_RATE: Lazy<Mutex<HashMap<String, Vec<Instant>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Record one send and report whether it is within budget. Prunes timestamps
/// older than the window on every call so the map cannot grow without bound for
/// a chatty session.
fn rate_ok(session: &str) -> bool {
    let now = Instant::now();
    let mut map = NOTIFY_RATE.lock().unwrap_or_else(|e| e.into_inner());
    let hits = map.entry(session.to_string()).or_default();
    hits.retain(|t| now.duration_since(*t) < NOTIFY_WINDOW);
    if hits.len() >= NOTIFY_MAX_IN_WINDOW {
        return false;
    }
    hits.push(now);
    true
}

#[derive(Debug, Deserialize)]
struct NotifyBody {
    /// Authenticates the caller AND scopes the notification to its own pane. Any
    /// other session's name presented here fails auth (its stored token differs).
    session: String,
    title: String,
    body: String,
}

/// `POST /api/hook/notify` — a bot pings its own human. Authenticates the
/// session, caps + sanitises the copy, rate-limits, then fires a web push (via
/// the SAME `send_push_for` gate the real triggers use, so the user's mute prefs
/// are honoured) deep-linking to the bot's pane.
async fn notify_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    LenientJson(body): LenientJson<NotifyBody>,
) -> Result<Json<Value>, AppError> {
    let session = body.session.trim().to_string();
    authenticate(&state, &headers, &session).await?;

    // Sanitise BEFORE the length check so a control-char-padded string can't slip
    // a long payload past the cap. `sanitise_text` strips ANSI / control bytes;
    // the push payload is JSON (serde escapes), so this is defence-in-depth, not
    // the only guard against injection.
    let title = crate::ws::sanitise_text(body.title.trim());
    let body_text = crate::ws::sanitise_text(body.body.trim());
    if title.is_empty() {
        return Err(AppError::BadRequest("'title' is required".into()));
    }
    if title.chars().count() > NOTIFY_TITLE_MAX_CHARS {
        return Err(AppError::BadRequest(format!(
            "'title' is too long (max {NOTIFY_TITLE_MAX_CHARS} characters)"
        )));
    }
    if body_text.chars().count() > NOTIFY_BODY_MAX_CHARS {
        return Err(AppError::BadRequest(format!(
            "'body' is too long (max {NOTIFY_BODY_MAX_CHARS} characters)"
        )));
    }
    if !rate_ok(&session) {
        return Err(AppError::TooManyRequests(format!(
            "too many notifications from this session (max {NOTIFY_MAX_IN_WINDOW} per {}s) — wait before sending another",
            NOTIFY_WINDOW.as_secs()
        )));
    }

    // Best-effort push, spawned so the hook response is not blocked on the push
    // service; no-ops cheaply when nobody is subscribed. `Attention` tier so a
    // deliberate "I need you" ping is never coalesced away; `Some(&session)` so
    // the per-bot notification policy applies (this IS about that bot). The copy
    // is the bot's own words — never a secret, and never logged here.
    {
        let state = state.clone();
        let url = format!("/focus/{session}");
        tokio::spawn(async move {
            let _ = crate::push::send_push_for(
                &state,
                crate::db::push::NotifCategory::AgentWaiting,
                &crate::notify::PushPayload::simple(
                    title,
                    body_text,
                    url,
                    crate::notify::Tier::Attention,
                ),
                Some(&session),
            )
            .await;
        });
    }

    Ok(Json(json!({ "ok": true })))
}

// ── delegate (message a same-company peer) ────────────────────────────────────

#[derive(Debug, Deserialize)]
struct DelegateBody {
    /// Authenticates the caller AND becomes the `from` — there is NO payload
    /// `from`, so a bot can only ever send AS itself (the schedule-hook
    /// discipline: scope is structural, not a checked field).
    session: String,
    to: String,
    prompt: String,
}

/// `POST /api/hook/delegate` — a bot messages a same-company peer. Authenticates
/// the session, forces `from` to it, and hands the rest to the shared
/// `delegate::deliver_delegation` so the company gate + wrapper refusal + size
/// cap + edge/audit are the SAME code the bearer route runs. A cross-company (or
/// company→main) target is a uniform 404 (no roster oracle).
async fn delegate_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    LenientJson(body): LenientJson<DelegateBody>,
) -> Result<Json<Value>, AppError> {
    let session = body.session.trim().to_string();
    authenticate(&state, &headers, &session).await?;

    // `from` is the AUTHENTICATED session, never a payload field — the delivery
    // helper enforces the company gate off both rows' `company_id`. `actor: None`
    // audits as `agent:<from>` (this is never the human composer path).
    let id = crate::agents::delegate::deliver_delegation(
        &state,
        &session,
        body.to.trim(),
        &body.prompt,
        None,
    )
    .await?;

    Ok(Json(json!({ "ok": true, "id": id })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::sessions::runtime::{HistoryWindow, SessionRuntime};
    use async_trait::async_trait;
    use axum::http::HeaderValue;
    use std::path::Path;
    use std::sync::Arc;

    /// A minimal LIVE `SessionRuntime` double: always `alive` (so
    /// `send_harness_text` skips the real `wake_for_send`, which on a clean box —
    /// CI, or a local box without a stray `supermux-<name>` tmux session — would
    /// try to boot a real `claude` agent that never comes up → `Conflict`) and a
    /// ready-composer capture (so the agent send-guard admits the delivery). Its
    /// `send_text`/`send_key` are no-ops: the delegate test asserts the AUTH +
    /// company-scope gate + the recorded edge, not the pty mechanics (those are
    /// covered by `sessions::lifecycle`'s own send-guard tests). Registered into
    /// `state.session_runtimes`, which `AppState::runtime_for` consults first.
    struct LiveStub;

    #[async_trait]
    impl SessionRuntime for LiveStub {
        async fn spawn(&self, _d: &Path, _e: &HashMap<String, String>, _s: &str) -> anyhow::Result<()> {
            Ok(())
        }
        async fn alive(&self) -> bool {
            true
        }
        async fn kill(&self) -> anyhow::Result<()> {
            Ok(())
        }
        async fn send_text(&self, _t: &str) -> anyhow::Result<()> {
            Ok(())
        }
        async fn send_key(&self, _k: &str) -> anyhow::Result<()> {
            Ok(())
        }
        async fn paste(&self, _t: &str, _b: bool) -> anyhow::Result<()> {
            Ok(())
        }
        async fn resize(&self, _c: u16, _r: u16) -> anyhow::Result<()> {
            Ok(())
        }
        // A ready Claude composer (`❯` + shortcuts hint, and NOT a resume
        // picker / trust dialog) so `pty_ready_for_send` admits the send.
        async fn capture_plain(&self, _lines: usize) -> anyhow::Result<String> {
            Ok("❯ \n\n? for shortcuts".to_string())
        }
        async fn capture_ansi(&self, _lines: usize) -> anyhow::Result<String> {
            Ok("❯ \n\n? for shortcuts".to_string())
        }
        async fn capture_screen_ansi(&self) -> anyhow::Result<String> {
            Ok("❯ ".to_string())
        }
        async fn capture_full(&self) -> anyhow::Result<String> {
            Ok("❯ ".to_string())
        }
        async fn seed(&self) -> anyhow::Result<String> {
            Ok("❯ ".to_string())
        }
        async fn history_window(&self, end_offset: i64, _count: u32) -> anyhow::Result<HistoryWindow> {
            Ok(HistoryWindow {
                rows: vec![],
                history_size: 0,
                start_offset: end_offset,
                end_offset,
                hit_top: true,
                cols: 80,
                at_limit: false,
            })
        }
        async fn history_meta(&self) -> (u32, u16) {
            (0, 80)
        }
        async fn pane_pid(&self) -> anyhow::Result<Option<u32>> {
            Ok(None)
        }
        async fn dead(&self) -> anyhow::Result<bool> {
            Ok(false)
        }
    }

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-agenthook-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    async fn seed_company(state: &AppState, slug: &str) -> i64 {
        db::companies::create(&state.pool, slug, slug, &format!("/srv/{slug}"))
            .await
            .unwrap()
            .id
    }

    /// Seed a session with a hook token, stamping its company (NULL when None).
    async fn seed_bot(state: &AppState, name: &str, token: &str, company: Option<i64>) {
        db::sessions::insert_minimal(&state.pool, name, "/tmp", "claude")
            .await
            .unwrap();
        db::sessions::ensure_runtime(&state.pool, name, token)
            .await
            .unwrap();
        sqlx::query("UPDATE sessions SET company_id = ? WHERE name = ?")
            .bind(company)
            .bind(name)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    fn token_header(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(HOOK_TOKEN_HEADER, HeaderValue::from_str(token).unwrap());
        h
    }

    fn notify_body(session: &str, title: &str, body: &str) -> LenientJson<NotifyBody> {
        LenientJson(NotifyBody {
            session: session.to_string(),
            title: title.to_string(),
            body: body.to_string(),
        })
    }

    fn delegate_body(session: &str, to: &str, prompt: &str) -> LenientJson<DelegateBody> {
        LenientJson(DelegateBody {
            session: session.to_string(),
            to: to.to_string(),
            prompt: prompt.to_string(),
        })
    }

    // ── notify ─────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn notify_own_pane_ok() {
        let (state, dir) = test_state().await;
        seed_bot(&state, "worker", "tok", None).await;

        let out = notify_handler(
            State(state.clone()),
            token_header("tok"),
            notify_body("worker", "Done", "The migration finished green."),
        )
        .await
        .expect("own-pane notify ok");
        assert_eq!(out.0["ok"], json!(true));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn notify_wrong_token_is_unauthorized() {
        let (state, dir) = test_state().await;
        seed_bot(&state, "worker", "tok", None).await;
        let res = notify_handler(
            State(state.clone()),
            token_header("WRONG"),
            notify_body("worker", "x", "y"),
        )
        .await;
        assert!(matches!(res, Err(AppError::Unauthorized)));
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn notify_another_users_pane_is_unauthorized() {
        // A bot may notify only about its OWN pane: presenting a peer's session
        // name with your own token fails auth (the stored tokens differ), so a
        // bot can never ping another user about a pane that is not its own.
        let (state, dir) = test_state().await;
        seed_bot(&state, "worker-a", "tok-a", None).await;
        seed_bot(&state, "worker-b", "tok-b", None).await;
        let res = notify_handler(
            State(state.clone()),
            token_header("tok-a"),
            notify_body("worker-b", "x", "y"),
        )
        .await;
        assert!(matches!(res, Err(AppError::Unauthorized)));
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn notify_empty_title_is_400() {
        let (state, dir) = test_state().await;
        seed_bot(&state, "worker", "tok", None).await;
        let res = notify_handler(
            State(state.clone()),
            token_header("tok"),
            notify_body("worker", "   ", "body"),
        )
        .await;
        assert!(matches!(res, Err(AppError::BadRequest(_))));
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn notify_overlong_title_is_400() {
        let (state, dir) = test_state().await;
        seed_bot(&state, "worker", "tok", None).await;
        let long = "a".repeat(NOTIFY_TITLE_MAX_CHARS + 1);
        let res = notify_handler(
            State(state.clone()),
            token_header("tok"),
            notify_body("worker", &long, "body"),
        )
        .await;
        assert!(matches!(res, Err(AppError::BadRequest(_))));
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn notify_rate_limit_trips_after_the_budget() {
        let (state, dir) = test_state().await;
        seed_bot(&state, "spammer", "tok", None).await;
        // The window budget succeeds…
        for i in 0..NOTIFY_MAX_IN_WINDOW {
            notify_handler(
                State(state.clone()),
                token_header("tok"),
                notify_body("spammer", &format!("n{i}"), "b"),
            )
            .await
            .expect("within budget");
        }
        // …the next one is a 429.
        let res = notify_handler(
            State(state.clone()),
            token_header("tok"),
            notify_body("spammer", "over", "b"),
        )
        .await;
        assert!(matches!(res, Err(AppError::TooManyRequests(_))));
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    // ── delegate ────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn delegate_same_company_peer_ok_and_records_edge() {
        let (state, dir) = test_state().await;
        let acme = seed_company(&state, "acme").await;
        seed_bot(&state, "acme-a", "tok-a", Some(acme)).await;
        seed_bot(&state, "acme-b", "tok-b", Some(acme)).await;
        // Deliver in-process: register a live runtime for the target so the
        // send does NOT try to wake a real `claude` agent (which never boots in
        // a unit test / on the clean CI runner → `Conflict`). The delegation
        // still exercises the real handler → `deliver_delegation` → send funnel
        // → `record_delegation` path.
        state
            .session_runtimes
            .insert("acme-b".to_string(), Arc::new(LiveStub));

        let out = delegate_handler(
            State(state.clone()),
            token_header("tok-a"),
            delegate_body("acme-a", "acme-b", "please take the deploy"),
        )
        .await
        .expect("same-company delegate ok");
        assert_eq!(out.0["ok"], json!(true));

        // The delegation edge was recorded (same bookkeeping as the bearer route).
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM delegations")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(n, 1, "a delivered delegation records exactly one edge");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn delegate_cross_company_is_404_and_writes_nothing() {
        // THE SCOPE CRUX: a company bot cannot message a bot in ANOTHER company.
        // The refusal is a uniform 404 (byte-identical to a nonexistent slug) and
        // leaves no edge / no audit row.
        let (state, dir) = test_state().await;
        let acme = seed_company(&state, "acme").await;
        let globex = seed_company(&state, "globex").await;
        seed_bot(&state, "acme-a", "tok-a", Some(acme)).await;
        seed_bot(&state, "globex-b", "tok-b", Some(globex)).await;

        let res = delegate_handler(
            State(state.clone()),
            token_header("tok-a"),
            delegate_body("acme-a", "globex-b", "cross-company hijack"),
        )
        .await;
        assert!(
            matches!(res, Err(AppError::NotFound(_))),
            "cross-company delegate must be a silent 404, got {res:?}"
        );
        let (edges,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM delegations")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        let (audits,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM audit_log")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(edges, 0, "a refused delegation writes NO edge");
        assert_eq!(audits, 0, "a refused delegation writes NO audit row");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn delegate_wrong_token_is_unauthorized() {
        let (state, dir) = test_state().await;
        let acme = seed_company(&state, "acme").await;
        seed_bot(&state, "acme-a", "tok-a", Some(acme)).await;
        seed_bot(&state, "acme-b", "tok-b", Some(acme)).await;
        let res = delegate_handler(
            State(state.clone()),
            token_header("WRONG"),
            delegate_body("acme-a", "acme-b", "hi"),
        )
        .await;
        assert!(matches!(res, Err(AppError::Unauthorized)));
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn delegate_cannot_authenticate_as_a_peer() {
        // A bot presenting a PEER's session name with its OWN token 401s — so it
        // can never send AS a colleague (the token binds the `from`).
        let (state, dir) = test_state().await;
        let acme = seed_company(&state, "acme").await;
        seed_bot(&state, "acme-a", "tok-a", Some(acme)).await;
        seed_bot(&state, "acme-b", "tok-b", Some(acme)).await;
        let res = delegate_handler(
            State(state.clone()),
            token_header("tok-a"),
            delegate_body("acme-b", "acme-a", "spoofed from"),
        )
        .await;
        assert!(matches!(res, Err(AppError::Unauthorized)));
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
