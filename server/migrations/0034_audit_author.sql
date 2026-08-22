-- 0034_audit_author.sql
-- Per-message human authorship (P3c): give the audit ledger a REAL person +
-- company for actions taken by an authenticated Human colleague (P3a). Until now
-- a scoped human's action was attributable only to the free-text `actor` string;
-- these two columns tie every human action to a `human_users` row and a company.
--
-- IMMUTABLE ONCE SHIPPED. Both columns are PLAIN NULLABLE INTEGERs with NO
-- default. `author_user_id` carries an inline `REFERENCES human_users(id)` — the
-- FK-on-ADD-COLUMN trap the 0032 header documents is a NON-NULL DEFAULT, not the
-- REFERENCES itself (host_id in 0018 / company_id in 0032 set the precedent), and
-- human_users exists (created in 0032, before this migration). Owner actions
-- leave BOTH columns NULL and keep the existing `actor` — the owner is not a
-- Human context, so no per-person attribution is written for it.
ALTER TABLE audit_log ADD COLUMN author_user_id INTEGER REFERENCES human_users(id);
ALTER TABLE audit_log ADD COLUMN author_company_id INTEGER;
