// Settings → Hosts (moved from the standalone /hosts route).
//
// The Hosts feature lives inside Settings so it shares the iOS-native
// grouped-list visual language: a Section header, a stack of Rows (one per
// host) divided by hairlines, and an "+ Add host" trailing button on the
// section header. All functionality from the former /hosts route is preserved
// 1:1 — create, recheck, bootstrap (with optional public-key install), delete
// (with a 4-second "armed" confirmation tap), and inline error surfaces.
//
// State strategy is unchanged from the old route:
//   * Hosts list: TanStack Query (use-hosts.ts) — shared cache with the
//     host-picker so flipping to "+ Add host" in Settings warms the picker too.
//   * Per-row mutations carry their own pending state so two rows can be
//     in-flight without cross-talk.
//   * Bootstrap report is rendered inline in the sheet — same component as the
//     after-create panel, single source of copy.
//
// The Add / Bootstrap surfaces live in the same ResponsiveSheet primitive used
// across the app (Vaul on mobile, side-Sheet on desktop), so the touch
// affordances and reduced-motion behaviour come for free.

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import {
  CheckCircle2,
  CircleDashed,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2,
  XCircle,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  HostError,
  type BootstrapReport,
  type Host,
  type HostStatus,
} from '@/lib/api'
import {
  useBootstrapHost,
  useCheckHost,
  useCreateHost,
  useDeleteHost,
  useHosts,
} from '@/hooks/use-hosts'
import { Row } from '@/components/settings/primitives'

// ── helpers ───────────────────────────────────────────────────────────────────

/** Render a unix-seconds timestamp as a calm relative string ("just now",
 *  "3m ago", "2h ago", "5d ago"). `null` / missing => "never". */
