//! End-to-end tests for the native runtime.
//!
//! These are REAL: a real `openpty` pair, a real child process on the slave, a
//! real unix socket, real frames, a real spool on disk, and the real
//! `alacritty_terminal` grid on the other end. The ONLY thing simulated is the
//! process boundary — the holder runs as a task inside the test process,
//! because `cargo test --lib` does not build the binary that hosts the
//! `pty-holder` subcommand. Every line of holder logic under test is the same
//! code the subcommand runs (`holder::run`).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::runtime::NativeSession;
use super::{holder, proto, spool};

/// A unique temp data dir per test.
fn data_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "supermux-native-{tag}-{}-{}",
        std::process::id(),
        Instant::now().elapsed().as_nanos()
            ^ std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Start a holder task for `name` running `command`, and return its handle.
fn start_holder(
    data_dir: &std::path::Path,
    name: &str,
    cols: u16,
    rows: u16,
    command: &str,
) -> tokio::task::JoinHandle<()> {
    let args = holder::Args {
        session: name.to_string(),
        dir: spool::session_dir(data_dir, name),
        socket: spool::socket_path(data_dir, name),
        cols,
        rows,
        command: command.to_string(),
    };
    tokio::spawn(async move {
        if let Err(e) = holder::run(args).await {
            eprintln!("holder exited with error: {e:#}");
        }
    })
}

