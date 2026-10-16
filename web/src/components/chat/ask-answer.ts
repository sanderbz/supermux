// Answering an ask from chat — the PURE half (docs/ASKS.md).
//
// The asks API turns the three dialogs chat used to answer by pressing keys —
// a permission, an AskUserQuestion, an MCP form — into a POST whose answer is
// printed by Claude Code's own `PermissionRequest` / `Elicitation` hook. That is
// the whole reason this file can be small: there is no caret to verify, no
// fingerprint per Claude Code build, no Space-then-Enter for a multi-select. The
// answer is DATA, validated by the server against the question it was asked.
//
// Everything here is pure so the label and body shapes are tested without a
// renderer; `use-ask-answer.ts` is the React around it and `ask-cards.tsx` draws
// it.

import type {
  Ask,
  AskAnswer,
  AskPermissionDetail,
  AskQuestion,
  PermissionSuggestion,
  QuestionAnswerValue,
} from '../../lib/api/asks'
import type { ElicitationAsk } from './elicitation'

/* ── permission ──────────────────────────────────────────────────────────── */

/** One answer a permission card offers. */
export interface PermissionChoice {
  label: string
  primary?: boolean
  answer: AskAnswer
}

/** Where a suggested rule is written, in words. `session` is the default
 *  destination for a mode change and for most rules Claude offers. */
function where(destination?: string): string {
  switch (destination) {
    case 'session':
      return ' for this session'
    case 'localSettings':
    case 'projectSettings':
      return ' in this project'
    case 'userSettings':
      return ' everywhere'
    default:
      return ''
  }
}

const MODE_WORDS: Record<string, string> = {
  acceptEdits: 'auto-accept edits',
  bypassPermissions: 'skip permission prompts',
  plan: 'switch to plan mode',
  default: 'ask again next time',
}

/** One rule as Claude Code prints it: `Bash(npm test:*)`, or the bare tool. */
function ruleText(rule: { toolName?: string; ruleContent?: string }): string {
  const tool = rule.toolName ?? ''
  return rule.ruleContent ? `${tool}(${rule.ruleContent})` : tool
}

/**
 * The "Yes, and …" label of one of Claude's own permission updates. `null` for a
 * shape this client does not know how to say — that suggestion is not offered,
 * because a button must never grant something it cannot name.
 */
export function suggestionLabel(s: PermissionSuggestion): string | null {
  if (s.type === 'addRules' || s.type === 'replaceRules') {
    if (s.behavior && s.behavior !== 'allow') return null
    const rules = (s.rules ?? []).map(ruleText).filter(Boolean)
    if (!rules.length) return null
    return `Yes, and always allow ${rules.join(', ')}${where(s.destination)}`
  }
  if (s.type === 'setMode' && typeof s.mode === 'string') {
    const words = MODE_WORDS[s.mode]
    return words ? `Yes, and ${words}${where(s.destination)}` : null
  }
  if (s.type === 'addDirectories' && Array.isArray(s.directories) && s.directories.length) {
    return `Yes, and allow ${s.directories.join(', ')}${where(s.destination)}`
  }
  return null
}

/**
 * The answers a permission ask offers, in the terminal's order: allow once,
 * then each nameable "always allow" update, then No.
 *
 * "No" DENIES AND STOPS THE TURN — the same thing the terminal's No / Esc does.
 * The softer "No, and tell Claude what to do instead" is the composer: text
 * typed while a permission is asking is sent as the deny's message (see
 * `composerReply`), which is exactly the terminal's feedback row.
 */
export function permissionChoices(ask: Ask): PermissionChoice[] {
  const plan = permissionTool(ask) === 'ExitPlanMode'
  const out: PermissionChoice[] = [
    { label: plan ? 'Yes, go ahead' : 'Yes', primary: true, answer: { decision: 'allow' } },
  ]
  const suggestions = ask.input?.permission_suggestions ?? []
  suggestions.forEach((s, i) => {
    const label = suggestionLabel(s)
    if (label) out.push({ label, answer: { decision: 'allow', permissions: [i] } })
  })
  out.push({
    label: plan ? 'No, keep planning' : 'No',
    answer: { decision: 'deny', interrupt: true },
  })
  return out
}

