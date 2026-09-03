//! The Workflows port contract — `migrations/0038_workflows.sql`, as an executable spec.
//!
//! The port is the only irreversible step in Workflows v1 (spec §10): 0038 ends
//! with `DROP TABLE schedules`. It therefore gets its own fixture, its own file,
//! and a rehearsal against a copy of production before the release is cut
//! (Phase 8). This file is written BEFORE the migration exists so 0038 is
//! written against a contract rather than a vibe.
//!
//! **Safety.** Every database here is a throwaway file in a per-test tempdir,
//! built from the embedded migrations and deleted at the end. Nothing in this
//! file may ever be pointed at a real install's `data.db`.
//!
//! The fixture recipe is written down in `tests/fixtures/schema_0037.md`;
//! [`seed_0037`] is the code half of it.

use std::path::PathBuf;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};

/// The schema version a deployed install sits at immediately before this upgrade.
const BEFORE: i64 = 37;

// ── the fixture ───────────────────────────────────────────────────────────────

/// A throwaway on-disk pool with production's pragmas (WAL, `foreign_keys=ON`).
/// Returns the dir too, so the caller can delete it.
async fn scratch_pool() -> (SqlitePool, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-port-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let opts = SqliteConnectOptions::new()
        .filename(dir.join("data.db"))
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(opts)
        .await
        .expect("scratch pool");
    (pool, dir)
}

/// Bring a fresh database to EXACTLY schema 0037 — the state a deployed install
/// is in the instant before it takes this upgrade.
///
/// sqlx has no "migrate to version N", so we replay 0001–0037 ourselves and
/// write the same `_sqlx_migrations` bookkeeping sqlx would have written
/// (`success=TRUE`, the migration's own checksum, `execution_time=-1`). A later
/// `Migrator::run` then validates those checksums, finds 0001–0037 applied, and
/// applies only what is new. If that bookkeeping were wrong the migrator would
/// refuse, so this is self-checking.
async fn migrate_to_0037(pool: &SqlitePool) {
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
            version BIGINT PRIMARY KEY,
            description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL,
            checksum BLOB NOT NULL,
            execution_time BIGINT NOT NULL
        );",
    )
    .execute(pool)
    .await
    .expect("migrations table");

    let migrator = sqlx::migrate!("./migrations");
    let mut applied = 0;
    for m in migrator.iter() {
        if m.version > BEFORE {
            continue;
        }
        sqlx::raw_sql(&m.sql)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("replaying migration {}: {e}", m.version));
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
             VALUES (?, ?, TRUE, ?, -1)",
        )
        .bind(m.version)
        .bind(&*m.description)
        .bind(m.checksum.to_vec())
        .execute(pool)
        .await
        .expect("record migration");
        applied += 1;
    }
    assert!(applied > 0, "no migrations at or below {BEFORE} — the fixture would be empty");
}

