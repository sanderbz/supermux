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
import { classifySlash, readTrigger, slashName } from './slash'

/** How much of the terminal's own draft the block banner quotes back. Enough to
 *  recognise the sentence, short enough that the banner stays one line. */
export const DRAFT_PREVIEW_CHARS = 60

// ── The key contract ────────────────────────────────────────────────────────

/** What a keystroke MEANS in the composer. Extracted from the component so the
 *  IME matrix can be asserted without a DOM (`chat-interactive.test.tsx`).
 *
 *  The four `picker-*` intents exist only while the `@`/`/` popover is open
 *  (fase A4 T9) — they are what keeps ONE ESCAPE, ONE MEANING true once a
 *  second thing on this surface can be closed. */
export type ComposerIntent =
  | 'submit'
  | 'newline'
  | 'stop'
  | 'clear'
  | 'pass'
  | 'picker-up'
  | 'picker-down'
  | 'picker-accept'
  | 'picker-close'

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
  ctx: { draft: string; active: boolean; picker?: boolean },
): ComposerIntent {
  // A COMPOSITION OWNS EVERY KEY IT IS GIVEN, not just Enter. Escape during an
  // IME composition means "cancel this conversion" — swallowing it to clear the
  // draft would throw away the whole message on the keystroke a CJK typist uses
  // dozens of times a paragraph, and `preventDefault` would leave the candidate
  // window stranded. Same reason keyCode 229 is honoured: on Android nearly
  // everything arrives as composition.
  if (composing(e)) return 'pass'
  // THE POPOVER OWNS ITS OWN KEYS while it is open (fase A4 T9). Escape is the
  // one that matters: with a picker up, Escape closes the PICKER — it does not
  // also clear the draft and it certainly does not stop the turn. One escape,
  // one meaning, even when there are two things to escape from.
  if (ctx.picker) {
    if (e.key === 'ArrowUp') return 'picker-up'
    if (e.key === 'ArrowDown') return 'picker-down'
    if (e.key === 'Escape') return 'picker-close'
    if (e.key === 'Tab' && !e.shiftKey) return 'picker-accept'
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Falls back to `submit` in the hook when the list has nothing to accept
      // (a query that matches nothing must not swallow the message).
      return 'picker-accept'
    }
  }
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
  kind:
    | 'tui-draft'
    | 'dialog'
    | 'send-failed'
    | 'stop-failed'
    /** A `/model`-class command: it opens a picker in the TUI, so chat refuses
     *  to send it and points at the terminal (fase A4 T9). */
    | 'slash-picker'
    /** A command that is not one of Claude's built-ins went out AS TEXT. Not a
     *  refusal — a receipt, so a typo does not quietly become a message. */
    | 'slash-note'
  /** The evidence: the terminal's own draft, the command, or the error. */
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

/**
 * What the popover registers with the composer (fase A4 T9).
 *
 * The LIST lives in the picker — it owns the query results and therefore the
 * highlight — while the KEYS arrive at the textarea, which is the only thing
 * that has focus (a popover that stole focus would close the soft keyboard on
 * every phone). So the picker hands these two verbs back and the composer's key
 * handler calls them.
 */
export interface ComposerPickerApi {
  /** Move the highlight; wraps at both ends. */
  move: (delta: number) => void
  /** Accept the highlighted row. `false` = there was nothing to accept, and the
   *  keystroke falls through to its normal meaning (Enter still SENDS). */
  accept: () => boolean
}

