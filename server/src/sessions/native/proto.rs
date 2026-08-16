//! Holder ⇄ daemon wire protocol.
//!
//! ONE unix-stream connection carries everything: pty output, pty input,
//! resize, signals and the child-exit notification, multiplexed as
//! length-prefixed frames.
//!
//! ```text
//!   ┌──────┬──────────────┬───────────────┐
//!   │ kind │ len (u32 BE) │ payload[len]  │
//!   │ u8   │ 4 bytes      │ len bytes     │
//!   └──────┴──────────────┴───────────────┘
//! ```
//!
//! `len` is big-endian and hard-capped at [`MAX_FRAME`] (1 MiB) on BOTH sides:
//! a corrupt/hostile length can never make the peer allocate unbounded memory.
//! A zero-length payload is legal (`QUERY`, `SHUTDOWN`).
//!
//! ## Kinds
//!
//! Daemon → holder (`0x0_`):
//!
//! | kind | name     | payload                                        |
//! |------|----------|------------------------------------------------|
//! | 0x01 | `INPUT`  | raw bytes, written verbatim to the pty master  |
//! | 0x02 | `RESIZE` | `u16 cols BE` + `u16 rows BE` → `TIOCSWINSZ`   |
//! | 0x03 | `SIGNAL` | `i32 signum BE`, sent to the child's process group |
//! | 0x04 | `QUERY`  | *(empty)* → holder answers with `INFO`         |
//! | 0x05 | `ATTACH_FROM` | `u64 BE` absolute spool offset already received |
//!
//! Holder → daemon (`0x8_`):
//!
//! | kind | name     | payload                                              |
//! |------|----------|------------------------------------------------------|
//! | 0x81 | `HELLO`  | JSON [`Hello`] — always the FIRST frame on a connection |
//! | 0x82 | `OUTPUT` | raw pty bytes (replay tail first, then live)          |
//! | 0x83 | `EXIT`   | `i32 BE` child exit status (`-1` = killed by signal / unknown) |
//! | 0x84 | `INFO`   | JSON [`Info`] — answer to `QUERY`                     |
//!
//! ## Attach handshake (why there are no gaps and no duplicates)
//!
//! On accept the holder takes ONE lock that guards both the spool and the
//! "current connection" slot. Under that lock it (a) snapshots the spool tail
//! and (b) installs the new connection's queue. Every pty chunk is appended to
//! the spool and pushed to the queue under the SAME lock, so each byte is
//! either in the snapshot (before the cutover) or in the queue (after) —
//! never both, never neither. The holder then writes `HELLO`, the snapshot as
//! `OUTPUT` frames, and finally the live queue. The daemon can therefore feed
//! every `OUTPUT` frame into its VT in arrival order without any offset
//! bookkeeping of its own.
//!
//! Exactly ONE daemon connection is served at a time: a new connection
//! replaces the old one (the old queue is dropped, which closes it).
//!
//! ## `ATTACH_FROM` — delta replay (why a reconnect is not an 8 MiB event)
//!
//! The daemon sends ONE frame before anything else on every connection:
//!
//! ```text
//!   0x05  len=8  <u64 BE absolute spool offset>
//! ```
//!
//! The offset is "I have already received spool bytes `[0, offset)`" — the
//! daemon derives it from the previous connection's `HELLO`
//! (`replay_from + every OUTPUT byte counted since`). `0` means "I have
//! nothing, send the full tail".
//!
//! The holder waits up to ~200 ms for that frame (an older daemon simply never
//! sends one, which reads as `0`), and only THEN takes the attach lock and
//! snapshots. When `offset` still sits inside the retained spool it snapshots
//! exactly `[offset, total)` and reports `delta: true` + `replay_from: offset`
//! in [`Hello`]; otherwise it falls back to the full [`REPLAY_TAIL`] tail with
//! `delta: false`, and the daemon rebuilds its grid from scratch as before.
//!
//! Why it matters: a lag-drop used to cost `attach → 8 MiB replay → the daemon
//! falls behind parsing it → lag-drop → attach → 8 MiB …` at ~4 Hz, which is
//! how a busy session's holder gets hammered into the ground. With a delta the
//! reconnect costs the handful of kilobytes that actually flowed during the gap.
//!
//! Both directions of the version skew are supported, which matters because a
//! deploy is exactly when a NEW daemon meets OLD holders: unknown frame kinds
//! are ignored by both sides, and the new [`Hello`] fields are `#[serde(default)]`
//! so an old holder's JSON still parses (`delta: false` → full replay).
//!
//! [`REPLAY_TAIL`]: crate::sessions::native::spool::REPLAY_TAIL

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

// ── daemon → holder ─────────────────────────────────────────────────────────

