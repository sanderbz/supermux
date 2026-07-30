//! [`PtyReader`] over a native session — the tap that feeds the existing
//! `PtySink` (broadcast fan-out + replay ring + detector heartbeat) from the
//! holder's byte stream.
//!
//! The VT grid is fed by the session's own pump, NOT here: the grid must stay
//! current even when no WebSocket is attached (the status detector captures
//! from it, and a reattaching client expects a live screen). This reader only
//! forwards LIVE bytes downstream, so everything past the sink — the 1013
//! lag-drop, the 32-subscriber cap, the wake-on-edge — behaves exactly as it
//! does for the tmux readers.
//!
//! **Self-healing contract.** `run` returns only when the stream is genuinely
//! dead. A dropped holder connection is NOT death: the pump reconnects and
//! replays, and this reader simply keeps forwarding. It returns `Ok(())` only
//! once the child has actually exited.

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::broadcast::error::RecvError;

use super::runtime::NativeSession;
use crate::sessions::pty::{PtyReader, PtySink, ReaderExit};

/// Streams one native session's live pty bytes into a [`PtySink`].
pub struct NativePtyReader {
    session: Arc<NativeSession>,
}

impl NativePtyReader {
    /// Wrap an existing session handle.
    pub fn new(session: Arc<NativeSession>) -> Self {
        Self { session }
    }
}

#[async_trait]
impl PtyReader for NativePtyReader {
    async fn run(self: Box<Self>, sink: PtySink) -> std::result::Result<(), ReaderExit> {
        let mut rx = self.session.subscribe();
        let mut detached = self.session.detached_watch();

        // A session whose child is already gone must not hold the stream open.
        if self.session.dead().await {
            return Ok(());
        }

        loop {
            tokio::select! {
                _ = sink.shutdown.notified() => {
                    tracing::debug!(session = %sink.name, "native reader shutdown (session restart)");
                    return Err(ReaderExit::Shutdown);
                }
                msg = rx.recv() => match msg {
                    Ok(chunk) => sink.forward_chunk(chunk),
                    // A slow sink is a downstream concern; dropping frames here
                    // is recoverable (the client re-seeds from the grid), so we
                    // keep going rather than tearing the stream down.
                    Err(RecvError::Lagged(n)) => {
                        tracing::warn!(session = %sink.name, dropped = n, "native reader lagged");
                    }
                    // The session handle was dropped out from under us.
                    Err(RecvError::Closed) => return Ok(()),
                },
                _ = detached.changed() => {
                    // Detach alone is not death — the pump reconnects and
                    // replays. Only a real child exit ends the stream.
                    if self.session.dead().await {
                        tracing::debug!(session = %sink.name, "native reader: child gone, stream dead");
                        return Ok(());
                    }
                }
            }
        }
    }
}
