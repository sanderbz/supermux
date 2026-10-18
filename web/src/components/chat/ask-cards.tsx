/**
 * The ANSWERABLE cards — a permission, an AskUserQuestion, an MCP form —
 * answered through the asks API (docs/ASKS.md) instead of keys pressed into
 * the terminal.
 * ─────────────────────────────────────────────────────────────────────────────
 * Same chrome as every other dialog on this surface (`DialogShell` /
 * `ChoiceCard`), so the only thing a user notices is that the buttons work:
 * every option, on every Claude Code build, multi-select and several questions
 * included, and Claude's own "Yes, and always allow …" offers by their real
 * names. The answer is Claude Code's own hook output, so the terminal dialog
 * closes exactly as if it had been answered there.
 *
 * Presentational: the panel owns the POST (`use-ask-answer.ts`); the labels and
 * the bodies are `ask-answer.ts`. No `@/` runtime imports (see `live-layer.tsx`).
 */
import * as React from 'react'

import type { Ask, AskAnswer, AskPermissionDetail, AskQuestion } from '../../lib/api/asks'
import type { SessionMode } from '../../lib/api/sessions'
import { modeChipLabel } from '../focus-mode/mode-labels'

import {
  answersOnTap,
  EMPTY_PICK,
  formOf,
  permissionChoices,
  permissionView,
  questionAnswer,
  questionsComplete,
  setOther,
  togglePick,
  type QuestionPick,
} from './ask-answer'
import type { ElicitationAsk } from './elicitation'
import { CardCode, ChoiceCard, ChoicePills, DialogShell, FormCard, InlineCode, type ChoiceOption } from './ui'

interface AnswerProps {
  busy?: boolean
  /** Why the last answer did not land. */
  error?: string | null
  /** Further asks queued behind this one. */
  queued?: number
  onAnswer?: (body: AskAnswer) => void
}

/** Claude Code's mode names → the app's, for the why line. Unknown → dropped. */
const CC_MODES: Record<string, SessionMode> = {
  default: 'normal',
  acceptEdits: 'accept_edits',
  plan: 'plan',
  bypassPermissions: 'bypass',
}

function shortDir(dir: string): string {
  const parts = dir.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || dir
}

/** The line under a card: what is happening, what went wrong, what else waits. */
function Footnote({ busy, error, queued, hint }: { busy?: boolean; error?: string | null; queued?: number; hint?: string }) {
  const text = busy
    ? 'Sending your answer…'
    : (error ?? [queued ? `${queued} more waiting after this one.` : '', hint ?? ''].filter(Boolean).join(' '))
  if (!text) return null
  return (
    <p
      role={error ? 'alert' : undefined}
      data-testid="chat-ask-note"
      className="ml-11 mt-[7px] text-[12.6px] tracking-[-0.05px] text-ink-2"
    >
      {text}
    </p>
  )
}

/* ── permission ──────────────────────────────────────────────────────────── */