/// Raw bytes for the pty master (keystrokes, pastes, `send_text`).
pub const INPUT: u8 = 0x01;
/// `u16 cols` + `u16 rows`, big-endian → `TIOCSWINSZ` on the master.
pub const RESIZE: u8 = 0x02;
/// `i32 signum`, big-endian → `killpg(child)`.
pub const SIGNAL: u8 = 0x03;
/// Empty → the holder replies with [`INFO`].
pub const QUERY: u8 = 0x04;
/// `u64` big-endian: the absolute spool offset the daemon has already received.
/// Sent as the FIRST frame on every connection (`0` = "send the full tail").
/// See the module docs for the delta-replay handshake.
pub const ATTACH_FROM: u8 = 0x05;

// ── holder → daemon ─────────────────────────────────────────────────────────

/// JSON [`Hello`]; always the first frame the holder writes on a connection.
pub const HELLO: u8 = 0x81;
/// Raw pty output bytes.
pub const OUTPUT: u8 = 0x82;
/// `i32` child exit status, big-endian. The holder exits right after.
pub const EXIT: u8 = 0x83;
/// JSON [`Info`], in reply to [`QUERY`].
pub const INFO: u8 = 0x84;

/// Hard cap on one frame's payload. Output frames are chunked well below this
/// ([`crate::sessions::native::holder::CHUNK`]); the cap exists so a corrupt
/// length header can't make either side allocate unbounded memory.
pub const MAX_FRAME: usize = 1024 * 1024;

/// First frame on every connection: what the daemon needs to know before it
/// starts replaying (`replay_bytes` lets it size/log the rebuild; `cols`/`rows`
/// let it build the VT at the pty's REAL geometry instead of guessing).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Hello {
    /// Session name the holder was started for.
    pub session: String,
    /// Child pid (the `bash -lc` process — also the process-group leader).
    pub pid: u32,
    /// Current pty width.
    pub cols: u16,
    /// Current pty height.
    pub rows: u16,
    /// Unix seconds when the holder spawned the child.
    pub started_at: i64,
    /// How many bytes of spool tail follow as `OUTPUT` frames before live
    /// output begins.
    pub replay_bytes: u64,
    /// Total bytes ever appended to the spool (pre-rotation) — also the
    /// absolute offset the LIVE stream starts at, since the snapshot and this
    /// number are taken under the same lock.
    pub spool_total: u64,
    /// Absolute spool offset of the first replay byte (`spool_total -
    /// replay_bytes` in the normal case). Sent explicitly rather than derived so
    /// the daemon's offset bookkeeping does not depend on arithmetic that a
    /// degraded spool could invalidate.
    #[serde(default)]
    pub replay_from: u64,
    /// `true` when the replay is the DELTA the daemon asked for with
    /// [`ATTACH_FROM`] — it continues exactly where the daemon left off, so the
    /// daemon keeps its grid instead of rebuilding it. `false` (also the default
    /// for a pre-delta holder) means "full tail, rebuild from scratch".
    #[serde(default)]
    pub delta: bool,
    /// `true` when the holder's spool is not recording (disk error). The replay
    /// may have a hole in it and delta replay is off for the rest of this
    /// holder's life; the child is unaffected.
    #[serde(default)]
    pub spool_degraded: bool,
    /// Bytes the child wrote that never reached the spool (0 in the normal case).
    #[serde(default)]
    pub spool_dropped: u64,
}

/// Answer to [`QUERY`] — the liveness/pid probe.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Info {
    /// Child pid.
    pub pid: u32,
    /// `true` once the child has been reaped (an `EXIT` frame is on its way).
    pub exited: bool,
    /// Current pty width.
    pub cols: u16,
    /// Current pty height.
    pub rows: u16,
    /// Total bytes ever appended to the spool.
    pub spool_total: u64,
}

/// Write one frame. Single `write_all` of a header+payload scratch buffer so a
/// frame is never split by a concurrent writer (there is only one writer task
/// per connection, but keeping frames atomic keeps that invariant cheap).
pub async fn write_frame<W: AsyncWrite + Unpin>(
    w: &mut W,
    kind: u8,
    payload: &[u8],
) -> io::Result<()> {
    if payload.len() > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("frame payload {} > MAX_FRAME", payload.len()),
        ));
    }
    let mut buf = Vec::with_capacity(5 + payload.len());
    buf.push(kind);
    buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    buf.extend_from_slice(payload);
    w.write_all(&buf).await
}

/// Read one frame. `Ok(None)` on a clean EOF at a frame boundary (the peer
/// closed); an EOF *mid-frame* is an error (truncated stream).
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut head = [0u8; 5];
    match r.read_exact(&mut head).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame length {len} > MAX_FRAME"),
        ));
    }
    let mut payload = vec![0u8; len];
    if len > 0 {
        r.read_exact(&mut payload).await?;
    }
    Ok(Some((head[0], payload)))
}

