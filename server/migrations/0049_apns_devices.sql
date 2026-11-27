-- Native iOS push (APNs) devices.
--
-- The web app reaches a phone through Web Push (`push_subscriptions`, 0012);
-- the native iOS app cannot, so it registers its APNs device token here and
-- `crate::apns` fans every push that passes the Web Push gate out to these rows
-- as well. One row per device token (APNs issues one per app install).
--
--   device_token — hex APNs token, lowercase. A capability to push to the
--                  device: never logged, never returned by the API.
--   environment  — `sandbox` (Xcode builds) or `production` (TestFlight / App
--                  Store); picks the APNs host for this device.
--   bundle_id    — the app's bundle id; must equal the configured topic.
--   client_ref   — opaque (<= 64 chars) string the app chose; echoed in every
--                  payload so the app knows which of its servers sent it.
--
-- Additive only. A token APNs reports as `410 Unregistered` / `400
-- BadDeviceToken` is pruned by the sender. Numbered 0049 (not 0048) because an
-- open PR already claims 0048; sqlx applies migrations by version, not by gap.
CREATE TABLE IF NOT EXISTS apns_devices (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_token TEXT NOT NULL UNIQUE,
    environment  TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
    bundle_id    TEXT NOT NULL,
    device_name  TEXT NOT NULL DEFAULT '',
    app_version  TEXT,
    client_ref   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,  -- epoch ms
    last_seen_at INTEGER NOT NULL   -- epoch ms; refreshed by every register
);