/// Seed the pre-drop rows. One witness per branch of the port; see
/// `tests/fixtures/schema_0037.md` for the table of why each one is here.
pub async fn seed_0037(pool: &SqlitePool) {
    // A company and the bot that belongs to it, so the DERIVED company_id has
    // something to derive from. `ghost` deliberately has NO sessions row.
    sqlx::query(
        "INSERT INTO companies (id, slug, display_name, root_dir, created_at, updated_at)
         VALUES (7, 'acme', 'Acme', '/tmp/acme', 1000, 1000)",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sessions (name, dir, created_at, company_id) VALUES ('scout', '/tmp/scout', 1000, 7)",
    )
    .execute(pool)
    .await
    .unwrap();

    // 1. the happy path: recurring, watched, notify, a command AND a prompt.
    ins(pool, Seed {
        id: "SCHED-tmux0001",
        title: "Weekly report",
        session: "scout",
        command: "/review",
        prompt: "Check the inbox",
        kind: "tmux",
        sched_type: "recurring",
        recurrence: None,
        run_at: None,
        next_run: Some("2026-09-01T09:00:00+00:00"),
        last_run: Some("2026-08-23T09:00:00+00:00"),
        enabled: 1,
        run_count: 5,
        schedule_expr: Some("daily at 09:00"),
        watch_timeout: 300,
        done_pattern: Some("ALL DONE"),
        done_action: "notify",
        deleted: None,
    })
    .await;

    // 2. the synth_expr branch: schedule_expr IS NULL, recurrence + run_at carry
    //    the cadence. watch_timeout 0 must become the 1800 default.
    ins(pool, Seed {
        id: "SCHED-tmux0002",
        title: "Morning sweep",
        session: "scout",
        command: "",
        prompt: "Sweep the board",
        kind: "tmux",
        sched_type: "recurring",
        recurrence: Some("daily"),
        run_at: Some("09:00"),
        next_run: Some("2026-08-25T07:00:00+00:00"),
        last_run: None,
        enabled: 0,
        run_count: 0,
        schedule_expr: None,
        watch_timeout: 0,
        done_pattern: None,
        done_action: "disable",
        deleted: None,
    })
    .await;

    // 3 + 4. the two dragons that do not come across.
    ins(pool, Seed {
        id: "SCHED-shel0003",
        title: "Nightly backup",
        session: "",
        command: "tar -czf /tmp/b.tgz /srv",
        prompt: "",
        kind: "shell",
        sched_type: "recurring",
        recurrence: None,
        run_at: None,
        next_run: Some("2026-08-25T02:00:00+00:00"),
        last_run: None,
        enabled: 1,
        run_count: 3,
        schedule_expr: Some("0 2 * * *"),
        watch_timeout: 120,
        done_pattern: None,
        done_action: "disable",
        deleted: None,
    })
    .await;
    ins(pool, Seed {
        id: "SCHED-boot0004",
        title: "Boot the intern",
        session: "",
        command: "",
        prompt: "Start on the backlog",
        kind: "boot",
        sched_type: "once",
        recurrence: None,
        run_at: None,
        next_run: Some("2026-08-25T08:00:00+00:00"),
        last_run: None,
        enabled: 1,
        run_count: 0,
        schedule_expr: Some("in 2 hours"),
        watch_timeout: 120,
        done_pattern: None,
        done_action: "disable",
        deleted: None,
    })
    .await;

    // 5. `done_action: command:` — ported, but the follow-up text is only ever
    //    preserved, never re-interpreted as a connector send.
    ins(pool, Seed {
        id: "SCHED-cmd00005",
        title: "Standup nudge",
        session: "scout",
        command: "",
        prompt: "Post the standup",
        kind: "tmux",
        sched_type: "recurring",
        recurrence: None,
        run_at: None,
        next_run: Some("2026-08-25T09:00:00+00:00"),
        last_run: None,
        enabled: 1,
        run_count: 1,
        schedule_expr: Some("daily at 09:00"),
        watch_timeout: 600,
        done_pattern: None,
        done_action: "command:say hi",
        deleted: None,
    })
    .await;

    // 6. already a tombstone: archived to the log, never ported.
    ins(pool, Seed {
        id: "SCHED-gone0006",
        title: "Retired job",
        session: "scout",
        command: "/old",
        prompt: "",
        kind: "tmux",
        sched_type: "once",
        recurrence: None,
        run_at: None,
        next_run: None,
        last_run: Some("2026-08-01T09:00:00+00:00"),
        enabled: 0,
        run_count: 9,
        schedule_expr: Some("in 1 hour"),
        watch_timeout: 120,
        done_pattern: None,
        done_action: "disable",
        deleted: Some(1_700_000_000),
    })
    .await;

    // 7. a live tmux job whose session no longer exists → company_id must be NULL,
    //    not an error and not a guess.
    ins(pool, Seed {
        id: "SCHED-tmux0007",
        title: "Orphan",
        session: "ghost",
        command: "",
        prompt: "Nobody is home",
        kind: "tmux",
        sched_type: "recurring",
        recurrence: None,
        run_at: None,
        next_run: Some("2026-08-25T10:00:00+00:00"),
        last_run: None,
        enabled: 1,
        run_count: 0,
        schedule_expr: Some("every 1h"),
        watch_timeout: 120,
        done_pattern: None,
        done_action: "disable",
        deleted: None,
    })
    .await;

    // The per-fire ledger. Every status the runner actually writes is represented
    // ('ok', 'done', 'error', 'skipped', 'timeout' — see scheduler/{runner,mod,watch}.rs).
    for (sid, ran_at, status, note) in [
        ("SCHED-tmux0001", 1_700_000_100i64, "ok", "delivered"),
        ("SCHED-tmux0001", 1_700_000_200, "done", "agent confirmed"),
        ("SCHED-tmux0001", 1_700_000_300, "skipped", "missed window"),
        ("SCHED-shel0003", 1_700_000_400, "error", "exit 1"),
    ] {
        sqlx::query("INSERT INTO schedule_runs (schedule_id, ran_at, status, note) VALUES (?, ?, ?, ?)")
            .bind(sid)
            .bind(ran_at)
            .bind(status)
            .bind(note)
            .execute(pool)
            .await
            .unwrap();
    }

    // The idempotency tuples. Without these crossing over, a window that lands
    // across the upgrade fires twice.
    for (sid, ts) in [("SCHED-tmux0001", 1_700_000_100i64), ("SCHED-shel0003", 1_700_000_400)] {
        sqlx::query(
            "INSERT INTO schedule_run_keys (schedule_id, scheduled_for_ts, fired_at) VALUES (?, ?, ?)",
        )
        .bind(sid)
        .bind(ts)
        .bind(ts)
        .execute(pool)
        .await
        .unwrap();
    }
}

