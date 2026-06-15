//! WebSocket control-frame wire protocol.
//!
//! Text frames carry these JSON control messages; binary frames carry raw pty
//! bytes (server→client only). The first text frame a client sends MUST be
//! [`ClientMsg::Auth`] — the in-band first-frame auth that keeps the token out of
//! URLs/logs/screenshots. All variants use an internally-tagged
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
    /// Request a fresh full-screen snapshot ("resync"). The server re-pushes the
    /// clear + alt-screen-aware capture (the same payload as the attach seed) on
    /// the existing socket, deterministically wiping any client-side render
    /// garble — an inline-TUI cursor-relative redraw landing on rows xterm has
    /// reflowed (e.g. after a width change) leaves stale, misaligned rows that
    /// only a remount/reconnect/reload would otherwise clear. The web client
    /// sends this from a manual "refresh" affordance; the server ALSO triggers
    /// the same resync automatically (debounced) after it applies a client
    /// resize, so the common trigger self-heals with no user action.
    Resync,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_resync_control_frame() {
        // `{"type":"resync"}` is the manual-refresh / auto-heal control frame:
        // the client asks the server to re-push a clean full-screen snapshot
        // (clear + alt-screen-aware capture) so any client-side render garble
        // from an inline-TUI redraw landing on reflowed rows is wiped — the
        // same coherent state a full page reload reaches, without the reload.
        let msg = serde_json::from_str::<ClientMsg>(r#"{"type":"resync"}"#)
            .expect("resync control frame must deserialize");
        assert!(matches!(msg, ClientMsg::Resync));
    }
}
