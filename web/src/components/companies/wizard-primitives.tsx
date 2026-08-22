/**
 * The small, truly-new primitives the onboarding wizard needs — kept tiny and
 * grok-native (every colour is a `--gr-*` / `--sm-*` token, never a raw hex), so
 * they inherit light/dark + reduced-motion for free. Everything else the wizard
 * uses is REUSED (`ResponsiveSheet`, `CompanyMark`, `Button`, `Input`, the store
 * `cs-*` surfaces). Nothing here fetches — they are presentational.
 *
 *   <StatusChip>   idle | working | done | error → the four grok status tones.
 *   <CopyField>    a full-width mono value + a big full-width Copy → "Copied ✓"
 *                  (the mobile-critical affordance — never rely on drag-select).
 *   <SecretInput>  masked password field + show/hide.
 *   <RoleSelect>   owner/admin/member with a one-line explainer.
 *   <WizardStepper> the vertical numbered rail, each step carrying a StatusChip.
 */
import * as React from 'react'
import { Check, Copy, Eye, EyeOff, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'

// ── StatusChip ────────────────────────────────────────────────────────────────

export type ChipState = 'idle' | 'working' | 'done' | 'error'

const CHIP_TONE: Record<ChipState, string> = {
  idle: 'var(--gr-idle)',
  working: 'var(--gr-work)',
  done: 'var(--gr-done)',
  error: 'var(--gr-need)',
}

export function StatusChip({
  state,
  label,
  className,
}: {
  state: ChipState
  label: string
  className?: string
}) {
  const tone = CHIP_TONE[state]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium',
        className,
      )}
      style={{
        color: tone,
        background: `color-mix(in oklab, ${tone} 14%, transparent)`,
      }}
    >
      {state === 'working' ? (
        <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
      ) : state === 'done' ? (
        <Check aria-hidden className="size-3.5" />
      ) : (
        <span aria-hidden className="size-2 rounded-full" style={{ background: tone }} />
      )}
      {label}
    </span>
  )
}

// ── CopyField ─────────────────────────────────────────────────────────────────

/** Copy `value` to the clipboard, flipping a local "Copied ✓" for ~1.6s. Returns
 *  `[copied, copy]` — reused by CopyField and the Success step's Copy-invite. */
export function useCopy(): [boolean, (value: string) => void] {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const copy = React.useCallback((value: string) => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1600)
      },
      () => {},
    )
  }, [])
  return [copied, copy]
}

export function CopyField({
  value,
  label,
  className,
}: {
  value: string
  /** Accessible name for the Copy button (e.g. "Copy redirect URI"). */
  label: string
  className?: string
}) {
  const [copied, copy] = useCopy()
  return (
    <div className={cn('flex flex-col gap-2 sm:flex-row sm:items-stretch', className)}>
      {/* The value — mono, scrolls horizontally inside its own box so a long
          token never pushes the page wide. Selectable as a fallback. */}
      <div
        className="min-w-0 flex-1 overflow-x-auto rounded-lg border px-3 py-2 font-mono text-[13px] leading-tight"
        style={{ borderColor: 'var(--gr-line)', background: 'var(--gr-surf)' }}
      >
        <span className="whitespace-nowrap text-foreground">{value}</span>
      </div>
      <button
        type="button"
        onClick={() => copy(value)}
        aria-label={label}
        className={cn(
          'inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 text-[13px]',
          'font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'sm:h-auto sm:min-w-[104px]',
        )}
        style={
          copied
            ? { background: 'color-mix(in oklab, var(--gr-done) 16%, transparent)', color: 'var(--gr-done)' }
            : { background: 'var(--gr-sel)', color: 'var(--foreground)' }
        }
      >
        {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

// ── SecretInput ───────────────────────────────────────────────────────────────

export function SecretInput({
  value,
  onChange,
  placeholder,
  id,
  autoComplete = 'off',
  invalid,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  id?: string
  autoComplete?: string
  invalid?: boolean
}) {
  const [shown, setShown] = React.useState(false)
  return (
    <div className="relative">
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-invalid={invalid || undefined}
        className={cn(
          'flex h-10 w-full rounded-md border bg-transparent px-3 py-1 pr-11 font-mono text-base md:text-sm',
          'shadow-sm transition-colors placeholder:text-muted-foreground placeholder:font-sans',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          invalid ? 'border-destructive' : 'border-input',
        )}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide' : 'Show'}
        aria-pressed={shown}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground"
      >
        {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
      </button>
    </div>
  )
}

// ── RoleSelect ────────────────────────────────────────────────────────────────

export type HumanRole = 'owner' | 'admin' | 'member'

/** One-line explainer per role — the SAME copy the design specifies, kept here so
 *  the select and any future roster reuse one definition. */
export const ROLE_BLURB: Record<HumanRole, string> = {
  member: 'Works inside this company — chat, agents, connectors.',
  admin: 'Everything a member can, plus invite/manage people and settings.',
  owner: 'Full control of this company, including removing other people.',
}

export function RoleSelect({
  value,
  onChange,
  company,
  id,
}: {
  value: HumanRole
  onChange: (v: HumanRole) => void
  /** Company name, folded into the explainer for context. */
  company?: string
  id?: string
}) {
  const blurb = ROLE_BLURB[value].replace('this company', company ? `${company}` : 'this company')
  return (
    <div className="flex flex-col gap-1">
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as HumanRole)}
        className={cn(
          'h-10 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm',
          'shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
        <option value="owner">Owner</option>
      </select>
      <p className="text-[12px] leading-snug text-muted-foreground">{blurb}</p>
    </div>
  )
}

// ── WizardStepper ─────────────────────────────────────────────────────────────

export interface StepMeta {
  key: string
  title: string
  /** The chip shown to the right of the step title. */
  chip: { state: ChipState; label: string }
}

/** A compact vertical rail: numbered dots, the current step highlighted, each
 *  row carrying its live StatusChip. Purely presentational — the sheet owns which
 *  step is active. On a phone it collapses to a single "Step n of N" line + the
 *  active title (the full rail is desktop affordance). */
export function WizardStepper({
  steps,
  current,
}: {
  steps: StepMeta[]
  current: number
}) {
  return (
    <ol className="flex flex-col gap-0" aria-label="Onboarding steps">
      {steps.map((s, i) => {
        const active = i === current
        const done = i < current
        return (
          <li key={s.key} className="flex items-center gap-3 py-1.5">
            <span
              aria-hidden
              className="grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold"
              style={
                active
                  ? { background: 'var(--sm-accent-fill)', color: 'var(--gr-onaccent)' }
                  : done
                    ? { background: 'color-mix(in oklab, var(--gr-done) 18%, transparent)', color: 'var(--gr-done)' }
                    : { background: 'var(--gr-sel)', color: 'var(--muted-foreground)' }
              }
            >
              {done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[13px]',
                active ? 'font-semibold text-foreground' : 'text-muted-foreground',
              )}
            >
              {s.title}
            </span>
            <StatusChip state={s.chip.state} label={s.chip.label} className="shrink-0" />
          </li>
        )
      })}
    </ol>
  )
}