/** The trigger the composer is sitting in, plus the verbs the popover needs. */
export interface ComposerPickerState {
  open: boolean
  kind: '@' | '/'
  query: string
  /** Replace the trigger token with this text and close the popover. */
  pick: (value: string) => void
  close: () => void
  /** Called by the popover on mount/unmount to hand over its two verbs. */
  bind: (api: ComposerPickerApi | null) => void
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
  /** The `@`/`/` surface (fase A4 T9). */
  picker: ComposerPickerState
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  /** Caret moves (arrow keys, clicks) — the trigger is read at the CARET, not
   *  at the end of the draft. */
  onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void
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
  // The caret, mirrored into state because the TRIGGER is read at it. It starts
  // at 0 on purpose: a draft restored from another mount (renderer toggle) must
  // not pop a popover nobody asked for, and 0 can never be inside a token.
  const [caret, setCaret] = React.useState(0)
  // What the user has already closed, so Escape (and an accepted pick) stay
  // closed while they keep typing. Keyed by the token's TEXT, not just its
  // offset: clearing the box and typing `@` again is a new question.
  const [closed, setClosed] = React.useState<{ start: number; text: string } | null>(null)
  const pickerApi = React.useRef<ComposerPickerApi | null>(null)

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
    // THE SLASH GATE (fase A4 T9), before the peek because it needs no network.
    // A `/model`-class command opens a PICKER in the TUI: send it from chat and
    // the widget sits on a pty nobody is looking at, silently eating whatever
    // the session is told next. So it is not sent — the composer names the
    // command and offers the terminal, where it can actually be answered.
    const slash = classifySlash(text)
    if (slash === 'picker') {
      setNotice({ kind: 'slash-picker', detail: slashName(text) ?? undefined })
      return
    }
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
        // A command that is not one of Claude's built-ins WENT — as text, which
        // is what a project/skill command is. The receipt exists so a typo
        // (`/compct`) does not quietly become a message nobody meant to write.
        if (slash === 'unknown') {
          setNotice({ kind: 'slash-note', detail: slashName(text) ?? undefined })
        }
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
    (text: string) => {
      // The caret mirror has to follow a programmatic insert too, or the next
      // keystroke would read the trigger at a stale offset. (This is also what
      // makes the `+` button work: it inserts `@`, and the popover opens.)
      setCaret(insertIntoComposer(name, text))
      // An insert is a fresh request from the user, so a popover they dismissed
      // earlier must not swallow it — tapping `+` twice has to work twice.
      setClosed(null)
    },
    [name],
  )

  // ── The `@`/`/` trigger (fase A4 T9) ──────────────────────────────────────
  // Derived, never stored: the token under the caret IS the draft plus the
  // caret, and a second copy of it in state is a second thing to get wrong.
  const trigger = React.useMemo(
    () => readTrigger(draft, Math.min(caret, draft.length)),
    [caret, draft],
  )
  const token = trigger ? draft.slice(trigger.start, trigger.end) : ''
  const pickerOpen =
    trigger != null && !(closed != null && closed.start === trigger.start && token.startsWith(closed.text))

  const closePicker = React.useCallback(() => {
    if (trigger) setClosed({ start: trigger.start, text: token })
  }, [token, trigger])

  const pick = React.useCallback(
    (value: string) => {
      if (!trigger) return
      // Replace the WHOLE token, not just the query: `@mai` → `@src/main.rs`,
      // with T3's spacing rule doing the joining so a pick reads the same here
      // as an attachment path does.
      setCaret(insertIntoComposer(name, value, { start: trigger.start, end: trigger.end }))
      // Closed against the accepted text: typing on keeps it closed, but
      // backspacing INTO the pick re-opens it (the user is editing the token
      // again, which is the only reason to be there).
      setClosed({ start: trigger.start, text: value })
    },
    [name, trigger],
  )

  const bindPicker = React.useCallback((api: ComposerPickerApi | null) => {
    pickerApi.current = api
  }, [])

  const onChange = React.useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      set(e.target.value)
      setCaret(e.target.selectionStart ?? e.target.value.length)
      growTextarea(e.target)
      if (notice) setNotice(null)
    },
    [notice, set],
  )

  const onSelect = React.useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    setCaret(el.selectionStart ?? el.value.length)
  }, [])

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const intent = composerKeyIntent(e, {
        draft: getDraft(name),
        active,
        picker: pickerOpen,
      })
      if (intent === 'pass' || intent === 'newline') return // the browser types it
      // A picker Enter that has nothing to accept must still SEND. The
      // preventDefault therefore waits until the outcome is known — the one
      // place in this handler where the order matters.
      if (intent === 'picker-accept') {
        const took = pickerApi.current?.accept() ?? false
        if (took) {
          e.preventDefault()
          return
        }
        if (e.key === 'Tab') return // nothing to complete: Tab keeps its browser meaning
        e.preventDefault()
        submit()
        return
      }
      e.preventDefault()
      if (intent === 'submit') submit()
      else if (intent === 'clear') {
        set('')
        setNotice(null)
      } else if (intent === 'stop') stop()
      else if (intent === 'picker-up') pickerApi.current?.move(-1)
      else if (intent === 'picker-down') pickerApi.current?.move(1)
      else if (intent === 'picker-close') closePicker()
    },
    [active, closePicker, name, pickerOpen, set, stop, submit],
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
    picker: {
      open: pickerOpen,
      kind: trigger?.kind ?? '@',
      query: trigger?.query ?? '',
      pick,
      close: closePicker,
      bind: bindPicker,
    },
    onChange,
    onKeyDown,
    onSelect,
  }
}
