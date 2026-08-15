// The renderer SEAM — which pane a focus route mounts, as pure functions.
//
// Fase A1 wrote this decision inline in `desktop-split.tsx`; fase A5 needs the
// same decision at the MOBILE seam (`routes/focus/mobile.tsx`), and two copies
// of a three-gate decision is how the two surfaces end up disagreeing about
// what "the experiment is on" means. So it lives here, next to `flag.ts` (the
// three gates themselves) and, like it, as pure functions with no React in
// them — which is also what makes the seam assertable in `bun test`
// (`tests/unit/chat-seam.test.ts`), a runner with no DOM.
//
// Nothing here decides ELIGIBILITY — that is `flag.ts` (`chatEligible` /
// `chatRendererOn`) and its React binding `use-chat-renderer.ts`. This module
// only answers the two questions a route asks after those gates have spoken:
// which renderer did the user end up with, and what does the chrome around it
// look like.

export type ChatRenderer = 'chat' | 'terminal'

/** A manual tap on the renderer switch, keyed by the session it was made on. */
export interface RendererOverride {
  /** The route `:name` at the time of the tap — an override must not survive a
   *  navigation to another session (each session gets its own default). */
  name: string
  value: ChatRenderer
}

/**
 * Which renderer this pane shows, or `null` for "not decided yet".
 *
 * FULLY DERIVED — the only state a route holds is the user's manual tap. A
 * `useState` default seeded from the flag would mean setState-in-effect
 * (cascading renders, and the lint rule `react-hooks/set-state-in-effect`), and
 * it could be stomped by a late flag/eligibility resolve.
 *
 * `resolved` is "the sessions query has delivered THIS row". With the
 * experiment on we wait for it before choosing, so the terminal never
 * mounts→attaches→unmounts on every focus load (a wasted pty WS and a visible
 * flash — the focus-no-mobile-flash class of bug). The mobile route synthesizes
 * a placeholder row so its terminal can mount before the query lands, so it
 * must pass the presence of the REAL row here, not `current != null`.
 */
export function pickRenderer(
  override: RendererOverride | null,
  name: string,
  resolved: boolean,
  chatOn: boolean,
): ChatRenderer | null {
  if (override && override.name === name) return override.value
  if (!resolved) return null
  return chatOn ? 'chat' : 'terminal'
}

/**
 * The chat renderer is what this pane MOUNTS.
 *
 * `settingOn` is re-checked alongside `chatOn` on purpose: `chatOn` is read
 * through the hook (settings toggle AND kill-switch AND eligibility), and a
 * surface that could show chat while the Experimental toggle reads off would be
 * an experiment nobody can turn off.
 *
 * A `stopped` session is never chat: its pty is gone, so the route owes the
 * user the calm `StoppedSession` surface (with its restart affordance) rather
 * than a transcript of a conversation that cannot continue.
 */
export function chatPaneActive(
  settingOn: boolean,
  chatOn: boolean,
  renderer: ChatRenderer | null,
  status: string | undefined,
): boolean {
  return settingOn && chatOn && renderer === 'chat' && status !== 'stopped'
}

/**
 * The live terminal is what this pane mounts.
 *
 * False in exactly one case: the experiment is ON and the row has not resolved
 * yet — render nothing for a frame rather than flash a doomed terminal. With
 * the experiment OFF this is unconditionally true, which is what keeps the
 * flag-off path byte-identical to the pre-A1 route.
 */
export function terminalPaneMounts(
  settingOn: boolean,
  renderer: ChatRenderer | null,
  chatActive: boolean,
): boolean {
  if (chatActive) return false
  return !settingOn || renderer != null
}

/**
 * What the MOBILE route's chrome does under each renderer (fase A5).
 *
 * The phone has no room for two headers and no use for a key bar over a surface
 * with no pty in it, so the seam is a chrome swap as much as a pane swap. Every
 * field below is consumed by `routes/focus/mobile.tsx`:
 *
 *   · `focusHeader` — the 44px terminal top bar. OFF under chat: the chat
 *     surface draws its OWN floating header card (`mobile-light.png`), and
 *     stacking the two would push the transcript down by a bar it already has.
 *   · `keyBar` / `joystick` — both drive raw key bytes into a pty through the
 *     terminal handle, which is null with no terminal mounted. Hidden rather
 *     than left to no-op silently (the dead-accessory-bar bug this route has
 *     already shipped once).
 *   · `switchRow` / `switchInHeader` — the switch is reachable in EXACTLY one
 *     place at a time: a slim row under the focus header while the terminal is
 *     up, the header card's trailing slot once chat is up (the boards' floating
 *     chrome). Never both, or the phone grows a second toolbar.
 *   · `dockChat` — the dock stays (session switching, snippets, dictation all
 *     work through the input plane) but sheds every terminal-only control, the
 *     same reduction `desktop-split.tsx` makes with `rawKeys={!chatActive}`.
 */
export interface MobileChrome {
  focusHeader: boolean
  keyBar: boolean
  joystick: boolean
  switchRow: boolean
  switchInHeader: boolean
  dockChat: boolean
}

export function mobileChrome(chatOn: boolean, chatActive: boolean): MobileChrome {
  return {
    focusHeader: !chatActive,
    keyBar: !chatActive,
    joystick: !chatActive,
    // `chatOn` and not `chatSetting`: an ineligible session (a shell pane, a
    // remote host, a team lead) must not grow a control that would switch it to
    // a renderer it is not allowed to have.
    switchRow: chatOn && !chatActive,
    switchInHeader: chatActive,
    dockChat: chatActive,
  }
}
