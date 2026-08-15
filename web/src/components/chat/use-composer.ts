// The composer's BEHAVIOUR (fase A4 T3) — the key contract, the pre-send gate,
// and the React hook that binds them to a session.
//
// The draft store and the insert seam live next door in `composer-draft.ts`
// (the entry chunk imports those; this module stays in the lazy chat chunk).
// What is deliberately NOT here: the pending echo and the delivery watchdog
// (T4). This module's `submit` resolves when the POST resolves and says so; it
// never claims delivery.

import * as React from 'react'

import type { SessionInput } from '../../lib/session-input'

import {
  bindComposerField,
  getDraft,
  growTextarea,
  insertIntoComposer,
  setDraft,
  subscribeDraft,
} from './composer-draft'
import type { PeekLens } from './peek-lens'

/** How much of the terminal's own draft the block banner quotes back. Enough to
 *  recognise the sentence, short enough that the banner stays one line. */
export const DRAFT_PREVIEW_CHARS = 60

// ── The key contract ────────────────────────────────────────────────────────

/** What a keystroke MEANS in the composer. Extracted from the component so the
 *  IME matrix can be asserted without a DOM (`chat-interactive.test.tsx`). */
export type ComposerIntent = 'submit' | 'newline' | 'stop' | 'clear' | 'pass'

/** The shape a React keydown event and a plain object both satisfy. */
export interface ComposerKeyEvent {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
  isComposing?: boolean
}

function composing(e: ComposerKeyEvent): boolean {
  // `isComposing` is the standard; keyCode 229 is the Android/GBoard fallback
  // the repo already relies on in two places (`hooks/use-live-term.ts:1349`,
  // `lib/android-ime.ts`) because soft keyboards deliver nearly everything as
  // composition and some of them never set `isComposing` on the keydown that
  // commits. Enter during composition is the IME's own "accept this candidate",
  // NOT a submit — treating it as one is how a chat box sends half a word in
  // Japanese, and every keystroke in Korean.
  return (
    e.isComposing === true ||
    e.nativeEvent?.isComposing === true ||
    e.keyCode === 229 ||
    e.nativeEvent?.keyCode === 229
  )
}

/**
 * The whole keyboard contract, as data.
 *
 *   Enter                 → submit (unless composing — then the IME owns it)
 *   Shift+Enter           → newline
 *   Escape, draft present → clear the draft
 *   Escape, draft empty   → stop the turn, when there is one
 *
 * ONE ESCAPE, ONE MEANING: with text in the box Escape clears the box; with an
 * empty box it interrupts the agent. Doing both on one press would make "I
 * changed my mind about this sentence" occasionally kill a running turn.
 */
export function composerKeyIntent(
  e: ComposerKeyEvent,
  ctx: { draft: string; active: boolean },
): ComposerIntent {
  // A COMPOSITION OWNS EVERY KEY IT IS GIVEN, not just Enter. Escape during an
  // IME composition means "cancel this conversion" — swallowing it to clear the
  // draft would throw away the whole message on the keystroke a CJK typist uses
  // dozens of times a paragraph, and `preventDefault` would leave the candidate
  // window stranded. Same reason keyCode 229 is honoured: on Android nearly
  // everything arrives as composition.
  if (composing(e)) return 'pass'
  if (e.key === 'Enter') {
    if (e.shiftKey) return 'newline'
    // A modified Enter is somebody else's shortcut (⌘Enter is not ours yet).
    if (e.metaKey || e.ctrlKey || e.altKey) return 'pass'
    return 'submit'
  }
  if (e.key === 'Escape') {
    if (ctx.draft.length > 0) return 'clear'
    return ctx.active ? 'stop' : 'pass'
  }
  return 'pass'
}

// ── The hook ────────────────────────────────────────────────────────────────

/** Why the composer refused to send. One shape, so the banner's copy lives in
 *  the component and the reason lives in the logic. */
export interface ComposerNotice {
  kind: 'tui-draft' | 'dialog' | 'send-failed' | 'stop-failed'
  /** The evidence: the terminal's own draft, or the error's message. */
  detail?: string
}

/** Send, or refuse and say why. */
export type SendGate = { send: true } | { send: false; notice: ComposerNotice }

/**
 * THE PRE-SEND GATE (master plan §3), as data so it can be asserted without a
 * DOM. Read the truth table rather than the prose:
 *
 *   lens === null (the peek FAILED)   → send. "I could not look" must not mean
 *                                       "you cannot type": the T4 watchdog is
 *                                       the honest layer when a send vanishes.
 *   lens.dialog                       → refuse. `/send` into an open permission
 *                                       dialog was never A0-tested (a0 §5); the
 *                                       card above can answer it (T7).
 *   lens.composerDraft                → refuse. `send_text` pastes at the TUI's
 *                                       prompt, so it would concatenate onto
 *                                       the user's half-sentence and submit the
 *                                       pair — silently.
 *   otherwise                         → send.
 *
 * Dialog outranks draft: with a dialog up, what the lens reads as a "draft" is
 * more likely to be the dialog's own furniture, and the dialog is the more
 * specific thing to say.
 */
export function sendGate(lens: PeekLens | null): SendGate {
  if (!lens) return { send: true }
  if (lens.dialog) return { send: false, notice: { kind: 'dialog' } }
  if (lens.composerDraft) {
    return { send: false, notice: { kind: 'tui-draft', detail: lens.composerDraft } }
  }
  return { send: true }
}

