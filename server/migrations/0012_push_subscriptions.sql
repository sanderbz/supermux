-- migrations/0012_push_subscriptions.sql
-- Web push subscriptions (PUSH milestone — web push notifications).
--
-- The dashboard is single-user, but a user may install the PWA on several
-- devices (phone + tablet + laptop home-screen), so this is a one-row-per-
-- device table keyed by the browser-issued push `endpoint` (globally unique
-- per subscription). `send_push` fans a notification out to every row.
--
-- Stored fields are exactly the browser `PushSubscription` JSON the client
-- POSTs to `/api/push/subscribe`:
--   endpoint — the push-service URL the encrypted payload is delivered to.
--   p256dh   — the subscription's public key (base64url), for payload encryption.
--   auth     — the subscription's auth secret (base64url), for payload encryption.
-- These are USER DATA (a capability to push to the device) — never logged.
--
-- Additive only: no existing table/column is touched. A stale endpoint that the
-- push service reports 404/410 (Gone) for is pruned by `send_push` so dead
-- devices don't accumulate.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
