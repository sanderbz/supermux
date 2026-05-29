// Scheduler shared helpers: formatting + preset recipes + expression
// helper patterns. Pure functions only, no React — so both the route and the
// dialog/sheet import without circular deps.

import type { ScheduleKind } from '@/lib/api'

/** Relative + absolute formatting for a next/last-run timestamp (RFC3339). */
export function formatRunTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const now = Date.now()
  const diff = d.getTime() - now
  const abs = Math.abs(diff)
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour

  let rel: string
  if (abs < min) {
    rel = diff >= 0 ? 'in <1m' : 'just now'
  } else if (abs < hour) {
    const m = Math.round(abs / min)
    rel = diff >= 0 ? `in ${m}m` : `${m}m ago`
  } else if (abs < day) {
    const h = Math.round(abs / hour)
    rel = diff >= 0 ? `in ${h}h` : `${h}h ago`
  } else if (abs < 7 * day) {
    const dd = Math.round(abs / day)
    rel = diff >= 0 ? `in ${dd}d` : `${dd}d ago`
  } else {
    rel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return rel
}

/** Full local datetime for tooltips + the preview list. */
export function formatFull(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Time-ago for a `schedule_runs.ran_at` epoch-seconds value. */
export function formatRanAt(epochSeconds: number): string {
  return formatRunTime(new Date(epochSeconds * 1000).toISOString())
}

/** Human label for a job kind. Sentence case (never UPPERCASE). */
export const KIND_LABEL: Record<ScheduleKind, string> = {
  boot: 'Boot session',
  tmux: 'Prompt session',
  shell: 'Shell job',
}

export const PROVIDERS = ['claude'] as const

// ── recurrence composer + English humanizer (frontend-only; the server parser
// already accepts every grammar form below — see scheduler/parser.rs) ──────────

/** Quick-pick frequencies the composer chips serialize to. `custom` is the
 *  raw escape hatch (free-text natural language or cron). */
export type Frequency =
  | 'once'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly'
  | 'interval'
  | 'custom'

/** Sentence-case label for each quick-pick chip. */
export const FREQUENCY_LABEL: Record<Frequency, string> = {
  once: 'Once',
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly',
  monthly: 'Monthly',
  interval: 'Interval',
  custom: 'Custom',
}

/** The quick-pick chips, in display order (Custom last — it's the escape hatch). */
export const FREQUENCY_CHIPS: Frequency[] = [
  'once',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'interval',
  'custom',
]

/** Day-of-week tokens the parser accepts (`weekly on <day>` / `every <day>`). */
export const WEEKDAYS = [
  { value: 'mon', label: 'Mon', full: 'Monday' },
  { value: 'tue', label: 'Tue', full: 'Tuesday' },
  { value: 'wed', label: 'Wed', full: 'Wednesday' },
  { value: 'thu', label: 'Thu', full: 'Thursday' },
  { value: 'fri', label: 'Fri', full: 'Friday' },
  { value: 'sat', label: 'Sat', full: 'Saturday' },
  { value: 'sun', label: 'Sun', full: 'Sunday' },
] as const

// Map every day token the server parser accepts (abbrev + full + variants, see
// parser.rs::day_to_std) to its full English name, so the humanizer recognizes
// both `weekly on mon` and `every monday`.
const DAY_FULL: Record<string, string> = {
  sun: 'Sunday',
  sunday: 'Sunday',
  mon: 'Monday',
  monday: 'Monday',
  tue: 'Tuesday',
  tues: 'Tuesday',
  tuesday: 'Tuesday',
  wed: 'Wednesday',
  wednesday: 'Wednesday',
  thu: 'Thursday',
  thurs: 'Thursday',
  thursday: 'Thursday',
  fri: 'Friday',
  friday: 'Friday',
  sat: 'Saturday',
  saturday: 'Saturday',
}

// Map a day token to the short token the composer's day-picker uses.
const DAY_TO_SHORT: Record<string, string> = {
  sun: 'sun',
  sunday: 'sun',
  mon: 'mon',
  monday: 'mon',
  tue: 'tue',
  tues: 'tue',
  tuesday: 'tue',
  wed: 'wed',
  wednesday: 'wed',
  thu: 'thu',
  thurs: 'thu',
  thursday: 'thu',
  fri: 'fri',
  friday: 'fri',
  sat: 'sat',
  saturday: 'sat',
}

const ORDINAL = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}

