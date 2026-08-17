import * as React from 'react'
import { motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { MISC } from '@/brand/copy'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { sessionsApi, SessionError } from '@/lib/api'
import { HostPicker } from '@/components/host-picker'
import {
  WherePicker,
  defaultWhereSelection,
  type NewWhereSelection,
} from './where-picker'
import { createProjectFolder } from '@/lib/create-project-folder'
import { SessionMark } from '@/brand/marks'
import { useRosterMarks } from '@/hooks/use-roster-marks'
import { encodeMarkPin, freeTokens } from '@/lib/roster-marks'

/** Derive the immutable slug from the free-typed display name (migration 0019):
 *  whitespace → `-`, drop anything outside the server's `valid_name` charset
 *  (`[A-Za-z0-9_.-]`), bound to 100. The user types a human label; this is the
 *  URL/tmux/identity key — and the name of the folder we auto-create for it. */
function toSlug(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .slice(0, 100)
}

export interface NewSessionSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-filled working directory. When omitted a folder named after the
   *  session is created under the projects root. */
  defaultDir?: string
  /** Called after a successful create/start so the route can navigate to focus. */
  onCreated: (name: string) => void
}

/** The single boot panel. A `Claude | Codex` toggle selects an equivalent
 *  single-agent launch form. The "+" opens this directly — no intermediate
 *  menu. The inner panel only mounts while the sheet is open, so its state
 *  starts fresh each time. */
export function NewSessionSheet({
  open,
  onOpenChange,
  defaultDir,
  onCreated,
}: NewSessionSheetProps) {
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="New session"
      description={MISC.newSessionSubtitle}
    >
      {open && (
        <NewSessionPanel
          defaultDir={defaultDir}
          onCancel={() => onOpenChange(false)}
          onCreated={(name) => {
            onOpenChange(false)
            onCreated(name)
          }}
        />
      )}
    </ResponsiveSheet>
  )
}

type Kind = 'claude' | 'codex'

function NewSessionPanel({
  defaultDir,
  onCancel,
  onCreated,
}: {
  defaultDir: string | undefined
  onCancel: () => void
  onCreated: (name: string) => void
}) {
  const [kind, setKind] = React.useState<Kind>('claude')

  return (
    <div className="flex flex-col">
      <div className="px-6 pt-4">
        <KindToggle value={kind} onChange={setKind} />
      </div>

      <AgentForm
        provider={kind}
        defaultDir={defaultDir}
        onCancel={onCancel}
        onCreated={onCreated}
      />
    </div>
  )
}