export function AskPermissionCard({ ask, dir, busy, error, queued, onAnswer }: AnswerProps & { ask: Ask; dir?: string }) {
  const view = permissionView(ask)
  const choices = permissionChoices(ask)
  const d = ask.detail as AskPermissionDetail
  const mode = d.mode ? CC_MODES[d.mode] : undefined
  const why = [
    view.verb === 'Use' && d.tool && view.chip !== d.tool ? d.tool : '',
    dir ? `in ${shortDir(dir)}` : '',
    mode ? `${modeChipLabel(mode).toLowerCase()} mode` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const options: ChoiceOption[] = choices.map((c) => ({ label: c.label, primary: c.primary, disabled: busy }))
  return (
    <div data-testid="chat-ask-permission" data-ask={ask.id}>
      <ChoiceCard
        eyebrow={d.agent_type ? `Subagent · ${d.agent_type}` : undefined}
        question={
          view.plan ? (
            'Claude has a plan. Ready to go ahead?'
          ) : (
            <>
              {view.verb} <InlineCode>{view.chip}</InlineCode>?
            </>
          )
        }
        detail={view.evidence ? <CardCode wrap={view.evidence.prose}>{view.evidence.text}</CardCode> : undefined}
        why={why || undefined}
        options={options}
        onChoose={onAnswer && !busy ? (i) => onAnswer(choices[i].answer) : undefined}
      />
      <Footnote
        busy={busy}
        error={error}
        queued={queued}
        hint={view.plan ? 'Or type below to tell Claude what to change.' : 'Or type below to tell Claude what to do instead.'}
      />
    </div>
  )
}

/* ── question ────────────────────────────────────────────────────────────── */

const OTHER_CLASS =
  'mt-[9px] h-[32px] w-full rounded-[9px] border-[0.5px] border-hairline bg-fill-soft px-[10px] text-[13.2px] text-ink outline-none placeholder:text-ink-3 focus-visible:border-[color-mix(in_oklab,var(--sm-accent)_55%,transparent)]'

export function AskQuestionCard({
  ask,
  questions,
  busy,
  error,
  queued,
  onAnswer,
}: AnswerProps & { ask: Ask; questions: readonly AskQuestion[] }) {
  const [picks, setPicks] = React.useState<QuestionPick[]>(() => questions.map(() => EMPTY_PICK))
  const tap = answersOnTap(questions)
  const complete = questionsComplete(questions, picks)
  const inert = busy || !onAnswer

  // ONE SINGLE-SELECT QUESTION: a pill is the whole answer — the old card's
  // grammar, now for every build and with nothing pressed into the terminal.
  if (tap) {
    const q = questions[0]
    return (
      <div data-testid="chat-question-card" data-ask={ask.id} data-vr="qq-card">
        <ChoiceCard
          eyebrow={q.header}
          question={q.question || 'Claude is asking you to choose.'}
          detail={<Meanings q={q} />}
          options={q.options.map((o, i) => ({ label: o.label, primary: i === 0, kbd: String(i + 1), disabled: inert }))}
          onChoose={!inert ? (i) => onAnswer?.(questionAnswer(questions, [{ selected: [q.options[i].label], other: '' }])) : undefined}
        />
        <Footnote busy={busy} error={error} queued={queued} hint="Or type your own answer below." />
      </div>
    )
  }

  const update = (i: number, next: QuestionPick) => setPicks((prev) => prev.map((p, j) => (j === i ? next : p)))
  const single = questions.length === 1
  return (
    <div data-testid="chat-question-card" data-ask={ask.id} data-vr="qq-card" data-multi="true">
      <DialogShell
        eyebrow={single ? questions[0].header : undefined}
        question={single ? questions[0].question : `Claude has ${questions.length} questions for you.`}
      >
        {questions.map((q, i) => (
          <QuestionBlock
            key={`${i}:${q.question}`}
            q={q}
            pick={picks[i] ?? EMPTY_PICK}
            titled={!single}
            disabled={inert}
            onChange={(next) => update(i, next)}
          />
        ))}
        <div className="mt-[13px] flex flex-wrap items-center gap-2">
          <ChoiceCardSubmit
            disabled={inert || !complete}
            onClick={() => onAnswer?.(questionAnswer(questions, picks))}
          />
          {!complete && !busy && (
            <span className="text-[12.6px] text-ink-3">
              {single ? 'Pick at least one.' : 'Answer each question to send.'}
            </span>
          )}
        </div>
      </DialogShell>
      <Footnote busy={busy} error={error} queued={queued} />
    </div>
  )
}

function QuestionBlock({
  q,
  pick,
  titled,
  disabled,
  onChange,
}: {
  q: AskQuestion
  pick: QuestionPick
  titled: boolean
  disabled?: boolean
  onChange: (next: QuestionPick) => void
}) {
  const options: ChoiceOption[] = q.options.map((o) => ({
    label: o.label,
    pressed: pick.selected.includes(o.label),
    disabled,
  }))
  return (
    <div data-testid="chat-question-block" className={titled ? 'mt-[13px]' : undefined}>
      {titled && (
        <div className="text-[13.4px] font-medium leading-[1.4] text-ink">
          {q.header && <span className="mr-1.5 text-[11.5px] uppercase tracking-[0.5px] text-ink-3">{q.header}</span>}
          {q.question}
        </div>
      )}
      <Meanings q={q} />
      <div className="mt-[9px] flex flex-wrap gap-2" role="group" aria-label={q.question}>
        <ChoicePills options={options} onChoose={(i) => onChange(togglePick(q, pick, q.options[i].label))} />
      </div>
      <input
        type="text"
        aria-label={`Another answer to: ${q.question}`}
        placeholder={q.multi_select ? 'Something else (optional)' : 'Or type an answer'}
        value={pick.other}
        disabled={disabled}
        onChange={(e) => onChange(setOther(q, pick, e.target.value))}
        className={OTHER_CLASS}
      />
    </div>
  )
}

/** Each option's description, as prose under the question — the model writes
 *  one under every label and the terminal prints it. */
function Meanings({ q }: { q: AskQuestion }) {
  // A description that only repeats its label says nothing (models do write
  // `Apple — Apple`), so it is not drawn.
  const rows = q.options.filter((o) => o.description && o.description.trim() !== o.label.trim())
  if (!rows.length) return null
  return (
    <dl className="mt-[9px] space-y-[3px]">
      {rows.map((o) => (
        <div key={o.label} className="text-[13.2px] leading-[1.45]">
          <dt className="inline font-medium text-ink-2">{o.label}</dt>
          <dd className="inline text-ink-3"> — {o.description}</dd>
        </div>
      ))}
    </dl>
  )
}

function ChoiceCardSubmit({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="chat-question-submit"
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className={[
        'inline-flex h-[34px] items-center rounded-full border-[0.5px] border-hairline bg-fill-soft-2 px-[15px]',
        'text-[13.4px] font-semibold tracking-[-0.05px] text-ink sm-t-morph',
        disabled ? 'cursor-default opacity-45' : '',
      ].join(' ')}
    >
      Send answer
    </button>
  )
}

/* ── form ────────────────────────────────────────────────────────────────── */

export function AskFormCard({ ask, form, busy, error, queued, onAnswer }: AnswerProps & { ask: Ask; form: ElicitationAsk }) {
  return (
    <div data-ask={ask.id}>
      <FormCard
        key={ask.id}
        ask={form}
        onSubmit={onAnswer && !busy ? (a) => onAnswer(a as AskAnswer) : undefined}
      />
      <Footnote busy={busy} error={error} queued={queued} />
    </div>
  )
}

/* ── the dispatcher ──────────────────────────────────────────────────────── */

/** What the live layer hands down for the ask chat answers natively. */
export interface NativeAskView extends AnswerProps {
  ask: Ask
  questions: readonly AskQuestion[]
}

export function AskCard({ view, dir, form }: { view: NativeAskView; dir?: string; form?: ElicitationAsk | null }) {
  const { ask, questions, ...answer } = view
  if (ask.kind === 'question') {
    // Keyed by ask: a second question must not open with the first one's picks.
    return <AskQuestionCard key={ask.id} ask={ask} questions={questions} {...answer} />
  }
  if (ask.kind === 'elicitation') {
    const f = formOf(ask, form)
    return f ? <AskFormCard key={ask.id} ask={ask} form={f} {...answer} /> : null
  }
  return <AskPermissionCard key={ask.id} ask={ask} dir={dir} {...answer} />
}
