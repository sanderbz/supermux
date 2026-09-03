---
description: Report progress on YOUR supermux board issue (comment / done / needs-input / check / link).
argument-hint: done | needs-input "<question>" | comment <text> | check <item_id> [off] | link pr|commit <ref> [label]
supermux-managed: true
---

# /supermux-task — report back to your board issue

You were assigned a supermux board issue and it is linked to THIS session. Use this
command to write progress back onto your own card.

## The decision rule — read this first

When you STOP, you are in exactly ONE of two situations. Always report which one:

1. The task is **DONE** and its acceptance criteria pass → run the **done** call.
   It moves your card to the Done lane. Use this ONLY when the work is fully
   complete and accepted.
2. You are **BLOCKED** / need a human decision or information to continue → run the
   **needs-input** call with your question. Your card STAYS in Doing, shows the
   question, and the human is notified. Do NOT mark done; do NOT guess — ask.

Never end your turn silently — always report one of the two.

Everything here is scoped to YOUR issue only. The server resolves "your issue" as
the issue linked to `$SUPERMUX_SESSION` (the one you're doing). You can only ever
touch that one card — a leaked token grants nothing else. Each call re-publishes
the board so it shows up live for whoever is watching.

Run the matching `supermux-task` line below. The wrapper is on your `PATH` and
pre-approved, so it runs without a permission prompt; it prints the server's
answer and fails loudly on a non-2xx.

---

## done — the task is finished

Move your card to the Done lane. Use this ONLY when the work is complete and the
acceptance criteria pass.

```bash
supermux-task done
```

## needs-input — you are blocked, ask the human

Ask for a decision or information. Your card stays in Doing, your question is
posted on the card, and the human gets a push notification. They can reply
straight from the board and you'll receive it as input.

```bash
supermux-task needs-input "Should I drop the legacy column now, or keep it for one more release?"
```

---

The calls below are OPTIONAL progress reporting you can use while working. They
are NOT terminal actions — finish with `done` or `needs-input` above.

## comment — leave a progress note

Append a comment to your card. Use it liberally: "ran the tests, 2 failing",
"pushed the fix".

```bash
supermux-task comment "Finished the migration. All board tests pass."
```

## check — tick (or untick) an acceptance item

Tick off an acceptance-criteria item by its numeric `item_id` (the card's
checklist shows the ids). The item must belong to YOUR issue.

```bash
supermux-task check 42        # tick it done
supermux-task check 42 off    # untick it
```

## link — attach a PR or commit

Attach a pull-request URL or a commit SHA to your card so reviewers can jump
straight to the work. The kind is `pr` or `commit`; a label is optional.

```bash
supermux-task link pr https://github.com/org/repo/pull/123 fix
supermux-task link commit "$(git rev-parse HEAD)" impl
```

For text with awkward quoting, or a field these forms do not cover, hand over the
whole body after the subcommand:

```bash
supermux-task comment --json '{"body":"line one\nline two"}'
```

---

## A good end-of-task flow

```bash
supermux-task comment "Implemented + tested. Opening PR."
supermux-task link pr https://github.com/org/repo/pull/123
supermux-task done
```

## Under the hood

Each subcommand POSTs one JSON body to one board hook with your
`$SUPERMUX_HOOK_TOKEN`, filling in `"session":"$SUPERMUX_SESSION"` for you:

- `done` → `$SUPERMUX_URL/api/hook/board/status` with `{"status":"done"}`
- `needs-input` → `$SUPERMUX_URL/api/hook/board/needs-input` with `{"question":"…"}`
- `comment` → `$SUPERMUX_URL/api/hook/board/comment` with `{"body":"…"}`
- `check` → `$SUPERMUX_URL/api/hook/board/check` with `{"item_id":42,"done":true}`
- `link` → `$SUPERMUX_URL/api/hook/board/link` with `{"kind":"pr","ref":"…","label":"…"}`

The raw form of the first one:

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/status" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","status":"done"}'
```

Use the `curl` only if the wrapper is missing from an old pane; it costs a
permission prompt that nobody may be there to answer.

---

This command is managed by supermux and auto-installed — don't edit it by hand;
your changes will be overwritten on the next boot.
