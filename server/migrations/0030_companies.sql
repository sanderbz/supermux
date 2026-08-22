-- 0030_companies.sql
-- Companies (Bot Mode): a first-class company registry, a nullable company_id
-- filter attribute on sessions (NULL = the main/PA/tech-admin bots), a seeded
-- human_users owner row (dormant until P3), and the P2 company_connectors store.
--
-- IMMUTABLE ONCE SHIPPED. sessions.company_id is a PLAIN NULLABLE INTEGER with
-- NO default. We DELIBERATELY omit the inline REFERENCES (SQLite would ALLOW it
-- here -- host_id in 0018 carries `REFERENCES hosts(id)`; the FK-on trap is only a
-- NON-NULL DEFAULT on an ADD COLUMN, not the REFERENCES itself). Integrity is
-- enforced in the application layer and by the trg_company_delete_* triggers.

CREATE TABLE companies (
    id           INTEGER PRIMARY KEY,               -- rowid; mirrors hosts(id)
    slug         TEXT    NOT NULL UNIQUE,            -- stable, [A-Za-z0-9_.-]+
    display_name TEXT    NOT NULL,                   -- mutable, may repeat
    root_dir     TEXT    NOT NULL,                   -- absolute folder root
    archived     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

-- Plain nullable INTEGER, no default; inline REFERENCES omitted BY CHOICE (see
-- header) not by FK-on necessity. NULL = main bot.
ALTER TABLE sessions ADD COLUMN company_id INTEGER;
CREATE INDEX idx_sessions_company ON sessions(company_id);

CREATE TABLE human_users (
    id           INTEGER PRIMARY KEY,
    email        TEXT    NOT NULL UNIQUE,
    display_name TEXT    NOT NULL,
    company_id   INTEGER,                            -- NULL = owner / admin-all
    role         TEXT    NOT NULL DEFAULT 'member'
                   CHECK (role IN ('owner','admin','member')),
    created_at   INTEGER NOT NULL
);

-- Seed exactly one owner row. Email is a runtime-resolved sentinel, NOT the
-- owner's real address hardcoded into a checksummed, world-readable migration
-- (keeps PII out of git; the real email is bound from config at startup -- §7).
INSERT INTO human_users (email, display_name, company_id, role, created_at)
VALUES ('owner@localhost', 'Owner', NULL, 'owner',
        CAST(strftime('%s','now') AS INTEGER));

-- P2 store. config_json holds encrypt-at-rest secrets (§6). target_session NULL
-- => shared to the whole company; else a single bot slug (name-matched wholesale
-- replace). Cascade on company delete via trigger (FK-on forbids the inline FK
-- with the pattern above, and we keep the table consistent with sessions).
CREATE TABLE company_connectors (
    id             INTEGER PRIMARY KEY,
    company_id     INTEGER NOT NULL,                 -- logical FK -> companies(id)
    name           TEXT    NOT NULL,                 -- mcpServers key
    config_json    TEXT    NOT NULL,                 -- vault-sealed blob (§6)
    target_session TEXT,                             -- NULL = whole company
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    UNIQUE (company_id, name, target_session)
);
CREATE INDEX idx_company_connectors_company ON company_connectors(company_id);

-- Cascade: when a company row is deleted, drop its connectors and NULL its
-- sessions' company_id (turning them into main bots is safer than orphaning --
-- but hard-delete is admin-only and archival is the default; see §9).
CREATE TRIGGER trg_company_delete_connectors
AFTER DELETE ON companies BEGIN
    DELETE FROM company_connectors WHERE company_id = OLD.id;
END;
CREATE TRIGGER trg_company_delete_sessions
AFTER DELETE ON companies BEGIN
    UPDATE sessions SET company_id = NULL WHERE company_id = OLD.id;
END;
