//! **A JS dialog must not freeze the browser relay.**
//!
//! While a page shows `alert()` / `confirm()` / `prompt()`, Chrome parks every
//! command that needs the renderer until the dialog is answered — including the
//! `Input.dispatchMouseEvent` (`mouseReleased`) whose click opened it. Measured
//! against the pinned Chrome 149 (2026-11-25):
//!
//! | parked behind the dialog | answered at once |
//! |---|---|
//! | the opening `mouseReleased`, `Runtime.evaluate`, `Page.captureScreenshot`, `Emulation.setDeviceMetricsOverride`, `Emulation.setUserAgentOverride`, `Emulation.clearDeviceMetricsOverride`, `Page.getFrameTree` | `Input.*` sent while it is open, `Page.startScreencast`/`stopScreencast`, `Page.getNavigationHistory`, `Page.handleJavaScriptDialog`, `Target.closeTarget` |
//!
//! Awaiting a parked command blocked its caller for the full 30 s CDP deadline:
//! the takeover socket loop on the click (and then a ping timeout), and the
//! viewport / resync / attach / close paths for as long as the dialog stayed up.
//!
//! No real chrome here: a stub CDP endpoint reproduces exactly that table, so
//! these run on every CI box. Each test bounds the call under test far below
//! the 30 s deadline, so before the fix it fails on the bound.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use supermux_server::connectors::browser::cdp::CdpClient;
use supermux_server::connectors::browser::context::AgentContext;
use supermux_server::connectors::browser::lock::Actor;

const SESSION: &str = "S-dialog";
const TARGET: &str = "T-dialog";
const PAGE: &str = "http://127.0.0.1/alert.html";

/// Far below the 30 s CDP deadline, far above a loopback round trip.
const BOUND: Duration = Duration::from_secs(5);

/// Does Chrome park this command while a dialog is open? (The left column.)
fn parked_behind_dialog(method: &str) -> bool {
    matches!(
        method,
        "Runtime.evaluate"
            | "Page.captureScreenshot"
            | "Emulation.setDeviceMetricsOverride"
            | "Emulation.setUserAgentOverride"
            | "Emulation.clearDeviceMetricsOverride"
            | "Page.getFrameTree"
    )
}

/// A one-connection CDP stub with chrome's dialog behaviour. A `mouseReleased`
/// opens an `alert()` (the page's button handler), and so does a message on the
/// returned sender (a page timer). Returns the browser ws url.
async fn stub_chrome() -> (String, mpsc::UnboundedSender<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (open_tx, mut open_rx) = mpsc::unbounded_channel::<()>();
    tokio::spawn(async move {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let (mut sink, mut source) = ws.split();
        let mut dialog_open = false;
        let mut parked: Vec<i64> = Vec::new();
        let opening = json!({
            "method": "Page.javascriptDialogOpening",
            "sessionId": SESSION,
            "params": { "url": PAGE, "message": "stop right there", "type": "alert",
                        "hasBrowserHandler": false, "defaultPrompt": "" },
        });
        loop {
            let text = tokio::select! {
                Some(()) = open_rx.recv() => {
                    dialog_open = true;
                    let _ = sink.send(Message::Text(opening.to_string().into())).await;
                    continue;
                }
                next = source.next() => match next {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(_)) => continue,
                    _ => return,
                },
            };
            let cmd: Value = serde_json::from_str(&text).unwrap();
            let id = cmd["id"].as_i64().unwrap();
            let method = cmd["method"].as_str().unwrap_or_default().to_string();
            let mut events = Vec::new();
            let mut result = json!({});
            match method.as_str() {
                "Target.createTarget" => result = json!({ "targetId": TARGET }),
                "Target.attachToTarget" => result = json!({ "sessionId": SESSION }),
                "Input.dispatchMouseEvent"
                    if cmd["params"]["type"] == json!("mouseReleased") && !dialog_open =>
                {
                    // The click's handler runs `alert()`: chrome announces the
                    // dialog and answers this command only once it is closed.
                    dialog_open = true;
                    parked.push(id);
                    let _ = sink.send(Message::Text(opening.to_string().into())).await;
                    continue;
                }
                m if dialog_open && parked_behind_dialog(m) => {
                    parked.push(id);
                    continue;
                }
                "Page.handleJavaScriptDialog" => {
                    if !dialog_open {
                        let err =
                            json!({ "id": id, "error": { "message": "No dialog is showing" } });
                        let _ = sink.send(Message::Text(err.to_string().into())).await;
                        continue;
                    }
                    dialog_open = false;
                    events.push(json!({
                        "method": "Page.javascriptDialogClosed",
                        "sessionId": SESSION,
                        "params": { "result": true, "userInput": "" },
                    }));
                }
                "Target.closeTarget" => {
                    dialog_open = false;
                    events.push(json!({
                        "method": "Target.detachedFromTarget",
                        "params": { "sessionId": SESSION, "targetId": TARGET },
                    }));
                    result = json!({ "success": true });
                }
                _ => {}
            }
            let answer = json!({ "id": id, "result": result });
            let _ = sink.send(Message::Text(answer.to_string().into())).await;
            if method == "Page.handleJavaScriptDialog" {
                // Everything parked behind the dialog runs now, in order.
                for pid in parked.drain(..) {
                    let late = json!({ "id": pid, "result": {} });
                    let _ = sink.send(Message::Text(late.to_string().into())).await;
                }
            }
            for ev in events {
                let _ = sink.send(Message::Text(ev.to_string().into())).await;
            }
        }
    });
    (format!("ws://{addr}/devtools/browser/stub"), open_tx)
}

