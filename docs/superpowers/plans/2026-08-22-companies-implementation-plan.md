# Companies (Bot Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the flat single-tenant supermux dashboard into a small operational OS where a `Company` is a first-class named workspace that owns a folder + a set of agents, isolated server-side (files, delegation, connector credentials, and an OS sandbox), with company-less bots (`company_id IS NULL`) staying omniscient main/PA bots.

**Architecture:** `company_id` is a **plain nullable `INTEGER`** filter attribute on `sessions` (NULL = main bot). Session slugs stay **globally unique** — company is only a `WHERE` predicate + a client-side filter, so none of the ~20 slug-keyed in-memory `DashMap`s, the native spool path, the hook-token store, or the tmux session names ever gain a company dimension. Isolation is layered: a server-enforced Files jail + delegation gate + query scoping (cheap, seam already exists), a P0 **secret-floor** (per-company `CLAUDE_CONFIG_DIR` on the child env per-spawn), and a P1 kernel-enforced **OS sandbox** (`IsolationProvider`: Landlock on Linux via `pre_exec` + `restrict_self()`, Seatbelt on macOS, Noop fallback) applied per-spawn only to company agents.

**Tech Stack:** Rust (axum / tokio / sqlx runtime `query_as` + `FromRow`, SQLite WAL + `foreign_keys=ON`), React / TypeScript / Vite / Tailwind / Bun, rust-landlock (`ABI::V4` + `CompatLevel::BestEffort`, P1), XChaCha20-Poly1305 secretbox vault (P2), Cloudflare tunnel + Google OIDC (P3).

**Spec:** `/opt/projects/supermux-companies/docs/superpowers/specs/2026-08-22-companies-botmode-design.md` (read it alongside this plan — the plan argues from it; every `file:line` anchor below is verified against `feat/companies` head).

## Global Constraints

- **Worktree only.** Work exclusively in `/opt/projects/supermux-companies` on branch `feat/companies` (off `origin/main`). NEVER touch other worktrees/branches. Do not push; the owner reviews all merges.
- **Migrations are immutable once shipped.** New file only, never edit any `server/migrations/*` (even a comment) — sqlx checksums them; a mismatch bricks a deployed install. **Next free number is `0030`** (`0006`/`0025` are permanent gaps; tail is `0029_session_seen.sql`).
- **FK-on ADD COLUMN rule.** Under `PRAGMA foreign_keys=ON`, SQLite refuses `ALTER TABLE … ADD COLUMN … REFERENCES … DEFAULT '<non-null>'`. A nullable, no-default inline `REFERENCES` is fine (`host_id` in 0018). `sessions.company_id` is a **plain nullable `INTEGER`, no default, no inline `REFERENCES`** (integrity in the app layer + delete triggers).
- **`company_id IS NULL` is the one fact that defines a main/PA/tech-admin bot** everywhere — the delegation bypass, the jail-off, the no-confinement gate all key on it, never on a caller-declared field (`actor`, body-supplied `from`).
- **Slugs stay globally unique.** `sessions.name` is the PK, tmux/native session name, `$SUPERMUX_SESSION`, route segment, hook-token key, spool path. Company is NEVER part of any key. Per-company *display names* may repeat; the slug never does.
- **Gates, every slice.** Server: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo check` (DEBUG). Web: `cd web && OPENSSL_NO_VENDOR=1 bun run build:perf` + `bunx tsc -b` (or `bun run typecheck`). **NEVER `cargo build/test --release`** (OOM-thrashes the host). **NEVER** bounded `{m,n}` quantifiers with ripgrep `-o` / the Grep tool on long-line files.
- **Deploy each slice ALONE** from this worktree via a manual deploy-request (`source_dir=` this worktree — MEMORY: deploy-branch-from-worktree), and let the owner verify visually before the next slice. **Never restart the hosting instance unasked**; test side-by-side on another port where a live check is needed.
- **P0 is behavior-neutral for existing (NULL) sessions.** The entire current fleet backfills to `company_id = NULL` and keeps behaving exactly as today.

---

## A. Overview — the phase map & ship order

Five independently-shippable units, in ship order. Each states its one-line done-definition and the owner-visible check.

| # | Slice | Done-definition (one line) | Owner-visible check |
| --- | --- | --- | --- |
| 0 | **Deploy prereq — `@sandbox` unit line** | `supermux.service` carries `SystemCallFilter=@sandbox` and the service still boots green | Service restarts cleanly; `systemctl show supermux -p SystemCallFilter` lists `@sandbox`; nothing in the dashboard changes |
| 1 | **P0 — data-model + secret-floor** | Migration 0030 applied (count 27→28), `company_id` threaded through the 5 Rust + 3 web types, companies CRUD live, create-time dir-forcing + per-child `CLAUDE_CONFIG_DIR` in place; all gates green | A create/list curl shows a company exists and a company-scoped session carries its `company_id` with `dir` forced under `root_dir`; **the dashboard looks identical** (that is the point) |
| 2 | **P1 — companies + switcher + isolation backend** | Files jail flips on, delegation gate + silent-404 + graph filter live, `<CompanySwitcher>` scopes the whole app, `IsolationProvider`/Landlock/startup-probe land | Owner picks a company → roster, teams, Files all narrow; a new agent lands in that company's folder; the PA still reaches everyone; a cross-company delegate curl 404s; the session log records the measured isolation level |
| 3 | **P2 — connectors + vault + UI badge + strict + TCP** | `company_connectors` materialize per-company at start into the secret-floor dir, sealed at rest by the vault, manager sheet shows scope; per-session isolation badge, `StrictRequired`, ABI-v4 TCP rule | Owner configures Slack for Company X and Y with different tokens; each company's bot picks up its own on start; the sheet shows "inherited from company"; each session shows its isolation level |
| 4 | **P3 — external humans + macOS backend** | Per-company Cloudflare tunnel + Google login + human-auth middleware, per-company SSE channels, per-message human provenance, audit attribution, iCal gating, owner/admin/member; SeatbeltMacOS on-demand | Owner invites a colleague to one company; the colleague logs in via Google, chats with only that company's agents; the owner sees the colleague's name on each message and in the audit log |

**Sequencing law (see §E):** slice 0 (`@sandbox`) is independent and ships first or alongside P0 — it is a no-op until the Landlock backend (P1) lands, and self-verifies via the P1 probe. The **secret-floor is independent of `@sandbox`** — it holds on every host including Noop. P1's Landlock backend is *dead code* (measures `None`) until slice 0 has shipped, so slice 0 must precede P1's owner-verify.

---

## B. P0 — execution-ready tasks

**File structure for P0.**
- Create `server/migrations/0030_companies.sql` — the schema (companies, `sessions.company_id`, `human_users` seed, `company_connectors` + triggers).
- Create `server/src/db/companies.rs` — the companies DB module (`list`/`get`/`create`/`set_display_name`/`archive`/`delete`), modeled on `db/hosts.rs`.
- Create `server/src/companies/mod.rs` — the HTTP router (`GET/POST /api/companies`, `PATCH/DELETE /api/companies/{id}`), modeled on `agents::router_for`.
- Modify `server/src/db/sessions.rs` — `Session` struct, `NewSession` struct, `create` INSERT, `duplicate` INSERT + a `set_dir` helper.
- Modify `server/src/sessions/mod.rs` — `CreateInput`, `SessionView`, `view()`, the create-time dir-forcing, the `duplicate` handler re-derive.
- Modify `server/src/sessions/lifecycle.rs` — `build_env` gains company context → per-child `CLAUDE_CONFIG_DIR`.
- Modify `server/src/db/mod.rs` — bump the applied-migration assertion 27→28 + new company regression tests.
- Modify `server/src/http.rs` — merge the companies router.
- Modify `server/src/db.rs`/module tree + `server/src/lib.rs` (or `main.rs` module decls) — register `companies` modules.
- Modify `web/src/lib/api/sessions.ts` — `company_id?` on `SessionSummary`, `ApiSession`, `NewSession`.

The tasks are **strictly ordered**: 1 (migration) must land before 2 (assertion/regression tests read the new schema), before 3 (Rust types read the column), before 6 (create-dir uses the threaded field), etc.

---

### Task P0.1 — Migration 0030 (schema + seed + triggers)

**Files:**
- Create: `server/migrations/0030_companies.sql`

**Interfaces:**
- Produces: tables `companies(id,slug,display_name,root_dir,archived,created_at,updated_at)`, column `sessions.company_id INTEGER` (nullable, no default), `idx_sessions_company`, table `human_users(id,email,display_name,company_id,role,created_at)` seeded with one owner row, table `company_connectors(id,company_id,name,config_json,target_session,created_at,updated_at)`, `idx_company_connectors_company`, triggers `trg_company_delete_connectors` + `trg_company_delete_sessions`.

- [ ] **Step 1: Write the failing test** — reuse the existing count assertion as the "test." In `server/src/db/mod.rs:116`, the assertion currently reads `27`. Leave it at `27` for this step so the migration-count test *fails* the moment 0030 applies, proving the new migration ran. (The bump is Task P0.2.)

- [ ] **Step 2: Author the migration.** Create `server/migrations/0030_companies.sql` with exactly the SQL from spec §3.2 (verbatim — it is the reviewed schema):

```sql
-- 0030_companies.sql
-- Companies (Bot Mode): company registry, a nullable company_id filter attribute
-- on sessions (NULL = main/PA/tech-admin bots), a seeded human_users owner row
-- (dormant until P3), and the P2 company_connectors store.
-- IMMUTABLE ONCE SHIPPED. sessions.company_id is a PLAIN NULLABLE INTEGER, NO
-- default, inline REFERENCES DELIBERATELY omitted (allowed here — the FK-on trap
-- is only a NON-NULL DEFAULT on an ADD COLUMN, not the REFERENCES itself).
-- Integrity is enforced in the application layer + the trg_company_delete_* triggers.