/** Pretty-print an HH:MM 24h time as e.g. "09:00". Used in the English render. */
function prettyTime(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Parse the grammar's clock forms (`9am`, `6pm`, `9:30pm`, `14:30`) → [h, m].
 *  Mirrors server `parse_time`. Returns null when unparseable. */
function readTime(raw: string): [number, number] | null {
  const t = raw.trim().toLowerCase()
  let ampm: 'am' | 'pm' | null = null
  let body = t
  if (t.endsWith('am')) {
    ampm = 'am'
    body = t.slice(0, -2).trim()
  } else if (t.endsWith('pm')) {
    ampm = 'pm'
    body = t.slice(0, -2).trim()
  }
  const [hStr, mStr] = body.includes(':') ? body.split(':') : [body, '0']
  let h = Number(hStr)
  const m = Number(mStr)
  if (!Number.isInteger(h) || !Number.isInteger(m) || m > 59) return null
  if (ampm === 'pm') h = h === 12 ? 12 : h < 12 ? h + 12 : NaN
  if (ampm === 'am') h = h === 12 ? 0 : h < 12 ? h : NaN
  if (!Number.isInteger(h) || h > 23 || h < 0) return null
  return [h, m]
}

const RE_IN = /^in\s+(\d+)\s*([a-z]+)$/
const RE_EVERY_N = /^every\s+(\d+)\s*([a-z]+)$/
const RE_EVERY_ALIAS = /^every\s+(morning|evening|night)$/
const RE_WEEKDAY = /^every\s+weekday\s+at\s+(.+)$/
const RE_DAILY = /^daily\s+at\s+(.+)$/
const RE_WEEKLY = /^weekly\s+on\s+([a-z]+)\s+at\s+(.+)$/
const RE_MONTHLY = /^monthly\s+on\s+(\d+)\s+at\s+(.+)$/
const RE_EVERY_DAY = /^every\s+([a-z]+)\s+at\s+(.+)$/

const UNIT_WORD: Record<string, string> = {
  s: 'second',
  sec: 'second',
  secs: 'second',
  second: 'second',
  seconds: 'second',
  m: 'minute',
  min: 'minute',
  mins: 'minute',
  minute: 'minute',
  minutes: 'minute',
  h: 'hour',
  hr: 'hour',
  hrs: 'hour',
  hour: 'hour',
  hours: 'hour',
  d: 'day',
  day: 'day',
  days: 'day',
}

/**
 * Humanize a schedule expression to a friendly English sentence —
 * "Every Monday at 09:00", "Every weekday at 09:00", "Daily at 18:00", etc.
 * Mirrors the grammar the server parser recognizes (scheduler/parser.rs); for a
 * raw 5-field cron we return "Custom schedule" rather than pulling in a heavy
 * cron-humanizer dependency. Falls back to the raw text when nothing matches.
 */
export function describeSchedule(expr: string | null | undefined): string {
  const e = (expr ?? '').trim().toLowerCase()
  if (!e) return '—'

  let c = RE_IN.exec(e)
  if (c) {
    const n = Number(c[1])
    const unit = UNIT_WORD[c[2]] ?? c[2]
    return `Once, in ${n} ${unit}${n === 1 ? '' : 's'}`
  }

  c = RE_EVERY_N.exec(e)
  if (c) {
    const n = Number(c[1])
    const unit = UNIT_WORD[c[2]] ?? c[2]
    return n === 1
      ? `Every ${unit}`
      : `Every ${n} ${unit}${n === 1 ? '' : 's'}`
  }

  c = RE_EVERY_ALIAS.exec(e)
  if (c) {
    const t = c[1] === 'morning' ? '09:00' : '18:00'
    const word = c[1].charAt(0).toUpperCase() + c[1].slice(1)
    return `Every ${word.toLowerCase()} at ${t}`
  }

  c = RE_WEEKDAY.exec(e)
  if (c) {
    const tm = readTime(c[1])
    return tm ? `Every weekday at ${prettyTime(tm[0], tm[1])}` : 'Every weekday'
  }

  c = RE_DAILY.exec(e)
  if (c) {
    const tm = readTime(c[1])
    return tm ? `Daily at ${prettyTime(tm[0], tm[1])}` : 'Daily'
  }

  c = RE_WEEKLY.exec(e)
  if (c) {
    const day = DAY_FULL[c[1]] ?? c[1]
    const tm = readTime(c[2])
    return tm ? `Every ${day} at ${prettyTime(tm[0], tm[1])}` : `Every ${day}`
  }

  c = RE_MONTHLY.exec(e)
  if (c) {
    const dom = Number(c[1])
    const tm = readTime(c[2])
    return tm
      ? `Monthly on the ${ORDINAL(dom)} at ${prettyTime(tm[0], tm[1])}`
      : `Monthly on the ${ORDINAL(dom)}`
  }

  c = RE_EVERY_DAY.exec(e)
  if (c && DAY_FULL[c[1]]) {
    const day = DAY_FULL[c[1]]
    const tm = readTime(c[2])
    return tm ? `Every ${day} at ${prettyTime(tm[0], tm[1])}` : `Every ${day}`
  }

  if (e.split(/\s+/).length === 5) return 'Custom schedule'

  return expr!.trim()
}

/** The composer's structured selection — serializes to a `schedule_expr`. */
export interface RecurrenceDraft {
  frequency: Frequency
  day: string // weekday token for `weekly`
  time: string // HH:MM (24h) for daily/weekdays/weekly/monthly
  dom: number // day-of-month (1–28) for `monthly`
  intervalN: number // count for `interval`
  intervalUnit: string // m/h/d for `interval`
}

export const EMPTY_RECURRENCE: RecurrenceDraft = {
  frequency: 'daily',
  day: 'mon',
  time: '09:00',
  dom: 1,
  intervalN: 30,
  intervalUnit: 'm',
}

/** Render a 24h "HH:MM" string into the parser's `H:MM` time (drops the pad so
 *  the round-trip is clean — both forms parse identically server-side). */
function exprTime(hhmm: string): string {
  const tm = readTime(hhmm)
  if (!tm) return hhmm
  return `${tm[0]}:${String(tm[1]).padStart(2, '0')}`
}

/** Serialize a structured composer selection into a `schedule_expr` the server
 *  parser accepts verbatim. `custom` returns null (caller keeps the free-text). */
export function recurrenceToExpr(r: RecurrenceDraft): string | null {
  switch (r.frequency) {
    case 'once':
      return null // one-shot is composed by the datetime picker → "in <N>m"
    case 'daily':
      return `daily at ${exprTime(r.time)}`
    case 'weekdays':
      return `every weekday at ${exprTime(r.time)}`
    case 'weekly':
      return `weekly on ${r.day} at ${exprTime(r.time)}`
    case 'monthly':
      return `monthly on ${r.dom} at ${exprTime(r.time)}`
    case 'interval':
      return `every ${r.intervalN}${r.intervalUnit}`
    case 'custom':
      return null
  }
}

/** Best-effort: read an existing `schedule_expr` back into a composer draft so
 *  editing an existing schedule lands on the matching chip (else `custom`). */
export function exprToRecurrence(expr: string | null | undefined): RecurrenceDraft {
  const e = (expr ?? '').trim().toLowerCase()
  if (!e) return { ...EMPTY_RECURRENCE }

  let c = RE_DAILY.exec(e)
  if (c) {
    const tm = readTime(c[1])
    if (tm) return { ...EMPTY_RECURRENCE, frequency: 'daily', time: prettyTime(tm[0], tm[1]) }
  }
  c = RE_WEEKDAY.exec(e)
  if (c) {
    const tm = readTime(c[1])
    if (tm) return { ...EMPTY_RECURRENCE, frequency: 'weekdays', time: prettyTime(tm[0], tm[1]) }
  }
  c = RE_WEEKLY.exec(e)
  if (c && DAY_TO_SHORT[c[1]]) {
    const tm = readTime(c[2])
    if (tm)
      return {
        ...EMPTY_RECURRENCE,
        frequency: 'weekly',
        day: DAY_TO_SHORT[c[1]],
        time: prettyTime(tm[0], tm[1]),
      }
  }
  c = RE_EVERY_DAY.exec(e)
  if (c && DAY_TO_SHORT[c[1]]) {
    const tm = readTime(c[2])
    if (tm)
      return {
        ...EMPTY_RECURRENCE,
        frequency: 'weekly',
        day: DAY_TO_SHORT[c[1]],
        time: prettyTime(tm[0], tm[1]),
      }
  }
  c = RE_MONTHLY.exec(e)
  if (c) {
    const tm = readTime(c[2])
    if (tm)
      return {
        ...EMPTY_RECURRENCE,
        frequency: 'monthly',
        dom: Number(c[1]),
        time: prettyTime(tm[0], tm[1]),
      }
  }
  c = RE_EVERY_N.exec(e)
  if (c) {
    return {
      ...EMPTY_RECURRENCE,
      frequency: 'interval',
      intervalN: Number(c[1]),
      intervalUnit: c[2],
    }
  }
  c = RE_IN.exec(e)
  if (c) return { ...EMPTY_RECURRENCE, frequency: 'once' }

  return { ...EMPTY_RECURRENCE, frequency: 'custom' }
}
