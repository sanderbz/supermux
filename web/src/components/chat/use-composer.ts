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
  type ComposerField,
  getDraft,
  growTextarea,
  insertIntoComposer,
  setDraft,
  subscribeDraft,
} from './composer-draft'
import { handoffLabel, readDelegateIntent, type DelegateIntent } from './delegate-intent'
import type { PeekLens } from './peek-lens'
import { armedRefusal } from './registry/armed'
import { classifySlash, readTrigger, slashName } from './slash'
import type { PickerJump } from './composer-keys'
import { isInlineOwned } from './pending'

/** How much of the terminal's own draft the block banner quotes back. Enough to
 *  recognise the sentence, short enough that the banner stays one line. */
export const DRAFT_PREVIEW_CHARS = 60

// The key contract lives in `composer-keys.ts` since fase B3, so the
// scheduler's PromptField and the ⌘K palette can share it without pulling this
// hook — and React, and delegate-intent, and the session-input plumbing — into
// their chunks. NOT re-exported: a barrel here would undo exactly that.
import { composerKeyIntent } from './composer-keys'
import { useMediaQuery } from '../../hooks/use-media-query'

// ── The hook ────────────────────────────────────────────────────────────────

/** Why the composer refused to send. One shape, so the banner's copy lives in
 *  the component and the reason lives in the logic. */
export interface ComposerNotice {
  kind:
    | 'tui-draft'
    /** The terminal shows SOMETHING at its prompt, and this capture could not
     *  tell a typed sentence from Claude Code's own predicted one (2.1.232
     *  draws the prediction dim, and a plain capture has no dim). A receipt,
     *  not a refusal: the message went. Refusing on it would refuse nearly
     *  every send on a 2.1.232 session — the ghost is on screen most of the
     *  time — which is an outage wearing a safety argument. */
    | 'tui-draft-unverified'
    /** A dialog is up AND a choice card for it is on screen — "answer the thing
     *  above" is a true sentence. */
    | 'dialog'
    /** A dialog is up and there is NO card for it above the composer: an
     *  unmapped family, a plan dialog (no `PermissionRequest` hook is verified
     *  for `ExitPlanMode`), or a hook that was cleared while the pty still shows
     *  the prompt. Pointing at a card that is not there is the one thing a
     *  refusal must not do (A4 review). */
    | 'dialog-terminal'
    /** An AskUserQuestion is up. Its own free-text row (`Type something.`)
     *  exists, so "answer it in the terminal" is not the whole truth — but a
     *  composer send is a PASTE at the TUI prompt, and a0 §3 verified what that
     *  does to an open dialog: the paste is ignored and the appended Enter picks
     *  whatever row the caret is on. Sending free text here would therefore
     *  answer the question with an option the user never chose, silently. So the
     *  refusal names the buttons above, which answer the same question with the
     *  caret verified between every key. */
    | 'dialog-question'
    /** An MCP server's typed FORM is open. Its own reason, not `dialog`'s: the
     *  card above can be READ but not answered yet, so "answer it first" would
     *  point at inert buttons — and the mechanism is worth one clause, because
     *  a send here does not vanish. It is pasted into whichever field the
     *  terminal's caret is in, and the Enter behind it submits or advances the
     *  form on the user's behalf. */
    | 'dialog-form'
    /** Stop was pressed while a dialog is on screen. `Escape` there DENIES the
     *  dialog (a0 §3, live-verified) — it does not interrupt the turn — so the
     *  keystroke is not sent and the composer says what it would have done. */
    | 'stop-dialog'
    /** Stop was pressed while the screen has ARMED the key it would send
     *  (`registry/armed.ts`, catalog `generic.armed_keys`). With `Esc again to
     *  clear` showing, the interrupt Escape throws away whatever the human was
     *  typing in the terminal instead; with `Press Ctrl-C again to exit` it is
     *  the process. `detail` is the terminal's own line, because that is the
     *  whole evidence. */
    | 'stop-armed'
    | 'send-failed'
    | 'stop-failed'
    /** A `/model`-class command: it opens a picker in the TUI, so chat refuses
     *  to send it and points at the terminal (fase A4 T9). */
    | 'slash-picker'
    /** One of Claude Code's own commands that A0 never captured. Refused for
     *  the same reason, one rung down: nobody has watched what it does to the
     *  pty, and `/permissions`-class widgets eat the NEXT message. */
    | 'slash-unverified'
    /** A command that is not one of Claude's built-ins went out AS TEXT. Not a
     *  refusal — a receipt, so a typo does not quietly become a message. */
    | 'slash-note'
    /** The draft was HANDED TO A COLLEAGUE rather than sent here (fase B4 T4).
     *  A receipt, not a refusal — and the one that matters most on this
     *  surface, because it is the only confirmation that the words left for
     *  somewhere else. `detail` is the recipient, as a person reads it. */
    | 'handoff-sent'
    /** The hand-off was refused or never landed. The draft is still in the box
     *  — a delegation that 500s must never eat the user's text. `detail` is the
     *  server's own sentence ("prompt may not contain supermux wrapper
     *  markup"), which is written to be read. */
    | 'handoff-failed'
  /** The evidence: the terminal's own draft, the command, or the error. */
  detail?: string
}

