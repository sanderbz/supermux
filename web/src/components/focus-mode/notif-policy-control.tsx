// Per-bot notification setting — the Grok move: you turn notifications on (or
// off) in a BOT's own settings, not in a global list of event types.
//
// The global Settings toggles stay as the per-KIND mute; this is the per-BOT
// one, and the effective decision is the AND of the two (applied once, on the
// server, in `push::send_push_for`). Four states, in escalating quiet:
//
//   Inherit   — follow the global toggles. The default; changes nothing.
//   Everything— this bot adds no mute of its own.
//   Needs attention only — mute the calm "turn finished" tier for this bot.
//   Off       — this bot never pushes.
//
// It writes through `PATCH /api/sessions/{name}/config { notif }` and shows the
// server's answer, never an optimistic guess — a rejected value has to be
// visible.

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { cn } from '@/lib/utils'
import { sessionsApi, type NotifPolicy } from '@/lib/api/sessions'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { useToast } from '@/components/ui/use-toast'

interface PolicySpec {
  key: NotifPolicy
  label: string
  hint: string
}

/** In escalating quiet, so the row reads left-to-right as "more silence". */
const POLICIES: PolicySpec[] = [
  { key: 'inherit', label: 'Inherit', hint: 'Follow your global notification settings.' },
  { key: 'all', label: 'Everything', hint: 'Every notification this bot can send.' },
  {
    key: 'attention',
    label: 'Needs you',
    hint: 'Only when this bot is blocked on you, or errors.',
  },
  { key: 'off', label: 'Off', hint: 'This bot never notifies you.' },
]

export function NotifPolicyControl({
  name,
  value,
}: {
  name: string
  /** The server's current setting; `undefined` while the row is loading. */
  value: NotifPolicy | undefined
}) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [saving, setSaving] = React.useState<NotifPolicy | null>(null)
  const current: NotifPolicy = value ?? 'inherit'

  async function choose(next: NotifPolicy) {
    if (next === current || saving) return
    setSaving(next)
    try {
      await sessionsApi.config(name, { notif: next })
      // Refetch rather than patch the cache: the server normalises the value,
      // and the row must show what would actually apply.
      await qc.invalidateQueries({ queryKey: SESSIONS_KEY })
    } catch (e) {
      toast({
        message: e instanceof Error ? e.message : 'Could not save that setting.',
        tone: 'error',
      })
    } finally {
      setSaving(null)
    }
  }

  const hint = POLICIES.find((p) => p.key === current)?.hint ?? ''

  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="radiogroup"
        aria-label="Notifications for this bot"
        className="flex flex-wrap gap-1.5"
      >
        {POLICIES.map((p) => {
          const active = p.key === current
          return (
            <button
              key={p.key}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={saving !== null}
              onClick={() => void choose(p.key)}
              className={cn(
                'min-h-11 rounded-[10px] px-3 text-[13px] font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:pointer-events-none disabled:opacity-60',
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-secondary text-foreground hover:bg-muted',
              )}
            >
              {saving === p.key ? 'Saving…' : p.label}
            </button>
          )
        })}
      </div>
      <p className="text-[12px] text-muted-foreground">{hint}</p>
    </div>
  )
}