function relativeFromUnix(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'never'
  const secsAgo = Math.max(0, Math.round(Date.now() / 1000 - seconds))
  if (secsAgo < 45) return 'just now'
  const mins = Math.round(secsAgo / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

const STATUS_LABEL: Record<HostStatus, string> = {
  reachable: 'Reachable',
  unreachable: 'Unreachable',
  unknown: 'Unknown',
}

/** Colored dot + status label pill. Same token system as the session-tile
 *  StatusDot so the visual vocabulary stays consistent. */
function HostStatusPill({ status }: { status: HostStatus }) {
  const dotCls =
    status === 'reachable'
      ? 'bg-status-ready'
      : status === 'unreachable'
        ? 'bg-status-error'
        : 'bg-muted-foreground/50'
  const textCls =
    status === 'reachable'
      ? 'text-status-ready'
      : status === 'unreachable'
        ? 'text-status-error'
        : 'text-muted-foreground'
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
      <span aria-hidden className={cn('size-2 rounded-full', dotCls)} />
      <span className={textCls}>{STATUS_LABEL[status]}</span>
    </span>
  )
}

// ── section ───────────────────────────────────────────────────────────────────

/** Settings-section variant of the former /hosts route. Renders a section
 *  header with a trailing "+ Add host" button, then a Row per registered host
 *  (status pill, ssh target, last-seen relative, action cluster). Empty and
 *  loading states are inline Rows so the section never collapses to nothing
 *  (the iOS grouped-list never shows a card with zero rows). */
export function HostsSection() {
  const reduce = useReducedMotion()
  const { data: hosts, isLoading, isError, refetch } = useHosts()
  const [sheetOpen, setSheetOpen] = React.useState(false)

  const sortedHosts = React.useMemo<Host[]>(
    () =>
      (hosts ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [hosts],
  )

  // The Add control sits on the same line as the section header so it reads as
  // "this section's primary action". A 44pt hit target keeps the touch-spec
  // honest; the visual is a calm pill that mirrors other Settings outline
  // buttons (Manage, Rotate, etc.).
  const headerAction = (
    <Button
      asChild
      variant="outline"
      onClick={() => setSheetOpen(true)}
      className="h-9 gap-1.5 px-3"
      aria-label="Add host"
    >
      <motion.button
        whileTap={reduce ? undefined : { scale: 0.96 }}
        transition={springs.buttonPress}
      >
        <Plus className="size-4" />
        <span className="text-[13px] font-medium">Add host</span>
      </motion.button>
    </Button>
  )

  return (
    <SectionWithAction
      id="hosts"
      title="Remote hosts"
      action={headerAction}
      footnote="Remote hosts need a reachable address — Tailscale, a VPN, public DNS, or an SSH reverse tunnel all work. Generate an SSH key on the supermux server and copy the public key into the host’s ~/.ssh/authorized_keys via the Bootstrap button."
    >
      {isLoading ? (
        <Row>
          <div className="flex items-center gap-2 py-1 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading hosts…
          </div>
        </Row>
      ) : isError ? (
        <Row
          label="Couldn’t load hosts"
          hint="The server may be unreachable. Try again in a moment."
          control={
            <Button
              variant="outline"
              onClick={() => refetch()}
              className="h-11 gap-1.5"
            >
              <RefreshCw className="size-4" />
              Retry
            </Button>
          }
        />
      ) : sortedHosts.length === 0 ? (
        <Row
          label="No remote hosts yet"
          hint="Add one to run agents off-machine."
          control={
            <Button
              variant="outline"
              onClick={() => setSheetOpen(true)}
              className="h-11 gap-1.5"
            >
              <Globe className="size-4" />
              Add host
            </Button>
          }
        />
      ) : (
        sortedHosts.map((host) => <HostRow key={host.id} host={host} />)
      )}

      <AddHostSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </SectionWithAction>
  )
}

/** Section variant with a trailing control on the title row + a stable `id`
 *  anchor so `/settings#hosts` deep-links land here. Mirrors the visual
 *  language of `Section` (same grouped card, divider rules, footnote spacing)
 *  but reserves space for an action button next to the section title. */
function SectionWithAction({
  id,
  title,
  action,
  footnote,
  children,
}: {
  id?: string
  title: string
  action?: React.ReactNode
  footnote?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section
      id={id}
      // `scroll-mt` keeps the section header clear of the floating top bar
      // when a fragment anchor scrolls us into view.
      className="flex scroll-mt-16 flex-col"
    >
      <div className="flex items-end justify-between px-4 pb-2">
        <h2 className="text-[13px] font-medium leading-none text-muted-foreground">
          {title}
        </h2>
        {action}
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {children}
      </div>
      {footnote ? (
        <p className="px-4 pt-2 text-[12px] leading-snug text-muted-foreground">
          {footnote}
        </p>
      ) : null}
    </section>
  )
}

// ── one row ───────────────────────────────────────────────────────────────────

/** A single host row inside the Settings section: name + globe + status pill
 *  on the title line, ssh target / last-seen / key path on the hint line, and
 *  the per-row action cluster (recheck, bootstrap, delete) trailing. */
function HostRow({ host }: { host: Host }) {
  const check = useCheckHost()
  const remove = useDeleteHost()
  const [bootstrapOpen, setBootstrapOpen] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)

  const checking = check.isPending && check.variables === host.id
  const deleting = remove.isPending && remove.variables === host.id

  const onRecheck = () => {
    check.mutate(host.id)
  }
  const onDelete = () => {
    setDeleteError(null)
    if (!confirmDelete) {
      setConfirmDelete(true)
      // Auto-cancel the confirm after a few seconds so the row never sits in a
      // half-armed state.
      window.setTimeout(() => setConfirmDelete(false), 4000)
      return
    }
    remove.mutate(host.id, {
      onError: (err) => {
        setConfirmDelete(false)
        setDeleteError(
          err instanceof HostError
            ? err.message
            : 'Could not delete the host.',
        )
      },
    })
  }

  const label = (
    <div className="flex min-w-0 items-center gap-2">
      <Globe className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate text-[15px] font-medium">{host.name}</span>
      <HostStatusPill status={host.status} />
    </div>
  )

  const hint = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted-foreground">
      <span className="truncate font-mono">{host.ssh_target}</span>
      <span className="shrink-0">
        Last seen: {relativeFromUnix(host.last_seen)}
      </span>
      {host.ssh_key_path && (
        <span className="truncate font-mono">key: {host.ssh_key_path}</span>
      )}
    </div>
  )

  const control = (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={onRecheck}
            aria-label={`Recheck ${host.name}`}
            disabled={checking}
          >
            {checking ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Check reachability</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setBootstrapOpen(true)}
            aria-label={`Bootstrap ${host.name}`}
          >
            <ServerCog />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Bootstrap remote prerequisites</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={onDelete}
            aria-label={
              confirmDelete
                ? `Confirm delete ${host.name}`
                : `Delete ${host.name}`
            }
            disabled={deleting}
            className={cn(
              confirmDelete &&
                'bg-status-error/10 text-status-error hover:bg-status-error/15',
            )}
          >
            {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {confirmDelete ? 'Click again to delete' : 'Delete host'}
        </TooltipContent>
      </Tooltip>
    </div>
  )

  return (
    <Row label={label} hint={hint} control={control}>
      {/* Inline post-check error surfaces under the row so the user sees why a
          recheck failed (e.g. ssh stderr). Best-effort — present only when the
          server returned an `error` snippet in the CheckReport. */}
      {check.isSuccess &&
        check.variables === host.id &&
        check.data.status !== 'reachable' &&
        check.data.error && (
          <p className="mt-2 text-[12px] text-status-error">
            {check.data.error}
          </p>
        )}
      {deleteError && (
        <p className="mt-2 text-[12px] text-status-error" role="alert">
          {deleteError}
        </p>
      )}

      <BootstrapSheet
        open={bootstrapOpen}
        onOpenChange={setBootstrapOpen}
        host={host}
      />
    </Row>
  )
}

// ── Add host sheet ────────────────────────────────────────────────────────────

interface AddHostFormState {
  name: string
  sshTarget: string
  publicKey: string
}

function AddHostSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add host"
      description="Register a remote machine to run Claude sessions on."
    >
      {open && <AddHostForm onDone={() => onOpenChange(false)} />}
    </ResponsiveSheet>
  )
}

function AddHostForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = React.useState<AddHostFormState>({
    name: '',
    sshTarget: '',
    publicKey: '',
  })
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // After a successful create + auto-check, we keep the just-created host id
  // on the form so the user can run a bootstrap probe inline (no nav away).
  const [created, setCreated] = React.useState<Host | null>(null)
  const [report, setReport] = React.useState<BootstrapReport | null>(null)
  const [bootstrapping, setBootstrapping] = React.useState(false)

  const create = useCreateHost()
  const bootstrap = useBootstrapHost()

  const canSubmit =
    form.name.trim().length > 0 && form.sshTarget.trim().length > 0

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const host = await create.mutateAsync({
        name: form.name.trim(),
        ssh_target: form.sshTarget.trim(),
      })
      setCreated(host)
      // If the auto-check after create came back reachable, dismiss the sheet
      // immediately — there is nothing else for the user to do. A failing
      // auto-check keeps the sheet open so the user can run Bootstrap inline
      // (with the optional pubkey paste if they typed one).
      if (host.status === 'reachable') {
        onDone()
      }
    } catch (err) {
      const message =
        err instanceof HostError ? err.message : 'Could not create the host.'
      setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  const runBootstrap = async () => {
    if (!created) return
    setBootstrapping(true)
    try {
      const r = await bootstrap.mutateAsync({
        id: created.id,
        input: form.publicKey.trim()
          ? { public_key: form.publicKey.trim() }
          : undefined,
      })
      setReport(r)
    } catch (err) {
      setError(
        err instanceof HostError ? err.message : 'Bootstrap probe failed.',
      )
    } finally {
      setBootstrapping(false)
    }
  }

  // After-create panel: the host exists; show its status + offer Bootstrap.
  if (created) {
    return (
      <div className="flex flex-col gap-4 px-6 pb-6 pt-4">
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex items-center gap-2">
            <Globe className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">{created.name}</span>
            <HostStatusPill status={created.status} />
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {created.ssh_target}
          </p>
        </div>

        {created.status === 'reachable' ? (
          <p className="text-sm text-muted-foreground">
            Reachable on the first try. You can start a session on it from the
            Overview &raquo; New session sheet.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            The first check didn’t reach the host. Run Bootstrap to probe what
            it needs (tmux / claude / authorized_keys). Paste your supermux
            server&rsquo;s public key below if you want it installed in the
            remote&rsquo;s <code className="font-mono">~/.ssh/authorized_keys</code> in one go.
          </p>
        )}

        <Field label="Public key (optional)" htmlFor="ah-pubkey">
          <textarea
            id="ah-pubkey"
            value={form.publicKey}
            onChange={(e) =>
              setForm((f) => ({ ...f, publicKey: e.target.value }))
            }
            rows={3}
            placeholder="ssh-ed25519 AAAA... user@supermux"
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </Field>

        {report && <BootstrapChecklist report={report} />}

        {error && (
          <p role="alert" className="text-sm text-status-error">
            {error}
          </p>
        )}

        <div className="flex gap-2 pt-2">
          <Button variant="ghost" className="flex-1" onClick={onDone}>
            Close
          </Button>
          <Button
            type="button"
            className="flex-1"
            onClick={runBootstrap}
            disabled={bootstrapping}
          >
            {bootstrapping && <Loader2 className="animate-spin" />}
            {bootstrapping ? 'Probing…' : 'Bootstrap'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 px-6 pb-6 pt-4">
      <Field
        label="Name"
        htmlFor="ah-name"
        hint="A short label you’ll see in the picker."
      >
        <Input
          id="ah-name"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="ml-rig"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <Field
        label="SSH target"
        htmlFor="ah-target"
        hint="user@host or user@host:port. Reached via your SSH config + agent."
      >
        <Input
          id="ah-target"
          value={form.sshTarget}
          onChange={(e) =>
            setForm((f) => ({ ...f, sshTarget: e.target.value }))
          }
          placeholder="user@ml-rig.tailnet.ts.net"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <Field
        label="Public key (optional)"
        htmlFor="ah-pubkey-pre"
        hint="If set, Bootstrap will append it to the host’s authorized_keys."
      >
        <textarea
          id="ah-pubkey-pre"
          value={form.publicKey}
          onChange={(e) =>
            setForm((f) => ({ ...f, publicKey: e.target.value }))
          }
          rows={3}
          placeholder="ssh-ed25519 AAAA... user@supermux"
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </Field>

      {error && (
        <p role="alert" className="text-sm text-status-error">
          {error}
        </p>
      )}

      <div className="flex gap-2 pt-2">
        <Button
          type="button"
          variant="ghost"
          className="flex-1"
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          className="flex-1"
          disabled={!canSubmit || submitting}
        >
          {submitting && <Loader2 className="animate-spin" />}
          {submitting ? 'Adding…' : 'Add host'}
        </Button>
      </div>
    </form>
  )
}

// ── Bootstrap (standalone, from row action) ───────────────────────────────────

function BootstrapSheet({
  open,
  onOpenChange,
  host,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  host: Host
}) {
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Bootstrap ${host.name}`}
      description="Probe the remote for tmux, the supermux work dir, and the Claude CLI."
    >
      {open && (
        <BootstrapBody host={host} onClose={() => onOpenChange(false)} />
      )}
    </ResponsiveSheet>
  )
}

function BootstrapBody({
  host,
  onClose,
}: {
  host: Host
  onClose: () => void
}) {
  const [publicKey, setPublicKey] = React.useState('')
  const [report, setReport] = React.useState<BootstrapReport | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const bootstrap = useBootstrapHost()

  const run = async () => {
    setError(null)
    try {
      const r = await bootstrap.mutateAsync({
        id: host.id,
        input: publicKey.trim() ? { public_key: publicKey.trim() } : undefined,
      })
      setReport(r)
    } catch (err) {
      setError(
        err instanceof HostError ? err.message : 'Bootstrap probe failed.',
      )
    }
  }

  return (
    <div className="flex flex-col gap-4 px-6 pb-6 pt-4">
      <p className="text-sm text-muted-foreground">
        Runs a small SSH probe on{' '}
        <code className="font-mono text-xs">{host.ssh_target}</code> and reports
        what supermux still needs you to install. Paste your supermux server&rsquo;s
        public key to append it to the remote&rsquo;s authorized_keys at the same
        time.
      </p>

      <Field label="Public key (optional)" htmlFor="bs-pubkey">
        <textarea
          id="bs-pubkey"
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          rows={3}
          placeholder="ssh-ed25519 AAAA... user@supermux"
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </Field>

      {report && <BootstrapChecklist report={report} />}

      {error && (
        <p role="alert" className="text-sm text-status-error">
          {error}
        </p>
      )}

      <div className="flex gap-2 pt-2">
        <Button variant="ghost" className="flex-1" onClick={onClose}>
          Close
        </Button>
        <Button
          type="button"
          className="flex-1"
          onClick={run}
          disabled={bootstrap.isPending}
        >
          {bootstrap.isPending && <Loader2 className="animate-spin" />}
          {bootstrap.isPending ? 'Probing…' : 'Bootstrap'}
        </Button>
      </div>
    </div>
  )
}

// ── Checklist ─────────────────────────────────────────────────────────────────

function BootstrapChecklist({ report }: { report: BootstrapReport }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Probe report
      </p>
      <ul className="flex flex-col gap-1.5 text-sm">
        <ChecklistItem
          ok={report.tmux_installed}
          label={
            report.tmux_installed
              ? `tmux ${report.tmux_version ?? 'installed'}`
              : 'tmux'
          }
        />
        <ChecklistItem
          ok={report.supermux_dir === 'created'}
          label={`~/.supermux-remote (${report.supermux_dir})`}
        />
        <ChecklistItem ok={report.claude_installed} label="Claude CLI" />
        {report.authorized_key_added !== undefined && (
          <ChecklistItem
            ok={report.authorized_key_added}
            label={
              report.authorized_key_added
                ? 'Public key appended to authorized_keys'
                : 'Public key already present'
            }
            // The dedup case ISN'T an error — it's still a green check.
            forceOk={!report.authorized_key_added}
          />
        )}
      </ul>
      {report.warnings.length > 0 && (
        <div className="mt-3 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
          <p className="mb-1 font-medium">Warnings</p>
          <ul className="list-disc pl-5">
            {report.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ChecklistItem({
  ok,
  label,
  forceOk = false,
}: {
  ok: boolean
  label: string
  /** Force the "ok" green check even when `ok=false`. Used for the
   *  "already present" dedup case of the authorized_keys append, which is
   *  semantically a green outcome (the key is in place). */
  forceOk?: boolean
}) {
  const okState = ok || forceOk
  // The supermux-dir line never goes "red" — `missing` is a soft state.
  const isSoftMissing = !okState && label.startsWith('~/.supermux-remote')
  const Icon = okState ? CheckCircle2 : isSoftMissing ? CircleDashed : XCircle
  return (
    <li className="flex items-center gap-2">
      <span
        className={cn(
          okState
            ? 'text-status-ready'
            : isSoftMissing
              ? 'text-muted-foreground'
              : 'text-status-error',
          '[&_svg]:size-4',
        )}
      >
        <Icon />
      </span>
      <span className={cn(!okState && 'text-muted-foreground')}>{label}</span>
    </li>
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

// Re-exported for the settings route to keep its imports tidy. Wider use of
// `Section` (without a header action) stays on `@/components/settings/primitives`.
// Unused but kept as the canonical name in case future settings sections want
// the same "header with a trailing action" layout.
export { SectionWithAction }
