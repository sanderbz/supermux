/**
 * Chat answers through the asks API (docs/ASKS.md) — the cards answer a
 * permission, a question (multi-select, several questions, free text) and a
 * form natively, and a composer send while one is up IS its answer.
 *
 * Static markup for the cards (no DOM, no network), plain calls for the pure
 * halves, and one JSDOM harness for the composer's routing.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'

import {
  answerFailure,
  answersOnTap,
  composerReply,
  deliveredLine,
  drawable,
  EMPTY_PICK,
  permissionChoices,
  permissionView,
  questionAnswer,
  questionsComplete,
  setOther,
  suggestionLabel,
  togglePick,
} from '../../src/components/chat/ask-answer'
import type { NativeAskView } from '../../src/components/chat/ask-cards'
import { getDraft, setDraft } from '../../src/components/chat/composer-draft'
import { askKind, LiveLayer } from '../../src/components/chat/live-layer'
import { nativeAsk } from '../../src/components/chat/use-ask-answer'
import { useComposer, type ComposerHandle } from '../../src/components/chat/use-composer'
import type { TileSession } from '../../src/components/session-tile/types'
import { applyAskFrame } from '../../src/hooks/use-asks'
import type { Ask, AskAnswer, AskQuestion } from '../../src/lib/api/asks'
import { ApiError } from '../../src/lib/api/client'

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>)

function ask(over: Partial<Ask> = {}): Ask {
  return {
    id: 'ask_1',
    session: 'api-worker',
    kind: 'permission',
    state: 'open',
    answerable: true,
    detail: { tool: 'Bash', summary: '⚡ Run the migration', kind: 'bash', mode: 'default', suggestions: 2 },
    created_ms: 1_000,
    updated_ms: 1_000,
    rev: 1,
    ...over,
  }
}

const LIVE_INPUT: Ask['input'] = {
  tool_input: { command: 'bin/migrate --apply', description: 'Run the migration' },
  permission_suggestions: [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'bin/migrate:*' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'somethingNew', destination: 'session' },
  ],
}

const FRUITS: AskQuestion = {
  question: 'Which fruits do you like?',
  header: 'Fruit',
  multi_select: true,
  options: [{ label: 'Apple', description: 'Crisp' }, { label: 'Banana' }, { label: 'Cherry' }],
}
const COLOR: AskQuestion = {
  question: 'Which color?',
  multi_select: false,
  options: [{ label: 'Green' }, { label: 'Blue' }],
}

function questionAsk(questions: AskQuestion[]): Ask {
  return ask({ id: 'ask_q', kind: 'question', detail: { questions } })
}

function session(over: Partial<TileSession> = {}): TileSession {
  return { name: 'api-worker', status: 'waiting', updated_at: '', dir: '/opt/projects/api/worker', ...over } as TileSession
}

function view(a: Ask, questions: AskQuestion[] = []): NativeAskView {
  return { ask: a, questions, onAnswer: () => {} }
}

/* ── the live list ───────────────────────────────────────────────────────── */

describe('applyAskFrame keeps the open list honest', () => {
  test('an opened ask is added, an updated one replaced in place, a closed one removed', () => {
    const a = ask()
    const b = ask({ id: 'ask_2', created_ms: 2_000 })
    let list = applyAskFrame([], { op: 'opened', rev: 1, ask: a })!
    list = applyAskFrame(list, { op: 'opened', rev: 1, ask: b })!
    expect(list.map((x) => x.id)).toEqual(['ask_1', 'ask_2'])
    list = applyAskFrame(list, { op: 'updated', rev: 2, ask: { ...a, rev: 2, answerable: false } })!
    expect(list.map((x) => x.id)).toEqual(['ask_1', 'ask_2'])
    expect(list[0].answerable).toBe(false)
    list = applyAskFrame(list, { op: 'closed', rev: 3, ask: { ...a, rev: 3, state: 'answered' } })!
    expect(list.map((x) => x.id)).toEqual(['ask_2'])
  })

  test('an older frame cannot resurrect or rewind an ask', () => {
    const list = [ask({ rev: 5 })]
    expect(applyAskFrame(list, { op: 'updated', rev: 4, ask: ask({ rev: 4, state: 'open' }) })).toBeNull()
  })

  test('the live input a GET fetched survives a frame, which never carries it', () => {
    const list = [ask({ input: LIVE_INPUT })]
    const next = applyAskFrame(list, { op: 'updated', rev: 2, ask: ask({ rev: 2 }) })!
    expect(next[0].input).toEqual(LIVE_INPUT)
  })

  test('a malformed frame is ignored, not thrown', () => {
    expect(applyAskFrame([], null)).toBeNull()
    expect(applyAskFrame([], { op: 'opened', ask: { id: 7 } })).toBeNull()
  })
})

