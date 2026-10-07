/**
 * `<BotPanel>` — the per-bot settings PAGE (Grok/Bot mode, ASK 3).
 * ─────────────────────────────────────────────────────────────────────────────
 * The roster's detail pane used to only GLANCE (cost/context/provider/status) —
 * nothing was editable. The real editable surface lived in
 * `focus-mode/session-info-panel.tsx` and was never mounted in Grok mode. This is
 * that surface, re-shaped as a tabbed bot page and reusing the info-panel's own
 * section bodies (name editor, dir, desc/role, tags, settings, Issues, Schedules,
 * Git, Clone, NotifPolicyControl) rather than reimplementing them.
 *
 * "Three fidelities, one component" (master plan §11.4):
 *   • variant="pane"  — the desktop roster's second column (replaces DetailPane).
 *   • variant="sheet" — a bottom sheet (the mobile focus-view title opens THIS,
 *                       not a duplicate surface).
 *
 * Three quiet tabs — the five-tab version read as five settings screens, so it
 * was folded down to what you actually DO here: glance, configure, automate.
 *   • Overview  — what this bot is doing, what it last did, who hands it work,
 *                 editable tags and the working directory.
 *
 * WHAT THE GLANCE USED TO BE, AND WHY IT ISN'T.
 * The Overview opened on a 2×2 card grid — Context ring / Tokens / Provider /
 * Status — and a "Latest" bubble. Three of those five read fields with NO server
 * producer: `tokens` is declared on `ApiSession` and written by nothing in
 * `server/src`, `task_summary` never reaches the wire, and `chat_tail` is
 * SSE-delta-only so it is absent on every fresh open. The ring was permanently
 * `—`, Tokens permanently `0 · cumulative`, and the bubble permanently blank;
 * Provider said `claude` about a fleet that is all claude. The panel was less
 * informative than the roster tile it was opened from.
 *
 * A field with no producer is DELETED here, not em-dashed. What replaced them is
 * what the row already carries and nothing rendered: the live activity line, the
 * blocked/limit badges, `last_send_text`, and two cheap reads — the chat recall
 * page and the delegation graph.
 *   • Setup     — everything you CONFIGURE, grouped: the role + launch model +
 *                 core notes, the bot's Connectors, what it has learned, how it
 *                 notifies you, and the launch internals (MCP / flags / runtime)
 *                 tucked under one Advanced disclosure.
 *   • Workflows — the bot-scoped Workflows list · Recent runs · Issues · Git.
 *
 * The old `instructions` / `tools` / `memory` keys folded into ONE tab keyed
 * `instructions` (labelled "Setup"); `normalizeTab()` re-points any legacy
 * deep-link at `tools` or `memory` onto it, so a bookmarked panelTab never lands
 * on a tab that no longer exists.
 *
 * Styling is Tailwind + shadcn tokens (NOT `[data-grok]`-scoped CSS) so the ONE
 * component renders identically in the in-shell pane and in the body-portalled
 * sheet; the pane's outer chrome reuses the roster's existing `.gr-pane` surface.
 */
import * as React from 'react'
import { BrowserFeedbackCard, supportsBrowserFeedback } from '../browser-feedback/browser-pairing'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Files as FilesIcon,
  FolderOpen,
  Loader2,
  Plus,
  Terminal,
  Undo2,
} from 'lucide-react'
import { Link } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { modelOptions } from '@/lib/model-options'
import { SessionFace } from '@/components/roster/session-face'
import { GrantedConnectors, RestartToApply } from '@/components/roster/granted-connectors'
import { LearnedNotes } from '@/components/roster/learned-notes'
import {
  ActivityLine,
  BlockedBadge,
  ErrorBadge,
  UsageChip,
} from '@/components/session-tile/activity-status'
import { condenseReceiptLabel } from '@/components/chat/grouping'
import {
  formatRecallTime,
  useLastSend,
  type LastSend,
} from '@/components/focus-mode/last-send-recall'
import { NotifPolicyControl } from '@/components/focus-mode/notif-policy-control'
import {
  DescEditor,
  TagsEditor,
  GitRow,
  type DescEditorHandle,
} from '@/components/focus-mode/session-info-panel'
import { WorkflowsView } from '@/components/workflows/workflows-view'
import { RecentRuns } from '@/components/workflows/recent-runs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { SessionActionsMenu } from '@/components/session-tile/session-actions-menu'
import { IssueList } from '@/components/issues/issue-list'
import { IssueSurface } from '@/components/issues/issue-surface'
import { useSession } from '@/hooks/use-sessions'
import { useSessionAttention } from '@/hooks/use-attention'
import { useSessionConfig } from '@/hooks/use-session-config'
import { groupOf, stateWordFor } from '@/lib/team-attention'
import { useCloneSession } from '@/components/focus-mode/use-clone-session'
import { useToast } from '@/components/ui/use-toast'
import { agentsApi, type DelegationEdge, type DelegationsView } from '@/lib/api/agents'
import { displayLabel, sessionsApi, type ApiSession, type RecallEntry } from '@/lib/api'

/* ── tiny pure helpers (mirrors of grok-roster's; kept local so this module is
      self-contained and does not widen grok-roster's export surface) ────────── */

function modelOf(s: ApiSession | null): string {
  if (!s) return ''
  if (s.model?.trim()) return s.model.trim()
  const m = s.flags?.match(/--model[= ]+(\S+)/)
  return m?.[1] ?? ''
}

/* ── the CORE-notes budget, mirrored from the server ───────────────────────── */

/** The budgets `cap_core_notes` (`server/src/sessions/lifecycle.rs`) enforces —
 *  whichever bites FIRST. The editor used to state `~N / 2000 chars`, a number
 *  that exists nowhere on the server and that hid the line budget entirely; on
 *  a bulleted index the line budget is the one that actually bites. */
export const CORE_MAX_LINES = 40
export const CORE_MAX_CHARS = 6_000

export interface CoreNotesBudget {
  lines: number
  chars: number
  overLines: boolean
  overChars: boolean
}

/** What the server will keep of these notes, in the server's own two units.
 *  Pure, so `tests/unit/bot-panel-settings.test.ts` can pin it against the Rust
 *  without a DOM.
 *
 *  Two details are the whole reason this is a function and not two `.length`s:
 *  Rust's `str::lines()` yields NOTHING for an empty string where JS's
 *  `''.split('\n')` yields one entry, and `chars().count()` counts Unicode
 *  SCALARS where `String.length` counts UTF-16 units — an emoji index would
 *  otherwise read as twice its real cost. `trimEnd()` first, exactly as the
 *  Rust does, so a trailing newline is not a line. */
export function coreNotesBudget(notes: string): CoreNotesBudget {
  const text = notes.trimEnd()
  const lines = text === '' ? 0 : text.split('\n').length
  const chars = [...text].length
  return {
    lines,
    chars,
    overLines: lines > CORE_MAX_LINES,
    overChars: chars > CORE_MAX_CHARS,
  }
}

/* ── the last exchange, selected out of a recall page ──────────────────────── */