struct Seed {
    id: &'static str,
    title: &'static str,
    session: &'static str,
    command: &'static str,
    prompt: &'static str,
    kind: &'static str,
    sched_type: &'static str,
    recurrence: Option<&'static str>,
    run_at: Option<&'static str>,
    next_run: Option<&'static str>,
    last_run: Option<&'static str>,
    enabled: i64,
    run_count: i64,
    schedule_expr: Option<&'static str>,
    watch_timeout: i64,
    done_pattern: Option<&'static str>,
    done_action: &'static str,
    deleted: Option<i64>,
}

async fn ins(pool: &SqlitePool, s: Seed) {
    sqlx::query(
        "INSERT INTO schedules
            (id, title, session, command, prompt, kind, boot_dir, boot_provider, boot_worktree,
             sched_type, recurrence, run_at, next_run, last_run, enabled, run_count,
             schedule_expr, watch, watch_timeout, done_pattern, done_action, confirm_finish,
             bypass_permissions, created, updated, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'claude', 0, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, 0, 1000, 1000, ?)",
    )
    .bind(s.id)
    .bind(s.title)
    .bind(s.session)
    .bind(s.command)
    .bind(s.prompt)
    .bind(s.kind)
    .bind(if s.kind == "boot" { "/tmp/boot" } else { "" })
    .bind(s.sched_type)
    .bind(s.recurrence)
    .bind(s.run_at)
    .bind(s.next_run)
    .bind(s.last_run)
    .bind(s.enabled)
    .bind(s.run_count)
    .bind(s.schedule_expr)
    .bind(s.watch_timeout)
    .bind(s.done_pattern)
    .bind(s.done_action)
    .bind(s.deleted)
    .execute(pool)
    .await
    .unwrap_or_else(|e| panic!("seeding {}: {e}", s.id));
}

/// 0037 → seed → run the real migrator, which applies 0038 and nothing else.
async fn ported() -> (SqlitePool, PathBuf) {
    let (pool, dir) = scratch_pool().await;
    migrate_to_0037(&pool).await;
    seed_0037(&pool).await;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("0038 must apply cleanly on top of a seeded 0037 database");
    (pool, dir)
}

async fn scalar_i64(pool: &SqlitePool, sql: &str) -> i64 {
    sqlx::query(sql).fetch_one(pool).await.unwrap().get::<i64, _>(0)
}

