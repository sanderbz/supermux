//! The group-chat tool endpoint: `POST /api/hook/groupchat/tool`.
//!
//! Called ONLY by the embedded MCP server ([`super`]) that a granted bot
//! launches. It sits on the same no-bearer, per-session-hook-token router family
//! as the status hook, the board hook and the browser tool endpoint — and for
//! the same reason: the caller runs inside a pane and must never hold the
//! dashboard bearer.
//!
//! ```text
//!   bot ──stdio──▶ mcp_server.py ──HTTP(hook token)──▶ THIS ──▶ companies::groupchat
//! ```
//!
//! # The gates, in order
//!
//! 1. **Identity.** `X-Supermux-Hook-Token` is constant-time compared against
//!    that session's `session_runtime.hook_token`. Bot A's token authenticates
//!    only bot A.
//! 2. **Company.** The company is read from the SESSION ROW, never from the
//!    request or from the baked `SUPERMUX_COMPANY_ID`. A session with no
//!    company has no channel to reach.
//! 3. **Connector grant.** The session must hold an enabled `group-chat` grant
//!    (its own, its company's `@company:<id>` tier, or the all-agents one).
//! 4. **Per-tool rules.** `tag_bot` is Router-only and passes the CODE-SIDE
//!    two-tags-per-routing-turn cap; `post_message` is `@`-stripped; every read
//!    is budget-capped. These live here, on the single path, rather than in the
//!    Python — a forwarder cannot be a fence.
//!
//! Nothing in here wakes a bot except `tag_bot`, which is the one tool whose
//! entire job is to wake exactly one.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::companies::groupchat as gc;
use crate::db;
use crate::error::AppError;
use crate::extract::LenientJson;
use crate::state::AppState;

/// The largest `post_message` / `tag_bot` text this endpoint accepts. Matches
/// the channel's own row cap so a refusal happens at the door, once.
const TEXT_MAX_BYTES: usize = gc::POST_MAX_BYTES;

pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/hook/groupchat/tool", post(tool_handler))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
pub struct ToolBody {
    /// The supermux session name (`$SUPERMUX_SESSION`); scopes the token check
    /// AND names the caller in the channel.
    pub session: String,
    /// `read_history` | `who_tagged_me` | `post_message` | `tag_bot` | `whoami`.
    pub tool: String,
    #[serde(default)]
    pub args: Value,
}