async fn page() -> (Arc<AgentContext>, mpsc::UnboundedSender<()>) {
    let (url, open) = stub_chrome().await;
    let client = CdpClient::connect(&url).await.expect("connect stub");
    let ctx = AgentContext::create_in_default_context(client, "tb_dialogstub", 800, 600, PAGE)
        .await
        .expect("open a page on the stub");
    (Arc::new(ctx), open)
}

fn mouse(kind: &str) -> Value {
    json!({ "type": kind, "x": 100.0, "y": 100.0, "button": "left", "buttons": 1, "clickCount": 1 })
}

/// Finding (1): the human's click on a button that calls `alert()`. The relay
/// dispatches `mousePressed` then `mouseReleased` and awaits each; the second
/// is only answered when the alert closes, so the takeover socket loop sat in
/// that await for 30 s (measured: the `nav_state` carrying the dialog arrived
/// at t=30.0 s, and the socket died of a ping timeout). The dispatch must hand
/// the loop back as soon as the dialog is up, and the nav feed must say so.
#[tokio::test]
async fn a_click_that_opens_an_alert_hands_the_relay_back_at_once() {
    let (ctx, _open) = page().await;
    let mut nav = ctx.watch_nav().await.expect("nav watcher");

    tokio::time::timeout(
        BOUND,
        ctx.dispatch_input(
            Actor::Human,
            "Input.dispatchMouseEvent",
            mouse("mousePressed"),
        ),
    )
    .await
    .expect("mousePressed returns")
    .expect("mousePressed ok");

    let released = tokio::time::timeout(
        BOUND,
        ctx.dispatch_input(
            Actor::Human,
            "Input.dispatchMouseEvent",
            mouse("mouseReleased"),
        ),
    )
    .await;
    assert!(
        matches!(released, Ok(Ok(()))),
        "the click that opens an alert must not wait for the alert to close: {released:?}"
    );

    let blocked = tokio::time::timeout(BOUND, nav.wait_for(|s| s.dialog.is_some()))
        .await
        .expect("the nav feed reports the dialog")
        .expect("nav watcher alive")
        .clone();
    let dialog = blocked.dialog.expect("dialog");
    assert_eq!(dialog.kind, "alert");
    assert_eq!(dialog.message, "stop right there");

    // More input while the dialog is up does not wedge either.
    tokio::time::timeout(
        BOUND,
        ctx.dispatch_input(
            Actor::Human,
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": 5.0, "y": 5.0, "buttons": 0 }),
        ),
    )
    .await
    .expect("input during the dialog returns")
    .expect("input during the dialog ok");

    // Answering it is still the way out, and the feed clears.
    ctx.handle_dialog(Actor::Human, true, None)
        .await
        .expect("answer the dialog");
    tokio::time::timeout(BOUND, nav.wait_for(|s| s.dialog.is_none()))
        .await
        .expect("the nav feed clears the dialog")
        .expect("nav watcher alive");
    ctx.close().await;
}

