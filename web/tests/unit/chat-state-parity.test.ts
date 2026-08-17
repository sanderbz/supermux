/**
 * **The Claude-state parity contract — TypeScript half.**
 *
 * Twin of `server/tests/state_parity.rs`. Both read the SAME corpus,
 * `server/tests/fixtures/chat/claude-states.jsonl`, whose rows are verbatim
 * Claude Code payloads captured off this box together with what each plane
 * must make of them.
 *
 * Why the classification is asserted in BOTH languages rather than trusted from
 * the server: the same banner reaches this app on two planes. The transcript
 * plane carries the server's stamped `class`/`limit`/`resets_at`; the roster
 * plane carries only `error: {type, message}` from the `StopFailure` hook,
 * because `chat_store()` is deliberately non-creating and a roster is exactly
 * the list of sessions nobody has open. So `agent-error.ts` re-derives the
 * bucket from the banner text, and nothing but this corpus can catch it drifting
 * from `agent_error.rs`.
 *
 * Every assertion here failed before the states fix:
 *   · a limit banner arrived as `kind:'assistant'` and rendered as ordinary
 *     Claude speech — same bubble, same colour, green dot, live composer;
 *   · every `system` entry was dropped, so a silent model swap, a retry storm
 *     and a compaction seam rendered as literally nothing;
 *   · `toolLine` had no `questions`/`plan` key, so a question read
 *     "AskUserQuestion" and a whole written plan read "ExitPlanMode";
 *   · a denied permission folded in with a success tick.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { classifyAgentError, errorBadgeLabel, limitName } from '../../src/components/chat/agent-error'
import { toDisplayList } from '../../src/components/chat/entries'
import { buildTranscript, type TranscriptNode } from '../../src/components/chat/grouping'
import { TranscriptItem } from '../../src/components/chat/transcript-item'
import { toChatEntries, toolLine } from '../../src/components/chat/wire-entries'
import type { WireEntry, WireKind } from '../../src/components/chat/wire'

/** A JSON object read out of the corpus. `unknown` values, read through the
 *  narrow accessors below — this file must not be able to make the corpus pass
 *  by asserting the shape it wants. */
type Json = Record<string, unknown>

interface Row {
  name: string
  source: string
  line: Json
  expect: {
    kind: string
    label?: string
    ok?: boolean
    body?: Json
    display?: string
    tool_line?: string
    reply?: string
  }
}

/** `line.message.content[0]`, the one interesting block of a corpus record. */
function firstBlock(line: Json): Json | undefined {
  const message = line.message as Json | undefined
  const content = message?.content as Json[] | undefined
  return Array.isArray(content) ? content[0] : undefined
}

function blockText(line: Json): string {
  return String(firstBlock(line)?.text ?? '')
}

