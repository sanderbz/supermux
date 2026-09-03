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

`<time>` is `HH:MM` (24-hour), or `9am` / `6pm` / `9:30pm`. **Clock times are the
SERVER's local time** — the host's own `TZ` / `/etc/localtime`, i.e. the same
wall clock `date` prints in your pane — so "every weekday at 08:00" fires at the
operator's 08:00, not at 08:00 UTC. The stored `next_run` is an instant and
comes back in RFC3339 with an offset; convert it before quoting a time back to
the human. **When the human is
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
supermux-schedule "Deploy check" "every weekday at 08:00" "Check whether the 08:00 deploy went green; if it did not, summarise the failure."
```

Three arguments in order: the title, the schedule expression, then the prompt.
The wrapper is on your `PATH` and pre-approved, so it runs without a permission
prompt — reach for it rather than `curl`.

### A one-shot follow-up

For something that should happen once and then stop, use a relative expression:

```bash
supermux-schedule "CI follow-up" "in 20m" "Check whether the CI run on this branch finished, and report the result."
```

`done_action` defaults to `disable`, which turns the schedule off after it has
run — the right answer for a one-shot. To set it (or any other field the three
arguments do not cover) hand over the whole body:

```bash
supermux-schedule --json '{"title":"Nightly release watch","schedule_expr":"daily at 21:00","prompt":"Check the release job; if it is red, say what broke.","done_action":"notify"}'
```

### Pinging the human instead

`"done_action":"notify"` sends the human a notification when the run completes,
rather than turning the schedule off. Use it for a recurring check they asked to
be told about.

## After you create one

The response is `201` with the envelope every supermux API uses:
`{"ok":true,"data":{...the schedule...}}` — the schedule itself (its `id`,
`title`, `schedule_expr`, `next_run`) is under `data`, not at the top level.
Read it with `jq .data.id` / `jq .data.next_run`. **A 2xx means it was created,
even if you could not parse the body — never retry the create call, or you make
a duplicate schedule.** A `Created schedule ⏱ <title>` line appears in this
session's transcript by itself — you do not need to announce it separately. **Tell the human what you scheduled and when it will
first fire**, in one sentence, so they can correct you before it runs.

To change or remove a schedule, the human does it from the Schedules sheet in
the app (tap the `⏱` chip in the transcript). You cannot edit or delete
schedules — including your own — and you should say that rather than trying.

## Under the hood

`supermux-schedule` POSTs `{session,title,schedule_expr,prompt}` to
`$SUPERMUX_URL/api/hook/schedule/create` with your `$SUPERMUX_HOOK_TOKEN` — the
same call as:

```bash
curl -fsS -H "X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  "$SUPERMUX_URL/api/hook/schedule/create" \
  -d '{"session":"'"$SUPERMUX_SESSION"'","title":"Deploy check","prompt":"…","schedule_expr":"every weekday at 08:00"}'
```

Use the `curl` only if the wrapper is missing from an old pane; it costs a
permission prompt that nobody may be there to answer.

---

This command is managed by supermux and auto-installed — don't edit it by hand;
your changes will be overwritten on the next boot.
