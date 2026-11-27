//! Owner-managed Agent Skills packages and the same grant targets as connectors.
mod launch;
mod sources;

use crate::{
    error::AppError,
    scope::{self, OptCtx, Scope},
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
pub use launch::{cleanup, prepare, record};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

type Files = BTreeMap<String, String>; // relative path -> base64, including binary resources
type Reply = Result<Json<Value>, AppError>;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/agent-skills", get(list))
        .route("/api/agent-skills/-/sources", get(sources::browse))
        .route(
            "/api/agent-skills/{name}",
            get(detail).put(save).delete(remove),
        )
        .route(
            "/api/agent-skills/{name}/grant",
            axum::routing::put(grant).delete(revoke),
        )
        .with_state(state)
}

fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}
fn missing() -> AppError {
    AppError::NotFound("Skill or target not found".into())
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
}

fn validate(name: &str, files: &Files) -> Result<String, AppError> {
    if !valid_name(name) {
        return Err(bad(
            "Use a lowercase skill name with letters, digits and single hyphens",
        ));
    }
    if files.len() > 512 || files.values().map(String::len).sum::<usize>() > 1_800_000 {
        return Err(bad(
            "A skill can contain up to 512 files and 1.3 MiB of content",
        ));
    }
    let mut paths = BTreeMap::new();
    for (path, encoded) in files {
        if path.len() > 1024
            || path.contains('\\')
            || path.contains(':')
            || path.chars().any(char::is_control)
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".." || part.len() > 255)
        {
            return Err(bad("Invalid relative skill file path"));
        }
        // Reject file/directory and case-folding collisions before writing on either OS.
        let mut prefix = String::new();
        for part in path.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let value = (prefix.clone(), prefix == *path);
            if paths
                .insert(prefix.to_lowercase(), value.clone())
                .is_some_and(|old| old != value)
            {
                return Err(bad("Conflicting skill file paths"));
            }
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| bad("Invalid file encoding"))?;
        if path.to_lowercase().ends_with(".md") && std::str::from_utf8(&bytes).is_err() {
            return Err(bad("Markdown files must contain UTF-8 text"));
        }
    }
    let bytes = STANDARD
        .decode(
            files
                .get("SKILL.md")
                .ok_or_else(|| bad("SKILL.md is required"))?,
        )
        .map_err(|_| bad("Invalid SKILL.md"))?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| bad("Invalid SKILL.md"))?
        .replace("\r\n", "\n");
    let header = text
        .strip_prefix("---\n")
        .and_then(|s| {
            s.split_once("\n---\n")
                .map(|(h, _)| h)
                .or_else(|| s.strip_suffix("\n---"))
        })
        .ok_or_else(|| bad("SKILL.md needs YAML frontmatter with name and description"))?;
    let meta: Metadata = serde_yaml_ng::from_str(header)
        .map_err(|_| bad("SKILL.md needs a valid YAML name and description"))?;
    if meta.name != name || meta.description.trim().is_empty() {
        return Err(bad(
            "The SKILL.md name must match the package and its description must be nonempty",
        ));
    }
    Ok(meta.description)
}
#[derive(Deserialize)]
struct Metadata {
    name: String,
    description: String,
}

#[derive(Deserialize)]
struct Save {
    files: Files,
    revision: Option<String>,
}

async fn save(
    State(s): State<AppState>,
    ctx: OptCtx,
    Path(name): Path<String>,
    Json(body): Json<Save>,
) -> Reply {
    scope::require_admin(ctx.0.as_ref(), "/api/agent-skills")?;
    let description = validate(&name, &body.files)?;
    let revision = uuid::Uuid::new_v4().to_string();
    let files = serde_json::to_string(&body.files).map_err(anyhow::Error::from)?;
    let changed = match body.revision {
        None => sqlx::query("INSERT INTO skill_packages (name,files,description,revision) VALUES (?,?,?,?) ON CONFLICT DO NOTHING")
            .bind(name).bind(files).bind(description).bind(&revision).execute(&s.pool).await?,
        Some(old) => sqlx::query("UPDATE skill_packages SET files=?,description=?,revision=? WHERE name=? AND revision=?")
            .bind(files).bind(description).bind(&revision).bind(name).bind(old).execute(&s.pool).await?,
    };
    if changed.rows_affected() == 0 {
        return Err(AppError::Conflict(
            "Skill changed. Reload the saved version before saving again.".into(),
        ));
    }
    Ok(Json(json!({"revision":revision})))
}