/// `POST /api/hook/groupchat/tool` — run ONE group-chat tool for a granted bot.
async fn tool_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    LenientJson(body): LenientJson<ToolBody>,
) -> Result<Json<Value>, AppError> {
    // 1. Identity (401 on any miss, including an unknown session — no oracle).
    crate::hooks::verify_hook_token(&state, &body.session, &headers).await?;
    if !crate::sessions::valid_name(&body.session) {
        return Err(AppError::BadRequest("invalid session name".into()));
    }
    // 2. Company — from the row, never from the request.
    let row = db::sessions::get(&state.pool, &body.session)
        .await?
        .ok_or(AppError::Unauthorized)?;
    let Some(company_id) = row.company_id else {
        return Err(AppError::Forbidden(
            "this session is not in a company, so it has no group chat".into(),
        ));
    };
    let company = db::companies::get(&state.pool, company_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={company_id}")))?;
    // 3. Connector grant — an ungranted bot that somehow learned the URL is a
    //    403, and reaches no channel.
    let granted = db::connectors::grants_for_session(&state.pool, &body.session)
        .await
        .unwrap_or_default()
        .into_iter()
        .any(|g| g.connector_id == super::GROUPCHAT_ID);
    if !granted {
        return Err(AppError::Forbidden(
            "this session has no group-chat grant".into(),
        ));
    }
    let result = run(&state, &company, &body.session, &body.tool, &body.args).await?;
    Ok(Json(json!({ "ok": true, "result": result })))
}

/// The dispatch table. One arm per declared tool — see
/// [`super::tool_decls`], which the card and the Python server share.
pub async fn run(
    state: &AppState,
    company: &db::companies::Company,
    session: &str,
    tool: &str,
    args: &Value,
) -> Result<Value, AppError> {
    let path = gc::log_path(state, company.id);
    match tool {
        "whoami" => Ok(json!({
            "session": session,
            "company_id": company.id,
            "company": company.slug,
            "display_name": company.display_name,
            "is_router": gc::is_router(&company.slug, session),
            "router": gc::router_name(&company.slug),
        })),

        "read_history" => {
            let since_seq = args.get("since_seq").and_then(|v| v.as_u64());
            let budget = args
                .get("budget_tokens")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            let (rows, more_seq) =
                tokio::task::spawn_blocking(move || gc::read_history(&path, since_seq, budget))
                    .await
                    .map_err(|e| AppError::Internal(anyhow::anyhow!("history read failed: {e}")))?;
            Ok(json!({
                "rows": rows,
                "more_seq": more_seq,
                "max_rows": gc::HISTORY_TOOL_MAX_ROWS,
                "max_tokens": gc::HISTORY_TOOL_MAX_TOKENS,
            }))
        }

        "who_tagged_me" => {
            let me = session.to_string();
            let found = tokio::task::spawn_blocking(move || gc::who_tagged_me(&path, &me))
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("history read failed: {e}")))?;
            Ok(match found {
                Some((tag, human)) => json!({
                    "tagged": true,
                    "by": tag.author_session,
                    "seq": tag.seq,
                    "reason": tag.body,
                    // The human request behind the routing decision, when it is
                    // still in the log. Absent is honest — never invented.
                    "request": human.as_ref().map(|h| h.body.clone()),
                    "requested_by": human.as_ref().map(|h| h.author_session.clone()),
                }),
                // Not an error: "nobody tagged you" is a real, useful answer.
                None => json!({ "tagged": false }),
            })
        }

        "post_message" => {
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
            if text.is_empty() {
                return Err(AppError::BadRequest("post_message needs `text`".into()));
            }
            if text.len() > TEXT_MAX_BYTES {
                return Err(AppError::BadRequest(format!(
                    "post_message text is too large (max {TEXT_MAX_BYTES} bytes)"
                )));
            }
            // The SAME path the REST route takes: `@`-stripped, author-kind
            // server-derived, appended to the log, published to the ring. Wakes
            // nobody.
            let row = gc::post_as_session(state, company, session, text, None).await?;
            Ok(json!({ "posted": true, "seq": row.seq, "text": row.body }))
        }

        "tag_bot" => tag_bot(state, company, session, args).await,

        other => Err(AppError::BadRequest(format!("unknown group-chat tool: {other}"))),
    }
}

/// Build the prompt DELIVERED to a tagged bot: the Router's distilled request
/// plus a standing instruction to post the answer back to the channel.
///
/// The tagged bot is woken through `deliver_delegation` and otherwise arrives
/// with nothing but the distilled request — no reason to reply to the group. A
/// bot that does its work and returns silently leaves the human staring at a
/// routing pill and no answer, which is exactly the live incident. Appending the
/// post-back reminder here (and ONLY to the delivered prompt — the recorded row
/// body stays the bare request) closes that loop.
///
/// Contains no supermux wrapper markup, so it never trips `deliver_delegation`'s
/// wrapper guard: the reminder is plain English naming the `post_message` tool,
/// never a `<supermux-…>` tag.
fn delivered_prompt(company_display: &str, request: &str) -> String {
    // Kept SHORT on purpose (token cost): one clause naming the tool, one giving
    // the bot permission to bow out in a line. A nudge is not an order to write an
    // essay — a bot with nothing to add should say so briefly, not manufacture a
    // long answer. A bot whose live session predates the group-chat grant simply
    // lacks the tool and the owner restarts it — cheaper than a per-delegation
    // fallback.
    format!(
        "{request}\n\n(From {company_display} group chat. Reply in-channel with mcp__group_chat__post_message — keep it short; if there's nothing here for you, a one-line \"nothing for me on this\" is fine.)"
    )
}