/** What the Overview shows of the bot's last turn: the reply and the receipts
 *  under it. Who delegated the work in comes from the delegation GRAPH
 *  ([`handoffView`]) instead — one source for that fact, not two that disagree. */
export interface LastExchange {
  /** The newest assistant prose. */
  answer?: string
  /** Up to [`RECEIPT_MAX`] tool receipts, newest first. */
  receipts: { label: string; ok: boolean }[]
}

/** More than three receipts is a transcript, and the transcript is one tap away. */
const RECEIPT_MAX = 3

/** Pick the readable bits out of a `?chat=true` recall page (newest first).
 *  Pure, so the selection is unit-testable without a live panel — the same shape
 *  `normalizeTab` and `afterUndo` already take in this file.
 *
 *  THE PAGE SPANS MORE THAN ONE TURN, and the card files everything it collects
 *  under ONE prompt and one timestamp — `lastSend`. So the walk is scoped to
 *  THAT prompt's turn, or the card asserts something false: measured on the
 *  frozen bot `Mail`, it showed three ✓ receipts under "You asked · 12d ago"
 *  whose entries all PREDATED the prompt they sat beneath (`last_send_at`
 *  1787064835 over tool calls at …832 / …754 / …749).
 *
 *  The page is newest-first, so one pass does it. Anything OLDER than the prompt
 *  cannot be part of its answer, and a user turn is a boundary — but which kind
 *  of boundary depends on which side of the prompt it falls:
 *    · older than `lastSend` ⇒ it is the prompt that opened this turn (or an
 *      earlier one). Stop.
 *    · newer than `lastSend` ⇒ a LATER question the row never recorded — a
 *      `/exit`, a slash command — and everything collected above it answered
 *      that one. Drop what we have and keep walking down into the exchange the
 *      card is actually showing. Three live sessions (`Research`, `wvhj-claude`,
 *      `linkbuilder-exec`) sit in exactly this shape, and stopping here instead
 *      would blank a card whose answer is one row further down.
 *
 *  Only the LABEL comes from the chat plane (`condenseReceiptLabel`), never the
 *  chrome: `<ReceiptGroup>` wraps itself in the grok-scoped chat `<Bubble>`, and
 *  this file is committed to Tailwind + shadcn tokens so one component renders
 *  identically in the pane and in the body-portalled sheet. */
export function lastExchange(entries: RecallEntry[], lastSend?: LastSend | null): LastExchange {
  const out: LastExchange = { receipts: [] }
  // Epoch SECONDS on both sides — `RecallEntry.ts` is what the recall list
  // already renders as `new Date(entry.ts * 1000)`.
  const since = lastSend ? Math.floor(lastSend.sentAt.getTime() / 1000) : null
  for (const e of entries) {
    if (e.kind !== 'assistant' && e.kind !== 'tool_use') {
      if (since === null || e.ts <= since) break
      out.answer = undefined
      out.receipts = []
      continue
    }
    if (since !== null && e.ts < since) break
    const text = e.text?.trim() ?? ''
    if (e.kind === 'assistant') {
      if (!out.answer && text) out.answer = text
    } else {
      const label = condenseReceiptLabel(text)
      if (label && out.receipts.length < RECEIPT_MAX) {
        out.receipts.push({ label, ok: e.ok !== false })
      }
    }
  }
  return out
}

/* ── the delegation graph, read once for both Overview blocks ──────────────── */

/** Server cap on the stored send preview (`LAST_SEND_TEXT_MAX_CHARS`,
 *  `server/src/db/sessions.rs`). Below it the row holds the prompt verbatim;
 *  above it, a prefix of the one the edge kept whole. */
const LAST_SEND_MAX_CHARS = 8_000

/** Is this edge the very send the Last-exchange card is already showing?
 *
 *  `last_send_text` is the last prompt written INTO the session no matter who
 *  wrote it, and `agents::delegate` records the SAME unwrapped string on the edge
 *  (the `<supermux-delegation>` wrapper is machinery and is stripped from both).
 *  So when a bot handed the work in, the row field and the graph edge are ONE
 *  fact — which the panel printed three times: "You asked", "↳ from X", and the
 *  top Handoffs row, same prompt, same timestamp.
 *
 *  Exact by default; a prefix only counts once the preview is at the cap, so a
 *  short send can never collide with a longer prompt that happens to start with
 *  it. */
export function isLastSend(edge: DelegationEdge, lastSend: LastSend | null): boolean {
  const sent = lastSend?.text.trim() ?? ''
  if (!sent) return false
  const prompt = edge.prompt.trim()
  return prompt === sent || (sent.length >= LAST_SEND_MAX_CHARS && prompt.startsWith(sent))
}

/** One row of the Handoffs list: the edge, the bot on the other end, and which
 *  way the work went. */
export interface HandoffRow {
  edge: DelegationEdge
  partner: string
  inbound: boolean
}

/** What the Overview makes of the delegation graph. */
export interface HandoffView {
  /** The bot that sent the prompt the Last-exchange card is showing, when a bot
   *  sent it. `undefined` ⇒ the owner did, and the card says "You asked". */
  askedBy?: string
  /** The handoffs worth listing — newest first, MINUS the edge the card is
   *  already rendering as its headline. */
  rows: HandoffRow[]
}

/** More than three is a graph view, and this is a glance. */
const HANDOFF_MAX = 3

export function handoffView(
  data: DelegationsView | undefined,
  lastSend: LastSend | null,
): HandoffView {
  const edges: HandoffRow[] = [
    ...(data?.incoming ?? []).map((e) => ({ edge: e, partner: e.from_session, inbound: true })),
    ...(data?.outgoing ?? []).map((e) => ({ edge: e, partner: e.to_session, inbound: false })),
  ].sort((a, b) => b.edge.ts - a.edge.ts)

  // The INBOUND edge carrying the last send IS the card's headline. It stands
  // down here rather than repeat the partner, the prompt and the timestamp two
  // sections apart; the card names the sender in its own label instead.
  const asked = edges.find((r) => r.inbound && isLastSend(r.edge, lastSend))
  return {
    askedBy: asked?.partner,
    rows: edges.filter((r) => r !== asked).slice(0, HANDOFF_MAX),
  }
}

/** Role presets that ADD a durable job to the role/desc textarea. Picking one
 *  INSERTS its paragraph (at the caret, or into an empty field as the whole
 *  text) — it never replaces what is already written, and the row under the
 *  field offers a one-tap Undo. The user edits from there and blur saves. */
const ROLE_PRESETS: { label: string; text: string }[] = [
  {
    label: 'Reviewer',
    text: 'You review changes for correctness and clarity. Read the diff, flag real bugs and risky edits, and keep feedback specific and actionable. Never merge; report findings.',
  },
  {
    label: 'Builder',
    text: 'You implement features end to end. Prefer small, verifiable steps; run the tests before claiming done; keep changes scoped to the task.',
  },
  {
    label: 'Researcher',
    text: 'You investigate and explain. Search broadly, cite the files you read, and return a structured answer — findings first, then the evidence.',
  },
  {
    label: 'Ops',
    text: 'You keep things running. Watch health, act on failures, prefer the least-destructive recovery, and always say what you changed.',
  },
]

