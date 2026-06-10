# Design: Last User Prompt Recall

**Status**: Draft for review · **Date**: 2026-06-04 · **Owner**: tbd

## 1. Problem

When juggling many supermux sessions, Claude's replies fill the terminal viewport and the user loses recall of what they themselves typed. Today supermux exposes the session's status, current activity, terminal preview, and timestamps — but never the user's own last prompt. The result: context-switch friction ("which question is this answer to?") and a small but persistent dignity tax on multi-session work.

The DB already captures a 200-char preview of the last sent text (`sessions.last_send_text`, written by `set_last_send` on REST `send` / `paste`); it is unused by the frontend and partially unwritten on the WebSocket input path.

## 2. Goal

Make the user's last prompt **instantly recallable** on the focus screen — with zero clicks at the moment of arrival in a session, and a one-tap re-summon afterwards — without stealing screen space from the terminal.

Apply the same affordance, consistently, on desktop and mobile.

## 3. Out of scope

- A scrollable history of earlier prompts (the user asked for "the last one"; YAGNI for now).
- A full user-only transcript or search across sessions.
- Editing or re-sending the prompt from the recall affordance (read-only).
- Showing the recall affordance on overview tiles, focus-strip rows, or mobile session-pills (could be a thin follow-up since the backend field is now exposed, but is explicitly deferred from this spec).

## 4. UX overview

### 4.1 Trigger model

| Event | What happens |
|---|---|
| Mount of the focus session-view AND `last_send_text` is non-empty | Auto-show the prompt bar (desktop) ; no auto-show on mobile — mobile users tap the icon |
| Switch into the session via overview / pill / focus-strip / command palette / back-nav | Counts as a mount → re-shows on desktop |
| Page reload, PWA re-open | Counts as a mount → re-shows on desktop |
| User clicks the recall icon in the focus header | Open expanded recall: popover (desktop) or Vaul bottom-sheet (mobile) |
| First keypress directed at the terminal | Fade-out the auto-bar (user is engaged) |
| Click / scroll inside terminal viewport | Fade-out the auto-bar (user is reading) |
| 8s elapsed since auto-show | Fade-out the auto-bar (safety net) |
| `×` button on the auto-bar | Fade-out the auto-bar (explicit dismiss) |
| User sends a new prompt while in the same session-view | Silently update the stored text — do NOT re-flash the bar (would be nervous). Next mount will pick up the new text. |
| Session has no `last_send_text` (fresh, no prompts yet) | Auto-bar does not appear; recall icon is hidden (not just disabled) so the header doesn't grow a dead control |

### 4.2 Desktop — the glass recall bar

The bar lives directly under the focus header, full-width, ~32 px tall:

```
┌─ focus header ──────────────────────────────────────────────────┐
│ ●  my-app-refactor                             [↩] [⚙] [⋯] [⊕] │   ← recall icon left of settings
├─ glass recall bar (auto-show on mount, fade per §4.1) ──────────┤
│ ╴ You · 2m ago · "refactor the auth middleware to use the…"   × │
├──────────────────────────────────────────────────────────────────┤
│ $ claude is typing…                                              │
│   …long reply…                                                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

- **Glass effect**: `backdrop-blur-md bg-background/70 border-b border-border/50`. Matches existing PWA aesthetic; legible over both terminal-light and terminal-dark schemes.
- **Single-line**: truncate with `…` at the column boundary. The auto-bar never wraps.
- **Animation**: 220ms slide-down + opacity fade on enter ; 180ms slide-up + opacity fade on exit. Spring: existing `springs.sheetDetent` if it reads well there, otherwise a fresh tween.
- **Click anywhere on the bar (except the ×)**: opens the same popover the recall icon opens.
- **Recall icon** (left of settings) is always present when `last_send_text` exists, regardless of bar visibility. Icon: Lucide `Quote` (semantically "what I said"). Tooltip: "Last prompt (⌘G)".
- **Keyboard shortcut**: `Cmd/Ctrl + G` toggles the popover. (G for "get my last prompt" ; mnemonic-friendly.)

### 4.3 Desktop — the expanded popover

Triggered by clicking the recall icon, clicking the auto-bar, or pressing `⌘G`. Radix popover anchored to the icon:

```
┌─ popover (≤320 × auto height, max 360 height) ──────────────┐
│  You · 2m ago                                       [📋]    │
├──────────────────────────────────────────────────────────────┤
│  refactor the auth middleware to use the new token shape.   │
│  keep the legacy header working for one release so the      │
│  mobile clients have time to roll out…                       │
│                                                              │
│  (preview · 200 chars max — DB cap)                          │
└──────────────────────────────────────────────────────────────┘
```

- **Header**: `You · <relative-time>` + a copy-to-clipboard icon (Lucide `Clipboard`).
- **Body**: full `last_send_text` (up to 200 chars), preserving line breaks; readable, never truncated inside the popover itself.
- **Truncation note**: if `last_send_text.length === 200` (i.e. hit the cap), show a faint footer "preview · 200 chars max" so users know they're seeing a truncated form, not the full original.
- **Closing**: Esc, click-outside, or re-press `⌘G`.

### 4.4 Mobile — icon + Vaul bottom-sheet

Mobile has no auto-show. The focus header gets the same recall icon, left of settings:

```
┌─────────────────────────────────────┐
│ ←  ● my-app-refactor     [↩][⚙][⋯] │   ← icon mirrors desktop position
├─────────────────────────────────────┤
│ terminal…                            │
│ …                                    │
│                                      │
└─────────────────────────────────────┘
```

Tapping the icon opens a Vaul bottom-sheet (matches `session-picker-sheet.tsx` pattern):

```
┌─────────────────────────────────────┐
│            ╴╴╴╴ grabber ╴╴╴╴         │
│                                      │
│  You · 2m ago                  📋   │
│                                      │
│  refactor the auth middleware to    │
│  use the new token shape. keep the  │
│  legacy header working for one…     │
│                                      │
│  (preview · 200 chars max)           │
└─────────────────────────────────────┘
```

- Sheet ≈ 40% of viewport height ; drag-to-dismiss.
- Same content shape as the desktop popover.
- Copy-to-clipboard button.
- No keyboard shortcut on mobile.

### 4.5 Reduced motion + a11y

- `prefers-reduced-motion`: no slide animation, no fade — instant show + instant hide. The 8s safety-net timer still applies.
- The auto-bar is announced once when it appears: `aria-live="polite"` with the label `"Last prompt: <text>"`.
- The recall icon has `aria-label="Show last prompt sent"` and the popover has `role="dialog" aria-label="Last prompt"`.
- The `×` close button is keyboard-reachable; Tab order: recall icon → settings → bar's × → … unchanged elsewhere.
- The keyboard shortcut is registered through the existing focus-mode keymap so it never fires while a modal/sheet is open elsewhere.

## 5. Data model & API

### 5.1 Backend changes

| Change | File | Note |
|---|---|---|
| Expose `last_send_text` and `last_send` (epoch seconds) on `SessionView` | `server/src/sessions/mod.rs` (struct + `view()` builder) | Field names on the wire: `last_send_text: Option<String>`, `last_send_at: Option<i64>`. None when no send has happened. |
| Plug the WS input gap | `server/src/ws/mod.rs` (around the `ClientMsg::Input` handler near line 800) | After `tmux.send_text(&data)` succeeds, call `set_last_send` if the input ends with a newline / submit. **See §5.2 for the submission-detection nuance.** |
| Optionally extend DB column cap | `server/src/db/sessions.rs` | The current 200-char cap is fine for v1. If we widen later for richer popover content, it's a single migration. Not in scope for this spec. |

### 5.2 What counts as "a prompt" on the WS path

The WS `Input` frames carry **raw key bytes** — including individual keystrokes, paste chunks, and the trailing `\r` (carriage return) that submits in tmux. We must NOT log every keystroke individually as "last prompt".

Heuristic for v1 (deliberately simple):

- Maintain a small per-session in-memory buffer of input bytes pending submission.
- Append every `Input.data` chunk to that buffer (cap it at 4 KB to avoid runaway memory if the user pastes a novel without submitting).
- When the buffer contains a `\r` or `\n`, treat the bytes up to and including that newline as one submission: strip control chars, write the first 200 chars to `set_last_send`, clear the buffer.
- A `Ctrl-C` (byte `0x03`) clears the buffer without writing (the user abandoned the prompt).
- A `Ctrl-U` (byte `0x15`) clears the buffer (line kill).

This matches what a human reasonably calls "a prompt": the text typed into the terminal that ends with Enter, not abandoned. It deliberately doesn't try to be perfect (multi-line prompts via Shift-Enter in Claude Code, for example, complicate things) — v1 captures the last newline-terminated line, which is the dominant case.

### 5.3 Frontend wire-up

- Extend the `ApiSession` TypeScript type (`web/src/lib/api.ts`) with `lastSendText?: string; lastSendAt?: number`.
- The existing SSE / WS session-state stream that pushes `SessionView` updates already triggers re-renders ; no new endpoint needed.
- One new hook: `useLastSend(sessionName)` returning `{ text: string | null, sentAt: Date | null }` derived from the same session-state cache the focus-screen already reads.

## 6. Frontend architecture

### 6.1 Components (new)

| Component | Path | Role |
|---|---|---|
| `LastSendBar` | `web/src/components/focus-mode/last-send-bar.tsx` | The glass auto-show bar under the focus header (desktop only). Owns its visibility state + fade timer + dismiss triggers. |
| `LastSendButton` | `web/src/components/focus-mode/last-send-button.tsx` | The Lucide-`Quote` header icon. Renders on both desktop and mobile in the focus header. Hidden when there is no last send. |
| `LastSendPopover` | `web/src/components/focus-mode/last-send-popover.tsx` | Desktop Radix popover with full text + copy. Reusable from the icon click and the bar click. |
| `LastSendSheet` | `web/src/components/focus-mode/last-send-sheet.tsx` | Mobile Vaul bottom-sheet equivalent of the popover. |

### 6.2 Wire-up changes

- `focus-header.tsx`: insert `<LastSendButton />` left of the existing settings/menu cluster. One new prop drilling — the session's `lastSendText`/`lastSendAt`, or pull from the hook directly.
- `routes/focus/desktop.tsx`: render `<LastSendBar />` directly below the header, above the terminal pane.
- `routes/focus/mobile.tsx`: no bar — the icon in `focus-header.tsx` is the only entry.
- `lib/keymap.ts` (or equivalent focus-mode keymap): bind `⌘/Ctrl+G` to toggle the popover. Suppress when any other modal is open.

### 6.3 State & timing

- The fade timer (8s) is owned by `LastSendBar` via `useEffect` + `setTimeout`. Cleared on early-dismiss triggers.
- "First keypress in terminal" hook: subscribe to the existing terminal-input event stream (the same path that dispatches keystrokes to xterm). On first event after mount-with-bar-visible → dismiss. No new global listener.
- "Click / scroll in terminal viewport": a single `onPointerDownCapture` + `onWheelCapture` on the terminal wrapper, gated to fire only while the bar is visible.
- Bar visibility is **not** persisted across navigations. Each mount starts fresh.

## 7. Edge cases

| Case | Behavior |
|---|---|
| No `last_send_text` | Bar not rendered ; icon not rendered. Header stays clean. |
| `last_send_text` is at the 200-char cap | Show truncation footer in popover/sheet ("preview · 200 chars max"). Bar caption still single-line truncated. |
| User sends a new prompt while bar is visible | Bar's caption updates in place (no re-flash). Fade timer NOT reset. |
| User sends a new prompt after bar has faded | Icon now reflects the new prompt on next click ; no auto re-show. |
| Reduced motion | No animations ; show/hide are instant. 8s timer still applies. |
| Multi-line prompt in Claude Code (Shift-Enter) | v1 captures only the line terminated by `\r` ; multi-line will appear truncated to its last line. Documented limitation — track for v2 if it becomes painful. |
| Very fast switching across many sessions (10+ in seconds) | Each mount fires its own auto-show + 8s timer. To avoid timer pile-up, the bar's effect must cancel its timer on unmount. (Standard `useEffect` cleanup.) |
| `Ctrl-C` mid-typing | Buffer cleared on the server ; nothing written. Bar/icon reflect the previous successfully-submitted prompt. |
| Two browser tabs open on the same session | Both receive the same `SessionView` push ; both show the same recall content. No conflict. |
| Prompt contains shell control characters / ANSI escapes | The server strips control chars (per §5.2) before storage ; the frontend renders as plain text with `whitespace-pre-wrap` (newlines preserved, no HTML interpretation). |

## 8. Testing

### 8.1 Server

- Unit test `set_last_send` truncation + control-char stripping. (Exists ; extend if §5.2 introduces new stripping.)
- New unit tests for the WS input buffer:
  - Single keystrokes accumulate, `\r` commits.
  - `Ctrl-C` clears, no commit.
  - `Ctrl-U` clears, no commit.
  - Cap at 4 KB ; further bytes dropped from the head, not the tail.
- Integration: send a prompt via REST `send`, read back `SessionView`, assert `last_send_text` + `last_send_at` populated.
- Integration: send via WS, assert same.

### 8.2 Frontend

- Component test: `LastSendBar` shows on mount when text present, hides when text absent.
- Component test: bar fades on simulated keypress, on simulated terminal click, on 8s timer, on `×`.
- Component test: popover renders full text, copy button writes to clipboard (mock).
- Mobile sheet test: opens on icon tap, drag-to-dismiss closes.
- Keymap test: `⌘G` toggles popover ; suppressed when another sheet/dialog is open.
- A11y smoke: focus order, `aria-live` announcement on bar appearance, ESC closes popover.
- Reduced-motion test: assert no transition classes applied when `prefers-reduced-motion: reduce` matches.

### 8.3 Visual regression

- New VR scenario: focus screen with last-send bar visible (desktop) and faded (desktop).
- Focus screen with icon, no auto-bar (mobile).
- Popover open (desktop), sheet open (mobile).

## 9. Acceptance criteria

A reviewer should be able to verify these in order on a build:

1. Open a fresh session with no prompts. Header does not show the recall icon. No bar appears.
2. Send any prompt via the input. After a moment, the next mount of the focus view (e.g. navigate to overview and back) shows:
   - Desktop: the glass bar appears below the header, contains your prompt (truncated to one line), and fades after 8 s.
   - Mobile: no bar ; the recall icon appears in the header.
3. With the bar visible (desktop): tap any key directed at the terminal → bar fades within ~180 ms.
4. With the bar visible (desktop): scroll the terminal viewport → bar fades.
5. With the bar visible (desktop): press `⌘G` → popover opens, bar is closed (or its dismissal coincides).
6. Click the recall icon (both desktop and mobile) → recall opens (popover / sheet) with the full text and a working copy button.
7. Switch to another session and back: the bar re-appears on the desktop side; the icon remains present on mobile with the latest prompt content.
8. `prefers-reduced-motion: reduce`: bar appears and disappears instantly ; 8 s timer still fires.
9. Server: a REST `send` and a WS `Input ... \r` both result in `last_send_text` being set and pushed to the client.
10. No regressions on the overview tiles, focus strip, mobile pill bar, or session-info panel.

## 10. Open questions

None at spec-finalization time. Items deliberately deferred (not open):
- Multi-prompt history (§3).
- Showing the prompt on tiles/pills (§3 — likely a quick follow-up after this lands).
- Editing/re-sending from the recall affordance (§3).