/// Poll `$cond` until it is true or `$timeout` elapses. A macro rather than a
/// function taking a closure: the conditions here `.await` on borrowed state,
/// which an `FnMut` returning an async block cannot express.
macro_rules! wait_until {
    ($timeout:expr, $cond:expr) => {{
        let deadline = Instant::now() + $timeout;
        let mut ok = false;
        while Instant::now() < deadline {
            if $cond {
                ok = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        ok
    }};
}

/// Wait for the grid to contain `needle`; returns the capture that matched.
async fn wait_for_text(session: &Arc<NativeSession>, needle: &str, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    let mut last = String::new();
    while Instant::now() < deadline {
        last = session.capture_full().await;
        if last.contains(needle) {
            return last;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("grid never contained {needle:?}; last capture:\n{last}");
}

/// (a) End-to-end: holder + pty + child + socket + grid + history + kill.
#[tokio::test]
async fn holder_end_to_end_feeds_the_grid_and_serves_history() {
    let dir = data_dir("e2e");
    let h = start_holder(&dir, "e2e", 80, 24, "seq 1 100; sleep 30");
    let session = NativeSession::new("e2e", &dir);

    assert!(
        wait_until!(Duration::from_secs(10), session.attached()),
        "pump never attached to the holder",
    );

    // The child's output reached the daemon's grid.
    let full = wait_for_text(&session, "100", Duration::from_secs(10)).await;
    assert!(full.contains("100"), "viewport tail missing:\n{full}");
    assert!(full.contains('1'), "history head missing:\n{full}");

    // The visible screen holds the tail; the rest scrolled into history.
    let screen = session.capture_screen_ansi().await;
    assert!(screen.contains("100"), "screen:\n{screen}");
    let (history_size, cols) = session.history_meta().await;
    assert!(history_size >= 70, "history_size={history_size}");
    assert_eq!(cols, 80);

    // A history window returns physical rows anchored by history_size.
    let w = session.history_window(-1, 5).await;
    assert_eq!(w.rows.len(), 5);
    assert_eq!(w.cols, 80);
    assert!(!w.hit_top);
    assert!(!w.at_limit);
    let plain: Vec<String> = w
        .rows
        .iter()
        .map(|r| super::serialize::strip_sgr(r))
        .collect();
    assert!(
        plain.iter().any(|r| r.trim() == "76"),
        "expected the rows just above the viewport, got {plain:?}",
    );

    // The spool was written and the child pid is known.
    let spool_bytes = std::fs::metadata(spool::spool_path(&spool::session_dir(&dir, "e2e")))
        .unwrap()
        .len();
    assert!(spool_bytes > 100, "spool is suspiciously small: {spool_bytes}");
    assert!(session.pane_pid().await.is_some_and(|p| p > 1));

    // Kill: SIGHUP through the holder, then the exit marker + a dead session.
    assert!(session.alive().await);
    session.kill().await.unwrap();
    assert!(
        wait_until!(Duration::from_secs(5), session.dead().await),
        "session never went dead after kill()",
    );
    assert!(
        wait_until!(Duration::from_secs(5), spool::read_exit(&spool::session_dir(&dir, "e2e")).is_some()),
        "holder never wrote the exit marker",
    );

    h.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

/// (b) Deploy survival: drop the daemon-side object (the daemon "restarted"),
/// attach a fresh one, and the grid must rebuild IDENTICALLY from the spool.
#[tokio::test]
async fn reattach_replays_the_spool_into_an_identical_grid() {
    let dir = data_dir("replay");
    let h = start_holder(&dir, "replay", 80, 24, "seq 1 100; sleep 30");

    let session = NativeSession::new("replay", &dir);
    wait_for_text(&session, "100", Duration::from_secs(10)).await;
    let before_full = session.capture_full().await;
    let before_seed = session.seed().await;
    let before_meta = session.history_meta().await;
    let before_window = session.history_window(-1, 20).await;
    assert!(before_full.contains("100"));

    // The daemon goes away. The holder and its child do not.
    drop(session);
    tokio::time::sleep(Duration::from_millis(200)).await;

    // A brand-new daemon-side object, from nothing but the socket + spool.
    let session2 = NativeSession::new("replay", &dir);
    assert!(
        wait_until!(Duration::from_secs(10), session2.attached()),
        "second pump never attached",
    );
    // Let the replay frames land.
    assert!(
        wait_until!(Duration::from_secs(10), session2.capture_full().await == before_full),
        "replayed grid differs.\nBEFORE:\n{before_full}\nAFTER:\n{}",
        session2.capture_full().await,
    );

    assert_eq!(session2.history_meta().await, before_meta);
    assert_eq!(session2.seed().await, before_seed);
    assert_eq!(session2.history_window(-1, 20).await.rows, before_window.rows);
    assert!(session2.alive().await);

    session2.kill().await.unwrap();
    h.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

/// Input path: `send_text` + `send_key` reach the child's pty verbatim.
#[tokio::test]
async fn send_text_and_keys_reach_the_child() {
    let dir = data_dir("input");
    // `cat` echoes what it reads, so anything that shows up twice made the
    // full round trip (terminal echo + the child's own write).
    let h = start_holder(&dir, "input", 80, 24, "cat");
    let session = NativeSession::new("input", &dir);
    assert!(wait_until!(Duration::from_secs(10), session.attached()));

    session.send_text("hello-native").await.unwrap();
    session.send_key("Enter").await.unwrap();
    // Wait for BOTH copies (terminal echo + cat's write). On a slow runner the
    // echo lands first — asserting right after the first appearance raced.
    assert!(
        wait_until!(
            Duration::from_secs(10),
            session.capture_full().await.matches("hello-native").count() >= 2
        ),
        "expected echo + cat's copy:\n{}",
        session.capture_full().await,
    );

    // A literal that tmux's send-keys lexer would have swallowed (trailing `;`).
    session.send_text("trailing;").await.unwrap();
    session.send_key("Enter").await.unwrap();
    wait_for_text(&session, "trailing;", Duration::from_secs(10)).await;

    // Bracketed paste wraps the payload in the standard markers.
    session.paste("pasted-text", true).await.unwrap();
    session.send_key("Enter").await.unwrap();
    wait_for_text(&session, "pasted-text", Duration::from_secs(10)).await;

    // An unknown key name is rejected rather than sent as garbage.
    assert!(session.send_key("NotAKey").await.is_err());

    session.kill().await.unwrap();
    h.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

/// (e) Resize: the pty learns the new size (the child sees SIGWINCH and reads
/// it back with `stty size`) and the grid reflows.
#[tokio::test]
async fn resize_reaches_the_child_and_reflows_the_grid() {
    let dir = data_dir("resize");
    // bash defers traps until the foreground command finishes, so background
    // the sleep and `wait` — that makes the WINCH trap fire immediately.
    let h = start_holder(
        &dir,
        "resize",
        80,
        24,
        "trap 'stty size' WINCH; echo ready; sleep 30 & wait",
    );
    let session = NativeSession::new("resize", &dir);
    assert!(wait_until!(Duration::from_secs(10), session.attached()));
    wait_for_text(&session, "ready", Duration::from_secs(10)).await;

    session.resize(40, 20).await.unwrap();

    // The child's own view of the pty geometry: `stty size` prints "rows cols".
    let cap = wait_for_text(&session, "20 40", Duration::from_secs(10)).await;
    assert!(cap.contains("20 40"), "child never saw the new winsize:\n{cap}");

    // …and the daemon-side grid resized with it.
    let (_, cols) = session.history_meta().await;
    assert_eq!(cols, 40);
    assert!(session.capture_screen_ansi().await.split('\n').count() <= 20);

    session.kill().await.unwrap();
    h.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

/// A holder with no daemon attached must keep the child running and keep
/// spooling — the daemon is optional, which is the whole point of the split.
#[tokio::test]
async fn holder_keeps_running_and_spooling_without_a_daemon() {
    let dir = data_dir("nodaemon");
    let sdir = spool::session_dir(&dir, "nodaemon");
    let h = start_holder(&dir, "nodaemon", 80, 24, "for i in $(seq 1 20); do echo tick-$i; done; sleep 30");

    // No NativeSession at all for the first stretch.
    assert!(
        wait_until!(Duration::from_secs(10), std::fs::metadata(spool::spool_path(&sdir)).map(|m| m.len()).unwrap_or(0) > 100),
        "holder did not spool without a daemon",
    );
    assert!(spool::read_meta(&sdir).is_some(), "meta.json must be written at spawn");
    assert!(spool::read_exit(&sdir).is_none(), "child must still be running");

    // Attach late: everything that happened while we were away is replayed.
    let session = NativeSession::new("nodaemon", &dir);
    let cap = wait_for_text(&session, "tick-20", Duration::from_secs(10)).await;
    assert!(cap.contains("tick-1"), "full backlog should replay:\n{cap}");

    session.kill().await.unwrap();
    h.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

/// A second daemon connection REPLACES the first (the holder serves one at a
/// time) and the newcomer gets a complete grid.
#[tokio::test]
async fn a_second_daemon_connection_replaces_the_first() {
    let dir = data_dir("replace");
    let h = start_holder(&dir, "replace", 80, 24, "echo first-line; sleep 30");
    let a = NativeSession::new("replace", &dir);
    wait_for_text(&a, "first-line", Duration::from_secs(10)).await;

    let b = NativeSession::new("replace", &dir);
    assert!(
        wait_until!(Duration::from_secs(10), b.attached()),
        "the replacing connection never attached",
    );
    wait_for_text(&b, "first-line", Duration::from_secs(10)).await;
    // The displaced handle notices it lost the connection.
    assert!(
        wait_until!(Duration::from_secs(5), !a.attached()),
        "the displaced connection should have been dropped by the holder",
    );

    b.kill().await.unwrap();
    h.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

/// Every `L<n>.` token in `bytes`, in order. The child prints exactly one of
/// each, so the sequence a daemon receives must be strictly consecutive: a gap
/// is a lost chunk, a repeat is a duplicated one.
fn tokens(bytes: &[u8]) -> Vec<u64> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'L' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        // Require the closing `.` so a token cut by the end of the capture (or
        // by the head of a truncated replay tail) is skipped rather than
        // misread as a smaller number.
        if j > i + 1 && j < bytes.len() && bytes[j] == b'.' {
            if let Ok(n) = std::str::from_utf8(&bytes[i + 1..j]).unwrap_or("x").parse::<u64>() {
                out.push(n);
            }
            i = j + 1;
        } else {
            i = j.max(i + 1);
        }
    }
    out
}

/// (S5) The attach seam is exactly-once even though the replay tail is now read
/// OUTSIDE the holder's `Inner` lock.
///
/// Under the lock the holder only fixes the tail's end offset and installs the
/// live queue; the (up to 8 MiB) `pread` happens afterwards, concurrently with
/// the child still writing. This attaches to a holder whose child is streaming
/// at full tilt and checks the received byte stream for BOTH failure modes: a
/// byte that made it into neither the snapshot nor the queue (gap), and one
/// that made it into both (duplicate).
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn attaching_mid_stream_neither_loses_nor_duplicates_bytes() {
    const LINES: u64 = 200_000;
    let dir = data_dir("seam");
    let sdir = spool::session_dir(&dir, "seam");
    let h = start_holder(
        &dir,
        "seam",
        200,
        50,
        &format!("for i in $(seq 1 {LINES}); do echo \"L$i.\"; done; sleep 30"),
    );

    // Attach MID-stream: as soon as a slice of output has landed, while the
    // child is still pouring the rest in. That is the only interesting timing —
    // it puts bytes on both sides of the cutover.
    let spooled = || {
        std::fs::metadata(spool::spool_path(&sdir))
            .map(|m| m.len())
            .unwrap_or(0)
    };
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && spooled() < 100_000 {
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert!(spooled() >= 100_000, "the child never produced enough output to attach mid-stream");

    let mut stream = tokio::net::UnixStream::connect(spool::socket_path(&dir, "seam"))
        .await
        .expect("connect to the holder");

    let (kind, payload) = proto::read_frame(&mut stream).await.unwrap().unwrap();
    assert_eq!(kind, proto::HELLO, "HELLO must be the first frame");
    let hello: proto::Hello = serde_json::from_slice(&payload).unwrap();
    assert!(hello.replay_bytes > 0, "the snapshot must carry the pre-attach output");

    // Drain until the child's last line shows up (or the holder decides we are
    // a lagging daemon and drops us — a documented, lossless outcome: whatever
    // we DID receive must still be gap- and duplicate-free).
    let mut bytes: Vec<u8> = Vec::new();
    let last = format!("L{LINES}.");
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut done = false;
    while !done && Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), proto::read_frame(&mut stream)).await {
            Ok(Ok(Some((proto::OUTPUT, p)))) => {
                done = p.windows(last.len()).any(|w| w == last.as_bytes());
                bytes.extend_from_slice(&p);
            }
            Ok(Ok(Some(_))) => continue,
            _ => break,
        }
    }

    // Both sides of the cutover are represented: the snapshot carried
    // pre-attach output, and more output arrived through the live queue after
    // it. Without both, the seam would not have been crossed at all.
    assert!(
        bytes.len() as u64 > hello.replay_bytes,
        "nothing arrived after the cutover ({} bytes vs {} of replay)",
        bytes.len(),
        hello.replay_bytes,
    );
    // The token sequence is the proof: consecutive means every byte the child
    // wrote crossed exactly once.
    let seen = tokens(&bytes);
    assert!(seen.len() > 5_000, "only {} tokens — too short to be meaningful", seen.len());
    for w in seen.windows(2) {
        assert!(
            w[1] == w[0] + 1,
            "seam broken at L{}→L{}: {}",
            w[0],
            w[1],
            if w[1] <= w[0] { "DUPLICATED bytes" } else { "LOST bytes" },
        );
    }
    // The seam itself: the token that straddles `replay_bytes` had its front
    // half from the spool snapshot and its back half from the live queue.
    let across = tokens(&bytes[..(hello.replay_bytes as usize).min(bytes.len())]);
    assert!(!across.is_empty() && across.len() < seen.len(), "the cutover was not crossed");
    assert_eq!(
        seen[across.len() - 1],
        across[across.len() - 1],
        "the snapshot's last token must be the same token in the full stream",
    );

    drop(stream);
    let session = NativeSession::new("seam", &dir);
    let _ = session.kill().await;
    h.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

/// (S4) A live holder's directory, socket and spool are owner-only. The socket
/// is the sharp one: `connect()` on it is a shell as the service user.
#[tokio::test]
async fn holder_files_and_socket_are_not_world_accessible() {
    use std::os::unix::fs::MetadataExt;

    let dir = data_dir("perms");
    let sdir = spool::session_dir(&dir, "perms");
    let sock = spool::socket_path(&dir, "perms");
    let h = start_holder(&dir, "perms", 80, 24, "echo hi; sleep 30");
    assert!(
        wait_until!(
            Duration::from_secs(10),
            sock.exists() && spool::read_meta(&sdir).is_some()
        ),
        "the holder never came up",
    );

    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().mode() & 0o777;
    assert_eq!(mode(&sdir), 0o700, "the session dir must not be traversable by others");
    assert_eq!(mode(&sock), 0o600, "holder.sock must not be world-connectable");
    assert_eq!(mode(&spool::spool_path(&sdir)), 0o600, "out.raw is raw terminal bytes");
    assert_eq!(mode(&sdir.join("meta.json")), 0o600);

    let session = NativeSession::new("perms", &dir);
    let _ = session.kill().await;
    assert!(wait_until!(Duration::from_secs(5), sdir.join("exit").exists()));
    assert_eq!(mode(&sdir.join("exit")), 0o600);

    h.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

/// The child exiting on its own ends the session cleanly: exit marker, exit
/// code, `dead()`.
#[tokio::test]
async fn child_exit_marks_the_session_dead_with_its_status() {
    let dir = data_dir("exit");
    let h = start_holder(&dir, "exit", 80, 24, "echo bye; exit 7");
    let session = NativeSession::new("exit", &dir);
    wait_for_text(&session, "bye", Duration::from_secs(10)).await;

    assert!(
        wait_until!(Duration::from_secs(10), session.dead().await),
        "session should be dead after the child exits",
    );
    assert_eq!(session.exit_code(), Some(7));
    assert_eq!(spool::read_exit(&spool::session_dir(&dir, "exit")), Some(7));
    // The output the child produced before exiting is still readable.
    assert!(session.capture_full().await.contains("bye"));

    h.abort();
    let _ = std::fs::remove_dir_all(&dir);
}