CREATE TABLE companies (
    id           INTEGER PRIMARY KEY,
    slug         TEXT    NOT NULL UNIQUE,
    display_name TEXT    NOT NULL,
    root_dir     TEXT    NOT NULL,
    archived     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

ALTER TABLE sessions ADD COLUMN company_id INTEGER;
CREATE INDEX idx_sessions_company ON sessions(company_id);

CREATE TABLE human_users (
    id           INTEGER PRIMARY KEY,
    email        TEXT    NOT NULL UNIQUE,
    display_name TEXT    NOT NULL,
    company_id   INTEGER,
    role         TEXT    NOT NULL DEFAULT 'member'
                   CHECK (role IN ('owner','admin','member')),
    created_at   INTEGER NOT NULL
);

-- Sentinel email; the real owner email is bound at startup from config (§7),
-- never hardcoded into a checksummed, world-readable migration.
INSERT INTO human_users (email, display_name, company_id, role, created_at)
VALUES ('owner@localhost', 'Owner', NULL, 'owner',
        CAST(strftime('%s','now') AS INTEGER));

CREATE TABLE company_connectors (
    id             INTEGER PRIMARY KEY,
    company_id     INTEGER NOT NULL,
    name           TEXT    NOT NULL,
    config_json    TEXT    NOT NULL,
    target_session TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_company_connectors_company ON company_connectors(company_id);

CREATE TRIGGER trg_company_delete_connectors
AFTER DELETE ON companies BEGIN
    DELETE FROM company_connectors WHERE company_id = OLD.id;
END;
CREATE TRIGGER trg_company_delete_sessions
AFTER DELETE ON companies BEGIN
    UPDATE sessions SET company_id = NULL WHERE company_id = OLD.id;
END;
```

- [ ] **Step 3: Run the FK-on migration test to prove the schema is FK-on-legal.**

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server db::mod::tests::migrations_apply_under_foreign_keys_enforced`
Expected: PASS (the whole chain incl. 0030 applies under `foreign_keys=ON`; proves the ADD COLUMN carries no illegal non-null-default REFERENCES).

- [ ] **Step 4: Run the count test and confirm it now FAILS at 28-vs-27.**

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server db::mod::tests::migrations`
Expected: the count assertion FAILS `left: 28, right: 27` — proving 0030 applied. (Fixed in P0.2.)

- [ ] **Step 5: Commit**

```bash
git add server/migrations/0030_companies.sql
git commit -m "feat(companies): migration 0030 — companies, sessions.company_id, human_users seed, company_connectors"
```

---

### Task P0.2 — Bump the applied-migration assertion + company regression tests

**Files:**
- Modify: `server/src/db/mod.rs:116-118` (the count assertion + message) and add tests in the same `#[cfg(test)] mod tests` block.

**Interfaces:**
- Consumes: the 0030 schema (Task P0.1).
- Produces: passing count test at 28; three company regression tests mirroring the board_id pattern at `db/mod.rs:124-218`.

- [ ] **Step 1: Write the failing regression test** — add, in the tests module beside `migration_0015_seeds_main_board_and_backfills_existing_cards`:

```rust
#[tokio::test]
async fn migration_0030_backfills_null_company_and_cascades_on_delete() {
    let (pool, dir) = test_pool().await;
    let now = chrono::Utc::now().timestamp();

    // A legacy session (no company_id in the INSERT column list) backfills to NULL.
    sqlx::query(
        "INSERT INTO sessions (name, dir, desc, provider, flags, pinned, archived,
             auto_continue, auto_continue_msg, rate_limit_resume_text, tags, creator,
             branch, worktree, worktree_repo, mcp, created_at, start_count, last_started,
             last_send, last_send_text, task_summary, cc_session_name, cc_conversation_id,
             codex_session_id, start_error)
         VALUES ('legacy', '/home/x', '', 'claude', '', 0, 0, 0, '', '', '[]', '',
                 '', 0, '', '', ?, 0, 0, 0, '', '', '', '', '', '')",
    ).bind(now).execute(&pool).await.unwrap();
    let cid: Option<i64> =
        sqlx::query_scalar("SELECT company_id FROM sessions WHERE name = 'legacy'")
            .fetch_one(&pool).await.unwrap();
    assert_eq!(cid, None, "existing fleet backfills to NULL = main bot");

    // Create a company + a member session + a connector row.
    sqlx::query("INSERT INTO companies (slug, display_name, root_dir, created_at, updated_at)
                 VALUES ('acme', 'Acme', '/srv/acme', ?, ?)")
        .bind(now).bind(now).execute(&pool).await.unwrap();
    let acme: i64 = sqlx::query_scalar("SELECT id FROM companies WHERE slug='acme'")
        .fetch_one(&pool).await.unwrap();
    sqlx::query("UPDATE sessions SET company_id = ? WHERE name = 'legacy'")
        .bind(acme).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO company_connectors (company_id, name, config_json, created_at, updated_at)
                 VALUES (?, 'slack', '{}', ?, ?)")
        .bind(acme).bind(now).bind(now).execute(&pool).await.unwrap();

    // Deleting the company NULLs its sessions and drops its connectors (triggers).
    sqlx::query("DELETE FROM companies WHERE id = ?").bind(acme).execute(&pool).await.unwrap();
    let cid_after: Option<i64> =
        sqlx::query_scalar("SELECT company_id FROM sessions WHERE name = 'legacy'")
            .fetch_one(&pool).await.unwrap();
    assert_eq!(cid_after, None, "trg_company_delete_sessions NULLs member sessions");
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM company_connectors WHERE company_id = ?")
        .bind(acme).fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0, "trg_company_delete_connectors cascades");

    // The seeded owner row exists exactly once.
    let owners: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM human_users WHERE role='owner'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(owners, 1, "exactly one seeded owner row");

    pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}
```

(If the exact legacy `INSERT` column set drifts, copy the minimal-insert used by an existing sessions test — the point is a column list that omits `company_id`.)

- [ ] **Step 2: Run it and watch the count test fail, the regression test pass.**

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server db::mod::tests`
Expected: `migration_0030_backfills_null_company_and_cascades_on_delete` PASSES; the count test still FAILS at 28-vs-27.

- [ ] **Step 3: Bump the assertion.** Edit `server/src/db/mod.rs:116-118`:

```rust
        assert_eq!(
            applied, 28,
            "expected twenty-eight applied migrations (0001-0005, 0007-0024, 0026-0030)"
        );
```

- [ ] **Step 4: Run the full db test module.**

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server db::mod::tests`
Expected: PASS (count = 28, FK-on chain applies, company regression + board regression all green).

- [ ] **Step 5: Commit**

```bash
git add server/src/db/mod.rs
git commit -m "test(companies): bump applied-migration count 27->28 + 0030 backfill/cascade regression"
```

---

### Task P0.3 — Thread `company_id` through the `Session` read model + `db/sessions` create/duplicate

**Files:**
- Modify: `server/src/db/sessions.rs` — `Session` struct (add field next to `host_id` at `:56`), `NewSession` struct (`:363`), `create` INSERT (`:391-416`), `duplicate` INSERT (`:458`), add `set_dir` helper.

**Interfaces:**
- Consumes: the `company_id` column (P0.1).
- Produces: `Session.company_id: Option<i64>`; `NewSession.company_id: Option<i64>`; `create()` persists it; `duplicate()` inherits it; `pub async fn set_dir(pool, name, dir) -> sqlx::Result<()>`.

- [ ] **Step 1: Write the failing test** — in the `db::sessions` tests (or the db mod tests), assert create persists and duplicate inherits `company_id`:

```rust
#[tokio::test]
async fn create_persists_company_id_and_duplicate_inherits_it() {
    let (pool, dir) = test_pool().await;
    let now = chrono::Utc::now().timestamp();
    sqlx::query("INSERT INTO companies (slug, display_name, root_dir, created_at, updated_at)
                 VALUES ('acme','Acme','/srv/acme',?,?)").bind(now).bind(now)
        .execute(&pool).await.unwrap();
    let acme: i64 = sqlx::query_scalar("SELECT id FROM companies WHERE slug='acme'")
        .fetch_one(&pool).await.unwrap();

    let mut ns = NewSession {
        name: "bot-a".into(), display_name: "bot-a".into(), dir: "/srv/acme/bot-a".into(),
        desc: String::new(), provider: "claude".into(), creator: String::new(),
        flags: String::new(), tags: "[]".into(), branch: String::new(), mcp: String::new(),
        worktree: false, worktree_repo: String::new(), host_id: None,
        runtime: "native".into(), company_id: Some(acme),
    };
    create(&pool, &ns).await.unwrap();
    let got = get(&pool, "bot-a").await.unwrap().unwrap();
    assert_eq!(got.company_id, Some(acme));

    duplicate(&pool, "bot-a", "bot-a-copy").await.unwrap();
    let copy = get(&pool, "bot-a-copy").await.unwrap().unwrap();
    assert_eq!(copy.company_id, Some(acme), "duplicate inherits company_id");

    let _ = &mut ns;
    pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}
```

- [ ] **Step 2: Run it — fails to compile** (`NewSession` has no `company_id`, `Session` has no `company_id`).

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server db::sessions 2>&1 | head`
Expected: FAIL — "struct `NewSession` has no field named `company_id`".

- [ ] **Step 3: Implement the thread.**
  - In `Session` (after `host_id` at `:56`): add
    ```rust
    /// The company this session belongs to (migration 0030), or `NULL` for a
    /// main/PA/tech-admin bot. `FromRow` picks up the new column.
    pub company_id: Option<i64>,
    ```
  - In `NewSession` (after `host_id`): add `pub company_id: Option<i64>,`.
  - In `create` INSERT (`:391`): add `company_id` to the column list and a `?`, and add `.bind(s.company_id)` in the matching position:
    ```sql
    (name, display_name, dir, desc, provider, creator, flags, tags, branch, mcp,
     worktree, worktree_repo, host_id, company_id, runtime, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ```
    (insert `.bind(s.company_id)` between the `host_id` and `runtime` binds).
  - In `duplicate` INSERT (`:458`): add `company_id` to BOTH the column list and the `SELECT` list so the clone inherits it:
    ```sql
    (name, display_name, dir, desc, provider, flags, pinned, auto_continue, auto_continue_msg,
     rate_limit_resume_text, tags, creator, branch, worktree, worktree_repo, mcp,
     host_id, company_id, runtime, notif, mark_pin, created_at)
    SELECT ?, ?, dir, desc, provider, flags, 0, auto_continue, auto_continue_msg,
           rate_limit_resume_text, tags, creator, branch, worktree, worktree_repo, mcp,
           host_id, company_id, runtime, notif, mark_pin, ?
    ```
  - Add a `set_dir` helper (modeled on `set_runtime` at `:~430`):
    ```rust
    /// Durably set a session's working directory. Used by the create-time and
    /// duplicate-time dir-forcing (§4.1) to move a company clone under its own
    /// `<root_dir>/<name>/` after the row is inserted.
    pub async fn set_dir(pool: &SqlitePool, name: &str, dir: &str) -> sqlx::Result<()> {
        sqlx::query("UPDATE sessions SET dir = ? WHERE name = ?")
            .bind(dir).bind(name).execute(pool).await?;
        Ok(())
    }
    ```

- [ ] **Step 4: Run it — passes.**

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server db::sessions`
Expected: PASS. (Any other construction of `NewSession` in tests/non-test code now needs `company_id: None` — fix those compile errors by adding `company_id: None`.)

- [ ] **Step 5: Commit**

```bash
git add server/src/db/sessions.rs
git commit -m "feat(companies): thread company_id through Session/NewSession/create/duplicate + set_dir helper"
```

---

### Task P0.4 — Surface `company_id` on the read path (`CreateInput`, `SessionView`, `view()`)

**Files:**
- Modify: `server/src/sessions/mod.rs` — `CreateInput` (near `host_id` at `:943`), `SessionView` (`:194`), `view()` (`:431`).

**Interfaces:**
- Consumes: `Session.company_id` (P0.3).
- Produces: `SessionView.company_id: Option<i64>` (the read-path addition `host_id` never got); `CreateInput.company_id: Option<i64>`. NOTE: do **not** add `company_id` to `ConfigInput` — membership is fixed at create (decision #11).

- [ ] **Step 1: Write the failing test** — an HTTP-level or `view()`-level assertion that a company session's `SessionView` carries `company_id`. If a `view()` unit test harness exists, assert on it; otherwise add to the sessions handler tests:

```rust
#[tokio::test]
async fn session_view_surfaces_company_id() {
    // build a Session with company_id = Some(7); call view(&s, None, None, None)
    let mut s = /* a minimal Session, e.g. via the existing test constructor */;
    s.company_id = Some(7);
    let v = view(&s, None, None, None);
    assert_eq!(v.company_id, Some(7));
}
```

- [ ] **Step 2: Run — fails** (`SessionView` has no `company_id`).

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server sessions::session_view 2>&1 | head`
Expected: FAIL — no field `company_id` on `SessionView`.

- [ ] **Step 3: Implement.**
  - `SessionView` (after `host_id` if present, else beside `creator`):
    ```rust
    /// The company this session belongs to (migration 0030), or `null` for a
    /// main/PA bot. The read-path addition host_id never got — the switcher
    /// reads this to scope the roster (§5).
    pub company_id: Option<i64>,
    ```
  - `view()` — set it from the row: `company_id: s.company_id,`.
  - `CreateInput` — after the `host_id` field (`:943`):
    ```rust
    /// The company a new session is created into (migration 0030). Absent /
    /// null => a main bot (company_id NULL). When set, the create path forces
    /// `dir` under the company's `root_dir/<name>/` and rejects any other dir (§4.1).
    #[serde(default)]
    pub company_id: Option<i64>,
    ```

- [ ] **Step 4: Run — passes.**

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server sessions::session_view`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/mod.rs
git commit -m "feat(companies): surface company_id on SessionView/view() + accept it on CreateInput"
```

---

### Task P0.5 — `db/companies.rs` module

**Files:**
- Create: `server/src/db/companies.rs`
- Modify: `server/src/db/mod.rs` (add `pub mod companies;`)

**Interfaces:**
- Produces:
  ```rust
  #[derive(Debug, Clone, sqlx::FromRow, Serialize)]
  pub struct Company { pub id: i64, pub slug: String, pub display_name: String,
      pub root_dir: String, pub archived: i64, pub created_at: i64, pub updated_at: i64 }
  pub async fn list(pool, include_archived: bool) -> sqlx::Result<Vec<Company>>;
  pub async fn get(pool, id: i64) -> sqlx::Result<Option<Company>>;
  pub async fn get_by_slug(pool, slug: &str) -> sqlx::Result<Option<Company>>;
  pub async fn create(pool, slug, display_name, root_dir) -> sqlx::Result<Company>;
  pub async fn set_display_name(pool, id, display_name) -> sqlx::Result<bool>;
  pub async fn set_archived(pool, id, archived: bool) -> sqlx::Result<bool>;
  pub async fn delete(pool, id) -> sqlx::Result<bool>;
  pub async fn active_session_count(pool, id) -> sqlx::Result<i64>;
  ```
  (`set_display_name` only — there is NO `rename`/`set_slug`: slug is immutable, decision #2/#3.)

- [ ] **Step 1: Write the failing test** in `db/companies.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::mod_test_pool_or_similar as _; // use the crate's test_pool()

    #[tokio::test]
    async fn create_list_archive_delete_roundtrip() {
        let (pool, dir) = crate::db::test_pool().await;
        let c = create(&pool, "acme", "Acme", "/srv/acme").await.unwrap();
        assert_eq!(c.slug, "acme");
        assert_eq!(c.archived, 0);
        assert_eq!(list(&pool, false).await.unwrap().len(), 1);
        assert!(set_display_name(&pool, c.id, "Acme Corp").await.unwrap());
        assert_eq!(get(&pool, c.id).await.unwrap().unwrap().display_name, "Acme Corp");
        assert!(set_archived(&pool, c.id, true).await.unwrap());
        assert_eq!(list(&pool, false).await.unwrap().len(), 0, "archived hidden by default");
        assert_eq!(list(&pool, true).await.unwrap().len(), 1, "included when asked");
        assert_eq!(active_session_count(&pool, c.id).await.unwrap(), 0);
        assert!(delete(&pool, c.id).await.unwrap());
        assert!(get(&pool, c.id).await.unwrap().is_none());
        pool.close().await; let _ = std::fs::remove_dir_all(dir);
    }
}
```

- [ ] **Step 2: Run — fails to compile** (module missing).

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server db::companies 2>&1 | head`
Expected: FAIL.

- [ ] **Step 3: Implement** `db/companies.rs` modeled on `db/hosts.rs`. `list` is `SELECT … WHERE (? OR archived = 0) ORDER BY display_name` (bind `include_archived`); `create` sets both `created_at`/`updated_at` to now and returns the fetched row; `set_display_name`/`set_archived` also touch `updated_at`; `active_session_count` = `SELECT COUNT(*) FROM sessions WHERE company_id = ? AND archived = 0`. Add `pub mod companies;` to `db/mod.rs`.

- [ ] **Step 4: Run — passes.**

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server db::companies`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/companies.rs server/src/db/mod.rs
git commit -m "feat(companies): db::companies module (list/get/create/set_display_name/archive/delete)"
```

---

### Task P0.6 — Companies HTTP router + slug soft-reject + delete guard

**Files:**
- Create: `server/src/companies/mod.rs`
- Modify: `server/src/http.rs:155` (merge `companies::router_for(state.clone())` beside `agents::router_for`)
- Modify: the crate module tree (`server/src/lib.rs` or `main.rs`) to declare `pub mod companies;`

**Interfaces:**
- Consumes: `db::companies` (P0.5), `db::sessions::exists` (for the slug soft-reject).
- Produces: `pub fn router_for(state: AppState) -> Router<()>` with `GET /api/companies` (list, `?archived=1` includes archived), `POST /api/companies` ({slug, display_name, root_dir}), `PATCH /api/companies/{id}` ({display_name?, archived?}), `DELETE /api/companies/{id}`.

- [ ] **Step 1: Write the failing test** (an axum handler test with a test pool + state; mirror an existing router test in `agents` or `hosts`):

```rust
#[tokio::test]
async fn post_company_rejects_slug_colliding_with_session_slug() {
    // seed a session slug "acme"; POST /api/companies {slug:"acme"} => 409/400
}
#[tokio::test]
async fn delete_company_refused_when_active_sessions_present() {
    // company with an archived=0 member session => DELETE => 409
}
#[tokio::test]
async fn create_then_list_roundtrip_over_http() {
    // POST returns the row; GET lists it; PATCH archived=1 hides it from the default list
}
```

- [ ] **Step 2: Run — fails** (router missing).

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server companies 2>&1 | head`
Expected: FAIL.

- [ ] **Step 3: Implement** the router. Validation rules:
  - `slug`: `[A-Za-z0-9_.-]+` (reuse/mirror `valid_name`); reject empty/oversize.
  - **Slug soft-reject:** if `db::sessions::exists(&pool, &slug)` is true, return `AppError::Conflict` (folder/URL legibility — decision #3/§9).
  - `root_dir`: must be an absolute path; `mkdir -p` it at create.
  - `POST` returns 201 + the `Company` JSON.
  - `PATCH` applies `display_name` and/or `archived` (unarchive needs no fresh collision check — §9).
  - `DELETE` is guarded: refuse (`AppError::Conflict`) unless `active_session_count == 0` (parallels the archived-only purge guard at `db/sessions.rs:238-262`); the triggers then NULL any lingering (archived) sessions and drop connectors; the `root_dir` folder on disk is **NOT** removed — return the retained path in the response body.
  - Merge into `protected_router` at `http.rs:155`.

- [ ] **Step 4: Run — passes.**

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server companies`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/companies/ server/src/http.rs server/src/lib.rs
git commit -m "feat(companies): /api/companies CRUD router (slug soft-reject, delete guard, no rm of root_dir)"
```

---

### Task P0.7 — Create-time dir-forcing (create path)

**Files:**
- Modify: `server/src/sessions/mod.rs` — the `dir` derivation at `:1020-1027` and the `NewSession` build at `:1051-1069`.

**Interfaces:**
- Consumes: `CreateInput.company_id` (P0.4), `db::companies::get` (P0.5), `path_safe` canonicalization (`server/src/files/path_safe.rs`).
- Produces: a company session's `dir` is forced to `<company.root_dir>/<name>/` and any caller-supplied `dir` not canonicalizing under `root_dir` is a 400; the folder is `mkdir -p`'d. Main-bot sessions (NULL) keep today's free-form default-to-`$HOME` behavior unchanged.

- [ ] **Step 1: Write the failing test** (HTTP-level create):

```rust
#[tokio::test]
async fn company_session_dir_is_forced_under_root_and_rogue_dir_is_400() {
    // seed company acme root_dir=/srv/acme
    // POST /api/sessions {name:"bot-a", company_id: acme}  => dir == "/srv/acme/bot-a"
    // POST /api/sessions {name:"bot-b", company_id: acme, dir:"/etc"} => 400
    // POST /api/sessions {name:"main-x"}  (no company) => dir defaults to $HOME, 201
}
```

- [ ] **Step 2: Run — fails** (no forcing yet; `/etc` would be accepted).

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server company_session_dir 2>&1 | head`
Expected: FAIL.

- [ ] **Step 3: Implement.** Between the existing `dir` derivation (`:1020`) and the `NewSession` build (`:1051`), insert a company branch:

```rust
// Company sessions live under their company's root_dir/<name>/ and cannot be
// pointed outside it, even by a raw curl (§4.1). Main bots (company_id NULL)
// keep the free-form default-to-$HOME dir above.
let dir = if let Some(cid) = input.company_id {
    let company = db::companies::get(&state.pool, cid).await?
        .ok_or_else(|| AppError::BadRequest(format!("no company {cid}")))?;
    if company.archived != 0 {
        return Err(AppError::BadRequest("company is archived".into()));
    }
    let root = std::path::Path::new(&company.root_dir);
    let forced = root.join(&name);
    // If the caller supplied a dir, it must canonicalize under root_dir.
    if let Some(supplied) = input.dir.as_ref().filter(|d| !d.trim().is_empty()) {
        let sp = std::path::Path::new(supplied);
        let ok = sp.canonicalize().ok()
            .zip(root.canonicalize().ok())
            .map(|(a, r)| a.starts_with(&r))
            .unwrap_or(false)
            // allow the not-yet-created forced path itself
            || sp == forced.as_path();
        if !ok {
            return Err(AppError::BadRequest(
                "dir must be under the company's root_dir".into()));
        }
    }
    std::fs::create_dir_all(&forced).map_err(|e| AppError::Internal(e.to_string()))?;
    forced.display().to_string()
} else {
    dir // the existing main-bot derivation
};
```

Then carry `company_id: input.company_id` into the `NewSession` literal.

- [ ] **Step 4: Run — passes.**

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server company_session_dir`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/mod.rs
git commit -m "feat(companies): create-time dir-forcing under root_dir/<name> for company sessions"
```

---

### Task P0.8 — Duplicate-path dir re-derivation (the create()-bypassing seam)

**Files:**
- Modify: `server/src/sessions/mod.rs` — the `duplicate` handler at `:1193-1216` (after `db::sessions::duplicate` returns).

**Interfaces:**
- Consumes: `db::sessions::get` (to read the clone's inherited `company_id`), `db::companies::get`, `db::sessions::set_dir` (P0.3).
- Produces: a duplicated company session's `dir` is re-derived to `<root_dir>/<new_name>/` (not shared with the source) and `mkdir`'d; a main-bot duplicate keeps copying `dir` verbatim.

- [ ] **Step 1: Write the failing test:**

```rust
#[tokio::test]
async fn duplicate_of_company_session_gets_its_own_forced_dir() {
    // company acme root /srv/acme; create bot-a (dir /srv/acme/bot-a)
    // duplicate bot-a -> bot-a-copy
    // assert get("bot-a-copy").dir == "/srv/acme/bot-a-copy"  (NOT /srv/acme/bot-a)
    // duplicate a main bot -> dir copied verbatim (unchanged)
}
```

- [ ] **Step 2: Run — fails** (clone shares the source dir).

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server duplicate_of_company 2>&1 | head`
Expected: FAIL — copy dir == source dir.

- [ ] **Step 3: Implement.** In the `duplicate` handler, after `db::sessions::duplicate(&state.pool, src, new_name).await?`:

```rust
// §3.3#3 / §4.1 — duplicate() bypasses create()'s dir-forcing and copies `dir`
// verbatim. For an inherited company_id, re-derive the clone's own
// root_dir/<new_name>/ so two company agents never share a working folder.
if let Some(row) = db::sessions::get(&state.pool, new_name).await? {
    if let Some(cid) = row.company_id {
        if let Some(company) = db::companies::get(&state.pool, cid).await? {
            let forced = std::path::Path::new(&company.root_dir).join(new_name);
            std::fs::create_dir_all(&forced)
                .map_err(|e| AppError::Internal(e.to_string()))?;
            db::sessions::set_dir(&state.pool, new_name, &forced.display().to_string()).await?;
        }
    }
}
```

- [ ] **Step 4: Run — passes.**

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server duplicate_of_company`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/mod.rs
git commit -m "feat(companies): re-derive+mkdir a duplicated company session's own root_dir/<name> dir"
```

---

### Task P0.9 — The secret-floor: per-child `CLAUDE_CONFIG_DIR` (per-spawn, 0700, NOT process-global)

**Files:**
- Modify: `server/src/sessions/lifecycle.rs` — `build_env` (`:225`), its callsite in `start_locked` (`:1113`), and the resolution of the session's `company_id` (available via `db::sessions::get` already loaded near `:884`/`:961`).

**Interfaces:**
- Consumes: `Session.company_id` (P0.3), `db::companies::get`, the config `data_dir`.
- Produces: `build_env` gains a `company_id: Option<i64>` parameter (and resolves the company `root`/slug), and inserts `CLAUDE_CONFIG_DIR = <data_dir>/companies/<slug>/claude` into the returned per-child env map **only when `company_id.is_some()`**; the dir is `mkdir`'d `0700` before spawn. Main bots (NULL) get no `CLAUDE_CONFIG_DIR` insertion (unchanged process-inherited behavior). Two concurrently-spawned company sessions in **different** companies resolve to **different** `CLAUDE_CONFIG_DIR` values.

- [ ] **Step 1: Write the failing test** — a `build_env`-level unit test (the module already exists at `lifecycle.rs:2653 build_env_tests`):

```rust
#[test]
fn build_env_sets_per_company_claude_config_dir_and_isolates_two_companies() {
    // Given two companies with slugs "acme"/"globex" and a data_dir,
    // env_a = build_env(.., company=Some(acme_slug_resolved)),
    // env_b = build_env(.., company=Some(globex..)),
    // assert env_a["CLAUDE_CONFIG_DIR"] != env_b["CLAUDE_CONFIG_DIR"]
    // assert a main bot (None) has NO CLAUDE_CONFIG_DIR key.
}
```

(Because `build_env` currently takes `host_id: Option<i64>` and no DB pool, pass the already-resolved company **slug + data_dir** rather than doing a DB read inside `build_env` — keep `build_env` a pure function of its arguments, matching its existing test discipline. Resolve `company_id → slug` in `start_locked` before the call.)

- [ ] **Step 2: Run — fails** (no such parameter / key).

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server build_env 2>&1 | head`
Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Change `build_env`'s signature to accept `company: Option<&CompanyEnv>` where `CompanyEnv { slug: String, config_dir: PathBuf }` (or the pair `(slug, data_dir)`), and inside, when `Some`, `env.insert("CLAUDE_CONFIG_DIR".into(), config_dir.display().to_string())`.
  - In `start_locked` (`:1113` callsite), resolve the session's `company_id` (the `Session` is in hand from the `db::sessions::get` this function already does), and when non-NULL: `db::companies::get` → build `config_dir = <config.data_dir>/companies/<slug>/claude`, `std::fs::create_dir_all` it and set mode `0700` (`std::os::unix::fs::PermissionsExt`), then pass it to `build_env`. NULL → pass `None`.
  - **Critical:** this insertion is on the returned per-child env `HashMap` that flows into `Command::envs(env)` (native at `runtime.rs:376`), NOT a `std::env::set_var`. Do not touch the process-global. Update the other `build_env(...)` test callsites to pass `None`.

- [ ] **Step 4: Run — passes.** Then run the full lifecycle test module to catch the signature ripple.

Run: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test -p supermux-server lifecycle::build_env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/lifecycle.rs
git commit -m "feat(companies): secret-floor — per-child CLAUDE_CONFIG_DIR per company spawn (0700, not process-global)"
```

---

### Task P0.10 — Web types: `company_id?` on `SessionSummary`, `ApiSession`, `NewSession`

**Files:**
- Modify: `web/src/lib/api/sessions.ts` — `SessionSummary` (`:36`, near `host_id?` `:56`), `ApiSession` (`:126`, near `host_id?` `:299`), `NewSession` (`:500`, near `host_id?` `:511`).

**Interfaces:**
- Produces: `company_id?: number | null` on all three interfaces (read + create). No behavior; the switcher (P1) consumes them.

- [ ] **Step 1: Add the field** to each interface, mirroring the existing `host_id?: number | null` line with a comment: `/** The company this session belongs to (migration 0030); null / absent = a main/PA bot. */ company_id?: number | null`.

- [ ] **Step 2: Run the web gates.**

Run: `cd web && OPENSSL_NO_VENDOR=1 bun run build:perf && bunx tsc -b`
Expected: PASS (types compile; no runtime change).

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/api/sessions.ts
git commit -m "feat(companies): web types — company_id? on SessionSummary/ApiSession/NewSession"
```

---

### Task P0.11 — P0 full-gate + deploy-alone

- [ ] **Step 1: Full server gate.** `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo check` then the db + sessions + lifecycle + companies test modules. Expected: all green.
- [ ] **Step 2: Full web gate.** `cd web && OPENSSL_NO_VENDOR=1 bun run build:perf && bunx tsc -b`. Expected: green.
- [ ] **Step 3: Deploy this worktree alone** (manual deploy-request, `source_dir=/opt/projects/supermux-companies`; MEMORY: deploy-branch-from-worktree). Do NOT restart the hosting instance unasked — test on a side port if a live check is needed.
- [ ] **Step 4: Owner-visible verify.** Curl round-trip on the deployed side port: `POST /api/companies {slug:"acme",display_name:"Acme",root_dir:"/srv/acme"}` → `GET /api/companies` shows it; `POST /api/sessions {name:"acme-bot",company_id:<id>}` → `GET /api/sessions` shows `acme-bot` with `company_id` set and `dir` == `/srv/acme/acme-bot`; the dashboard UI is visually unchanged. **Done-definition met.**

---

## C. Task-level outline — P1, P2, P3 & the `@sandbox` prereq

Each bullet is a slice with its anchor(s) and done-definition. Expand to full TDD tasks (same shape as §B) at execution time.

### Slice 0 — `@sandbox` deploy prereq (ship first / alongside P0)

- [ ] **Add `SystemCallFilter=@sandbox` to `supermux.service`** via the root deploy path-unit (§4.4). It un-blocks the `landlock_*` syscalls the current `SystemCallFilter=@system-service` denies; opens no namespaces (`RestrictNamespaces` stays `true`); grants no runtime privilege. **Done:** `systemctl show supermux -p SystemCallFilter` lists `@sandbox`, the service boots green, no behavior change (dead until P1's Landlock backend). Self-verifies via the P1 probe flipping `None → Full`.

### P1 — companies + switcher + isolation backend (first visible slice)

Server:
- [ ] **Flip the Files jail** — replace the six `safe_path(&transport, …, None)` calls (`files/mod.rs:240,278,356,405,522,562`) with a resolved `jail: Option<PathBuf>`: the switcher's active company `root_dir` for a company-scoped request, `None` for main-bot/owner. `resolve_safe` (`path_safe.rs:103,134-137`) already enforces `abs.starts_with(jail_canon)`. **Done:** a company-scoped Files request cannot resolve outside `root_dir` (`..` + absolute-escape both 400); a main-bot request still reaches out-of-root.
- [ ] **Delegation gate** — in `delegate()` (`delegate.rs:164`), between the existence checks (`:201-203`) and delivery (`:214`), add a `db::sessions::get(from)` beside the existing `get(to)` (`:210`) and enforce: allow if `from.company_id IS NULL` OR `to.company_id == from.company_id`, else `AppError::NotFound(format!("session '{to}'"))` (silent 404, before any edge/audit/keystroke). **Done:** cross-company 404; same-company + main-bot delegate succeed.
- [ ] **Graph filter** — `GET /api/agents/delegations` (`delegate.rs:261`): add a `JOIN sessions` on each endpoint in `delegations_out`/`delegations_in` (`db/audit.rs:189-211`) to get endpoint `company_id`, and hide out-of-company edges from a scoped caller. **Done:** `delegations_graph_filtered_by_company` passes.
- [ ] **`list_for_scope`** — add `db::sessions::list_for_scope(company: Option<i64>)` (`None` = today's unfiltered `WHERE archived=0`; `Some(id)` adds `AND company_id = ?`), used by `sessions::list` (`mod.rs:795`). Owner keeps calling `None` (filters client-side). **Done:** a scoped call returns only in-company rows.
- [ ] **`IsolationProvider` trait + `IsolationMode`/`IsolationLevel`/`Backend` enums** in a new `server/src/isolation/mod.rs` (`confine(&ConfineSpec)`, `probe() -> IsolationLevel`; backends `LandlockLinux`, `SeatbeltMacOS` cfg-gated, `Noop`). Gating: `confine()` called per-spawn **only when `company_id != NULL`**; main bots never confined. **Done:** unit tests on the mode→level mapping; Noop measures `None`.
- [ ] **LandlockLinux backend** — `landlock` crate `ABI::V4` + `CompatLevel::BestEffort`; build the `Ruleset` and call `restrict_self()` **inside** the child via `CommandExt::pre_exec` (the existing `pre_exec` seam at `native/runtime.rs:399`, and the holder at `native/holder.rs:700`). Allow-list: company tree RW + the company `CLAUDE_CONFIG_DIR` RW + RO/exec system paths (`/usr`,`/lib`,`/lib64`,`/bin`,`/etc`, node/cargo/rustup caches, `/tmp` RW); deny siblings + `~/.supermux/auth_token`. **Done (on the deployed `@sandbox` host):** a confined company agent's shell **cannot** `cat` a sibling company's tree or `~/.supermux/auth_token`; a main bot still can.
- [ ] **Startup probe** — fork a throwaway child that actually calls `restrict_self()` with the intended attrs and reports `RulesetStatus` via exit code (catches the `@system-service` filter silently blocking `landlock_*`). Log the measured `IsolationLevel` once at startup. **Done:** probe reports `Full` on the `@sandbox` host, `None` (+ loud warning) without it.
- [ ] **`BestEffort` default** — apply the strongest available backend, log **one loud per-session warning** if none, never crash; surface the **measured** level, never the requested mode.

Web:
- [ ] **`<CompanySwitcher>`** in the overview header (`overview.tsx:641`, leftmost) + a compact echo in `layout.tsx`; options = `GET /api/companies` + "All companies". **Done:** switching narrows.
- [ ] **`activeCompany: number | null` persisted state** in the UI store (server-persisted via `/api/prefs`, mirroring `hideStopped`/layout blob, `use-sessions.ts:302-329`, `ui-store.ts:131`).
- [ ] **Overview scoping** — extend the single `filtered` choke-point (`overview.tsx:235-244`) with `activeCompany === null || s.company_id === activeCompany`; keep renderer-pin pruning (`:133-137`) reading full `allSessions`.
- [ ] **Team-card scoping** — extend `filteredTeams` (`:457-466`) by the lead session's `company_id`.
- [ ] **New-agent default** — the New-session sheet defaults `company_id` to `activeCompany`.
- [ ] **Files root** — the browser roots at the active company's `root_dir` (jail on); "All companies" = omniscient all-files, company-grouped picker (§8).
- [ ] **Global-search company-first** — `matches()` (`:98-107`) unchanged; rank in-company hits first on a non-empty query; scoped-empty `noMatch` CTA (`:513-521`).
- [ ] **@-picker scope** (defense-in-depth) — scope `mentionIndex`/`displayNames` (`grouping.ts:552-586`; `chat-panel.tsx:161-165`) to the active company.

**P1 done-definition:** switcher narrows overview + teams; a company bot's Files view can't escape its root; cross-company delegate curl 404s; same-company + main-bot delegate succeed; the probe reports `Full` on the deployed host and a confined agent can't read a sibling tree while a main bot can; gates green.

### P2 — connector store + vault + isolation surfacing

- [ ] **`db::company_connectors`** module — `list_for_company`, `effective_for_session(company_id, slug)` (company-wide rows overlaid by `target_session = slug` rows, **name-matched wholesale replace**, decision #9), CRUD.
- [ ] **Encrypt-at-rest vault** (`server/src/companies/vault.rs`) — key file `<data_dir>/companies_vault_key` mode `0600`, generated on first use (32 bytes), `SUPERMUX_COMPANIES_VAULT_KEY` override, modeled on `config.rs:309-367`; XChaCha20-Poly1305 secretbox over `config_json` → `{nonce,ciphertext}` base64. Decrypt server-side only. Key rotation re-seals every row.
- [ ] **Session-start materialization** — a new hook in `start_locked` (`lifecycle.rs:960+`, near the hook-install block `:1075`) resolves `company_id`, gathers the effective connector set, decrypts via the vault, and materializes them into the session's cwd `local` scope in its **per-company `CLAUDE_CONFIG_DIR`** (the P0 secret-floor) via `write_json_atomic` (`claude_tools/atomic.rs:81`, read→merge `mcpServers` subtree→temp→fsync→rename). **Done:** two companies each hold a differently-credentialed Slack; a bot's `local` scope shows exactly its company's (+ per-bot-override) connectors; secrets sealed at rest, masked on read (`mask_mcp_secrets`, `atomic.rs:127-142`).
- [ ] **Manager sheet scope** — `claude-tools-sheet.tsx` gains company provenance ("inherited from company" vs "overridden for this bot"), a company-connectors editor when a company is active, and a "restart affected bots to apply" affordance (materialization is at start).
- [ ] **Per-session `IsolationLevel` UI badge** — surface the measured `Full`/`Partial`/`None` per session (never the requested mode), threaded onto `SessionView` (a new `isolation: {level, backend, note}` field) and rendered in the session UI.
- [ ] **`StrictRequired` mode** — refuse to start a company session when the measured level is below the configured ABI floor.
- [ ] **ABI-v4 TCP-port egress rule** — the Landlock net rule denying the loopback-API port to confined agents.

**P2 done-definition:** two companies, two Slack tokens, each bot picks up its own on start; sealed at rest + masked on read; a session shows its isolation badge; a `StrictRequired` company session refuses to start below floor; gates green.

### P3 — external humans + macOS backend

- [ ] **Per-company Cloudflare tunnel** → loopback; add `companies.tunnel_hostname` (a **follow-on migration 0031**, not 0030); Host → company map; add hostname to `config.extra_origins` (`config.rs:72-79`, consumed `ws/mod.rs:1414`).
- [ ] **Google OIDC + human-auth middleware** beside the bearer at `http.rs:176` (bearer-or-cookie). Mandatory: `state` (login CSRF), PKCE, `nonce` (replay), a **per-host redirect-URI allowlist**. Cookies `Secure;HttpOnly;SameSite=Lax` + CSRF tokens on state-changing routes. Client secret via env (`github_token` pattern, `config.rs:255-279`). Bind the seeded owner email from config at startup.
- [ ] **Company scoping for a human** — `human_users.company_id` hard-limits list/Files(jail)/delegation/palette/**search** server-side; out-of-company slug access to any resource returns the **same 404** as a missing slug (enumeration rule).
- [ ] **Delegation `from`-binding** — in P3 additionally require `from.company_id == human.company_id`, and condition the `company_id IS NULL` bypass on the **authenticated identity** being owner/admin-all, never on a body-supplied `from` (§4.2 P3 caveat).
- [ ] **Live-pane WS + `/api/events`** — accept **cookie-derived** human auth as an alternative first-frame path; check `name.company_id == human.company_id` **before subscribe** (silent 404); move `/api/events` under the human-auth layer, company-filtered per subscriber.
- [ ] **Per-company SSE channels** — the single global `state.sse_tx` (`sessions/mod.rs:1099`) becomes per-company; owner/main channel gets all.
- [ ] **Per-message human author provenance** — through `send_harness_text` (`lifecycle.rs:1541+`, the privileged writer), wrap with an identity tag mirroring `<supermux-delegation from=…>` (`delegate.rs:110-119`), author = **server-established** human (never body-trusted; guard at `lifecycle.rs:1507-1535`); reader `recall::classify_prompt_body` (`recall.rs:1275-1296`) + renderer (`transcript-item.tsx:459-501`, `wire-entries.ts:268`) render "●alice@acme".
- [ ] **Audit attribution** — add `author_user_id` + `company_id` to `audit_log` (follow-on migration; bump the count assertion again).
- [ ] **iCal gating** — drop the public exemption on any tunneled host; gate `/api/calendar.ics` behind human-auth as owner/admin-all only; stays global-board (per-company calendars wait on board→company scoping, deferred).
- [ ] **owner/admin/member permissions** — role gates the middleware's route authorization; agent-create + connector-edit require `admin`+.
- [ ] **Connector per-human isolation** — the manager sheet resolves rows through the human's company scope (`WHERE company_id = <their>`), masked.
- [ ] **SeatbeltMacOS backend (on-demand, deferred until the Mac mini joins)** — `sandbox-exec -p <profile> -D COMPANY_DIR=… -D SECRETS=… -- <cmd>` as a plain `Command` (no FFI/entitlements); v1 profile = deny-cross-company-write + deny-read-secrets → measures **`Partial`** (not a full read-jail); `excludedCommands`/`dangerouslyDisableSandbox` escape hatch for Go-CLI TLS, Apple Events `-600`, nested Playwright/Chromium. Until then macOS runs Noop + secret-floor, badge reports `None` honestly.

**P3 done-definition:** a Google-authed Company-B colleague reaches only Company-B agents (list/files/search/delegate hard-scoped); each message renders "●name"; the audit ledger attributes to them; no Company-A SSE/secret/iCal reaches them; gates green.

---

## D. Testing & rollout

**Gates, every slice (verbatim):**
- Server: `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo check` (DEBUG) + the touched test modules. **NEVER `--release`.**
- Web: `cd web && OPENSSL_NO_VENDOR=1 bun run build:perf` + `bunx tsc -b`.
- Never bounded `{m,n}` ripgrep `-o` on long-line files.

**P0 assertion & regression (Task P0.2):** count `27 → 28` + message string; the 0030 backfill/cascade test mirroring the board_id pattern (`db/mod.rs:124-218`): existing fleet backfills `company_id = NULL`; `trg_company_delete_sessions` NULLs member sessions; `trg_company_delete_connectors` cascades; one seeded owner row.

**New delegation-gate tests (P1, beside `delegate.rs:277-391`):**
- `same_company_delegate_allowed` — shared `company_id` ⇒ delivered.
- `cross_company_delegate_refused_as_404` — different non-null companies ⇒ `NotFound`, no edge/audit written.
- `main_bot_bypass_into_any_company` — `from.company_id IS NULL` ⇒ delivered into a company target.
- `company_bot_cannot_reach_main_or_other` — a company bot to a NULL/main target AND to another company both 404.
- `delegations_graph_filtered_by_company` — the read endpoint hides out-of-company edges from a scoped caller.

**Files-jail tests (P1):** a company-scoped Files request cannot resolve outside `root_dir` (`..` + absolute-escape both 400); a main-bot request (jail `None`) still reaches an out-of-root path.

**Isolation probe self-test (P1):** the fork-and-`restrict_self` probe reports `Full` on the deployed `@sandbox` host and `None` + one loud warning without it; a live check that a confined company agent's shell cannot `cat` a sibling tree or `~/.supermux/auth_token` while a main bot can.

**Secret-floor test (P0, Task P0.9):** two concurrently-spawned company sessions in different companies resolve to **different** `CLAUDE_CONFIG_DIR` values on the **child env** (per-child, not process-global); a main bot gets no `CLAUDE_CONFIG_DIR` insertion.

**Deploy-alone + owner-visual-verify loop:** deploy each slice alone from this worktree (manual deploy-request, `source_dir=` the worktree), then the owner verifies the phase's "Owner sees" line before the next slice starts. Never restart the hosting instance unasked; side-port for live checks.

---

## E. Risk / sequencing note — what must land before what

1. **`@sandbox` (slice 0) before P1's Landlock owner-verify.** The LandlockLinux backend is **dead code that measures `None`** until `SystemCallFilter=@sandbox` un-blocks `landlock_*` (the current `@system-service` filter blocks them, silently → `EPERM`/`ENOSYS`). Ship slice 0 first or alongside P0; it is a pure no-op until P1 and self-verifies via the probe. If P1 ships to a host without the unit line, the probe correctly reports `None` + a loud warning — no false `Full`.
2. **The secret-floor (P0.9) is independent of `@sandbox` and of Landlock.** It is env separation on the child, holds on every host including Noop, and is the P0-critical isolation primitive. It must NOT be gated on the sandbox landing — it is the honest floor when the kernel jail is absent.
3. **P0.1 (migration) strictly precedes everything** — the assertion bump, the Rust type thread, the create/duplicate seams all read the new column/tables. Within P0 the order in §B is a hard dependency chain (migration → assertion+regression → db types → view types → db module → router → create-dir → duplicate-dir → secret-floor → web types → gate/deploy).
4. **Create-time dir-forcing (P0.7/P0.8) MUST co-ship with `company_id`-on-create.** A company session created in P0 whose `dir` merely defaulted to `$HOME` would be **un-jailable** when P1 flips the jail — P1 does **not** retroactively move it. The column and its dir invariant land together, and the duplicate seam (which bypasses `create()`) is closed in the same phase.
5. **P1's Files jail depends on P0's dir-forcing** — the jailed roots must exist to flip onto. Flipping the jail without forced dirs would jail nothing useful.
6. **P2 materialization depends on P0's secret-floor dir** — connectors materialize **into** the per-company `CLAUDE_CONFIG_DIR`; the vault seals what materialization reads. The vault protects at-rest-in-DB + P3-over-the-API; the secret-floor protects runtime co-residence — complementary layers, neither substitutes for the other.
7. **P3's per-company SSE channels are a hard gate** — any P3 path that publishes to the global `sse_tx` re-opens the cross-company real-time leak; test with two simultaneous human connections. P3's delegation `from`-binding is the moment the `company_id IS NULL` bypass must move from a body-supplied `from` to the authenticated identity — until P3 only the owner authenticates, so it is a documented assumption, not a live hole.
8. **Migration numbering ordering across phases:** 0030 (P0) is the only migration in this plan's early phases; P3 adds `companies.tunnel_hostname` and `audit_log.author_user_id`/`company_id` as **new** migrations (next-free-above, e.g. 0031/0032), each bumping the `db/mod.rs` count assertion again. Never edit 0030 after it ships.
