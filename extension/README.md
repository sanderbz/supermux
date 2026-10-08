# Supermux · Point & tell

A Chrome Manifest V3 extension for reviewed website feedback. Pick DOM elements, draw a circle, or select an area; add notes; review a masked screenshot; send to the Supermux chat paired with that website.

## Try it

```sh
cd extension
npm run build
```

Download the ZIP from your Claude or Codex agent’s **Settings → Feedback Chrome Extension** card and unzip it, or build locally as above. Installation requires desktop Chrome; pairing and connection management are also available from the phone.

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `extension/dist`. Pin Supermux to the toolbar. Open a regular HTTP/HTTPS website and click its icon. Local annotation and screenshot review work before connecting a server.

**⌘ P / Ctrl P** picks an element, **⌘ D / Ctrl D** draws, **⌘ R / Ctrl R** selects an area (⌘ on Mac, Ctrl on Windows/Linux). Shortcuts leave text fields and their native undo untouched. Click a numbered pin to edit; **⌘/Ctrl Enter** finishes a note; **⌘/Ctrl Z** undoes; **Escape** closes a note, review, or the overlay. Drafts recover on the same page. Notes follow page scrolling. Finish a note while visible to save its crop, then Review captures the current viewport. Retake whenever you need to. In Review, click the screenshot or a crop to inspect the full image; switch between the clean and numbered overview or inspect actual pixels. Escape closes the viewer and returns focus to its preview. **Edit notes** returns to annotation without losing your overall message.

For a standalone design preview, open `extension/preview/index.html` in a browser. It runs the production overlay with a simulated worker and page capture.

## Connect a chat

From Review choose **Connect this website to a chat**. Enter your Supermux endpoint (prefer your Tailscale HTTPS address; localhost and private Tailscale HTTP are supported). The browser asks for access to that exact server. In your Supermux chat choose **Pair browser**, then enter the extension’s four-digit code. Return to the website and reopen the overlay. If Connect reports an HTML page or a missing browser feedback API, verify the server address and update the Supermux server with browser feedback support; an older dashboard alone cannot accept pairing codes. Each website origin can connect to a different chat. Disconnect individual bindings from the chat sheet; **Reset server** in extension settings removes all local bindings and server permission.

## Privacy and delivery

Server credentials stay in the background worker and trusted extension storage. Content scripts receive only the paired chat label. Captures mask visible inputs, editable fields, marked private elements (`data-private` / `data-sensitive`), accessible shadow controls, and embedded frames. Closed shadow roots cannot be inspected. Always review the screenshot for other sensitive content. Route query and hash context are preserved while common credential parameters and URL userinfo are redacted. DOM context excludes private/editable text and executable markup.

The agent receives a clean overview, a matching numbered overview, and one crop per note. Crops read from the original capture before overview downsampling, preserve native text detail up to 1400 × 1000 pixels, and shrink adaptively to stay inside image and request budgets. Explicit note numbers match the numbered overview and the delivered crop filenames. Each new crop records its capture time, viewport, original note geometry, drawing points, and the exact padded/clipped crop bounds.

Screenshots and crops freeze their capture coordinates. A viewport or active-tab change cancels capture. Offscreen notes use their previously saved image and capture context; deleting an earlier note updates its displayed number without changing the crop’s provenance. Older saved drafts remain readable; their original capture context and matching numbered overview may be unavailable. Offscreen notes are labeled outside the current full screenshot. Failed sends preserve the draft and client id for idempotent retry. “Queued” means received by Supermux; “Delivered” appears only after server status becomes `sent`.

Drafts deduplicate repeated image pixels and adapt saved crop sizes to a combined 10 MiB image budget while retaining every note and its capture context. The extension requests `unlimitedStorage` to support detailed screenshots, then enforces its own limits: 48 MiB per packed draft, 80 MiB across retained drafts, and seven days of retention. Older drafts are pruned after a new draft saves successfully. Sending waits for that save; a storage failure keeps the previous saved draft and displays a retry message.

## Verify

```sh
npm run build
npm test
npm run test:e2e
npm run showcase
```

Brand assets use the canonical blue chevrons from `brand/logo-supermux.svg`, `web/src/brand/logo.svg`, and `web/public/icon.svg`. Toolbar PNGs are checked in at 16, 32, 48, and 128 pixels; normal builds copy these assets without a rasterizer dependency.

Node tests use the workspace’s `web/node_modules/jsdom`. The browser suite uses a persistent Chromium extension context and CDP to inspect the production closed shadow root. It checks actual document and overflow-container scrolling against SVG outlines, drawing points, pins, and the selected editor; fixed/sticky elements and restored DOM anchors after reload are included. Run `npm run build && npm run test:e2e` on a host that permits Chromium to launch; Node geometry tests alone do not verify browser layout. No production dependencies or bundler are required.

The showcase command opens a local example website, annotates it with the built extension, and captures the production review UI to `docs/screenshots/browser-feedback.png`. It requires Chromium with extension support and is also available in the browser feedback showcase GitHub Actions workflow.
