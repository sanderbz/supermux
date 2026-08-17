// DesktopSplit — desktop two-column focus mode + dock.
//
// The desktop focus mode: a two-column flex — a 320px session-strip on the left
// (vertical scroll of <CompactTile>, current row highlighted via a spring), and
// a flex-1 main pane on the right (FocusHeader 44px / LiveTerminal flex-1 /
// DesktopDock 56px).
//
// Keyboard capture lives here: a document-level keydown listener (useKeyboard
// capture) intercepts ONLY ⌘K / ⌘D / ⌘W / ⌘1..9; all other keys flow to the
// xterm (LiveTerminal) untouched. The dock send-row chips and the keyboard
// shortcuts share one imperative LiveTerminal handle captured via `onReady`.
//
// The LiveTerminal is REUSED verbatim — we do not reimplement xterm. The
// session-strip reuses the overview `TileSession` data via `useFocusSessions`
// (single source of truth — no second fetch, WebSocket/SSE-driven downstream).

import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { Eye, EyeOff } from 'lucide-react'

import { LiveTerminal } from '@/components/terminal/live-terminal'
import { StoppedSession } from '@/components/terminal/stopped-session'
import type { UseLiveTermResult } from '@/hooks/use-live-term'
import { useTerminalGone } from '@/hooks/use-terminal-gone'
import { restSessionInput, useTerminalInput } from '@/lib/session-input'
import type { TileSession } from '@/components/session-tile/types'
import type { Team, TeamMember } from '@/lib/api/teams'
import { sessionTitle } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { CompactTile } from './compact-tile'
import { TeamStripGroup } from './team-strip-group'
import { TeammatePane } from './teammate-pane'
import { useGroupedStrip } from './use-grouped-strip'
import { FocusStripSection } from './focus-strip-section'
import { FocusStripModeToggle } from './focus-strip-mode-toggle'
import { DesktopFocusHeader } from './focus-header'
import {
  LastSendBar,
  LastSendPopover,
  useLastSend,
} from './last-send-recall'
import { DesktopDock } from './dock'
import { TerminalCaptureIndicator } from './terminal-capture-indicator'
import { useKeyboardCapture } from './use-keyboard-capture'
import { SnippetPanel } from '@/components/snippets/snippet-panel'
import { Dropzone } from '@/components/files/dropzone'
import { AttachmentRow } from './attachment-chip'
import { useAttachmentUpload } from './use-attachment-upload'
import { useExternalEdit } from './use-external-edit'
import { MobileComposeSheet } from './mobile-compose-sheet'
import { SessionInfoPanel } from './session-info-panel'
import { useUI } from '@/stores/ui-store'
import { RendererSwitch } from '@/components/chat/renderer-switch'
import { RendererShell } from '@/components/chat/renderer-shell'
import { useChatRenderer } from '@/components/chat/use-chat-renderer'
import {
  chatPaneActive,
  paneIsDead,
  terminalPaneMounts,
  type ChatRenderer,
} from '@/components/chat/seam'
import { useRenderer } from '@/components/chat/use-renderer-pref'
import { togglePref } from '@/components/chat/renderer-pref'
import { composerSessionInput } from '@/components/chat/composer-draft'
import { useArmComposerFocus } from '@/components/chat/arm-composer-focus'

// Lazy: the chat renderer is its own chunk — nothing chat-related may land in
// the entry bundle (perf budget; master plan Global Constraints).
const ChatPanel = React.lazy(() => import('@/components/chat/chat-panel'))

export interface DesktopSplitProps {
  /** Focused session name (route param). */
  name: string
  /** The strip rows — canonical session list (single source). */
  sessions: TileSession[]
  /** The focused row (may be null before the store resolves). */
  current: TileSession | null
  /** Detected Agent Teams. The strip groups a team's lead + teammates
   *  consistently with the overview TEAM CARD; empty array = today's flat list
   *  (zero regression). */
  teams?: Team[]
  /** Navigate to another focus route (Cmd+1..9 + compact-tile click). */
  onSelect: (name: string) => void
  /** Detach (⌘D): leave to overview, keep the session alive. */
  onDetach: () => void
  /** Stop (⌘W): stop the session, then leave. */
  onStop: () => void
  /** Open the "Make it a team" sheet for the focused
   *  session. Omit to hide the affordance entirely (e.g. the route gates it on
   *  "already a team lead" / archived). */
  onMakeTeam?: () => void
  /** Optional hook to open the snippet drawer from the parent (the dock owns its
   *  own state too; this is just for route-level openers). */
  onSnippets?: () => void
}