export function permissionTool(ask: Ask): string {
  return String((ask.detail as AskPermissionDetail).tool ?? '')
}

/** What a permission card asks, as data: the sentence frame, the code chip in
 *  it, and the verbatim evidence (the live tool input) under it. */
export interface PermissionView {
  /** `Run`, `Edit`, `Create`, `Fetch`, `Use` — the verb before the chip. */
  verb: string
  chip: string
  /** The thing being approved, verbatim. `prose` → may soft-wrap (a plan). */
  evidence?: { text: string; prose: boolean }
  plan: boolean
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

export function permissionView(ask: Ask): PermissionView {
  const d = ask.detail as AskPermissionDetail
  const tool = permissionTool(ask)
  const input = ask.input?.tool_input ?? {}
  const summary = (d.summary ?? '').replace(/^\p{Extended_Pictographic}️?\s*/u, '').trim()
  if (tool === 'ExitPlanMode') {
    return { verb: '', chip: '', plan: true, evidence: str(input.plan) ? { text: String(input.plan), prose: true } : undefined }
  }
  if (tool === 'Bash') {
    const command = str(input.command)
    return {
      verb: 'Run',
      chip: summary.replace(/^\s*run\s+/i, '').trim() || command || 'a command',
      evidence: command ? { text: command, prose: false } : undefined,
      plan: false,
    }
  }
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  if (tool === 'Write') return { verb: 'Create', chip: file || summary || 'a file', plan: false, evidence: str(input.content) ? { text: String(input.content), prose: false } : undefined }
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const after = str(input.new_string) ?? str(input.new_source)
    return { verb: 'Edit', chip: file || summary || 'a file', plan: false, evidence: after ? { text: after, prose: false } : undefined }
  }
  if (tool === 'WebFetch') return { verb: 'Fetch', chip: str(input.url) || summary || tool, plan: false }
  // Anything else — an MCP tool, WebSearch, a tool from a newer build — names the
  // tool and shows its input as JSON. Never an invented sentence.
  const keys = Object.keys(input)
  return {
    verb: 'Use',
    chip: summary || tool || 'a tool',
    plan: false,
    evidence: keys.length ? { text: JSON.stringify(input, null, 2), prose: false } : undefined,
  }
}

/* ── question ────────────────────────────────────────────────────────────── */

/** What the user has picked for one question: option labels, plus the dialog's
 *  "Type something" row. */
export interface QuestionPick {
  selected: string[]
  other: string
}

export const EMPTY_PICK: QuestionPick = { selected: [], other: '' }

/** Toggle `label` on question `q`. A single-select question holds one answer —
 *  picking a label clears the free text, and vice versa (`setOther`). */
export function togglePick(q: AskQuestion, pick: QuestionPick, label: string): QuestionPick {
  if (!q.multi_select) return { selected: pick.selected[0] === label ? [] : [label], other: '' }
  const on = pick.selected.includes(label)
  return { ...pick, selected: on ? pick.selected.filter((l) => l !== label) : [...pick.selected, label] }
}

export function setOther(q: AskQuestion, pick: QuestionPick, other: string): QuestionPick {
  return q.multi_select ? { ...pick, other } : { selected: other.trim() ? [] : pick.selected, other }
}

function answered(q: AskQuestion, p: QuestionPick | undefined): boolean {
  if (!p) return false
  const n = p.selected.length + (p.other.trim() ? 1 : 0)
  return q.multi_select ? n >= 1 : n === 1
}

