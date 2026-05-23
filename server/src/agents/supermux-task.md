---
description: Report progress on YOUR supermux board issue (comment / done / check / link).
argument-hint: comment <text> | done | status <col> | check <item_id> [off] | link pr|commit <ref> [label]
supermux-managed: true
---

# /supermux-task — report back to your board issue

You were assigned a supermux board issue and it is linked to THIS session. Use this
command to write progress back onto your own card: leave a comment, tick an
acceptance item, attach a PR/commit, or move the issue to another column
(including `done` — you have full authority over your own issue's status).

Everything here is scoped to YOUR issue only. The pane already has the three env
vars these calls need — you don't set anything up:

- `$SUPERMUX_URL` — the server base URL.
- `$SUPERMUX_SESSION` — this session's name (identifies which issue is yours).
- `$SUPERMUX_HOOK_TOKEN` — your per-session secret; authenticates these calls.

The server resolves "your issue" as the issue linked to `$SUPERMUX_SESSION`
(the one you're `doing`). You can only ever touch that one card — a leaked token
grants nothing else. Each call re-publishes the board so it shows up live for
whoever is watching.

Run the matching `curl` below. They use `-fsS` so a non-2xx response prints the
error and fails loudly. The body's `session` MUST be `$SUPERMUX_SESSION`.

---

## comment — leave a progress note

Append a comment to your card. Use it liberally: "ran the tests, 2 failing",
"pushed the fix", "blocked on X".

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/comment" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","body":"<your update here>"}'
```

Tip for multi-line / quote-heavy text, build the JSON safely with the body in a shell var:

```bash
BODY='Finished the migration. All 25 board tests pass.'
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/comment" \
  --json "$(printf '{"session":%s,"body":%s}' \
            "$(jq -Rn --arg s "$SUPERMUX_SESSION" '$s')" \
            "$(jq -Rn --arg b "$BODY" '$b')")"
```

## done (or any status) — move your issue's column

Move your card to another column. `done` is allowed — mark it done when the work
is finished and accepted. `review` is the polite "ready for a human to check"
state. The status must be a real column (`todo`, `doing`, `review`, `done`, …).

Mark it done:

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/status" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","status":"done"}'
```

Send it to review instead:

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/status" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","status":"review"}'
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

# 3. move to review (or done)
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/board/status" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","status":"review"}'
```

This command is managed by supermux and auto-installed — don't edit it by hand;
your changes will be overwritten on the next boot.
