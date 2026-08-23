import {
  AutoHealToggle,
  RecoveryLadder,
} from '@/components/recovery/recovery-ladder'
/** The `prefs` k/v key behind the automatic recovery switch. Mirrors
 *  `db::prefs::AUTO_HEAL_PREF_KEY` — one string, both sides. */
const AUTO_HEAL_KEY = 'recovery.auto_heal'
import * as React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useScroll,
  useTransform,
  type Variants,
} from 'framer-motion'
import {
  ArrowUpCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronsUpDown,
  Loader2,
  PlayCircle,
  RefreshCw,
  SlidersHorizontal,
  Store as StoreIcon,
  X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import {
  adoptNewBuild,
  fetchServedSha,
  isNewerServedSha,
  isRealSha,
} from '@/lib/version-guard'
import { appVersion, authToken, baseUrl } from '@/env'
import { MISC, ONBOARDING } from '@/brand/copy'
import {
  forgetDemoSession,
  getDemoSession,
  resetFirstLaunch,
} from '@/lib/onboarding'
import { onboardingApi } from '@/lib/api'
import { useTheme, type Theme } from '@/components/theme-provider'
import {
  useUI,
  type ViewMode,
  type HoverPreview,
  type OverviewPreview,
} from '@/stores/ui-store'
import { useAgentToolsSheet } from '@/stores/claude-tools-store'
import { botModeOn, BOT_KILL_SWITCH_KEY } from '@/lib/bot-mode-flag'
import { GROK_KILL_SWITCH_KEY } from '@/lib/grok-mode-flag'
import { useConnectors } from '@/stores/connectors-store'
import { getSoundsEnabled, playTone, primeAudio, setSoundsEnabled } from '@/lib/sound'
import { pushApi, type NotifCategory, type PushAttempt, type PushPrefs } from '@/lib/api'
import { usePush } from '@/hooks/use-push'
import {
  useAgentTeams,
  useEnvKeys,
  usePatchAgentTeams,
  usePatchDefaultModel,
  usePatchEnvKeys,
  useRegenerateToken,
} from '@/hooks/use-settings'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { settingsApi } from '@/lib/api/settings'
import {
  Row,
  Section,
  SegmentedControl,
  Switch,
  listContainer,
} from '@/components/settings/primitives'
import {
  CopyButton,
  MaskedKeyField,
  RevealableSecret,
} from '@/components/settings/secret-field'
import { SnippetsSection } from '@/components/settings/snippets-section'
import { HostsSection } from '@/components/settings/hosts-section'
import { SchedulesSection } from '@/components/settings/schedules-section'
import { AuditLog } from '@/components/settings/audit-log'
import { UpdatesSection } from '@/components/settings/updates-panel'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const VIEW_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: 'tile', label: 'Tiles' },
  { value: 'list', label: 'List' },
]

const HOVER_OPTIONS: { value: HoverPreview; label: string }[] = [
  { value: 'live', label: 'Live terminal' },
  { value: 'expanded', label: 'Expanded text' },
]

const OVERVIEW_PREVIEW_OPTIONS: { value: OverviewPreview; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'text', label: 'Text' },
]

/** Fixed default-model list. '' = whatever the server is configured to. */
const MODELS: { value: string; label: string }[] = [
  { value: '', label: 'Server default' },
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
]