/** The receipt under the instruction field: which preset was applied, the draft
 *  it displaced (`prev`) and the one it produced (`after`, the Undo's guard).
 *  `refused` means the editor turned the Undo down because the field has been
 *  edited since — the row stays, saying so. */
export interface AppliedPreset {
  label: string
  prev: string
  after: string
  refused?: boolean
}

/** What the receipt becomes after an Undo attempt. `restore()` REFUSES once the
 *  field has moved on (reverting then would take the sentences written after the
 *  insert), and clearing the row on a refusal would claim an undo that never
 *  happened — so a refusal keeps the row and re-words it. Pure, so
 *  `tests/unit/bot-panel-settings.test.ts` can pin exactly that. */
export function afterUndo(applied: AppliedPreset, restored: boolean): AppliedPreset | null {
  return restored ? null : { ...applied, refused: true }
}

/* ── section shell (Tailwind, portal-safe) ─────────────────────────────────── */

/** Exported for `<TeamPanel>`, which copies BotPanel's FRAME (tabs, tablist,
 *  scrolling body) but shares its section primitives rather than re-declaring
 *  them — the panels must look like one family, and a second copy would drift.
 *  BotPanel itself is NOT generalised: no `variant` prop crosses the two. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[13px] font-semibold tracking-tight text-foreground">{label}</h3>
        {hint && <p className="text-[12px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

/** The "Applies on next start" advisory — shown after a launch-line change
 *  (model / notes / a grant) so the user knows the live agent was NOT relaunched.
 *  Now carries the one-tap restart that closes the loop (was advice with no
 *  button); a mid-turn bot arms first. */
function RestartHint({ name }: { name: string }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5">
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <ArrowRight className="size-3 shrink-0" aria-hidden />
        Applies on next start — the running agent keeps its current setup.
      </span>
      <RestartToApply name={name} />
    </div>
  )
}

/* ── model picker ──────────────────────────────────────────────────────────── */

/** The empty id is the PROVIDER's default. `lib/model-options` labels it
 *  `Default`, which on a trigger reads as "we don't know what this bot is on" —
 *  the exact hollowness this field was accused of. Same data, honest word; the
 *  allowlist itself stays shared with the create sheet. */
function optionLabel(o: { value: string; label: string }): string {
  return o.value ? o.label : 'Provider default'
}

function ModelPicker({
  name,
  session,
  onRestartAdvised,
}: {
  name: string
  session: ApiSession | null
  onRestartAdvised: () => void
}) {
  const { setModel, pending } = useSessionConfig()
  const options = modelOptions(session?.provider)
  const current = modelOf(session)
  const currentLabel = optionLabel(
    options.find((o) => o.value === current) ?? { value: current, label: current },
  )

  if (options.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        {session?.provider ? `${session.provider} runs one model — no selection.` : 'No model selection.'}
      </p>
    )
  }

  return (
    // `modal={false}` — same reason as the row + actions menus: this picker lives
    // inside the bot-panel's Vaul sheet on a phone, where a modal Radix menu
    // portalled to <body> lands under the drawer's pointer-events:none and reads
    // as dead on touch. See session-actions-menu.tsx for the full note.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={pending}
          data-vr="bot-model-picker"
          className={cn(
            'inline-flex min-h-9 items-center gap-1.5 rounded-[10px] border border-input bg-card px-3 text-[13px] font-medium text-foreground',
            'transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
          )}
        >
          {/* Mono is for model IDS; "Provider default" is a sentence. */}
          <span className={cn(current && 'font-mono')}>{currentLabel}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[180px]">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value || 'default'}
            data-vr="bot-model-option"
            onSelect={() => {
              if (o.value === current) return
              void setModel(name, o.value).then((restart) => {
                if (restart) onRestartAdvised()
              })
            }}
          >
            <span className={cn('flex-1 text-[13px]', o.value && 'font-mono')}>{optionLabel(o)}</span>
            {o.value === current && <Check className="size-4 shrink-0" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* ── notes (memory) editor — launch-injected, read-only to the bot at runtime ── */

function NotesEditor({
  name,
  memory,
  onRestartAdvised,
}: {
  name: string
  memory: string
  onRestartAdvised: () => void
}) {
  const { setMemory, pending } = useSessionConfig()
  const [draft, setDraft] = React.useState(memory)
  const focused = React.useRef(false)
  React.useEffect(() => {
    if (!focused.current) setDraft(memory)
  }, [memory])

  const commit = () => {
    focused.current = false
    const next = draft.trim()
    if (next === (memory ?? '').trim()) return
    void setMemory(name, next).then((restart) => {
      if (restart) onRestartAdvised()
    })
  }

  // The counter reads the DRAFT, not the saved value: the limit is only useful
  // while you are typing past it. It lives here rather than beside each caller
  // so the bot panel and `<TeamPanel>` state the same budget from one place.
  const budget = coreNotesBudget(draft)

  return (
    <>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          focused.current = true
        }}
        onBlur={commit}
        disabled={pending}
        rows={3}
        placeholder="Facts this bot should always have on hand — conventions, endpoints, who owns what…"
        aria-label="Notes this bot keeps"
        data-vr="bot-notes"
        className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      {/* BOTH budgets, because the server truncates on whichever bites first —
          and it is the LINE budget that usually bites on a bulleted index. The
          exceeded number goes amber (never red: the calm error tone the rest of
          the app uses), so the reader can see WHICH one is over. */}
      <p data-vr="bot-notes-budget" className="text-[12px] tabular-nums text-muted-foreground">
        <span className={cn(budget.overLines && 'font-semibold text-status-error')}>
          {budget.lines} / {CORE_MAX_LINES} lines
        </span>
        {' · '}
        <span className={cn(budget.overChars && 'font-semibold text-status-error')}>
          {budget.chars.toLocaleString('en-US')} / {CORE_MAX_CHARS.toLocaleString('en-US')} chars
        </span>
        {' · restart to apply'}
      </p>
    </>
  )
}

/* ── working-dir row (mono + copy + Files link) ────────────────────────────── */

export function WorkingDirRow({ name, dir }: { name: string; dir: string }) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  if (!dir) return <p className="text-sm text-muted-foreground">Not set.</p>
  const copy = () => {
    void navigator.clipboard?.writeText(dir).then(() => {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  return (
    <div className="flex items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[12px] text-foreground">
        {dir}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy working directory"
        title={copied ? 'Copied' : 'Copy'}
        className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? <Check className="size-4 text-status-active-ink" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      </button>
      <Link
        to={`/files/${encodeURIComponent(name)}`}
        aria-label="Open in file browser"
        title="Files"
        className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FolderOpen className="size-4" aria-hidden />
      </Link>
    </div>
  )
}

/* ── the three tabs ────────────────────────────────────────────────────────── */

/** The tab KEY is the durable one — it is router state (`panelTab` in history,
 *  `initialTab`/`infoTab` on the two routes), a bench selector and the
 *  `data-vr-tab` hook — so the config tab stays keyed `'instructions'` even
 *  though its LABEL is now "Setup" (the same key-vs-label split the roster
 *  already uses elsewhere). Exported so the tab contract is asserted against the
 *  real array rather than a test's copy of the strings (`workflows-view.test.tsx`). */
export type TabKey = 'overview' | 'instructions' | 'workflows'
export const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'instructions', label: 'Setup' },
  { key: 'workflows', label: 'Workflows' },
]

