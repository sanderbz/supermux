//! **Let one HQ bot accept messages from company bots** —
//! `GET | PUT | DELETE /api/sessions/{name}/company-inbox`.
//!
//! A company bot can `/supermux-message` only its own company
//! ([`crate::agents::delegate::delegation_gate_allows`]). This is the owner's
//! per-bot exception for a main (company-less) bot that should hear back from
//! companies — a chief of staff, say. No inbox is the default, and every HQ bot
//! without one stays unreachable from companies.
//!
//! ```text
//! PUT    {"companies": "*"}                         every company, incl. later ones
//! PUT    {"companies": ["erecentrum-nl", "mtbway"]} only these (by slug)
//! DELETE                                            closed again (the default)
//! ```
//!
//! Owner / admin-all only ([`Scope::All`]): opening a bot outside every company
//! to company traffic is a fleet-wide decision, not a per-company one, so a
//! company-scoped human is refused even for a bot it can see. Every change is
//! audited (`session.company_inbox`). What the receiver does with a message is
//! its own policy — it arrives wrapped as `<supermux-delegation from="…">`,
//! information from a colleague, not an order from the owner.

use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db;
use crate::db::company_inbox::Accepts;
use crate::error::AppError;
use crate::scope::{OptCtx, Scope};
use crate::state::AppState;

/// `"*"` or a list of company slugs.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum CompaniesIn {
    All(String),
    Only(Vec<String>),
}

#[derive(Debug, Deserialize)]
pub struct InboxInput {
    pub companies: CompaniesIn,
}

/// The inbox as the API reports it: `companies` is `"*"`, the admitted slugs,
/// or `[]` when closed.
#[derive(Debug, Serialize)]
pub struct InboxView {
    pub session: String,
    pub open: bool,
    pub companies: serde_json::Value,
}

fn owner_only(ctx: &OptCtx) -> Result<(), AppError> {
    if Scope::of(ctx.0.as_ref()) == Scope::All {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "opening a bot to messages from companies is owner/admin only".into(),
        ))
    }
}

async fn hq_session(state: &AppState, name: &str) -> Result<db::sessions::Session, AppError> {
    db::sessions::get(&state.pool, name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{name}'")))
}

async fn view(state: &AppState, name: &str) -> Result<InboxView, AppError> {
    let companies = match db::company_inbox::get(&state.pool, name).await? {
        None => json!([]),
        Some(Accepts::All) => json!("*"),
        Some(Accepts::Only(ids)) => {
            let mut slugs = Vec::new();
            for id in ids {
                if let Some(c) = db::companies::get(&state.pool, id).await? {
                    slugs.push(c.slug);
                }
            }
            slugs.sort();
            json!(slugs)
        }
    };
    let open = companies != json!([]);
    Ok(InboxView {
        session: name.to_string(),
        open,
        companies,
    })
}

/// Resolve the body to what is stored. Unknown slugs and an empty list are a
/// 400: closing is `DELETE`, and a typo must not quietly admit nobody.
async fn accepts_from(state: &AppState, input: CompaniesIn) -> Result<Accepts, AppError> {
    match input {
        CompaniesIn::All(s) if s.trim() == "*" => Ok(Accepts::All),
        CompaniesIn::All(s) => Err(AppError::BadRequest(format!(
            "'companies' is \"*\" or a list of company slugs, not {s:?}"
        ))),
        CompaniesIn::Only(slugs) => {
            let mut ids = Vec::new();
            for slug in slugs.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                let company = db::companies::get_by_slug(&state.pool, slug)
                    .await?
                    .ok_or_else(|| AppError::BadRequest(format!("unknown company '{slug}'")))?;
                if !ids.contains(&company.id) {
                    ids.push(company.id);
                }
            }
            if ids.is_empty() {
                return Err(AppError::BadRequest(
                    "list at least one company, or DELETE to close the inbox".into(),
                ));
            }
            Ok(Accepts::Only(ids))
        }
    }
}

pub(crate) async fn get_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path(name): Path<String>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    owner_only(&ctx)?;
    hq_session(&state, &name).await?;
    Ok(super::ok(view(&state, &name).await?))
}

pub(crate) async fn put_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path(name): Path<String>,
    axum::Json(input): axum::Json<InboxInput>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    owner_only(&ctx)?;
    let session = hq_session(&state, &name).await?;
    if session.company_id.is_some() {
        return Err(AppError::BadRequest(
            "only an HQ (company-less) bot has a company inbox; a company bot already \
             hears its own company"
                .into(),
        ));
    }
    let accepts = accepts_from(&state, input.companies).await?;
    db::company_inbox::set(&state.pool, &name, &accepts).await?;
    let out = view(&state, &name).await?;
    db::audit::log(
        &state.pool,
        "user",
        "session.company_inbox",
        &name,
        json!({ "companies": out.companies }),
    )
    .await?;
    Ok(super::ok(out))
}

