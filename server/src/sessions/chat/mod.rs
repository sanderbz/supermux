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
//! Later tasks add `ws` and `statusline`.

pub mod model;
pub mod parser;
pub mod store;
pub mod tailer;
