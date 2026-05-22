-- migrations/0003_schedules.sql
-- Scheduler tables. Verbatim from TECH_PLAN §3.3.

CREATE TABLE schedules (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    session       TEXT NOT NULL DEFAULT '',
    command       TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'tmux',         -- 'tmux'|'shell'|'boot'
    boot_dir      TEXT NOT NULL DEFAULT '',             -- for kind=boot
    boot_provider TEXT NOT NULL DEFAULT 'claude',
    boot_worktree INTEGER NOT NULL DEFAULT 0,
    sched_type    TEXT NOT NULL DEFAULT 'once',         -- 'once'|'recurring'
    recurrence    TEXT,                                  -- 'hourly'|'daily'|'weekly'|'monthly'
    run_at        TEXT,
    next_run      TEXT,
    last_run      TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    run_count     INTEGER NOT NULL DEFAULT 0,
    schedule_expr TEXT,
    watch         INTEGER NOT NULL DEFAULT 0,
    watch_timeout INTEGER NOT NULL DEFAULT 120,
    done_pattern  TEXT,
    done_action   TEXT NOT NULL DEFAULT 'disable',
    created       INTEGER NOT NULL,
    updated       INTEGER NOT NULL,
    deleted       INTEGER,
    CHECK (kind IN ('tmux','shell','boot')),
    CHECK (sched_type IN ('once','recurring')),                                    -- Added v2 (Eng schema gap)
    CHECK (done_action IN ('disable','notify') OR done_action LIKE 'command:%')   -- Added v2 (Eng schema gap)
);
CREATE INDEX idx_schedules_due ON schedules(deleted, enabled, next_run);

-- Added v2 (Eng): idempotency tuple for scheduler missed-tick recovery (Codex #6)
-- (schedule_id, scheduled_for_ts) UNIQUE — prevents double-fire on restart
CREATE TABLE schedule_run_keys (
    schedule_id      TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    scheduled_for_ts INTEGER NOT NULL,
    fired_at         INTEGER NOT NULL,
    PRIMARY KEY (schedule_id, scheduled_for_ts)
);

CREATE TABLE schedule_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    ran_at      INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'ok',             -- 'ok'|'error'|'done'
    note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_schedule_runs_sid ON schedule_runs(schedule_id, ran_at DESC);