const CORPUS: Row[] = readFileSync(
  new URL('../../../server/tests/fixtures/chat/claude-states.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row & { _?: string })
  .filter((r) => (r as { _?: string })._ === undefined)

/** The first real row of a built transcript — `buildTranscript` opens with a
 *  date divider, which is chrome and not the node under test. */
function itemNode(nodes: readonly TranscriptNode[]) {
  const node = nodes.find((n) => n.kind === 'item')
  return node && node.kind === 'item' ? node : undefined
}

const byName = (needle: string): Row => {
  const row = CORPUS.find((r) => r.name.includes(needle))
  if (!row) throw new Error(`corpus row missing: ${needle}`)
  return row
}

/**
 * The row's raw transcript line → the sealed wire entry the server produces
 * for it.
 *
 * Every CLASSIFIED key (`class`, `limit`, `limit_label`, `resets_at`,
 * `blocked`, `request_id`, `from_model`, …) comes straight from `expect.body`,
 * which the Rust half proves the real parser emits for this same line. What is
 * reassembled here is only the mechanical half — which block of the record the
 * body was built from — so this shim can never make the corpus pass by
 * agreeing with itself.
 */
function wireFrom(row: Row, seq = 1): WireEntry {
  const line = row.line
  const body: Json = { ...(row.expect.body ?? {}) }
  const block = firstBlock(line)
  if (block?.type === 'text') body.text = block.text
  if (block?.type === 'tool_use') body.input = block.input
  if (block?.type === 'tool_result') {
    body.content = block.content
    const structured = line.toolUseResult as Json | undefined
    if (structured?.answers) body.answers = structured.answers
  }
  if (line.type === 'system') {
    body.content = line.content
    body.level = line.level ?? null
  }
  return {
    seq,
    uuid: String(line.uuid),
    kind: row.expect.kind as WireKind,
    ts_ms: Date.parse(String(line.timestamp)),
    offset: 0,
    tool_use_id: (block?.tool_use_id ?? block?.id) as string | undefined,
    label: row.expect.label,
    ok: row.expect.ok,
    oversize: false,
    truncated: false,
    body,
  }
}

describe('the shared state corpus', () => {
  test('is present and has not shrunk', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(22)
  })

  test('still covers every limit bucket and both impostors', () => {
    const buckets = CORPUS.map((r) => r.expect.body?.limit).filter(Boolean)
    for (const want of ['session_5h', 'weekly', 'opus', 'model', 'usage_credit']) {
      expect(buckets).toContain(want)
    }
    const classes = CORPUS.map((r) => r.expect.body?.class).filter(Boolean)
    expect(classes).toContain('throttle')
    expect(classes).toContain('auth')
  })
})

describe('agent-error.ts agrees with agent_error.rs on every banner', () => {
  for (const row of CORPUS.filter((r) => r.expect.kind === 'agent_error')) {
    test(row.name, () => {
      const got = classifyAgentError(
        blockText(row.line),
        row.line.error as string | undefined,
        row.line.apiErrorStatus as number | undefined,
      )
      const want = row.expect.body ?? {}
      expect(got.cls).toBe(want.class)
      if (want.limit) expect(got.limit).toBe(want.limit)
      if (want.limit_label) expect(got.label).toBe(want.limit_label)
      if (want.resets_at) expect(got.resetsAt).toBe(want.resets_at)
      if (typeof want.blocked === 'boolean') expect(got.blocking).toBe(want.blocked)
    })
  }
})

describe('an ordinary assistant line is never read as a failure', () => {
  for (const row of CORPUS.filter((r) => r.expect.kind === 'assistant')) {
    test(row.name, () => {
      const text = blockText(row.line)
      // No line-level error fields ⇒ the server never classifies it at all, and
      // the client's own classifier must not either (the roster plane hands it
      // the banner text with no class beside it).
      expect(row.line.error).toBeUndefined()
      expect(classifyAgentError(text, null, null).cls).toBe('error')
      expect(classifyAgentError(text, null, null).blocking).toBe(false)
    })
  }
})

describe('the renderer draws each state as its recorded display kind', () => {
  for (const row of CORPUS.filter((r) => r.expect.display)) {
    test(row.name, () => {
      const entries = toChatEntries([wireFrom(row)])
      const want = row.expect.display
      if (want === '-') {
        // Deliberately not rendered: chrome, or a receipt that folds into the
        // tool row above it (which is not present in a one-entry list).
        expect(entries).toHaveLength(0)
        return
      }
      expect(entries).toHaveLength(1)
      if (want === 'blocked') {
        expect(entries[0].kind).toBe('blocked')
        // The bucket must reach the surface as WORDS — "Rate-limited" for all
        // six is the answer that sends somebody to wait when the fix is
        // `/model`.
        expect(entries[0].label).toBeTruthy()
      } else if (want === 'system') {
        // A centred system line, never anybody's bubble.
        const node = itemNode(buildTranscript(toDisplayList(entries), {}))
        expect(node?.speaker).toBe('system')
      } else {
        expect(entries[0].kind).toBe(want)
      }
    })
  }
})

describe('a blocked banner survives the whole display pipeline', () => {
  for (const row of CORPUS.filter((r) => r.expect.display === 'blocked')) {
    test(row.name, () => {
      const items = toDisplayList(toChatEntries([wireFrom(row)]))
      expect(items).toHaveLength(1)
      const item = items[0]
      expect(item.type).toBe('blocked')
      if (item.type !== 'blocked') return
      expect(item.text).toBe(blockText(row.line))
      // …and the reset clause, where the bucket has one, is the whole answer to
      // "when can I work again".
      if (row.expect.body?.resets_at) {
        expect(item.detail).toBe(`Resets ${row.expect.body.resets_at}`)
      }
      // Centred, in the system voice — never a Claude bubble.
      expect(itemNode(buildTranscript(items, {}))?.speaker).toBe('system')
    })
  }
})

describe('toolLine surfaces the payload that IS the tool call', () => {
  for (const row of CORPUS.filter((r) => r.expect.tool_line)) {
    test(row.name, () => {
      const block = firstBlock(row.line)!
      expect(toolLine(String(block.name), block.input)).toBe(row.expect.tool_line!)
    })
  }
})

describe('the AskUserQuestion pair folds into one answered receipt', () => {
  test('the answer renders as the chosen label, not CC’s sentence for the model', () => {
    const use = byName("AskUserQuestion's question reaches")
    const answer = byName('the answer renders as the chosen LABEL')
    const entries = toChatEntries([wireFrom(use, 1), wireFrom(answer, 2)])
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('tool_use')
    expect(entries[0].text).toBe(use.expect.tool_line!)
    // `Which fruit do you want → Apple`, from the SIBLING `toolUseResult`.
    expect(entries[0].reply).toBe('Which fruit do you want → Apple')
    expect(entries[0].ok).toBe(true)
  })

  test('a denied permission does not fold in as a successful call', () => {
    const deny = byName('a denied permission is not a successful')
    const use: WireEntry = {
      seq: 1,
      uuid: 'tu-deny',
      kind: 'tool_use',
      ts_ms: 0,
      offset: 0,
      tool_use_id: 'toolu_01deny',
      label: 'Bash',
      oversize: false,
      truncated: false,
      body: { input: { command: 'rm -rf /tmp/x' } },
    }
    const entries = toChatEntries([use, wireFrom(deny, 2)])
    expect(entries).toHaveLength(1)
    expect(entries[0].ok).toBe(false)
    // The DENIAL rides as its own flag, not as the label: the label is the
    // tool's name, and the flag is what the receipt row reads to say "declined"
    // instead of "failed" (round-2 finding 30 — as a label it was write-only).
    expect(entries[0].denied).toBe(true)
    expect(entries[0].label).toBe('Bash')
  })

  test('a tool whose output merely QUOTES the refusal is still a success', () => {
    const quoted = byName('quotes the refusal sentence')
    const use: WireEntry = {
      seq: 1,
      uuid: 'tu-quote',
      kind: 'tool_use',
      ts_ms: 0,
      offset: 0,
      tool_use_id: 'toolu_01quote',
      label: 'Grep',
      oversize: false,
      truncated: false,
      body: { input: { pattern: 'proceed' } },
    }
    const entries = toChatEntries([use, wireFrom(quoted, 2)])
    expect(entries[0].ok).toBe(true)
    expect(entries[0].label).toBe('Grep')
  })
})

describe('a retry storm is one counting row, not ten', () => {
  test('collapses on requestId and reports the newest attempt', () => {
    const row = byName('api_error retry carries the id')
    const frames = [1, 2, 3, 4].map((n) => {
      const w = wireFrom(row, n)
      return { ...w, uuid: `${w.uuid}-${n}`, body: { ...(w.body as object), attempt: n } }
    })
    const entries = toChatEntries(frames as WireEntry[])
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toContain('retrying (4/10)')
  })
})

describe('the roster badge names the bucket without a chat store', () => {
  // The `StopFailure` plane: `{type, message}` and nothing else. This is what
  // turns `⚠ Error` on every dead session into a sentence.
  test('the six buckets each get their own badge word', () => {
    const cases: [string, string][] = [
      ["You've hit your session limit · resets 4:40am (Europe/Amsterdam)", 'Session limit'],
      ["You've hit your weekly limit · resets 2pm (Europe/Amsterdam)", 'Weekly limit'],
      ["You've hit your Opus limit · resets Aug 20, 9am (Europe/Amsterdam)", 'Opus limit'],
      ["You've reached your Fable 5 limit. Run /usage-credits to continue.", 'Fable 5 limit'],
    ]
    for (const [message, want] of cases) {
      expect(errorBadgeLabel('rate_limit', message)).toBe(want)
    }
    expect(errorBadgeLabel('rate_limit', "You're out of usage credits. /model to switch models.")).toBe(
      'Usage credits',
    )
    // A rate_limit with no banner still badges honestly rather than guessing.
    expect(errorBadgeLabel('rate_limit', '')).toBe('Rate-limited')
  })

  test('a server-side throttle is not badged as a quota hit', () => {
    expect(
      errorBadgeLabel(
        'rate_limit',
        'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
      ),
    ).toBe('Server busy')
  })

  test('the rest of the taxonomy is reachable at last', () => {
    expect(errorBadgeLabel('authentication_failed', 'Please run /login')).toBe('Auth error')
    expect(errorBadgeLabel('billing_error', '')).toBe('Billing')
    expect(errorBadgeLabel('server_error', '529 Overloaded')).toBe('Server error')
    expect(errorBadgeLabel('holder_died', 'pty holder exited')).toBe('Terminal died')
    // Anything unmapped falls through to the caller's own generic.
    expect(errorBadgeLabel('some_future_class', '')).toBeNull()
  })

  test('an unknown bucket keeps Claude Code’s own words', () => {
    const info = classifyAgentError("You've hit your Haiku limit · resets 9am (UTC)", 'rate_limit')
    expect(info.limit).toBe('model')
    expect(limitName(info)).toBe('Haiku limit')
  })
})

describe('the compaction seam says how much history went away', () => {
  // "Conversation compacted" answers "what happened" and nothing else. The
  // payload has always carried `compactMetadata` — trigger, preTokens,
  // postTokens — and the row dropped all three, so the transcript could not say
  // whether the user asked for the compaction or the context filled up, nor how
  // much was summarised away. The size of the drop is the only thing that
  // explains why the model forgot something specific.
  test('the trigger and the token counts reach the row', () => {
    const row = byName('a compaction seam')
    const entries = toChatEntries([wireFrom(row)])
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe('earlier turns are summarised automatically · 1.0M → 17k tokens')
    expect(itemNode(buildTranscript(toDisplayList(entries), {}))?.speaker).toBe('system')
  })

  test('a payload without the metadata still gets its row, minus the clauses', () => {
    // A CC version that renames a field must produce LESS on the row, never a
    // wrong number and never a missing seam (`parser.rs` reads all three
    // defensively for the same reason).
    const bare = { ...wireFrom(byName('a compaction seam')), body: { content: 'Conversation compacted' } }
    const entries = toChatEntries([bare])
    expect(entries[0].text).toBe('earlier turns are summarised')
  })
})

describe('the injected grace-window instruction is never the user speaking', () => {
  // `limit.grace_window`: near a usage limit the server sets
  // `anthropic-ratelimit-unified-grace-status` and Claude Code injects a wrap-up
  // instruction into the MODEL's context as a user-role entry. There is no
  // banner anywhere. Rendered as a prompt — which is what this renderer did —
  // it reads as if the owner typed `[Usage limit reached — grace window active.
  // Wrap up: …]`, and Claude's sudden refusal to spawn subagents then looks like
  // a bug in supermux.
  test('it renders as a system notice, in this app’s words, with CC’s underneath', () => {
    const row = byName('the grace-window wrap-up instruction')
    const entries = toChatEntries([wireFrom(row)])
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe('Claude Code asked the agent to wrap up — usage limit near')
    // …and NOT the injected sentence itself.
    expect(entries[0].text).not.toContain('grace window active')
    // Centred, in the system voice — never anybody's bubble.
    const node = itemNode(buildTranscript(toDisplayList(entries), {}))
    expect(node?.speaker).toBe('system')
    // …AND CC'S OWN SENTENCE UNDERNEATH, which the row used to drop on the floor
    // — leaving this app's paraphrase as the only account of why the agent
    // suddenly stopped starting subagents.
    expect(entries[0].reply).toContain('grace window active')
    // `React.createElement` rather than JSX: this file is a `.ts`, and one
    // assertion is not worth renaming a corpus reader six other tests import
    // their vocabulary from.
    const html = renderToStaticMarkup(
      React.createElement(TranscriptItem, { node: node!, name: 'v-claude', labels: new Map() }),
    )
    expect(html).toContain('data-testid="chat-system-detail"')
    expect(html).toContain('start subagents')
  })

  test('the checkpoint variant says which hint it was', () => {
    const row = byName('the checkpoint variant of the grace hint')
    const entries = toChatEntries([wireFrom(row)])
    expect(entries[0].text).toContain('checkpointing')
  })

  test('a human QUOTING the instruction is still the human', () => {
    const row = byName('a prompt that merely quotes the grace instruction')
    const entries = toChatEntries([wireFrom(row)])
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('prompt')
    const node = itemNode(buildTranscript(toDisplayList(entries), {}))
    expect(node?.speaker).toBe('me')
  })
})

describe('a parked MCP task is visible, and a working one is quiet', () => {
  test('input_required names the server and asks for a person', () => {
    const row = byName('an MCP task parked on input_required')
    const entries = toChatEntries([wireFrom(row)])
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe('an MCP task on “deploy-bot” is waiting for your input')
    expect(itemNode(buildTranscript(toDisplayList(entries), {}))?.speaker).toBe('system')
  })

  test('every other status in the enum stays off the surface', () => {
    const row = byName('an MCP task that is merely working')
    expect(toChatEntries([wireFrom(row)])).toHaveLength(0)
  })
})

describe('the no-hook fallback for an MCP form', () => {
  // A session whose `Elicitation` hook is not installed — an older
  // settings.json, a session started before the upgrade — still emits
  // `request_user_dialog`, the universal "this session is blocked" signal. It
  // is the only thing between that user and a silent hang, so it names what is
  // asking rather than printing CC's token.
  test('request_user_dialog reports an elicitation as an MCP input form', () => {
    const row = byName('request_user_dialog names an elicitation')
    const entries = toChatEntries([wireFrom(row)])
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe('this session is waiting on an MCP server’s input form')
    expect(itemNode(buildTranscript(toDisplayList(entries), {}))?.speaker).toBe('system')
  })
})

/**
 * **The retraction, and the append-only rule it had to respect.**
 *
 * The catalog says the messages named by `retractedMessageUuids` "must be
 * EVICTED from the rendered transcript", and records that supermux's ring has no
 * eviction. The fix is not to build one: what the user READ stays on screen and
 * stops reading as live, driven by a LATER append-only entry that this fold
 * re-derives on every render. These are the two halves of that claim — the rows
 * are marked, and nothing is missing.
 */
describe('a refusal fallback withdraws what it already streamed — without deleting it', () => {
  const retraction = byName('retracts the messages it already streamed')

  /** Two assistant replies, then the fallback line that withdraws them. */
  const wire = (): WireEntry[] => [
    {
      seq: 1,
      uuid: 'asst-withdrawn-1',
      kind: 'assistant',
      ts_ms: Date.parse('2026-08-17T09:11:58.000Z'),
      offset: 0,
      oversize: false,
      truncated: false,
      body: { text: 'Here is how I would exploit that parser.' },
    },
    {
      seq: 2,
      uuid: 'asst-withdrawn-2',
      kind: 'assistant',
      ts_ms: Date.parse('2026-08-17T09:11:59.000Z'),
      offset: 0,
      oversize: false,
      truncated: false,
      body: { text: 'Second half of the same reply.' },
    },
    wireFrom(retraction, 3),
  ]

  test('the withdrawn replies are still there, and marked', () => {
    const entries = toChatEntries(wire())
    const withdrawn = entries.filter((e) => e.uuid.startsWith('asst-withdrawn'))
    // NOT evicted: the reader saw these words, and a transcript that removes
    // what somebody read is lying about what happened.
    expect(withdrawn).toHaveLength(2)
    expect(withdrawn.every((e) => e.retracted === true)).toBe(true)
    // …and the text is untouched. Marking is a rendering fact; the content is
    // Claude Code's and this app does not edit it.
    expect(withdrawn.some((e) => e.text.includes('exploit that parser'))).toBe(true)
  })

  test('a tombstone says what happened and why', () => {
    const tomb = toChatEntries(wire()).find((e) => e.kind === 'retracted')
    expect(tomb).toBeDefined()
    expect(tomb!.text).toContain('withdrawn')
    expect(tomb!.text).toContain('safeguards')
    // Centred system voice, never anybody's bubble.
    const node = buildTranscript(toDisplayList(toChatEntries(wire())), {}).find(
      (n) => n.kind === 'item' && n.item.uuid === tomb!.uuid,
    )
    expect(node?.kind === 'item' && node.speaker).toBe('system')
  })

  test('the mark survives into the display model', () => {
    const items = toDisplayList(toChatEntries(wire()))
    const first = items.find((i) => i.uuid === 'asst-withdrawn-1')
    expect(first?.type).toBe('assistant')
    expect(first?.type === 'assistant' && first.retracted).toBe(true)
  })

  test('a re-fold of the same append-only list gives the same answer', () => {
    // The whole argument for marking rather than mutating: this is a pure fold
    // over a log, so a reload, a re-page and a reconnect all reproduce it. A
    // fold that had mutated its input would not survive being run twice.
    const a = toChatEntries(wire())
    const b = toChatEntries(wire())
    expect(b.map((e) => [e.uuid, e.retracted ?? false])).toEqual(
      a.map((e) => [e.uuid, e.retracted ?? false]),
    )
  })

  test('an ordinary system line withdraws nothing', () => {
    const plain = toChatEntries([wireFrom(byName('a model fallback names BOTH models'))])
    expect(plain.every((e) => e.retracted !== true)).toBe(true)
    expect(plain.every((e) => e.kind !== 'retracted')).toBe(true)
  })
})

/**
 * The two PTY-07 transcript states that used to render as the wrong thing: a
 * refusal drawn as a retryable API error, and a stall drawn as one too (or, once
 * the retry storm collapsed, as nothing at all).
 */
describe('the refused turn and the stalled one are not ordinary API errors', () => {
  test('a refusal is its own class, and it does NOT blank the composer', () => {
    const row = byName('a safeguards refusal is a dead turn')
    const info = classifyAgentError(blockText(row.line), 'refusal', null)
    expect(info.cls).toBe('refusal')
    // `blocking` gates the composer. Sending something else is the remedy here,
    // so taking the composer away would take the fix away.
    expect(info.blocking).toBe(false)
    const item = toDisplayList(toChatEntries([wireFrom(row)]))[0]
    expect(item.type).toBe('blocked')
    expect(item.type === 'blocked' && item.label).toBe('Refused')
    // The remedy rides in the sub-line where a limit's reset clause would be.
    expect(item.type === 'blocked' && item.detail).toContain('/model')
  })

  test('a stalled retry says the turn is still live', () => {
    const row = byName('a stalled stream is a live turn')
    const entries = toChatEntries([wireFrom(row)])
    expect(entries).toHaveLength(1)
    // NOT the `api-retry` badge: nothing errored, and "API error · retrying"
    // about a live turn is a sentence that reads as damage.
    expect(entries[0].kind).toBe('stalled')
    expect(entries[0].text).toContain('nothing has come back yet')
    expect(entries[0].text).toContain('retrying (1/10)')
  })

  test('an ordinary 529 retry keeps its own row', () => {
    const row = byName('an api_error retry carries the id')
    expect(toChatEntries([wireFrom(row)])[0].kind).toBe('api-retry')
  })
})
