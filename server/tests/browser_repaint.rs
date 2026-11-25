//! **The repaint that follows an input must reach the viewer.**
//!
//! The drive profile asks chrome for every 4th compositor frame
//! (`DRIVE_EVERY_NTH`). A click whose handler repaints once produces one or two
//! compositor frames, and unless one lands on the 4th chrome emits nothing; a
//! page that then sits still never paints again. Measured on the pinned Chrome
//! 149 through the takeover socket (2026-11-25): 4 of 5 single clicks on a
//! repaint-once button produced no frame at all.
//!
//! No real chrome here: a stub CDP endpoint answers every command and — like a
//! throttled cast after a single repaint — never emits a `Page.screencastFrame`.
//! So the only way a frame reaches the subscriber is the post-input still.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message;

use supermux_server::connectors::browser::cdp::CdpClient;
use supermux_server::connectors::browser::context::{
    AgentContext, ScreencastFrame, ScreencastOptions,
};
use supermux_server::connectors::browser::lock::Actor;

/// What the stub's `Page.captureScreenshot` returns ("STILL", base64).
const STILL: &str = "U1RJTEw=";

/// A one-connection CDP stub. Counts `Page.captureScreenshot` calls.
async fn stub_chrome() -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let shots = Arc::new(AtomicUsize::new(0));
    let counted = shots.clone();
    tokio::spawn(async move {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let (mut sink, mut source) = ws.split();
        while let Some(Ok(msg)) = source.next().await {
            let Message::Text(text) = msg else { continue };
            let cmd: Value = serde_json::from_str(&text).unwrap();
            let result = match cmd["method"].as_str().unwrap_or_default() {
                "Target.createTarget" => json!({ "targetId": "T-repaint" }),
                "Target.attachToTarget" => json!({ "sessionId": "S-repaint" }),
                "Page.captureScreenshot" => {
                    counted.fetch_add(1, Ordering::SeqCst);
                    json!({ "data": STILL })
                }
                _ => json!({}),
            };
            let answer = json!({ "id": cmd["id"], "result": result });
            if sink
                .send(Message::Text(answer.to_string().into()))
                .await
                .is_err()
            {
                return;
            }
        }
    });
    (format!("ws://{addr}/devtools/browser/stub"), shots)
}

async fn page() -> (AgentContext, Arc<AtomicUsize>) {
    let (url, shots) = stub_chrome().await;
    let client = CdpClient::connect(&url).await.expect("connect stub");
    let ctx =
        AgentContext::create_in_default_context(client, "tb_repaintstub", 800, 600, "about:blank")
            .await
            .expect("open a page on the stub");
    (ctx, shots)
}

fn mouse(kind: &str, x: f64) -> Value {
    json!({ "type": kind, "x": x, "y": 100.0, "button": "left", "buttons": 1, "clickCount": 1 })
}

/// Every frame that arrives within `window`.
async fn frames_within(
    rx: &mut broadcast::Receiver<ScreencastFrame>,
    window: Duration,
) -> Vec<ScreencastFrame> {
    let mut got = Vec::new();
    let end = tokio::time::Instant::now() + window;
    while let Ok(Ok(f)) = tokio::time::timeout_at(end, rx.recv()).await {
        got.push(f);
    }
    got
}

/// Finding (3): one click under the drive profile, one repaint, and the viewer
/// must see it — as a frame on the cast's own channel, mapped to the live box.
#[tokio::test]
async fn a_single_click_under_the_drive_profile_reaches_the_viewer() {
    let (ctx, shots) = page().await;
    let mut frames = ctx
        .start_screencast(Actor::Human, ScreencastOptions::drive(800, 600, 1.0))
        .await
        .expect("cast");

    for kind in ["mousePressed", "mouseReleased"] {
        ctx.dispatch_input(Actor::Human, "Input.dispatchMouseEvent", mouse(kind, 100.0))
            .await
            .expect("dispatch");
    }

    let got = frames_within(&mut frames, Duration::from_secs(2)).await;
    assert_eq!(
        got.len(),
        1,
        "the click's repaint must reach the viewer as one frame"
    );
    assert_eq!(got[0].data, STILL);
    assert_eq!(
        got[0].metadata["deviceWidth"],
        json!(800),
        "{}",
        got[0].metadata
    );
    assert_eq!(
        got[0].metadata["deviceHeight"],
        json!(600),
        "{}",
        got[0].metadata
    );
    assert!(got[0].ack.is_none(), "a still has nothing to ack");
    assert_eq!(shots.load(Ordering::SeqCst), 1);
    ctx.close().await;
}

/// The throttle stays: a burst of input (a drag, typing) is followed by ONE
/// still once it settles, not one per event.
#[tokio::test]
async fn a_burst_of_input_ends_in_exactly_one_still() {
    let (ctx, shots) = page().await;
    let mut frames = ctx
        .start_screencast(Actor::Human, ScreencastOptions::drive(800, 600, 1.0))
        .await
        .expect("cast");

    for i in 0..20 {
        ctx.dispatch_input(
            Actor::Human,
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": f64::from(i) * 5.0, "y": 100.0, "buttons": 0 }),
        )
        .await
        .expect("dispatch");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let got = frames_within(&mut frames, Duration::from_secs(2)).await;
    assert_eq!(got.len(), 1, "one still per burst");
    assert_eq!(shots.load(Ordering::SeqCst), 1);
    ctx.close().await;
}

/// The watch profile streams every frame, so it loses nothing and gets no
/// extra screenshot.
#[tokio::test]
async fn an_unthrottled_cast_gets_no_extra_still() {
    let (ctx, shots) = page().await;
    let mut frames = ctx
        .start_screencast(Actor::Human, ScreencastOptions::watch())
        .await
        .expect("cast");

    ctx.dispatch_input(
        Actor::Human,
        "Input.dispatchMouseEvent",
        mouse("mouseReleased", 100.0),
    )
    .await
    .expect("dispatch");

    let got = frames_within(&mut frames, Duration::from_millis(800)).await;
    assert!(got.is_empty(), "{} unexpected frame(s)", got.len());
    assert_eq!(shots.load(Ordering::SeqCst), 0);
    ctx.close().await;
}