/// Encode a `RESIZE` payload.
pub fn resize_payload(cols: u16, rows: u16) -> [u8; 4] {
    let mut p = [0u8; 4];
    p[..2].copy_from_slice(&cols.to_be_bytes());
    p[2..].copy_from_slice(&rows.to_be_bytes());
    p
}

/// Decode a `RESIZE` payload; `None` if it isn't exactly 4 bytes.
pub fn parse_resize(payload: &[u8]) -> Option<(u16, u16)> {
    if payload.len() != 4 {
        return None;
    }
    Some((
        u16::from_be_bytes([payload[0], payload[1]]),
        u16::from_be_bytes([payload[2], payload[3]]),
    ))
}

/// Encode an [`ATTACH_FROM`] payload (`u64` big-endian).
pub fn attach_from_payload(offset: u64) -> [u8; 8] {
    offset.to_be_bytes()
}

/// Decode an [`ATTACH_FROM`] payload; `None` if it isn't exactly 8 bytes.
pub fn parse_u64(payload: &[u8]) -> Option<u64> {
    let bytes: [u8; 8] = payload.try_into().ok()?;
    Some(u64::from_be_bytes(bytes))
}

/// Decode a `SIGNAL` / `EXIT` payload (`i32` big-endian).
pub fn parse_i32(payload: &[u8]) -> Option<i32> {
    if payload.len() != 4 {
        return None;
    }
    Some(i32::from_be_bytes([
        payload[0], payload[1], payload[2], payload[3],
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_round_trip_preserves_kind_and_payload() {
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, OUTPUT, b"hello \x1b[31mworld").await.unwrap();
        write_frame(&mut buf, QUERY, b"").await.unwrap();
        write_frame(&mut buf, RESIZE, &resize_payload(120, 40)).await.unwrap();

        let mut cur = std::io::Cursor::new(buf);
        let (k, p) = read_frame(&mut cur).await.unwrap().unwrap();
        assert_eq!(k, OUTPUT);
        assert_eq!(p, b"hello \x1b[31mworld");
        let (k, p) = read_frame(&mut cur).await.unwrap().unwrap();
        assert_eq!((k, p.len()), (QUERY, 0));
        let (k, p) = read_frame(&mut cur).await.unwrap().unwrap();
        assert_eq!(k, RESIZE);
        assert_eq!(parse_resize(&p), Some((120, 40)));
        // Clean EOF at a frame boundary → None, not an error.
        assert!(read_frame(&mut cur).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn oversized_length_header_is_rejected_without_allocating() {
        // kind=OUTPUT, len = 4 GiB - 1. Must error, not try to allocate.
        let bytes = vec![OUTPUT, 0xff, 0xff, 0xff, 0xff];
        let mut cur = std::io::Cursor::new(bytes);
        let err = read_frame(&mut cur).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    /// The position frame is the whole delta-replay handshake: 8 big-endian
    /// bytes, and anything else is refused rather than silently read as 0 (a 0
    /// would cost the holder a full 8 MiB tail).
    #[tokio::test]
    async fn attach_from_carries_a_u64_offset() {
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, ATTACH_FROM, &attach_from_payload(8_388_608)).await.unwrap();
        let mut cur = std::io::Cursor::new(buf);
        let (k, p) = read_frame(&mut cur).await.unwrap().unwrap();
        assert_eq!(k, ATTACH_FROM);
        assert_eq!(parse_u64(&p), Some(8_388_608));
        assert_eq!(parse_u64(&[0; 4]), None, "a short payload is not an offset");
        assert_eq!(parse_u64(&[0; 9]), None, "an over-long payload is not an offset");
        assert_eq!(parse_u64(&u64::MAX.to_be_bytes()), Some(u64::MAX));
    }

    /// A `HELLO` from a PRE-delta holder has none of the new fields. It must
    /// still parse — that is the mixed-version deploy this whole change happens
    /// during — and read as "full tail, healthy spool".
    #[test]
    fn an_old_holders_hello_still_parses_as_a_full_replay() {
        let old = br#"{"session":"s","pid":42,"cols":80,"rows":24,"started_at":7,
                       "replay_bytes":100,"spool_total":500}"#;
        let hello: Hello = serde_json::from_slice(old).unwrap();
        assert_eq!((hello.replay_bytes, hello.spool_total), (100, 500));
        assert!(!hello.delta, "an old holder never sends a delta");
        assert_eq!(hello.replay_from, 0);
        assert!(!hello.spool_degraded);
        assert_eq!(hello.spool_dropped, 0);
    }

    #[tokio::test]
    async fn truncated_frame_is_an_error_not_a_clean_eof() {
        let mut buf: Vec<u8> = vec![OUTPUT, 0, 0, 0, 8];
        buf.extend_from_slice(b"abc"); // 3 of the promised 8 bytes
        let mut cur = std::io::Cursor::new(buf);
        assert!(read_frame(&mut cur).await.is_err());
    }
}
