-- Connector store + credential vault + per-agent grants (additive, backfill-safe).
--
-- The foundation for the connector store (spec
-- docs/superpowers/specs/2026-08-18-connector-store-design.md §3): every
-- connector is a manifest (`connectors`), granted per-agent or to all agents
-- (`session_connectors`), with any secret held encrypted at rest (`vault`) and
-- injected as an env var at launch — never written into ~/.claude.json and never
-- surfaced to the agent transcript.
--
-- This migration ONLY adds tables + one nullable column; it edits nothing that
-- already exists (sqlx checksums migrations — an edit VersionMismatch-bricks
-- deployed installs). The vestigial `sessions.mcp` column is left inert: scoping
-- is driven entirely from `session_connectors` below.

-- One row per installed connector manifest (catalog-installed OR agent-authored).
-- `*_json` columns hold the manifest's card + credential-schema + emit block
-- verbatim (see server/src/connectors/manifest.rs); secrets are NEVER stored here
-- — only the credential SCHEMA (field names/types), never their values.
CREATE TABLE connectors (
    id               TEXT PRIMARY KEY,        -- stable slug, e.g. 'icloud-mail'
    kind             TEXT NOT NULL,           -- mcp_catalog | agent_authored | builtin_browser
    display_name     TEXT NOT NULL DEFAULT '',
    icon             TEXT NOT NULL DEFAULT '',-- data-URI or mirrored URL
    description      TEXT NOT NULL DEFAULT '',
    tools_json       TEXT NOT NULL DEFAULT '[]',  -- declared tools (name+desc) for the card
    credentials_json TEXT NOT NULL DEFAULT '[]',  -- .mcpb user_config-shaped credential SCHEMA
    emit_json        TEXT NOT NULL DEFAULT '{}',  -- the mcpServers entry template ({command|url,...,env:{K:${VAR}}})
    source_json      TEXT NOT NULL DEFAULT '{}',  -- provenance: catalog ref / .mcpb path / builder run id
    created_at       INTEGER NOT NULL
);

-- The grant — the per-agent scoping primitive. `session_name = '*'` is the
-- sentinel for ALL agents (unioned into every session's inline config at launch).
-- No FK on `session_name` (the '*' sentinel is not a real session row); the
-- connector back-ref DOES cascade so deleting a connector drops its grants.
CREATE TABLE session_connectors (
    session_name TEXT NOT NULL,               -- sessions.name, or '*' = all agents
    connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    secret_ref   TEXT,                         -- vault.id (NULL for no-secret connectors)
    enabled      INTEGER NOT NULL DEFAULT 1,   -- soft toggle
    granted_at   INTEGER NOT NULL,
    PRIMARY KEY (session_name, connector_id)
);

CREATE INDEX idx_session_connectors_connector ON session_connectors(connector_id);

-- Encrypted secrets, WRITE-ONLY from the API (raw in, masked out, never logged).
-- `fields_enc` is AES-256-GCM ciphertext (ciphertext || 16-byte tag) of the
-- credential field-map; `nonce` is the per-secret 12-byte GCM nonce. Decrypted
-- only at launch to inject as env (server/src/vault).
CREATE TABLE vault (
    id           TEXT PRIMARY KEY,             -- the secret_ref
    connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    fields_enc   BLOB NOT NULL,
    nonce        BLOB NOT NULL,
    created_at   INTEGER NOT NULL,
    rotated_at   INTEGER NOT NULL DEFAULT 0
);

-- The memory phase's shared-role tier: a session's role identity id (nullable).
-- Nothing consumes it in THIS phase; it exists so the column is present when the
-- memory phase lands and does not need to edit an existing migration. Nullable +
-- no REFERENCES so it applies cleanly under foreign_keys=ON.
ALTER TABLE sessions ADD COLUMN role_id TEXT;
