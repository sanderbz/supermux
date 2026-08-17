/**
 * The FORM card: what a third-party MCP server is asking for, as controls.
 * ─────────────────────────────────────────────────────────────────────────────
 * An MCP server can stop a tool call and demand structured input
 * (`elicitation/create`). Claude Code draws a real form for it — typed fields,
 * per-field validation, required enforcement, Accept / Decline — and until this
 * card existed a supermux user got none of that: the session simply stopped,
 * green dot, live composer, forever (`mcp.elicitation_form`).
 *
 * It is the same card as the question/permission card and deliberately so: the
 * glass shell, the eyebrow, the ask and the why line all come from
 * `DialogShell` (`choice-card.tsx`), which this file does not re-implement. The
 * only new vocabulary is the controls between them.
 *
 * ## Everything here is written by somebody else
 *
 * `ask.message`, every field `title`, every enum `label` is authored by whoever
 * wrote the MCP server. Three rules follow, and they are the reason this card
 * looks the way it does:
 *
 *   1. **Attribution before content.** The eyebrow names the server, and the
 *      server's sentence sits under a quote rule with `MCP server "<name>"`
 *      beside it. No sentence from a third party is ever drawn in this app's own
 *      voice, where "supermux needs your API key" would look like supermux
 *      asking.
 *   2. **Plain text only.** Rendered as text nodes — no markdown, no links, no
 *      HTML. A prompt cannot become a clickable anything.
 *   3. **Nothing is pressed for you.** The card is INERT about delivery: it
 *      collects and validates an answer and shows exactly what would be sent,
 *      and it says plainly that the answer has to be given in the terminal. The
 *      write lane (a hook that answers on the user's behalf) is a decider, and
 *      shipping a decider that has never been tested against a live MCP server
 *      is the one thing this feature must not do.
 */
import { useMemo, useState } from 'react'

import {
  buildAnswer,
  initialValues,
  validateAll,
  validateField,
  type ElicitationAction,
  type ElicitationAsk,
  type ElicitationField,
  type FormValue,
} from '../elicitation'
import { cn } from '../../../lib/utils'

import { DialogShell } from './choice-card'

export interface FormCardProps {
  ask: ElicitationAsk
  /**
   * What happens on submit. Given the exact `{action, content}` an MCP
   * elicitation response carries.
   *
   * Absent = the delivery lane is not available on this session, which is the
   * shipped state: the card validates, shows the answer, and says where it has
   * to be given instead.
   */
  onSubmit?: (answer: ReturnType<typeof buildAnswer>) => void
  /** Why the answer cannot be delivered from here, in one sentence. Shown under
   *  the actions and read out with the disabled buttons. */
  inertReason?: string
}

export function FormCard({ ask, onSubmit, inertReason }: FormCardProps) {
  const [values, setValues] = useState<Record<string, FormValue>>(() => initialValues(ask.fields))
  /** Fields the user has left — a form that turns red while you type in it is
   *  a form that shouts at you for not having finished yet. */
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [submitted, setSubmitted] = useState(false)

  const problems = useMemo(() => validateAll(ask.fields, values), [ask.fields, values])
  const complete = problems.length === 0

  const set = (name: string, v: FormValue) => setValues((prev) => ({ ...prev, [name]: v }))

  const answer = (action: ElicitationAction) => {
    if (action === 'accept') {
      setSubmitted(true)
      if (!complete) return
    }
    onSubmit?.(buildAnswer(action, ask.fields, values))
  }

  return (
    <div data-testid="chat-elicitation-card">
      <DialogShell
        // ATTRIBUTION FIRST — the eyebrow slot the question card added for
        // `AskUserQuestion`'s dialog title carries the one fact that decides
        // whether any of this should be answered at all: who is asking.
        eyebrow={<>MCP server · {ask.server}</>}
        question={<>{ask.server} needs your input</>}
        detail={ask.message ? <ServerSays server={ask.server}>{ask.message}</ServerSays> : undefined}
        why={
          ask.dropped_fields
            ? `${ask.fields.length} of ${ask.fields.length + ask.dropped_fields} fields shown`
            : undefined
        }
      >
        {ask.fields.length > 0 && (
          <div className="mt-[11px] flex flex-col gap-[9px]">
            {ask.fields.map((field) => (
              <FormRow
                key={field.name}
                field={field}
                value={values[field.name]}
                onChange={(v) => set(field.name, v)}
                onBlur={() => setTouched((t) => ({ ...t, [field.name]: true }))}
                // The complaint appears once the field has been left, or once
                // Accept has been pressed — whichever comes first.
                problem={
                  touched[field.name] || submitted
                    ? validateField(field, values[field.name])
                    : undefined
                }
              />
            ))}
          </div>
        )}
        <div className="mt-[13px] flex flex-wrap items-center gap-2">
          <FormButton
            label="Accept"
            primary
            // Never silently dead: an incomplete form's Accept is pressable and
            // reveals what is missing, which is the whole point of pressing it.
            disabled={!onSubmit}
            hint={!onSubmit ? inertReason : undefined}
            onClick={() => answer('accept')}
          />
          <FormButton
            label="Decline"
            disabled={!onSubmit}
            hint={!onSubmit ? inertReason : undefined}
            onClick={() => answer('decline')}
          />
          <FormButton
            label="Cancel"
            disabled={!onSubmit}
            hint={!onSubmit ? inertReason : undefined}
            onClick={() => answer('cancel')}
          />
          {submitted && !complete && (
            <span role="status" className="text-[12.6px] text-ink-2">
              {problems.length === 1 ? '1 field needs attention' : `${problems.length} fields need attention`}
            </span>
          )}
        </div>
      </DialogShell>
      {inertReason && (
        <p className="ml-11 mt-[7px] text-[12.6px] tracking-[-0.05px] text-ink-2">{inertReason}</p>
      )}
    </div>
  )
}

