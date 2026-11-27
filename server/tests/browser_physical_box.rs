//! **The page never sees physical pixels as its viewport.**
//!
//! The native app laid a tab out at 402×666 CSS px at 2× and the page's own
//! resize log read 402×666 → 804×1332 → 402×666; a tap in the middle phase
//! landed at exactly double its coordinates. Measured against Chrome for
//! Testing 159 (2026-11-27): under a device-scale override, our own
//! `Page.captureScreenshot` (the post-input still, seed, resync) makes chrome
//! resize the view to `css × dpr` for the capture, and a screencast frame
//! composited in that window carries the PHYSICAL box as its
//! `deviceWidth/deviceHeight`. The takeover trusted it: the client mapped taps
//! through 804, and `capture_mismatch` fired `repair_capture`, whose
//! `clearDeviceMetricsOverride` landed while the view was still 804×1332 — so
//! the page laid out at the physical size until the set.
//!
//! No real chrome here: a stub CDP endpoint does what chrome does — every
//! `Page.captureScreenshot` is accompanied by a `Page.screencastFrame` whose box
//! is the override's CSS box times its device scale factor.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message;

use supermux_server::connectors::browser::cdp::CdpClient;
use supermux_server::connectors::browser::context::{
    capture_mismatch, AgentContext, ScreencastFrame, ScreencastOptions,
};
use supermux_server::connectors::browser::lock::Actor;

const SESSION: &str = "S-physbox";

/// A one-connection CDP stub. `Page.captureScreenshot` emits one screencast
/// frame at the box `frame_box` computes from the last override
/// `(width, height, deviceScaleFactor)`.
async fn stub_chrome(frame_box: fn(f64, f64, f64) -> (f64, f64)) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let (mut sink, mut source) = ws.split();
        let mut over = (1366.0, 900.0, 1.0);
        let mut ack = 0;
        while let Some(Ok(msg)) = source.next().await {
            let Message::Text(text) = msg else { continue };
            let cmd: Value = serde_json::from_str(&text).unwrap();
            let mut event = None;
            let result = match cmd["method"].as_str().unwrap_or_default() {
                "Target.createTarget" => json!({ "targetId": "T-physbox" }),
                "Target.attachToTarget" => json!({ "sessionId": SESSION }),
                "Emulation.setDeviceMetricsOverride" => {
                    let p = &cmd["params"];
                    over = (
                        p["width"].as_f64().unwrap(),
                        p["height"].as_f64().unwrap(),
                        p["deviceScaleFactor"].as_f64().unwrap(),
                    );
                    json!({})
                }
                "Page.captureScreenshot" => {
                    ack += 1;
                    let (w, h) = frame_box(over.0, over.1, over.2);
                    event = Some(json!({
                        "method": "Page.screencastFrame",
                        "sessionId": SESSION,
                        "params": {
                            "data": "RlJBTUU=",
                            "sessionId": ack,
                            "metadata": {
                                "offsetTop": 0, "pageScaleFactor": 1,
                                "deviceWidth": w, "deviceHeight": h,
                                "scrollOffsetX": 0, "scrollOffsetY": 0,
                                "timestamp": 1.0,
                            },
                        },
                    }));
                    json!({ "data": "U1RJTEw=" })
                }
                _ => json!({}),
            };
            if let Some(ev) = event {
                if sink
                    .send(Message::Text(ev.to_string().into()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
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
    format!("ws://{addr}/devtools/browser/stub")
}

/// A phone's tab (402×666 at 2×, mobile) under the drive profile, then one
/// still; every screencast frame that arrived meanwhile.
async fn frames_around_a_still(frame_box: fn(f64, f64, f64) -> (f64, f64)) -> Vec<ScreencastFrame> {
    let url = stub_chrome(frame_box).await;
    let client = CdpClient::connect(&url).await.expect("connect stub");
    let ctx =
        AgentContext::create_in_default_context(client, "tb_physbox", 1366, 900, "about:blank")
            .await
            .expect("open a page on the stub");
    ctx.set_viewport_scaled(Actor::Human, 402, 666, 2.0, true)
        .await
        .expect("setDeviceMetricsOverride");
    let mut rx = ctx
        .start_screencast(Actor::Human, ScreencastOptions::drive(402, 666, 2.0))
        .await
        .expect("cast");
    ctx.screenshot().await.expect("still");
    let got = frames_within(&mut rx, Duration::from_secs(1)).await;
    assert_eq!(ctx.viewport_css(), (402, 666));
    ctx.close().await;
    got
}

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

/// The reported bug: the frame chrome composites during our own screenshot
/// says 804×1332. Every consumer — the client's tap mapping, the server's input
/// clamp, the capture-drift detector — must get the CSS box instead.
#[tokio::test]
async fn a_frame_taken_during_a_still_reports_the_css_box_not_the_physical_one() {
    let got = frames_around_a_still(|w, h, dpr| ((w * dpr).floor(), (h * dpr).floor())).await;
    assert_eq!(got.len(), 1, "the stub sends one frame per still");
    let meta = &got[0].metadata;
    assert_eq!(meta["deviceWidth"].as_f64(), Some(402.0), "{meta}");
    assert_eq!(meta["deviceHeight"].as_f64(), Some(666.0), "{meta}");
    assert!(
        !capture_mismatch(Some(meta), (402, 666)),
        "a still's frame is not a dropped capture: repairing it clears the override \
         while the view is physical, and the page lays out at 804x1332"
    );
}

/// The repair still has its signal: a frame at the real WINDOW (what a
/// navigation drop looks like) is passed through untouched.
#[tokio::test]
async fn a_window_sized_frame_still_reads_as_a_dropped_capture() {
    let got = frames_around_a_still(|_, _, _| (1366.0, 757.0)).await;
    assert_eq!(got.len(), 1);
    let meta = &got[0].metadata;
    assert_eq!(meta["deviceWidth"].as_f64(), Some(1366.0), "{meta}");
    assert!(capture_mismatch(Some(meta), (402, 666)));
}