#[derive(Deserialize)]
struct Revision {
    revision: String,
}
async fn remove(
    State(s): State<AppState>,
    ctx: OptCtx,
    Path(name): Path<String>,
    Query(q): Query<Revision>,
) -> Reply {
    scope::require_admin(ctx.0.as_ref(), "/api/agent-skills")?;
    let r = sqlx::query("DELETE FROM skill_packages WHERE name=? AND revision=?")
        .bind(name)
        .bind(q.revision)
        .execute(&s.pool)
        .await?;
    if r.rows_affected() == 0 {
        return Err(AppError::Conflict("Skill changed or was removed".into()));
    }
    Ok(Json(json!({"ok":true})))
}
async fn detail(State(s): State<AppState>, ctx: OptCtx, Path(name): Path<String>) -> Reply {
    scope::require_admin(ctx.0.as_ref(), "/api/agent-skills")?;
    let (files, revision): (String, String) =
        sqlx::query_as("SELECT files,revision FROM skill_packages WHERE name=?")
            .bind(&name)
            .fetch_one(&s.pool)
            .await?;
    let grants: Vec<(String, bool)> =
        sqlx::query_as("SELECT target,enabled FROM skill_grants WHERE skill=? ORDER BY target")
            .bind(name)
            .fetch_all(&s.pool)
            .await?;
    Ok(Json(
        json!({"grants":grants,"files": serde_json::from_str::<Files>(&files).map_err(anyhow::Error::from)?, "revision": revision}),
    ))
}

#[derive(Deserialize)]
struct Target {
    target: String,
}
#[derive(Deserialize)]
struct Toggle {
    enabled: bool,
}

async fn target_company(s: &AppState, ctx: &OptCtx, target: &str) -> Result<Option<i64>, AppError> {
    scope::authorize_connector_target(s, ctx.0.as_ref(), target).await?;
    sqlx::query_scalar("SELECT company_id FROM skill_targets WHERE target=?")
        .bind(target)
        .fetch_optional(&s.pool)
        .await?
        .ok_or_else(missing)
}

async fn grant(
    State(s): State<AppState>,
    ctx: OptCtx,
    Path(name): Path<String>,
    Query(q): Query<Target>,
    Json(body): Json<Toggle>,
) -> Reply {
    let company = target_company(&s, &ctx, &q.target).await?;
    // Check the same company at write time in case the bot moved during authorization.
    let r = sqlx::query(
        "INSERT INTO skill_grants(skill,target,enabled)
         SELECT p.name, t.target, ? FROM skill_packages p, skill_targets t
         WHERE p.name=? AND t.target=? AND t.company_id IS ?
         ON CONFLICT(skill,target) DO UPDATE SET enabled=excluded.enabled",
    )
    .bind(body.enabled)
    .bind(name)
    .bind(q.target)
    .bind(company)
    .execute(&s.pool)
    .await?;
    if r.rows_affected() == 0 {
        return Err(missing());
    }
    Ok(Json(json!({"ok":true})))
}
async fn revoke(
    State(s): State<AppState>,
    ctx: OptCtx,
    Path(name): Path<String>,
    Query(q): Query<Target>,
) -> Reply {
    let company = target_company(&s, &ctx, &q.target).await?;
    sqlx::query(
        "DELETE FROM skill_grants WHERE skill=? AND target=(
        SELECT target FROM skill_targets WHERE target=? AND company_id IS ?)",
    )
    .bind(name)
    .bind(q.target)
    .bind(company)
    .execute(&s.pool)
    .await?;
    Ok(Json(json!({"ok":true})))
}

