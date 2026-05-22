// Scheduler shared helpers (M21): formatting + preset recipes + expression
// helper patterns. Pure functions only, no React — so both the route and the
// dialog/sheet import without circular deps.

import type { ScheduleCreateInput, ScheduleKind } from '@/lib/api'

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
  boot: 'Boot agent',
  tmux: 'Send command',
  shell: 'Shell job',
}

/** Free-text expression helper patterns (pre-fill chips under the input). */
export const EXPR_HELPERS: { label: string; expr: string }[] = [
  { label: 'every morning', expr: 'every morning' },
  { label: 'every weekday at 9am', expr: 'every weekday at 9am' },
  { label: 'every 5m', expr: 'every 5m' },
  { label: 'in 30m', expr: 'in 30m' },
  { label: 'daily at 6pm', expr: 'daily at 6pm' },
]

/** A preset boot recipe: one tap prefills the whole form. */
export interface PresetRecipe {
  id: string
  label: string
  blurb: string
  fill: Partial<ScheduleCreateInput> & { kind: ScheduleKind }
}

/** The three CEO-amplification preset cards (§10 M21). */
export const PRESETS: PresetRecipe[] = [
  {
    id: 'cso-monday',
    label: '/cso every Monday 9am',
    blurb: 'Boot a security review at the start of the week.',
    fill: {
      kind: 'boot',
      title: 'Weekly /cso review',
      command: '/cso',
      schedule_expr: 'weekly on mon at 9am',
      boot_provider: 'claude',
    },
  },
  {
    id: 'design-friday',
    label: '/design-shotgun Friday 4pm',
    blurb: 'Boot a design explore before the weekend.',
    fill: {
      kind: 'boot',
      title: 'Friday /design-shotgun',
      command: '/design-shotgun',
      schedule_expr: 'weekly on fri at 4pm',
      boot_provider: 'claude',
    },
  },
  {
    id: 'qa-daily',
    label: '/qa daily at 6pm',
    blurb: 'Boot an end-of-day QA pass every evening.',
    fill: {
      kind: 'boot',
      title: 'Daily /qa pass',
      command: '/qa',
      schedule_expr: 'daily at 6pm',
      boot_provider: 'claude',
    },
  },
]

export const PROVIDERS = ['claude', 'codex'] as const
export const DONE_ACTIONS = ['disable', 'notify'] as const