/** Re-point a legacy or unknown tab key onto a tab that still exists. The old
 *  five-tab model shipped `'tools'` and `'memory'` as router state; both folded
 *  into Setup (`'instructions'`), so a bookmarked `panelTab: 'tools'` must land
 *  there rather than on a blank body. Pure, so the redirect is unit-testable
 *  without a live panel. */
export function normalizeTab(t?: string | null): TabKey {
  if (t === 'tools' || t === 'memory' || t === 'instructions') return 'instructions'
  if (t === 'overview' || t === 'workflows') return t
  return 'overview'
}

/** LIVE STATE — the row that replaced the 2×2 stat grid.
 *
 *  The grid said one real fact between its four cards (Status) and occupied the
 *  entire fold at 390px doing it. This row says strictly more on one line: the
 *  status word, the tool the agent is running RIGHT NOW, how many subagents it
 *  has out, and the two badges that mean it cannot take a turn at all.
 *
 *  No status DOT here on purpose. `<SessionFace>` in the header, six lines up,
 *  already carries it — and "one fact rendered three times" is precisely what
 *  got the Status card deleted. State is a word here; colour stays on the face.
 *
 *  And it is the ROSTER's word, from `stateWordFor` — not `session.status`
 *  capitalised. The raw enum put `Idle` in this panel while the row it was opened
 *  from said `done` two hundred pixels to the left, and `Active` beside `working`:
 *  one fact, two vocabularies, on screen at the same instant. The `needs` bit the
 *  bucketing wants comes from `useSessionAttention` — the single-row read that
 *  exists for exactly this case (a surface with no roster to hand).
 *
 *  Every badge self-nulls when it has nothing to say (their documented
 *  contract), so they mount unguarded and a calm bot's row is two words. */
function LiveState({
  session,
  lastSend,
}: {
  session: ApiSession | null
  lastSend: LastSend | null
}) {
  const attention = useSessionAttention(session)
  // Gated on a WORKING status, exactly as this component's two other call sites
  // do (`session-tile/tile.tsx`, `focus-mode/focus-header.tsx`). The backend
  // clears `activity` on Stop/SessionEnd, but a stale label survives often
  // enough that the ungated version printed "Idle · ✎ hooks.rs" — two
  // contradicting facts on one line — and, worse, took the slot from the honest
  // `last prompted` tail on exactly the rows that need it.
  const working =
    (session?.status === 'active' || session?.status === 'starting') &&
    Boolean(session?.activity?.trim())
  if (!session) return null

  // `.word` only: `.agents` is the ` · N agents` clause, which `<ActivityLine>`
  // below already renders from the same `agents_live` field.
  const state = stateWordFor(session, groupOf(session, attention.tier === 'needs'))

  return (
    // wrap, never overflow: the badges are the part that grows on a bad day.
    <div
      data-vr="bot-live-state"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]"
    >
      {/* `first-letter:uppercase`, never `capitalize`: the words are the
          roster's own lowercase vocabulary, and `capitalize` would title-case
          "needs you" into "Needs You". Only the line's first letter lifts. */}
      <span className="font-medium first-letter:uppercase text-foreground">{state.word}</span>
      {working ? (
        <>
          <span className="text-muted-foreground" aria-hidden>·</span>
          <ActivityLine
            activity={session.activity}
            // `agents_live`, never the raw `subagents`: the raw count is pinned
            // by a lost `SubagentStop` and would keep the "· N agents" clause
            // alive after the children are gone. Same field the tile passes.
            agentsLive={session.agents_live}
            className="max-w-full flex-1 basis-40 text-[13px]"
          />
        </>
      ) : (
        <span className="text-muted-foreground">
          {/* "last PROMPTED", never "last active": `updated_at` is
              max(last_send, last_started, created_at) and never arrives on the
              SSE delta, so "last active" would be a second small lie in a row
              that exists to stop telling them. */}
          · {lastSend ? `last prompted ${formatRecallTime(lastSend.sentAt)}` : 'never prompted'}
        </span>
      )}
      <ErrorBadge error={session.error} session={session} />
      <BlockedBadge blocked={session.blocked ?? undefined} error={session.error} />
      <UsageChip rateLimits={session.rate_limits ?? undefined} />
    </div>
  )
}

/** LAST EXCHANGE — what the "Latest" bubble was trying to be.
 *
 *  That bubble read `chat_tail ?? task_summary`: one is SSE-delta-only (absent
 *  on every fresh open, as `session-row.tsx` already documents) and the other
 *  has no server producer at all, so it rendered blank every single time. Two
 *  layers instead, so the block is never empty and never expensive:
 *
 *    1 · the prompt off the session row — free, present on 34/36 live rows;
 *    2 · one `?chat=true` recall page (measured 200 / 2.2 ms / 5.9 KB at
 *        limit=8) for the reply, its receipts, and any inbound delegation.
 *
 *  ONE tap target, not five 18px ones: everything in here opens the thread. */
function LastExchangeBlock({
  name,
  lastSend,
  askedBy,
  onOpenThread,
}: {
  name: string
  lastSend: LastSend | null
  /** The bot that delegated this send, from the graph ([`handoffView`]). */
  askedBy?: string
  onOpenThread: () => void
}) {
  const recall = useQuery({
    queryKey: ['bot-last-exchange', name],
    queryFn: () => sessionsApi.recall(name, { chat: true, limit: 8 }),
    staleTime: 30_000,
    retry: false,
  })
  const exchange = React.useMemo(
    () => lastExchange(recall.data?.entries ?? [], lastSend),
    [recall.data, lastSend],
  )
  const replied = Boolean(exchange.answer || exchange.receipts.length > 0)

  // Nothing on the row AND nothing on the wire. One muted line — an empty card
  // with a heading is the shape this redesign exists to remove. Unreachable is
  // NOT empty, so a failed read says so rather than claiming silence.
  if (!lastSend && !replied && !recall.isLoading) {
    return (
      <p className="text-[13px] text-muted-foreground">
        {recall.isError
          ? 'Couldn’t read this bot’s history.'
          : 'No conversation yet — open the thread to start one.'}
      </p>
    )
  }

  return (
    <Field label="Last exchange">
      <button
        type="button"
        onClick={onOpenThread}
        data-vr="bot-last-exchange"
        className="flex min-h-11 w-full flex-col gap-2.5 rounded-2xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {lastSend && (
          <div className="flex w-full flex-col gap-0.5">
            {/* "You asked" is FALSE for bot→bot work, and this panel is about a
                company of bots: `last_send_text` is the last prompt written into
                the session whoever wrote it. When the graph says a bot handed it
                in, that bot is named here — which is also where the card's old
                "↳ from X" footer went, so the fact is stated once. */}
            <span className="text-[11.5px] font-medium text-muted-foreground">
              {askedBy ? `${askedBy} asked` : 'You asked'} · {formatRecallTime(lastSend.sentAt)}
            </span>
            <span className="line-clamp-3 text-[13px] leading-relaxed text-foreground">
              {lastSend.text}
            </span>
          </div>
        )}

        {recall.isLoading ? (
          <div className="h-16 w-full animate-pulse rounded-xl border border-border bg-muted/30" />
        ) : recall.isError ? (
          <span className="text-[12.5px] text-muted-foreground">
            Couldn’t read this bot’s history.
          </span>
        ) : (
          replied && (
            <div className="flex w-full flex-col gap-1.5">
              {exchange.answer && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11.5px] font-medium text-muted-foreground">It answered</span>
                  <span className="line-clamp-2 text-[13px] leading-relaxed text-foreground">
                    {exchange.answer}
                  </span>
                </div>
              )}
              {exchange.receipts.map((r, i) => (
                <span
                  key={`${r.label}-${i}`}
                  className={cn(
                    'flex items-baseline gap-2 text-[12.5px]',
                    r.ok ? 'text-muted-foreground' : 'text-status-error',
                  )}
                >
                  <span aria-hidden>{r.ok ? '✓' : '✗'}</span>
                  <span className="min-w-0 truncate">{r.label}</span>
                </span>
              ))}
            </div>
          )
        )}
      </button>
    </Field>
  )
}

