# Fase A0 transcript fixture corpus

Anonymized Claude Code JSONL transcript fixtures for the supermux chat-renderer
parser (`server/src/sessions/chat/parser.rs`, master plan §2.1). Every line was
captured from a live transcript on this machine and anonymized by a
deterministic transformer that preserves **exact structural shape**: key order,
nesting, field presence, value types, string lengths (incl. newline positions),
and line-level block splitting. Free text / paths / URLs / ids are synthetic;
enum-like values (`type`, `subtype`, `role`, `model`, `operation`, `mode`,
`permissionMode`, `version`, tool names, hook event names) are verbatim.
Timestamps are kept verbatim (machine times, no PII). Serialized line length can
differ slightly from the source where the source contained JSON-escaped
characters; parsed string lengths match exactly.

Validation: a checker script re-parses every line, compares the recursive key
structure against the (private, not-checked-in) source lines, regenerates the
anonymization byte-for-byte, and runs a forbidden-substring privacy scan.
41/41 lines pass as of 2026-08-13.

**Claude Code versions**: captured across 2.1.211 → 2.1.231 (the deployed CLI
auto-updated from 2.1.227 to 2.1.231 during capture on 2026-08-13; the live
probe session that produced the `subagents/` pair ran 2.1.231). Each entry that
carries a `version` field states its true source version — see the table.
Entries whose source has no `version` field (bare pointer/metadata lines) are
marked `—`.

## Coverage

| Fixture file : line | Shape | Source CC version |
|---|---|---|
| assistant.jsonl:1 | assistant, single `thinking` block (with `signature`) | 2.1.220 |
| assistant.jsonl:2 | assistant, single `text` block | 2.1.220 |
| assistant.jsonl:3 | assistant, single `tool_use` block | 2.1.220 |
| assistant.jsonl:4 | assistant, **multi-block** `[thinking, text]` — RARE (1 in 21,431 recent assistant lines) but real; the "always single-block" invariant is soft | 2.1.224 |
| user.jsonl:1 | user, string `message.content` | 2.1.220 |
| user.jsonl:2 | user, list-of-`text`-blocks content | 2.1.220 |
| tool-results.jsonl:1 | user w/ `tool_result` block + `toolUseResult` | 2.1.220 |
| tool-results.jsonl:2 | `tool_result`, **104,045-byte line** (wire-cap case) | 2.1.220 |
| tool-results.jsonl:3 | user w/ nested `image` block (base64 source), 482 KB | 2.1.220 |
| queue-operation.jsonl:1–3 | `enqueue` / `dequeue` / `remove` | — |
| mode.jsonl:1 | `mode` entry | — |
| mode.jsonl:2 | `permission-mode` entry | — |
| system.jsonl:1 | `system` / `compact_boundary` (+`compactMetadata`, `logicalParentUuid`) | 2.1.211 |
| system.jsonl:2 | `system` / `local_command` | 2.1.220 |
| system.jsonl:3 | `system` / `stop_hook_summary` | 2.1.220 |
| system.jsonl:4 | `system` / `turn_duration` | 2.1.220 |
| meta-entries.jsonl:1 | `custom-title` | — |
| meta-entries.jsonl:2 | `last-prompt` (`leafUuid`) | — |
| meta-entries.jsonl:3 | `pr-link` (`prNumber`/`prUrl`/`prRepository`) | — |
| meta-entries.jsonl:4 | `agent-name` (bonus, in corpus but not in plan list) | — |
| meta-entries.jsonl:5 | `ai-title` (bonus) | — |
| meta-entries.jsonl:6 | `agent-setting` (bonus) | — |
| meta-entries.jsonl:7 | `bridge-session` (bonus) | — |
| attachment.jsonl:1 | attachment / `hook_success` (the `-o /dev/null` noise class) | 2.1.220 |
| attachment.jsonl:2 | attachment / `hook_additional_context` | 2.1.220 |
| attachment.jsonl:3 | attachment / `queued_command` | 2.1.220 |
| attachment.jsonl:4 | attachment / `task_reminder` | 2.1.220 |
| file-history.jsonl:1 | `file-history-snapshot`, empty `trackedFileBackups` | — |
| file-history.jsonl:2 | `file-history-snapshot`, path-keyed `trackedFileBackups` | — |
| file-history.jsonl:3 | `file-history-delta` (`trackingPath`, `backup`) | — |
| subagents/agent-a03a3cf7ef12532dc.jsonl (8 lines) | full subagent transcript: `isSidechain:true`, `agentId`, user/assistant/attachment lines | 2.1.231 |
| subagents/agent-a03a3cf7ef12532dc.meta.json | subagent meta: `agentType`, `description`, `toolUseId`, `spawnDepth` | 2.1.231 capture |