#[derive(sqlx::FromRow, Serialize)]
struct Card {
    name: String,
    description: String,
    revision: String,
}
async fn list(State(s): State<AppState>, ctx: OptCtx, Query(q): Query<Target>) -> Reply {
    target_company(&s, &ctx, &q.target).await?;
    let cards: Vec<Card> =
        sqlx::query_as("SELECT name,description,revision FROM skill_packages ORDER BY name")
            .fetch_all(&s.pool)
            .await?;
    let grants: Vec<(String, String, bool)> = sqlx::query_as(
        "SELECT skill,target,enabled FROM skill_grants WHERE target=? ORDER BY skill",
    )
    .bind(&q.target)
    .fetch_all(&s.pool)
    .await?;
    let assignments: Vec<(String, String)> =
        sqlx::query_as("SELECT skill,source FROM effective_skill_grants WHERE target=?")
            .bind(&q.target)
            .fetch_all(&s.pool)
            .await?;
    let effective: BTreeMap<_, _> = assignments.into_iter().collect();
    let desired: BTreeMap<_, _> = cards
        .iter()
        .filter(|c| effective.contains_key(&c.name))
        .map(|c| (&c.name, &c.revision))
        .collect();
    let previous: Option<String> =
        sqlx::query_scalar("SELECT snapshot FROM skill_launches WHERE session=?")
            .bind(&q.target)
            .fetch_optional(&s.pool)
            .await?;
    let pending = !q.target.starts_with('@')
        && q.target != "*"
        && previous.as_deref().unwrap_or("{}")
            != serde_json::to_string(&desired).map_err(anyhow::Error::from)?;
    Ok(Json(
        json!({"skills": cards,"grants": grants,"effective":effective,"pending":pending,"can_edit":matches!(Scope::of(ctx.0.as_ref()),Scope::All)}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn package(name: &str) -> Files {
        Files::from([
            (
                "SKILL.md".into(),
                STANDARD.encode(format!(
                    "---\r\nname: {name}\r\ndescription: Review a release\r\n---\r\n"
                )),
            ),
            (
                "references/review.md".into(),
                STANDARD.encode("Crème brûlée"),
            ),
            ("assets/example.bin".into(), STANDARD.encode([0, 255, 1])),
        ])
    }

    #[test]
    fn validates_the_complete_package_before_storing_it() {
        assert!(validate("release", &package("release")).is_ok());
        assert!(validate("renamed", &package("release")).is_err());
        for path in [
            "../note.md",
            "/note.md",
            "references",
            "REFERENCES/review.md",
            "a\\b.md",
        ] {
            let mut files = package("release");
            files.insert(path.into(), String::new());
            assert!(validate("release", &files).is_err(), "{path}");
        }
    }

    #[tokio::test]
    async fn each_provider_receives_only_its_grants_and_revocation_removes_stale_files() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        for (name, provider) in [("one", "claude"), ("two", "codex")] {
            db::sessions::insert_minimal(&pool, name, "/tmp", provider)
                .await
                .unwrap();
        }
        let files = package("release");
        sqlx::query("INSERT INTO skill_packages VALUES('release',?,'Review','v1')")
            .bind(serde_json::to_string(&files).unwrap())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO skill_grants VALUES('release','one',1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO companies(id,slug,display_name,root_dir,created_at,updated_at) VALUES(1,'acme','Acme','/tmp/acme',0,0)")
            .execute(&pool).await.unwrap();
        sqlx::query("UPDATE sessions SET company_id=1 WHERE name='one'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO skill_grants VALUES('release','@company:1',1)")
            .execute(&pool)
            .await
            .unwrap();
        let selected = || {
            sqlx::query_scalar::<_, String>(
                "SELECT source FROM effective_skill_grants WHERE target='one' AND skill='release'",
            )
            .fetch_one(&pool)
        };
        assert_eq!(selected().await.unwrap(), "one");
        sqlx::query("UPDATE skill_grants SET enabled=0 WHERE target='one'")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(selected().await.unwrap(), "@company:1");
        let one = db::sessions::get(&pool, "one").await.unwrap().unwrap();
        let two = db::sessions::get(&pool, "two").await.unwrap().unwrap();
        let claude = prepare(&pool, &data, &one).await.unwrap();
        assert_eq!(claude.flags[0], "--add-dir");
        let reference = std::path::Path::new(&claude.flags[1])
            .join(".claude/skills/release/references/review.md");
        assert_eq!(std::fs::read_to_string(&reference).unwrap(), "Crème brûlée");
        assert!(prepare(&pool, &data, &two).await.unwrap().flags.is_empty());
        sqlx::query("INSERT INTO skill_grants VALUES('release','*',1)")
            .execute(&pool)
            .await
            .unwrap();
        let codex = prepare(&pool, &data, &two).await.unwrap();
        assert_eq!(codex.flags[0], "-c");
        assert!(codex.flags[1].contains("mcp_servers.supermux_skills"));
        // Exercise the same stdio exchange the Codex client uses, including a
        // nested UTF-8 document and a file absent from the grant.
        use std::{
            io::Write,
            process::{Command, Stdio},
        };
        let mut child = Command::new("python3")
            .arg(data.join("session-config/two/agent-skills/skills.py"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        for (id, method, params) in [
            (1, "tools/list", json!({})),
            (
                2,
                "tools/call",
                json!({"name":"release","arguments":{"file":"references/review.md"}}),
            ),
            (
                3,
                "tools/call",
                json!({"name":"release","arguments":{"file":"absent.md"}}),
            ),
        ] {
            writeln!(
                input,
                "{}",
                json!({"id":id,"jsonrpc":"2.0","method":method,"params":params})
            )
            .unwrap();
        }
        drop(input);
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let replies: Vec<Value> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(replies[0]["result"]["tools"][0]["name"], "release");
        assert!(replies[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Crème brûlée"));
        assert_eq!(replies[2]["result"]["isError"], true);
        record(&pool, "two", &codex).await.unwrap();
        assert_eq!(codex.snapshot, claude.snapshot);
        sqlx::query("DELETE FROM skill_packages")
            .execute(&pool)
            .await
            .unwrap();
        assert!(prepare(&pool, &data, &one).await.unwrap().flags.is_empty());
        assert!(!reference.exists());
        std::fs::remove_dir_all(data).unwrap();
    }
}