/** Send, or refuse and say why. A `send: true` MAY carry a notice — that is a
 *  receipt for something the user should know went out anyway, never a refusal
 *  in disguise. */
export type SendGate =
  | { send: true; notice?: ComposerNotice }
  | { send: false; notice: ComposerNotice }

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
 *   lens.modal                        → refuse. A full-screen panel (`/status`,
 *                                       `/cost`, `/config`) has taken the
 *                                       screen; the Enter `send_text` appends
 *                                       goes into IT. Only the terminal can
 *                                       dismiss it, so that is what is offered.
 *   lens.composerDraft, VERIFIED      → refuse. `send_text` pastes at the TUI's
 *                                       prompt, so it would concatenate onto
 *                                       the user's half-sentence and submit the
 *                                       pair — silently.
 *   lens.composerDraft, unverified    → send, and SAY SO. Claude Code 2.1.232
 *                                       pre-fills the composer with a predicted
 *                                       next prompt drawn dim; without the SGR
 *                                       channel it is byte-identical to a typed
 *                                       draft (a4c finding 3). Refusing on it
 *                                       refuses nearly every send on that CLI,
 *                                       so the honest move is to deliver and
 *                                       hand the user the evidence — the text
 *                                       that was on the prompt — rather than to
 *                                       block on a reading this app has already
 *                                       admitted it cannot make. With `?ansi=1`
 *                                       answered in colour this branch is not
 *                                       reached: the ghost is stripped and a
 *                                       real draft still refuses.
 *   otherwise                         → send.
 *
 * Dialog outranks draft: with a dialog up, what the lens reads as a "draft" is
 * more likely to be the dialog's own furniture, and the dialog is the more
 * specific thing to say.
 *
 * THE SECOND SOURCE (`ctx.dialogCard`) is the session's hook-driven
 * `permission_request` — the same signal `live-layer.tsx` renders the choice
 * card from. It does two things the lens cannot:
 *   · it holds the refusal when the PEEK IS DOWN. "I could not look" is a send
 *     when nothing else knows better, but a hook that fired ≪1s ago and has not
 *     been cleared is knowing better, and a send into an open dialog is answered
 *     BY the dialog (a0 §3: the paste is ignored, the appended Enter picks the
 *     caret's row);
 *   · it decides WHICH refusal is true — whether there is a card above the
 *     composer to point at, or whether the only surface that can answer this is
 *     the terminal.
 */
export interface SendContext {
  /** A choice card for a live dialog is rendered above the composer (the
   *  session's `permission_request`). */
  dialogCard?: boolean
  /**
   * An MCP server's typed FORM is up (the session's `elicitation`).
   *
   * A THIRD source, and the only one for this family: the peek lens is
   * structurally blind here. Every dialog it knows is a numbered list it can
   * fingerprint; an elicitation is a set of text fields with Accept/Decline
   * buttons, so `readLens` reads no dialog at all and the gate would say "send".
   * That send is a PASTE at a TUI that is focused on a form field — it types a
   * chat message into a third party's form and the appended Enter submits
   * whatever is under the caret.
   */
  formCard?: boolean
}

export function sendGate(lens: PeekLens | null, ctx: SendContext = {}): SendGate {
  const dialogKind = ctx.dialogCard ? ('dialog' as const) : ('dialog-terminal' as const)
  // THE FORM OUTRANKS THE LENS (see `formCard`): the hook is the only witness,
  // so its refusal cannot wait for a sighting that will never come. The card IS
  // above the composer, so the refusal may point at it.
  if (ctx.formCard) return { send: false, notice: { kind: 'dialog-form' } }
  // A QUESTION is the one dialog whose refusal needs its own sentence: it HAS a
  // free-text row, so a user who typed an answer is not doing anything unusual —
  // they are answering, in the way the terminal itself offers. What they cannot
  // know is that a chat send is a paste, and that a paste into an open dialog is
  // dropped while the Enter after it picks the highlighted row (a0 §3). The
  // buttons above do the same job with the caret checked between every key.
  if (lens?.dialog?.family === 'question') {
    return { send: false, notice: { kind: 'dialog-question' } }
  }
  if (lens?.dialog) return { send: false, notice: { kind: dialogKind } }
  // A FULL-SCREEN PANEL (`/status`, `/cost`, `/config`) — nothing to answer, but
  // it owns the screen and it will eat the Enter `send_text` appends. There is
  // no card for it above the composer (no hook fires for a panel), so the
  // refusal names the only surface that can dismiss it. Its own footer is the
  // evidence, quoted on the banner.
  //
  // BEFORE the draft branch on purpose: the panel is why the draft reading is
  // unavailable, and "the terminal has an unsent draft `/status`" — pointing at
  // the scrollback echo of the command that OPENED the panel — is the exact lie
  // daily-driver QA #1 caught. The lens no longer reports that draft at all;
  // this ordering is the belt to that braces.
  if (lens?.modal) {
    return { send: false, notice: { kind: 'dialog-terminal', detail: lens.modal.hint } }
  }
  // Peek down, hook says a dialog is up: refuse. The lens is the authority when
  // it can look — a hook that reads stale against a CLEAR screen does not block
  // anything — but when it cannot look, the hook is the only witness there is.
  if (!lens) return ctx.dialogCard ? { send: false, notice: { kind: dialogKind } } : { send: true }
  if (lens.composerDraft) {
    return lens.composerDraftVerified
      ? { send: false, notice: { kind: 'tui-draft', detail: lens.composerDraft } }
      : { send: true, notice: { kind: 'tui-draft-unverified', detail: lens.composerDraft } }
  }
  return { send: true }
}

/**
 * May Stop press Escape right now?
 *
 * Escape is the interrupt every one of the three TUIs understands — but inside
 * a permission dialog it DENIES the dialog (a0 §3, live-verified) and its effect
 * on the plan dialog is explicitly unverified. Same fail-open rule as the send
 * gate: a peek that could not look still interrupts, because an interrupt
 * nobody can press is its own failure.
 */
export function stopGate(lens: PeekLens | null): SendGate {
  if (lens?.dialog) return { send: false, notice: { kind: 'stop-dialog' } }
  // ARMED KEYS (catalog `generic.armed_keys`) — the prior question, and the one
  // that applies on a screen with no dialog at all: has this screen redefined
  // Escape? `Esc again to clear` is drawn under an ordinary composer, so the
  // dialog check above sees nothing and the interrupt would land as a silent
  // delete of the user's own half-written sentence. The registry answers by
  // family and refuses everything it has no captured mapping for.
  const armed = lens ? armedRefusal(lens, 'Escape') : null
  if (armed) {
    return { send: false, notice: { kind: 'stop-armed', detail: armed.armed.text } }
  }
  return { send: true }
}

/**
 * Should a Stop reconcile the client's live turn to idle?
 *
 * `delivered` is whether `sendKey('Escape')` resolved (the interrupt reached the
 * session) or threw (it did not). A delivered interrupt reconciles — either it
 * ended a running turn, or there was nothing to end and the stale "thinking" must
 * clear; a THROWN one does not, because that is the genuine "the turn is still
 * running" case the `stop-failed` notice is for. One line, pulled out so the
 * decision is asserted without driving an async hook through a live DOM.
 */
export function stopReconcile(delivered: boolean): boolean {
  return delivered
}

/**
 * What stays in the box after a send of `raw`.
 *
 * Subtraction, not assignment: a peek plus a POST is two round-trips and people
 * keep typing through them (measured: text typed ~40ms after Enter). A blind
 * `setDraft('')` deletes those keystrokes with no undo and no trace.
 *
 * By FIRST OCCURRENCE rather than by prefix, because the caret does not have to
 * be at the end: typing "hey " at the front during the round-trip leaves
 * "hey hello" in the box, and a prefix rule keeps ALL of it — the sent words
 * included, one Enter away from being sent again (A4 review).
 */
export function draftAfterSend(after: string, raw: string): string {
  const at = after.indexOf(raw)
  if (at < 0) return after
  return (after.slice(0, at) + after.slice(at + raw.length)).replace(/^\s+/, '')
}

/**
 * What a finished hand-off leaves behind: the new draft, and the receipt.
 *
 * Extracted from the hook (fase B4 T4.5) so BOTH branches are assertable
 * without a DOM — the same reason `sendGate` and `draftAfterSend` live out
 * here. The branch that matters is the failure one: a hand-off that 500s must
 * leave the sentence in the box, and "we only clear on success" is a claim a
 * refactor can break in one line with nothing to catch it.
 *
 * @param after     the draft as it stands NOW (the user kept typing through the
 *                  round-trip — measured at ~40 ms after Enter)
 * @param raw       the draft as it was when Enter was pressed
 * @param recipient the colleague, as a person reads them
 * @param error     present → the hand-off did not land
 */
export function handoffResult(
  after: string,
  raw: string,
  recipient: string,
  error?: string,
): { draft: string; notice: ComposerNotice } {
  if (error !== undefined) {
    return { draft: after, notice: { kind: 'handoff-failed', detail: error || undefined } }
  }
  // Subtraction, not assignment — see `draftAfterSend`.
  return { draft: draftAfterSend(after, raw), notice: { kind: 'handoff-sent', detail: recipient } }
}

export interface UseComposerOptions {
  name: string
  /** The input plane. In the chat renderer this is the REST one. */
  input: Pick<SessionInput, 'submit' | 'sendKey'>
  /** The shared peek lens (T2). Omitted on a bench/test render — then the
   *  pre-send verification is skipped exactly as it is on a peek failure. */
  peek?: { refresh: () => Promise<PeekLens | null> }
  /** A live turn is running (the reconciled `status === 'active' && turnStart`,
   *  NOT raw status) — so the trailing control is Stop and a bare Escape
   *  interrupts. Reconciled so a session whose status is stuck at `active` after
   *  its turn ended does not keep offering a Stop that fires into nothing. */
  active: boolean
  /**
   * Reconcile the local live turn to idle — the honest half of Stop. Called
   * AFTER a delivered interrupt: if the turn was genuinely running the Escape
   * ended it and the client agrees; if it was already over (a stuck-`active`
   * status), this is what makes Stop visibly DO something instead of firing an
   * Escape into a pty with nothing to interrupt. NOT called when the interrupt
   * throws — that is the real "still running" case the `stop-failed` notice owns.
   */
  onInterrupt?: () => void
  /**
   * Text to PREPEND to the outgoing message, computed at submit time — the
   * composer upgrade's attachment seam (`attachmentSentence(readyPaths())`: the
   * quoted absolute upload paths, space-separated, one trailing space). Folded
   * in INSIDE `submit`, before `input.submit`, so the attachment flows through
   * the same peek / slash / hand-off gates a typed message does — never around
   * them. Absent ⇒ `submit` is byte-identical to today.
   */
  getOutgoingPrefix?: () => string
  /**
   * Called once the POST resolves successfully (`staged.reset` clears the
   * chips) — mirrors how the draft is subtracted only AFTER a resolved send, so
   * a rejected send keeps both the words and the attachments to retry.
   */
  onSent?: () => void
  /** The session's hook-driven `permission_request` is live, i.e. a choice card
   *  is on screen above this composer. Second source for the pre-send gate —
   *  see `sendGate`. */
  dialogCard?: boolean
  /** The session's `elicitation` is live: an MCP server's form card is on
   *  screen. THIRD source, and the only witness for a family the peek lens
   *  cannot see at all — see `SendContext.formCard`. */
  formCard?: boolean
  /**
   * The `@`-hand-off plane (fase B4 T4). ALL THREE OR NONE: without them the
   * composer has no way to tell a colleague from a word, so `@patch do x` stays
   * an ordinary message and nothing changes. A bench render and every existing
   * test therefore keep their exact behaviour by omitting this.
   */
  handoff?: {
    /** Lowercased known name → slug. The same index the chips use. */
    mentions: ReadonlyMap<string, string>
    /** Slug → display name, for the control's label. */
    names?: ReadonlyMap<string, string>
    /** Deliver. Resolving means the SERVER accepted and delivered it. */
    send: (to: string, prompt: string) => Promise<unknown>
  }
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
  /** Coarse, clamped movement (Home/End/PageUp/PageDown). */
  jump: (to: PickerJump) => void
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
  fieldRef: React.RefObject<ComposerField | null>
  /** A POST is in flight. The control disables so a slow pty cannot be
   *  double-fired; it is NOT a delivery claim (that is T4's watchdog). */
  sending: boolean
  notice: ComposerNotice | null
  dismissNotice: () => void
  submit: () => void
  stop: () => void
  insert: (text: string) => void
  /**
   * The draft currently reads as a hand-off (fase B4 T4.4), so Enter will go to
   * `to` instead of to this session.
   *
   * Derived from the live draft, published so the SEND CONTROL can relabel —
   * "Hand to ●Patch" — while the intent holds. The change of meaning has to be
   * visible BEFORE the key is pressed; a composer that quietly re-routed on
   * Enter would be the worst version of this feature.
   */
  handoff: { to: string; label: string } | null
  /**
   * A hand-off this composer DISPATCHED that has not been confirmed by the
   * ledger yet (fase B4 T5). The optimistic half of the handoff pill: it is the
   * only thing in the app that knows a delegation is in flight, because the
   * ledger cannot know until it lands.
   *
   * Set on dispatch, cleared on failure, and deliberately LEFT SET on success —
   * `live-layer.tsx::pendingHandoff` retires it when the matching
   * `session.delegate` row appears, so the pill resolves INTO the durable line
   * instead of blinking out before it.
   */
  handoffPending: { to: string; atMs: number } | null
  /** The `@`/`/` surface (fase A4 T9). */
  picker: ComposerPickerState
  onChange: (e: { target: ComposerField }) => void
  onKeyDown: (e: React.KeyboardEvent<Element>) => void
  /** Caret moves (arrow keys, clicks) — the trigger is read at the CARET, not
   *  at the end of the draft. */
  onSelect: (e: { currentTarget: ComposerField }) => void
}

export function useComposer({
  name,
  input,
  peek,
  active,
  dialogCard = false,
  formCard = false,
  handoff,
  onInterrupt,
  getOutgoingPrefix,
  onSent,
}: UseComposerOptions): ComposerHandle {
  const draft = React.useSyncExternalStore(
    React.useCallback((fn) => subscribeDraft(name, fn), [name]),
    React.useCallback(() => getDraft(name), [name]),
    React.useCallback(() => getDraft(name), [name]),
  )
  const ref = React.useRef<ComposerField | null>(null)
  const [sending, setSending] = React.useState(false)
  const [notice, setNotice] = React.useState<ComposerNotice | null>(null)
  // The caret, mirrored into state because the TRIGGER is read at it. It starts
  // at 0 on purpose: a draft restored from another mount (renderer toggle) must
  // not pop a popover nobody asked for, and 0 can never be inside a token.
  const [caret, setCaret] = React.useState(0)
  // See `ComposerHandle.handoffPending`.
  const [handoffPending, setHandoffPending] = React.useState<{ to: string; atMs: number } | null>(
    null,
  )
  // What the user has already closed, so Escape (and an accepted pick) stay
  // closed while they keep typing. Keyed by the token's TEXT, not just its
  // offset: clearing the box and typing `@` again is a new question.
  const [closed, setClosed] = React.useState<{ start: number; text: string } | null>(null)
  const pickerApi = React.useRef<ComposerPickerApi | null>(null)
  // COARSE POINTER = the soft-keyboard contract: a bare Enter breaks the line and
  // the send DISC is the send (like every native chat app), so Enter-to-send never
  // fires on the reflexive key a thumb hits reaching for the next word (the field
  // shows a Return key — `enterKeyHint` in composer.tsx). Gated on the pointer, NOT
  // the surface — the grok chat pane is `surface="desktop"` (a real <textarea>) yet
  // runs on the phone. Desktop (fine pointer) keeps Enter=submit, unchanged.
  const coarse = useMediaQuery('(pointer: coarse)')

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

  // One reading of "is this a hand-off", used by both the SUBMIT path (which
  // must read the store, because the box is not frozen while a send is in
  // flight) and the RENDER path (which reads the rendered draft, because that
  // is what the user can see when the label changes).
  const readIntent = React.useCallback(
    (draft: string): DelegateIntent | null =>
      handoff ? readDelegateIntent(draft, handoff.mentions, name) : null,
    [handoff, name],
  )

  const submit = React.useCallback(() => {
    // `raw` is what the box held when Enter was pressed; `text` is what goes on
    // the wire. Both are kept because the box is NOT frozen while the send is in
    // flight — see the clear below.
    const raw = getDraft(name)
    const text = raw.trim()
    // The attachment prefix (quoted upload paths) is computed HERE, at submit
    // time, so an image staged one keystroke before Enter is still counted. An
    // image alone is a valid message — empty text but a non-empty prefix sends.
    const prefix = getOutgoingPrefix?.() ?? ''
    if ((text.length === 0 && prefix.length === 0) || sendingRef.current) return
    setNotice(null)
    // THE HAND-OFF BRANCH (fase B4 T4), beside the slash gate and before it:
    // `@patch /clear` is a message to a colleague, not a slash command this
    // session is about to run, and the slash classifier would never see a
    // leading `@` anyway.
    //
    // NO PEEK GATE ON THIS PATH, deliberately. The pre-send peek exists because
    // `POST /send` pastes at THIS session's TUI prompt and would concatenate
    // onto a half-typed sentence there. A delegation touches this pty not at
    // all — the server delivers to the RECIPIENT's — so gating it on the local
    // terminal's draft would refuse a hand-off for a reason that has nothing to
    // do with it. (The recipient's own prompt is the server's business; a
    // delegated prompt goes through the same lifecycle path a human send does.)
    const intent = readIntent(raw)
    if (intent && handoff) {
      void (async () => {
        sendingRef.current = true
        setSending(true)
        setHandoffPending({ to: intent.to, atMs: Date.now() })
        const recipient = handoffLabel(intent.to, handoff.names)
        let error: string | undefined
        try {
          await handoff.send(intent.to, intent.prompt)
        } catch (err) {
          // THE DRAFT SURVIVES A FAILURE — `handoffResult` is where that is
          // decided, and where it is asserted. `''` rather than `undefined` on
          // an unworded throw: the field is optional, the outcome is not.
          error = err instanceof Error ? err.message : ''
          // Nothing is in flight any more, and nothing will confirm it.
          setHandoffPending(null)
        }
        try {
          const out = handoffResult(getDraft(name), raw, recipient, error)
          setDraft(name, out.draft)
          setNotice(out.notice)
        } finally {
          sendingRef.current = false
          setSending(false)
        }
      })()
      return
    }
    // THE SLASH GATE (fase A4 T9), before the peek because it needs no network
    // — and therefore it cannot fail open when the session or the command list
    // is unreachable, which is the one property a gate has to have.
    //
    // A `/model`-class command opens a PICKER in the TUI: send it from chat and
    // the widget sits on a pty nobody is looking at, silently eating whatever
    // the session is told next. So it is not sent — the composer names the
    // command and offers the terminal, where it can actually be answered. Any
    // OTHER Claude Code built-in that A0 never captured is refused the same way
    // (`/permissions`, `/hooks`, `/memory`, …): they are widgets too, and a
    // chat message typed into an open permission editor is the worst version of
    // this failure. Only a user-authored skill/project command still goes.
    const slash = classifySlash(text)
    if (slash === 'picker' || slash === 'unverified') {
      setNotice({
        kind: slash === 'picker' ? 'slash-picker' : 'slash-unverified',
        detail: slashName(text) ?? undefined,
      })
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
        const gate = sendGate(peek ? await peek.refresh() : null, { dialogCard, formCard })
        if (!gate.send) {
          setNotice(gate.notice)
          return
        }
        // A warning the send is going out THROUGH, not around: shown before the
        // POST so it is on screen for the whole round-trip, and overridable by
        // the slash receipt below, which is about the same delivery.
        if (gate.notice) setNotice(gate.notice)
        // The attachment paths go on the wire FIRST, then the user's prose —
        // quoted absolute paths Claude's Read/vision tool resolves, exactly the
        // shape the dock and terminal drag/paste have always injected.
        await input.submit(prefix + text)
        // Cleared only AFTER the POST resolves: a rejected send keeps the
        // user's words in the box, where they can retry them.
        //
        // And cleared by SUBTRACTION, not by assignment. A peek plus a POST is
        // two round-trips; people keep typing through them (measured: text typed
        // ~40 ms after Enter). A blind `setDraft('')` deletes those keystrokes
        // with no undo and no trace — the same silent-corruption class the peek
        // gate exists to prevent, on the other side of the wire. So only the
        // sent prefix goes; anything typed after it stays in the box.
        setDraft(name, draftAfterSend(getDraft(name), raw))
        // Chips clear only now, on a resolved POST — the same rule the draft
        // follows, so a rejected send keeps the attachments to retry.
        onSent?.()
        // A command that is not one of Claude's built-ins WENT — as text, which
        // is what a project/skill command is. The receipt exists so a typo
        // (`/compct`) does not quietly become a message nobody meant to write.
        if (slash === 'unknown') {
          setNotice({ kind: 'slash-note', detail: slashName(text) ?? undefined })
        }
      } catch (err) {
        // ONE OWNER PER FAILED SEND. When the input plane is the tracked one
        // (`use-pending-sends`), the failure is already on the transcript row
        // under the bubble that failed — the server's sentence, a Retry, an
        // Open terminal and a Dismiss. Saying it again here stacked a third
        // ~110px panel under a card that was already repeating it, and put the
        // reason string in the page twice. The draft is still in the box either
        // way: it is only cleared after a POST resolves.
        if (!isInlineOwned(err)) {
          setNotice({
            kind: 'send-failed',
            detail: err instanceof Error ? err.message : undefined,
          })
        }
      } finally {
        sendingRef.current = false
        setSending(false)
      }
    })()
  }, [dialogCard, formCard, getOutgoingPrefix, handoff, input, name, onSent, peek, readIntent])

  const stop = React.useCallback(() => {
    // Escape is the interrupt every one of the three TUIs understands; the
    // allowlist carries it, so this is the same key the terminal renderer's
    // Esc sends (`KEY_ALLOWLIST`, lifecycle.rs:1696).
    //
    // BUT ONLY WHEN NOTHING IS ASKING A QUESTION. Escape inside a permission
    // dialog DENIES it (a0 §3, live-verified) and its effect on the plan dialog
    // is explicitly unverified — which is why the registry ships plan-Esc as
    // `actOn: false`. A Stop that quietly dismisses a tool call the user never
    // read is the same wrong-action class this fase is built to refuse, and the
    // window is real: `PermissionRequest` has no `HookEvent` variant, so the
    // status stays `active` — Stop stays on screen — for the dialog's whole
    // life (A4 review). So the same one-peek gate the send path takes, with the
    // same fail-open rule: a peek that fails still interrupts, because an
    // interrupt nobody can press is its own failure.
    void (async () => {
      const gate = stopGate(peek ? await peek.refresh() : null)
      if (!gate.send) {
        setNotice(gate.notice)
        return
      }
      // A REJECTED interrupt has to be said out loud. "I pressed Stop and the
      // agent kept going" is the one failure this surface must never absorb into
      // a console warning — and on the REST plane a 404/409 (session gone,
      // restarted under the same name) is exactly how it arrives.
      //
      // A DELIVERED interrupt reconciles the local live turn to idle
      // (`onInterrupt`). Two cases, one honest outcome: a genuinely-running turn
      // is interrupted and the client agrees it is over; an already-cancelled
      // turn whose status is stuck at `active` gets its stale "thinking" cleared,
      // so Stop is never a silent no-op. Only a THROWN send is left "still
      // running" — that is what `stop-failed` means, and it must not reconcile.
      try {
        await input.sendKey('Escape')
        if (stopReconcile(true)) onInterrupt?.()
      } catch (err) {
        setNotice({
          kind: 'stop-failed',
          detail: err instanceof Error ? err.message : undefined,
        })
      }
    })()
  }, [input, onInterrupt, peek])

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
    (e: { target: ComposerField }) => {
      set(e.target.value)
      setCaret(e.target.selectionStart ?? e.target.value.length)
      growTextarea(e.target)
      if (notice) setNotice(null)
    },
    [notice, set],
  )

  const onSelect = React.useCallback((e: { currentTarget: ComposerField }) => {
    const el = e.currentTarget
    setCaret(el.selectionStart ?? el.value.length)
  }, [])

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<Element>) => {
      const intent = composerKeyIntent(e, {
        draft: getDraft(name),
        active,
        picker: pickerOpen,
        // A refusal card is up: Escape closes IT (see `composer-keys.ts`). The
        // card is what the user is looking at, and the draft under it is the
        // message they still want to send.
        notice: notice !== null,
      })
      // MOBILE (coarse pointer): a bare Enter breaks the line — the send DISC is
      // the send. Fold it into the `pass`/`newline` early return, so a plain
      // submit-Enter falls through to the browser, which inserts the line break
      // (the same path Shift+Enter takes). Desktop leaves `coarse` false, so
      // Enter=submit is byte-identical to before. (The `@`/`/` popover, when it is
      // open, keeps its own Enter — completing the highlighted row — below.)
      if (intent === 'pass' || intent === 'newline' || (coarse && intent === 'submit')) return
      // A picker Enter that has nothing to accept must still SEND. The
      // preventDefault therefore waits until the outcome is known — the one
      // place in this handler where the order matters.
      if (intent === 'picker-accept') {
        const took = pickerApi.current?.accept() ?? false
        if (took) {
          e.preventDefault()
          return
        }
        // Nothing to complete: Tab keeps its browser meaning; and on mobile a bare
        // Enter breaks the line rather than sending — both fall through to the
        // browser, so only a desktop (fine-pointer) Enter reaches submit.
        if (e.key === 'Tab' || coarse) return
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
      else if (intent === 'picker-page-up') pickerApi.current?.jump('page-up')
      else if (intent === 'picker-page-down') pickerApi.current?.jump('page-down')
      else if (intent === 'picker-first') pickerApi.current?.jump('first')
      else if (intent === 'picker-last') pickerApi.current?.jump('last')
      else if (intent === 'picker-close') closePicker()
      else if (intent === 'notice-dismiss') setNotice(null)
    },
    [active, closePicker, coarse, name, notice, pickerOpen, set, stop, submit],
  )

  // Derived, never stored — the same discipline as `trigger`. A second copy of
  // "the draft currently means a hand-off" in state is a second thing to get
  // out of step with the box.
  const intent = React.useMemo(() => readIntent(draft), [draft, readIntent])
  const handoffState = React.useMemo(
    () =>
      intent ? { to: intent.to, label: handoffLabel(intent.to, handoff?.names) } : null,
    [handoff?.names, intent],
  )

  return {
    draft,
    setDraft: set,
    fieldRef: ref,
    sending,
    notice,
    dismissNotice,
    submit,
    stop,
    insert,
    handoff: handoffState,
    handoffPending,
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
