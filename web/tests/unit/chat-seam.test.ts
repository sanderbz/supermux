/**
 * The renderer SEAM — what each focus route mounts, and what the chrome does.
 * ─────────────────────────────────────────────────────────────────────────────
 * `chat-flag.test.ts` pins the three GATES (setting, kill-switch, eligibility).
 * This pins what the routes do with the answer, for both seams at once:
 * `desktop-split.tsx` (fase A1) and `routes/focus/mobile.tsx` (fase A5) call
 * these same four functions, so a mobile/desktop disagreement about "the
 * experiment is on" is a failing test rather than a phone-only bug.
 *
 * The four failures these exist to catch, each of which shipped once somewhere
 * in this app's history:
 *
 *   1. THE DOOMED-TERMINAL FLASH. With the experiment on, choosing before the
 *      sessions query resolves mounts the terminal, opens a pty WS, and
 *      unmounts it a frame later. `pickRenderer` answers `null` instead — and
 *      the MOBILE route must pass the presence of the REAL row, because it
 *      synthesizes a placeholder one whose empty `provider` is ineligible.
 *   2. THE STUCK OVERRIDE. A manual tap is keyed by session name; navigating to
 *      another session must fall back to that session's default.
 *   3. A CHAT PANE OVER A DEAD PTY. `stopped` is never chat — the route owes
 *      the calm StoppedSession surface with its restart affordance.
 *   4. DEAD CHROME. The KeyBar, the joystick, the dock's key rows and the tap-
 *      to-focus gate all drive raw bytes through a terminal handle that is null
 *      under chat. This route has already shipped one accessory bar whose taps
 *      silently did nothing.
 */
import { describe, expect, test } from 'bun:test'

import {
  chatPaneActive,
  mobileChrome,
  paneIsDead,
  pickRenderer,
  terminalPaneMounts,
  type RendererOverride,
} from '../../src/components/chat/seam'

const NAME = 'release-train'

describe('pickRenderer — which renderer this pane shows', () => {
  test('flag on + eligible + row resolved → chat is the DEFAULT', () => {
    expect(pickRenderer(null, NAME, true, true)).toBe('chat')
  })

  test('flag off / ineligible → terminal, exactly as before the experiment', () => {
    expect(pickRenderer(null, NAME, true, false)).toBe('terminal')
  })

  test('row unresolved → undecided (null), never a doomed terminal', () => {
    expect(pickRenderer(null, NAME, false, true)).toBeNull()
    expect(pickRenderer(null, NAME, false, false)).toBeNull()
  })

  test('a manual tap wins over the default, in both directions', () => {
    const toTerminal: RendererOverride = { name: NAME, value: 'terminal' }
    const toChat: RendererOverride = { name: NAME, value: 'chat' }
    expect(pickRenderer(toTerminal, NAME, true, true)).toBe('terminal')
    expect(pickRenderer(toChat, NAME, true, false)).toBe('chat')
  })

  test('a tap made on ANOTHER session does not follow the navigation', () => {
    const stale: RendererOverride = { name: 'patch', value: 'terminal' }
    expect(pickRenderer(stale, NAME, true, true)).toBe('chat')
  })

  test('a tap decides even before the row resolves (the user asked)', () => {
    const tap: RendererOverride = { name: NAME, value: 'terminal' }
    expect(pickRenderer(tap, NAME, false, false)).toBe('terminal')
  })
})

describe('chatPaneActive — the chat renderer has the pane', () => {
  test('all three gates plus the choice', () => {
    expect(chatPaneActive(true, true, 'chat', 'idle')).toBe(true)
    expect(chatPaneActive(false, true, 'chat', 'idle')).toBe(false)
    expect(chatPaneActive(true, false, 'chat', 'idle')).toBe(false)
    expect(chatPaneActive(true, true, 'terminal', 'idle')).toBe(false)
    expect(chatPaneActive(true, true, null, 'idle')).toBe(false)
  })

  test('a STOPPED session is never chat — its pty is gone', () => {
    expect(chatPaneActive(true, true, 'chat', 'stopped')).toBe(false)
  })

  test('every other status is fair game', () => {
    for (const status of ['starting', 'active', 'waiting', 'idle', 'error']) {
      expect(chatPaneActive(true, true, 'chat', status)).toBe(true)
    }
  })
})

describe('terminalPaneMounts — the flag-off path is unchanged', () => {
  test('experiment OFF → the terminal mounts unconditionally', () => {
    expect(terminalPaneMounts(false, null, false)).toBe(true)
    expect(terminalPaneMounts(false, 'terminal', false)).toBe(true)
  })

  test('experiment ON, row unresolved → nothing mounts for that frame', () => {
    expect(terminalPaneMounts(true, null, false)).toBe(false)
  })

  test('experiment ON, terminal chosen → the terminal mounts', () => {
    expect(terminalPaneMounts(true, 'terminal', false)).toBe(true)
  })

  test('the two renderers are never both mounted', () => {
    expect(terminalPaneMounts(true, 'chat', true)).toBe(false)
  })
})

