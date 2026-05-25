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

Everything here is scoped to YOUR issue only. The pane already has the three env
vars these calls need — you don't set anything up:

- `$SUPERMUX_URL` — the server base URL.
- `$SUPERMUX_SESSION` — this session's name (identifies which issue is yours).
- `$SUPERMUX_HOOK_TOKEN` — your per-session secret; authenticates these calls.

The server resolves "your issue" as the issue linked to `$SUPERMUX_SESSION`
(the one you're doing). You can only ever touch that one card — a leaked token
grants nothing else. Each call re-publishes the board so it shows up live for
whoever is watching.

Run the matching `curl` below. They use `-fsS` so a non-2xx response prints the
error and fails loudly. The body's `session` MUST be `$SUPERMUX_SESSION`.

---

## done — the task is finished

Move your card to the Done lane. Use this ONLY when the work is complete and the
acceptance criteria pass.

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/status" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","status":"done"}'
```

## needs-input — you are blocked, ask the human

Ask for a decision or information. Your card stays in Doing, your question is
posted on the card, and the human gets a push notification. They can reply
straight from the board and you'll receive it as input.

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/needs-input" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","question":"<your question here>"}'
```

For multi-line / quote-heavy questions, build the JSON safely with `jq`:

```bash
Q='Should I drop the legacy column now, or keep it for one more release?'
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/needs-input" \
  --json "$(printf '{"session":%s,"question":%s}' \
            "$(jq -Rn --arg s "$SUPERMUX_SESSION" '$s')" \
            "$(jq -Rn --arg q "$Q" '$q')")"
```

---

The calls below are OPTIONAL progress reporting you can use while working. They
are NOT terminal actions — finish with `done` or `needs-input` above.

## comment — leave a progress note

Append a comment to your card. Use it liberally: "ran the tests, 2 failing",
"pushed the fix".

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/comment" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","body":"<your update here>"}'
```

Tip for multi-line / quote-heavy text, build the JSON safely with the body in a shell var:

```bash
BODY='Finished the migration. All board tests pass.'
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/comment" \
  --json "$(printf '{"session":%s,"body":%s}' \
            "$(jq -Rn --arg s "$SUPERMUX_SESSION" '$s')" \
            "$(jq -Rn --arg b "$BODY" '$b')")"
```

## check — tick (or untick) an acceptance item

Tick off an acceptance-criteria item by its numeric `item_id` (the card's
checklist shows the ids). The item must belong to YOUR issue.

Tick it done:

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/check" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","item_id":42,"done":true}'
```

Untick it (`"done":false`):

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/check" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","item_id":42,"done":false}'
```

## link — attach a PR or commit

Attach a pull-request URL or a commit SHA to your card so reviewers can jump
straight to the work. `kind` is `"pr"` or `"commit"`; `label` is optional.

Attach a PR:

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/link" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","kind":"pr","ref":"https://github.com/org/repo/pull/123","label":"fix"}'
```

Attach a commit:

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/link" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","kind":"commit","ref":"'"$(git rev-parse HEAD)"'","label":"impl"}'
```

---

## A good end-of-task flow

```bash
# 1. note what you did
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/comment" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","body":"Implemented + tested. Opening PR."}'

# 2. attach the PR
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/link" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","kind":"pr","ref":"https://github.com/org/repo/pull/123"}'

# 3. mark it done (the task is complete and accepted)
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/status" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","status":"done"}'
```

This command is managed by supermux and auto-installed — don't edit it by hand;
your changes will be overwritten on the next boot.