pub(crate) async fn delete_handler(
    State(state): State<AppState>,
    ctx: OptCtx,
    Path(name): Path<String>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    owner_only(&ctx)?;
    hq_session(&state, &name).await?;
    if db::company_inbox::clear(&state.pool, &name).await? {
        db::audit::log(
            &state.pool,
            "user",
            "session.company_inbox",
            &name,
            json!({ "companies": [] }),
        )
        .await?;
    }
    Ok(super::ok(view(&state, &name).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth_human::AuthContext;

    async fn state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-inbox-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
            swarm_reaper: Default::default(),
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
            company_isolation: Vec::new(),
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    async fn seed(state: &AppState, name: &str, company: Option<i64>) {
        db::sessions::insert_minimal(&state.pool, name, "/tmp", "claude")
            .await
            .unwrap();
        sqlx::query("UPDATE sessions SET company_id = ? WHERE name = ?")
            .bind(company)
            .bind(name)
            .execute(&state.pool)
            .await
            .unwrap();
    }

    fn put(companies: serde_json::Value) -> axum::Json<InboxInput> {
        axum::Json(serde_json::from_value(json!({ "companies": companies })).unwrap())
    }

    #[tokio::test]
    async fn owner_opens_closes_and_every_change_is_audited() {
        let (state, dir) = state().await;
        let acme = db::companies::create(&state.pool, "acme", "Acme", "/srv/acme")
            .await
            .unwrap();
        seed(&state, "max", None).await;

        put_handler(
            State(state.clone()),
            OptCtx(None),
            Path("max".into()),
            put(json!(["acme"])),
        )
        .await
        .expect("owner opens to one company");
        assert_eq!(
            db::company_inbox::get(&state.pool, "max").await.unwrap(),
            Some(Accepts::Only(vec![acme.id]))
        );
        put_handler(
            State(state.clone()),
            OptCtx(None),
            Path("max".into()),
            put(json!("*")),
        )
        .await
        .expect("owner opens to all");
        assert_eq!(
            db::company_inbox::get(&state.pool, "max").await.unwrap(),
            Some(Accepts::All)
        );
        delete_handler(State(state.clone()), OptCtx(None), Path("max".into()))
            .await
            .expect("owner closes");
        assert_eq!(
            db::company_inbox::get(&state.pool, "max").await.unwrap(),
            None
        );

        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM audit_log WHERE action = 'session.company_inbox'")
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(n, 3);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn refuses_a_company_bot_unknown_slugs_an_empty_list_and_a_scoped_human() {
        let (state, dir) = state().await;
        let acme = db::companies::create(&state.pool, "acme", "Acme", "/srv/acme")
            .await
            .unwrap();
        seed(&state, "max", None).await;
        seed(&state, "acme-bot", Some(acme.id)).await;

        let bad = |r: Result<_, AppError>| matches!(r, Err(AppError::BadRequest(_)));
        assert!(bad(put_handler(
            State(state.clone()),
            OptCtx(None),
            Path("acme-bot".into()),
            put(json!("*"))
        )
        .await
        .map(|_| ())));
        assert!(bad(put_handler(
            State(state.clone()),
            OptCtx(None),
            Path("max".into()),
            put(json!(["nope"]))
        )
        .await
        .map(|_| ())));
        assert!(bad(put_handler(
            State(state.clone()),
            OptCtx(None),
            Path("max".into()),
            put(json!([]))
        )
        .await
        .map(|_| ())));
        assert!(bad(put_handler(
            State(state.clone()),
            OptCtx(None),
            Path("max".into()),
            put(json!("all"))
        )
        .await
        .map(|_| ())));

        // A human fenced to a company may not open an HQ bot — not even one it
        // could otherwise address.
        let member = OptCtx(Some(AuthContext::Human {
            user_id: 1,
            company_id: Some(acme.id),
            role: "admin".into(),
        }));
        let res = put_handler(
            State(state.clone()),
            member,
            Path("max".into()),
            put(json!("*")),
        )
        .await;
        assert!(matches!(res, Err(AppError::Forbidden(_))));
        assert_eq!(
            db::company_inbox::get(&state.pool, "max").await.unwrap(),
            None
        );
        std::fs::remove_dir_all(dir).ok();
    }
}
