/**
 * The chat header's model picker — lazily loaded from `header-pill.tsx`.
 * ─────────────────────────────────────────────────────────────────────────────
 * Desktop (fine pointer): a popover anchored to the model chip. Phone (coarse
 * pointer): the shared `ResponsiveSheet` bottom sheet. Same body in both.
 *
 * A pick never types into the composer from here: it is one
 * `POST /api/sessions/{name}/model`, and the SERVER drives Claude Code's own
 * `/model` (see `server/src/sessions/model_pick.rs` for what was watched working
 * on the shipping CLI). The typed `/model` stays refused in the composer
 * (`slash.ts` PICKER_OPENING): a bare one opens a TUI picker on a pty nobody is
 * watching. This door reads that picker off the screen instead.
 *
 * Where the pick lands follows the `model.pick_scope` pref (Settings → Model):
 * this session only (the default — a pick for one task must not silently become
 * every new session's model) or Claude Code's normal save-as-default.
 *
 * The chip does NOT flip optimistically. It moves on the server's `live_model`
 * delta — the statusline when tapped, else the transcript's last main-agent
 * signal, which for a pick is the `Set model to …` record Claude Code writes
 * the moment it lands. A pick the server could not see confirmed comes back as
 * an error carrying Claude Code's own words (another model, `Kept model as …`,
 * `Model 'x' not found`), and the toast says exactly that.
 *
 * Saving a DEFAULT writes the account's shared settings, so it is the owner's
 * or an admin's to do; a member's picks are always this session only.
 */
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/use-media-query'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { useToast } from '@/components/ui/use-toast'
import { useIsOwnerPlane } from '@/stores/viewer-store'
import {
  sessionRequest,
  type ModelAlias,
  type ModelPickScope,
  type SetModelResult,
} from '@/lib/api'
import {
  MODEL_PICK_SCOPE_KEY,
  modelFamily,
  pickScopeFrom,
  shortModelName,
  type LiveModelLike,
} from '@/lib/model-name'

/** `POST /api/sessions/{name}/model {model, scope}`. The server only types into
 *  an IDLE, empty composer (409 with the reason otherwise). Lives here, not on
 *  `sessionsApi`, because that object rides the entry chunk and this call is
 *  only ever made from this lazily-loaded picker. */
function setModel(name: string, model: ModelAlias, scope: ModelPickScope): Promise<SetModelResult> {
  return sessionRequest(`/api/sessions/${encodeURIComponent(name)}/model`, {
    method: 'POST',
    body: JSON.stringify({ model, scope }),
  })
}

/** The scope pref, as `settingsApi.getPref` reads it (same query key, same
 *  `string | null`), through the sessions client this chunk already shares with
 *  the entry: importing `settingsApi` here split it into a new hero-path chunk. */
async function readPickScope(): Promise<string | null> {
  try {
    const d = await sessionRequest<{ value?: string | null }>(`/api/prefs/${MODEL_PICK_SCOPE_KEY}`)
    return d?.value ?? null
  } catch (e) {
    // An older server without the key answers 404: unset, i.e. session-only.
    if ((e as { status?: number }).status === 404) return null
    throw e
  }
}

/** The rows, in Claude Code's own picker order, with its own one-line hints
 *  (2.1.326). The families are aliases, so each row follows Claude Code's
 *  "latest for your provider" resolution rather than pinning a version here. */
const ROWS: { alias: ModelAlias; label: string; hint: string }[] = [
  { alias: 'opus', label: 'Opus', hint: 'Everyday, complex tasks' },
  { alias: 'fable', label: 'Fable', hint: 'Hardest and longest-running tasks' },
  { alias: 'sonnet', label: 'Sonnet', hint: 'Routine tasks' },
  { alias: 'haiku', label: 'Haiku', hint: 'Quick answers' },
]

export interface ModelPickerProps {
  name: string
  current: LiveModelLike | null | undefined
  /** May a pick be sent right now? The agent idle at its prompt, no dialog up.
   *  The server re-checks the screen itself; this only keeps the rows honest. */
  canPick: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The chip the desktop popover anchors to. */
  anchorRef: React.RefObject<HTMLElement | null>
}

