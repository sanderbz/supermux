-- Multi-account connector foundation (additive, backfill-safe).
--
-- The connector store's owner override: ONE connector can hold N connected
-- ACCOUNTS, each with its own non-secret display identity (`account_label`, e.g.
-- 'sander@acme.com'), its own sealed secret (`secret_ref` → vault.id), and its own
-- lifecycle `status`. A grant then references WHICH account it uses.
--
-- Why a dedicated table rather than a bare `session_connectors.account_label`
-- column: the owner's rules require an account atom that OUTLIVES any single grant.
-- "Disconnect = revoke the grants but KEEP the sealed secret for a 1-tap reconnect"
-- means the (label, secret_ref, status) tuple must survive after every grant row is
-- gone — a per-grant column cannot (it is deleted with the grant, and the vault row
-- is secret-only / label-free). A first-class row can, and it is also the only place
-- "two connected accounts, zero grants" can be represented at all.
--
-- Immutable-safe: this ONLY adds a new table + one nullable column; it edits nothing
-- shipped (sqlx checksums migrations — an edit VersionMismatch-bricks deployed
-- installs). No FK-on-add-with-non-null-default trap (0034 header): the new column is
-- plain nullable.

-- One row per CONNECTED ACCOUNT. `account_label` is NON-secret and stored in
-- cleartext (display only) — the encrypted vault stays write-only for secrets.
-- `secret_ref` is the vault id of THIS account's sealed credential; it is kept even
-- after a disconnect so a reconnect reuses it (status flips, the secret stays).
CREATE TABLE connector_accounts (
    id            TEXT PRIMARY KEY,                 -- the account_ref (uuid)
    connector_id  TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    account_label TEXT NOT NULL DEFAULT '',         -- e.g. 'sander@acme.com'; '' when a connector captures no identity
    secret_ref    TEXT,                             -- vault.id of this account's secret (NULL for a no-secret connector)
    status        TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'disconnected'
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER NOT NULL DEFAULT 0        -- passive freshness (written at launch, later slice)
);

CREATE INDEX idx_connector_accounts_connector ON connector_accounts(connector_id);

-- Which account a grant is using. NULL for a legacy / no-account grant (every grant
-- that existed before this migration, and no-identity catalog connectors). No FK —
-- same free-of-vault-coupling discipline `secret_ref` already follows (0031), and a
-- plain nullable add applies cleanly under foreign_keys=ON.
ALTER TABLE session_connectors ADD COLUMN account_ref TEXT;