describe('the ask chat answers is the oldest answerable hook ask', () => {
  test('oldest first, answerable only, hook kinds only — the rest are counted', () => {
    const asks = [
      ask({ id: 'new', created_ms: 3_000 }),
      ask({ id: 'old', created_ms: 1_000 }),
      ask({ id: 'held', created_ms: 500, answerable: false }),
      ask({ id: 'board', created_ms: 100, kind: 'needs_input' }),
    ]
    const { ask: pick, queued } = nativeAsk(asks)
    expect(pick?.id).toBe('old')
    expect(queued).toBe(1)
  })
})

/* ── permission ──────────────────────────────────────────────────────────── */

describe('permission answers say what they grant', () => {
  test('Claude’s own offers are named; an unknown shape is not offered', () => {
    expect(suggestionLabel(LIVE_INPUT!.permission_suggestions![0])).toBe(
      'Yes, and always allow Bash(bin/migrate:*) in this project',
    )
    expect(suggestionLabel(LIVE_INPUT!.permission_suggestions![1])).toBe('Yes, and auto-accept edits for this session')
    expect(suggestionLabel(LIVE_INPUT!.permission_suggestions![2])).toBeNull()
    expect(suggestionLabel({ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny' })).toBeNull()
  })

  test('the choices are allow, each offer by its own index, then No (which stops the turn)', () => {
    const choices = permissionChoices(ask({ input: LIVE_INPUT }))
    expect(choices.map((c) => c.label)).toEqual([
      'Yes',
      'Yes, and always allow Bash(bin/migrate:*) in this project',
      'Yes, and auto-accept edits for this session',
      'No',
    ])
    expect(choices.map((c) => c.answer)).toEqual([
      { decision: 'allow' },
      { decision: 'allow', permissions: [0] },
      { decision: 'allow', permissions: [1] },
      { decision: 'deny', interrupt: true },
    ])
  })

  test('the card shows the real command from the live input', () => {
    const v = permissionView(ask({ input: LIVE_INPUT }))
    expect(v).toMatchObject({ verb: 'Run', chip: 'the migration', evidence: { text: 'bin/migrate --apply', prose: false } })
  })

  test('a plan is a plan, an edit names its file, an unknown tool shows its input', () => {
    const plan = permissionView(ask({ detail: { tool: 'ExitPlanMode' }, input: { tool_input: { plan: '1. Do it' } } }))
    expect(plan).toMatchObject({ plan: true, evidence: { text: '1. Do it', prose: true } })
    expect(permissionChoices(ask({ detail: { tool: 'ExitPlanMode' } })).map((c) => c.label)).toEqual([
      'Yes, go ahead',
      'No, keep planning',
    ])
    const edit = permissionView(ask({ detail: { tool: 'Edit', summary: '' }, input: { tool_input: { file_path: 'src/a.ts', new_string: 'x' } } }))
    expect(edit).toMatchObject({ verb: 'Edit', chip: 'src/a.ts' })
    const mcp = permissionView(ask({ detail: { tool: 'mcp__db__query', summary: '' }, input: { tool_input: { sql: 'select 1' } } }))
    expect(mcp.verb).toBe('Use')
    expect(mcp.chip).toBe('mcp__db__query')
    expect(mcp.evidence?.text).toContain('select 1')
  })
})

/* ── question ────────────────────────────────────────────────────────────── */

describe('question answers', () => {
  test('a multi-select toggles; a single-select holds one answer, and free text replaces it', () => {
    let p = togglePick(FRUITS, EMPTY_PICK, 'Apple')
    p = togglePick(FRUITS, p, 'Cherry')
    expect(p.selected).toEqual(['Apple', 'Cherry'])
    p = togglePick(FRUITS, p, 'Apple')
    expect(p.selected).toEqual(['Cherry'])

    let c = togglePick(COLOR, EMPTY_PICK, 'Green')
    c = togglePick(COLOR, c, 'Blue')
    expect(c.selected).toEqual(['Blue'])
    c = setOther(COLOR, c, 'teal')
    expect(c).toEqual({ selected: [], other: 'teal' })
    expect(togglePick(COLOR, c, 'Green')).toEqual({ selected: ['Green'], other: '' })
  })

  test('the body is keyed by index and carries labels, lists and free text in the server’s shapes', () => {
    const picks = [{ selected: ['Apple', 'Cherry'], other: '' }, { selected: [], other: 'teal' }]
    expect(questionsComplete([FRUITS, COLOR], picks)).toBe(true)
    expect(questionAnswer([FRUITS, COLOR], picks)).toEqual({
      answers: { '0': ['Apple', 'Cherry'], '1': { selected: [], other: 'teal' } },
    })
    expect(questionAnswer([COLOR], [{ selected: ['Green'], other: '' }])).toEqual({ answers: { '0': 'Green' } })
    expect(questionsComplete([FRUITS, COLOR], [picks[0], EMPTY_PICK])).toBe(false)
  })

  test('only one single-select question answers on the first tap', () => {
    expect(answersOnTap([COLOR])).toBe(true)
    expect(answersOnTap([FRUITS])).toBe(false)
    expect(answersOnTap([COLOR, COLOR])).toBe(false)
  })
})

/* ── the composer ────────────────────────────────────────────────────────── */

describe('a composer send while an ask is up is its answer', () => {
  test('one question → its free-text answer; a permission → deny with the note; otherwise none', () => {
    expect(composerReply(questionAsk([COLOR]), [COLOR], ' teal ')).toEqual({ answers: { '0': { selected: [], other: 'teal' } } })
    expect(composerReply(ask(), [], 'use staging')).toEqual({ decision: 'deny', message: 'use staging' })
    expect(composerReply(questionAsk([FRUITS, COLOR]), [FRUITS, COLOR], 'x')).toBeNull()
    expect(composerReply(ask({ kind: 'elicitation' }), [], 'x')).toBeNull()
    expect(composerReply(ask(), [], '   ')).toBeNull()
    expect(composerReply(null, [], 'x')).toBeNull()
  })

  test('delivered lines and refusals are in the card’s voice', () => {
    expect(deliveredLine(ask(), { decision: 'allow' })).toBe('Allowed.')
    expect(deliveredLine(ask(), { decision: 'deny', message: 'no' })).toBe('Declined — Claude has your note.')
    expect(deliveredLine(questionAsk([COLOR]), { answers: {} })).toBe('Answered.')
    expect(answerFailure(new ApiError(409, 'ask_not_open: ask x is answered'))).toContain('Already answered')
    expect(answerFailure(new ApiError(409, 'ask_not_answerable: no decision hook'))).toContain('terminal')
    expect(answerFailure(new ApiError(400, 'question 0: "Kiwi" is not one of its options'))).toContain('Kiwi')
  })
})

/* ── the live band ───────────────────────────────────────────────────────── */

describe('the native card outranks every key-pressing card', () => {
  const legacy = session({
    permission_request: { tool: 'Bash', summary: 'Run the migration', kind: 'bash' },
  })

  test('a waiting permission is answerable — no "answer in the terminal"', () => {
    const out = html(<LiveLayer name="api-worker" session={legacy} turnStart={null} nativeAsk={view(ask({ input: LIVE_INPUT }))} />)
    expect(out).toContain('chat-ask-permission')
    expect(out).toContain('bin/migrate --apply')
    expect(out).toContain('Yes, and auto-accept edits for this session')
    expect(out).not.toContain('chat-permission-card')
    expect(out).not.toContain('Answer in the terminal')
    // Live buttons, not disabled ones.
    expect(out).not.toMatch(/<button[^>]*disabled[^>]*>Yes</)
  })

  test('without a native ask the legacy card still draws — the fallback for older hooks', () => {
    const out = html(<LiveLayer name="api-worker" session={legacy} turnStart={null} />)
    expect(out).toContain('chat-permission-card')
  })

  test('a delivered answer holds the band so the old card cannot flash back', () => {
    const out = html(<LiveLayer name="api-worker" session={legacy} turnStart={null} askDelivered="Allowed." />)
    expect(out).toContain('Allowed.')
    expect(out).not.toContain('chat-permission-card')
  })

  test('multi-select and several questions are drawn as toggles with one Send', () => {
    const a = questionAsk([FRUITS, COLOR])
    const out = html(<LiveLayer name="api-worker" session={session()} turnStart={null} nativeAsk={view(a, [FRUITS, COLOR])} />)
    expect(out).toContain('Claude has 2 questions for you.')
    expect(out).toContain('Which fruits do you like?')
    expect(out).toContain('aria-pressed="false"')
    expect(out).toContain('chat-question-submit')
    expect(out).not.toContain('Pick more than one in the terminal')
  })

  test('a question ask without parseable questions falls back instead of drawing an empty card', () => {
    const a = questionAsk([])
    expect(drawable(view(a, []))).toBe(false)
    const out = html(<LiveLayer name="api-worker" session={legacy} turnStart={null} nativeAsk={view(a, [])} />)
    expect(out).toContain('chat-permission-card')
  })

  test('a form ask draws a live form', () => {
    const a = ask({
      id: 'ask_f',
      kind: 'elicitation',
      detail: { server: 'deploy', message: 'Who approves?', fields: [{ name: 'approver', title: 'Approver', kind: 'string', required: true }] },
    })
    const out = html(<LiveLayer name="api-worker" session={session()} turnStart={null} nativeAsk={view(a)} />)
    expect(out).toContain('chat-elicitation-card')
    expect(out).not.toContain('supermux can read this form but not submit it yet')
  })

  test('the spoken ask names what the native card is', () => {
    expect(askKind({ native: 'plan', form: true, permission: true, signIn: false })).toBe('plan')
  })
})

/* ── composer routing (JSDOM) ────────────────────────────────────────────── */

let root: Root | null = null
let dom: JSDOM | null = null
const prior = new Map<string, PropertyDescriptor | undefined>()
afterEach(async () => {
  if (root) await React.act(() => root?.unmount())
  root = null
  dom?.window.close()
  dom = null
  for (const [key, d] of prior) {
    if (d) Object.defineProperty(globalThis, key, d)
    else Reflect.deleteProperty(globalThis, key)
  }
  prior.clear()
})

async function composerWith(reply: { accepts: (t: string) => boolean; answer: (t: string) => Promise<boolean> }) {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const name = `ask-reply-${Math.random().toString(36).slice(2)}`
  const typed: string[] = []
  let handle: ComposerHandle
  function Probe() {
    handle = useComposer({
      name,
      input: { submit: async (t: string) => void typed.push(t), sendKey: async () => {} },
      active: false,
      askReply: { kind: 'question', ...reply },
    })
    return null
  }
  root = createRoot(dom.window.document.getElementById('root')!)
  await React.act(() => root!.render(<Probe />))
  const flush = (fn: () => void) =>
    React.act(async () => {
      fn()
      await new Promise((r) => setTimeout(r, 0))
    })
  return { name, typed, flush, handle: () => handle! }
}

describe('the composer answers the ask instead of typing into its dialog', () => {
  test('an accepted reply goes to the ask, never to the pty, and the draft clears', async () => {
    const answered: string[] = []
    const h = await composerWith({ accepts: () => true, answer: async (t) => (answered.push(t), true) })
    await h.flush(() => setDraft(h.name, 'teal please'))
    await h.flush(() => h.handle().submit())
    expect(answered).toEqual(['teal please'])
    expect(h.typed).toEqual([])
    expect(getDraft(h.name)).toBe('')
  })

  test('a failed answer keeps the words in the box', async () => {
    const h = await composerWith({ accepts: () => true, answer: async () => false })
    await h.flush(() => setDraft(h.name, 'keep me'))
    await h.flush(() => h.handle().submit())
    expect(getDraft(h.name)).toBe('keep me')
    expect(h.typed).toEqual([])
    await h.flush(() => setDraft(h.name, ''))
  })

  test('a reply the ask cannot take is refused — and still not typed into the dialog', async () => {
    const h = await composerWith({ accepts: () => false, answer: async () => true })
    await h.flush(() => setDraft(h.name, 'two questions, one sentence'))
    await h.flush(() => h.handle().submit())
    expect(h.handle().notice?.kind).toBe('ask-card')
    expect(h.typed).toEqual([])
    await h.flush(() => setDraft(h.name, ''))
  })
})

/* ── the terminal's draft, moved (JSDOM) ─────────────────────────────────── */

describe('a terminal draft can be moved into chat instead of only refused', () => {
  test('the text comes into the box, the prompt is cleared with End + C-u, and re-read', async () => {
    dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, { configurable: true, value })
    }
    const name = `adopt-${Math.random().toString(36).slice(2)}`
    const keys: string[] = []
    // Before the send: a draft. Before the move: the same. After the keys: empty.
    const reads = ['half a sentence', 'half a sentence', null]
    const lens = (d: string | null) => ({ composerDraft: d, composerDraftVerified: true, dialog: null, modal: null }) as never
    let handle: ComposerHandle
    function Probe() {
      handle = useComposer({
        name,
        input: { submit: async () => {}, sendKey: async (k) => void keys.push(k) },
        peek: { refresh: async () => lens(reads.shift() ?? null) },
        active: false,
      })
      return null
    }
    root = createRoot(dom.window.document.getElementById('root')!)
    await React.act(() => root!.render(<Probe />))
    const flush = (fn: () => void) =>
      React.act(async () => {
        fn()
        await new Promise((r) => setTimeout(r, 0))
      })
    await flush(() => setDraft(name, 'my message'))
    await flush(() => handle!.submit())
    expect(handle!.notice?.kind).toBe('tui-draft')
    await flush(() => handle!.adoptTerminalDraft?.())
    expect(keys).toEqual(['End', 'C-u'])
    expect(getDraft(name)).toBe('half a sentence\nmy message')
    expect(handle!.notice).toBeNull()
    await flush(() => setDraft(name, ''))
  })
})

// Typed against the union so a drift in the API shape fails the build here.
const _shapes: AskAnswer[] = [{ decision: 'allow', permissions: [0] }, { answers: { '0': ['a'] } }, { action: 'decline' }]
void _shapes