export function DesktopSplit({
  name,
  sessions,
  current,
  teams = [],
  onSelect,
  onDetach,
  onStop,
  onMakeTeam,
  onSnippets,
}: DesktopSplitProps) {
  // Build the grouped, team-aware strip model from the SAME sessions + the
  // shared teams cache + the shared `useOverviewLayout` (no second fetch).
  // The hook also owns the strip's local concerns (mode toggle, per-group
  // collapse, per-group sort overrides).
  //
  // With NO teams + NO user groups + NO ungrouped → the hook returns an empty
  // model and we fall through to the "No other sessions." placeholder below
  // (zero regression for first-time users).
  const {
    model: strip,
    viewMode,
    setViewMode,
    hideStopped,
    setHideStopped,
    setGroupSortMode,
    isCollapsed,
    setCollapsed,
  } = useGroupedStrip(sessions, teams)

  // Which teammate (if any) is shown in the MAIN pane. Held by team+agent_id so
  // the selection survives an SSE snapshot replace (member identity changes each
  // tick). We ALSO stamp the focused-session `name` at selection time: a teammate
  // is read-only and bound to "the session the user was on when they opened it",
  // so the moment the route's focused session changes (⌘1..9, back, an external
  // navigate) the selection is ignored and the session terminal re-takes the
  // pane — derived in render (no effect, no ref-during-render → linter-clean).
  const [selected, setSelected] = React.useState<{
    teamName: string
    agentId: string
    forName: string
  } | null>(null)

  // Seed from the URL: `/focus/<lead>?teammate=<agent_id>` selects the matching
  // teammate on mount / when the param changes (the overview TEAM CARD navigates
  // here for a teammate tap — single teammate-view surface, no in-overview
  // overlay). We resolve the team via the lead session (only one team can host a
  // given lead) so the param stays minimal. A user-initiated strip click later
  // overwrites `selected` independently; the param is read-once per
  // (name, teammate) pair via the effect's dep array.
  const [searchParams, setSearchParams] = useSearchParams()
  const teammateParam = searchParams.get('teammate')
  React.useEffect(() => {
    if (!teammateParam) return
    const t = teams.find((x) => x.lead_supermux_session === name)
    const m = t?.members.find((x) => x.agent_id === teammateParam)
    if (!t || !m) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected({ teamName: t.team_name, agentId: m.agent_id, forName: name })
    // Strip the param so a manual sidebar switch later (which clears `selected`
    // via selectSession) isn't silently undone by a re-mount that re-reads the
    // same param. Replace, not push — back-button should still land on overview.
    const next = new URLSearchParams(searchParams)
    next.delete('teammate')
    setSearchParams(next, { replace: true })
  }, [teammateParam, teams, name, searchParams, setSearchParams])

  // Honour the selection ONLY while the route is still on the session it was made
  // from; a route change implicitly drops it.
  const activeSel = selected && selected.forName === name ? selected : null

  // Resolve the selected teammate live from the current teams snapshot (so its
  // status / pane id stay fresh). If it vanished from the roster, fall back to
  // the session pane rather than a dangling selection.
  const selectedTeam = activeSel
    ? teams.find((t) => t.team_name === activeSel.teamName) ?? null
    : null
  const selectedMember: TeamMember | null = activeSel
    ? selectedTeam?.members.find((m) => m.agent_id === activeSel.agentId) ?? null
    : null
  const teammateActive = !!(selectedTeam && selectedMember)

  const selectTeammate = React.useCallback(
    (team: Team, member: TeamMember) => {
      setSelected({
        teamName: team.team_name,
        agentId: member.agent_id,
        forName: name,
      })
    },
    [name],
  )

  // Selecting a session (lead or normal row) clears any teammate selection and
  // routes — identical to today's behaviour for a normal row.
  const selectSession = React.useCallback(
    (next: string) => {
      setSelected(null)
      onSelect(next)
    },
    [onSelect],
  )
  // One imperative LiveTerminal handle, shared by the dock chips + the keyboard
  // shortcuts. Captured via the `onReady` callback — no re-subscribe.
  const termRef = React.useRef<UseLiveTermResult | null>(null)
  // The pane that wraps xterm — used as the DOM-focus anchor for the capture
  // indicator: when focus moves anywhere INSIDE this subtree (xterm's hidden
  // textarea, the read-only screen) the indicator shows; click outside (the
  // dock, the session strip, the header) releases.
  const termPaneRef = React.useRef<HTMLDivElement | null>(null)
  // Live capture indicator (polish-pass #4) — flips on when the terminal has
  // DOM focus, off when focus moves elsewhere. `focusin`/`focusout` on the
  // pane subtree is the cleanest signal; xterm's hidden textarea is the
  // focusable element, so the document-level `activeElement` check inside the
  // listener is what actually drives the badge.
  const [capturingInput, setCapturingInput] = React.useState(false)

  // Snippet panel — the dock's "+" button opens it; desktop has no separate
  // text composer, so both tap-insert and long-press-run send straight to xterm.
  const [snippetsOpen, setSnippetsOpen] = React.useState(false)

  // "Edit in native editor" (feat-edit-in-native-editor). The dock's ✎ Edit button
  // sends Ctrl+G; Claude lifts its current `❯` input into the supermux bridge, and
  // this sheet opens on the `external-edit` SSE event PRE-FILLED. Save writes the
  // edited text back into Claude's input buffer (no auto-submit) via the submit
  // endpoint; a dismiss cancels (buffer left unchanged). After Save we re-focus
  // xterm so the user can press Enter to submit.
  const edit = useExternalEdit(name)
  // Stage 1 OPTIMISTIC OPEN — opens the sheet immediately (skeleton) while
  // Ctrl+G goes to the pty; the bridge SSE replaces the skeleton with the real
  // textarea once Claude delivers the buffer.
  const onEdit = React.useCallback(() => {
    // Gate the Ctrl+G on requestOpen's outcome: a rapid 2nd tap while we're
    // still `pending` returns false (no transition) — firing another Ctrl+G then
    // would queue a 2nd bridge round-trip whose empty-buffer arrival could race
    // the first and clobber an in-progress textarea. One tap, one Ctrl+G.
    if (edit.requestOpen()) {
      // Terminal-only: `C-g` is NOT in the server's `KEY_ALLOWLIST`, so this
      // one cannot go through `SessionInput`. It stays on the ref by name.
      termRef.current?.sendKey('Ctrl-G')
    }
  }, [edit])
  const onEditSave = React.useCallback(
    (text: string) => {
      // Fire-and-forget the save (the Done path doesn't care when the POST
      // returns — the sheet's already closed, the user will press Enter
      // themselves). Swallow the rejection: the warn is logged inside
      // useExternalEdit; the user-visible failure mode is "the next Enter
      // doesn't submit," which is benign.
      void edit.save(text).catch(() => undefined)
      // Re-focus xterm so the edited prompt is ready to submit with Enter.
      window.requestAnimationFrame(() => termRef.current?.focus())
    },
    [edit],
  )
  /** Send = Save + auto-submit. The sheet awaits this promise BEFORE firing
   *  the Enter byte, so we let the rejection propagate (the sheet surfaces a
   *  toast on failure and skips the Enter). */
  const onEditSaveAndSubmit = React.useCallback(
    (text: string) => edit.save(text),
    [edit],
  )
  /** Enter passthrough — fired by the sheet's Send button AFTER the submit POST
   *  returns. Goes through the existing `sendKey('Enter')` path → `\r` on the
   *  terminal WS. No new protocol; the byte sits in the pty input stream until
   *  Claude finishes consuming the bridge's write-back, then submits the
   *  now-edited prompt.
   *
   *  Stays on the terminal ref (not `SessionInput`): the whole external-edit
   *  flow is terminal-only, because the Ctrl+G that OPENS it is not in the
   *  server's `KEY_ALLOWLIST` — so the sheet can never be up on the REST plane,
   *  and routing only its Enter through `SessionInput` would buy nothing. */
  const onEditSendEnter = React.useCallback(() => {
    termRef.current?.sendKey('Enter')
  }, [])

  // feat-session-info — the title-click info panel. `titleRef` is the Popover's
  // anchor (the title <button> in the header); the panel only mounts while open.
  const [infoOpen, setInfoOpen] = React.useState(false)
  const titleRef = React.useRef<HTMLButtonElement>(null)

  // feat-last-prompt — the recall popover open state, owned HERE so the icon
  // (inside the header), the auto-show bar (below the header), and the ⌘G
  // shortcut all toggle the SAME state. The button ref anchors the popover.
  const [lastSendOpen, setLastSendOpen] = React.useState(false)
  const lastSendButtonRef = React.useRef<HTMLButtonElement>(null)
  const lastSend = useLastSend(current ?? undefined)
  const toggleLastSend = React.useCallback(
    () => setLastSendOpen((o) => !o),
    [],
  )
  // ⌘G IS LIVE WHENEVER THE SHEET CAN OPEN — which is whenever there is a
  // session (recall-reachability fix). It used to be gated on `lastSend`, i.e.
  // on supermux's own `last_send` column, which is empty for every session it
  // did not itself submit through — while GET /recall returns real history for
  // exactly those sessions. The gate hid a working surface behind a column
  // describing a different fact; the panel owns its own empty state.
  const onShowLastSend = React.useMemo(
    () => (current ? toggleLastSend : undefined),
    [current, toggleLastSend],
  )

  const status = current?.status ?? 'starting'

  // The terminal WS learns a dead pty (4404) BEFORE the row's status flips —
  // and, when the backend never flipped it at all, instead of it. Without this
  // the pane sat on a frozen, silent terminal with no way to restart the
  // session. `termGone` renders the same stopped surface the row-driven branch
  // does, and clears itself the moment the session runs again.
  const { gone: termGone, onTermState } = useTerminalGone(status)
  // …and `holder_died` is the THIRD way to learn the same thing — the only one
  // that reaches a chat surface, which has no terminal socket to hear the 4404
  // on. See `chat/seam.ts`'s `paneIsDead`.
  const stopped = paneIsDead(status, termGone, current?.error?.type)

  // Fase A1 chat renderer — the DESKTOP seam. The mobile one landed in A5
  // (routes/focus/mobile.tsx) and shares this file's decision verbatim, via
  // components/chat/seam.ts. Guard: local Claude, not a team lead (Track A v1
  // scope), flag + kill-switch in components/chat/flag.ts.
  //
  // Declared HERE rather than next to `title` (where the rest of the render
  // prep lives) because `onPaste` below closes over `chatActive` AND lists it
  // as a useCallback dep — a later `const` would be in its TDZ.
  const isTeamLead = React.useMemo(
    () => teams.some((t) => t.lead_supermux_session === name),
    [teams, name],
  )
  const chatSetting = useUI((s) => s.chatRenderer)
  const chatOn = useChatRenderer(current ?? null, isTeamLead)
  // renderer null = undecided. With the experiment ON we wait for the
  // sessions query (`current` is null on first paint) before choosing, so the
  // terminal never mounts→attaches→unmounts on every focus load (wasted pty
  // WS + a visible flash — the focus-no-mobile-flash class of bug). With the
  // experiment OFF the always-terminal path below is byte-identical to today.
  //
  // Fully DERIVED (no effect): the only state is the user's manual tap, keyed
  // by session name so it resets on navigation and can never be stomped by a
  // late flag/eligibility resolve. Storing the default in state instead would
  // mean setState-in-effect (cascading renders; lint rule
  // react-hooks/set-state-in-effect).
  //
  // The decision itself is `components/chat/seam.ts` — pure functions, shared
  // with the MOBILE seam (fase A5, routes/focus/mobile.tsx) so the two surfaces
  // cannot drift into two different readings of "the experiment is on", and
  // assertable in `bun test` (tests/unit/chat-seam.test.ts).
  //
  // Fase A5 T1/T2: the tap is no longer `React.useState` — it is a PERSISTED
  // pin (`components/chat/renderer-pref.ts`), so it survives navigation, a
  // reload and the trip to another device. `resolveRenderer` still delegates
  // its base ladder to `seam.ts`'s `pickRenderer`, so the undecided frame and
  // the eligibility rule are byte-identical to A1's; only the source of the
  // choice changed.
  const {
    resolved: renderer,
    pref: rendererPref,
    setPref: setRendererPref,
  } = useRenderer(name, chatOn, current != null)
  const setRenderer = React.useCallback(
    (value: ChatRenderer) => setRendererPref(value),
    [setRendererPref],
  )
  // `stopped`, not `status`: the seam's "a stopped session is never chat" rule
  // has to see the SOCKET's conclusion too (`termGone`), not only the row's, or
  // the two disagree for exactly the window `useTerminalGone` exists to cover.
  // The mobile seam makes the same substitution, for the same reason.
  const chatActive = chatPaneActive(
    chatSetting,
    chatOn,
    renderer,
    stopped ? 'stopped' : status,
  )
  // The terminal mounts unless chat has the pane — false for exactly one frame
  // (experiment on, row unresolved), which is what stops the doomed-terminal
  // flash.
  const terminalMounts = terminalPaneMounts(chatSetting, renderer, chatActive)

  // ── The input handle (fase A4 T1) ───────────────────────────────────────────
  // Every TEXT write surface below (snippets, attachments, the dock's slash
  // row) goes through ONE `SessionInput` instead of reaching for
  // `termRef.current?.send`. Which plane it is depends only on which
  // renderer is mounted: the terminal's byte path when xterm is there, the REST
  // input plane (`/send` · `/paste` · `/keys`) when it is not — the chat
  // renderer has no xterm, which is why those surfaces used to be hidden there.
  // Behaviour with chat OFF is byte-identical: `terminalSessionInput.submit`
  // appends the same single `\r` the call sites used to append themselves.
  const termInput = useTerminalInput(termRef)
  const restInput = React.useMemo(() => restSessionInput(name), [name])
  // Under chat, INSERT means "stage it in the composer where I can edit it",
  // not "paste it at a `❯` nobody is looking at" (fase A4 T3, master plan §3:
  // every insert surface writes into the React composer). Submit and keys still
  // go straight to the session on the REST plane.
  const chatInput = React.useMemo(
    () => composerSessionInput(name, restInput),
    [name, restInput],
  )
  const input = chatActive ? chatInput : termInput

  // Attach a file/screenshot into the session: upload bytes → data-dir uploads/
  // → inject the quoted absolute path (no trailing Enter). Shared engine with
  // mobile. Fed by the dock's 📎 button, drag-drop onto the terminal pane, and
  // image clipboard-paste. After inject we re-focus the input so the user keeps
  // the cursor in the prompt to add context.
  const sendToTerm = React.useCallback(
    (text: string) => void input.insert(text),
    [input],
  )
  const focusTerm = React.useCallback(() => input.focus(), [input])
  const attach = useAttachmentUpload(sendToTerm, focusTerm)

  // Clipboard image paste — handled BEFORE xterm. xterm only forwards TEXT paste
  // (the textarea paste → `term.onData`), so reading `clipboardData.files` /
  // `items[].getAsFile()` here for images doesn't conflict. We ONLY
  // preventDefault when an image is present, so a normal TEXT paste still reaches
  // the terminal untouched.
  const onPaste = React.useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const dt = e.clipboardData
      if (!dt) return
      const images: File[] = []
      // `files` covers the screenshot-paste case; `items[].getAsFile()` is the
      // broader path (some browsers populate only one). De-dupe by identity.
      for (const f of Array.from(dt.files)) {
        if (f.type.startsWith('image/')) images.push(f)
      }
      if (images.length === 0) {
        for (const item of Array.from(dt.items)) {
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const f = item.getAsFile()
            if (f) images.push(f)
          }
        }
      }
      if (images.length > 0) {
        // An image is on the clipboard → take it, and stop it from also reaching
        // xterm's textarea (which would paste garbled bytes). Text paste (no
        // image) falls through untouched.
        e.preventDefault()
        attach.handleFiles(images)
      }
    },
    [attach],
  )

  // Auto-focus the terminal on session entry (polish-pass #4) so keystrokes go
  // to the terminal IMMEDIATELY — no second click. The flag is armed on mount
  // / on session change, then consumed by either the rAF below (handle already
  // installed) or by <LiveTerminal onReady> (the first onReady AFTER arming).
  // Either path focuses xterm exactly once per session entry, so we never
  // steal focus away from a user who has Tab'd into the dock input.
  //
  // DEPS — `name` only. The polish pass originally also depended on
  // `current?.status`, but agent status flips many times during a session
  // (idle → active → idle on every command), and each flip would re-arm
  // wantFocusRef + re-call `term.focus()`. Refocusing a textarea that is
  // already focused can synchronously fire a focusin event on some browsers,
  // and combined with DECSET ?1004 (focus-event reporting) that emits
  // `\x1b[I` / `\x1b[O` back into the pty — which is half of the path that
  // caused the phantom-Enter symptom. The stopped/error guard is now a check
  // INSIDE the mount-time effect: a stopped session has no pty to focus, but
  // a later transition to stopped doesn't need to re-run anything (the user
  // can re-enter the route to retry).
  //
  // FASE A5 T3, invariant 4 — gated on the RESOLVED renderer. Before retention
  // this fired unconditionally on mount, which was harmless because the
  // terminal was the only thing that could be there. With a retained terminal
  // sitting hidden behind chat, an unconditional `term.focus()` is exactly the
  // silent keystroke sink Risk 1 describes: the user types into the composer
  // and the bytes go to an invisible pty.
  const wantFocusRef = React.useRef(false)
  React.useEffect(() => {
    if (current?.status === 'stopped' || current?.status === 'error') {
      wantFocusRef.current = false
      return
    }
    if (chatActive) {
      wantFocusRef.current = false
      return
    }
    wantFocusRef.current = true
    const raf = window.requestAnimationFrame(() => {
      if (wantFocusRef.current && termRef.current) {
        termRef.current.focus()
        wantFocusRef.current = false
      }
    })
    return () => window.cancelAnimationFrame(raf)
    // `chatActive` joins `name`: entering a session under chat must not arm the
    // focus, and revealing the terminal later must. Status is still excluded —
    // see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, chatActive])

  // …and the CHAT direction of the same arming. Without it a toggle to Chat
  // left `document.activeElement` on `<body>`, so the surface the user just
  // asked for swallowed its leading characters and handed the first `t` to the
  // global renderer hotkey. See `chat/arm-composer-focus.ts`.
  useArmComposerFocus(name, chatActive)

  const handleTermReady = React.useCallback((t: UseLiveTermResult) => {
    termRef.current = t
    // Consume a pending auto-focus request on the first onReady after a
    // mount/session-change — xterm's container is laid out by now, so
    // focus() lands on the real hidden textarea.
    if (wantFocusRef.current) {
      wantFocusRef.current = false
      t.focus()
    }
  }, [])

  // Track DOM focus inside the terminal pane. `focusin` / `focusout` bubble,
  // so one pair of listeners on the pane wrapper catches xterm's hidden
  // textarea (the element that actually receives keys). `focusout` fires
  // BEFORE focus lands, so we re-read `document.activeElement` after a
  // microtask to know whether focus left the subtree entirely.
  React.useEffect(() => {
    const pane = termPaneRef.current
    if (!pane) return
    const refresh = () => {
      const active = document.activeElement
      setCapturingInput(!!active && pane.contains(active))
    }
    const onFocusIn = () => refresh()
    const onFocusOut = () => {
      // Defer to the next tick so the freshly-focused element (if any) is the
      // one we read — `focusout` fires before the new `focusin` lands.
      window.setTimeout(refresh, 0)
    }
    pane.addEventListener('focusin', onFocusIn)
    pane.addEventListener('focusout', onFocusOut)
    return () => {
      pane.removeEventListener('focusin', onFocusIn)
      pane.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  // Jump to the N-th (0-indexed) ROUTABLE session — Cmd+1..9. Uses the strip's
  // flattened jump list (each team's mapped lead, then loose sessions) so a
  // teammate (read-only, not a route) never claims a number. Also clears any
  // teammate selection so the session terminal re-takes the pane.
  const jump = React.useCallback(
    (index: number) => {
      const target = strip.jumpSessions[index]
      if (target) {
        setSelected(null)
        if (target.name !== name) onSelect(target.name)
      }
    },
    [strip.jumpSessions, name, onSelect],
  )

  // Map of session name → 1-indexed ⌘N slot (≤9). Source: the same
  // `strip.jumpSessions` list `jump()` reads above — so the visible chip on
  // a tile matches exactly what pressing that number does.
  const jumpIndexBySession = React.useMemo(() => {
    const m = new Map<string, number>()
    strip.jumpSessions.slice(0, 9).forEach((s, i) => m.set(s.name, i + 1))
    return m
  }, [strip.jumpSessions])

  // The single document-level keydown capture (PRINCIPLE). All non-shortcut keys
  // pass straight through to xterm. ⌘K is intentionally NOT routed through here
  // anymore — the global <CommandPalette> in <Layout> owns the shortcut so it
  // works on every route, not just /focus. We keep the slot for ⌘D / ⌘W / ⌘1-9.
  useKeyboardCapture({
    onDetach,
    onStop,
    onJump: jump,
    onShowLastSend,
    // FASE A5 T7 — `T` flips between the two CONCRETE renderers and writes a
    // PIN. Never selects `auto`: a hotkey does one obvious thing, and `auto` is
    // reachable from the switch and both menus. The six refusals (modifiers,
    // IME, an editable target, an open overlay, xterm holding focus, and
    // ineligibility) live in `components/chat/renderer-hotkey.ts`; every one of
    // them returns WITHOUT preventDefault, so the key reaches whoever wanted it.
    onToggleRenderer: () => {
      if (renderer) setRendererPref(togglePref(renderer))
    },
    rendererEligible: chatOn,
  })

  const title = current ? sessionTitle(current) : name

  return (
    <div className="flex h-full w-full bg-background" data-testid="desktop-split">
      {/* Left: 320px session-strip (vertical scroll). The header carries the
          strip mode toggle ("Match overview" / "Custom for this strip") so a
          user who wants a different per-group sort here than the overview can
          opt in WITHOUT clobbering the overview's prefs. */}
      <aside
        className="flex w-80 shrink-0 flex-col border-r border-border bg-background/60"
        data-vr="focus-strip"
        data-vr-view-mode={viewMode}
      >
        <div className="flex h-11 shrink-0 items-center gap-1 px-3 text-[13px] font-semibold tracking-tight text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">Sessions</span>
          {/* Global hide-stopped toggle (Eye / EyeOff). One control, applies
              to every group in 'as-overview' AND to the flat list in any
              other view mode. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setHideStopped(!hideStopped)}
                aria-pressed={hideStopped}
                aria-label={
                  hideStopped
                    ? 'Show stopped sessions'
                    : 'Hide stopped sessions'
                }
                data-vr="strip-hide-stopped"
                data-vr-active={hideStopped ? 'true' : 'false'}
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  hideStopped
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {hideStopped ? (
                  <EyeOff className="size-3.5" aria-hidden />
                ) : (
                  <Eye className="size-3.5" aria-hidden />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {hideStopped ? 'Show stopped sessions' : 'Hide stopped sessions'}
            </TooltipContent>
          </Tooltip>
          <FocusStripModeToggle mode={viewMode} onChange={setViewMode} />
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
          {sessions.length === 0 &&
          strip.teamGroups.length === 0 &&
          strip.userGroups.length === 0 &&
          (strip.flatSessions?.length ?? 0) === 0 ? (
            <p className="px-1 pt-2 text-[13px] text-muted-foreground">
              No other sessions.
            </p>
          ) : (
            <>
              {/* Detected teams — grouped (header + lead + teammates),
                  mirroring the overview TEAM CARD. Pinned ABOVE the rest
                  in both view modes because teams are a separate concept
                  from sort. */}
              {strip.teamGroups.map((g) => (
                <TeamStripGroup
                  key={g.team.team_name}
                  team={g.team}
                  lead={g.lead}
                  members={g.members}
                  focusedSessionName={name}
                  selectedTeammateId={
                    teammateActive ? activeSel!.agentId : null
                  }
                  onSelectSession={selectSession}
                  onSelectTeammate={selectTeammate}
                  jumpIndexBySession={jumpIndexBySession}
                />
              ))}

              {/* As-overview view — render user groups (overview's
                  membership + group order) with per-group sort chips. */}
              {strip.flatSessions == null &&
                strip.userGroups.map((g) => (
                  <FocusStripSection
                    key={g.groupId}
                    group={g}
                    focusedSessionName={name}
                    teammateActive={teammateActive}
                    onSelectSession={selectSession}
                    onSortModeChange={(mode) =>
                      setGroupSortMode(g.groupId, mode)
                    }
                    collapsed={isCollapsed(g.groupId)}
                    onCollapsedChange={(next) => setCollapsed(g.groupId, next)}
                    jumpIndexBySession={jumpIndexBySession}
                  />
                ))}

              {/* Flat view — one sorted list, no group chrome. The
                  view-mode dropdown at the top advertises the active
                  sort, so we don't repeat it in a section header. */}
              {strip.flatSessions != null && (
                <div className="flex flex-col gap-1.5">
                  {strip.flatSessions.map((s) => (
                    <CompactTile
                      key={s.name}
                      session={s}
                      current={!teammateActive && s.name === name}
                      onSelect={selectSession}
                      jumpIndex={jumpIndexBySession?.get(s.name)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </aside>

      {/* Right: main pane. A SELECTED TEAMMATE swaps the whole pane for its
          read-only terminal (no editable header/dock — the teammate WS is
          read-only); otherwise the focused SESSION's header / terminal / dock
          owns the pane exactly as today. */}
      <main className="flex min-w-0 flex-1 flex-col">
        {teammateActive ? (
          <TeammatePane team={selectedTeam!} member={selectedMember!} />
        ) : (
        <>
        <DesktopFocusHeader
          name={name}
          provider={current?.provider}
          title={title}
          status={status}
          activity={current?.activity}
          subagents={current?.subagents}
          error={current?.error}
          onDetach={onDetach}
          onStop={onStop}
          // Manual resync — re-pull a clean screen on the live handle. Omitted
          // for a stopped session (no live WS to resync) so the control hides.
          onRefresh={
            status === 'stopped'
              ? undefined
              : () => termRef.current?.resync()
          }
          onMakeTeam={onMakeTeam}
          // Open only — Radix closes the popover on outside-click / Escape, so a
          // toggle here would race its onOpenChange(false) and re-open it.
          onTitleClick={() => setInfoOpen(true)}
          titleRef={titleRef}
          hasLastSend={!!current}
          lastSendOpen={lastSendOpen}
          onToggleLastSend={toggleLastSend}
          lastSendButtonRef={lastSendButtonRef}
        />

        {/* feat-last-prompt — the auto-show glass strip. Re-keys on `name` so
            switching sessions resets the show-then-fade cycle, matching the
            "recall on arrival" trigger model in the spec.

            TERMINAL ONLY (chat-core, 15-bar.cjs). The strip exists because the
            terminal pane scrolls the user's own prompt away and nothing else
            says what was asked. The chat renderer draws that prompt as a
            BUBBLE, at the bottom of the transcript, permanently — so under chat
            the strip is the same sentence twice, it never fades (measured at
            t+3/8/12/20/30s), and it costs 32px of pane height on every session.
            `chatActive` is the seam's own answer to "chat has the pane", shared
            with the mobile surface, so this cannot drift from what is mounted. */}
        {!chatActive && (
          <LastSendBar
            key={name}
            recall={lastSend}
            sessionName={name}
            onOpenRecall={() => setLastSendOpen(true)}
          />
        )}

        {/* `relative` so the capture indicator (polish-pass #4) can position
            itself in the top-right corner of the terminal pane WITHOUT
            overlaying the terminal viewport — a small chrome element, not an
            overlay over content. The pane ref is the focus boundary used to
            detect when xterm has DOM focus (focusin/focusout listener).

            onPaste — image clipboard-paste into the session (before xterm; only
            preventDefaults when an image is present, so text paste still flows to
            the terminal). The Dropzone (whose overlay stays pointer-events-none,
            so xterm mouse selection is NOT regressed) reveals a drop affordance
            and hands dropped files to the same upload+inject engine. */}
        {chatOn && (
          <div className="flex h-8 shrink-0 items-center justify-end border-b border-border/60 px-3">
            <RendererSwitch
              value={rendererPref}
              resolved={renderer ?? 'chat'}
              onChange={setRendererPref}
            />
          </div>
        )}

        <div
          ref={termPaneRef}
          className="relative min-h-0 flex-1"
          onPaste={onPaste}
        >
          <Dropzone
            onFiles={attach.handleFiles}
            // Under chat the dropped file's quoted path lands in the REACT
            // composer (fase A4 T3), so drag-drop is no longer a no-op there —
            // only a session with no pty at all (`stopped`, which #64 widened to
            // include a terminal WS refused with 4404) still refuses the drop.
            disabled={stopped}
            className="h-full w-full"
          >
            {/* A `stopped` session's pty is gone — opening the live WS would
                just 101-upgrade then get closed in a loop. Detect it up front
                from the session row and render the calm StoppedSession surface
                instead. When it transitions back to running, this swaps to
                LiveTerminal.

                `termGone` is the same surface reached from the other side: the
                socket was refused with 4404 while the row still claimed the
                session was running. */}
            {stopped ? (
              <StoppedSession name={name} />
            ) : (
              /* FASE A5 T3 — mounted-but-hidden retention.
                 Until A5 this was a component SWAP (`chatActive ? <ChatPanel/>
                 : <LiveTerminal/>`), so every toggle cost a full unmount →
                 `useLiveTerm` dispose → new WS → auth → resize → seed, and the
                 same again for the chat socket in the other direction. The
                 shell puts BOTH panes in one grid cell and hides the one you
                 are not looking at, so a toggle is a 180 ms crossfade over two
                 live connections — and the terminal escape hatch is exercised
                 on every toggle instead of rotting.

                 `key={name}` is invariant 8: a retained terminal from session A
                 must never be revealed under session B. `stopped` never reaches
                 here (the branch above owns it), which is invariant 9. */
              <RendererShell
                key={name}
                name={name}
                chatActive={chatActive}
                terminalMounts={terminalMounts}
                onTerminalHidden={() => termRef.current?.blur()}
                chat={
                  <React.Suspense fallback={null}>
                    <ChatPanel
                      name={name}
                      session={current}
                      // The RAW plane. The panel is the one place that may write
                      // to the pty under chat, and it does it through its own
                      // gates (peek-verify, the slash gate, the pending echo +
                      // watchdog). Everything else in this pane holds
                      // `chatInput`, whose text paths stage into the composer
                      // instead — one draft, one gated way out of it (A4 T3).
                      input={restInput}
                      // A5: the escape hatch writes a PIN, not a `useState` —
                      // "I had to escape to the terminal" is a preference, and
                      // it should still be true after a reload.
                      onOpenTerminal={() => setRenderer('terminal')}
                    />
                  </React.Suspense>
                }
                terminal={
                  /* LiveTerminal — reused verbatim, and deliberately told
                     NOTHING about being hidden (invariant 3). The keydown
                     capture still does not preventDefault on ordinary keys, so
                     Ctrl-C / arrows / Tab / Esc / text all reach xterm's
                     onData → the pty WS. */
                  <LiveTerminal
                    name={name}
                    onReady={handleTermReady}
                    onStateChange={onTermState}
                  />
                }
              />
            )}
          </Dropzone>
          {/* Subtle "Capturing input" pill — only visible while xterm holds DOM
              focus. Click outside (header / dock / strip) releases. Esc is NOT
              the release because Esc must reach the terminal (vim, REPLs). */}
          <TerminalCaptureIndicator
            capturing={capturingInput && !stopped && !chatActive}
          />
        </div>

        {/* Attachment feedback — in-flight / ready file chips (uploading spinner
            → thumbnail/name, dismissible), shown between the terminal and the
            dock the moment a file is dropped/pasted/picked. Renders nothing when
            empty. */}
        {attach.attachments.length > 0 && (
          <div className="shrink-0 border-t border-border bg-card px-6 py-2">
            <AttachmentRow
              attachments={attach.attachments}
              onDismiss={attach.dismiss}
            />
          </div>
        )}

        {/* Chat is read-only (A1): every dock control writes into the pty via
            `termRef`, which is null without a mounted terminal — hide it
            rather than let taps silently no-op. The chat panel's own footer
            says "switch to Terminal to type". */}
        <DesktopDock
          // Raw keys stay on the terminal ref: the accessory strip's names
          // (`EscEsc`, `Newline`, `Ctrl-G`, …) are `keyToBytes` names with no
          // REST equivalent — `KEY_ALLOWLIST` would reject them. Terminal-only
          // by definition, which is why the ROW is hidden under chat (fase A4
          // T3) while the rest of the dock — snippets, attach, palette, detach,
          // stop — keeps working through the input plane.
          onSendKey={(label) => termRef.current?.sendKey(label)}
          rawKeys={!chatActive}
          onRunSlash={(cmd) => void input.submit(cmd)}
          onSnippets={() => {
            onSnippets?.()
            setSnippetsOpen(true)
          }}
          onAttach={attach.handleFiles}
          // "Edit in native editor" relies on the Ctrl+G ($EDITOR bridge). Claude
          // (`chat:externalEditor`) and Codex (`open_external_editor`) both bind
          // Ctrl+G to open $EDITOR, so each opens the same supermux-edit bridge →
          // same `external-edit` SSE. It's a no-op on shell panes — hide it
          // there.
          //
          // The Ctrl+G bridge is a terminal-only path too (the key is not in
          // `KEY_ALLOWLIST`), so it is absent under chat — where the composer
          // IS the editor.
          onEdit={
            !chatActive &&
            (current?.provider === 'claude' || current?.provider === 'codex')
              ? onEdit
              : undefined
          }
          onDetach={onDetach}
          onStop={onStop}
        />
        </>
        )}
      </main>

      {/* Snippet panel — slides up over the dock; tap-insert and long-press
          both fire the snippet body into xterm (no separate composer here). */}
      <SnippetPanel
        open={snippetsOpen}
        onOpenChange={setSnippetsOpen}
        onInsert={(body) => void input.insert(body)}
        onRun={(body) => void input.submit(body)}
      />

      {/* feat-edit-in-native-editor — the native editor sheet. Portaled to
          document.body so it works on desktop too (the keyboard inset is 0, so it
          rests at the bottom). Opens PRE-FILLED on the `external-edit` SSE event
          after the ✎ Edit button sends Ctrl+G; Save writes the edited text back
          into Claude's input buffer (no Enter). */}
      <MobileComposeSheet
        open={edit.open}
        onOpenChange={edit.setOpen}
        phase={edit.phase === 'closed' ? 'pending' : edit.phase}
        buffer={edit.buffer}
        requestId={edit.requestId}
        onSave={onEditSave}
        onSaveAndSubmit={onEditSaveAndSubmit}
        onSendEnter={onEditSendEnter}
      />

      {/* feat-session-info — the title-click info panel (Popover on desktop). The
          body only mounts while open (PopoverContent portals on open). Cloning an
          agent navigates to its focus route via the route's select handler. */}
      <SessionInfoPanel
        name={name}
        open={infoOpen}
        onOpenChange={setInfoOpen}
        triggerRef={titleRef}
        onNavigate={onSelect}
      />

      {/* feat-last-prompt — the recall popover, anchored to the icon in the
          header. Only mounts the heavy content while open. The popover is
          controlled by `lastSendOpen`; the icon, the bar-click, and the ⌘G
          shortcut all flip the same state above. Gated on `current` (not on
          `lastSend`) so the anchor refs don't fight an unmounted button while
          still opening for a session whose history predates supermux. */}
      {current && (
        <LastSendPopover
          open={lastSendOpen}
          onOpenChange={setLastSendOpen}
          recall={lastSend}
          session={current}
          anchorRef={lastSendButtonRef}
        />
      )}
    </div>
  )
}

export default DesktopSplit
