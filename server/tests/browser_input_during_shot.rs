//! **A tap never lands while our own screenshot has the view re-emulated.**
//!
//! Under a device-scale override `Page.captureScreenshot` re-emulates the view
//! at `css × deviceScaleFactor` for the length of the capture, and an `Input.*`
//! event chrome handles inside that window is mapped through it: on a 402×666
//! phone at 2× a tap sent at (100,200) lands at (50,100). Measured through the
//! takeover against Chrome for Testing 159 (2026-11-27): with taps 150 ms apart
//! — the post-input still's own delay — ~40 % landed at half their coordinates;
//! at 400 ms, none.
//!
//! No real chrome here: a stub CDP endpoint does what chrome does. A screenshot
//! is answered after [`SHOT_TAKES`], and a mouse event that arrives in the
//! meantime is recorded at its coordinates divided by the device scale factor.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;

use supermux_server::connectors::browser::cdp::CdpClient;
use supermux_server::connectors::browser::context::{AgentContext, ScreencastOptions};
use supermux_server::connectors::browser::lock::Actor;

const SESSION: &str = "S-inputshot";
/// How long the stub's capture keeps the view re-emulated.
const SHOT_TAKES: Duration = Duration::from_millis(120);

/// Where each `mousePressed` landed on the page, in page CSS px.
type Landed = Arc<Mutex<Vec<(f64, f64)>>>;

async fn stub_chrome() -> (String, Landed) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let landed: Landed = Arc::default();
    let record = landed.clone();
    tokio::spawn(async move {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let (mut sink, mut source) = ws.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            while let Some(v) = out_rx.recv().await {
                if sink
                    .send(Message::Text(v.to_string().into()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        });
        let mut dsf = 1.0;
        let mut shot_until: Option<Instant> = None;
        while let Some(Ok(msg)) = source.next().await {
            let Message::Text(text) = msg else { continue };
            let cmd: Value = serde_json::from_str(&text).unwrap();
            let id = cmd["id"].clone();
            let result = match cmd["method"].as_str().unwrap_or_default() {
                "Target.createTarget" => json!({ "targetId": "T-inputshot" }),
                "Target.attachToTarget" => json!({ "sessionId": SESSION }),
                "Emulation.setDeviceMetricsOverride" => {
                    dsf = cmd["params"]["deviceScaleFactor"].as_f64().unwrap();
                    json!({})
                }
                "Page.captureScreenshot" => {
                    // Answered later; the view is re-emulated until then.
                    shot_until = Some(Instant::now() + SHOT_TAKES);
                    let out = out.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(SHOT_TAKES).await;
                        let _ = out.send(json!({ "id": id, "result": { "data": "U1RJTEw=" } }));
                    });
                    continue;
                }
                "Input.dispatchMouseEvent" => {
                    let p = &cmd["params"];
                    if p["type"] == json!("mousePressed") {
                        let mid_shot = shot_until.is_some_and(|t| Instant::now() < t);
                        let k = if mid_shot { dsf } else { 1.0 };
                        let (x, y) = (p["x"].as_f64().unwrap(), p["y"].as_f64().unwrap());
                        record.lock().unwrap().push((x / k, y / k));
                    }
                    json!({})
                }
                _ => json!({}),
            };
            let _ = out.send(json!({ "id": id, "result": result }));
        }
    });
    (format!("ws://{addr}/devtools/browser/stub"), landed)
}

/// A phone's tab: 402×666 CSS px at 2×, mobile.
async fn phone() -> (AgentContext, Landed) {
    let (url, landed) = stub_chrome().await;
    let client = CdpClient::connect(&url).await.expect("connect stub");
    let ctx =
        AgentContext::create_in_default_context(client, "tb_inputshot", 1366, 900, "about:blank")
            .await
            .expect("open a page on the stub");
    ctx.set_viewport_scaled(Actor::Human, 402, 666, 2.0, true)
        .await
        .expect("setDeviceMetricsOverride");
    (ctx, landed)
}

async fn tap(ctx: &AgentContext, x: f64, y: f64) {
    for kind in ["mousePressed", "mouseReleased"] {
        ctx.dispatch_input(
            Actor::Human,
            "Input.dispatchMouseEvent",
            json!({ "type": kind, "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1 }),
        )
        .await
        .expect("dispatch");
    }
}

/// The mechanism, deterministically: a tap sent while a screenshot is in
/// flight must wait for it and land where it was sent.
#[tokio::test]
async fn a_tap_sent_during_a_screenshot_lands_at_its_css_coordinates() {
    let (ctx, landed) = phone().await;
    let (shot, ()) = tokio::join!(ctx.screenshot(), async {
        tokio::time::sleep(SHOT_TAKES / 4).await;
        tap(&ctx, 100.0, 200.0).await;
    });
    shot.expect("still");
    assert_eq!(*landed.lock().unwrap(), vec![(100.0, 200.0)]);
    ctx.close().await;
}

/// The field shape: rapid taps under the drive profile, each followed by the
/// post-input still. Every tap lands where it was sent, in the order sent.
#[tokio::test]
async fn rapid_taps_under_the_post_input_still_all_land_where_sent() {
    let (ctx, landed) = phone().await;
    let _frames = ctx
        .start_screencast(Actor::Human, ScreencastOptions::drive(402, 666, 2.0))
        .await
        .expect("cast");
    let sent: Vec<(f64, f64)> = (0..12).map(|i| (100.0 + f64::from(i), 200.0)).collect();
    for &(x, y) in &sent {
        tap(&ctx, x, y).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    assert_eq!(*landed.lock().unwrap(), sent);
    ctx.close().await;
}
