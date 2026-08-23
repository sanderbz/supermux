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

The pane already has the env vars these calls need — you set nothing up:

- `$SUPERMUX_URL` — the server base URL.
- `$SUPERMUX_SESSION` — this session's name.
- `$SUPERMUX_HOOK_TOKEN` — your per-session secret; authenticates the call.

## Send a notification

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  "$SUPERMUX_URL/api/hook/notify" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","title":"Deploy done","body":"The 08:00 release went green."}'
```

For a title/body with quotes or newlines, build the JSON safely with `jq`:

```bash
TITLE='Blocked on you'
BODY='I need the staging DB password before I can run the migration.'
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/notify" \
  --json "$(printf '{"session":%s,"title":%s,"body":%s}' \
            "$(jq -Rn --arg s "$SUPERMUX_SESSION" '$s')" \
            "$(jq -Rn --arg t "$TITLE" '$t')" \
            "$(jq -Rn --arg b "$BODY" '$b')")"
```

A `200 {"ok":true}` means it was accepted (and delivered if the human has a
device subscribed; `0` devices is not an error). Don't announce that you sent a
notification unless the human needs to know — the ping speaks for itself.

---

This command is managed by supermux and auto-installed — don't edit it by hand;
your changes will be overwritten on the next boot.