/** HANDOFFS — who hands this bot work, and who it hands work to.
 *
 *  The delegation graph has been typed and served since migration 0005 and is
 *  rendered by nothing in the product. In a company-of-bots product it is the
 *  one fact on this panel that is ABOUT being a company of bots, and it is
 *  already populated on real sessions.
 *
 *  Strictly conditional: no edges ⇒ no section, no empty card, no zero count.
 *  A failed read renders nothing too — an error banner about a graph the user
 *  did not ask for is noise.
 *
 *  The graph is fetched by `<OverviewTab>` and selected by [`handoffView`],
 *  because the Last-exchange card above needs the same edges: it names the bot
 *  that handed the work in, and the row it names stands down here. */
function Handoffs({
  rows,
  onNavigate,
}: {
  rows: HandoffRow[]
  onNavigate: (name: string) => void
}) {
  if (rows.length === 0) return null

  return (
    <Field label="Handoffs" hint="Work passed to this bot, and work it passed on.">
      <div className="flex flex-col">
        {rows.map(({ edge: e, partner, inbound }) => (
          <button
            key={e.id}
            type="button"
            onClick={() => onNavigate(partner)}
            data-vr="bot-handoff"
            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-1 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="shrink-0 text-[13px] font-medium text-foreground">
              <span aria-hidden>{inbound ? '←' : '→'}</span> {partner}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
              {e.prompt}
            </span>
            <span className="shrink-0 text-[11.5px] text-muted-foreground">
              {/* Epoch SECONDS on the wire — the same conversion `useLastSend`
                  does for `last_send_at`. */}
              {formatRecallTime(new Date(e.ts * 1000))}
            </span>
          </button>
        ))}
      </div>
    </Field>
  )
}

function OverviewTab({
  name,
  session,
  onOpenThread,
  onNavigate,
}: {
  name: string
  session: ApiSession | null
  onOpenThread: () => void
  onNavigate: (name: string) => void
}) {
  const dir = session?.dir?.trim() || ''
  // `last_send_at` is epoch SECONDS, not an ISO string — the hook owns that
  // conversion, and reading the field by hand is how the old code would have
  // silently rendered nothing.
  const lastSend = useLastSend(session ?? undefined)
  const asking = session?.status === 'waiting' && Boolean(session.waiting_message?.trim())
  // ONE read of the delegation graph for the two blocks that need it — the card
  // (who asked) and the list (everything else). Two components each fetching it
  // would be two chances to disagree about the same edge.
  const graph = useQuery({
    queryKey: ['bot-handoffs', name],
    queryFn: () => agentsApi.delegations(name),
    staleTime: 60_000,
    retry: false,
  })
  const handoffs = React.useMemo(() => handoffView(graph.data, lastSend), [graph.data, lastSend])

  return (
    // TWO REGIONS, not one column of loose things: what this bot is DOING (live,
    // read-only) and then, under a hairline, the details you can act on. Single
    // column throughout — the 2×2 grid is what put a fold full of em-dashes in
    // front of every phone user.
    <div className="flex flex-col gap-5">
      <LiveState session={session} lastSend={lastSend} />

      {asking && (
        <Field label="Needs you">
          {/* The ask's OWN sentence, and nothing else: `Open thread` in the
              header is the resolution. A second answering surface here would be
              a second place for the same reply to go wrong. */}
          <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
            {session?.waiting_message}
          </p>
        </Field>
      )}

      <LastExchangeBlock
        name={name}
        lastSend={lastSend}
        askedBy={handoffs.askedBy}
        onOpenThread={onOpenThread}
      />

      <Handoffs rows={handoffs.rows} onNavigate={onNavigate} />

      <div className="flex flex-col gap-6 border-t border-border pt-5">
        <Field label="Tags" hint="Searchable across the roster.">
          <TagsEditor name={name} tags={session?.tags ?? []} />
        </Field>

        <Field label="Working directory">
          <WorkingDirRow name={name} dir={dir} />
        </Field>
      </div>
    </div>
  )
}

/** The "What this bot does" block — the role/desc textarea, the preset pills
 *  that INSERT (never overwrite) a durable job, and the transient undo receipt.
 *  Pulled out of `InstructionsTab` so the folded Setup tab and `<TeamPanel>`'s
 *  Setup tab share ONE implementation of the pill/undo contract rather than two
 *  that could drift. */
