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
    /// Request a window of authoritative scrollback from tmux (copy-mode over
    /// web). `end_offset <= -1` (scrollback coord; `-1` = the row just above the
    /// visible top); the server returns up to `count` physical rows ending there,
    /// captured at the pane's CURRENT width. `req_id` correlates async replies —
    /// a fling scroll leaves many requests inflight and the client keeps only the
    /// newest. `cols` is the client's grid width for the width-match guard (the
    /// client discards rows whose captured width no longer matches its grid).
    ///
    /// `rename_all = "lowercase"` makes the wire tag `"history"`. `ClientMsg`
    /// does NOT set `deny_unknown_fields`, so an OLD server given a `history`
    /// frame simply fails `from_str` and the loop drops it — graceful downgrade,
    /// no explicit guard needed.
    History {
        req_id: u32,
        end_offset: i64,
        count: u32,
        cols: u16,
    },
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

    #[test]
    fn parses_history_control_frame() {
        // `{"type":"history",...}` is the copy-mode-over-web scrollback request:
        // the client asks for `count` physical rows ending at `end_offset`,
        // captured at `cols`, correlated by `req_id` so a fling's stale replies
        // can be discarded. The `rename_all="lowercase"` tag is `"history"`.
        let msg = serde_json::from_str::<ClientMsg>(
            r#"{"type":"history","req_id":7,"end_offset":-1,"count":300,"cols":80}"#,
        )
        .expect("history control frame must deserialize");
        match msg {
            ClientMsg::History {
                req_id,
                end_offset,
                count,
                cols,
            } => {
                assert_eq!(req_id, 7);
                assert_eq!(end_offset, -1);
                assert_eq!(count, 300);
                assert_eq!(cols, 80);
            }
            other => panic!("expected ClientMsg::History, got {other:?}"),
        }
    }
}
