// MobileFocus — focus-mode mobile route.
//
// Composes the hero mobile interaction around the LiveTerminal:
//   <MobileSheet>            ← full-screen layout wrapper, its height driven by
//                              useKeyboardViewport so it shrinks to sit ABOVE
//                              the soft keyboard (no page slide). NO drawer
//                              chrome — focus mode is the whole surface, peek
//                              detents and drag-to-dismiss never revealed
//                              anything useful, so we dropped Vaul + the
//                              handle/glass/rounded-top theatre. iOS and
//                              Android share one path. Dismiss = the back
//                              chevron in FocusHeader or the existing left-edge
//                              swipe-back. Vaul still owns the other mobile
//                              sheets below (picker/key-bar-customize/etc.)
//                              where the drawer-over-content model fits.
//     <FocusHeader minimal />← 44px top bar
//     <LiveTerminal />       ← the terminal (flex-1) — REUSED, the LIVE-TYPE
//                              keystroke-capture (tap focuses it → keyboard up)
//     <KeyBar />             ← floating glass pill (mobile-focus-keybar spec):
//                              arrow/Enter-style key chips pinned just under
//                              the header, toggled by the dock's `···` icon.
//     <MobileDock />         ← accessory bar: session-pill + ⌨ + key-bar toggle
//                              + snippets + dictate + keyboard-pinned key strip
//                              (Esc/Tab/^C/arrows). NO text composer (live-type).
//   <SessionPickerSheet />   ← Vaul half-sheet (full list)
//   <KeyBar>'s picker + <SnippetPanel />
//                            ← the two action panels, both hosted in the ONE
//                              shared Vaul shell (<MobileActionSheet>) so
//                              edit/+ share one quirk-free sheet. (DOCK: the
//                              slash sheet was removed — slash commands now
//                              run from the Claude Tools sheet's Commands
//                              tab; the old Quick-keys drawer was replaced by
//                              the KeyBar — see key-bar.tsx.)
//   edge-of-next peek         ← left-edge drag reveals the next session
//
// Edge gestures: left-edge swipe-right → overview;
// right-edge swipe-left → next session (pinned-then-active order). The left-edge
// drag renders a live peek-of-next that springs back below 40% width.
//
// Single source of truth: the terminal handle from <LiveTerminal onReady> drives
// EVERY key path (dock send, KeyBar, joystick) — the same `useLiveTerm` the
// desktop tile/focus use. No duplicate WS, no second xterm. The auth token is
// never referenced here; it lives in `window._SUPERMUX_AUTH_TOKEN` (env.ts).
//
// ── THE RENDERER SEAM (fase A5) ─────────────────────────────────────────────
// This route now offers the CHAT renderer too, on the same three gates the
// desktop seam uses (`components/chat/flag.ts`): the Settings → Experimental
// toggle, the `supermux:chat-renderer` kill-switch, and the Track A v1
// eligibility guard (local Claude, never a team lead). Chat is the DEFAULT when
// all three pass; the terminal is one tap away on the switch. The decision
// itself is shared, pure and tested — `components/chat/seam.ts`.
//
// What changes when chat has the pane, and why (all of it is `mobileChrome`):
//   · <FocusHeader> goes. The chat surface draws its own floating header card
//     (`mobile-light.png`), and this route fills that card's two slots: the
//     back button on the left, the renderer switch on the right. Two headers
//     would cost the transcript a bar it already has.
//   · <KeyBar> and the <Joystick> go, and the dock sheds its terminal-only
//     controls. All three write raw key BYTES through `termRef`, which is null
//     with no terminal mounted — hiding them beats letting them no-op silently
//     (this route has shipped a dead accessory bar once already).
//   · the tap-to-focus gate on the pane goes with the terminal it was written
//     for: under chat a tap in the transcript must not summon the keyboard.
//   · the INPUT PLANE forks. Snippets and dictation keep working, but "insert"
//     under chat means "stage it in the composer where I can edit it", not
//     "paste it at a `❯` nobody is looking at" — `composerSessionInput`, the
//     same plane the desktop seam switches to.
// The keyboard-aware layout is untouched: <MobileSheet> still sizes itself off
// `useKeyboardViewport`, and the composer is a real textarea inside it, so the
// surface shrinks to sit above the soft keyboard exactly as the terminal did.

import * as React from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { useNavigateMorph } from '@/components/view-transitions/morph'

import { LiveTerminal } from '@/components/terminal/live-terminal'
import { StoppedSession } from '@/components/terminal/stopped-session'
import { useTerminalGone } from '@/hooks/use-terminal-gone'
import { Joystick } from '@/components/joystick/joystick'
import type { UseLiveTermResult } from '@/hooks/use-live-term'
import { restSessionInput, useTerminalInput } from '@/lib/session-input'
import { composerSessionInput } from '@/components/chat/composer-draft'
import { useArmComposerFocus } from '@/components/chat/arm-composer-focus'
import { RendererSwitch } from '@/components/chat/renderer-switch'
import { RendererShell } from '@/components/chat/renderer-shell'
import { useChatRenderer } from '@/components/chat/use-chat-renderer'
import {
  chatPaneActive,
  mobileChrome,
  paneIsDead,
  terminalPaneMounts,
  type ChatRenderer,
} from '@/components/chat/seam'
import { useRenderer } from '@/components/chat/use-renderer-pref'
import { BackIcon } from '@/components/chat/ui'
import { useUI } from '@/stores/ui-store'
import { useSessions } from '@/hooks/use-sessions'
import { useAttentionContext } from '@/hooks/use-attention'
import { useTeams } from '@/hooks/use-teams'
import { useLastActiveSession } from '@/stores/board-create-session-store'
import type { Team, TeamMember } from '@/lib/api/teams'
import { TeammateFocus } from '@/components/team'
import { displayLabel, sessionTitle, type ApiSession, type SessionStatus } from '@/lib/api'
import { motionOff, springs } from '@/lib/springs'
import { StatusDot } from '@/components/session-tile/status-dot'