/**
 * The server's own sentence, quoted and attributed.
 *
 * A left rule plus the server's name is the cheapest honest frame there is: it
 * reads as a quotation at a glance, on a phone, in both themes — and it makes
 * the sentence structurally somebody else's rather than relying on the reader
 * to remember the eyebrow.
 */
function ServerSays({ server, children }: { server: string; children: string }) {
  return (
    <div className="mt-[9px] border-l-2 border-hairline pl-[11px]">
      <p data-testid="chat-elicitation-message" className="whitespace-pre-wrap text-[13.4px] leading-[1.45] text-ink">
        {children}
      </p>
      <p className="mt-[3px] text-[11.5px] leading-[1.3] text-ink-3">from the MCP server “{server}”</p>
    </div>
  )
}

/** One labelled control + its complaint. */
function FormRow({
  field,
  value,
  onChange,
  onBlur,
  problem,
}: {
  field: ElicitationField
  value: FormValue | undefined
  onChange: (v: FormValue) => void
  onBlur: () => void
  problem?: string
}) {
  const id = `elic-${field.name}`
  const describedBy = problem ? `${id}-err` : field.description ? `${id}-desc` : undefined
  return (
    <div>
      <label htmlFor={id} className="block text-[12.6px] font-medium leading-[1.3] text-ink-2">
        {field.title}
        {field.required && (
          <span aria-hidden className="ml-1 text-ink-3">
            *
          </span>
        )}
        {field.required && <span className="sr-only"> (required)</span>}
      </label>
      {field.description && (
        <p id={`${id}-desc`} className="mt-[2px] text-[11.8px] leading-[1.35] text-ink-3">
          {field.description}
        </p>
      )}
      <Control
        id={id}
        field={field}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        invalid={!!problem}
        describedBy={describedBy}
      />
      {problem && (
        <p id={`${id}-err`} data-testid="chat-elicitation-error" className="mt-[3px] text-[11.8px] leading-[1.35] text-status-error-ink">
          {problem}
        </p>
      )}
    </div>
  )
}

const CONTROL_CLASS =
  'mt-[4px] h-[32px] w-full rounded-[9px] border-[0.5px] border-hairline bg-fill-soft px-[10px] text-[13.2px] text-ink outline-none focus-visible:border-[color-mix(in_oklab,var(--sm-accent)_55%,transparent)]'

function Control({
  id,
  field,
  value,
  onChange,
  onBlur,
  invalid,
  describedBy,
}: {
  id: string
  field: ElicitationField
  value: FormValue | undefined
  onChange: (v: FormValue) => void
  onBlur: () => void
  invalid: boolean
  describedBy?: string
}) {
  const common = {
    id,
    onBlur,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
    'aria-required': field.required || undefined,
  }
  if (field.kind === 'boolean') {
    return (
      <input
        {...common}
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-[6px] h-[16px] w-[16px] accent-[var(--sm-accent)]"
      />
    )
  }
  if (field.kind === 'enum') {
    return (
      <select
        {...common}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        className={cn(CONTROL_CLASS, invalid && 'border-status-error')}
      >
        <option value="">—</option>
        {(field.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  if (field.kind === 'unsupported') {
    // Shown, named, and honestly unanswerable — a form missing one of its
    // fields would lie about what was asked.
    return (
      <p className="mt-[4px] text-[12.4px] italic leading-[1.35] text-ink-3">
        this field’s type isn’t one a form can show
      </p>
    )
  }
  const numeric = field.kind === 'number' || field.kind === 'integer'
  return (
    <input
      {...common}
      type={numeric ? 'number' : field.format === 'date' ? 'date' : 'text'}
      inputMode={numeric ? (field.kind === 'integer' ? 'numeric' : 'decimal') : undefined}
      step={field.kind === 'integer' ? 1 : undefined}
      min={field.minimum}
      max={field.maximum}
      value={value === undefined || typeof value === 'boolean' ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
      className={cn(CONTROL_CLASS, invalid && 'border-status-error')}
    />
  )
}

/** The same pill grammar the choice card uses — weight plus a soft fill for
 *  emphasis, never the identity hue (concept contract C7). */
function FormButton({
  label,
  primary,
  disabled,
  hint,
  onClick,
}: {
  label: string
  primary?: boolean
  disabled?: boolean
  hint?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-[34px] items-center gap-2 rounded-full border-[0.5px] border-hairline px-[15px]',
        'text-[13.4px] tracking-[-0.05px] text-ink sm-t-morph',
        primary ? 'bg-fill-soft-2 font-semibold' : 'bg-transparent font-medium hover:bg-fill-soft',
        disabled && 'cursor-default opacity-45 hover:bg-transparent',
      )}
    >
      {label}
      {/* WHY IT IS INERT, REACHABLE (gap G4): a `title=` is a mouse tooltip on a
          control that is not even a tab stop. As text inside the button it is
          part of the accessible name, so a virtual cursor reads the refusal
          with the option it belongs to. */}
      {hint && <span className="sr-only"> — {hint}</span>}
    </button>
  )
}
