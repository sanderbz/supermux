//! Chat data plane — the read-only transcript pipeline behind the chat renderer.
//!
//! Layering (fase A2):
//! - [`model`]  — typed entries + the **sealed** wire type (`WireEntry`), the
//!   only thing the WS/SSE layers may serialize. Its single constructor applies
//!   the per-entry cap, so an uncapped entry cannot reach the wire without
//!   editing that file.
//! - [`parser`] — streaming JSONL → [`model::ChatEntry`], pinned by the A0
//!   fixture corpus at `server/tests/fixtures/chat/`.
//!
//! Later tasks add `store` (ring + `seq` + snapshot-and-subscribe), `tailer`
//! (byte cursor + staleness guard), `ws` and `statusline`.

pub mod model;
pub mod parser;