/** Every question has an answer the server will accept. */
export function questionsComplete(qs: readonly AskQuestion[], picks: readonly (QuestionPick | undefined)[]): boolean {
  return qs.length > 0 && qs.every((q, i) => answered(q, picks[i]))
}

/** The `answers` body, keyed by 0-based index (two questions may share a text). */
export function questionAnswer(qs: readonly AskQuestion[], picks: readonly (QuestionPick | undefined)[]): AskAnswer {
  const answers: Record<string, QuestionAnswerValue> = {}
  qs.forEach((q, i) => {
    const p = picks[i] ?? EMPTY_PICK
    const other = p.other.trim()
    answers[String(i)] = other
      ? { selected: p.selected, other }
      : q.multi_select
        ? p.selected
        : (p.selected[0] ?? '')
  })
  return { answers }
}

/** A question card can answer on the FIRST tap: one single-select question,
 *  so a pill is the whole answer and a Submit button would be ceremony. */
export function answersOnTap(qs: readonly AskQuestion[]): boolean {
  return qs.length === 1 && !qs[0].multi_select
}

/* ── the composer ────────────────────────────────────────────────────────── */

/**
 * What a message typed in the composer MEANS while an answerable ask is open,
 * or `null` when it cannot be an answer (the composer then refuses as before).
 *
 *   · a question with ONE question → its "Type something" answer — the free-text
 *     row the terminal dialog offers, which a paste could never reach;
 *   · a permission → "No, and tell Claude what to do instead": a deny carrying
 *     the message, the turn continues;
 *   · several questions or a form → `null`; a sentence cannot fill those.
 */
export function composerReply(ask: Ask | null, questions: readonly AskQuestion[], text: string): AskAnswer | null {
  const t = text.trim()
  if (!ask || !t) return null
  if (ask.kind === 'question' && questions.length === 1) return { answers: { '0': { selected: [], other: t } } }
  if (ask.kind === 'permission') return { decision: 'deny', message: t }
  return null
}

/* ── delivery ────────────────────────────────────────────────────────────── */

/** The line a card leaves behind once its answer was delivered. */
export function deliveredLine(ask: Ask, answer: AskAnswer): string {
  if ('decision' in answer) {
    if (answer.decision === 'allow') return permissionTool(ask) === 'ExitPlanMode' ? 'Plan approved.' : 'Allowed.'
    return answer.message && !answer.interrupt ? 'Declined — Claude has your note.' : 'Declined.'
  }
  if ('answers' in answer) return 'Answered.'
  if ('action' in answer) return answer.action === 'accept' ? 'Form sent.' : 'Form declined.'
  return 'Sent.'
}

/** A server refusal, in the card's voice. The server prefixes its 409s with a
 *  stable code; anything else keeps the server's own sentence. */
export function answerFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (msg.startsWith('ask_not_open')) return 'Already answered — in the terminal or on another device.'
  if (msg.startsWith('ask_not_answerable')) return 'Chat can’t deliver this one any more — answer it in the terminal.'
  return msg || 'That answer didn’t reach the session.'
}

/* ── which card ──────────────────────────────────────────────────────────── */

/** A form ask's own detail, when it carries a drawable form. */
export function formOf(ask: Ask, fallback?: ElicitationAsk | null): ElicitationAsk | null {
  const d = ask.detail as Partial<ElicitationAsk>
  if (typeof d.server === 'string' && Array.isArray(d.fields)) return d as ElicitationAsk
  return fallback ?? null
}

/** Can this ask be drawn as a native card at all? A question ask without
 *  parseable questions, or a form without a form, falls back to the older
 *  paths rather than drawing an empty card. */
export function drawable(view: { ask: Ask; questions: readonly AskQuestion[] } | null | undefined, form?: ElicitationAsk | null): boolean {
  if (!view) return false
  if (view.ask.kind === 'question') return view.questions.length > 0
  if (view.ask.kind === 'elicitation') return formOf(view.ask, form) != null
  return view.ask.kind === 'permission'
}
