-- Connector-account health / freshness columns (additive, backfill-safe).
--
-- Passive freshness (`connector_accounts.last_used_at`) already shipped in 0035.
-- This migration adds the ACTIVE-health home so a later per-kind "Test connection"
-- probe (IMAP login for iCloud, an API ping for a catalog MCP) has somewhere to
-- write WITHOUT another migration. Nothing writes these yet — they are present-now,
-- written-later (KISS): shipping the columns with the account foundation keeps the
-- probe slice migration-free.
--
-- Immutable-safe: additive columns only, each nullable or NOT NULL DEFAULT — no
-- FK-on-add-with-non-null-default trap (0034 header).
ALTER TABLE connector_accounts ADD COLUMN health          TEXT;                  -- NULL | 'ok' | 'expired' | 'error'
ALTER TABLE connector_accounts ADD COLUMN last_checked_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connector_accounts ADD COLUMN last_error      TEXT;                  -- masked, human-readable
