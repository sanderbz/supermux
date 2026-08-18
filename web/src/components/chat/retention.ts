// The mount-set reducer — sticky, name-keyed (fase A5 T3).
//
// A1/A3/#66 both focus seams SWAP components: `chatActive ? <ChatPanel/> :
// <LiveTerminal/>`. Every toggle is therefore a full unmount → `useLiveTerm`
// dispose → new WS → auth → resize → seed, and (since #67) the same again for
// the chat socket in the other direction. A5 stops the teardown: whichever
// renderer has been shown once stays MOUNTED for the life of this session on
// this surface, hidden in the other half of one grid cell.
//
// The rule is arithmetic, so it lives here rather than in the shell: a static
// render cannot prove a WebSocket did not reconnect, but it can prove the
// mount set is what it should be, and this is the part that decides.
//
// Retention is FOCUS-ONLY. Tiles, the hover peek and the quick-peek are
// transient surfaces and the per-session subscriber cap is real
// (`config.ws.subscribers_per_session`, enforced at `ws/mod.rs:209,467` for the
// pty and `sessions/chat/ws.rs:645` for chat — separate pools, same ceiling;
// the 33rd connection closes 1013). Cost accounting, corrected for #67: at most
// +1 pty subscriber AND +1 chat subscriber per FOCUSED session, and only after
// the user has toggled at least once.

export interface Retention {
  /** The session these mounts belong to. */
  name: string
  /** Is the chat pane in the tree (visible or hidden)? */
  chat: boolean
  /** Is the terminal pane in the tree (visible or hidden)? */
  terminal: boolean
}

export interface RetentionInput {
  name: string
  /** `chatPaneActive(...)` — chat is the VISIBLE renderer this frame. */
  chat: boolean
  /** `terminalPaneMounts(...)` — the terminal is the VISIBLE renderer this
   *  frame. Both false is the legitimate undecided frame (the sessions query
   *  has not delivered the row yet), and it must mount NOTHING. */
  terminal: boolean
  /** The pty is gone. `<StoppedSession>` owns the cell. */
  stopped: boolean
}

/**
 * Sticky-once-mounted, keyed by session.
 *
 * Three resets, each for a concrete failure:
 *   · a SESSION CHANGE resets to nothing — a retained terminal points at the
 *     WRONG pty, and revealing session A's scrollback under session B is worse
 *     than a handshake;
 *   · `stopped` resets both — the pty is gone, and a retained WS would
 *     reconnect-loop against a dead pane while `<StoppedSession>` owns the cell;
 *   · the undecided frame mounts nothing, which is A1's no-flash rule surviving
 *     retention intact.
 */
export function retain(prev: Retention | null, next: RetentionInput): Retention {
  if (next.stopped) {
    // Identity, not just value: the shell folds this during render and compares
    // by reference, so a fresh object every frame on a stopped session is an
    // infinite render loop rather than a wasted allocation.
    if (prev && prev.name === next.name && !prev.chat && !prev.terminal) return prev
    return { name: next.name, chat: false, terminal: false }
  }
  if (!prev || prev.name !== next.name) {
    return { name: next.name, chat: next.chat, terminal: next.terminal }
  }
  const chat = prev.chat || next.chat
  const terminal = prev.terminal || next.terminal
  // Identity is meaningful: the shell folds this during render and compares the
  // result by reference to decide whether to adjust its state, so returning a
  // fresh-but-equal object would be an infinite render loop.
  if (chat === prev.chat && terminal === prev.terminal) return prev
  return { name: next.name, chat, terminal }
}