describe('mobileChrome — the phone chrome swaps with the pane (fase A5)', () => {
  const terminal = mobileChrome(false, false)
  const eligibleTerminal = mobileChrome(true, false)
  const chat = mobileChrome(true, true)

  test('terminal mode is the route as it always was', () => {
    expect(terminal).toEqual({
      focusHeader: true,
      keyBar: true,
      joystick: true,
      switchRow: false,
      switchInHeader: false,
      dockChat: false,
    })
  })

  test('chat mode hides every surface that writes raw bytes to a pty', () => {
    expect(chat.keyBar).toBe(false)
    expect(chat.joystick).toBe(false)
    expect(chat.dockChat).toBe(true)
  })

  test('chat mode drops the focus header — the surface draws its own card', () => {
    expect(chat.focusHeader).toBe(false)
    expect(terminal.focusHeader).toBe(true)
  })

  test('the switch is reachable in exactly ONE place at a time', () => {
    for (const c of [terminal, eligibleTerminal, chat]) {
      expect(c.switchRow && c.switchInHeader).toBe(false)
    }
    // Terminal up on an eligible session: the rail under the focus header is
    // the only way back to chat, so it has to be there.
    expect(eligibleTerminal.switchRow).toBe(true)
    expect(chat.switchInHeader).toBe(true)
  })

  test('an INELIGIBLE session grows no switch at all', () => {
    expect(terminal.switchRow).toBe(false)
    expect(terminal.switchInHeader).toBe(false)
  })
})

describe('the mobile seam end to end', () => {
  /** The mobile route's own composition, in one place: the placeholder row it
   *  renders before the query lands is NOT what the seam reads. */
  function seam(opts: {
    settingOn: boolean
    chatOn: boolean
    resolved: boolean
    status: string
    override?: RendererOverride | null
  }) {
    const renderer = pickRenderer(
      opts.override ?? null,
      NAME,
      opts.resolved,
      opts.chatOn,
    )
    const chatActive = chatPaneActive(
      opts.settingOn,
      opts.chatOn,
      renderer,
      opts.status,
    )
    return {
      renderer,
      chatActive,
      terminal: terminalPaneMounts(opts.settingOn, renderer, chatActive),
      chrome: mobileChrome(opts.chatOn, chatActive),
    }
  }

  test('a local Claude session with the flag on opens in CHAT', () => {
    const s = seam({ settingOn: true, chatOn: true, resolved: true, status: 'idle' })
    expect(s.chatActive).toBe(true)
    expect(s.terminal).toBe(false)
    expect(s.chrome.focusHeader).toBe(false)
    expect(s.chrome.switchInHeader).toBe(true)
  })

  test('the terminal is ONE tap away, and takes its chrome back with it', () => {
    const s = seam({
      settingOn: true,
      chatOn: true,
      resolved: true,
      status: 'idle',
      override: { name: NAME, value: 'terminal' },
    })
    expect(s.chatActive).toBe(false)
    expect(s.terminal).toBe(true)
    expect(s.chrome).toEqual({
      focusHeader: true,
      keyBar: true,
      joystick: true,
      switchRow: true,
      switchInHeader: false,
      dockChat: false,
    })
  })

  test('the kill-switch (chatOn=false) leaves the route exactly as it was', () => {
    const s = seam({ settingOn: true, chatOn: false, resolved: true, status: 'idle' })
    expect(s.chatActive).toBe(false)
    expect(s.terminal).toBe(true)
    expect(s.chrome).toEqual(mobileChrome(false, false))
  })

  test('before the row lands nothing mounts — no pty WS for a chat session', () => {
    const s = seam({ settingOn: true, chatOn: false, resolved: false, status: 'idle' })
    expect(s.renderer).toBeNull()
    expect(s.chatActive).toBe(false)
    expect(s.terminal).toBe(false)
  })

  test('a stopped session falls to the stopped surface under either renderer', () => {
    const s = seam({ settingOn: true, chatOn: true, resolved: true, status: 'stopped' })
    expect(s.chatActive).toBe(false)
    // The route's own ternary puts StoppedSession ahead of both renderers; what
    // matters here is that the chat pane never claims it.
    expect(s.chrome.dockChat).toBe(false)
  })
})

describe('is there still a process behind this pane? (paneIsDead)', () => {
  test('a running session is not dead — no clause fires', () => {
    expect(paneIsDead('idle', false, undefined)).toBe(false)
    expect(paneIsDead('active', false, undefined)).toBe(false)
    // A turn-level agent error is NOT a dead pane: the pty is fine, the model
    // failed a request. Widening the predicate to any `error` would take the
    // chat surface away from a rate-limited session that only needs a retry.
    expect(paneIsDead('idle', false, 'rate_limit')).toBe(false)
    expect(paneIsDead('active', false, 'billing_error')).toBe(false)
  })

  test('the two pre-existing signals still fire', () => {
    expect(paneIsDead('stopped', false, undefined)).toBe(true)
    expect(paneIsDead('idle', true, undefined)).toBe(true)
  })

  test('a crashed HOLDER is a dead pane even while the row still reads idle', () => {
    // THE REGRESSION. `kill -9` on a pty holder is broadcast to the browser as
    // a `holder_died` badge; the row's status flip is not reliably broadcast at
    // all, and under the chat renderer there is no terminal socket, so
    // `termGone` can never fire either. With only the first two clauses the
    // browser sat on a live-looking chat surface over a pane with no process:
    // enabled composer, sends reported as delivered, for as long as the tab
    // stayed open.
    expect(paneIsDead('idle', false, 'holder_died')).toBe(true)
    expect(paneIsDead('active', false, 'holder_died')).toBe(true)
  })

  test('a healed session comes back — the badge is cleared, not sticky', () => {
    // `clear_holder_death_badge` broadcasts `error: null` on the next alive
    // tick. The predicate must not latch, or one crash would strand a session
    // on the stopped card for the life of the tab.
    expect(paneIsDead('active', false, undefined)).toBe(false)
  })

  test('a dead pane is never chat — the seam hands over', () => {
    const dead = paneIsDead('idle', false, 'holder_died')
    expect(chatPaneActive(true, true, 'chat', dead ? 'stopped' : 'idle')).toBe(false)
  })
})
