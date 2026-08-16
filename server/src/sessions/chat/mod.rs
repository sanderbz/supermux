//! Chat data plane — the read-only transcript pipeline behind the chat renderer.
//!
//! Layering (fase A2):
//! - [`model`]  — typed entries + the **sealed** wire type (`WireEntry`), the
//!   only thing the WS/SSE layers may serialize. Its single constructor applies
//!   the per-entry cap, so an uncapped entry cannot reach the wire without
//!   editing that file.
//! - [`parser`] — streaming JSONL → [`model::ChatEntry`], pinned by the A0
//!   fixture corpus at `server/tests/fixtures/chat/`.
//! - [`store`]  — the per-session ring, the monotonic `seq`, and the
//!   snapshot-and-subscribe that makes the seed→live boundary provably free of
//!   gaps and overlaps. The tailer is its only producer; the WS, the history
//!   route and the sessions-SSE `chat_tail` are pure consumers.
//!
//! - [`tailer`] — the byte cursor, the subagents scope and the staleness guard
//!   (the pointer can be stale after a restart, a `/clear` or a terminal-side
//!   `--resume`). It is the ONLY reader of a transcript file, which is what
//!   makes byte offsets and `seq` consistent by construction.
//!
//! - [`ws`]     — the chat WebSocket (seed → `seed_done` → live `entry`s, with
//!   `state`/`resync` overlays) plus the two backlog REST routes. A pure
//!   consumer of the store: it never reads a transcript for the live path, so
//!   the tailer stays the file's only reader.
//!
//! - [`statusline`] — the OPT-IN Claude statusline tap: a wrap-don't-clobber
//!   installer for the single global `statusLine` slot, its exact uninstall, and
//!   the hook-token-authed ingest for what the tap POSTs. Off by default and
//!   unreachable from the session create/start path by construction; the only
//!   thing in the chat data plane that writes to the user's own Claude config.

pub mod model;
pub mod parser;
pub mod statusline;
pub mod store;
pub mod tailer;
pub mod ws;