export interface UseComposerOptions {
  name: string
  /** The input plane. In the chat renderer this is the REST one. */
  input: Pick<SessionInput, 'submit' | 'sendKey'>
  /** The shared peek lens (T2). Omitted on a bench/test render — then the
   *  pre-send verification is skipped exactly as it is on a peek failure. */
  peek?: { refresh: () => Promise<PeekLens | null> }
  /** Session status is `active` — a turn is running, so the trailing control is
   *  Stop and a bare Escape interrupts. */
  active: boolean
}

export interface ComposerHandle {
  draft: string
  setDraft: (value: string) => void
  ref: React.RefObject<HTMLTextAreaElement | null>
  /** A POST is in flight. The control disables so a slow pty cannot be
   *  double-fired; it is NOT a delivery claim (that is T4's watchdog). */
  sending: boolean
  notice: ComposerNotice | null
  dismissNotice: () => void
  submit: () => void
  stop: () => void
  insert: (text: string) => void
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
}

export function useComposer({
  name,
  input,
  peek,
  active,
}: UseComposerOptions): ComposerHandle {
  const draft = React.useSyncExternalStore(
    React.useCallback((fn) => subscribeDraft(name, fn), [name]),
    React.useCallback(() => getDraft(name), [name]),
    React.useCallback(() => getDraft(name), [name]),
  )
  const ref = React.useRef<HTMLTextAreaElement | null>(null)
  const [sending, setSending] = React.useState(false)
  const [notice, setNotice] = React.useState<ComposerNotice | null>(null)

  // Publish the field so `insertIntoComposer` (and therefore every insert
  // surface in the app) can find this session's caret.
  React.useEffect(() => bindComposerField(name, () => ref.current), [name])

  // A draft restored from another mount (renderer toggle, session switch) has
  // to arrive at its grown height, not at one line.
  React.useEffect(() => {
    growTextarea(ref.current)
  }, [draft, name])

  const set = React.useCallback(
    (value: string) => setDraft(name, value),
    [name],
  )

  const dismissNotice = React.useCallback(() => setNotice(null), [])

  // The submit path reads the STORE, not the render's `draft`: it is async, and
  // by the time the peek resolves the user may have typed on. The in-flight
  // flag is a ref for the same reason — a second Enter arriving before React
  // has re-rendered must still be refused (state alone would let it through).
  const sendingRef = React.useRef(false)

  const submit = React.useCallback(() => {
    // `raw` is what the box held when Enter was pressed; `text` is what goes on
    // the wire. Both are kept because the box is NOT frozen while the send is in
    // flight — see the clear below.
    const raw = getDraft(name)
    const text = raw.trim()
    if (text.length === 0 || sendingRef.current) return
    setNotice(null)
    void (async () => {
      sendingRef.current = true
      setSending(true)
      try {
        // PEEK-VERIFY BEFORE SEND (master plan §3). `POST /send` types into
        // whatever is at the TUI's prompt: if the user left half a sentence
        // there, the server's paste CONCATENATES onto it and submits the pair.
        // One ~50ms peek is the only thing standing between a chat send and
        // that silent corruption.
        const gate = sendGate(peek ? await peek.refresh() : null)
        if (!gate.send) {
          setNotice(gate.notice)
          return
        }
        await input.submit(text)
        // Cleared only AFTER the POST resolves: a rejected send keeps the
        // user's words in the box, where they can retry them.
        //
        // And cleared by SUBTRACTION, not by assignment. A peek plus a POST is
        // two round-trips; people keep typing through them (measured: text typed
        // ~40 ms after Enter). A blind `setDraft('')` deletes those keystrokes
        // with no undo and no trace — the same silent-corruption class the peek
        // gate exists to prevent, on the other side of the wire. So only the
        // sent prefix goes; anything typed after it stays in the box.
        const after = getDraft(name)
        setDraft(
          name,
          after.startsWith(raw) ? after.slice(raw.length).replace(/^\s+/, '') : after,
        )
      } catch (err) {
        setNotice({
          kind: 'send-failed',
          detail: err instanceof Error ? err.message : undefined,
        })
      } finally {
        sendingRef.current = false
        setSending(false)
      }
    })()
  }, [input, name, peek])

  const stop = React.useCallback(() => {
    // Escape is the interrupt every one of the three TUIs understands; the
    // allowlist carries it, so this is the same key the terminal renderer's
    // Esc sends (`KEY_ALLOWLIST`, lifecycle.rs:1696).
    //
    // A REJECTED interrupt has to be said out loud. "I pressed Stop and the
    // agent kept going" is the one failure this surface must never absorb into
    // a console warning — and on the REST plane a 404/409 (session gone,
    // restarted under the same name) is exactly how it arrives.
    void input.sendKey('Escape').catch((err: unknown) => {
      setNotice({
        kind: 'stop-failed',
        detail: err instanceof Error ? err.message : undefined,
      })
    })
  }, [input])

  const insert = React.useCallback(
    (text: string) => insertIntoComposer(name, text),
    [name],
  )

  const onChange = React.useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      set(e.target.value)
      growTextarea(e.target)
      if (notice) setNotice(null)
    },
    [notice, set],
  )

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const intent = composerKeyIntent(e, { draft: getDraft(name), active })
      if (intent === 'pass' || intent === 'newline') return // the browser types it
      e.preventDefault()
      if (intent === 'submit') submit()
      else if (intent === 'clear') {
        set('')
        setNotice(null)
      } else if (intent === 'stop') stop()
    },
    [active, name, set, stop, submit],
  )

  return {
    draft,
    setDraft: set,
    ref,
    sending,
    notice,
    dismissNotice,
    submit,
    stop,
    insert,
    onChange,
    onKeyDown,
  }
}
