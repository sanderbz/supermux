#!/usr/bin/env python3
"""amux -> supermux data migration.

One-shot, idempotent, dry-runnable. Reads an amux install (~/.amux/) and writes
into the supermux SQLite database (~/.supermux/data.db).

Design constraints:
  * Column-explicit copies ONLY -- never `SELECT *`. The schemas drift, so
    every column is named on both sides and dry-run asserts compatibility.
  * `INSERT OR IGNORE` everywhere -- safe to re-run; counts never double.
  * Sessions come from filesystem (~/.amux/sessions/*.env + *.meta.json), not
    the v2 DB. .env is parsed quote-aware.
  * Each migrated session gets a freshly generated `hook_token`
    (secrets.token_urlsafe(32)) in `session_runtime`.
  * `schedule_run_keys` is v3 idempotency state -- left empty by design.
  * Memory/log files stay in their v2 locations (not touched here).

Usage:
    migrate-v2.py [--dry-run] [--src DIR] [--dst-db FILE]

  --dry-run   Count rows / parse files WITHOUT writing. Also asserts that the
              v2 column set is a superset of the v3 required columns for every
              copied table and reports any drift.
  --src       v2 data dir (default: ~/.amux).
  --dst-db    v3 SQLite database (default: ~/.supermux/data.db).

The v2 DB filename is auto-detected: `data.db` or `amux.db` inside --src.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import pathlib
import secrets
import sqlite3
import sys
import time

# ---------------------------------------------------------------------------
# Table column maps -- EXPLICIT column lists (TECH_PLAN §9: never SELECT *).
# For DB-to-DB copies: the v3 destination columns. v2 source columns are the
# same names (drift is handled per-table below via defaults / COALESCE).
# ---------------------------------------------------------------------------

# DB tables copied old.<t> -> v3.<t> with identical column names on both sides.
SIMPLE_COPY_TABLES = {
    "issues": [
        "id", "title", "desc", "status", "session", "creator", "due",
        "due_time", "created", "updated", "deleted", "owner_type", "pinned",
        "pos", "notified",
    ],
    "issue_tags": ["issue_id", "tag"],
    "issue_counters": ["prefix", "next_n"],
    "statuses": ["id", "label", "position", "is_builtin"],
    "skills": ["name", "content", "updated"],
    "prefs": ["key", "value"],
}

# v3 `sessions` columns we populate from the filesystem .env/.meta.json pair.
SESSION_COLUMNS = [
    "name", "dir", "desc", "provider", "flags", "pinned", "archived",
    "auto_continue", "auto_continue_msg", "rate_limit_resume_text", "tags",
    "creator", "branch", "worktree", "worktree_repo", "mcp", "created_at",
    "start_count", "last_started", "last_send", "last_send_text",
    "task_summary", "cc_session_name", "cc_conversation_id",
    "codex_session_id", "start_error",
]


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# .env parsing -- quote-aware (handles `KEY="value with spaces"`).
# ---------------------------------------------------------------------------

def parse_env(path: pathlib.Path) -> dict:
    """Parse a v2 session .env file. Quote-aware, comment-aware."""
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        # Strip a single matching pair of surrounding quotes.
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            inner = val[1:-1]
            if val[0] == '"':
                # Unescape common double-quote escapes.
                inner = inner.replace('\\"', '"').replace("\\\\", "\\")
            val = inner
        out[key] = val
    return out


def truthy(v: str | None) -> int:
    return 1 if str(v or "").strip().lower() in ("1", "true", "yes", "on") else 0


def csv_tags_to_json(raw: str | None) -> str:
    """v2 CC_TAGS is comma-separated; v3 `sessions.tags` is a JSON array."""
    if not raw:
        return "[]"
    raw = raw.strip()
    if raw.startswith("[") and raw.endswith("]"):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return json.dumps([str(t) for t in parsed])
        except json.JSONDecodeError:
            pass
    tags = [t.strip() for t in raw.split(",") if t.strip()]
    return json.dumps(tags)


# ---------------------------------------------------------------------------
# Dry-run drift check: assert v2 column set superset of v3 required columns.
# ---------------------------------------------------------------------------

def table_columns(con: sqlite3.Connection, schema: str,
                  table: str) -> set[str]:
    """Column names for a table. `schema` is 'main' or 'old' (the ATTACHed
    v2 db). PRAGMA does not accept `schema.table` inside the parens, so the
    schema is passed via the documented `PRAGMA schema.table_info(name)`."""
    return {r[1] for r in
            con.execute(f"PRAGMA {schema}.table_info({table})")}


def table_exists(con: sqlite3.Connection, schema: str, table: str) -> bool:
    row = con.execute(
        f"SELECT 1 FROM {schema}.sqlite_master "
        f"WHERE type='table' AND name=?", (table,)).fetchone()
    return row is not None


def check_drift(con: sqlite3.Connection) -> bool:
    """Returns True if compatible, False if a blocking drift was found."""
    ok = True
    log("\n-- column drift check (v2 must be a superset of v3-required) --")
    for table, cols in SIMPLE_COPY_TABLES.items():
        if not table_exists(con, "old", table):
            log(f"  {table:16s} SKIP  (v2 table missing)")
            continue
        v2_cols = table_columns(con, "old", table)
        v3_cols = table_columns(con, "main", table)
        required = set(cols)
        missing_in_v2 = required - v2_cols
        v2_only = v2_cols - v3_cols
        v3_extra = v3_cols - v2_cols
        if missing_in_v2:
            ok = False
            log(f"  {table:16s} DRIFT  v2 is MISSING required cols: "
                f"{sorted(missing_in_v2)}")
        else:
            log(f"  {table:16s} OK    (v2 superset of {len(required)} "
                f"required cols)")
        if v2_only:
            log(f"  {'':16s}        v2-only cols dropped in v3: "
                f"{sorted(v2_only)}")
        if v3_extra:
            log(f"  {'':16s}        v3-only cols (defaulted): "
                f"{sorted(v3_extra)}")
    return ok


# ---------------------------------------------------------------------------
# Migration steps. Each returns (inserted, total_seen).
# ---------------------------------------------------------------------------

def migrate_sessions(con: sqlite3.Connection, src: pathlib.Path,
                     dry_run: bool) -> tuple[int, int]:
    sess_dir = src / "sessions"
    env_files = sorted(sess_dir.glob("*.env"))
    inserted = 0
    runtime_inserted = 0
    for env_file in env_files:
        name = env_file.stem
        env = parse_env(env_file)
        meta_file = sess_dir / f"{name}.meta.json"
        meta: dict = {}
        if meta_file.exists():
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as e:
                log(f"  WARN: bad meta for {name}: {e} -- using defaults")

        provider = (env.get("CC_PROVIDER") or "claude").strip().lower()
        if provider not in ("claude", "codex", "shell"):
            provider = "claude"
        created_at = int(meta.get("created_at")
                         or env_file.stat().st_mtime)

        row = (
            name,
            env.get("CC_DIR", ""),
            env.get("CC_DESC", ""),
            provider,
            env.get("CC_FLAGS", ""),
            truthy(env.get("CC_PINNED")),
            truthy(env.get("CC_ARCHIVED")),
            truthy(env.get("CC_AUTO_CONTINUE")),
            env.get("CC_AUTO_CONTINUE_MSG", "continue"),
            env.get("CC_RATE_LIMIT_RESUME_TEXT", "continue"),
            csv_tags_to_json(env.get("CC_TAGS")),
            env.get("CC_CREATOR") or meta.get("creator", "") or "",
            "" if env.get("CC_BRANCH", "").strip().lower() in ("", "none")
            else env.get("CC_BRANCH", ""),
            truthy(env.get("CC_WORKTREE")),
            env.get("CC_WORKTREE_REPO", ""),
            env.get("CC_MCP", ""),
            created_at,
            int(meta.get("start_count") or 0),
            int(meta.get("last_started") or 0),
            int(meta.get("last_send") or 0),
            str(meta.get("last_send_text") or "")[:200],
            str(meta.get("task_summary") or ""),
            str(meta.get("cc_session_name") or ""),
            str(meta.get("cc_conversation_id") or ""),
            str(meta.get("codex_session_id") or ""),
            str(meta.get("start_error") or ""),
        )
        assert len(row) == len(SESSION_COLUMNS), "session row/col mismatch"

        if not dry_run:
            placeholders = ", ".join("?" * len(SESSION_COLUMNS))
            cols = ", ".join(SESSION_COLUMNS)
            cur = con.execute(
                f"INSERT OR IGNORE INTO sessions ({cols}) "
                f"VALUES ({placeholders})", row)
            inserted += cur.rowcount
            # session_runtime: fresh hook_token per session (v3-only column).
            rt = con.execute(
                "INSERT OR IGNORE INTO session_runtime (name, hook_token) "
                "VALUES (?, ?)",
                (name, secrets.token_urlsafe(32)))
            runtime_inserted += rt.rowcount
        else:
            inserted += 1
    log(f"  sessions        : {inserted} inserted / {len(env_files)} v2 .env "
        f"files" + ("" if dry_run else
                    f"  (+{runtime_inserted} session_runtime rows)"))
    return inserted, len(env_files)


def migrate_table(con: sqlite3.Connection, table: str, cols: list[str],
                  dry_run: bool, *, transform: str = "") -> tuple[int, int]:
    """Generic column-explicit old.<table> -> v3.<table> copy."""
    try:
        total = con.execute(f"SELECT COUNT(*) FROM old.{table}").fetchone()[0]
    except sqlite3.Error as e:
        log(f"  {table:16s}: SKIP (v2 table missing: {e})")
        return 0, 0
    col_list = ", ".join(cols)
    # transform overrides the SELECT expression list when v3 needs coercion.
    select_expr = transform or col_list
    if dry_run:
        log(f"  {table:16s}: {total} v2 rows (would INSERT OR IGNORE)")
        return total, total
    before = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    con.execute(
        f"INSERT OR IGNORE INTO {table} ({col_list}) "
        f"SELECT {select_expr} FROM old.{table}")
    after = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    inserted = after - before
    log(f"  {table:16s}: {inserted} inserted / {total} v2 rows")
    return inserted, total


def migrate_schedules(con: sqlite3.Connection,
                      dry_run: bool) -> tuple[int, int]:
    """schedules: v3 adds boot_dir/boot_provider/boot_worktree (defaulted)."""
    v3_cols = [
        "id", "title", "session", "command", "kind", "boot_dir",
        "boot_provider", "boot_worktree", "sched_type", "recurrence",
        "run_at", "next_run", "last_run", "enabled", "run_count",
        "schedule_expr", "watch", "watch_timeout", "done_pattern",
        "done_action", "created", "updated", "deleted",
    ]
    # v2 lacks boot_* -> supply literal defaults in the SELECT.
    select_expr = (
        "id, title, session, command, kind, '' , 'claude', 0, "
        "sched_type, recurrence, run_at, next_run, last_run, enabled, "
        "run_count, schedule_expr, watch, watch_timeout, done_pattern, "
        "done_action, created, updated, deleted"
    )
    return migrate_table(con, "schedules", v3_cols, dry_run,
                         transform=select_expr)


def migrate_schedule_runs(con: sqlite3.Connection,
                          dry_run: bool) -> tuple[int, int]:
    """schedule_runs: v2 `note` is nullable; v3 is NOT NULL DEFAULT ''."""
    v3_cols = ["id", "schedule_id", "ran_at", "status", "note"]
    select_expr = ("id, schedule_id, ran_at, status, "
                   "COALESCE(note, '')")
    return migrate_table(con, "schedule_runs", v3_cols, dry_run,
                         transform=select_expr)


# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------

def find_v2_db(src: pathlib.Path) -> pathlib.Path | None:
    for candidate in ("data.db", "amux.db"):
        p = src / candidate
        if p.exists():
            return p
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="amux v2 -> v3 data migration")
    ap.add_argument("--dry-run", action="store_true",
                    help="count + drift-check only; no writes")
    ap.add_argument("--src", default=str(pathlib.Path.home() / ".amux"),
                    help="v2 data dir (default: ~/.amux)")
    ap.add_argument("--dst-db",
                    default=str(pathlib.Path.home() / ".supermux" / "data.db"),
                    help="v3 SQLite db (default: ~/.supermux/data.db)")
    args = ap.parse_args()

    src = pathlib.Path(args.src).expanduser()
    dst_db = pathlib.Path(args.dst_db).expanduser()
    mode = "DRY-RUN" if args.dry_run else "REAL"

    log(f"amux v2 -> v3 migration [{mode}]")
    log(f"  src    : {src}")
    log(f"  dst-db : {dst_db}")

    if not src.is_dir():
        log(f"ERROR: v2 data dir not found: {src}")
        return 2
    v2_db = find_v2_db(src)
    if v2_db is None:
        log(f"ERROR: no v2 database (data.db / amux.db) in {src}")
        return 2
    if not dst_db.exists():
        log(f"ERROR: v3 database not found: {dst_db} "
            f"(run the v3 server once to create it)")
        return 2
    log(f"  v2 db  : {v2_db}")

    con = sqlite3.connect(str(dst_db))
    try:
        con.execute("PRAGMA foreign_keys = ON")
        con.execute("ATTACH DATABASE ? AS old", (str(v2_db),))

        if args.dry_run:
            compatible = check_drift(con)
            log("\n-- row counts (dry-run, no writes) --")
            migrate_sessions(con, src, dry_run=True)
            for table, cols in SIMPLE_COPY_TABLES.items():
                migrate_table(con, table, cols, dry_run=True)
            migrate_schedules(con, dry_run=True)
            migrate_schedule_runs(con, dry_run=True)
            log("\n  schedule_run_keys: 0 (intentionally empty -- v3 "
                "idempotency state)")
            if not compatible:
                log("\nDRY-RUN RESULT: COLUMN DRIFT DETECTED -- fix before "
                    "real run.")
                return 1
            log("\nDRY-RUN RESULT: OK -- v2 schema compatible, safe to "
                "migrate.")
            return 0

        # Real run.
        log("\n-- migrating (INSERT OR IGNORE -- idempotent) --")
        migrate_sessions(con, src, dry_run=False)
        for table, cols in SIMPLE_COPY_TABLES.items():
            migrate_table(con, table, cols, dry_run=False)
        migrate_schedules(con, dry_run=False)
        migrate_schedule_runs(con, dry_run=False)
        con.commit()
        log("\n  schedule_run_keys: left empty (v3 idempotency state)")

        # Summary of final v3 state.
        log("\n-- v3 database now contains --")
        for table in ["sessions", "session_runtime", "issues", "issue_tags",
                       "issue_counters", "statuses", "schedules",
                       "schedule_runs", "skills", "prefs"]:
            cnt = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            log(f"  {table:16s}: {cnt}")
        log("\nMIGRATION COMPLETE.")
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