Notes for the parser:
- **Assistant lines are single-block ~99.995% of the time, not 100%**: one live
  `[thinking, text]` line exists (2.1.224). Parse `content` as a list, always.
- The subagent meta.json on 2.1.227+ has **no `model` key** (seen only on some
  2.1.221 metas) — treat `model` as optional.
- Corpus also contains top-level types `agent-name`, `agent-setting`,
  `ai-title`, `bridge-session` that the master plan's type list omits — the
  tolerant `unknown` variant must cover at least these.
- `session_id` (snake) and `sessionId` (camel) both appear on the same entry;
  `toolUseID` (capital ID) appears inside hook attachments.

## `claude-states.jsonl` — the state parity corpus (states audit, 2026-08-17)

A SECOND corpus with a different job. The files above pin *shape tolerance*:
every line must parse, nothing may panic, nothing may be dropped. This one pins
*meaning*: what each state MUST become on both planes.

One file, two readers — `server/tests/state_parity.rs` (the real
`chat::parser` + `chat::agent_error`) and
`web/tests/unit/chat-state-parity.test.ts` (`agent-error.ts` +
`wire-entries.ts`). Both assert the same rows, because the limit taxonomy is
classified twice: the server stamps it onto the wire entry from the transcript
line, and the client re-derives it from a `StopFailure` banner for the roster
badge (that plane has no chat store behind it — `chat_store()` is deliberately
non-creating, and a roster is exactly the list of sessions nobody has open).
Neither language errors when the two drift.

Row fields: `name`, `source`, `line` (the raw JSONL record, exactly as CC
writes it), `expect.kind` / `.label` / `.ok`, `expect.body` (a **subset** —
every key listed must match exactly, so a new body key never breaks the corpus
and a dropped one always does), and `expect.display` (what
`wire-entries.ts` must render; `-` means deliberately not drawn).

What it covers, and why each row is there:

| rows | why |
|---|---|
| the six limit buckets (`session_5h`, `weekly`, `opus`, `model`, `usage_credit`) | they are NOT interchangeable — waiting is the wrong answer to four of them (`/model`, `/usage-credits`) |
| the server-side throttle | CC explicitly says "not your usage limit"; it arrives with the SAME class and status as a quota hit and must never badge as one |
| a 529 overload, a 401 auth death | a damaged turn vs a session that is dead until somebody signs in |
| two prose controls | an assistant line that merely *mentions* a limit, and a tool result that *quotes* the refusal sentence — a loose match on either blanks a working session |
| `api_error` / `model_refusal_fallback` / `request_user_dialog` / `compact_boundary` / `informational` / `stop_hook_summary` | the five system subtypes that must render, and the one that must stay dropped |
| the `AskUserQuestion` pair, `ExitPlanMode`, a denial | the payloads that ARE the tool call, and the receipt that must not carry a success tick |

Sources are verbatim captures off this box except where a row's `source` says
`strings(2.1.227)` — those are transcribed from the binary's own template
strings (the `Kzt` label map and the `KZe` banner template), for buckets this
account has never hit.