function RoleField({ name, session }: { name: string; session: ApiSession | null }) {
  const desc = session?.desc ?? ''
  // The pills drive the EDITOR, not the row. Writing `desc` behind the field's
  // back is what made one stray tap destroy an authored instruction: the PATCH
  // replaced the whole value and the editor re-seeded from it, with nothing to
  // undo. Through the handle a preset is an ordinary edit — inserted, still
  // uncommitted, reversible.
  const editor = React.useRef<DescEditorHandle | null>(null)
  // The last preset applied, the draft it displaced, and the one it produced.
  // One step is enough: the undo row is a way back from a mis-tap, not a
  // history — and `after` is what keeps a late Undo from eating the sentences
  // the user wrote in the meantime (the editor refuses a moved-on field).
  const [applied, setApplied] = React.useState<AppliedPreset | null>(null)
  // The receipt is transient — a way back from the tap you just made, not a
  // banner that outlives it. It clears itself after a beat (and on the next
  // preset, which replaces it).
  React.useEffect(() => {
    if (!applied) return
    const t = setTimeout(() => setApplied(null), 12_000)
    return () => clearTimeout(t)
  }, [applied])

  return (
    <Field
      label="What this bot does"
      hint="The durable role, injected into the agent's system prompt at launch — this steers every turn. Tasks still go in the message; this is the standing job."
    >
      <div className="flex flex-wrap gap-1.5">
        {ROLE_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            data-vr="bot-role-preset"
            aria-label={`Add the ${p.label} role to these instructions`}
            // Do NOT take focus off the textarea: a blur here would commit a
            // half-typed draft and the insert would then land in a stale one.
            // The pill edits the field the user is still standing in.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const done = editor.current?.insert(p.text)
              if (done) setApplied({ label: p.label, prev: done.prev, after: done.next })
            }}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border bg-secondary px-3.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            {p.label}
          </button>
        ))}
      </div>
      <DescEditor ref={editor} name={name} desc={desc} />
      {applied && (
        <div
          role="status"
          data-vr="bot-role-undo-row"
          data-vr-refused={applied.refused ? 'yes' : undefined}
          className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground"
        >
          {applied.refused ? (
            <>
              {/* The Undo was REFUSED, and says so. Clearing the row here would
                  read as "undone" while the field still holds the preset. */}
              <span>Can’t undo — you’ve edited since.</span>
              <button
                type="button"
                data-vr="bot-role-undo-dismiss"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setApplied(null)}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Dismiss
              </button>
            </>
          ) : (
            <>
              <span>Added “{applied.label}” to your instructions.</span>
              <button
                type="button"
                data-vr="bot-role-undo"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  setApplied(afterUndo(applied, editor.current?.restore(applied.prev, applied.after) ?? false))
                }
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Undo2 className="size-3.5 shrink-0" aria-hidden />
                Undo
              </button>
            </>
          )}
        </div>
      )}
    </Field>
  )
}

/** The launch internals — MCP, flags, worktree, runtime — behind ONE disclosure.
 *  These are the "nerdy" bits the owner wanted folded away, not deleted: shown
 *  on demand, never in the resting surface. Shared by the Setup tab and by
 *  `<TeamPanel>`'s `ToolsTab`.
 *
 *  The `Skills` row is gone: it printed the hardcoded string "Workspace
 *  defaults", because `sessions.skills` is a reserved column whose own doc says
 *  nothing consumes it yet. And MCP / Worktree render only when SET — otherwise
 *  Advanced opened onto a column reading None / No / None, which is furniture
 *  wearing the costume of data. Flags and Runtime are real on every row. */
