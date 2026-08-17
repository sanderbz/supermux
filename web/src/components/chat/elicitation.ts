/**
 * **An MCP server is asking for a typed form** — the arithmetic.
 * ─────────────────────────────────────────────────────────────────────────────
 * Twin of `server/src/sessions/elicitation.rs`, and pure for the same reason
 * `dialog-answer.ts` is: every rule below is asserted in `bun test` with no DOM
 * and no server, against the SAME corpus the Rust half reads
 * (`server/tests/fixtures/hooks/elicitation.jsonl`).
 *
 * The server parses one `Elicitation` hook payload into the typed
 * [`ElicitationAsk`] this file consumes; nothing here re-derives the schema.
 * What it does own is the half a browser must own: what a value is worth WHILE
 * somebody types it, and what the answer looks like on the way out.
 *
 * **The text is not ours.** `message`, every `title`, every enum `label` is
 * written by whoever wrote the MCP server. It is rendered verbatim, attributed
 * to the server by name, as plain text — never markdown, never a link, never in
 * this app's own voice. `form-card.tsx` is where that is enforced visually;
 * this file's contribution is that nothing here interprets any of it.
 */

/* ── the wire shape (server `sessions::elicitation`) ───────────────────────── */

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'unsupported'

export interface ElicitationChoice {
  value: string
  label: string
}

export interface ElicitationField {
  name: string
  title: string
  kind: FieldKind
  required: boolean
  format?: 'email' | 'uri' | 'date' | 'date-time' | string
  description?: string
  options?: ElicitationChoice[]
  minimum?: number
  maximum?: number
  min_length?: number
  max_length?: number
  default?: string | number | boolean
}

export interface ElicitationAsk {
  /** The MCP server's name. THE attribution — the card refuses to draw without
   *  it, and the server refuses to send one without it. */
  server: string
  /** The server's own sentence. Third-party text. */
  message: string
  fields: ElicitationField[]
  id?: string
  /** Properties the server dropped at its cap — counted, so the card can say
   *  the form on screen is shorter than the one that was asked. */
  dropped_fields?: number
}

/** What an answer to an elicitation IS, per MCP + Claude Code's own
 *  `hookSpecificOutput` (`accept` | `decline` | `cancel`). */
export type ElicitationAction = 'accept' | 'decline' | 'cancel'

export interface ElicitationAnswer {
  action: ElicitationAction
  /** Present (possibly empty) on `accept`; ABSENT on decline/cancel — declining
   *  while shipping the half-typed values would hand a third party data the
   *  user just refused to give it. */
  content?: Record<string, FormValue>
}

/** What a control can hold before it becomes JSON. `''` is the empty text box,
 *  which is not the same as the string `'0'` and not the same as absent. */
export type FormValue = string | number | boolean

/* ── validation ───────────────────────────────────────────────────────────── */

export interface ElicitationProblem {
  field: string
  message: string
}

/**
 * One field's complaint, or `undefined`.
 *
 * The sentences are Claude Code's own (2.1.227 bundle strings) so a user
 * looking at the terminal and a user looking at this card are told the same
 * thing — with two documented exceptions, both marked below.
 */
export function validateField(field: ElicitationField, value: FormValue | undefined): string | undefined {
  // A property neither renderer can type is shown read-only and never enforced:
  // refusing an answer over a control the user was never given is a dead end.
  if (field.kind === 'unsupported') return undefined
  if (isBlank(value)) return field.required ? 'This field is required' : undefined
  switch (field.kind) {
    case 'enum': {
      const options = field.options ?? []
      if (options.some((o) => o.value === value)) return undefined
      // Claude Code renders an enum as a SELECTOR and so has no message for
      // this — the state is unreachable there. Ours, and it names the remedy.
      return 'Select one of the offered options'
    }
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'Must be true or false'
    case 'number':
    case 'integer': {
      const noun = field.kind === 'integer' ? 'an integer' : 'a number'
      const n = typeof value === 'number' ? value : Number(String(value).trim())
      if (!Number.isFinite(n)) return `Must be ${noun}`
      if (field.kind === 'integer' && !Number.isInteger(n)) return `Must be ${noun}`
      const { minimum: min, maximum: max } = field
      if (min !== undefined && max !== undefined && (n < min || n > max)) {
        return `Must be ${noun} between ${num(min)} and ${num(max)}`
      }
      if (min !== undefined && max === undefined && n < min) return `Must be at least ${num(min)}`
      if (max !== undefined && min === undefined && n > max) return `Must be at most ${num(max)}`
      return undefined
    }
    case 'string': {
      const s = String(value)
      const chars = [...s].length
      if (field.min_length !== undefined && chars < field.min_length) {
        return `Must be at least ${field.min_length} ${plural(field.min_length, 'character')}`
      }
      if (field.max_length !== undefined && chars > field.max_length) {
        return `Must be at most ${field.max_length} ${plural(field.max_length, 'character')}`
      }
      switch (field.format) {
        case 'email':
          return isEmail(s) ? undefined : 'Must be a valid email address, e.g. user@example.com'
        case 'uri':
          return isUri(s) ? undefined : 'Must be a valid URI, e.g. https://example.com'
        // Claude Code parses natural language here by asking Haiku ("tomorrow",
        // "next Monday"); this app has no model in the path and must not
        // pretend to — so ISO 8601 is what it takes, and the sentence is Claude
        // Code's own fallback for exactly that case.
        case 'date':
          return isIsoDate(s)
            ? undefined
            : 'Unable to parse date/time. Please enter in ISO 8601 format manually'
        case 'date-time':
          return isIsoDateTime(s)
            ? undefined
            : 'Unable to parse date/time. Please enter in ISO 8601 format manually'
        default:
          return undefined
      }
    }
    default:
      return undefined
  }
}

