---
description: Ping the human in the app — when you need them, or when you finish something while they're away.
argument-hint: <title> — <one-line body>   (e.g. "Deploy done — the 08:00 release went green")
supermux-managed: true
---

# /supermux-notify — get the human's attention

Send a push notification to the human who owns this dashboard. It reaches their
phone / installed app even when supermux is closed, and tapping it opens THIS
session's pane. Use it when a decision is blocked on them, or when a long job
finishes while they're away — not for routine progress (that's your board issue,
`/supermux-task`).

## The boundaries — read these before you call

- **You can only notify about YOUR OWN pane.** The server takes the session from
  your token; there is no way to ping someone else's user or point the tap at
  another pane.
- **`title` and `body` are short.** `title` ≤ 120 chars, `body` ≤ 600 — a
  notification is a glance, not a report. Over the limit is a 400.
- **There is a rate limit** (a handful per minute per session). A loop that pings
  every second gets a 429 — that is not a retry; back off, or you're spamming a
  phone.
- **Never put secrets in the title or body.** It lands on a lock screen.

## Send a notification

```bash
supermux-notify "The 08:00 release went green." --title "Deploy done"
```

Everything that is not `--title` is the body. Leave `--title` off and the
notification is titled with your session name, which is usually what the human
wants to see on a lock screen. The wrapper is on your `PATH` and pre-approved, so
it runs without a permission prompt — reach for it rather than `curl`.

An `{"ok":true}` means it was accepted (and delivered if the human has a device
subscribed; `0` devices is not an error). Don't announce that you sent a
notification unless the human needs to know — the ping speaks for itself.

For copy with awkward quoting, hand over the whole body instead:

```bash
supermux-notify --json '{"title":"Blocked on you","body":"I need the staging DB password."}'
```

## Under the hood

`supermux-notify` POSTs `{session,title,body}` to `$SUPERMUX_URL/api/hook/notify`
with your `$SUPERMUX_HOOK_TOKEN` — the same call as:

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  "$SUPERMUX_URL/api/hook/notify" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","title":"Deploy done","body":"…"}'
```

Use the `curl` only if the wrapper is missing from an old pane; it costs a
permission prompt that nobody may be there to answer.

---

This command is managed by supermux and auto-installed — don't edit it by hand;
your changes will be overwritten on the next boot.