function LaunchInternals({ session }: { session: ApiSession | null }) {
  const mcp = session?.mcp?.trim() || ''
  const flags = session?.flags?.trim() || ''
  return (
    <details className="group rounded-xl border border-border bg-card px-4 py-3">
      <summary className="cursor-pointer list-none text-[13px] font-medium text-foreground [&::-webkit-details-marker]:hidden">
        Advanced
      </summary>
      <dl className="mt-3 flex flex-col gap-2 text-[13px]">
        {mcp && (
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">MCP</dt>
            <dd className="min-w-0">
              <code className="block max-w-full truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[12px] text-foreground">
                {mcp}
              </code>
            </dd>
          </div>
        )}
        {/* The SAME stacked shape as MCP above, for the same reason: a launch
            line is long. It also has to be a BLOCK box — on `<code>`'s default
            `display: inline` both `truncate` and `max-w-full` are inert, and the
            longest real flag lines (`--dangerously-skip-permissions
            --permission-mode bypassPermissions`) then pushed the whole tab panel
            sideways at 390px instead of clipping inside it. */}
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">Flags</dt>
          <dd className="min-w-0">
            {flags ? (
              <code className="block max-w-full truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[12px] text-foreground">
                {flags}
              </code>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </dd>
        </div>
        {session?.worktree && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Worktree</dt>
            <dd>Yes</dd>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Runtime</dt>
          <dd className="capitalize">{session?.runtime ?? '—'}</dd>
        </div>
      </dl>
    </details>
  )
}

/** The model field's hint, shared by both Setup surfaces so they cannot drift.
 *
 *  The field was called "Model" and read as hollow because it looks like a
 *  READOUT and is not one: there is no live-model signal on the wire (`model` is
 *  empty on every live row), and this control writes the launch line. Saying so
 *  is the whole fix — the write path itself is real and the server 400s an
 *  unknown id. */
const LAUNCH_MODEL_HINT =
  'Passed as --model when this bot next starts. It is not a reading of the model a running agent is on.'

/** Core notes are the reachable half of the memory gate (`session_has_memory`),
 *  so the field that turns the tier on should say that it does. */
const MEMORY_SWITCH_HINT = 'This is also what turns this bot’s memory on.'

/** The LEAD's instructions, verbatim, when `<TeamPanel>` mounts it — a crew is
 *  steered by steering its lead, so there is exactly ONE instructions surface.
 *  Kept for `<TeamPanel>`, which composes it with `<ToolsTab>` into its own
 *  Setup tab; the bot panel folds the same pieces inline via `<SetupTab>`. */
export function InstructionsTab({
  name,
  session,
  onRestartAdvised,
}: {
  name: string
  session: ApiSession | null
  onRestartAdvised: () => void
}) {
  return (
    <div className="flex flex-col gap-6">
      <RoleField name={name} session={session} />
      <Field label="Launch model" hint={LAUNCH_MODEL_HINT}>
        <ModelPicker name={name} session={session} onRestartAdvised={onRestartAdvised} />
      </Field>
      <Field
        label="Notes this bot keeps"
        hint={`Injected read-only into the system prompt at launch — the bot can read these, but not rewrite them. ${MEMORY_SWITCH_HINT}`}
      >
        <NotesEditor name={name} memory={session?.memory ?? ''} onRestartAdvised={onRestartAdvised} />
      </Field>
      <Field label="Notifications">
        <NotifPolicyControl name={name} value={session?.notif} />
      </Field>
    </div>
  )
}

/** The lead's tools. `<TeamPanel>` mounts this crew-scoped: a teammate pane
 *  inherits the lead's env/config, so the lead's grants ARE the crew's grants. */
export function ToolsTab({ name, session }: { name: string; session: ApiSession | null }) {
  return (
    <div className="flex flex-col gap-6">
      {/* Connectors are the HERO — the real, per-bot action surface — so they
          lead; the launch internals fold behind Advanced below. */}
      <GrantedConnectors name={name} />
      <LaunchInternals session={session} />
    </div>
  )
}

/** A hairline group divider inside a tab — the same rule the Overview tab uses
 *  to split the glance from the details: a quiet rule between altitudes, not a
 *  heavy heading, so the folded Setup tab reads as calm sections rather than one
 *  long column of loose fields. */
function Group({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6 border-t border-border pt-6 first:border-t-0 first:pt-0">
      {children}
    </div>
  )
}

/** SETUP — the one tab that holds everything you CONFIGURE, folded from the old
 *  Instructions + Connectors + Memory tabs. The owner found three separate
 *  settings screens nerdy and redundant (the core-notes editor even appeared on
 *  two of them); here they are four calm groups, hairline-separated, with the
 *  launch internals under a single Advanced disclosure.
 *
 *   1 · Behavior   — the role, the model, the core notes it always carries.
 *   2 · Connectors — the real per-bot action surface.
 *   3 · Memory     — what the bot has LEARNED across runs.
 *   4 · Delivery   — how it notifies you, then the Advanced internals. */
function SetupTab({
  name,
  session,
  onRestartAdvised,
}: {
  name: string
  session: ApiSession | null
  onRestartAdvised: () => void
}) {
  const memory = session?.memory ?? ''
  return (
    <div className="flex flex-col gap-6">
      {supportsBrowserFeedback(session?.provider) && <BrowserFeedbackCard key={name} session={name} label={session?.display_name || name} remote={session?.host_id != null} />}
      <Group>
        <RoleField name={name} session={session} />
        <Field label="Launch model" hint={LAUNCH_MODEL_HINT}>
          <ModelPicker name={name} session={session} onRestartAdvised={onRestartAdvised} />
        </Field>
        <Field
          label="Notes this bot keeps"
          hint={`Kept verbatim and injected into the system prompt every run — the bot reads these, but can't rewrite them. ${MEMORY_SWITCH_HINT}`}
        >
          <NotesEditor name={name} memory={memory} onRestartAdvised={onRestartAdvised} />
        </Field>
      </Group>

      <Group>
        {/* Bare, not wrapped in a `<Field label="Connectors">`: the component
            draws its own "Connectors" heading and hint, and the wrapper stacked
            a second copy of the word above them — four lines of chrome for one
            section, and the tab's worst spacing moment at 390px. */}
        <GrantedConnectors name={name} />
      </Group>

      <Group>
        <LearnedNotes name={name} />
      </Group>

      <Group>
        <Field label="Notifications">
          <NotifPolicyControl name={name} value={session?.notif} />
        </Field>
        <LaunchInternals session={session} />
      </Group>
    </div>
  )
}

function WorkflowsTab({
  name,
  onNavigate,
}: {
  name: string
  onNavigate: (name: string) => void
}) {
  const [issuesOpen, setIssuesOpen] = React.useState(false)
  const [openIssueId, setOpenIssueId] = React.useState<string | null>(null)
  const { session } = useSession(name)

  return (
    <div className="flex flex-col gap-6">
      {/* The list carries its own heading and its own "+ New workflow" — one
          implementation of a workflow list, scoped, rather than a second one
          that would start disagreeing with /workflows about what a card says. */}
      <WorkflowsView variant="panel" scope={name} />

      <Field label="Recent runs">
        <RecentRuns session={name} limit={5} />
      </Field>

      <Field label="Issues">
        <div className="flex flex-col gap-2">
          <IssueList
            session={name}
            onOpen={(issue) => {
              setOpenIssueId(issue.id)
              setIssuesOpen(true)
            }}
          />
          <button
            type="button"
            onClick={() => {
              setOpenIssueId(null)
              setIssuesOpen(true)
            }}
            className="self-start rounded-md px-1 py-1 text-xs text-primary hover:underline"
          >
            Open issues →
          </button>
        </div>
      </Field>
      <IssueSurface
        open={issuesOpen}
        onOpenChange={setIssuesOpen}
        initialIssueId={openIssueId}
        session={name}
        title={displayLabel(session ?? { name })}
        onFocusSession={(target) => {
          setIssuesOpen(false)
          onNavigate(target)
        }}
      />

      <Field label="Git">
        <GitRow name={name} />
      </Field>
    </div>
  )
}

/* ── the panel body (shared by both variants) ──────────────────────────────── */

function BotPanelBody({
  name,
  variant,
  onOpenThread,
  onOpenTerminal,
  onNavigate,
  initialTab,
}: {
  name: string
  variant: 'pane' | 'sheet'
  onOpenThread: () => void
  /** When set, this bot cannot be a chat surface (Codex/shell/remote/team-lead),
   *  so the header offers "Open terminal →" (→ /focus) INSTEAD of "Open thread". */
  onOpenTerminal?: () => void
  onNavigate: (name: string) => void
  /** Dev/bench only: seat a specific tab so a still frame can show each one. */
  initialTab?: TabKey
}) {
  const { session } = useSession(name)
  const clone = useCloneSession()
  const { toast } = useToast()
  // `normalizeTab` re-points a stale deep-link (a bookmarked `tools`/`memory`
  // panelTab from the five-tab era) onto the tab that absorbed it, so the panel
  // never opens on a body that no longer renders.
  const [tab, setTab] = React.useState<TabKey>(() => normalizeTab(initialTab))
  const [restartAdvised, setRestartAdvised] = React.useState(false)
  const onRestartAdvised = React.useCallback(() => setRestartAdvised(true), [])

  // ONE scroller serves all three tabs, so a tab switch used to keep the
  // previous tab's offset: from a scrolled Overview, the header's own "Say what
  // this bot does →" opened Setup at Notifications/Advanced — past the field it
  // names, which for an unconfigured bot is the whole point of the tap. A tab is
  // a new body; it starts at its own top. Layout effect, so the reset lands in
  // the same paint as the new body rather than as a visible jump.
  const body = React.useRef<HTMLDivElement | null>(null)
  React.useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0
  }, [tab])

  const label = displayLabel(session ?? { name })
  // The sub-line is the bot's STANDING JOB, not `status · model · branch` — two
  // of those three are empty on every live row, so it collapsed to "idle ·
  // claude" on every bot and restated the face dot for the third time. An
  // unconfigured bot gets the product's actual next action instead of a blank.
  const role = session?.desc?.trim() ?? ''

  const doClone = async () => {
    if (clone.pending) return
    try {
      const newName = await clone.run(name)
      toast({ message: `Cloned to ${newName}`, tone: 'active' })
      onNavigate(newName)
    } catch (e) {
      toast({ message: `Clone failed — ${(e as Error).message}`, tone: 'error', duration: 4000 })
    }
  }

  return (
    <div className={cn('flex min-h-0 flex-col', variant === 'pane' && 'h-full')}>
      {/* sticky header — face · editable name · sub-line · Open thread · [...]
          The `pane` variant is FULL-SCREEN on a phone (the grok roster's detail
          view), so its top runs under the iOS status bar / Dynamic Island unless
          it reserves the inset — the same fix Overview/Files/Connectors got.
          `env(safe-area-inset-top)` is 0 on desktop and in a normal browser tab,
          so this is a no-op off a notched standalone PWA; `max()` keeps the base
          0.75rem there. The `sheet` variant is a bottom drawer — never under the
          status bar — so it keeps the plain `py-3`. */}
      {/* ONE identity header (no generic "Bot" bar above it anymore). Two calm
          rows: the face + editable name lead; the status line and the single
          primary action sit below with room to breathe — the airy hierarchy the
          cramped one-row version lacked. */}
      <header
        className={cn(
          'flex flex-col gap-3 border-b border-border bg-background/80 px-5 pb-4 backdrop-blur-sm',
          variant === 'pane'
            ? 'pt-[max(0.875rem,env(safe-area-inset-top))]'
            : 'pt-4',
        )}
      >
        <div className="flex items-start gap-3.5">
          <SessionFace name={name} status={session?.status} size={48} />
          {/* The name is the title — one clean line, no bordered field and no
              second "id" row (that clutter is what made the old header read as a
              form). Rename lives in the ⋯ menu, reachable right beside it. */}
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 className="truncate text-[19px] font-semibold leading-tight tracking-tight text-foreground">
              {label}
            </h2>
          </div>
          {session && (
            <SessionActionsMenu
              session={session}
              variant="row"
              className="!static !size-9 !opacity-100 -mr-2 -mt-1 flex-none"
            />
          )}
        </div>
        {/* The standing job gets its OWN line. Sharing a row with the action
            pill left it ~188px at 390px, so a 160-character role rendered as
            "You keep things running. Wa…" on the device this panel is designed
            for — the one thing the header was rebuilt to say, cut to a fragment.
            Two clamped lines carry a real sentence; the action moves below. */}
        <div className="flex flex-col items-start gap-2.5">
          {role ? (
            // No `capitalize` here: `desc` is a sentence the owner wrote, not a
            // status word, and title-casing it reads as a bug.
            <span
              data-vr="bot-role-line"
              className="line-clamp-2 w-full text-[13px] leading-snug text-muted-foreground"
            >
              {role}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setTab('instructions')}
              data-vr="bot-role-cta"
              className="-ml-1 inline-flex min-h-9 items-center rounded-md px-1 text-left text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Say what this bot does →
            </button>
          )}
          {onOpenTerminal ? (
            <button
              type="button"
              onClick={onOpenTerminal}
              data-vr="bot-open-terminal"
              className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 text-[13.5px] font-medium text-primary-foreground shadow-sm transition-[background-color,transform] hover:bg-primary/90 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Terminal className="size-3.5" aria-hidden />
              Open terminal
              <ArrowRight className="size-3.5" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenThread}
              data-vr="bot-open-thread"
              className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 text-[13.5px] font-medium text-primary-foreground shadow-sm transition-[background-color,transform] hover:bg-primary/90 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open thread
              <ArrowRight className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      </header>

      {/* tab bar — an EQUAL-WIDTH segmented control. Each tab is `flex-1
          basis-0`, so three of them divide the width instead of overflowing it:
          the bar fits at 320px with no horizontal scroll and no cut-off tab (the
          five-tab version scrolled sideways on a phone and clipped its last
          tab). The BODY scrolls; this bar never does.

          A plain `div` carries `role="tablist"` (a `nav` is a landmark and may
          not take an interactive role: jsx-a11y/no-noninteractive-element-to-
          interactive-role). Full WAI-ARIA tab pattern: roving `tabindex`,
          arrow-key movement, and each tab `aria-controls` the one panel it
          drives (`aria-labelledby` points back). */}
      <div
        role="tablist"
        aria-label="Bot settings"
        className="flex w-full shrink-0 items-stretch border-b border-border px-2"
      >
        {TABS.map((t, ti) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`bot-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls="bot-tabpanel"
            tabIndex={tab === t.key ? 0 : -1}
            data-vr="bot-tab"
            data-vr-tab={t.key}
            onClick={() => setTab(t.key)}
            // Roving-tabindex arrow movement lives on the tabs themselves (they
            // are the focusable elements); the tablist container stays a plain,
            // non-focusable grouping so it needs no tabindex.
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
              e.preventDefault()
              const next =
                e.key === 'ArrowRight'
                  ? (ti + 1) % TABS.length
                  : (ti - 1 + TABS.length) % TABS.length
              setTab(TABS[next].key)
              e.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]
                ?.focus()
            }}
            className={cn(
              'relative -mb-px min-h-11 flex-1 basis-0 px-2 text-center text-[13px] font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              tab === t.key
                ? 'text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* scrolling tab body */}
      <div
        ref={body}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-5 py-5 [scrollbar-width:thin]',
          variant === 'sheet' && 'max-h-[70vh]',
        )}
        role="tabpanel"
        id="bot-tabpanel"
        aria-labelledby={`bot-tab-${tab}`}
        tabIndex={0}
      >
        {restartAdvised && <div className="mb-4"><RestartHint name={name} /></div>}
        {tab === 'overview' && (
          <OverviewTab
            name={name}
            session={session}
            onOpenThread={onOpenThread}
            onNavigate={onNavigate}
          />
        )}
        {tab === 'instructions' && (
          <SetupTab name={name} session={session} onRestartAdvised={onRestartAdvised} />
        )}
        {tab === 'workflows' && <WorkflowsTab name={name} onNavigate={onNavigate} />}

        {/* Clone — the panel's footer action, on every tab's scroll floor */}
        <div className="mt-8 border-t border-border pt-5">
          <button
            type="button"
            onClick={doClone}
            disabled={clone.pending}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent/40 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {clone.pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <FilesIcon className="size-4" aria-hidden />}
            {clone.pending ? 'Cloning…' : 'Clone bot in this directory'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── the public component ──────────────────────────────────────────────────── */

export interface BotPanelProps {
  name: string
  variant: 'pane' | 'sheet'
  /** Navigate to the bot's focus thread. */
  onOpenThread: () => void
  /** pane only, ineligible bots: show "Open terminal →" (→ /focus) in the header
   *  instead of "Open thread", since this bot cannot render as a chat surface. */
  onOpenTerminal?: () => void
  /** Navigate to a session's focus route (used by Clone + issue focus). */
  onNavigate: (name: string) => void
  /** sheet only. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Dev/bench only: seat a specific tab so a still frame can show each one. */
  initialTab?: TabKey
}

export function BotPanel({
  name,
  variant,
  onOpenThread,
  onOpenTerminal,
  onNavigate,
  open,
  onOpenChange,
  initialTab,
}: BotPanelProps) {
  if (variant === 'sheet') {
    return (
      <ResponsiveSheet
        open={open ?? false}
        onOpenChange={onOpenChange ?? (() => {})}
        // The body draws its OWN identity header (face · name · status · Open
        // thread), so suppress the sheet's generic bar — it was stacking a second
        // "Bot / <name>" title above the real one (the triple-name clutter).
        title={name}
        hideHeader
        className="max-w-2xl"
      >
        {/* `data-grok` so the sheet (portalled to <body>, outside the shell root)
            still resolves the Grok accent tokens, exactly like command-palette. */}
        <div data-grok>
          <BotPanelBody
            name={name}
            variant="sheet"
            initialTab={initialTab}
            onOpenThread={() => {
              onOpenChange?.(false)
              onOpenThread()
            }}
            onNavigate={(n) => {
              onOpenChange?.(false)
              onNavigate(n)
            }}
          />
        </div>
      </ResponsiveSheet>
    )
  }

  return (
    <div className="gr-pane gr-botpane" data-shell-pane>
      <BotPanelBody
        name={name}
        variant="pane"
        onOpenThread={onOpenThread}
        onOpenTerminal={onOpenTerminal}
        onNavigate={onNavigate}
        initialTab={initialTab}
      />
    </div>
  )
}

export default BotPanel
