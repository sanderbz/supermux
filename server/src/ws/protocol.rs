//! WebSocket control-frame wire protocol (TECH_PLAN §3.4).
//!
//! Text frames carry these JSON control messages; binary frames carry raw pty
//! bytes (server→client only). The first text frame a client sends MUST be
//! [`ClientMsg::Auth`] — the in-band first-frame auth that keeps the token out of
//! URLs/logs/screenshots (Codex T0 / #7). All variants use an internally-tagged
//! `{"type": "...", ...}` shape.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientMsg {
    /// First-frame auth: `{"type":"auth","token":"<dashboard-bearer>"}`.
    Auth { token: String },
    /// Literal text to inject at the pane (xterm `onData`).
    Input { data: String },
    /// A named tmux key (e.g. `Enter`, `C-c`, `Up`).
    Key { data: String },
    /// Terminal resize from the client's `FitAddon` + `ResizeObserver`.
    Resize { cols: u16, rows: u16 },
    /// Client-initiated liveness ping (server PINGs on its own 20s cadence).
    Ping,
}
