//! HTTP Range + ETag helpers for `GET /api/file/raw` (feature-extract §3.7).
//!
//! A single byte range only — multipart/byte-range responses are intentionally
//! unsupported (no client needs them; `<video>`/`<audio>` send single ranges).

/// An inclusive byte range `[start, end]` (RFC 7233 semantics).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

impl ByteRange {
    /// Number of bytes the range covers.
    pub fn len(&self) -> u64 {
        self.end - self.start + 1
    }
}

/// Parse a `Range: bytes=…` header value against the resource `total` size.
///
/// Returns `None` for: a non-`bytes` unit, a multi-range request, a malformed
/// spec, or a range that cannot be satisfied (start past EOF). Forms handled:
/// `bytes=A-B`, `bytes=A-` (A..EOF), `bytes=-N` (last N bytes).
pub fn parse_range(header: &str, total: u64) -> Option<ByteRange> {
    if total == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None; // single range only
    }
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());

    let range = match (a.is_empty(), b.is_empty()) {
        (false, false) => {
            let start: u64 = a.parse().ok()?;
            let end: u64 = b.parse().ok()?;
            if start > end {
                return None;
            }
            ByteRange { start, end: end.min(total - 1) }
        }
        (false, true) => {
            let start: u64 = a.parse().ok()?;
            ByteRange { start, end: total - 1 }
        }
        (true, false) => {
            // Suffix: the last N bytes.
            let n: u64 = b.parse().ok()?;
            if n == 0 {
                return None;
            }
            let n = n.min(total);
            ByteRange { start: total - n, end: total - 1 }
        }
        (true, true) => return None,
    };

    if range.start >= total {
        return None; // unsatisfiable
    }
    Some(range)
}

/// The weak-ish validator `"{mtime}-{size}"` used for `ETag`/`If-None-Match`.
pub fn etag(mtime: i64, size: u64) -> String {
    format!("\"{mtime}-{size}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_closed_range() {
        assert_eq!(parse_range("bytes=2-5", 10), Some(ByteRange { start: 2, end: 5 }));
    }

    #[test]
    fn clamps_end_to_eof() {
        assert_eq!(parse_range("bytes=8-100", 10), Some(ByteRange { start: 8, end: 9 }));
    }

    #[test]
    fn open_ended_runs_to_eof() {
        assert_eq!(parse_range("bytes=3-", 10), Some(ByteRange { start: 3, end: 9 }));
    }

    #[test]
    fn suffix_takes_last_n() {
        assert_eq!(parse_range("bytes=-3", 10), Some(ByteRange { start: 7, end: 9 }));
    }

    #[test]
    fn rejects_unsatisfiable_and_malformed() {
        assert_eq!(parse_range("bytes=20-30", 10), None);
        assert_eq!(parse_range("bytes=5-2", 10), None);
        assert_eq!(parse_range("bytes=0-1,3-4", 10), None);
        assert_eq!(parse_range("items=0-1", 10), None);
        assert_eq!(parse_range("bytes=2-5", 0), None);
    }

    #[test]
    fn etag_format() {
        assert_eq!(etag(1700000000, 42), "\"1700000000-42\"");
    }
}