export default function ModelPicker({
  name,
  current,
  canPick,
  open,
  onOpenChange,
  anchorRef,
}: ModelPickerProps) {
  const coarse = useMediaQuery('(pointer: coarse)')
  const body = (
    <PickerBody name={name} current={current} canPick={canPick} onDone={() => onOpenChange(false)} />
  )
  if (coarse) {
    return (
      <ResponsiveSheet open={open} onOpenChange={onOpenChange} title="Model" description={shortModelName(current) ?? undefined}>
        <div className="px-4 pb-4 pt-2">{body}</div>
      </ResponsiveSheet>
    )
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor
        virtualRef={anchorRef as React.RefObject<{ getBoundingClientRect(): DOMRect }>}
      />
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-72 rounded-[10px] p-2"
        data-testid="model-picker"
      >
        {body}
      </PopoverContent>
    </Popover>
  )
}

function PickerBody({
  name,
  current,
  canPick,
  onDone,
}: {
  name: string
  current: LiveModelLike | null | undefined
  canPick: boolean
  onDone: () => void
}) {
  const { toast } = useToast()
  const { data: rawScope, isLoading } = useQuery({
    queryKey: ['pref', MODEL_PICK_SCOPE_KEY],
    queryFn: readPickScope,
    staleTime: 30_000,
  })
  const ownerPlane = useIsOwnerPlane()
  // A member cannot save a default (the server answers 403), so their picks are
  // this session only whatever the account pref says. The two gates are the
  // same set: the server's `is_admin_or_owner` is "no company AND role
  // owner/admin", and the web's owner plane is "no company" (`viewerFromMe`) —
  // a company-less human is by schema the owner or an admin-all
  // (`human_users.company_id`: "NULL = owner / admin-all"). So an admin human
  // reads as `owner` here and may save the default, exactly as the server allows.
  const scope = ownerPlane ? pickScopeFrom(rawScope) : 'session'

  const selected = modelFamily(current)
  const [pending, setPending] = React.useState<ModelAlias | null>(null)

  const pick = async (row: (typeof ROWS)[number]) => {
    if (pending || !canPick || isLoading) return
    setPending(row.alias)
    try {
      const res = await setModel(name, row.alias, scope)
      const where = res.scope === 'session' ? 'for this session only' : 'and saved as the default for new sessions'
      toast({
        message: res.confirmed
          ? `Switched to ${row.label} ${where}.`
          : `Sent the switch to ${row.label} ${where}, but Claude Code's answer could not be read — check the chip.`,
        tone: res.confirmed ? 'active' : 'waiting',
      })
      onDone()
    } catch (e) {
      toast({
        message: e instanceof Error ? e.message : 'Model switch failed.',
        tone: 'error',
        duration: 5000,
      })
    } finally {
      setPending(null)
    }
  }

  return (
    <div data-testid="model-picker-body" className="flex flex-col gap-1.5">
      <div
        role="group"
        aria-label={scope === 'session' ? 'Model for this session' : 'Model for this and new sessions'}
        className="flex flex-col"
      >
        {ROWS.map((row) => {
          const on = selected === row.alias
          const busy = pending === row.alias
          return (
            <button
              key={row.alias}
              type="button"
              aria-pressed={on}
              data-model={row.alias}
              disabled={!canPick || pending !== null || isLoading}
              onClick={() => void pick(row)}
              className={cn(
                'flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed',
                on ? 'bg-accent/40' : 'hover:bg-accent/30',
                !canPick && 'opacity-60',
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium text-foreground">{row.label}</span>
                <span className="text-[11.5px] text-muted-foreground">{row.hint}</span>
              </span>
              {busy ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Switching" />
              ) : on ? (
                <Check className="size-4 shrink-0 text-primary" aria-hidden />
              ) : null}
            </button>
          )
        })}
      </div>
      <p
        className="px-2.5 pb-1 text-[11.5px] leading-snug text-muted-foreground"
        data-testid="model-picker-note"
        aria-live="polite"
      >
        {!canPick
          ? 'Available when the agent is idle at its prompt.'
          : scope === 'session'
            ? 'Applies to this session only. Change this in Settings → Model.'
            : 'Also becomes the default for new sessions. Change this in Settings → Model.'}
      </p>
    </div>
  )
}
