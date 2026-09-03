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

## Message a teammate

```bash
supermux-message billing-bot "Please reconcile invoice #91 against the July ledger and reply with any mismatch."
```

The first word is the teammate; everything after it is the prompt. The wrapper is
on your `PATH` and pre-approved, so it runs without a permission prompt — reach
for it rather than `curl`.

A `{"ok":true,"id":…}` means the prompt was delivered and the hand-off edge
recorded. Tell the human who you handed off to and why, in one sentence.

For a prompt with awkward quoting, or a field this form does not cover, hand over
the whole body instead:

```bash
supermux-message --json '{"to":"billing-bot","prompt":"Reply \"clean\" if it balances."}'
```

## Under the hood

`supermux-message` POSTs `{session,to,prompt}` to `$SUPERMUX_URL/api/hook/delegate`
with your `$SUPERMUX_HOOK_TOKEN` — the same call, byte for byte, as:

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  "$SUPERMUX_URL/api/hook/delegate" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","to":"billing-bot","prompt":"…"}'
```

Use the `curl` only if the wrapper is missing from an old pane; it costs a
permission prompt that nobody may be there to answer.

---

This command is managed by supermux and auto-installed — don't edit it by hand;
your changes will be overwritten on the next boot.
