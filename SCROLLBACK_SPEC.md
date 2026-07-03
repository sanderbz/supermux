I now have every anchor confirmed. The client dispatch is a flat `msg.type` switch on JSON text frames (line 1352), sends are `ws.send(JSON.stringify({type:...}))`, and resize flows through a `resize()` callback (line 501). Everything the spec needs is verified. Writing the decision and spec now.

---

# supermux tmux-authoritative scrollback: decision + implementation spec

## 1. Decision — **HYBRID (B-anchored, A-windowed)**. Reject pure A and pure B.

**What I'm choosing.** Keep the live tail exactly as-is (pipe-pane → FIFO → broadcast → `term.write`, xterm owns the *bottom viewport*), but make **tmux the single source of truth for every row above the live viewport**. Concretely:

- xterm's own scrollback is reduced to a **thin live band** (`scrollback: rows * 3`), not 50000. xterm stops being the history store.
- A new **`ClientMsg::History` windowed capture** (`capture-pane -S/-E` over the pane's transport) serves scroll-up from tmux's authoritative, already-reflowed buffer.
- History rows render in a **stacked read-only second xterm instance** ("history term") above the live term — so all the hard parts (SGR, wide chars, combining marks, OSC-8 links, selection) are reused, not reimplemented.
- On resize, the client **drops its history cache** and re-fetches at the new width; tmux does the reflow, xterm never reflows history. The two-independent-reflows drift (map §4a) is structurally eliminated.

**Why this and not the alternatives:**

| | Pure A (on-demand only) | Pure B (authoritative reseed on every scroll) | **HYBRID (chosen)** |
|---|---|---|---|
| Native copy-mode fidelity | High | High | **High** — history bytes are tmux's, reflow is tmux's |
| Resize robustness | Good | Good but janky | **Best** — history cache cleared + re-fetched at exact width; live band untouched |
| "Lost response section on resize mid-render" repro | Fixed | Fixed | **Fixed** — that bug lives entirely in xterm's independent history reflow, which we delete |
| Complexity / risk | Needs a whole virtual-scroll renderer (bespoke ANSI→DOM) OR the stacked-term trick anyway | Rewrites the *whole* screen on every scroll tick → flicker, huge frames, fights the live tail | **Contained** — reuses xterm as the history renderer; live path byte-for-byte unchanged |
| Live-tail regression risk | Low | **High** (reseed stomps the live viewport) | **Lowest** — live path is literally not touched |

Pure B (reseed-the-whole-screen on scroll) is rejected because it repaints the live viewport on every scroll tick, fights the rAF coalescer, and sends 512KB+ frames per gesture. Pure A's only real cost is "you must build a history renderer" — and the cheapest correct history renderer *is a second xterm*, which is exactly the hybrid. So the hybrid is Pure A with the pragmatic renderer choice made, plus the reseed's authoritative-capture helper reused verbatim. It's the decisive minimum that matches native tmux while never risking the live stream.

**The one hard invariant the whole thing rests on** (map §1, restated): while scrolled up, the pane keeps producing output, so tmux's `#{history_size}` grows and negative offsets *slide*. We anchor every fetched row to an **absolute line id** = `history_size_at_capture + offset`, and convert back to offsets using the *latest* known `history_size`. This is what stops the history view sliding under live output — same trick native copy-mode uses.

---

## 2. Implementation spec

### 2.1 Server — `server/src/sessions/tmux.rs`

Add a windowed capture next to `capture_history_with_alt_screen_aware_visible` (line 634). **Critical `-J` decision, corrected from the map:** the seed uses `-J` (line 668) to *join* wrapped lines for a coherent screen paint. The windowed history path must **omit `-J`** so tmux returns **physical rows already wrapped at the current pane width** — 1 tmux row = 1 display row, which is what the history term needs for exact row math and identical wrapping to the live band.

```rust
#[derive(serde::Serialize, Debug, Clone)]
pub struct HistoryWindow {
    pub rows: Vec<String>,   // top→bottom, ANSI-colored (-e), physical rows (no -J)
    pub history_size: u32,   // #{history_size} at capture time — the absolute-id anchor
    pub start_offset: i64,   // actual bottom-inclusive range served (clamped)
    pub end_offset: i64,
    pub hit_top: bool,       // start reached -history_size → no older rows exist
    pub cols: u16,           // #{pane_width} the capture was taken at
}

/// Windowed scrollback for copy-mode-over-web. `end_offset` <= -1 (scrollback
/// coord; -1 = row just above the visible top). Returns up to `count` physical
/// rows ending at `end_offset`, at the pane's CURRENT width. Read-only.
pub async fn capture_history_window(&self, end_offset: i64, count: u32)
    -> Result<HistoryWindow>
{
    let target = self.target_match().await;
    // 1. Probe size + width + alt in one message (mirror parse_pane_info style).
    let info = self.run(&["display-message", "-p", "-t", &target,
        "#{history_size},#{pane_width},#{alternate_on}"]).await.unwrap_or_default();
    let (history_size, pane_width, _alt) = parse_hist_info(&info); // new parser + unit test
    // 2. Clamp into [-history_size, -1].
    let count = count.min(HISTORY_WINDOW_MAX) as i64;          // HISTORY_WINDOW_MAX = 500
    let end   = end_offset.min(-1).max(-(history_size as i64));
    let start = (end - count + 1).max(-(history_size as i64));
    let hit_top = start <= -(history_size as i64);
    if history_size == 0 || start > end {
        return Ok(HistoryWindow { rows: vec![], history_size, start_offset: 0,
            end_offset: 0, hit_top: true, cols: pane_width });
    }
    // 3. Capture. -e colours, NO -J (physical rows), NO screen-control framing.
    //    NB: alt-screen scrollback IS the primary buffer's history, so -S/-E on
    //    the pane returns the right rows in both modes — no alt framing needed
    //    here (framing is a *seed* concern, not a *rows* concern).
    let body = self.run(&["capture-pane", "-e", "-p", "-t", &target,
        "-S", &start.to_string(), "-E", &end.to_string()]).await.unwrap_or_default();
    let rows = body.trim_end_matches('\n').split('\n').map(str::to_owned).collect();
    Ok(HistoryWindow { rows, history_size, start_offset: start, end_offset: end,
        hit_top, cols: pane_width })
}
```

Also add `fn parse_hist_info(&str) -> (u32, u16, bool)` next to `parse_pane_info` (line ~1026) **with a unit test** mirroring the existing `parse_pane_info` tests. Add `const HISTORY_WINDOW_MAX: u32 = 500;` near `HISTORY_LIMIT` (line 293).

### 2.2 Server — `server/src/ws/protocol.rs`

Add to the `#[serde(tag="type", rename_all="lowercase")] enum ClientMsg` (line 12). Note: `rename_all="lowercase"` makes the tag `"history"`.

```rust
/// Request a window of authoritative scrollback from tmux.
/// end_offset <= -1 (scrollback coord). count rows ending there, at CURRENT
/// pane width. req_id correlates async replies (fling → many inflight; client
/// keeps newest). cols = client grid width for the width-match guard (§2.5).
History { req_id: u32, end_offset: i64, count: u32, cols: u16 },
```

Add a deserialize unit test mirroring `parses_resync_control_frame` (line 47). Because `ClientMsg` does **not** set `deny_unknown_fields`, an old server given a `history` frame fails `from_str` and the loop already silently drops it (line 537 path) — graceful downgrade, no guard needed.

### 2.3 Server — `server/src/ws/mod.rs`

**(a) Transport fix (also fixes the latent remote-seed bug, map §3).** In `handle_socket`, the `tmux` handle is built local-only at lines 425-427. Resolve the session's transport once and build via the existing `new_on`/`for_pane_on` (tmux.rs:109,126):

```rust
let transport = match crate::db::sessions::get(&state.pool, &name).await {
    Ok(Some(s)) => match s.host_id {
        Some(h) => state.host_pool.transport_for(h).await.ok(),
        None => None,
    },
    _ => None,
};
let tmux = match (transport.as_ref(), lead_pane_id.as_deref()) {
    (Some(t), Some(lp)) => Tmux::for_pane_on(t, &name, lp.to_string()),
    (Some(t), None)     => Tmux::new_on(t, &name),
    (None, Some(lp))    => Tmux::for_pane(&name, lp.to_string()),
    (None, None)        => Tmux::new(&name),
};
```

(Adjust to the actual `db::sessions` accessor / `host_id` field names when implementing — the shape is: session → optional host → `host_pool.transport_for`.)

**(b) History handler.** Add a helper and wire it into **both** `select!` loops — `handle_socket` (the `Message::Text` → `ClientMsg` match around line 536) **and** `handle_ws_team_socket` (around line 261). History is read-only, so it satisfies the teammate read-only contract with no special-casing.

```rust
async fn send_history_window(
    socket: &mut WebSocket, tmux: &Tmux<'_>,
    req_id: u32, end_offset: i64, count: u32,
) {
    let payload = match tmux.capture_history_window(end_offset, count).await {
        Ok(w) => serde_json::json!({ "type": "history", "req_id": req_id,
            "history_size": w.history_size, "start_offset": w.start_offset,
            "end_offset": w.end_offset, "hit_top": w.hit_top, "cols": w.cols,
            "rows": w.rows }),
        Err(_) => serde_json::json!({ "type": "history", "req_id": req_id,
            "rows": [], "error": true, "hit_top": false }),
    };
    let _ = socket.send(Message::Text(payload.to_string().into())).await;
}
```

Match arm (both loops):
```rust
Ok(ClientMsg::History { req_id, end_offset, count, .. }) => {
    // Read-only capture: do NOT route to input_drain, do NOT take SessionLock.
    send_history_window(&mut socket, &tmux, req_id, end_offset, count).await;
}
```

**Concurrency note.** `capture-pane` is a ~2ms read-only fork. v1 inline-awaits it in the `select!` arm — acceptable and simplest. If harness profiling shows live-tail stutter during a fling, promote it to a dedicated history task over an mpsc (mirror the existing `input_drain_loop` pattern) whose response frames the main loop drains into the socket. Ship v1 inline; upgrade only if measured.

**(c) Attach metadata.** The client must init the boundary. Extend the seed path (`send_seed_then_done`, line 798) to send a `{"type":"attach_meta","history_size":N,"cols":W}` **Text** frame immediately before `replay_done` (line 835). Get `N,W` from one extra `display-message -p '#{history_size},#{pane_width}'`. Old clients ignore unknown text frames (client catches JSON parse / unknown `type` and returns — line 1384).

### 2.4 Web — `web/src/hooks/use-live-term.ts` (xterm 5.5)

**(a) Shrink the live band.** Line 636: `scrollback: 50000` → `scrollback: Math.max(rows * 3, 200)` (recompute on resize). xterm now holds only the streaming tail; tmux holds history.

**(b) History state (new refs in the hook):**
```ts
const histRows = new Map<number, string>()   // absLineId → ANSI row
let histOldestAbs = Infinity                  // smallest absId held
let histTopAbs = -1                           // absId of row directly above live top (the seam)
let histSizeLast = 0                          // latest tmux history_size
let hitTop = false
let inflightReq: number | null = null
let reqSeq = 0
const absId = (histSize: number, offset: number) => histSize + offset
```

**(c) Send helper** (mirror the `resize` sender at line 501):
```ts
const requestHistory = (endOffset: number, count: number) => {
  const t = termRef.current; const ws = wsRef.current
  if (!t || ws?.readyState !== WebSocket.OPEN || hitTop) return
  const req_id = ++reqSeq; inflightReq = req_id
  ws.send(JSON.stringify({ type: 'history', req_id, end_offset: endOffset, count, cols: t.cols }))
}
```

**(d) `history` frame handler** — add a branch in the JSON dispatch (line 1352, alongside `auth_ok`/`replay_done`):
```ts
else if (msg.type === 'history') {
  if (msg.error) { /* schedule one backoff retry, else fall back to seed */ return }
  if (msg.req_id !== inflightReq) return          // stale (fling) — discard
  inflightReq = null
  if (msg.cols !== termRef.current?.cols) {         // resized mid-flight → refetch
    histRows.clear(); histOldestAbs = Infinity; hitTop = false
    requestHistory(histTopAbs - histSizeLast, HISTORY_WINDOW); return
  }
  histSizeLast = msg.history_size
  hitTop = msg.hit_top
  const rows: string[] = msg.rows
  for (let i = 0; i < rows.length; i++) {
    const abs = absId(msg.history_size, msg.start_offset + i)
    histRows.set(abs, rows[i]); histOldestAbs = Math.min(histOldestAbs, abs)
  }
  renderHistory()   // repaint the history term from histRows (§2.6)
}
```

**(e) `attach_meta`:** on receipt set `histTopAbs = history_size - 1` (the row just above live top), `histSizeLast = history_size`, `hitTop = history_size === 0`. Reset all history state on every (re)connect and on `replay_done`-that-is-a-resync.

**(f) Scroll detection** — extend `syncScrolledUp` (line 681). Today it only computes `distFromBottom`. Add near-top detection on the **wrapper** scroll container (the element that spans both stacked terms):
```ts
const distFromTop = wrapperEl.scrollTop
if (distFromTop < HISTORY_PREFETCH_SLACK_PX && !hitTop && inflightReq === null) {
  const bottomAbs = histOldestAbs === Infinity ? histTopAbs : histOldestAbs - 1
  requestHistory(bottomAbs - histSizeLast, HISTORY_WINDOW)  // abs→offset via latest size
}
```
`HISTORY_PREFETCH_SLACK_PX` ≈ 400 local / ≈ 900 for SSH sessions (hide RTT). `HISTORY_WINDOW` = 300. Keep the existing `{ passive: true }` listener so iOS touch-scroll (the hard-won mobile feel, line 703) is unchanged — no new touch shim, no `onWheel`.

**(g) Seam tracking under live advance.** When the live tail scrolls rows off xterm's small band, those rows have entered tmux scrollback. On each flush (`afterFlush`/`flushPendingWrites`, line 1196), read `term.buffer.active.baseY` (already read at line 519); the increase since last flush = rows that scrolled off = advance `histTopAbs` by that delta. This keeps the seam aligned with tmux with zero extra captures. The absolute-id anchoring (via `histSizeLast`) means the *rendered* history does not slide under the user even as `histTopAbs` advances.

**(h) Resize:** in the `ResizeObserver`/fit path (the one that calls `resize(cols,rows)`, line ~501 caller), after sending the resize, clear history (`histRows.clear(); histOldestAbs=Infinity; hitTop=false`); if currently scrolled up, `requestHistory` the current window at the new width once the resize round-trips.

### 2.5 Width-match guard (the reflow-consistency guarantee)

Every `history` response carries `cols`. The client renders history rows **only** if `msg.cols === term.cols`; otherwise it clears the cache and re-requests (handler (d)). Because the server captured at the pane's live width and the live band is at that same width, historical and live rows wrap identically. **No client-side reflow of history ever happens** — tmux owns reflow. This is the decisive fix for the map §4a drift and the "lost response section on resize" repro.

### 2.6 Web — the stacked history term (new component)

Add `web/src/components/history-term.tsx` (or inline in the term wrapper). A second, read-only `@xterm/xterm` `Terminal` sized to the same `cols`, `scrollback` large, **never fed the live stream** — only `renderHistory()` clears + writes `histRows` top→bottom. Load the same `WebLinksAddon` + `LINK_URL_REGEX` (lines 662-665) so links work in scrollback. A single wrapper scroll container spans both viewports (history above, live below); scroll region `[0, H_hist)` scrolls history, `[H_hist, H_total)` is the live term. The existing jump-to-bottom button (`scrolledUp`/`scrollToBottom`, lines 105/585) now means "return to the live band bottom." Cross-seam text selection is **not** supported in v1 (native tmux copy-mode selection doesn't cross into the live pane either — acceptable).

---

## 3. Edge cases

1. **SSH / remote transport** — history capture runs on `Tmux::{new_on,for_pane_on}` built from `host_pool.transport_for` (§2.3a), same transport as the pane. This *also* repairs the latent remote-seed bug (seed was local-only). Widened prefetch slack + a thin "loading older…" shimmer row hides the extra RTT.
2. **Teammate panes** — identical `ClientMsg::History` arm added to `handle_ws_team_socket`; read-only capture fits the read-only contract natively. Teammate panes are local today (`for_pane`, `&LOCAL`); use `for_pane_on` symmetrically if teammate-on-remote ever lands.
3. **Alt-screen** — alt buffer has no scrollback; `-S/-E` on the pane returns the *primary* buffer's history in both modes, so `capture_history_window` needs **no** alt framing (framing is a seed-only concern). While in a rare alt TUI, the live band shows the TUI frame; scroll-up shows the primary scrollback that existed before alt entry.
4. **Huge history (20k+ lines, up to `HISTORY_LIMIT` 50000)** — reachable in full via successive 300-row windows keyed by absolute id; the 512KB replay ring is now irrelevant to history (it only serves `tail`/preview). `hit_top` stops fetching at the oldest line. If tmux trims past 50000 mid-session, old absIds become unfetchable; a re-request returns a clamped range and the client tolerates the shortened window.
5. **Mobile ↔ desktop** — same `{ passive: true }` scroll listener drives both; no touch shim, iOS feel preserved. DPR=1 harness path unaffected.
6. **Live-tail boundary** — seam advances via `baseY` delta (§2.4g); absolute-id anchoring keeps the rendered history stable under live output; new output does **not** yank the user to the bottom (matches native copy-mode).
7. **Reconnect** — on reattach: live band reseeded (unchanged), `attach_meta` re-inits `histTopAbs`/`histSizeLast`, history cache cleared; scroll-up re-fetches to the full 50000 regardless of the ring.
8. **history_size = 0 / fresh session** — server returns `rows:[], hit_top:true`; client renders no history layer; scroll-up past the seed is a no-op. No error.
9. **Fling scroll** — many rapid requests; `inflightReq`/`reqSeq` keep only the newest, older responses discarded by the `req_id !== inflightReq` guard.
10. **Session died (`remain-on-exit on`)** — `capture-pane` still works on a retained dead pane; history stays scrollable until reaped.

---

## 4. Test plan (headless harness `~/render_harness.mjs`, real Claude haiku, DPR=1)

| # | Scenario | Steps | Pass criteria |
|---|---|---|---|
| T1 | **Deep scroll to ~20k lines** | Drive haiku to emit 20k+ lines; scroll to top in windows. | Every window's rows match `capture-pane -e -p -S/-E` for that offset byte-for-byte; `hit_top` true only at `-history_size`; no gaps/dupes across seams. |
| T2 | **Resize-during-render (the "lost response section" repro)** | While haiku streams a long response, fire a resize mid-stream, then scroll up through the reflowed region. | No lost/duplicated/scrambled rows; history rows wrap at the new width; scrolled-up region matches a fresh `capture-pane` at the new width. This is the headline regression to defeat. |
| T3 | **Live advance while scrolled up** | Scroll to mid-history; keep haiku emitting. | History view stays anchored (does not slide/jump to bottom); seam advances; jump-to-bottom returns to live tail. |
| T4 | **Mobile ↔ desktop reflow** | Capture at desktop cols, resize to mobile cols, scroll up; and reverse. | Width-match guard discards stale-width rows; re-fetch renders correctly wrapped at each width; no bespoke-reflow artifacts. |
| T5 | **Reconnect reaches full history** | Emit 20k lines, drop+restore WS, scroll to top. | Full 50000-line reach (not ring-capped); `attach_meta` re-inits seam; no error frames. |
| T6 | **Alt-screen** | Run a brief alt TUI (non-Claude) with prior primary scrollback; scroll up. | Scroll-up shows primary scrollback; no alt framing leaks; on alt-exit a resync reconciles. |
| T7 | **Teammate read-only** | Attach a teammate pane; scroll up. | History served identically; no input side-effects; read-only contract intact. |
| T8 | **SSH remote** | Remote-host session; deep scroll. | Capture runs over SSH transport (verify target/host in logs); rows correct; shimmer hides RTT; seed no longer local-mis-targeted. |
| T9 | **Live-path non-regression** | Normal streaming, jump-to-bottom, reconnect — no scrolling up. | Byte-identical to pre-change behavior (live path untouched); rAF coalescer, pin-to-bottom, reveal gate all unchanged. |

**Screenshot/DOM assertion:** T2's pass is the decisive one — diff the scrolled-up region's rendered cells against a ground-truth `capture-pane -e -p -S <start> -E <end>` taken at the same width; require exact match.

---

## 5. Rollback / risk

**Feature flag.** Gate the entire client history-layer behind a `TERM_TMUX_HISTORY` flag (env/localStorage). Flag **off** → `scrollback` stays 50000, no `history` frames sent, stacked history term not mounted — **identical to today's behavior**. This is the instant rollback: flip the flag, no redeploy of the server needed (the server-side `History` handler is inert if never called).

**Server risk is low and isolated.** The new `capture_history_window` + `send_history_window` + `ClientMsg::History` arm are **additive and read-only** — they take no `SessionLock`, don't touch the live fan-out, the replay ring, or the seed. Worst server-side failure is a slow/failed capture, which returns `{error:true}`; the client degrades to the seed history already in xterm (today's behavior for the top portion). The transport-threading change (§2.3a) is the one server edit that touches an existing path — it's guarded by `Some/None` fallback to the current local `Tmux::new`, so a resolution failure degrades to exactly today's behavior.

**Staged rollout.** (1) Ship server additions (inert without a client that sends `history`). (2) Ship client behind the flag, off. (3) Enable flag for the harness + own instance; run T1–T9. (4) Default-on after T2 (the resize repro) passes on the real box.

**Residual risks & mitigations:**
- *Tail HOL-blocking during a fling* — mitigated by the 500-row cap and 300-row windows; if profiling shows stutter, promote the capture to the mpsc history task (§2.3b). Low likelihood (2ms forks).
- *Seam drift via `baseY` mis-count* — bounded blast radius (at most a row or two of overlap/gap at the seam); a manual resync re-anchors. Covered by T3.
- *Second xterm memory* — history term scrollback is bounded by DOM-mounted windows; evict far-below rows from the DOM while keeping ANSI in `histRows` for instant scroll-back-down.

**Files touched (final list):** `server/src/sessions/tmux.rs` (add `capture_history_window`, `HistoryWindow`, `parse_hist_info`, `HISTORY_WINDOW_MAX` + tests), `server/src/ws/protocol.rs` (add `History` variant + test), `server/src/ws/mod.rs` (transport threading, `send_history_window`, `History` arm in both `select!` loops, `attach_meta` frame), `web/src/hooks/use-live-term.ts` (shrink scrollback, history state, `requestHistory`, `history`/`attach_meta` handlers, seam tracking, near-top detection, resize cache-clear), new `web/src/components/history-term.tsx` (stacked read-only history xterm + scroll-coordination wrapper).