/// Finding (2): with a dialog open, every relay verb that touches the renderer
/// hung for 30 s or more — viewport (`setDeviceMetricsOverride` + still +
/// `current_url`), resync (the still), attach (the seed's `current_url` and
/// still) and close (`persist_location` reads url and title before
/// `closeTarget`). Each must come back promptly instead.
#[tokio::test]
async fn an_open_dialog_never_stalls_viewport_resync_attach_or_close() {
    let (ctx, open) = page().await;
    let mut nav = ctx.watch_nav().await.expect("nav watcher");
    // A page timer opens the alert — no input involved.
    open.send(()).unwrap();
    tokio::time::timeout(BOUND, nav.wait_for(|s| s.dialog.is_some()))
        .await
        .expect("the nav feed reports the dialog")
        .expect("nav watcher alive");

    // resync / attach: the still frame.
    let still = tokio::time::timeout(BOUND, ctx.screenshot())
        .await
        .expect("a screenshot behind a dialog must not wait out the CDP deadline");
    let err = still.expect_err("a blocked renderer has no still to give");
    assert!(err.to_string().contains("JavaScript dialog"), "{err}");

    // attach / viewport: the `target` frame's url.
    let url = tokio::time::timeout(BOUND, ctx.current_url())
        .await
        .expect("reading the url behind a dialog must not wait out the CDP deadline");
    assert!(url.is_err(), "{url:?}");

    // viewport: the override is parked by chrome and applied once the dialog
    // is answered, so the box is recorded rather than refused.
    tokio::time::timeout(
        BOUND,
        ctx.set_viewport_scaled(Actor::Human, 390, 700, 2.0, true),
    )
    .await
    .expect("a viewport behind a dialog must not wait out the CDP deadline")
    .expect("the viewport is accepted");
    assert_eq!(ctx.viewport_css(), (390, 700));

    // close: answers promptly and takes the dialog with it.
    tokio::time::timeout(BOUND, ctx.close())
        .await
        .expect("closing a tab behind a dialog must not wait out the CDP deadline");
}

/// A dialog that was opened BEFORE anybody watched the page — a takeover
/// attaching to a scratch context whose agent clicked an `alert()` button.
/// Chrome does not repeat the opening event, so the nav feed must learn it from
/// what the CDP reader already saw, or the human is shown a frozen page with
/// nothing to press.
#[tokio::test]
async fn a_watcher_started_behind_an_open_dialog_reports_it() {
    let (ctx, open) = page().await;
    open.send(()).unwrap();
    // Wait until the dialog has reached the client, without a watcher: a still
    // behind it is refused (or, before the fix, hangs past the bound).
    let mut seen = false;
    for _ in 0..50 {
        if let Ok(Err(e)) = tokio::time::timeout(Duration::from_millis(200), ctx.screenshot()).await
        {
            seen = e.to_string().contains("JavaScript dialog");
            if seen {
                break;
            }
        }
    }
    assert!(seen, "the client never registered the open dialog");

    let mut nav = ctx.watch_nav().await.expect("nav watcher");
    let state = tokio::time::timeout(BOUND, nav.wait_for(|s| s.dialog.is_some()))
        .await
        .expect("a late watcher still reports the open dialog")
        .expect("nav watcher alive")
        .clone();
    assert_eq!(state.dialog.expect("dialog").kind, "alert");
    assert_eq!(state.url, PAGE, "the dialog names the page it blocks");
    ctx.close().await;
}