import { MobileSheet } from '@/components/focus-mode/mobile-sheet'
import { FocusHeader } from '@/components/focus-mode/focus-header'
import {
  LastSendSheet,
  useLastSend,
} from '@/components/focus-mode/last-send-recall'
import { MobileDock } from '@/components/focus-mode/dock'
import { MobileBottomPanel } from '@/components/focus-mode/mobile-bottom-panel'
import { useKeyboardViewport } from '@/hooks/use-keyboard-viewport'
import { SessionPickerSheet } from '@/components/focus-mode/session-picker-sheet'
import { KeyBar, useKeyBar } from '@/components/focus-mode/key-bar'
import { SnippetPanel } from '@/components/snippets/snippet-panel'
import { MobileComposeSheet } from '@/components/focus-mode/mobile-compose-sheet'
import { useExternalEdit } from '@/components/focus-mode/use-external-edit'
import { SessionInfoPanel } from '@/components/focus-mode/session-info-panel'
import { useEdgeGestures } from '@/components/focus-mode/use-edge-gestures'
import { neighborSession } from '@/components/focus-mode/session-order'
import type { TileSession } from '@/components/session-tile/types'

/** The chat renderer, lazily — the terminal path must not pay for a chunk it
 *  never mounts, and with the experiment off nobody on this route does. Same
 *  split as the desktop seam. */
const ChatPanel = React.lazy(() => import('@/components/chat/chat-panel'))

/** The chat⇄terminal switch rail's height, in px. Named because TWO things need
 *  it: the rail itself, and the floating <KeyBar>, which hangs off a fixed
 *  offset below the 44px header and would otherwise cover it. */
const SWITCH_ROW_H = 36

/** Synthesize a minimal session from the route param so the terminal mounts even
 *  before the sessions query has delivered this row. */
function placeholderSession(name: string): ApiSession {
  return {
    name,
    status: 'idle' as SessionStatus,
    dir: '',
    provider: '',
    preview_lines: [],
    updated_at: '',
  }
}

export interface MobileFocusProps {
  /** DEV-only mock injection (the /dev/focus-mobile verification page).
   *  Production omits it → the real `useSessions` store. Mirrors
   *  `DesktopFocusProps.mockSessions` (focus/desktop.tsx). */
  mockSessions?: TileSession[]
  /** DEV-only mock teams injection, same pattern as `DesktopFocusProps`. */
  mockTeams?: Team[]
}

