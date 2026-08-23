---
description: Message or hand off to a same-company teammate bot — the prompt arrives in their pane.
argument-hint: <teammate> — <what to say or hand off>   (e.g. "billing-bot — please reconcile invoice #91")
supermux-managed: true
---

# /supermux-message — message a teammate

Send a prompt to another supermux agent in **your own company**. It arrives in
their pane exactly as a message from you, tagged with your session name so their
transcript knows who asked. Use it to hand off work you can't do, or to ask a
teammate who owns a domain you don't.

## The boundaries — read these before you call

- **Same company only.** You can reach a teammate in your OWN company; a bot in
  another company (or a main/HQ bot) is a **404** — the same answer a nonexistent
  name gets, so you cannot even probe who exists elsewhere. Your SessionStart
  briefing lists your same-company teammates by name; those are the valid `to`
  values.
- **You always send AS yourself.** The server takes the sender from your token;
  there is no way to send as a colleague.
- **You deliver a PROMPT, nothing else.** Write it to a peer who lacks your
  context — say what you need and why, self-contained.
- **Size + content limits.** The prompt is capped (64 KiB) and may not contain
  supermux wrapper markup (`<supermux-…>`); either is a 400.

The pane already has the env vars these calls need — you set nothing up:

- `$SUPERMUX_URL` — the server base URL.
- `$SUPERMUX_SESSION` — this session's name (becomes the `from`).
- `$SUPERMUX_HOOK_TOKEN` — your per-session secret; authenticates the call.

## Message a teammate

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  "$SUPERMUX_URL/api/hook/delegate" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","to":"billing-bot","prompt":"Please reconcile invoice #91 against the July ledger and reply with any mismatch."}'
```

For a prompt with quotes or newlines, build the JSON safely with `jq`:

```bash
TO='billing-bot'
PROMPT='Please reconcile invoice #91 against the July ledger. Reply here with any mismatch, or "clean" if it balances.'
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/delegate" \
  --json "$(printf '{"session":%s,"to":%s,"prompt":%s}' \
            "$(jq -Rn --arg s "$SUPERMUX_SESSION" '$s')" \
            "$(jq -Rn --arg to "$TO" '$to')" \
            "$(jq -Rn --arg p "$PROMPT" '$p')")"
```

A `200 {"ok":true,"id":…}` means the prompt was delivered and the hand-off edge
recorded. Tell the human who you handed off to and why, in one sentence.

---

This command is managed by supermux and auto-installed — don't edit it by hand;
your changes will be overwritten on the next boot.