function ModelPicker() {
  const defaultModel = useUI((s) => s.defaultModel)
  const setDefaultModel = useUI((s) => s.setDefaultModel)
  const patch = usePatchDefaultModel()
  const current = MODELS.find((m) => m.value === defaultModel) ?? MODELS[0]

  function choose(value: string) {
    setDefaultModel(value) // localStorage source of truth (survives restart)
    patch.mutate(value) // best-effort backend sync; failure is non-fatal
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          className="h-11 min-w-[11rem] justify-between gap-2 text-[13px]"
        >
          {current.label}
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        {MODELS.map((m) => (
          <DropdownMenuItem
            key={m.value || 'default'}
            onClick={() => choose(m.value)}
            className="justify-between gap-3"
          >
            {m.label}
            {m.value === current.value ? (
              <Check className="size-4 text-primary" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ApiKeysSection() {
  const { data, isError } = useEnvKeys()
  const patch = usePatchEnvKeys()

  return (
    <Section
      title="API keys"
      footnote={
        isError
          ? 'Stored on the server. The settings endpoint isn’t available yet — keys you save now will fail until it ships.'
          : 'Stored on the server and shown masked. New sessions inherit them.'
      }
    >
      <Row
        stacked={
          <MaskedKeyField
            label="Anthropic"
            currentMasked={data?.ANTHROPIC_API_KEY}
            placeholder="sk-ant-…"
            saving={patch.isPending}
            onSave={(v) => patch.mutate({ ANTHROPIC_API_KEY: v })}
          />
        }
      />
      <Row
        stacked={
          <MaskedKeyField
            label="OpenAI"
            currentMasked={data?.OPENAI_API_KEY}
            placeholder="sk-…"
            saving={patch.isPending}
            onSave={(v) => patch.mutate({ OPENAI_API_KEY: v })}
          />
        }
      />
    </Section>
  )
}

function RegenerateTokenButton({ onRotated }: { onRotated: (token: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const regen = useRegenerateToken()

  function confirm() {
    regen.mutate(undefined, {
      onSuccess: (res) => {
        // Keep the live token on `window` (NOT localStorage).
        window._SUPERMUX_AUTH_TOKEN = res.token
        onRotated(res.token)
        // Drop the cached HTML shell + tell the SW the token
        // rotated, so the next load doesn't serve a doc holding the old token.
        try {
          void caches?.delete?.('supermux-html')
          navigator.serviceWorker?.controller?.postMessage({ type: 'token-rotated' })
        } catch {
          /* no SW / caches in this context — fine */
        }
        setOpen(false)
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        asChild
        variant="outline"
        onClick={() => setOpen(true)}
        className="h-11 gap-1.5"
      >
        <motion.button whileTap={{ scale: 0.96 }} transition={springs.buttonPress}>
          <RefreshCw />
          Regenerate
        </motion.button>
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Regenerate access token?</DialogTitle>
          <DialogDescription>
            The current token stops working everywhere. Other devices and saved
            links will need to reopen supermux from a fresh link.
          </DialogDescription>
        </DialogHeader>
        {regen.isError ? (
          <p className="text-[13px] text-destructive">
            Couldn’t rotate the token — the server didn’t accept the request.
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" className="h-11">
              Cancel
            </Button>
          </DialogClose>
          <Button
            asChild
            variant="destructive"
            onClick={confirm}
            disabled={regen.isPending}
            className="h-11"
          >
            <motion.button whileTap={{ scale: 0.96 }} transition={springs.buttonPress}>
              {regen.isPending ? 'Regenerating…' : 'Regenerate'}
            </motion.button>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Settings → Experimental. The Agent Teams toggle enables running
 *  several Claude agents in parallel for one task. State lives server-side
 *  (default OFF) and takes effect on the next new session. An older server build
 *  that lacks the endpoint surfaces as `isError`: a calm "not supported yet"
 *  footnote + a disabled switch (NEVER red/alarmist — this is opt-in power, not a
 *  failure). The teammateMode is forced server-side and intentionally NOT
 *  user-facing. */
/** B5/T8.4 — the CANONICAL recovery ladder, plus the automatic layer's switch.
 *
 *  Two gaps closed here. The manual rungs existed only as endpoints, so a user
 *  whose terminal died had no vocabulary for what to press. And
 *  `recovery.auto_heal` was a real, allowlisted pref with ZERO UI anywhere in
 *  `web/src` — reachable only by hand-crafting a `PUT /api/prefs`, which means
 *  in practice it could not be turned off at all.
 *
 *  The `#recovery` anchor is what the inline affordance on a dead tile links
 *  to, so "More" lands on this section rather than the top of Settings. */
function RecoverySection() {
  const qc = useQueryClient()
  const { data: autoHeal, isLoading } = useQuery({
    queryKey: ['pref', AUTO_HEAL_KEY],
    queryFn: () => settingsApi.getPref(AUTO_HEAL_KEY),
  })
  const [saving, setSaving] = React.useState(false)

  // Absent means ON: the pref is the operator's off-switch, not an opt-in. A
  // terminal dying under a running agent is a fault, and leaving it dead until
  // a human notices is the incident this whole layer exists to end. Mirrors
  // `db::prefs::auto_heal_enabled`, which reads the same way.
  const enabled = !(
    typeof autoHeal === 'string' && /^(off|false|0|no)$/i.test(autoHeal.trim())
  )

  const setEnabled = React.useCallback(
    (next: boolean) => {
      setSaving(true)
      void settingsApi
        .putPref(AUTO_HEAL_KEY, next ? 'on' : 'off')
        .then(() => qc.invalidateQueries({ queryKey: ['pref', AUTO_HEAL_KEY] }))
        .finally(() => setSaving(false))
    },
    [qc],
  )

  return (
    <Section
      title="Recovery"
      footnote="Each option says what it keeps and what it clears. Pick the highest one that keeps what you still need — they are listed least-destructive first."
    >
      <div id="recovery" className="flex flex-col gap-2 p-3">
        <AutoHealToggle
          enabled={enabled}
          onChange={setEnabled}
          busy={saving || isLoading}
        />
        {/* No session in context here: the list is documentation as much as it
            is a control. Hiding it when nothing is selected would leave the
            vocabulary undiscoverable, which is the gap this section closes. */}
        <RecoveryLadder />
      </div>
    </Section>
  )
}

function ExperimentalSection() {
  const { data, isError } = useAgentTeams()
  const patch = usePatchAgentTeams()
  const enabled = !!data?.enabled
  const botMode = useUI((s) => s.botMode)
  const setBotMode = useUI((s) => s.setBotMode)

  const footnote = isError
    ? 'This server build doesn’t support Agent Teams yet.'
    : 'Runs several Claude agents in parallel for one task — expect roughly a few times the tokens of a single session. Applies only when you start a team.'

  return (
    <Section title="Experimental" footnote={footnote}>
      <Row
        label="Agent Teams"
        control={
          <Switch
            ariaLabel="Enable Agent Teams"
            checked={enabled}
            onCheckedChange={(v) => patch.mutate(v)}
            disabled={isError}
          />
        }
      />
      <Row
        label="Bot mode"
        hint="Your agents become bots: a roster inbox, chat threads instead of terminals, and Grok’s visual language across the app. Terminals stay one tap away. Takes effect on the next reload."
        control={
          <Switch
            ariaLabel="Turn your agents into bots (roster inbox, chat threads, Grok skin)"
            checked={botMode}
            onCheckedChange={setBotMode}
          />
        }
      />
    </Section>
  )
}

function ConnectionSection() {
  const [token, setToken] = React.useState(() => authToken())
  const origin = (() => {
    const b = baseUrl()
    if (b && b !== '/' && b !== import.meta.env.BASE_URL) return b
    return typeof location !== 'undefined' ? location.host : '—'
  })()

  return (
    <Section
      title="Connection"
      footnote="The access token authenticates this device. Treat it like a password — anyone with it can drive your agents."
    >
      <Row
        label="Server"
        control={
          <div className="flex items-center gap-2">
            <span className="max-w-[10rem] truncate font-mono text-[13px] text-muted-foreground">
              {origin}
            </span>
            <CopyButton
              value={typeof location !== 'undefined' ? location.origin : origin}
              label="Copy"
            />
          </div>
        }
      />
      <Row label="Version" control={<span className="font-mono text-[13px] text-muted-foreground">{appVersion()}</span>} />
      <Row
        label="Access token"
        hint="Masked by default. Reveal or copy when you need it."
        stacked={<RevealableSecret value={token} />}
      />
      <Row
        label="Rotate token"
        hint="Invalidate the current token and issue a new one."
        control={<RegenerateTokenButton onRotated={setToken} />}
      />
    </Section>
  )
}

/** Settings → Onboarding. "Run the 30-second demo" clears the
 *  first-launch flag, removes the one demo session supermux booted (if any), then
 *  navigates to `/` so the unboxing replays from a clean slate. */
function OnboardingSection() {
  const navigate = useNavigate()
  const [replaying, setReplaying] = React.useState(false)

  async function replay() {
    if (replaying) return
    setReplaying(true)
    // Remove only the session supermux booted as the demo — never a real one.
    const demo = getDemoSession()
    if (demo) {
      await onboardingApi.deleteSession(demo)
      forgetDemoSession()
    }
    // Clear the flag so OnboardingHost re-arms the unboxing on the next `/`.
    resetFirstLaunch()
    navigate('/')
    // OnboardingHost decides first-launch at mount; a full reload guarantees a
    // fresh mount so the replay always takes effect.
    window.location.reload()
  }

  return (
    <Section title="Onboarding" footnote={ONBOARDING.replayHint}>
      <Row
        label={ONBOARDING.replayLabel}
        hint="Replays the welcome tour and first-run experience."
        control={
          <Button
            asChild
            variant="outline"
            onClick={replay}
            disabled={replaying}
            className="h-11 gap-1.5"
          >
            <motion.button
              whileTap={{ scale: 0.96 }}
              transition={springs.buttonPress}
            >
              <PlayCircle />
              {replaying ? 'Resetting…' : ONBOARDING.replayAction}
            </motion.button>
          </Button>
        }
      />
    </Section>
  )
}

/** Settings → Claude tools. Opens
 *  the same manager sheet the ⌘K command + focus title-bar icon open, scoped to
 *  global (no session in this context). */
function ClaudeToolsSection() {
  const openClaudeTools = useAgentToolsSheet((s) => s.openSheet)
  return (
    <Section
      title="Claude tools"
      footnote="MCP servers, skills, and slash commands across this machine. Secrets stay on the server — only key names are shown."
    >
      <Row
        label="Manage MCP / skills / commands"
        hint="Add, remove, and review what your agents can use."
        control={
          <Button
            asChild
            variant="outline"
            onClick={() => openClaudeTools(null)}
            className="h-11 gap-1.5"
          >
            <motion.button whileTap={{ scale: 0.96 }} transition={springs.buttonPress}>
              <SlidersHorizontal />
              Manage
            </motion.button>
          </Button>
        }
      />
    </Section>
  )
}

function ConnectorsSection() {
  const navigate = useNavigate()
  const { data: connectors } = useConnectors()
  // Defensive: a non-array body from an offline / errored endpoint must not
  // crash the row — coerce before `.filter`.
  const installed = (Array.isArray(connectors) ? connectors : []).filter(
    (c) => c.source === 'local',
  ).length
  return (
    <Section
      title="Connectors"
      footnote="Secure, per-bot integrations. Keys are sealed in the vault and never shown to your bots — one bot, or all agents, your choice."
    >
      <Row
        label="Connector store"
        hint={
          installed > 0
            ? `${installed} installed · browse the catalog and connect more.`
            : 'Browse the catalog and give your bots their first connector.'
        }
        control={
          <Button
            asChild
            variant="outline"
            onClick={() => navigate('/store')}
            className="h-11 gap-1.5"
          >
            <motion.button whileTap={{ scale: 0.96 }} transition={springs.buttonPress}>
              <StoreIcon />
              Open store
            </motion.button>
          </Button>
        }
      />
    </Section>
  )
}

/** A single per-event notification toggle (the user-facing category list).
 *  `label` is what the user sees; `key` is the wire format that the server's
 *  `NotifCategory` enum matches. `hint` answers "when does this fire?" in one
 *  line so the user never has to guess what they're toggling. */
interface NotifTypeSpec {
  key: NotifCategory
  label: string
  hint: string
}

/** The categories, in display order. Kept short on purpose — every extra
 *  toggle is another decision the user has to make AND another row in the
 *  Recent activity diagnostic. Each one maps 1:1 to a distinct
 *  `send_push_for(NotifCategory::*)` call site on the server.
 *
 *  **All six ship ON** (B5, gate G2b). The upstream design had
 *  `agent_finished` shipping OFF; that was declined, because the server already
 *  carries three mitigations aimed at exactly that noise — a 2 s trailing
 *  coalesce, a 15 s window for a team lead bouncing through idle, and a gate
 *  that holds the ping while Task subagents are still in flight. Silently
 *  muting a category people already receive is a worse trade than the noise
 *  those three suppress. An explicit choice here always wins over the default,
 *  in both directions.
 *
 *  These are the GLOBAL half of the mute. The per-BOT half lives in each
 *  session's own info panel, and a push goes out only when both allow it —
 *  see `BRAND.md` §6g for the full tier × policy × category table. */
const NOTIF_TYPES: NotifTypeSpec[] = [
  {
    key: 'agent_waiting',
    label: 'Agent needs you',
    hint: 'When an agent goes idle waiting on your input or asks a board question.',
  },
  {
    key: 'agent_finished',
    label: 'Agent finished',
    hint: 'When an agent finishes its turn — ready for your review.',
  },
  {
    // B5/T3.4 — the sixth category. Distinct from `agent_stopped`, which is the
    // PROCESS going away: this is the agent still running and telling you, in
    // its own words, that the work did not land.
    key: 'agent_error',
    label: 'Agent hit an error',
    hint: 'When a turn ends in an error the agent could not recover from.',
  },
  {
    key: 'agent_stopped',
    label: 'Agent stopped',
    hint: 'When a session ends unexpectedly (the tmux pane goes away).',
  },
  {
    key: 'schedule_error',
    label: 'Scheduled task errored',
    hint: 'When a scheduled task fails. Successful runs are silent on purpose.',
  },
  {
    key: 'schedule_finished',
    label: 'Scheduled task finished',
    hint: 'When a schedule you marked "notify me when done" completes.',
  },
]

/** Human label for the activity row's category column. Matches the server's
 *  `human_label` so a test notification labelled "Agent finished" maps to the
 *  same row in the activity panel. `test` is the generic transport probe. */
function categoryLabel(slug: string): string {
  const known = NOTIF_TYPES.find((t) => t.key === slug)
  if (known) return known.label
  if (slug === 'test') return 'Transport test'
  return slug
}

/** Format an attempt timestamp (server-side Unix seconds) as a short relative
 *  string — the user usually cares about "did THAT recent action ping?" not the
 *  absolute clock time. */
function formatAgo(unixSec: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - unixSec))
  if (delta < 60) return `${delta}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

/** One row in the Recent activity panel. The terse "delivered N · failed N"
 *  summary is the entire point: when the user says "I never got a notification",
 *  the answer is here, not in a log. */
function ActivityRow({ a }: { a: PushAttempt }) {
  const detail = a.muted
    ? 'muted by your preference'
    : a.attempted === 0
      ? 'no devices subscribed'
      : `${a.delivered}/${a.attempted} delivered${
          a.pruned ? ` · ${a.pruned} pruned` : ''
        }${a.failed ? ` · ${a.failed} failed` : ''}`
  // Failed > 0 is the smoking gun the user is hunting for — red the detail.
  const tone = a.failed > 0 ? 'text-destructive' : 'text-muted-foreground'
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[13px]">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{a.title}</div>
        <div className={`truncate text-[12px] ${tone}`}>
          {categoryLabel(a.category)} · {detail}
        </div>
      </div>
      <div className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {formatAgo(a.at)}
      </div>
    </div>
  )
}

/** Settings → Notifications (PUSH milestone + this PR's per-type prefs).
 *
 *  Layout, top-to-bottom:
 *    1. Master toggle — subscribes/unsubscribes the device (Web Push
 *       lifecycle). Without this on, no notification of any kind can arrive.
 *    2. Generic transport test (when subscribed) — verifies the full pipe
 *       (VAPID → push service → SW → phone) bypassing every prefs gate.
 *    3. Per-event toggles — one per `NotifCategory`. Each has a "Test" link
 *       that fires THROUGH the prefs gate, so a click proves routing too.
 *    4. Recent activity — the in-memory ring of the last 10 fan-outs. The
 *       "why didn't my phone ring?" answer is always one glance away.
 *
 *  Degrades gracefully: shows blocked / unsupported states instead of a dead
 *  toggle. iOS requires the PWA installed to the home screen + permission —
 *  that's the `unsupported` state until installed. */
function NotificationsSection() {
  const { state, busy, error, enable, disable } = usePush()
  const enabled = state === 'enabled'

  // Prefs (one round-trip on mount + on re-enable; we own the optimistic UI).
  const [prefs, setPrefs] = React.useState<PushPrefs | null>(null)
  const [prefError, setPrefError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      try {
        const p = await pushApi.getPrefs()
        if (!cancelled) setPrefs(p)
      } catch (e) {
        if (!cancelled) {
          setPrefError(e instanceof Error ? e.message : 'Could not load preferences.')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])

  function togglePref(key: NotifCategory, next: boolean) {
    if (!prefs) return
    // Optimistic — the switch animation must feel instant. Rollback on a server
    // failure (the only legit one is offline / 5xx).
    const prev = prefs
    setPrefs({ ...prefs, [key]: next })
    setPrefError(null)
    void pushApi.putPrefs({ [key]: next }).catch((e) => {
      setPrefs(prev)
      setPrefError(e instanceof Error ? e.message : 'Could not save preference.')
    })
  }

  // The lock-screen message-preview toggle. Same optimistic pattern as
  // `togglePref`, but its key is the reserved (non-category) `message_preview`.
  function togglePreview(next: boolean) {
    if (!prefs) return
    const prev = prefs
    setPrefs({ ...prefs, message_preview: next })
    setPrefError(null)
    void pushApi.putPrefs({ message_preview: next }).catch((e) => {
      setPrefs(prev)
      setPrefError(e instanceof Error ? e.message : 'Could not save preference.')
    })
  }

  // Generic transport test (the existing "Send test" button — bypasses category
  // gates so it always fires when subscribed).
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<string | null>(null)
  async function onSendTest() {
    if (testing || !enabled) return
    setTesting(true)
    setTestResult(null)
    try {
      const { delivered } = await pushApi.test()
      // `delivered: 0` is the smoking gun for a misconfigured VAPID `sub`
      // (notably APNs / iPhone — server logs the underlying push-service
      // status at `warn`). Surface this back so the operator knows where to
      // look without grepping logs.
      setTestResult(
        delivered > 0
          ? `Sent to ${delivered} device${delivered === 1 ? '' : 's'} — check your phone.`
          : 'Server accepted the request but no device received the push. Check `push_sub` in config.toml.',
      )
      void refreshActivity()
    } catch (e) {
      setTestResult(
        e instanceof Error ? `Test failed: ${e.message}` : 'Test failed.',
      )
    } finally {
      setTesting(false)
    }
  }

  // Recent activity ring. Refetched on mount, after a test, and on demand
  // ("Refresh") — there's no live SSE feed here on purpose; this is a "I want
  // to check what just happened" surface, not a live monitor.
  const [activity, setActivity] = React.useState<PushAttempt[] | null>(null)
  const refreshActivity = React.useCallback(async () => {
    try {
      const rows = await pushApi.getAttempts()
      // Defensive: an offline / errored endpoint can resolve with a non-array
      // body. Coerce to [] so `activity.map` below never throws
      // "list.map is not a function" — the panel renders its empty state instead.
      setActivity(Array.isArray(rows) ? rows : [])
    } catch {
      /* best-effort; the panel renders an empty-state if this fails */
    }
  }, [])
  React.useEffect(() => {
    if (!enabled) return
    void refreshActivity()
  }, [enabled, refreshActivity])

  const footnote = (() => {
    switch (state) {
      case 'unsupported':
        return 'This device can’t receive web push. On iPhone/iPad, add supermux to your Home Screen first, then enable it from the installed app.'
      case 'blocked':
        return 'Notifications are blocked for this site. Allow them in your browser settings, then turn this on.'
      default:
        return 'Get a phone notification when an agent needs you, finishes, stops, or a scheduled task errors.'
    }
  })()

  function onMasterToggle(next: boolean) {
    if (busy || state === 'unsupported') return
    if (next) void enable()
    else void disable()
  }

  return (
    <Section title="Notifications" footnote={footnote}>
      <Row
        label="Enable phone notifications"
        hint={
          state === 'blocked'
            ? 'Blocked in browser settings'
            : state === 'unsupported'
              ? 'Not available on this device'
              : busy
                ? 'Working…'
                : undefined
        }
        control={
          <Switch
            ariaLabel="Enable phone notifications"
            checked={enabled}
            onCheckedChange={onMasterToggle}
          />
        }
      />

      {enabled ? (
        <Row
          label="Send a test notification"
          hint="Bypasses every preference toggle — verifies VAPID signing, push service, your service worker, your phone."
          control={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onSendTest()}
              disabled={testing}
            >
              {testing ? 'Sending…' : 'Send test'}
            </Button>
          }
        />
      ) : null}

      {testResult ? (
        <Row>
          <p className="text-[13px] text-muted-foreground">{testResult}</p>
        </Row>
      ) : null}

      {enabled ? (
        <>
          {/* Per-event toggles. Hidden until the master is on, because they're
              moot otherwise (and a tower of dead switches is bad UX). */}
          <Row>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Notify me when…
            </p>
          </Row>
          {NOTIF_TYPES.map((t) => (
            <Row
              key={t.key}
              label={t.label}
              hint={t.hint}
              control={
                <Switch
                  ariaLabel={`Notify me when ${t.label.toLowerCase()}`}
                  checked={prefs?.[t.key] ?? true}
                  onCheckedChange={(next) => togglePref(t.key, next)}
                  disabled={!prefs}
                />
              }
            />
          ))}

          {/* Privacy: show the actual message on the lock screen, or keep
              banners generic. Default ON — the owner asked for real previews. */}
          <Row
            label="Message preview"
            hint="Show a preview of what happened on the lock screen. Off keeps banners generic for privacy."
            control={
              <Switch
                ariaLabel="Message preview in notifications"
                checked={prefs?.message_preview ?? true}
                onCheckedChange={togglePreview}
                disabled={!prefs}
              />
            }
          />

          {prefError ? (
            <Row>
              <p className="text-[13px] text-destructive">{prefError}</p>
            </Row>
          ) : null}

          {/* Recent activity — the "why didn't I get a notification?" answer.
              In-memory ring, last 10. Manual refresh on purpose: this is a
              spot-check tool, not a live monitor (no need to burn an SSE topic
              on it). */}
          <Row>
            <div className="flex w-full items-baseline justify-between gap-2 pb-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Recent activity
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void refreshActivity()}
                className="h-7 text-[12px]"
              >
                Refresh
              </Button>
            </div>
          </Row>
          <Row>
            <div className="flex w-full flex-col divide-y divide-border/60">
              {activity == null ? (
                <p className="py-1.5 text-[13px] text-muted-foreground">Loading…</p>
              ) : activity.length === 0 ? (
                <p className="py-1.5 text-[13px] text-muted-foreground">
                  Nothing yet. Send a test or wait for an agent to ping you.
                </p>
              ) : (
                (Array.isArray(activity) ? activity : []).map((a, i) => (
                  <ActivityRow key={`${a.at}-${i}`} a={a} />
                ))
              )}
            </div>
          </Row>
        </>
      ) : null}

      {error ? (
        <Row>
          <p className="text-[13px] text-destructive">{error}</p>
        </Row>
      ) : null}
    </Section>
  )
}

/** The running-bundle status line for the Diagnostics "Build" row. Four states,
 *  driven by the version-guard served-sha compare so it can never contradict the
 *  reload bar the background heartbeat surfaces. */
type BuildStatus = 'checking' | 'latest' | 'stale' | 'unknown'

function BuildStatusLine({
  status,
  onReload,
  onRecheck,
}: {
  status: BuildStatus
  onReload: () => void
  onRecheck: () => void
}) {
  switch (status) {
    case 'checking':
      return (
        <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Checking for a newer version…
        </span>
      )
    case 'latest':
      return (
        <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <CheckCircle2 className="size-4 text-emerald-500" />
          You are on the latest version
        </span>
      )
    case 'stale':
      return (
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-amber-600 dark:text-amber-400">
            <ArrowUpCircle className="size-4" />
            Update available
          </span>
          <Button asChild onClick={onReload} className="h-9 gap-1.5">
            <motion.button whileTap={{ scale: 0.96 }} transition={springs.buttonPress}>
              <RefreshCw className="size-4" />
              Reload
            </motion.button>
          </Button>
        </div>
      )
    case 'unknown':
      return (
        <button
          type="button"
          onClick={onRecheck}
          className="flex items-center gap-1.5 text-[13px] text-muted-foreground underline-offset-2 hover:underline"
        >
          <RefreshCw className="size-3.5" />
          Couldn’t compare — check again
        </button>
      )
  }
}

/** Advanced → Diagnostics → Build. Which frontend bundle THIS install is
 *  actually running (short `__APP_BUILD_SHA__`) and whether the live server has
 *  already shipped a newer one. Reuses `fetchServedSha` + `isNewerServedSha`
 *  from the version guard, and the guard's `adoptNewBuild` for the one-tap
 *  reload — so this manual surface and the background heartbeat always agree. */
function BuildVersionRow() {
  const built = __APP_BUILD_SHA__
  const real = isRealSha(built)
  const shortSha = real ? built.slice(0, 7) : 'dev'
  const [status, setStatus] = React.useState<BuildStatus>(real ? 'checking' : 'unknown')

  const applyServed = React.useCallback(
    (served: string | null) => {
      if (served == null) setStatus('unknown')
      else setStatus(isNewerServedSha(served, built) ? 'stale' : 'latest')
    },
    [built],
  )

  // Manual re-check (the "recheck" button): flips to the spinner, then fetches.
  const check = React.useCallback(() => {
    if (!real) return
    setStatus('checking')
    void fetchServedSha().then(applyServed)
  }, [real, applyServed])

  // Initial fetch. `status` already starts at 'checking' when `real`, so the
  // effect does the async fetch WITHOUT a synchronous setState (which would trip
  // react-hooks/set-state-in-effect) — the state settles in the async callback.
  React.useEffect(() => {
    if (!real) return
    let alive = true
    void fetchServedSha().then((served) => {
      if (alive) applyServed(served)
    })
    return () => {
      alive = false
    }
  }, [real, applyServed])

  return (
    <>
      <Row
        label="Build"
        hint={
          real
            ? 'The frontend bundle this device is running, compared against the live server.'
            : 'Local development build — there is no server version to compare against.'
        }
        control={
          <span className="font-mono text-[13px] text-muted-foreground">{shortSha}</span>
        }
      />
      {real ? (
        <Row>
          <div className="flex min-h-[2rem] items-center py-1">
            <BuildStatusLine status={status} onReload={() => void adoptNewBuild()} onRecheck={check} />
          </div>
        </Row>
      ) : null}
    </>
  )
}

/** Advanced → Diagnostics. Operator-only tools: which bundle is running (+ a
 *  one-tap update when the server is newer). */
function DiagnosticsSection() {
  return (
    <Section
      title="Diagnostics"
      footnote="Which frontend bundle this install is running."
    >
      <BuildVersionRow />
    </Section>
  )
}

/** Per-section spring-in for the Advanced disclosure header (mirrors the
 *  `sectionItem` variant the grouped sections use, kept local so `primitives`
 *  stays untouched). */
const advItem: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: springs.cardExpand },
}

/** The disclosure body's reveal. Expressed as VARIANT LABELS (not inline style
 *  objects) on purpose: the moved sections are themselves `motion.section`s with
 *  a `hidden`/`visible` variant, and framer resolves a child's variant by the
 *  LABEL its ancestor is animating to. An object-based `animate` here would break
 *  that propagation and leave the children stuck at their `hidden` opacity, so
 *  the group's `hidden`/`visible` labels must match theirs. */
const advBody: Variants = {
  hidden: { height: 0, opacity: 0 },
  visible: { height: 'auto', opacity: 1, transition: springs.cardExpand },
}

/** The ADVANCED disclosure — a collapsible group at the foot of Settings that
 *  holds the power-user / set-once / diagnostic sections so the everyday surface
 *  (Appearance, Notifications, …) stays short. Collapsed by default; nothing is
 *  removed, only regrouped. Deep-linked sections (`#hosts`, `#schedules`,
 *  `#recovery`) are deliberately kept OUTSIDE so their fragment scroll still
 *  resolves against the always-rendered tree. */
function AdvancedGroup({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  return (
    <motion.section variants={advItem} className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 text-left transition-colors hover:bg-accent/40"
      >
        <span className="flex items-center gap-3">
          <SlidersHorizontal className="size-[18px] text-muted-foreground" />
          <span className="flex flex-col">
            <span className="text-[15px] leading-tight text-foreground">Advanced</span>
            <span className="text-[13px] leading-snug text-muted-foreground">
              Power-user, diagnostic, and rarely-touched settings
            </span>
          </span>
        </span>
        <ChevronDown
          className={cn(
            'size-5 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="advanced-body"
            variants={advBody}
            initial="hidden"
            animate="visible"
            exit="hidden"
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-7 pt-7">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.section>
  )
}

export function Settings() {
  const navigate = useNavigate()
  // Grok hides Settings from the nav (layout.tsx `grokHidden`), so under grok
  // this route grows its own exit affordance — a top-right close X. Detected the
  // same way the shell does (store botMode + the two kill-switches) so the
  // button appears ONLY under grok; the base app (grok off) keeps Settings in
  // the nav and this route stays byte-identical (no extra button in its header).
  const [grok] = React.useState(() =>
    botModeOn(
      useUI.getState().botMode,
      typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem(BOT_KILL_SWITCH_KEY),
      typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem(GROK_KILL_SWITCH_KEY),
    ),
  )
  const { theme, setTheme } = useTheme()
  const viewMode = useUI((s) => s.viewMode)
  const setViewMode = useUI((s) => s.setViewMode)
  const hoverPreview = useUI((s) => s.hoverPreview)
  const setHoverPreview = useUI((s) => s.setHoverPreview)
  const overviewPreview = useUI((s) => s.overviewPreview)
  const setOverviewPreview = useUI((s) => s.setOverviewPreview)
  const [sound, setSound] = React.useState(() => getSoundsEnabled())

  const scrollRef = React.useRef<HTMLDivElement>(null)
  const { scrollY } = useScroll({ container: scrollRef })
  const navOpacity = useTransform(scrollY, [8, 44], [0, 1])
  const titleOpacity = useTransform(scrollY, [0, 52], [1, 0])

  // Fragment-anchor scroll. The Settings route lives inside a route-local
  // scroll container, so the browser's default `#hosts` scroll doesn't work —
  // it tries to scroll `document` and finds the element at zero, then quits.
  // We watch `location.hash` and manually scroll the matching child into view
  // (smooth on subsequent navigations, instant on initial load so the user
  // doesn't see a jump after the route mounts). Used by /hosts → /settings#hosts.
  const { hash } = useLocation()
  React.useEffect(() => {
    if (!hash) return
    const id = hash.slice(1)
    // RAF so the children have laid out by the time we look up the target —
    // the iOS-style stagger animation otherwise reports a still-shifting
    // element top.
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [hash])

  function toggleSound(next: boolean) {
    primeAudio() // unlock iOS AudioContext from this user gesture
    setSoundsEnabled(next)
    setSound(next)
    if (next) playTone() // immediate preview so the choice is audible
  }

  return (
    // `gk-settings` — the Grok-skin hook (desktop-only re-materialization in
    // grok-mode.css, scoped `[data-grok]` + `@media(min-width:768px)`). The
    // class alone paints nothing, so base app (grok off) and every mobile
    // breakpoint stay byte-identical; under grok on desktop it repoints the
    // shared shadcn tokens the Section/Row/Switch/SegmentedControl primitives
    // read, re-skinning every section at once.
    <div ref={scrollRef} className="gk-settings relative h-full overflow-y-auto">
      {/* Floating glass nav bar — the only glass surface here; grouped cards
          below use the opaque iOS settings-list material. Fades in on scroll. */}
      {/* The shared mobile top bar was removed, so this sticky glass header
          owns the safe-area top inset on mobile (≤md) via `pt-safe`, reset at
          `sm` once the desktop SideNav owns the chrome. As the first in-flow
          child it reserves that height regardless of its scroll-driven opacity,
          so the big `<h1>` title block below it also clears the notch. */}
      <motion.header
        style={{ opacity: navOpacity }}
        // B1 T7.1 — the tokenised route-header contract. Was a hand-rolled
        // `min-h-12 … bg-background/70 backdrop-blur-xl`; now `glass
        // safe-header`, which is the same idea expressed once:
        //   · `safe-header` = min-height var(--sm-toolbar-min-h) (56px, the
        //     ROUTE floor) + additive padding-top: env(safe-area-inset-top).
        //     min-h, never h, so the notch inset GROWS the bar instead of
        //     eating into it and squishing the title under the Dynamic Island.
        //   · `glass` = the shared material, which also brings the
        //     `prefers-reduced-transparency` and no-backdrop-filter fallbacks
        //     the hand-rolled version never had.
        // DECISION (VR'd both ways, light + dark, desktop + iPhone 14 Pro): the
        // 56px route floor does NOT crowd the large title below — the 34px
        // title sits in the scrolling body with its own padding, and the extra
        // 8px reads as a more confident bar. So Settings takes the standard
        // route floor rather than keeping its 48px exception.
        // `sm:pt-0` still resets the mobile-only inset once the desktop SideNav
        // owns the chrome. z-20 is deliberately unchanged — B1 renumbers no
        // existing z-index (see BRAND.md §6d).
        className="glass safe-header pointer-events-none sticky top-0 z-20 flex items-center justify-center border-b border-hairline sm:pt-0"
      >
        <span className="text-[17px] font-semibold tracking-tight">Settings</span>
        {/* Close X — the exit affordance. Under grok, Settings is dropped from
            the nav (layout.tsx `grokHidden`) and reached via the roster avatar,
            so this route needs its own way out (the mirror of that top-right
            entry point, and the iOS sheet-dismiss convention). The header is
            `pointer-events-none` (a scroll-reveal glass bar) and `justify-center`
            (centred title), so the button is `pointer-events-auto` and absolutely
            pinned to the right edge, leaving the title centred. It reuses the
            roster's `.gr-icon-btn` ghost style. `navigate('/')` returns to the
            overview deterministically (vs. a fragile `navigate(-1)` on a
            deep-link / cold load). Rendered ONLY under grok, so the base app's
            header is byte-identical. */}
        {grok && (
          <button
            type="button"
            onClick={() => navigate('/')}
            aria-label="Close settings"
            title="Close"
            className="gr-icon-btn pointer-events-auto absolute right-3 top-1/2 -translate-y-1/2 sm:right-4"
          >
            <X size={20} aria-hidden />
          </button>
        )}
      </motion.header>

      <MotionConfig reducedMotion="user">
        <motion.div
          variants={listContainer}
          initial="hidden"
          animate="visible"
          className="mx-auto flex w-full max-w-2xl flex-col gap-7 px-4 pb-20 sm:px-6"
        >
          <motion.h1
            style={{ opacity: titleOpacity }}
            className="px-1 pb-1 pt-2 text-[34px] font-bold leading-tight tracking-tight"
          >
            Settings
          </motion.h1>

          <Section
            title="Appearance"
            footnote={MISC.soundsToggleHint}
          >
            <Row
              label="Theme"
              control={
                <SegmentedControl
                  ariaLabel="Theme"
                  value={theme}
                  onChange={setTheme}
                  options={THEME_OPTIONS}
                />
              }
            />
            <Row
              label="Default view"
              hint="How the overview lays out your agents."
              control={
                <SegmentedControl
                  ariaLabel="Default view"
                  value={viewMode}
                  onChange={setViewMode}
                  options={VIEW_OPTIONS}
                />
              }
            />
            <Row
              label="Overview preview"
              hint="Live shows a peek of each agent’s terminal; Text shows only the recent-output tail (lighter on resources)."
              control={
                <SegmentedControl
                  ariaLabel="Overview preview"
                  value={overviewPreview}
                  onChange={setOverviewPreview}
                  options={OVERVIEW_PREVIEW_OPTIONS}
                />
              }
            />
            {overviewPreview === 'live' ? (
              <Row
                label="Overview hover preview"
                hint="Hovering a tile shows a live terminal, or more lines of recent output."
                // The one wide control in this section ("Live terminal |
                // Expanded text" ≈ 262px): beside it on a 390px screen the
                // label had 66px and wrapped over three lines.
                wideControl
                control={
                  <SegmentedControl
                    ariaLabel="Overview hover preview"
                    value={hoverPreview}
                    onChange={setHoverPreview}
                    options={HOVER_OPTIONS}
                  />
                }
              />
            ) : null}
            <Row
              label={MISC.soundsToggleLabel}
              control={
                <Switch
                  ariaLabel={MISC.soundsToggleLabel}
                  checked={sound}
                  onCheckedChange={toggleSound}
                />
              }
            />
          </Section>

          <NotificationsSection />

          <UpdatesSection />

          <Section title="Model">
            <Row
              label="Default model"
              hint="Used when you boot a new agent."
              control={<ModelPicker />}
            />
          </Section>

          <HostsSection />

          {/* B1 T8 — the former /scheduler route, folded in. Sits between Hosts
              and Claude tools: the three are registry-ish configuration
              neighbours, and `/scheduler` now redirects to `#schedules`. */}
          <SchedulesSection />

          <ClaudeToolsSection />

          <ConnectorsSection />

          <RecoverySection />

          {/* B-advanced — declutter. The everyday surface above stays short;
              the power-user / set-once / diagnostic sections fold into one
              collapsed group. Nothing is removed and every toggle keeps its
              exact same wiring — only the grouping changed. Deep-linked sections
              (Hosts #hosts, Schedules #schedules, Recovery #recovery) stay above
              so their fragment scroll still finds an always-rendered target. */}
          <AdvancedGroup>
            <DiagnosticsSection />

            <OnboardingSection />

            <ApiKeysSection />

            <ConnectionSection />

            <ExperimentalSection />

            <SnippetsSection />

            <Section
              title="Audit log"
              footnote="The last 200 recorded actions. Secrets are never logged."
            >
              <AuditLog />
            </Section>
          </AdvancedGroup>
        </motion.div>
      </MotionConfig>
    </div>
  )
}