// Self-contained route component (reads the `:name` param like
// <DesktopFocus />) so the focus.tsx fork can call it with no props.
export function MobileFocus({ mockSessions, mockTeams }: MobileFocusProps = {}) {
  const { name = '' } = useParams()
  const navigate = useNavigate()
  // View-Transition navigate: used by the discrete back-button tap so
  // it plays the reverse tile↔header morph. The left-edge SWIPE keeps the plain
  // `navigate` — its own peek-of-next drag IS the iOS-native back transition,
  // and a View Transition would fight the live drag transform.
  const navigateMorph = useNavigateMorph()
  const reduceMotion = useReducedMotion()
  const { sessions: liveSessions } = useSessions()
  // DEV-only override (the /dev/focus-mobile harness) — TileSession is a
  // superset-compatible shape (see session-tile/types.ts), so it slots in
  // wherever the route otherwise reads the live `ApiSession[]`.
  const sessions: ApiSession[] = mockSessions ?? liveSessions
  // Detected Agent Teams — the shared `['teams']` cache (GET on mount + SSE-live),
  // the SAME source the overview TEAM CARD reads. Drives the team-aware picker +
  // the read-only teammate focus overlay.
  const liveTeams = useTeams()
  const teams = mockTeams ?? liveTeams.teams
  // Remember the focused session as the app-wide "last-active" pick so /files
  // (no `:name`) lands in this session's dir on the next visit. See
  // stores/board-create-session-store.ts.
  const [, setLastActiveSession] = useLastActiveSession()
  React.useEffect(() => {
    if (name) setLastActiveSession(name)
  }, [name, setLastActiveSession])

  // The REAL row, or null while the sessions query is still resolving.
  // `current` below papers over that with a placeholder so the terminal can
  // mount immediately — but the renderer seam may NOT read the placeholder: its
  // empty `provider` is ineligible, so a chat session would mount the terminal
  // for a beat and then swap. The coercion to `TileSession` is the same
  // boundary one `use-focus-sessions.ts` applies (the wire leaves `updated_at`
  // optional for partial deltas; the tile shape requires it).
  const row = React.useMemo<TileSession | null>(() => {
    const s = sessions.find((x) => x.name === name)
    return s ? { ...s, updated_at: s.updated_at ?? '' } : null
  }, [sessions, name])
  const current: ApiSession = row ?? placeholderSession(name)

  // Opening a session marks it read (fase B2 T5). Keyed on the NAME, and gated
  // on the REAL row — recording a cursor against the placeholder would stamp a
  // session we have not actually loaded yet.
  const { markRead } = useAttentionContext()
  React.useEffect(() => {
    if (row) markRead(row)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, row !== null])

  // The terminal WS proves a dead pty (4404) before — or, when the backend
  // never flipped the row, INSTEAD of — the status delta. Without this the pane
  // keeps a frozen terminal with no way to restart the session. Declared ABOVE
  // the seam because the seam's "a stopped session is never chat" rule has to
  // see the socket's conclusion too, not only the row's.
  const { gone: termGone, onTermState } = useTerminalGone(current.status)
  // The `holder_died` clause is what makes the CHAT renderer see a dead pane at
  // all — it has no terminal socket, so `termGone` can never fire under it.
  // Shared with the desktop seam (`chat/seam.ts`) so the two surfaces cannot
  // drift into two readings of "this pane has no process".
  const stopped = paneIsDead(current.status, termGone, current.error?.type)

  // ── The renderer seam (fase A5) ────────────────────────────────────────────
  // Same three gates as the desktop seam, same pure decision
  // (`components/chat/seam.ts`), same kill-switch. Declared HERE, above the
  // input plane and the tap gate, because both of them fork on `chatActive`.
  const isTeamLead = React.useMemo(
    () => teams.some((t) => t.lead_supermux_session === name),
    [teams, name],
  )
  const chatSetting = useUI((s) => s.chatRenderer)
  const chatOn = useChatRenderer(row, isTeamLead)
  // The ONLY state is the user's manual tap, keyed by session name so it resets
  // on navigation and cannot be stomped by a late flag/eligibility resolve.
  // Fase A5 T1/T2: a PERSISTED pin, not `React.useState`. `row != null` (not
  // `current`) stays the resolved signal — this route synthesizes a placeholder
  // row so its terminal can mount before the query lands, and only it knows the
  // difference.
  const {
    resolved: renderer,
    pref: rendererPref,
    setPref: setRendererPref,
  } = useRenderer(name, chatOn, row != null)
  const setRenderer = React.useCallback(
    (value: ChatRenderer) => setRendererPref(value),
    [setRendererPref],
  )
  // `stopped`, not `current.status`: a pty the SOCKET found dead owes the user
  // the same calm StoppedSession surface, and the chrome swap has to agree with
  // the pane swap or the phone shows a stopped session with no header on it.
  const chatActive = chatPaneActive(
    chatSetting,
    chatOn,
    renderer,
    stopped ? 'stopped' : current.status,
  )
  const terminalMounts = terminalPaneMounts(chatSetting, renderer, chatActive)
  // `stopped` joins the seam: a stopped session is never chat, so the raw-key
  // chrome used to survive onto a pane with no process in it.
  const chrome = mobileChrome(chatOn, chatActive, stopped)

  const next = React.useMemo(
    () => neighborSession(sessions, name, 1),
    [sessions, name],
  )
  const prev = React.useMemo(
    () => neighborSession(sessions, name, -1),
    [sessions, name],
  )

  // Imperative terminal handle — the ONE surface every key path drives.
  const termRef = React.useRef<UseLiveTermResult | null>(null)
  // The input handle (fase A4 T1, forked at the A5 seam). Every TEXT surface on
  // this route (snippets, dictation, the keybar's text chips, the dock's send)
  // speaks `SessionInput`, so which PLANE it is depends only on which renderer
  // is mounted:
  //   · terminal → the byte path through the live handle. Built off the REF, so
  //     it is stable across terminal remounts. `submit` appends the same single
  //     `\r` those call sites used to append themselves — behaviour with the
  //     experiment off is byte-identical to before A5.
  //   · chat → `composerSessionInput`: INSERT stages the text in the React
  //     composer (where the user can still edit it before it is sent), while
  //     submit and keys go straight to the session on the REST plane.
  const termInput = useTerminalInput(termRef)
  const restInput = React.useMemo(() => restSessionInput(name), [name])
  const chatInput = React.useMemo(
    () => composerSessionInput(name, restInput),
    [name, restInput],
  )
  const input = chatActive ? chatInput : termInput
  // Auto-focus the terminal on session entry (polish-pass #4) so keystrokes
  // (hardware keyboard, or the iOS soft keyboard once the user taps in) route
  // to xterm IMMEDIATELY — the focus pane is the terminal, not the dock
  // input. Re-armed per session-name change so jumping sessions follows focus.
  //
  // DEPS — `name` only. Mirrors the desktop fix: agent status flips many times
  // during a session, and each flip re-firing `term.focus()` could synchronously
  // emit a focusin event whose reporting bytes (`\x1b[I` under DECSET ?1004)
  // land back at the pty as part of the phantom-Enter symptom path. Status
  // changes don't warrant re-focusing the terminal.
  //
  // FASE A5 T3, invariant 4 — gated on `chatActive`. Before retention this
  // fired unconditionally, which was harmless because the terminal was the only
  // thing that could be there. With a retained xterm sitting hidden behind
  // chat, focusing it is the silent keystroke sink of Risk 1 — and on iOS it
  // also raises a soft keyboard over a surface that never asked for one.
  const wantFocusRef = React.useRef(false)
  React.useEffect(() => {
    if (current.status === 'stopped' || current.status === 'error') {
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
    // `chatActive` joins `name`: entering under chat must not arm the focus,
    // and revealing the terminal later must. Status is still excluded — see
    // above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, chatActive])
  // The CHAT direction of the same arming, shared with the desktop seam. On a
  // phone it is a deliberate NO-OP (`pointer: coarse`): focusing the composer
  // would summon the soft keyboard over a surface nobody asked to type into
  // yet. It is here so a coarse/fine change (an iPad with a keyboard, a desktop
  // browser at a narrow width) gets the same behaviour as the split route
  // rather than a second reading of the same rule.
  useArmComposerFocus(name, chatActive)
  const onTermReady = React.useCallback((t: UseLiveTermResult) => {
    termRef.current = t
    if (wantFocusRef.current) {
      wantFocusRef.current = false
      t.focus()
    }
  }, [])

  // ── Keyboard-viewport layout (the "page slides weirdly" fix) ────────────────
  // visualViewport drives the sheet's exact height so the terminal shrinks to
  // sit DIRECTLY above the soft keyboard (no page scroll), and the accessory
  // dock rides the keyboard top. No-op on desktop / closed keyboard (height is
  // null → the sheet falls back to its 100dvh CSS height).
  const {
    height: vvHeight,
    keyboardInset,
    keyboardOpen,
  } = useKeyboardViewport()

  // Imperative summon/dismiss of the keyboard. Tapping the terminal must focus
  // xterm INSIDE the user gesture (iOS only opens the keyboard on a real touch),
  // so these are passed to both the terminal pane tap-handler and the dock's
  // ⌨ toggle / accessory strip. xterm is the single keyboard owner — no dock
  // textarea to compete (LIVE-TYPE).
  const focusTerm = React.useCallback(() => input.focus(), [input])
  const blurTerm = React.useCallback(() => input.blur(), [input])

  // ── Tap-vs-swipe gate for the terminal body (mobile keyboard fix) ───────────
  // The terminal body now scrolls its scrollback on a one-finger swipe. But
  // focusing xterm on EVERY pointer-up also summoned the iOS soft keyboard at the
  // END of a scroll gesture. So we only focus on a genuine TAP: same pointer,
  // tiny movement (< slop), short duration. A swipe (movement) just scrolls —
  // xterm's `.xterm-viewport` already handled it — and never opens the keyboard.
  //
  // A second pointer going down (multi-touch, e.g. the joystick's 2-finger
  // gesture) INVALIDATES the candidate so an armed gesture is never a "tap".
  const TAP_SLOP_PX = 10 // max total finger travel that still counts as a tap
  const TAP_MAX_MS = 500 // max press duration that still counts as a tap
  const tapRef = React.useRef<{
    x: number
    y: number
    t: number
    id: number
  } | null>(null)
  const onTermPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // LIVE-TYPE tap detection. A genuine tap (single pointer, <10px travel,
      // <500ms) on the terminal focuses xterm so iOS raises the keyboard inside
      // the user gesture — a deferred/rAF focus would be ignored. A swipe is
      // not a tap and must not summon the keyboard; xterm's own viewport
      // handler pans the scrollback instead. We use pointer events (not
      // onClick) so the touch is observed even if xterm stops the click.
      // A second concurrent pointer = multi-touch → not a tap. Invalidate.
      if (tapRef.current && tapRef.current.id !== e.pointerId) {
        tapRef.current = null
        return
      }
      tapRef.current = {
        x: e.clientX,
        y: e.clientY,
        t: Date.now(),
        id: e.pointerId,
      }
    },
    [],
  )
  const onTermPointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const cand = tapRef.current
      tapRef.current = null
      if (!cand || cand.id !== e.pointerId) return // multi-touch / no candidate
      const dist = Math.hypot(e.clientX - cand.x, e.clientY - cand.y)
      const elapsed = Date.now() - cand.t
      const isTap = dist < TAP_SLOP_PX && elapsed < TAP_MAX_MS
      // A genuine tap on a URL OPENS it (PWA-safely) and must NOT summon the
      // keyboard — that reflow is exactly what fought the link open before. Any
      // other tap = "I want to type" → focus xterm so iOS raises the keyboard
      // INSIDE this user gesture. A swipe just scrolled the scrollback — do
      // nothing (no keyboard). Stopped sessions never focus.
      if (isTap && !stopped) {
        if (!termRef.current?.tryOpenLinkAt(e.clientX, e.clientY)) focusTerm()
      }
    },
    [stopped, focusTerm],
  )
  const onTermPointerCancel = React.useCallback(() => {
    tapRef.current = null
  }, [])
  // The dock registers its `insert` here so the snippet panel can
  // tap-to-insert a snippet body without prop-drilling. Post LIVE-TYPE the dock's
  // `insert` sends the body STRAIGHT to the terminal (no composer buffer).
  const composerInsert = React.useRef<((text: string) => void) | null>(null)
  const registerInsert = React.useCallback(
    (fn: ((text: string) => void) | null) => {
      composerInsert.current = fn
    },
    [],
  )

  // Stream literal text into the session — the one insert path the dock,
  // snippets, dictation, and the compose sheet all funnel through. Insert, not
  // submit: none of these callers wants an Enter.
  const sendToTerm = React.useCallback(
    (text: string) => void input.insert(text),
    [input],
  )

  const [pickerOpen, setPickerOpen] = React.useState(false)
  // Read-only teammate focus overlay. Held by team+agent_id so it stays
  // resolved across SSE snapshot replaces (member identity changes each tick). We
  // route teammate focus through the SHARED <TeammateFocus> overlay (the single
  // teammate-focus UI app-wide — the overview uses the same one) rather than a
  // second in-pane mechanism, so there aren't two competing teammate views.
  const [teammateFocus, setTeammateFocus] = React.useState<{
    teamName: string
    agentId: string
  } | null>(null)
  const focusTeam = teammateFocus
    ? teams.find((t) => t.team_name === teammateFocus.teamName) ?? null
    : null
  const focusMember: TeamMember | null = teammateFocus
    ? focusTeam?.members.find((m) => m.agent_id === teammateFocus.agentId) ?? null
    : null
  const openTeammate = React.useCallback((team: Team, member: TeamMember) => {
    setTeammateFocus({ teamName: team.team_name, agentId: member.agent_id })
  }, [])
  // Seed teammateFocus from `/focus/<lead>?teammate=<agent_id>` — the overview
  // TEAM CARD navigates here for a teammate tap (single teammate-view surface,
  // no in-overview overlay). Strip the param after consuming so a later
  // manual dismiss isn't silently undone by a re-mount re-reading it.
  const [searchParams, setSearchParams] = useSearchParams()
  const teammateParam = searchParams.get('teammate')
  React.useEffect(() => {
    if (!teammateParam) return
    const t = teams.find((x) => x.lead_supermux_session === name)
    const m = t?.members.find((x) => x.agent_id === teammateParam)
    if (!t || !m) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTeammateFocus({ teamName: t.team_name, agentId: m.agent_id })
    const next = new URLSearchParams(searchParams)
    next.delete('teammate')
    setSearchParams(next, { replace: true })
  }, [teammateParam, teams, name, searchParams, setSearchParams])
  // Floating KeyBar (mobile-focus-keybar spec) — persisted open/keys state
  // (localStorage, `focus_key_bar` — independent of the legacy `quick_keys`
  // server pref). The dock's `···` icon now toggles `keyBar.open` instead of
  // opening the old QuickKeysSheet bottom drawer.
  const keyBar = useKeyBar()
  // The KeyBar's own "customize keys" picker sheet — lifted here (rather than
  // local to <KeyBar>) purely so `useEdgeGestures`'s `enabled` gate below can
  // disable edge-swipe nav while it's open, matching `pickerOpen`.
  const [keyBarPickerOpen, setKeyBarPickerOpen] = React.useState(false)
  const [snippetsOpen, setSnippetsOpen] = React.useState(false)
  // The on-demand native EDITOR sheet (feat-edit-in-native-editor). The dock's
  // bottom-left Edit field is its trigger: tapping it sends Ctrl+G to the pty,
  // Claude lifts its current `❯` input into the supermux bridge, and the sheet
  // opens on the `external-edit` SSE event PRE-FILLED with that buffer. Save writes
  // the edited text back to Claude's buffer (no auto-submit). Live-type + the
  // accessory strip remain the default for interactive TUIs — this is additive.
  const edit = useExternalEdit(name)
  // Stage 1 OPTIMISTIC OPEN — tap the Edit field opens the sheet IMMEDIATELY
  // (skeleton renders this frame) AND fires Ctrl+G to Claude in parallel. The
  // sheet flips from skeleton → real textarea when the bridge SSE arrives with
  // Claude's buffer. This collapses the perceived ~5s wait to ~250ms.
  const onEdit = React.useCallback(() => {
    // Gate the Ctrl+G on requestOpen's outcome: a rapid 2nd tap while we're
    // still `pending` returns false (no transition) — firing another Ctrl+G then
    // would queue a 2nd bridge round-trip whose empty-buffer arrival could race
    // the first and clobber an in-progress textarea. One tap, one Ctrl+G.
    if (edit.requestOpen()) {
      // Terminal-only: `C-g` is NOT in the server's `KEY_ALLOWLIST`, so this
      // one cannot go through `SessionInput`. It stays on the ref by name —
      // and with it the rest of the external-edit flow it opens.
      termRef.current?.sendKey('Ctrl-G')
    }
  }, [edit])
  /** Done = save only (current behaviour). The user presses Enter themselves
   *  to submit. The sheet swallows any rejection — failure mode is just that
   *  the next Enter doesn't submit, which is benign. */
  const onEditSave = React.useCallback(
    (text: string) => {
      void edit.save(text).catch(() => undefined)
    },
    [edit],
  )
  /** Send = save AND auto-submit. The sheet awaits this Promise BEFORE firing
   *  the Enter byte, so we let the rejection propagate (sheet surfaces a toast
   *  + skips the Enter on failure). */
  const onEditSaveAndSubmit = React.useCallback(
    (text: string) => edit.save(text),
    [edit],
  )
  /** Enter passthrough — fired by the Send button AFTER the submit POST
   *  returns. Uses the existing `sendKey('Enter')` path → `\r` on the terminal
   *  WS (no new protocol). The byte sits in the pty input buffer until Claude
   *  finishes consuming the bridge's write-back, then submits the now-edited
   *  prompt — guaranteed by the pty input stream's sequential ordering. */
  const onEditSendEnter = React.useCallback(() => {
    termRef.current?.sendKey('Enter')
  }, [])
  // feat-session-info — the title-click info panel (a bottom Sheet on mobile).
  const [infoOpen, setInfoOpen] = React.useState(false)
  // feat-last-prompt — recall sheet for the user's last prompt. No auto-show
  // on mobile (the icon in the header is the only entry).
  const [lastSendOpen, setLastSendOpen] = React.useState(false)
  const lastSend = useLastSend(current ?? undefined)
  // DOCK — the slash panel was removed: slash commands now run from the Claude
  // Tools sheet's Commands tab (tap a command → it runs in the focused terminal).
  // Joystick on/off. The accessory bar's "Gesture" toggle flips this
  // via `onGestureToggle`; default ON (the joystick wins by default).
  const [gestureOn, setGestureOn] = React.useState(true)
  void setGestureOn // wired by the accessory bar; kept for the toggle handoff

  const goSession = React.useCallback(
    (target: string) => navigate(`/focus/${encodeURIComponent(target)}`),
    [navigate],
  )
  const goOverview = React.useCallback(() => navigate('/'), [navigate])
  // Back-button tap → reverse morph; the edge-swipe path still uses `goOverview`.
  const goOverviewMorph = React.useCallback(
    () => navigateMorph('/'),
    [navigateMorph],
  )

  // Edge gestures — disable while a half-sheet is open so they don't double-fire.
  const edge = useEdgeGestures({
    enabled: !pickerOpen && !keyBarPickerOpen,
    onSwipeRight: goOverview,
    onSwipeLeft: () => next && goSession(next.name),
    resolveNext: () => next,
  })

  return (
    <>
      {/* Left-edge peek-of-next: the next session's title + status dot revealed
          beneath the dragging view (springs back below the 40% threshold; the
          actual navigate is committed by useEdgeGestures). */}
      <AnimatePresence>
        {edge.dragging && edge.nextSession && (
          <PeekOfNext session={edge.nextSession} />
        )}
      </AnimatePresence>

      {/* Floating KeyBar (mobile-focus-keybar spec) — `position: fixed`, so it
          renders as a top-level sibling rather than inside the peek-tracking
          `<motion.div>` below (it must NOT slide with the left-edge drag). */}
      <KeyBar
        // Terminal-only: every chip is a raw key byte on `termRef` (fase A5).
        open={keyBar.open && chrome.keyBar}
        keys={keyBar.keys}
        onKeysChange={keyBar.setKeys}
        // Raw keys stay on the terminal ref: the keybar's names (`EscEsc`,
        // `Newline`, `Ctrl-G`, …) are `keyToBytes` names with no REST
        // equivalent — terminal-only by definition. Its TEXT chips are an
        // insert, so they go through the handle.
        onSendKey={(key) => termRef.current?.sendKey(key)}
        onSendText={(text) => void input.insert(text)}
        pickerOpen={keyBarPickerOpen}
        onPickerOpenChange={setKeyBarPickerOpen}
        // The bar is `fixed` under the 44px header and cannot see the flow — so
        // when the seam inserts the switch rail there, it has to be told
        // (fase A5). `SWITCH_ROW_H` is that rail's height, in one place.
        topOffset={chrome.switchRow ? SWITCH_ROW_H : 0}
      />

      <motion.div
        // The whole focus surface tracks the left-edge drag so the peek-of-next
        // reads as "the next session sliding in behind."
        style={{ x: edge.peekX }}
        transition={reduceMotion ? motionOff : springs.sheetDetent}
        className="h-full w-full"
      >
        <MobileSheet
          contentHeight={vvHeight}
          keyboardInset={keyboardInset}
        >
          {/* The title-bar "···" overflow was removed: it opened the SAME
              SessionPickerSheet the bottom-left session pill already opens (the
              pill is the richer, more discoverable affordance — name + status +
              swipe). Dropping the redundant dots clears the naming confusion so
              the only "dots" left is the bottom dock's KeyBar toggle. */}
          {/* Terminal chrome. Under chat the surface's own floating header card
              is the route's header (fase A5) — see `mobileChrome`. */}
          {chrome.focusHeader && (
            <FocusHeader
              name={current.name}
              provider={current.provider}
              title={sessionTitle(current)}
              status={current.status}
              activity={current.activity}
              subagents={current.subagents}
              error={current.error}
              onBack={goOverviewMorph}
              // Manual resync — re-pull a clean screen on the live handle. Omitted
              // for a stopped session (no live WS to resync) so the control hides.
              // `stopped` (not `current.status`) so a pty the SOCKET found dead
              // hides it too — see `useTerminalGone`.
              onRefresh={stopped ? undefined : () => termRef.current?.resync()}
              onTitleClick={() => setInfoOpen(true)}
              hasLastSend={!!current}
              lastSendOpen={lastSendOpen}
              onToggleLastSend={() => setLastSendOpen((o) => !o)}
            />
          )}

          {/* The way BACK to chat while the terminal has the pane. A slim rail
              under the focus header, mirroring the desktop seam's own switch
              bar — the chat-mode switch lives in the header card instead
              (`chrome.switchInHeader`), so there is only ever one on screen. */}
          {chrome.switchRow && (
            <div
              style={{ height: SWITCH_ROW_H }}
              className="flex shrink-0 items-center justify-center border-b border-border/60 px-3"
            >
              <RendererSwitch
                size="sm"
                // The rail has the full row's width, so all three words fit —
                // this is the one place the switch does NOT have to shrink.
                value={rendererPref}
                resolved={renderer ?? 'terminal'}
                onChange={setRendererPref}
              />
            </div>
          )}

          {/* The LiveTerminal with the joystick + 2-finger gesture
              layered on top. `relative` so the joystick's absolute layer scopes
              to the terminal viewport (excludes header/dock). The joystick
              drives the SAME `termRef` handle the dock uses — no second WS.

              SCROLL FIX — the joystick no longer blankets the terminal with a
              `touch-none` capturing overlay (that ate every touch before xterm's
              own scroll handler ran). It now observes pointer gestures via
              NON-blocking listeners on this wrapper and only captures once ARMED,
              so a plain one-finger drag falls through to `.xterm-viewport` and
              pans the scrollback natively. See joystick.tsx. */}
          <div
            className="relative min-h-0 flex-1"
            // Tap-to-focus (LIVE-TYPE): a genuine TAP anywhere in the terminal
            // body focuses xterm INSIDE the touch gesture so iOS summons the soft
            // keyboard reliably (it only opens the keyboard on a real user
            // gesture; a deferred/rAF focus is silently ignored). A SWIPE just
            // scrolls the scrollback (xterm's `.xterm-viewport` handled it) and
            // must NOT raise the keyboard — so we gate focus behind tap detection
            // (onTermPointerDown/Up: same pointer, <10px travel, <500ms). We use
            // pointer events (not onClick) so it fires for the actual touch even
            // if xterm's own pointer handling stops the click; harmless on mouse.
            //
            // OFF UNDER CHAT (fase A5): the gate exists to summon the keyboard
            // for a surface you type INTO directly. On the chat surface a tap
            // lands on a bubble, a card or the scroll region, and raising the
            // keyboard for it would cover the thing that was just tapped.
            onPointerDown={chatActive ? undefined : onTermPointerDown}
            onPointerUp={chatActive ? undefined : onTermPointerUp}
            onPointerCancel={chatActive ? undefined : onTermPointerCancel}
          >
            {stopped ? (
              /* The session's pty is gone — render the calm stopped state
                 instead of mounting a live WS that would 101-upgrade then get
                 closed in a no-backoff loop. No joystick: nothing to drive.
                 `termGone` is the same conclusion reached from the socket, for
                 the window (or the incident) where the row still says otherwise.
                 Reached under BOTH renderers: `chatPaneActive` excludes a
                 stopped session for exactly this reason. */
              <StoppedSession name={name} />
            ) : (
              /* FASE A5 T3/T4 — mounted-but-hidden retention, the SAME shell the
                 desktop seam uses. #66 already gave this route the renderer seam
                 (the chrome swap, the input-plane fork, the switch in two
                 places); what was still missing is the retention, and with it
                 the reason the phone needed it most: on a phone the terminal's
                 handshake is the slowest and the soft keyboard is the least
                 forgiving of a remount.

                 The shell adds ONE `display:grid` box INSIDE this existing flex
                 child, so `MobileSheet`'s `visualViewport` height chain is
                 unchanged — and it sets no `backdrop-filter`, `transform`,
                 `filter` or `contain`, so it cannot become a containing block
                 for the `fixed` KeyBar and joystick (§11.1, asserted in
                 `chat-renderer-shell.test.tsx`).

                 `onTerminalHidden` is the mobile-specific half of invariant 4:
                 an invisible xterm holding DOM focus keeps the iOS soft keyboard
                 up over a chat surface that never asked for it. */
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
                    session={row}
                    surface="phone"
                    // The RAW plane. The panel is the one place that may write to
                    // the session under chat, and it does it through its own gates
                    // (peek-verify, the slash gate, the pending echo + watchdog).
                    // Everything else on this route holds `chatInput`, whose text
                    // paths stage into the composer instead — one draft, one gated
                    // way out of it.
                    input={restInput}
                    onOpenTerminal={() => setRenderer('terminal')}
                    // The card's two shell slots (`mobile-light.png`): navigation
                    // on the left, the renderer choice on the right. The surface
                    // owns neither, which is why they arrive as nodes.
                    headerLeading={
                      <button
                        type="button"
                        aria-label="Back to sessions"
                        data-testid="chat-back"
                        onClick={goOverviewMorph}
                        className="grid size-[34px] flex-none place-items-center rounded-full bg-fill-soft text-ink-2 active:bg-fill-soft-2"
                      >
                        <BackIcon />
                      </button>
                    }
                    headerTrailing={
                      chrome.switchInHeader ? (
                        <RendererSwitch
                          size="sm"
                          // The header card's own width rule (QA #6): the word
                          // that goes is the one naming the surface you are not
                          // looking at, and the session's name gets it back.
                          labels="selected"
                          value={rendererPref}
                          resolved={renderer ?? 'chat'}
                          onChange={setRendererPref}
                        />
                      ) : undefined
                    }
                  />
                </React.Suspense>
                }
                terminal={
                  <>
                  {/* Pass the session's cached last-screen capture so the terminal
                      shows the CURRENT screen INSTANTLY on open (no blank, no
                      replay scroll), then crossfades to the live xterm. The
                      `current` row is the shared SSE-merged source the overview
                      tiles render, so the static screen matches what the user just
                      tapped (cached-tail crossfade). */}
                  <LiveTerminal
                    name={name}
                    onReady={onTermReady}
                    onStateChange={onTermState}
                    previewAnsi={current.preview_ansi}
                    previewLines={current.preview_lines}
                  />
                  <Joystick
                    enabled={gestureOn && chrome.joystick}
                    sendKey={(key) => termRef.current?.sendKey(key)}
                  />
                  </>
                }
              />
            )}
          </div>

          {/* The swipeable kbd-accessory bar (formerly mounted here) was
              removed in the mobile-finishing pass: it sat ABOVE the MobileDock
              as a second toolbar, and its Pager chips no-op'd silently because
              the terminal imperative handle wasn't registered until after the
              terminal mounted via onTermReady — leaving users tapping a dead
              bar. The lower MobileDock already covers the same shortcuts
              (keyboard toggle, KeyBar toggle, snippets, send), and the
              floating <KeyBar> above (mobile-focus-keybar spec) now owns
              arrow/Enter-style key-nav. Clean removal — no orphaned import. */}

          {/* The unified mobile bottom panel:
              ONE positioned element holds the session-pills
              strip AND the MobileDock content. Swipe-up reveals the pills
              above the dock buttons; swipe-down (or tap the grabber, or tap
              outside) hides them. Single height-animation on the panel — no
              two-sibling motion to fight each other, no second top border,
              no opacity gate. Desktop has the 320px sidebar — no parallel
              affordance is added there.

              MobileBottomPanel owns the panel chrome (glass background, top
              hairline, grabber, pills row, gesture state-machine). The dock
              content is passed as children so MobileBottomPanel stays a pure
              presentational shell that doesn't have to know the dock's many
              props. */}
          <MobileBottomPanel
            sessions={sessions}
            currentName={name}
            onPick={goSession}
          >
            <MobileDock
              current={current}
              prevSession={prev}
              nextSession={next}
              onOpenPicker={() => setPickerOpen(true)}
              onToggleKeyBar={keyBar.toggleOpen}
              keyBarOpen={keyBar.open}
              onOpenSnippets={() => setSnippetsOpen(true)}
              // Edit-in-native-editor uses the Ctrl+G $EDITOR bridge. Claude
              // (`chat:externalEditor`), Codex (`open_external_editor`) and Kimi
              // all bind Ctrl+G to open $EDITOR → same supermux-edit bridge /
              // `external-edit` SSE. No-op on shell — surface it for every agent
              // provider.
              //
              // The Ctrl+G bridge is a terminal-only path (the key is not in
              // the server's `KEY_ALLOWLIST`), so it is absent under chat —
              // where the composer IS the editor.
              onEdit={
                !chatActive &&
                (current.provider === 'claude' ||
                  current.provider === 'codex' ||
                  current.provider === 'kimi')
                  ? onEdit
                  : undefined
              }
              editOpen={edit.open}
              onSwitchSession={goSession}
              // Under chat this stages into the composer (`chatInput`) instead
              // of typing at the pty's `❯` — one draft, one way out of it.
              onSend={sendToTerm}
              onSendKey={(key) => termRef.current?.sendKey(key)}
              onFocusTerm={focusTerm}
              onBlurTerm={blurTerm}
              keyboardOpen={keyboardOpen}
              registerInsert={registerInsert}
              // Reduced dock: the accessory key strip, the ⌨ toggle, the KeyBar
              // toggle and the ↵ pill all drive raw bytes at a pty that isn't
              // mounted (fase A5).
              chat={chrome.dockChat}
            />
          </MobileBottomPanel>
        </MobileSheet>
      </motion.div>

      <SessionPickerSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        sessions={sessions}
        current={name}
        onPick={goSession}
        teams={teams}
        onPickTeammate={openTeammate}
      />

      {/* DOCK — the action panels share the one Vaul shell
          (<MobileActionSheet>): the KeyBar's own "customize keys" picker
          (rendered inside <KeyBar> above, gated by `keyBarPickerOpen`) and the
          snippets sheet below. Each opens with a backdrop + tap-away +
          drag-down dismiss; only their CONTENT differs. (The slash sheet was
          removed — slash commands now run from the Claude Tools sheet's
          Commands tab. The old Quick-keys drawer was replaced by the
          KeyBar — see key-bar.tsx.) */}
      <SnippetPanel
        open={snippetsOpen}
        onOpenChange={setSnippetsOpen}
        onInsert={(body) => composerInsert.current?.(body)}
        onRun={(body) => void input.submit(body)}
      />

      {/* The on-demand native EDITOR sheet (feat-edit-in-native-editor) — morphs
          from the dock Edit field via a shared `layoutId`. It opens PRE-FILLED with
          Claude's current `❯` input (delivered over the `external-edit` SSE event)
          and on Save writes the edited text (+ any attachment path) back into
          Claude's input buffer via the submit endpoint — NO Enter, so the user
          submits with Enter themselves. A dismiss cancels (buffer left unchanged). */}
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

      {/* feat-session-info — the title-click info panel (bottom Sheet on mobile).
          Cloning an agent navigates to its focus route via `goSession`. The
          panel's content only mounts while open (Vaul unmounts when closed). */}
      <SessionInfoPanel
        name={name}
        open={infoOpen}
        onOpenChange={setInfoOpen}
        onNavigate={goSession}
      />

      {/* feat-last-prompt — the recall bottom sheet. Heavy content only mounts
          while open (Vaul unmounts when closed). Gated on the SESSION, not on
          supermux's own `last_send` column: that column is empty for every
          session supermux did not itself submit through, while /recall returns
          real history for them — the sheet owns its empty state. */}
      {current && (
        <LastSendSheet
          open={lastSendOpen}
          onOpenChange={setLastSendOpen}
          recall={lastSend}
          session={current}
        />
      )}

      {/* Read-only teammate focus. The SAME full-screen <TeammateFocus>
          overlay the overview uses (one teammate-focus UI app-wide): glass
          header, read-only terminal, the member strip to switch teammates inside
          the team. Opened from the team-aware session picker. */}
      <AnimatePresence>
        {focusTeam && focusMember && (
          <TeammateFocus
            team={focusTeam}
            member={focusMember}
            onSelectMember={(memberName) => {
              const m = focusTeam.members.find((x) => x.name === memberName)
              if (m) setTeammateFocus({ teamName: focusTeam.team_name, agentId: m.agent_id })
            }}
            onClose={() => setTeammateFocus(null)}
          />
        )}
      </AnimatePresence>
    </>
  )
}

/** Peek-of-next preview pinned to the right edge during a left-edge drag. */
function PeekOfNext({ session }: { session: ApiSession }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={springs.smooth}
      className="pointer-events-none fixed right-3 top-1/2 z-40 flex -translate-y-1/2 items-center gap-2 rounded-full border border-border/60 glass px-3 py-2"
    >
      <StatusDot status={session.status} />
      <span className="max-w-[40vw] truncate text-[13px] font-medium">
        {displayLabel(session)}
      </span>
    </motion.div>
  )
}

export default MobileFocus
