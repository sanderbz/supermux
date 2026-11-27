-- Browser-control scope. 'origin' (the default, and every existing row) keeps
-- the exact-origin capability. 'all' is the owner-only "All websites" scope:
-- it lets the controlled tab leave the paired origin (except blocked sites)
-- and stops authorizing anything at expires_at (Unix seconds, 24 h after the
-- claim). Additive only: reverting the code leaves these columns unused.
ALTER TABLE browser_feedback_pairings ADD COLUMN scope TEXT NOT NULL DEFAULT 'origin' CHECK(scope IN ('origin','all'));
ALTER TABLE browser_feedback_bindings ADD COLUMN scope TEXT NOT NULL DEFAULT 'origin' CHECK(scope IN ('origin','all'));
ALTER TABLE browser_feedback_bindings ADD COLUMN expires_at INTEGER;

-- An all-sites capability exists only for the owner. Any change of the
-- claiming user's role or company (also owner -> admin) revokes it for good.
CREATE TRIGGER browser_control_all_sites_claimant_changed
AFTER UPDATE OF company_id,role ON human_users
WHEN OLD.company_id IS NOT NEW.company_id OR OLD.role IS NOT NEW.role
BEGIN
    UPDATE browser_feedback_bindings SET revoked_at=CAST(strftime('%s','now') AS INTEGER)
        WHERE paired_by_user_id=NEW.id AND scope='all' AND revoked_at IS NULL;
END;
