import * as React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  MotionConfig,
  motion,
  useScroll,
  useTransform,
} from 'framer-motion'
import {
  Check,
  ChevronsUpDown,
  PlayCircle,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react'

import { springs } from '@/lib/springs'
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
import { useClaudeToolsSheet } from '@/stores/claude-tools-store'
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
function ExperimentalSection() {
  const { data, isError } = useAgentTeams()
  const patch = usePatchAgentTeams()
  const enabled = !!data?.enabled

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

/** Settings → Claude tools (skills-mcp-manager plan §C.1, entry point 3). Opens
 *  the same manager sheet the ⌘K command + focus title-bar icon open, scoped to
 *  global (no session in this context). */
function ClaudeToolsSection() {
  const openClaudeTools = useClaudeToolsSheet((s) => s.openSheet)
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
 *  `send_push_for(NotifCategory::*)` call site on the server. */
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
      setActivity(rows)
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
                activity.map((a, i) => <ActivityRow key={`${a.at}-${i}`} a={a} />)
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

export function Settings() {
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
    <div ref={scrollRef} className="relative h-full overflow-y-auto">
      {/* Floating glass nav bar — the only glass surface here; grouped cards
          below use the opaque iOS settings-list material. Fades in on scroll. */}
      {/* R5: the shared mobile top bar was removed, so this sticky glass header
          owns the safe-area top inset on mobile (≤md) via `pt-safe`, reset at
          `sm` once the desktop SideNav owns the chrome. As the first in-flow
          child it reserves that height regardless of its scroll-driven opacity,
          so the big `<h1>` title block below it also clears the notch. */}
      <motion.header
        style={{ opacity: navOpacity }}
        // min-h (not h) so the notch inset (pt-safe) ADDS to the bar height
        // instead of eating into a fixed 48px — otherwise the title is squished
        // under the Dynamic Island in the iOS standalone PWA. Desktop resets
        // pt-safe (sm:pt-0), where min-h-12 renders identically to h-12.
        className="pointer-events-none sticky top-0 z-20 flex min-h-12 items-center justify-center border-b border-border/60 bg-background/70 pt-safe backdrop-blur-xl sm:pt-0"
      >
        <span className="text-[17px] font-semibold tracking-tight">Settings</span>
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

          <ClaudeToolsSection />

          <OnboardingSection />

          <ApiKeysSection />

          <ConnectionSection />

          <ExperimentalSection />

          <Section
            title="Snippets"
            footnote="Saved commands you can fire into a session from the accessory bar."
          >
            <SnippetsSection />
          </Section>

          <Section
            title="Audit log"
            footnote="The last 200 recorded actions. Secrets are never logged."
          >
            <AuditLog />
          </Section>
        </motion.div>
      </MotionConfig>
    </div>
  )
}
