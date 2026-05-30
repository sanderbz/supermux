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

import { LiveTerminal } from '@/components/terminal/live-terminal'
import { StoppedSession } from '@/components/terminal/stopped-session'
import type { UseLiveTermResult } from '@/hooks/use-live-term'
import type { TileSession } from '@/components/session-tile/types'
import type { Team, TeamMember } from '@/lib/api/teams'
import { sessionTitle } from '@/lib/api'
import { TeamStripGroup } from './team-strip-group'
import { TeammatePane } from './teammate-pane'
import { useGroupedStrip } from './use-grouped-strip'
import { FocusStripSection } from './focus-strip-section'
import { FocusStripModeToggle } from './focus-strip-mode-toggle'
import { DesktopFocusHeader } from './focus-header'
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
    stripMode,
    setStripMode,
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

  // Attach a file/screenshot into the session: upload bytes → data-dir uploads/
  // → inject the quoted absolute path (no trailing Enter). Shared engine with
  // mobile. Fed by the dock's 📎 button, drag-drop onto the terminal pane, and
  // image clipboard-paste. After inject we re-focus xterm so the user keeps the
  // cursor in the prompt to add context.
  const sendToTerm = React.useCallback(
    (text: string) => termRef.current?.send(text),
    [],
  )
  const focusTerm = React.useCallback(() => termRef.current?.focus(), [])
  const attach = useAttachmentUpload(sendToTerm, focusTerm)

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
   *  now-edited prompt. */
  const onEditSendEnter = React.useCallback(() => {
    termRef.current?.sendKey('Enter')
  }, [])

  // feat-session-info — the title-click info panel. `titleRef` is the Popover's
  // anchor (the title <button> in the header); the panel only mounts while open.
  const [infoOpen, setInfoOpen] = React.useState(false)
  const titleRef = React.useRef<HTMLButtonElement>(null)

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
  const wantFocusRef = React.useRef(false)
  React.useEffect(() => {
    if (current?.status === 'stopped' || current?.status === 'error') {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

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
  })

  const status = current?.status ?? 'starting'
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
        data-vr-strip-mode={stripMode}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 px-3 text-[13px] font-semibold tracking-tight text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">Sessions</span>
          <FocusStripModeToggle mode={stripMode} onChange={setStripMode} />
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
          {sessions.length === 0 &&
          strip.teamGroups.length === 0 &&
          strip.userGroups.length === 0 ? (
            <p className="px-1 pt-2 text-[13px] text-muted-foreground">
              No other sessions.
            </p>
          ) : (
            <>
              {/* Detected teams — grouped (header + lead + teammates), mirroring
                  the overview TEAM CARD. Pinned ABOVE user groups because that
                  matches how the overview pins team cards above the grid in
                  every sort mode. Renders nothing when there are no teams. */}
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

              {/* User groups — one collapsible section each, with the same
                  6-mode sort chip the overview uses on its group headers
                  (shared component, single source of truth). The implicit
                  "Ungrouped" bucket renders here too when it has any
                  sessions, mirroring the overview's behaviour. */}
              {strip.userGroups.map((g) => (
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
          title={title}
          status={status}
          activity={current?.activity}
          error={current?.error}
          onDetach={onDetach}
          onStop={onStop}
          onMakeTeam={onMakeTeam}
          // Open only — Radix closes the popover on outside-click / Escape, so a
          // toggle here would race its onOpenChange(false) and re-open it.
          onTitleClick={() => setInfoOpen(true)}
          titleRef={titleRef}
        />

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
        <div
          ref={termPaneRef}
          className="relative min-h-0 flex-1"
          onPaste={onPaste}
        >
          <Dropzone
            onFiles={attach.handleFiles}
            disabled={status === 'stopped'}
            className="h-full w-full"
          >
            {/* A `stopped` session's tmux pty is gone — opening the live WS would
                just 101-upgrade then get closed in a loop. Detect it up front
                from the session row and render the calm StoppedSession surface
                instead. When it transitions back to running, this swaps to
                LiveTerminal. */}
            {status === 'stopped' ? (
              <StoppedSession name={name} />
            ) : (
              /* LiveTerminal — reused verbatim. The keydown capture
                 deliberately does NOT preventDefault on ordinary keys, so
                 Ctrl-C / arrows / Tab / Shift+Tab / Esc / text all reach xterm's
                 onData → the pty WS. */
              <LiveTerminal name={name} onReady={handleTermReady} />
            )}
          </Dropzone>
          {/* Subtle "Capturing input" pill — only visible while xterm holds DOM
              focus. Click outside (header / dock / strip) releases. Esc is NOT
              the release because Esc must reach the terminal (vim, REPLs). */}
          <TerminalCaptureIndicator
            capturing={capturingInput && status !== 'stopped'}
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

        <DesktopDock
          onSendKey={(label) => termRef.current?.sendKey(label)}
          onRunSlash={(cmd) => termRef.current?.send(cmd + '\r')}
          onSnippets={() => {
            onSnippets?.()
            setSnippetsOpen(true)
          }}
          onAttach={attach.handleFiles}
          // "Edit in native editor" relies on Claude's Ctrl+G ($EDITOR bridge),
          // so it's a no-op on codex/shell panes — hide it for non-Claude sessions.
          onEdit={current?.provider === 'claude' ? onEdit : undefined}
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
        onInsert={(body) => termRef.current?.send(body)}
        onRun={(body) => termRef.current?.send(body + '\r')}
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
    </div>
  )
}

export default DesktopSplit