// ── Claude | Codex segmented toggle ──────────────────────────────────────────
// Mirrors the overview ViewToggle: a muted pill rail with an animated `bg-card`
// thumb (shared layoutId) sliding under the active label. No `transition: all`.
function KindToggle({
  value,
  onChange,
}: {
  value: Kind
  onChange: (k: Kind) => void
}) {
  const items: { id: Kind; label: string }[] = [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' },
  ]
  return (
    <div
      role="group"
      aria-label="Session kind"
      className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
    >
      {items.map((it) => {
        const active = value === it.id
        return (
          <button
            key={it.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(it.id)}
            className={cn(
              'relative flex h-9 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId="new-session-kind-thumb"
                transition={springs.snappy}
                className="absolute inset-0 rounded-md bg-card shadow-sm"
              />
            )}
            {/* The provider wears a face too (fase B2 T8): three text labels in
                a segmented control are three words to read; three marks are
                three things to recognise. Seeded by the provider id so the same
                provider always looks the same, and static — nothing on a form
                should blink. */}
            <SessionMark
              seed={`provider:${it.id}`}
              size={18}
              animate={false}
              label={null}
              className="relative"
            />
            <span className="relative">{it.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Agent form — shared by Claude and Codex ───────────────────────────────────
function AgentForm({
  provider,
  defaultDir,
  onCancel,
  onCreated,
}: {
  provider: 'claude' | 'codex'
  defaultDir: string | undefined
  onCancel: () => void
  onCreated: (name: string) => void
}) {
  const [name, setName] = React.useState('')
  // Default flow: a name auto-creates a folder named after it. The user can
  // opt into picking their own directory via the link — then we show the
  // WherePicker and use its selection instead.
  const [ownFolder, setOwnFolder] = React.useState(false)
  const [where, setWhere] = React.useState<NewWhereSelection>(() =>
    defaultDir ? { kind: 'new', dir: defaultDir } : defaultWhereSelection(),
  )
  const [hostId, setHostId] = React.useState<number | null>(null)
  const [worktree, setWorktree] = React.useState(false)
  const [bypassPermissions, setBypassPermissions] = React.useState(false)
  // Identity (fase B2 T8). `desc` and `tags` have been on the wire forever with
  // no control; the create sheet is the first place a session can be given
  // either. `prompt` is the create flow's answer to the one capability the
  // removed Board page had ("Add & start").
  const [desc, setDesc] = React.useState('')
  const [tags, setTags] = React.useState('')
  const [prompt, setPrompt] = React.useState('')
  // The reroll counter. The face is DERIVED from the slug, so a reroll is
  // "walk to the next token that nobody in the roster is wearing" — which is
  // why it needs the roster, and why it can never hand out a duplicate.
  const [reroll, setReroll] = React.useState(0)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // The typed text is the display LABEL; the slug is derived from it and is the
  // immutable id (URL / tmux / hooks) AND the auto-folder name. A label of only
  // spaces/emoji slugifies to "" → not valid.
  const slug = toSlug(name)
  const canSubmit = slug.length > 0

  // The reroll's candidate pool: every token nobody in the roster wears. The
  // pins come from the app-wide provider, so "free" means free across the whole
  // product and not just this sheet. `reroll === 0` ⇒ no override at all, and
  // the face stays derived (nothing is written to `mark_pin`).
  const { pins } = useRosterMarks()
  const pickedPin = React.useMemo(() => {
    if (reroll === 0) return undefined
    const free = freeTokens(pins)
    if (free.length === 0) return undefined // a full roster: keep the derived face
    return free[(reroll - 1) % free.length]
  }, [reroll, pins])

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      // Resolve the working directory. Default: auto-create a folder named
      // after the slug under the projects root (same proven PUT /api/file path
      // the WherePicker's "Create a new folder" uses). Opt-in: the directory
      // the user picked in the revealed WherePicker.
      let dir: string
      if (ownFolder) {
        dir = where.dir.trim()
      } else {
        const folder = await createProjectFolder(slug)
        if (!folder) {
          setError('Could not create the folder — pick your own folder instead.')
          setOwnFolder(true)
          setSubmitting(false)
          return
        }
        dir = folder
      }

      const created = await sessionsApi.create({
        name: slug,
        display_name: name.trim(),
        dir,
        provider,
        worktree,
        desc: desc.trim() || undefined,
        // Omit when LOCAL so the wire stays clean (server treats missing/null
        // both as LOCAL). Only sent for a registered remote host.
        host_id: hostId ?? undefined,
        // Claude-only: the server appends its trusted bypass flag. Codex has its
        // own approval settings, configured through its CLI flags/profile.
        bypass_permissions:
          provider === 'claude' && bypassPermissions ? true : undefined,
      })
      const sessionName = created?.name ?? slug

      // Identity extras go in a follow-up PATCH rather than on `create`: the
      // create endpoint deliberately takes a small, typed shape (it is the one
      // the CLI and the scheduler share), and both of these are edits a user can
      // make again later from the same controls.
      const tagList = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      const markPin = pickedPin ? encodeMarkPin(pickedPin) : null
      if (tagList.length > 0 || markPin) {
        try {
          await sessionsApi.config(sessionName, {
            ...(tagList.length > 0 ? { tags: tagList } : {}),
            ...(markPin ? { mark_pin: markPin } : {}),
          })
        } catch {
          /* the session exists; tags and a face are not worth failing create */
        }
      }

      // Boot the agent, and deliver the first message in the same step — the
      // start endpoint already takes a command, which is the path the Quick-start
      // presets use. Non-fatal: the row exists either way; focus can retry.
      try {
        await sessionsApi.start(sessionName, prompt.trim() || undefined)
      } catch {
        /* ignore — session created, start retryable from focus */
      }
      onCreated(sessionName)
    } catch (err) {
      if (err instanceof SessionError && err.status === 409) {
        setError(`The id “${slug}” is taken — tweak the name and try again.`)
      } else if (err instanceof SessionError && err.status === 0) {
        setError('Can’t reach supermux-server. Check it’s running, then try again.')
      } else {
        setError(err instanceof Error ? err.message : 'Could not create the session.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 px-6 pb-6 pt-4">
      <Field label="Name" htmlFor="ns-name">
        <Input
          id="ns-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-agent"
          autoComplete="off"
          spellCheck={false}
        />
        {!ownFolder && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {slug ? (
              <>
                Creates a new folder <code className="font-mono">{slug}</code>.{' '}
              </>
            ) : (
              <>Creates a new folder named after the session. </>
            )}
            <button
              type="button"
              onClick={() => setOwnFolder(true)}
              className="text-primary hover:underline"
            >
              choose your own folder →
            </button>
          </p>
        )}
      </Field>

      {/* The session's FACE, before it exists (fase B2 T8). Derived from the
          slug the user is typing, so it changes as they type — and the reroll
          walks the tokens NOBODY in the roster is wearing, which is why it can
          never hand out a duplicate. The choice is persisted on create through
          `mark_pin` (migration 0027); with no reroll, nothing is stored and the
          face stays derived. */}
      <Field label="Face" htmlFor="ns-mark">
        <div id="ns-mark" className="flex items-center gap-3">
          <SessionMark
            seed={slug || 'new-session'}
            pin={pickedPin}
            size={40}
            animate={false}
            label={null}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm">{name.trim() || 'Your new colleague'}</span>
            <span className="text-[11px] text-muted-foreground">
              {pickedPin
                ? 'Frozen — this face is saved with the session.'
                : 'Derived from the name, deduped against your roster.'}
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setReroll((n) => n + 1)}
            disabled={submitting}
          >
            Reroll
          </Button>
        </div>
      </Field>

      {/* Own-folder path: the same Projects list + "Create a new folder"
          picker, narrowed to 'new' picks (no session take-over for a brand-new
          session). gitHint="info" drops the amber non-git warning — a normal
          session can run anywhere. */}
      {ownFolder && (
        <Field label="Folder" htmlFor="ns-where">
          <WherePicker
            id="ns-where"
            value={where}
            onChange={setWhere}
            showSessions={false}
            gitHint="info"
          />
        </Field>
      )}

      <Field
        label="Run on"
        htmlFor="ns-host"
        hint="Pick a remote host you registered in Hosts, or stay Local."
      >
        <HostPicker
          id="ns-host"
          value={hostId}
          onChange={setHostId}
          disabled={submitting}
        />
      </Field>

      <CheckCard
        checked={worktree}
        onChange={setWorktree}
        title="Isolated worktree"
        desc="Run in a fresh git worktree so it can’t touch your tree."
      />

      <Field
        label="Standing instructions"
        htmlFor="ns-desc"
        hint="Durable rules for this agent — not this task. Editable later in Info."
      >
        <textarea
          id="ns-desc"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={2}
          placeholder="Always run the unit suite before you claim green."
          className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
        />
      </Field>

      <Field label="Tags" htmlFor="ns-tags" hint="Comma-separated. Searchable.">
        <Input
          id="ns-tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="frontend, release"
          autoComplete="off"
        />
      </Field>

      {/* The initial prompt — the create flow's answer to the Board page's
          "Add & start" (§12.6). It rides the existing create → start path, so a
          session that is given one arrives already working. */}
      <Field
        label="First message"
        htmlFor="ns-prompt"
        hint="Optional. Sent as soon as the agent boots."
      >
        <textarea
          id="ns-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          placeholder="Read the plan in docs/… and start with task 1."
          className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
        />
      </Field>

      {provider === 'claude' && (
        <CheckCard
          checked={bypassPermissions}
          onChange={setBypassPermissions}
          title="Bypass permissions"
          desc="Claude runs tools without asking. Use only in directories you trust."
        />
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-sm text-status-error-ink"
        >
          {error}
        </p>
      )}

      <div className="flex gap-2 pt-2">
        <Button type="button" variant="ghost" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" className="flex-1" disabled={!canSubmit || submitting}>
          {submitting && <Loader2 className="animate-spin" />}
          {submitting ? 'Booting…' : 'Start'}
        </Button>
      </div>
    </form>
  )
}

/** A bordered checkbox row with a title + muted description — the Claude form's
 *  "Isolated worktree" and "Bypass permissions" options share this shape. */
function CheckCard({
  checked,
  onChange,
  title,
  desc,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  desc: string
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[hsl(var(--primary))]"
      />
      <span className="flex flex-col">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{desc}</span>
      </span>
    </label>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
