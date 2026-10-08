# Browser feedback with Supermux

The Chrome extension lets you select an element, draw around a detail, or mark a region on a website and send a reviewed screenshot with change requests to a Supermux chat. Claude Code and Codex are supported. Feedback waits for an idle agent with an empty terminal composer; it never starts a stopped agent or clears a draft.

## Install and pair

1. Open any Claude or Codex agent's settings and download the ZIP from **Feedback Chrome Extension**. Install it once: every agent and company serves the same package. Extract it into a folder you will keep. The repository also includes [`extension/releases/supermux-browser-extension.zip`](../extension/releases/supermux-browser-extension.zip).
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the extracted folder containing `manifest.json`. Pin **Supermux · Point & tell** in Chrome's toolbar. Developers can instead run `cd extension && npm run build` and load `extension/dist`.
3. Open the website you want to change and click the extension icon, or press **Alt Shift A**. Use the overlay’s single connection control to connect this website.
4. On first use, enter your Supermux server address in the extension settings and approve access to that address. The extension remembers it; connecting another website starts pairing automatically with that saved server. For a server on another computer, use its reachable HTTPS or Tailscale address. `http://localhost:8823` refers to the computer running Chrome.
5. The extension displays a four-digit code. Open the intended agent's **Feedback Chrome Extension** settings or **Pair browser** in its chat and enter that code within five minutes. Users can pair or revoke browsers for agents they can access; company members are confined to their own company's agents.
6. Return to the extension, check the website, company and agent, and confirm the connection. A matched code does not activate a new destination until you confirm it.

Reuse the same installed extension for all agents and companies you can access. Each new website needs its own pairing, not another installation. The extension remembers each website's chosen agent. To change the agent for an already connected website, open its connection control and choose **Change agent**. Pair it with the intended agent and confirm that destination. Other websites keep their existing connections.

Pairing attaches that exact website origin to that chat. A different scheme, hostname, or port requires another pairing. You can pair several websites with different chats. Remove a connection from the agent's **Feedback Chrome Extension** settings or **Pair browser** to revoke it and cancel feedback that has not started delivery. Moving the agent or its pairing user to another company, or removing the pairing user, permanently revokes that connection.

A Supermux server on a VPS works when its agent runs locally on that VPS. Sessions configured to run through an SSH host are not supported by this first version because screenshot files must be readable on the agent's computer. Company feedback files stay within their company isolation root, including when the agent works in an existing project folder elsewhere. Pairing does not change the agent's project folder or expand a company member's filesystem access.

## Annotate and send

Choose the element, drawing, or region tool, then add a note describing what should change. Add more notes as needed. Open **Review**, capture the viewport, click the screenshot or a crop to inspect it at a larger size, and write an overall request or let the notes carry the requests. **Send to your agent** creates one durable receipt; retries reuse its client id and original destination. Changing this website’s agent affects new feedback, while outstanding submissions and receipt status checks keep their original agent. Resetting the server invalidates old credentials rather than redirecting those retries.

Capture shows the visible page as Chrome renders it. Supermux does not cover or remove input fields, editable content, private elements, or embedded frames. URL query and hash context are preserved. The preview lets you check the image before sending. The image viewer lets you switch between the clean screenshot and numbered overview, fit the image or inspect its actual size, and return to your unchanged review with Escape. The image covers the visible viewport. Clicking **Done** saves a crop for that note while it is visible. Notes saved before scrolling retain their crops and are identified as outside the current screenshot when appropriate. Capture is cancelled if the page or a scroll container moves while Chrome is taking the screenshot.

The agent receives a clean screenshot for visual detail, a separate numbered overview, and one `note-N.png` crop for each note. The crop is taken from the original capture before the overview is resized, so small text stays readable. Each crop records its capture time, viewport and scroll position, padded source rectangle, full annotation rectangle, and drawing points. Earlier crops keep this original context when you scroll; their coordinates do not refer to the latest overview. Numbers link the overview, annotation notes, and crop files even if crops arrive in a different order.

To try the overlay without a server, load the unpacked extension and annotate a normal HTTP or HTTPS page. You can add notes and inspect the capture. Sending becomes available after pairing. Chrome's own settings pages and other restricted pages cannot be annotated.

## Delivery and recovery

`queued` means saved and waiting. `sent` means the server observed the agent consume the terminal input; it does not mean the requested change is finished. Busy, stopped, unknown, modal, or nonempty-composer sessions remain queued. Existing drafts are preserved. Status changes and new feedback wake the outbox; a slow reconciliation tick also checks waiting rows. Messages preserve insertion order within each session, while stopped sessions do not block other sessions.

`failed` can mean submission became uncertain after possible terminal input, or the server restarted during delivery. Check the receipt's reason and the terminal before sending it again. A workspace change or unavailable evidence files also fails the receipt before terminal input; capture new feedback for the current workspace. The worker never automatically replays a failed receipt. `cancelled` means the browser binding was revoked before input was delivered.

Ordinary chat sends also use bracketed paste and bounded submit verification. Codex's paste-burst input handler suppresses Enter for 120 ms after a burst, so the server separates paste and submission. It retries only Enter while the current composer still holds the message it just sent. An unreadable screen or a dialog never receives a retry. The timing behavior comes from [Codex's paste burst implementation](https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/bottom_pane/paste_burst.rs).