/// `tag_bot` — the ONE tool that wakes another agent, and therefore the one
/// with the most gates.
///
/// The cap is CODE-SIDE (spec §4.6): the Router's prompt asks for at most two
/// tags, and this is what makes that true. A third tag in the same routing turn
/// is DROPPED — reported honestly to the Router, never queued behind its back,
/// because a queued fan-out is the same token bomb one tick later.
async fn tag_bot(
    state: &AppState,
    company: &db::companies::Company,
    session: &str,
    args: &Value,
) -> Result<Value, AppError> {
    if !gc::is_router(&company.slug, session) {
        // Only the company's Main Assistant routes. A bot that could tag would
        // be a bot that can wake other bots — the thing §4 exists to prevent.
        return Err(AppError::Forbidden(
            "only the company's assistant may tag bots".into(),
        ));
    }
    let target = args.get("session").and_then(|v| v.as_str()).unwrap_or("").trim();
    let request = args
        .get("distilled_request")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if target.is_empty() || request.is_empty() {
        return Err(AppError::BadRequest(
            "tag_bot needs `session` and `distilled_request`".into(),
        ));
    }
    if request.len() > TEXT_MAX_BYTES {
        return Err(AppError::BadRequest(format!(
            "distilled_request is too large (max {TEXT_MAX_BYTES} bytes)"
        )));
    }
    if target == session {
        return Err(AppError::BadRequest("the router may not tag itself".into()));
    }
    // In-company, resolved from the row. A foreign or missing target is the
    // uniform 404 — the router must not become a cross-company roster oracle.
    let target_row = db::sessions::get(&state.pool, target)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{target}'")))?;
    if target_row.company_id != Some(company.id) {
        return Err(AppError::NotFound(format!("session '{target}'")));
    }

    let gcc = gc::channel(state, company.id).await?;
    let path = gc::log_path(state, company.id);
    let turn = tokio::task::spawn_blocking(move || gc::current_turn(&path))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("history read failed: {e}")))?;
    let Some(turn) = turn else {
        // No human message has been posted, so there is no routing turn to be
        // in. Refusing here is what stops a bored Router from fanning out on
        // its own initiative.
        return Ok(json!({
            "tagged": false,
            "dropped": true,
            "reason": "there is no human request to route right now",
        }));
    };
    // The claim returns how many slots remain AFTER it, because that number is
    // only true while the cap's lock is held — and because telling the Router a
    // constant is what made it spend a turn on a tag this function then dropped.
    let Some(remaining) = gc::claim_tag_slot(&gcc, turn) else {
        return Ok(json!({
            "tagged": false,
            "dropped": true,
            "reason": format!(
                "the {}-tag cap for this routing turn is spent — pick the most important bots first",
                gc::MAX_TAGS_PER_TURN
            ),
            "max_tags_per_turn": gc::MAX_TAGS_PER_TURN,
        }));
    };

    // The visible routing line (the hero's DelegationPill), recorded BEFORE the
    // delivery so a failed wake still leaves the decision in the feed. The ROW
    // body stays the BARE `request` — the routing pill must read clean.
    let row = gc::record_tag(state, company.id, session, target, request).await?;
    // …and the ONE waking delegation. The DELIVERED prompt (only) gets a
    // standing post-back instruction appended: the tagged bot arrives with the
    // distilled request AND the reminder to post its answer back to the channel
    // (`post_message`), so the human actually sees the result. `actor: None`
    // audits as `agent:<router>`, which is exactly what happened.
    let prompt = delivered_prompt(&company.display_name, request);
    crate::agents::delegate::deliver_delegation(state, session, target, &prompt, None).await?;
    Ok(json!({
        "tagged": true,
        "session": target,
        "seq": row.seq,
        "turn": turn,
        // The TRUTH, not `MAX - 1`: after the second tag this is 0, which is
        // what stops the Router paying for a third.
        "remaining_tags": remaining,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companies::groupchat::{NewRow, AUTHOR_HUMAN};

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-gctools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
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
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    async fn seed(state: &AppState, slug: &str, bots: &[&str]) -> db::companies::Company {
        let c = db::companies::create(&state.pool, slug, slug, &format!("/srv/{slug}"))
            .await
            .unwrap();
        for b in bots {
            db::sessions::insert_minimal(&state.pool, b, "/tmp", "claude").await.unwrap();
            sqlx::query("UPDATE sessions SET company_id = ? WHERE name = ?")
                .bind(c.id)
                .bind(b)
                .execute(&state.pool)
                .await
                .unwrap();
            // PIN THE PTY. A successful `tag_bot` delivers through
            // `agents::delegate::deliver_delegation` →
            // `lifecycle::send_harness_text`, which probes the real runtime,
            // auto-wakes a stopped session via `start()` and reads its screen
            // before typing. Unpinned, these tests spawn real `supermux-<name>`
            // tmux sessions on the host and type `claude …` into them: green
            // only on a box where an earlier run left one behind with a live
            // agent, red on every clean host with no `claude` on PATH. What is
            // under test is the routing turn (the tag cap, the recorded row),
            // so the delivery precondition is stated, not inherited.
            crate::sessions::runtime::testing::agent_at_composer(state, b);
        }
        c
    }

    async fn human_row(state: &AppState, id: i64) {
        gc::append(
            state,
            id,
            NewRow {
                author_session: "owner".into(),
                author_kind: AUTHOR_HUMAN,
                body: "get the migration shipped".into(),
                wrapper: None,
                run_id: None,
                tagged: Vec::new(),
                author_name: None,
            },
        )
        .await
        .unwrap();
    }

    /// `whoami` is the identity a bot needs to know whether `tag_bot` is even
    /// its to call — and it is SERVER-derived, not env-derived.
    #[tokio::test]
    async fn whoami_names_the_company_and_the_router() {
        let (state, dir) = test_state().await;
        let c = seed(&state, "acme", &["acme-bot"]).await;
        let out = run(&state, &c, "acme-bot", "whoami", &json!({})).await.unwrap();
        assert_eq!(out["company"], "acme");
        assert_eq!(out["is_router"], false);
        assert_eq!(out["router"], "acme-assistant");
        let router = run(&state, &c, "acme-assistant", "whoami", &json!({})).await.unwrap();
        assert_eq!(router["is_router"], true);
        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    /// `post_message` takes the SAME path the REST route does: `@`-stripped,
    /// appended, and it wakes nobody.
    #[tokio::test]
    async fn post_message_strips_ats_through_the_tool_path_too() {
        let (state, dir) = test_state().await;
        let c = seed(&state, "acme", &["acme-bot"]).await;
        let out = run(
            &state,
            &c,
            "acme-bot",
            "post_message",
            &json!({ "text": "done — thanks @acme-assistant" }),
        )
        .await
        .unwrap();
        assert_eq!(out["posted"], true);
        assert_eq!(out["text"], "done — thanks acme-assistant");
        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    /// Only the Router routes. A bot that could tag would be a bot that can wake
    /// other bots — the exact thing the token economy forbids.
    #[tokio::test]
    async fn tag_bot_is_router_only() {
        let (state, dir) = test_state().await;
        let c = seed(&state, "acme", &["acme-bot", "acme-backend"]).await;
        human_row(&state, c.id).await;
        let err = run(
            &state,
            &c,
            "acme-bot",
            "tag_bot",
            &json!({ "session": "acme-backend", "distilled_request": "do it" }),
        )
        .await
        .expect_err("a non-router may not tag");
        assert!(matches!(err, AppError::Forbidden(_)), "got {err:?}");
        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    /// End to end through the tool: two tags land, the third is DROPPED — and a
    /// dropped tag is reported honestly rather than queued behind the Router's
    /// back.
    #[tokio::test]
    async fn the_third_tag_in_a_routing_turn_is_dropped() {
        let (state, dir) = test_state().await;
        let c = seed(
            &state,
            "acme",
            &["acme-assistant", "acme-a", "acme-b", "acme-c"],
        )
        .await;
        human_row(&state, c.id).await;
        let tag = |target: &'static str| {
            let state = state.clone();
            let c = c.clone();
            async move {
                run(
                    &state,
                    &c,
                    "acme-assistant",
                    "tag_bot",
                    &json!({ "session": target, "distilled_request": "please handle this" }),
                )
                .await
                .unwrap()
            }
        };
        assert_eq!(tag("acme-a").await["tagged"], true);
        assert_eq!(tag("acme-b").await["tagged"], true);
        let third = tag("acme-c").await;
        assert_eq!(third["tagged"], false, "the cap is code-side, not prompt-side");
        assert_eq!(third["dropped"], true);
        assert_eq!(third["max_tags_per_turn"], gc::MAX_TAGS_PER_TURN);
        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    /// No human message ⇒ no routing turn ⇒ nothing to route. This is what stops
    /// an idle Router fanning out on its own initiative.
    #[tokio::test]
    async fn tagging_outside_a_routing_turn_is_refused() {
        let (state, dir) = test_state().await;
        let c = seed(&state, "acme", &["acme-assistant", "acme-a"]).await;
        let out = run(
            &state,
            &c,
            "acme-assistant",
            "tag_bot",
            &json!({ "session": "acme-a", "distilled_request": "do something" }),
        )
        .await
        .unwrap();
        assert_eq!(out["tagged"], false);
        assert_eq!(out["dropped"], true);
        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    /// A cross-company target is the uniform 404 — the Router must not become a
    /// roster oracle for other companies.
    #[tokio::test]
    async fn tagging_out_of_company_is_a_silent_404() {
        let (state, dir) = test_state().await;
        let c = seed(&state, "acme", &["acme-assistant"]).await;
        let _globex = seed(&state, "globex", &["globex-bot"]).await;
        human_row(&state, c.id).await;
        let err = run(
            &state,
            &c,
            "acme-assistant",
            "tag_bot",
            &json!({ "session": "globex-bot", "distilled_request": "do it" }),
        )
        .await
        .expect_err("cross-company tag must be refused");
        assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    /// The DELIVERED prompt appends a standing post-back instruction to the
    /// distilled request — that is what makes the tagged bot answer back to the
    /// channel — while carrying no supermux wrapper markup (so it clears
    /// `deliver_delegation`'s guard).
    #[test]
    fn the_delivered_prompt_appends_a_post_back_instruction() {
        let p = delivered_prompt("Acme", "ship the migration");
        assert!(p.starts_with("ship the migration"), "the request leads: {p}");
        assert!(
            p.contains("mcp__group_chat__post_message"),
            "the bot is told how to answer back: {p}",
        );
        assert!(p.contains("Acme"), "the company is named: {p}");
        assert!(
            p.to_lowercase().contains("short") && p.to_lowercase().contains("nothing"),
            "the bot is invited to be brief / bow out, not write an essay: {p}",
        );
        assert!(
            !crate::agents::delegate::wrapper_markup(&p),
            "the suffix must not trip the wrapper guard",
        );
    }

    /// End to end: a successful tag DELIVERS the appended prompt but records the
    /// ROUTING ROW with the BARE request — the hero's pill must stay clean.
    #[tokio::test]
    async fn the_recorded_row_stays_the_bare_request() {
        let (state, dir) = test_state().await;
        let c = seed(&state, "acme", &["acme-assistant", "acme-a"]).await;
        human_row(&state, c.id).await;
        let out = run(
            &state,
            &c,
            "acme-assistant",
            "tag_bot",
            &json!({ "session": "acme-a", "distilled_request": "ship the migration" }),
        )
        .await
        .unwrap();
        assert_eq!(out["tagged"], true);
        // Read the log back and find the router routing row.
        let path = gc::log_path(&state, c.id);
        let (rows, _) = gc::read_history(&path, None, Some(gc::HISTORY_TOOL_MAX_TOKENS));
        let pill = rows
            .iter()
            .find(|r| r.kind == gc::AUTHOR_ROUTER)
            .expect("a routing row was recorded");
        assert_eq!(
            pill.text, "ship the migration",
            "the recorded pill is the bare request, not the delivered prompt",
        );
        assert!(
            !pill.text.contains("mcp__group_chat__post_message"),
            "the post-back suffix must NOT leak into the row body",
        );
        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn an_unknown_tool_is_a_400_not_a_silent_ok() {
        let (state, dir) = test_state().await;
        let c = seed(&state, "acme", &["acme-bot"]).await;
        let err = run(&state, &c, "acme-bot", "delete_everything", &json!({}))
            .await
            .expect_err("unknown tools must not be reachable");
        assert!(matches!(err, AppError::BadRequest(_)), "got {err:?}");
        state.pool.close().await;
        std::fs::remove_dir_all(dir).ok();
    }
}