async fn ids(pool: &SqlitePool, sql: &str) -> Vec<String> {
    sqlx::query(sql)
        .fetch_all(pool)
        .await
        .unwrap()
        .iter()
        .map(|r| r.get::<String, _>(0))
        .collect()
}

fn cleanup(dir: PathBuf) {
    let _ = std::fs::remove_dir_all(dir);
}

// ── the contract ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn every_tmux_schedule_becomes_a_one_step_workflow_with_its_id_intact() {
    let (pool, dir) = ported().await;

    // The ids are load-bearing: transcripts on disk, confirm footers in live
    // panes and the legacy hook aliases all reference the exact SCHED- string.
    assert_eq!(
        ids(&pool, "SELECT id FROM workflows ORDER BY id").await,
        vec!["SCHED-cmd00005", "SCHED-tmux0001", "SCHED-tmux0002", "SCHED-tmux0007"],
        "every live tmux schedule ports, keeping its id; shell/boot/deleted do not"
    );

    // Exactly one step per ported workflow, at position 0, with a fresh WS- id.
    let steps = sqlx::query(
        "SELECT workflow_id, id, position, command, prompt, timeout_secs FROM workflow_steps ORDER BY workflow_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(steps.len(), 4, "one step per ported workflow");
    for r in &steps {
        assert_eq!(r.get::<i64, _>("position"), 0);
        assert!(
            r.get::<String, _>("id").starts_with("WS-"),
            "steps get fresh WS- ids: {}",
            r.get::<String, _>("id")
        );
    }
    assert_eq!(
        scalar_i64(&pool, "SELECT COUNT(DISTINCT id) FROM workflow_steps").await,
        4,
        "the WS- ids are distinct"
    );

    // command and prompt cross over SEPARATELY. Concatenating them would stop
    // the slash line being its own submission, which is what makes Claude run it.
    let one = sqlx::query(
        "SELECT command, prompt, timeout_secs FROM workflow_steps WHERE workflow_id = 'SCHED-tmux0001'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(one.get::<String, _>("command"), "/review");
    assert_eq!(one.get::<String, _>("prompt"), "Check the inbox");
    assert_eq!(one.get::<i64, _>("timeout_secs"), 300, "watch_timeout carries over");

    // watch_timeout 0 is not a timeout of zero; it is "unset" → the 1800 default.
    assert_eq!(
        scalar_i64(&pool, "SELECT timeout_secs FROM workflow_steps WHERE workflow_id = 'SCHED-tmux0002'").await,
        1800
    );

    // A `command:` done_action becomes a disable — never a guess at what the
    // operator's follow-up text meant.
    let actions = sqlx::query("SELECT id, on_complete FROM workflows ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    for r in &actions {
        let (id, act) = (r.get::<String, _>("id"), r.get::<String, _>("on_complete"));
        let want = if id == "SCHED-tmux0001" { r#"{"kind":"notify"}"# } else { r#"{"kind":"disable"}"# };
        assert_eq!(act, want, "on_complete for {id}");
    }

    cleanup(dir);
}

#[tokio::test]
async fn cadence_crosses_over_bit_for_bit() {
    let (pool, dir) = ported().await;

    let r = sqlx::query(
        "SELECT title, session, company_id, enabled, trigger_kind, schedule_expr, next_run, last_run, run_count
           FROM workflows WHERE id = 'SCHED-tmux0001'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(r.get::<String, _>("title"), "Weekly report");
    assert_eq!(r.get::<String, _>("session"), "scout");
    assert_eq!(r.get::<Option<i64>, _>("company_id"), Some(7), "company_id is DERIVED from sessions");
    assert_eq!(r.get::<i64, _>("enabled"), 1);
    assert_eq!(r.get::<String, _>("trigger_kind"), "recurring");
    assert_eq!(r.get::<Option<String>, _>("schedule_expr").as_deref(), Some("daily at 09:00"));
    assert_eq!(r.get::<Option<String>, _>("next_run").as_deref(), Some("2026-09-01T09:00:00+00:00"));
    assert_eq!(r.get::<Option<String>, _>("last_run").as_deref(), Some("2026-08-23T09:00:00+00:00"));
    assert_eq!(r.get::<i64, _>("run_count"), 5, "run_count is continuous — the ledger must not restart");

    // A disabled schedule stays disabled. Nothing wakes up because of an upgrade.
    assert_eq!(
        scalar_i64(&pool, "SELECT enabled FROM workflows WHERE id = 'SCHED-tmux0002'").await,
        0
    );

    // schedule_expr NULL + recurrence/run_at → the synth_expr shape, computed in SQL.
    // 'daily' + '09:00' is "{minute} {hour} * * *" with leading zeros stripped.
    assert_eq!(
        ids(&pool, "SELECT schedule_expr FROM workflows WHERE id = 'SCHED-tmux0002'").await,
        vec!["0 9 * * *"]
    );

    // A workflow whose session does not exist gets NULL, not a guess and not an error.
    assert_eq!(
        sqlx::query("SELECT company_id FROM workflows WHERE id = 'SCHED-tmux0007'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<Option<i64>, _>(0),
        None
    );

    // sched_type maps 1:1 onto trigger_kind; nothing becomes 'manual' by accident.
    assert_eq!(
        scalar_i64(&pool, "SELECT COUNT(*) FROM workflows WHERE trigger_kind = 'manual'").await,
        0
    );

    cleanup(dir);
}

#[tokio::test]
async fn fire_keys_cross_over_so_the_upgrade_window_cannot_double_fire() {
    let (pool, dir) = ported().await;

    let rows = sqlx::query("SELECT workflow_id, scheduled_for_ts FROM workflow_run_keys ORDER BY workflow_id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1, "only the ported schedule's key crosses over");
    assert_eq!(rows[0].get::<String, _>("workflow_id"), "SCHED-tmux0001");
    assert_eq!(
        rows[0].get::<i64, _>("scheduled_for_ts"),
        1_700_000_100,
        "the tuple is byte-identical, so a window straddling the upgrade is still claimed"
    );

    cleanup(dir);
}

#[tokio::test]
async fn run_history_survives_so_past_runs_stay_in_the_log() {
    let (pool, dir) = ported().await;

    let runs = sqlx::query(
        "SELECT id, workflow_id, started_at, finished_at, trigger, status, note, current_step
           FROM workflow_runs ORDER BY started_at",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(runs.len(), 3, "the three tmux0001 runs port; the shell job's run does not");

    let got: Vec<(i64, String, String)> = runs
        .iter()
        .map(|r| (r.get::<i64, _>("started_at"), r.get::<String, _>("status"), r.get::<String, _>("note")))
        .collect();
    assert_eq!(
        got,
        vec![
            (1_700_000_100, "ok".to_string(), "delivered".to_string()),
            // 'done' is not a workflow_runs status (the CHECK is an exhaustive
            // enumeration); it was always an OK finish, and the fact that the
            // AGENT declared it survives on the step run's `signal`.
            (1_700_000_200, "ok".to_string(), "agent confirmed".to_string()),
            (1_700_000_300, "skipped".to_string(), "missed window".to_string()),
        ]
    );
    for r in &runs {
        assert_eq!(r.get::<String, _>("workflow_id"), "SCHED-tmux0001");
        assert_eq!(r.get::<String, _>("trigger"), "tick");
        assert_eq!(r.get::<i64, _>("current_step"), 0);
        assert_eq!(r.get::<Option<i64>, _>("finished_at"), Some(r.get::<i64, _>("started_at")));
    }

    // One step run per run, at position 0, pointing at the ported step.
    let step_runs = sqlx::query(
        "SELECT sr.run_id, sr.step_id, sr.position, sr.status, sr.signal, sr.note
           FROM workflow_step_runs sr ORDER BY sr.started_at",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(step_runs.len(), 3);
    let step_id = ids(&pool, "SELECT id FROM workflow_steps WHERE workflow_id = 'SCHED-tmux0001'").await;
    for r in &step_runs {
        assert_eq!(r.get::<i64, _>("position"), 0);
        assert_eq!(r.get::<String, _>("step_id"), step_id[0]);
    }
    assert_eq!(
        step_runs.iter().map(|r| r.get::<String, _>("signal")).collect::<Vec<_>>(),
        vec!["status-idle", "agent-confirmed", "skipped"],
        "the old status still tells us HOW each run ended"
    );

    cleanup(dir);
}

#[tokio::test]
async fn nothing_is_destroyed_shell_and_boot_land_in_the_import_log_with_reasons() {
    let (pool, dir) = ported().await;

    // EVERY pre-drop row, ported or not, tombstone or not.
    assert_eq!(
        ids(&pool, "SELECT old_id FROM workflows_import_log ORDER BY old_id").await,
        vec![
            "SCHED-boot0004",
            "SCHED-cmd00005",
            "SCHED-gone0006",
            "SCHED-shel0003",
            "SCHED-tmux0001",
            "SCHED-tmux0002",
            "SCHED-tmux0007",
        ]
    );

    let row = |id: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query("SELECT ported, reason, row_json FROM workflows_import_log WHERE old_id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };

    let shell = row("SCHED-shel0003").await;
    assert_eq!(shell.get::<i64, _>("ported"), 0);
    assert_eq!(shell.get::<String, _>("reason"), "shell jobs were removed in Workflows v1");

    let boot = row("SCHED-boot0004").await;
    assert_eq!(boot.get::<i64, _>("ported"), 0);
    assert_eq!(boot.get::<String, _>("reason"), "boot jobs were removed in Workflows v1");

    // The command: job DID port — with a disable action — and the operator's
    // follow-up text is preserved verbatim so they can rebuild it deliberately.
    let cmd = row("SCHED-cmd00005").await;
    assert_eq!(cmd.get::<i64, _>("ported"), 1);
    assert_eq!(
        cmd.get::<String, _>("reason"),
        "done_action command:… was removed; the follow-up text is preserved here"
    );
    assert!(
        cmd.get::<String, _>("row_json").contains("say hi"),
        "the follow-up text must survive the drop verbatim"
    );

    // A tombstone is archived but never resurrected.
    let gone = row("SCHED-gone0006").await;
    assert_eq!(gone.get::<i64, _>("ported"), 0);
    assert!(!gone.get::<String, _>("reason").is_empty(), "a refusal always says why");

    // A ported row's reason is empty unless there is something to say.
    let ok = row("SCHED-tmux0001").await;
    assert_eq!(ok.get::<i64, _>("ported"), 1);
    assert_eq!(ok.get::<String, _>("reason"), "");
    // The whole pre-drop row is in the JSON — including the columns v1 drops.
    let json = ok.get::<String, _>("row_json");
    for needle in ["ALL DONE", "\"watch\"", "\"confirm_finish\"", "\"bypass_permissions\"", "\"done_pattern\""] {
        assert!(json.contains(needle), "row_json must carry {needle}: {json}");
    }

    cleanup(dir);
}

#[tokio::test]
async fn the_dragons_table_is_gone() {
    let (pool, dir) = ported().await;

    assert_eq!(
        scalar_i64(
            &pool,
            "SELECT COUNT(*) FROM sqlite_master
              WHERE name IN ('schedules','schedule_runs','schedule_run_keys')",
        )
        .await,
        0,
        "schedules and its two children are dropped in the same transaction that ports them"
    );

    // And the shapes they carried cannot be re-expressed: the new CHECKs are
    // exhaustive enumerations, with no LIKE anywhere.
    let ddl = ids(
        &pool,
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'workflow%'",
    )
    .await
    .join("\n")
    .to_lowercase();
    assert!(!ddl.contains("like"), "a LIKE in a CHECK is how `command:` got in; there must be none");

    cleanup(dir);
}

// ── post-upgrade reconciliation (workflows::port::reconcile) ─────────────────
//
// The migration reads `sessions.company_id` at the instant it runs, and it can
// only write into the database it is running in. Two things therefore have to
// happen once, at boot, on the other side of it.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::state::AppState;
use supermux_server::workflows;

/// The ported fixture, wrapped in an `AppState` so `reconcile` can reach the
/// SSE bus and the push lane. Same throwaway tempdir; nothing else changes.
async fn ported_state() -> (AppState, PathBuf) {
    let (pool, dir) = ported().await;
    let config = Config {
        swarm_reaper: Default::default(),
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: "workflows-port-token".to_string(),
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
    (AppState::new(pool, config), dir)
}

#[tokio::test]
async fn reconcile_rederives_company_id_for_a_session_that_appeared_after_the_migration() {
    let (state, dir) = ported_state().await;

    // `ghost` had no sessions row when 0038 ran, so its workflow is stamped
    // NULL — correctly. This is the restored-database shape: the session rows
    // arrive afterwards.
    assert_eq!(
        sqlx::query("SELECT company_id FROM workflows WHERE id = 'SCHED-tmux0007'")
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get::<Option<i64>, _>(0),
        None
    );
    sqlx::query(
        "INSERT INTO sessions (name, dir, created_at, company_id) VALUES ('ghost', '/tmp/g', 1000, 3)",
    )
    .execute(&state.pool)
    .await
    .unwrap();

    let report = workflows::port::reconcile(&state).await.expect("reconcile");
    assert_eq!(report.rederived, 1, "exactly the one stale row is corrected");
    assert_eq!(
        sqlx::query("SELECT company_id FROM workflows WHERE id = 'SCHED-tmux0007'")
            .fetch_one(&state.pool)
            .await
            .unwrap()
            .get::<Option<i64>, _>(0),
        Some(3),
        "the cache must not stay stale — company_id is what routes the SSE frame"
    );
    // The rows that were already right are not rewritten.
    assert_eq!(
        scalar_i64(&state.pool, "SELECT company_id FROM workflows WHERE id = 'SCHED-tmux0001'").await,
        7
    );

    // Idempotent: a second pass has nothing left to do.
    assert_eq!(workflows::port::reconcile(&state).await.unwrap().rederived, 0);

    cleanup(dir);
}

#[tokio::test]
async fn reconcile_raises_exactly_one_alert_for_all_unported_rows_and_is_idempotent() {
    let (state, dir) = ported_state().await;
    let mut rx = state.sse_tx.subscribe();

    let report = workflows::port::reconcile(&state).await.expect("reconcile");
    // shell + boot + the pre-upgrade tombstone.
    assert_eq!(report.unported, 3);
    assert_eq!(report.command_notes, 1);
    assert!(report.alerted, "the first boot after the upgrade must say something");

    // ONE frame, not one per row. Drain everything queued and count.
    let mut alerts = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if ev.event == "alerts" {
            alerts.push(ev);
        }
    }
    assert_eq!(alerts.len(), 1, "one frame for the whole port, never one per row");
    let detail = alerts[0].payload.get("detail").and_then(|d| d.as_str()).unwrap_or_default();
    assert!(detail.contains('3'), "the text names the count: {detail}");
    assert!(
        detail.contains("could not be carried over"),
        "and says plainly that they were NOT migrated: {detail}"
    );
    assert_eq!(alerts[0].payload.get("source").and_then(|s| s.as_str()), Some("workflows"));

    // The audit row is the latch.
    assert_eq!(
        scalar_i64(&state.pool, "SELECT COUNT(*) FROM audit_log WHERE action = 'workflows.port'").await,
        1
    );

    // A second boot re-derives but says nothing further.
    let again = workflows::port::reconcile(&state).await.expect("reconcile twice");
    assert_eq!(again.unported, 3, "the log is still readable");
    assert!(!again.alerted, "re-announcing every restart trains the user to dismiss it");
    let mut more = 0;
    while let Ok(ev) = rx.try_recv() {
        if ev.event == "alerts" {
            more += 1;
        }
    }
    assert_eq!(more, 0);
    assert_eq!(
        scalar_i64(&state.pool, "SELECT COUNT(*) FROM audit_log WHERE action = 'workflows.port'").await,
        1
    );

    cleanup(dir);
}
