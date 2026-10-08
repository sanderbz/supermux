-- Capabilities keep their original company and claiming identity. Do not use
-- ON DELETE SET NULL for creator: deleting a member must not upgrade to owner.
ALTER TABLE browser_feedback_bindings ADD COLUMN company_id INTEGER;
ALTER TABLE browser_feedback_bindings ADD COLUMN paired_by_user_id INTEGER;
ALTER TABLE browser_feedback_bindings ADD COLUMN paired_by_company_id INTEGER;
-- Pre-0045 claims were owner/admin-only; keep their creator NULL while fencing
-- the agent to its current company. New Human claims store their real identity.
UPDATE browser_feedback_bindings SET company_id=(
    SELECT company_id FROM sessions WHERE sessions.name=browser_feedback_bindings.session
);

-- Permanent revocation also prevents a moved/deleted identity's old credential
-- becoming valid again if the company or SQLite row id is later reused.
CREATE TRIGGER browser_feedback_session_scope_changed
AFTER UPDATE OF company_id ON sessions
WHEN OLD.company_id IS NOT NEW.company_id
BEGIN
    UPDATE browser_feedback_bindings SET revoked_at=CAST(strftime('%s','now') AS INTEGER)
        WHERE session=NEW.name AND revoked_at IS NULL;
    UPDATE browser_feedback SET status='cancelled',reason='Agent company changed.',updated_at=CAST(strftime('%s','now') AS INTEGER)
        WHERE status='queued' AND binding_id IN (SELECT id FROM browser_feedback_bindings WHERE session=NEW.name);
END;
CREATE TRIGGER browser_feedback_claimant_scope_changed
AFTER UPDATE OF company_id,role ON human_users
WHEN OLD.company_id IS NOT NEW.company_id OR (NEW.company_id IS NULL AND NEW.role NOT IN ('owner','admin'))
BEGIN
    UPDATE browser_feedback_bindings SET revoked_at=CAST(strftime('%s','now') AS INTEGER)
        WHERE paired_by_user_id=NEW.id AND revoked_at IS NULL;
    UPDATE browser_feedback SET status='cancelled',reason='Pairing user permissions changed.',updated_at=CAST(strftime('%s','now') AS INTEGER)
        WHERE status='queued' AND binding_id IN (SELECT id FROM browser_feedback_bindings WHERE paired_by_user_id=NEW.id);
END;
CREATE TRIGGER browser_feedback_claimant_deleted
BEFORE DELETE ON human_users
BEGIN
    UPDATE browser_feedback_bindings SET revoked_at=CAST(strftime('%s','now') AS INTEGER)
        WHERE paired_by_user_id=OLD.id AND revoked_at IS NULL;
    UPDATE browser_feedback SET status='cancelled',reason='Pairing user was removed.',updated_at=CAST(strftime('%s','now') AS INTEGER)
        WHERE status='queued' AND binding_id IN (SELECT id FROM browser_feedback_bindings WHERE paired_by_user_id=OLD.id);
END;
