---
description: Schedule a prompt for YOUR OWN session — a follow-up, a recurring check, a reminder to yourself.
argument-hint: <when> — <what to do>   (e.g. "every weekday at 8 — check the deploy")
supermux-managed: true
---

# /supermux-schedule — put work on your own calendar

You can schedule a prompt to be delivered to **this session**, once or on a
cadence. When it fires, the prompt arrives in your pane exactly as if someone had
sent it to you, and the transcript shows which schedule sent it — so a 03:00
prompt does not read as the owner having been awake at 03:00.

Use it for: a follow-up you cannot do yet ("check whether CI went green in 20
minutes"), a recurring check the human asked for ("every weekday at 8, look at
the deploy"), or a reminder to yourself before you hand back.

## The boundaries — read these before you call

- **You can only schedule for YOUR OWN session.** The server takes the session
  from your token, not from your payload. There is no way to schedule work for a
  colleague; if that is what the human wants, say so rather than trying.
- **You can only deliver a PROMPT.** Not a shell command, not a booted session,
  not a permission bypass. Asking for any of those is a 400.
- **`done_action` may only be `disable` or `notify`.** `disable` turns the
  schedule off after it has run (the right answer for a one-shot); `notify` pings
  the human. Anything else is a 400.
- **There is a cap of 20 live schedules per session.** Over it you get a 429.
  That is not a retry — delete one first, or tell the human you are at the limit.
- **A rejected request is a 400, a 401 or a 429 with a readable message.**
  Surface it to the human. Do not retry the same call hoping for a different
  answer; the server is deterministic.

The pane already has the three env vars these calls need — you set nothing up:

- `$SUPERMUX_URL` — the server base URL.
- `$SUPERMUX_SESSION` — this session's name.
- `$SUPERMUX_HOOK_TOKEN` — your per-session secret; authenticates these calls.

## YOU do the parsing — the server does not

The human will say "every weekday at 8" or "in twenty minutes". **You translate
that into one of the expressions below and send the concrete form.** The server
does no natural-language interpretation at all: an expression it does not
recognise is a 400, never a guess about what you meant.

| what the human said | `schedule_expr` you send |
|---|---|
| "in twenty minutes" | `in 20m` |
| "in two hours" | `in 2h` |
| "tomorrow-ish" (be explicit, ask if unsure) | `in 1d` |
| "every couple of hours" | `every 2h` |
| "run this every weekday at 8" | `every weekday at 08:00` |
| "every morning" | `daily at 9am` (or `every morning`) |
| "every day at half nine at night" | `daily at 21:30` |
| "every Friday afternoon at five" | `weekly on friday at 17:00` |
| "on the first of the month" | `monthly on 1 at 09:00` |
| "every Tuesday at noon" | `every tuesday at 12:00` |
| a cron the human dictated | `0 8 * * 1-5` (bare 5-field cron) |

The full grammar, exactly as `scheduler/parser.rs` accepts it:

- `in <N><unit>` — one-shot, relative. Units: `s`/`m`/`h`/`d` (and their long
  forms: `min`, `mins`, `hour`, `hours`, `day`, `days`).
- `every <N><unit>` — a repeating interval measured from each fire.
- `every morning` / `every evening` / `every night` — 09:00 / 18:00 daily.
- `every weekday at <time>` — Mon–Fri.
- `daily at <time>`
- `weekly on <dayname> at <time>`
- `monthly on <N> at <time>` — `N` is 1–28 (so it exists in February).
- `every <dayname> at <time>`
- a bare 5-field cron: `<min> <hour> <dom> <mon> <dow>`

`<time>` is `HH:MM` (24-hour), or `9am` / `6pm` / `9:30pm`. **When the human is
ambiguous about the time — "in the morning", "after lunch" — ask them rather
than picking.** A schedule that fires at the wrong hour is worse than a
question.

## Create a schedule

`title` is what the human will see in their transcript and in the Schedules
sheet — make it a short noun phrase they would recognise ("Nightly release
watch"), not a restatement of the prompt.

`prompt` is what YOU will receive when it fires. Write it to your future self,
with enough context to act on cold: you will not remember this conversation.

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  "$SUPERMUX_URL/api/hook/schedule/create" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","title":"Deploy check","prompt":"Check whether the 08:00 deploy went green; if it did not, summarise the failure.","schedule_expr":"every weekday at 08:00"}'
```

For prompts with quotes or newlines in them, build the JSON safely with `jq`:

```bash
TITLE='Nightly release watch'
PROMPT='Check the release job. If it is red, read the last 50 lines of the log and say what broke.'
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  "$SUPERMUX_URL/api/hook/schedule/create" \
  --json "$(printf '{"session":%s,"title":%s,"prompt":%s,"schedule_expr":%s}' \
            "$(jq -Rn --arg s "$SUPERMUX_SESSION" '$s')" \
            "$(jq -Rn --arg t "$TITLE" '$t')" \
            "$(jq -Rn --arg p "$PROMPT" '$p')" \
            "$(jq -Rn --arg e 'daily at 21:00' '$e')")"
```

### A one-shot follow-up

For something that should happen once and then stop, use a relative expression
and `done_action: "disable"` (which is the default — it is spelled out here so
the intent is visible):

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  "$SUPERMUX_URL/api/hook/schedule/create" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","title":"CI follow-up","prompt":"Check whether the CI run on this branch finished, and report the result.","schedule_expr":"in 20m","done_action":"disable"}'
```

### Pinging the human instead

`"done_action":"notify"` sends the human a notification when the run completes,
rather than turning the schedule off. Use it for a recurring check they asked to
be told about.

## After you create one

The response is the schedule, including its `id`. A `Created schedule ⏱ <title>`
line appears in this session's transcript by itself — you do not need to
announce it separately. **Tell the human what you scheduled and when it will
first fire**, in one sentence, so they can correct you before it runs.

To change or remove a schedule, the human does it from the Schedules sheet in
the app (tap the `⏱` chip in the transcript). You cannot edit or delete
schedules — including your own — and you should say that rather than trying.

---

This command is managed by supermux and auto-installed — don't edit it by hand;
your changes will be overwritten on the next boot.