/** Every complaint, in field order — the list the submit button reads. */
export function validateAll(
  fields: readonly ElicitationField[],
  values: Readonly<Record<string, FormValue | undefined>>,
): ElicitationProblem[] {
  const out: ElicitationProblem[] = []
  for (const field of fields) {
    const message = validateField(field, values[field.name])
    if (message) out.push({ field: field.name, message })
  }
  return out
}

/**
 * The values a form starts with: the schema's `default` where there is one, an
 * empty control where there is not.
 *
 * A boolean with no default starts `false` rather than absent, because a
 * checkbox has no third state — and `false` is an ANSWER, which is why
 * `isBlank` refuses to treat it as a blank.
 */
export function initialValues(fields: readonly ElicitationField[]): Record<string, FormValue> {
  const out: Record<string, FormValue> = {}
  for (const f of fields) {
    if (f.default !== undefined) out[f.name] = f.default
    else if (f.kind === 'boolean') out[f.name] = false
    else out[f.name] = ''
  }
  return out
}

/**
 * The answer, exactly as the MCP elicitation result is shaped:
 * `{action, content}` — the same object Claude Code's own
 * `hookSpecificOutput` carries.
 *
 * On `accept` the content is COERCED to the schema's types (a number field
 * holds a string while it is being typed) and blank optional fields are
 * omitted, because an omitted optional property and a property present as `""`
 * are different answers to a third-party server.
 *
 * On `decline` / `cancel` there is no content at all. Declining is a refusal to
 * give the values; shipping them anyway would make the refusal a lie.
 */
export function buildAnswer(
  action: ElicitationAction,
  fields: readonly ElicitationField[],
  values: Readonly<Record<string, FormValue | undefined>>,
): ElicitationAnswer {
  if (action !== 'accept') return { action }
  const content: Record<string, FormValue> = {}
  for (const f of fields) {
    if (f.kind === 'unsupported') continue
    const v = values[f.name]
    if (isBlank(v)) continue
    if (f.kind === 'number' || f.kind === 'integer') {
      const n = typeof v === 'number' ? v : Number(String(v).trim())
      if (Number.isFinite(n)) content[f.name] = n
      continue
    }
    if (f.kind === 'boolean') {
      content[f.name] = v === true
      continue
    }
    content[f.name] = typeof v === 'boolean' ? v : String(v)
  }
  return { action, content }
}

/* ── the small print ──────────────────────────────────────────────────────── */

/** Absent, or an empty/whitespace-only string. `false` and `0` are ANSWERS —
 *  the bug that would make "no" and "none" unsayable. */
function isBlank(value: FormValue | undefined | null): boolean {
  if (value === undefined || value === null) return true
  return typeof value === 'string' && value.trim() === ''
}

/** `3` for a whole number, `2.5` otherwise — the bound came from JSON and the
 *  terminal prints it the same way. */
function num(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n)
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}

/** Deliberately not RFC 5322: one `@`, something either side, a dot in the
 *  domain, no whitespace. The server is the real judge of its own field. */
function isEmail(s: string): boolean {
  const t = s.trim()
  if (/\s/.test(t)) return false
  const parts = t.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  return local !== '' && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')
}

function isUri(s: string): boolean {
  const t = s.trim()
  if (/\s/.test(t)) return false
  const scheme = t.indexOf(':')
  return scheme > 0 && t.length > scheme + 1
}

/** `YYYY-MM-DD` — the prefix Claude Code's own `^\d{4}-\d{2}-\d{2}(T|$)` takes. */
function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim())
}

function isIsoDateTime(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s.trim())
}
