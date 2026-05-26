// /hosts (REMOTE_PLAN.md RT9) — remote host registry. List + add + recheck +
// bootstrap + delete. Mirrors the visual language of /board and /scheduler:
// a single scrollable column inside the safe-area-aware route shell, headline
// + secondary action row at top, then a card list (one card per host) with
// status pill, ssh target, last-seen relative time, and per-row controls. A
// "+ Add host" button opens a ResponsiveSheet (Vaul on mobile, side-Sheet on
// desktop — same primitive every other create flow uses).
//
// State strategy:
//   * Hosts list: TanStack Query (use-hosts.ts). Mutations invalidate the
//     cache; no SSE channel for hosts (RT8 didn't ship one — hosts change
//     rarely and only on user actions, so cache-invalidate + refetch is
//     enough).
//   * Per-row check / bootstrap / delete are short-lived imperative
//     mutations; their pending state lives on the row (not a shared store)
//     so two rows can be in-flight simultaneously without cross-talk.
//   * Bootstrap report is shown inline in the "Add host" sheet once the
//     auto-check after create fails — surfacing the per-prereq checklist
//     right where the user is already focused, with a single "Bootstrap"
//     button that POSTs and renders the returned report.

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
import { EmptyStatePlaceholder } from '@/components/empty-state'
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
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span aria-hidden className={cn('size-2 rounded-full', dotCls)} />
      <span className={textCls}>{STATUS_LABEL[status]}</span>
    </span>
  )
}

// ── route ─────────────────────────────────────────────────────────────────────

export function Hosts() {
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

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-3 py-4 pt-[calc(env(safe-area-inset-top)+1rem)] sm:px-5 sm:py-6 sm:pt-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="mr-1 text-2xl font-semibold tracking-tight">Hosts</h1>
        <p className="hidden flex-1 text-sm text-muted-foreground sm:block">
          Remote machines you can run agents on, reached via SSH.
        </p>
        <motion.button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-label="Add host"
          title="Add host"
          whileTap={reduce ? undefined : { scale: 0.9 }}
          transition={springs.snappy}
          className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors hover:text-foreground sm:hidden"
        >
          <Plus className="size-4" />
        </motion.button>
        <Button
          onClick={() => setSheetOpen(true)}
          className="hidden sm:inline-flex"
        >
          <Plus />
          Add host
        </Button>
      </header>

      <div className="min-h-0 flex-1">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : isError ? (
          <div className="flex h-full items-center justify-center">
            <EmptyStatePlaceholder
              icon={<ServerCog />}
              message="Couldn’t load hosts. The server may be unreachable."
              cta={{ label: 'Retry', onClick: () => refetch() }}
            />
          </div>
        ) : sortedHosts.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyStatePlaceholder
              icon={<Globe />}
              message="No remote hosts yet. Add one to run agents off-machine."
              cta={{ label: 'Add host', onClick: () => setSheetOpen(true) }}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {sortedHosts.map((host) => (
              <HostRow key={host.id} host={host} />
            ))}

            <SshHint className="mt-4" />
          </div>
        )}
      </div>

      <AddHostSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  )
}

// ── one row ───────────────────────────────────────────────────────────────────

/** A single host card: name + globe, status pill, ssh target (mono), last
 *  seen (relative), and per-row action cluster (recheck, bootstrap, delete).
 *  Per-row mutation state stays local so two rows can be in-flight at once. */
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
      // Auto-cancel the confirm after a few seconds so the card never sits
      // in a half-armed state.
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

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <Globe className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{host.name}</span>
            <HostStatusPill status={host.status} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="truncate font-mono">{host.ssh_target}</span>
            <span className="shrink-0">
              Last seen: {relativeFromUnix(host.last_seen)}
            </span>
            {host.ssh_key_path && (
              <span className="truncate font-mono">
                key: {host.ssh_key_path}
              </span>
            )}
          </div>
        </div>
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
      </div>

      {/* Inline post-check error surfaces under the row so the user sees why
          the recheck failed (e.g. ssh stderr). Best-effort — present only
          when the server returned an `error` snippet in the CheckReport. */}
      {check.isSuccess &&
        check.variables === host.id &&
        check.data.status !== 'reachable' &&
        check.data.error && (
          <p className="mt-2 text-xs text-status-error">
            {check.data.error}
          </p>
        )}
      {deleteError && (
        <p className="mt-2 text-xs text-status-error" role="alert">
          {deleteError}
        </p>
      )}

      <BootstrapSheet
        open={bootstrapOpen}
        onOpenChange={setBootstrapOpen}
        host={host}
      />
    </div>
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
      // If the auto-check after create came back reachable, dismiss the
      // sheet immediately — there is nothing else for the user to do. A
      // failing auto-check keeps the sheet open so the user can run
      // Bootstrap inline (with the optional pubkey paste if they typed one).
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
            onChange={(e) => setForm((f) => ({ ...f, publicKey: e.target.value }))}
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

// ── Checklist + the SSH-onboarding hint ───────────────────────────────────────

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
        <ChecklistItem
          ok={report.claude_installed}
          label="Claude CLI"
        />
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
  const isSoftMissing =
    !okState && label.startsWith('~/.supermux-remote')
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

/** Settings-style hint paragraph repeated on /hosts to explain the network
 *  expectations: Tailscale / a reachable hostname, plus the SSH key dance the
 *  Bootstrap button automates. Mirrors the same paragraph the Settings route
 *  renders in its Remote hosts section (single source of copy lives here). */
export function SshHint({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded-lg border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground',
        className,
      )}
    >
      Remote hosts require Tailscale or a reachable hostname. Generate an SSH
      key on the supermux server and copy the public key into the host&rsquo;s{' '}
      <code className="font-mono">~/.ssh/authorized_keys</code> via the{' '}
      <span className="font-medium">Bootstrap</span> button.
    </div>
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