## Data and limits

Screenshots, crops, and `feedback.json` for company agents are stored in `<company root>/.supermux/browser-feedback/<receipt id>/`. Agents without a company use `<agent workspace>/.supermux/browser-feedback/<receipt id>/`. The server records the capture-time agent workspace in the database-backed delivery prompt; changing it before delivery fails the receipt without typing into the agent. Existing receipts in an agent workspace remain valid only when their original path is still valid and, for company agents, inside that company's root. Each generated folder ignores its contents in Git. Files are created exclusively with mode `0600`; directory symlinks are refused. The JSON distinguishes user requests (`message` and annotation notes) from untrusted page evidence (URL, title, element text, selectors, and roles). Terminal prompts point to these files rather than injecting page text into the agent input.

The saved JSON uses `schema_version: 2`: `screenshot` identifies `screenshot.png`, `annotated_screenshot` identifies `annotated-overview.png`, and `annotations[].number` matches `crops[].number` and each `note-N.png` filename. `crops[].capture` contains the original capture context. Older clients may omit the numbered overview, explicit numbers, and crop capture context; the server fills in numbers and marks those crops with `capture_context_available: false`. An updated extension requires a server that supports these fields and preserves the draft if an older server rejects them.

Completed, failed, and cancelled receipts and their generated files expire after 30 days while their recorded storage location remains valid, checked hourly. Pending feedback stays available. Deleting a session removes its receipts but leaves generated files in their recorded storage folder; remove individual receipt folders manually when you no longer need the evidence. A company feedback folder can hold receipts for several agents. Stored image bytes tracked by the outbox are capped at approximately 1 GiB; files left after session deletion are outside that accounting. Each browser binding may have 30 pending receipts. Limits per feedback are 40 annotations, 1,500 drawing points per annotation, 12,000 characters in the overall request, and 4,000 characters per note. The server accepts bounded PNG containers with verified chunk checksums, up to 8 MiB per overview, 2 MiB per crop, and 16 MiB of images total. It does not fully decode compressed image data. Screenshots may be downsampled while preserving viewport aspect ratio; annotation coordinates stay in CSS pixels.

Drafts stay in this browser's extension storage. Image data is deduplicated within each draft. The extension requests `unlimitedStorage` so Chrome's ordinary local-storage quota does not discard a screenshot; its own limits remain 48 MiB per packed draft and 80 MiB of retained drafts. Saving a new draft prunes older drafts beyond that budget or seven days. A failed save keeps the previous draft and displays a message so you can keep the page open and retry.

Submission recovery stores only small destination and receipt records, never extra screenshot copies. It retains at most 2,048 records or 4 MiB and does not evict old attempts, so a forgotten retry cannot silently target a different agent. At capacity, new sends stop with the draft preserved.

The four digits are a short-lived pairing code, not the credential that sends feedback. Codes are single-use, expire after five minutes, and have bounded creation and claim attempts. Claiming a code requires an authenticated dashboard user with access to the chosen agent. The extension asks you to confirm the matched website and destination before activating a new connection. The extension's random pairing token becomes a scoped binding credential after the dashboard claims the code. Only SHA-256 token hashes are stored on the server. That credential cannot access dashboard session APIs, other bindings, or another website origin. Extension CORS is limited to these capability endpoints and does not enable cookie credentials.

The ZIP is identical for every agent and company. It contains only the extension's shipped code and icons, without local settings, screenshots, or browser storage. Its download is public at `/downloads/supermux-browser-extension.zip`. Normal web builds rebuild the ZIP, deployment input hashes include extension sources, and the server embeds it separately from the web assets so a frontend refresh cannot remove the download.

## Development checks

Use debug builds; never use release builds on small development hosts. From the repository root:

```sh
cd extension
npm test
npm run build
npm run test:e2e
node scripts/showcase.mjs
cd ../web
npm run build
cd ../server
cargo test --lib browser_feedback::tests
cargo test --lib sessions::lifecycle::write_runtime_tests
```

The Chrome smoke test uses the local Playwright installation in `web/node_modules`; install its Chromium browser before running it. `showcase.mjs` opens a synthetic studio website in real Chromium with the shipped extension, enters two notes through its closed shadow root, captures through the production service worker and `chrome.tabs.captureVisibleTab`, verifies that visible fields are preserved, and writes `docs/screenshots/browser-feedback.png`. The connection label is a local fixture and no feedback is submitted. The **Browser feedback** GitHub workflow runs both Chrome checks and uploads their screenshots; it has a ten-minute timeout and runs independently of the server CI jobs.

Packaging tests use Python's standard ZIP reader to validate the archive independently and check reproducibility. Backend regression tests use fake terminal runtimes and local SQLite/filesystem fixtures, including the paste suppression window, swallowed Enter, modal races, draft preservation, member access and CSRF, scoped credentials, deleted-user id reuse, queue ordering, revocation, restart recovery, idempotent numbered-image ingestion, crop provenance after scrolling, and legacy payload support.
