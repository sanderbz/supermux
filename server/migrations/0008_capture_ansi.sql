-- migrations/0008_capture_ansi.sql (NEW v3 — overview tile preview)
-- The hero tile preview renders the agent's REAL terminal colours. `last_capture`
-- stays ANSI-stripped (the status detector regex bank + `preview_lines` depend on
-- a plain-text capture); this parallel column keeps the SAME tail with its SGR
-- escapes intact, so `SessionView.preview_ansi` can drive a colour-true preview
-- without disturbing the detector. Written by the same 2s capture tick.
ALTER TABLE session_runtime ADD COLUMN last_capture_ansi TEXT NOT NULL DEFAULT '';
