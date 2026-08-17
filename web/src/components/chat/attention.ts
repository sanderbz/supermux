// The honesty copy, in ONE place (fase A4 T5).
//
// Ten causes, ten sentences the surface is allowed to say when it cannot do
// the thing it was asked to do — five from A4, three the states audit found the
// surface staying silent about (a session that cannot work at all, a session
// whose transcript does not exist, the lens-read blocked/usage condition), and
// two from the PTY-07 wave: the paused consent modal and the refused turn. They
// live in a pure module for the same reason
// `pending.ts` does: copy that apologises instead of explaining is a defect the
// same way a wrong caret is, and a defect you cannot assert in `bun test` is one
// that comes back. Every string below names WHAT IS TRUE — what this app tried,
// what came back, and which surface can still do it — and none of them says
// "something went wrong".
//
// THE CAUSES, and who raises each one:
//   session-paused             `chat-panel`, when the LENS sees Claude Code's
//                              `Session paused` consent modal: the turn is not
//                              over, no hook fires, and nothing happens until a
//                              human answers a question that spends credits or
//                              swaps the model.
//   turn-refused               `chat-panel`, when the lens sees a safeguards
//                              refusal on the live screen: the turn is dead and
//                              the recovery is a chord this app cannot send.
//   agent-blocked              `chat-panel`, when `blocked.ts` finds an
//                              un-cleared quota/auth banner in the transcript:
//                              this session cannot work at all until a limit
//                              resets or somebody signs in.
//   transcript-blind           `chat-panel`, when the pty is full of text and
//                              the transcript plane has produced nothing —
//                              Claude Code is not writing a transcript for this
//                              session, so chat can only show the terminal.
//   send-unconfirmed           NOBODY, today. It was raised by
//                              `use-pending-sends` (T4) for a send the watchdog
//                              gave up on — but that send has a BUBBLE, and the
//                              inline row under it already states the failure
//                              and carries the Retry. One failed send was being
//                              announced three times (row + card + composer
//                              banner, ~40% of the reading column), so the row
//                              won: it is anchored to the thing that failed.
//                              The sentence stays here for a send-level failure
//                              with no bubble to attach to.
//   session-blocked            the panel, when the LENS sees a usage-limit
//                              banner or a startup gate on the live screen —
//                              the one cause that is not about this app at all.
//                              It is read from the pty rather than from the
//                              transcript because the two cases that need it
//                              most have no transcript: a session with
//                              transcript saving off, and a session wedged on a
//                              startup gate before its first turn.
//   dialog-unmapped            `use-dialog-answer` (T7), when the lens sees a
//                              dialog the registry has no entry for — or when a
//                              key sequence aborted midway and the surface has
//                              stopped trusting its own reading.
//   registry-version-mismatch  `registry/index` (T6), when the session's
//                              BOOT-BANNER version is not one the fingerprint
//                              was captured against.
//   waiting-unmodelled         the panel, when the session reads `waiting` and
//                              the lens sees nothing this app knows how to ask.
//   transcript-stale           the panel, when the live layer is ahead of the
//                              confirmed transcript for longer than a turn.
//
// Nothing here renders, imports React or reaches the network: `attention-card.tsx`
// is the pixels, this is the words.

export type AttentionCause =
  /** The turn is PAUSED on a consent modal (catalog
   *  `limit.overage_consent_dialog` / `err.refusal_fallback_dialog`). Raised by
   *  the panel from the lens' `session-paused` notice. It outranks
   *  `agent-blocked` because it is a blocked session PLUS an unanswered
   *  question with a billing consequence — and because the fix is in the room:
   *  somebody answering it in the terminal starts the turn again immediately,
   *  where a limit block has to wait for a clock. */
  | 'session-paused'
  | 'agent-blocked'
  | 'transcript-blind'
  | 'send-unconfirmed'
  | 'session-blocked'
  | 'dialog-unmapped'
  | 'registry-version-mismatch'
  | 'waiting-unmodelled'
  /** The API refused this turn (catalog `err.safeguards_refusal`). Not a
   *  blocked session and not an error worth retrying: the model declined this
   *  message, nothing is retrying, and the recovery CC prints is a keystroke
   *  chord this surface cannot send. */
  | 'turn-refused'
  | 'transcript-stale'

/** What the sentence may quote back. Every field is optional and every string
 *  below still reads correctly without it — a copy module that NEEDS context to
 *  form a sentence produces "undefined" on the surface the first time a caller
 *  forgets. */
export interface AttentionContext {
  /** `agent-blocked` — the bucket as words, and the reset clause when the
   *  bucket has a clock (`blocked.ts`). */
  blockedLabel?: string
  blockedResets?: string
  /** The session's boot-banner version (`peek-lens` → `bannerVersion`). */
  version?: string | null
  /** The versions the sighted fingerprint WAS captured against (T6). */
  verifiedVersions?: readonly string[]
  /** A free-text fact the raiser already knows (a POST's error message). */
  detail?: string
}

export interface AttentionCopy {
  /** One line, sentence case, states the fact. */
  title: string
  /** Two or three sentences: what was observed, why nothing was sent, and what
   *  the user can do — the terminal is always one of the answers. */
  body: string
}

/**
 * Priority, most urgent first, for the surface that can only show ONE card.
 *
 * The ordering is by what the user loses if the card stays unread:
 *   0. the SESSION cannot work — a quota bucket or an auth death. It outranks
 *      the rest because the others are about what this app cannot do, and this
 *      one is about the agent being unable to do anything at all;
 *   0b. the session is writing no transcript, so this surface is structurally
 *      blind to it — same shape, one rung down, because the terminal still has
 *      everything;
 *   1. a message they typed did not arrive — the only cause where something
 *      the user AUTHORED is missing;
 *   1b. the session cannot work at all — it outranks every dialog cause below,
 *      because a card explaining which option chat declined to press is beside
 *      the point on a session that could not act on the answer anyway;
 *   2. a dialog is on the screen and this app will not touch it — the session
 *      is blocked until somebody answers, and chat has just declined to;
 *   3. same, but for a reason that is about US rather than the dialog (an
 *      unpinned CC version) — same blockage, more specific sentence;
 *   4. the session says it is waiting and nothing visible explains it;
 *   5. the view may be behind — the least urgent, because everything on it is
 *      still true, just not complete.
 */
export const ATTENTION_ORDER: readonly AttentionCause[] = [
  'session-paused',
  'agent-blocked',
  'transcript-blind',
  'send-unconfirmed',
  'session-blocked',
  'dialog-unmapped',
  'registry-version-mismatch',
  'waiting-unmodelled',
  'turn-refused',
  'transcript-stale',
]

/** The one cause a surface with one card should show. Nullish entries are
 *  ignored, so callers can pass their hooks' `attention` fields straight in. */
export function topAttention(
  causes: readonly (AttentionCause | null | undefined)[],
): AttentionCause | null {
  let best: AttentionCause | null = null
  let bestRank = Number.POSITIVE_INFINITY
  for (const cause of causes) {
    if (!cause) continue
    const rank = ATTENTION_ORDER.indexOf(cause)
    if (rank < 0 || rank >= bestRank) continue
    best = cause
    bestRank = rank
  }
  return best
}

/**
 * The raiser's own evidence — but only when the raiser is the card being drawn.
 *
 * `AttentionContext.detail` is free text dropped into the MIDDLE of whichever
 * sentence `attentionCopy` composes, and this surface has more than one raiser:
 * a send the watchdog gave up on outranks a dialog refusal, and both can be
 * true at the same second. Handing the dialog's sentence to `send-unconfirmed`
 * would print "the terminal's selection sits on option 3" as the reason a
 * MESSAGE never arrived. A card that quotes evidence from the wrong failure is
 * worse than one that quotes none, so the pairing is a function rather than a
 * habit at each call site.
 */
export function detailFor(
  top: AttentionCause | null,
  cause: AttentionCause | null,
  detail: string | null | undefined,
): string | undefined {
  return top && cause && top === cause && detail ? detail : undefined
}

/**
 * Cause (+ what the raiser knows) → the two strings the card says.
 *
 * The `version` clauses are additive: the sentence is complete without them, so
 * a mismatch raised before the banner has resolved still reads as a sentence
 * rather than as a template with a hole in it.
 */
export function attentionCopy(cause: AttentionCause, ctx: AttentionContext = {}): AttentionCopy {
  switch (cause) {
    case 'session-paused':
      return {
        // "Paused" is Claude Code's own word for it, and it is the one that
        // says the turn is not over: this session is mid-answer, waiting.
        title: 'Claude paused this turn and is waiting for an answer.',
        body: join(
          // The dialog's own body, verbatim — it names what is being consented
          // to (usage credits, a model switch after a safeguards flag), and no
          // paraphrase of a billing question is better than the question.
          ctx.detail,
          'Nothing further happens in this session until somebody answers it, and chat will not press a key into a dialog it has never seen on a live screen — one of these options spends credits on your account.',
          'The terminal shows the dialog; answering it there resumes the turn.',
        ),
      }

    case 'turn-refused':
      return {
        title: 'Claude declined this message.',
        body: join(
          ctx.detail,
          'Its safeguards flagged the prompt, so the turn ended with no answer — nothing is retrying and nothing is rate-limited.',
          'Send a different message, or switch model with /model. The terminal also offers “double press esc” to edit the last one.',
        ),
      }

    case 'agent-blocked':
      return {
        // NAMES THE BUCKET. "Rate-limited" for all six is what sends somebody
        // away to wait when the fix is one slash command — four of the six are
        // answered by `/model` or `/usage-credits`, not by a clock.
        title: ctx.blockedLabel
          ? `${ctx.blockedLabel} — this session can’t work right now.`
          : 'This session can’t work right now.',
        body: join(
          'Claude ended the turn with a block rather than an answer, so nothing you send will be picked up until it lifts.',
          // Only the verb is lower-cased. A blanket `toLowerCase()` would eat
          // the date and the timezone — "aug 17, 4am (europe/amsterdam)" — and
          // the clause exists for exactly those two facts.
          ctx.blockedResets ? `It ${lowerFirst(ctx.blockedResets)}.` : undefined,
          ctx.detail,
          'The terminal shows the session’s own screen, and Claude’s message above says what lifts it.',
        ),
      }

    case 'transcript-blind':
      return {
        title: 'This session isn’t writing a transcript.',
        body: join(
          'Claude Code has transcript saving off here, so there is nothing for chat to read — the conversation below is empty because the file is, not because nothing was said.',
          ctx.detail,
          'The terminal has the whole conversation. Restarting the session with transcript saving on is what fixes it for good.',
        ),
      }

    case 'send-unconfirmed':
      return {
        title: 'That message didn’t reach the session.',
        body: join(
          'It left this app, but nothing confirmed it: the transcript never echoed it back and the session showed no sign of life while we waited.',
          ctx.detail,
          'Send it again, or open the terminal and see what the session is actually doing.',
        ),
      }

    case 'session-blocked':
      return {
        title: 'This session can’t take another turn right now.',
        body: join(
          // The terminal's own sentence is the evidence AND the clock: it
          // carries the reset time, and no paraphrase of it would be more
          // useful than the words Claude Code printed.
          ctx.detail,
          'The conversation above is complete — the turn ended normally, and the next one is what cannot start.',
          'Switching this session to a different model moves it to a different limit bucket, which is the one thing that unblocks it before the reset.',
        ),
      }

    case 'dialog-unmapped':
      return {
        title: 'Claude is asking something chat can’t answer.',
        body: join(
          'The terminal is showing a prompt this app has no verified mapping for, so it will not press a key into it — a guess here answers the wrong option rather than none.',
          ctx.detail,
          'Here is what the session is showing. Answer it in the terminal.',
        ),
      }

    case 'registry-version-mismatch':
      return {
        title: 'This session runs a Claude Code version chat hasn’t been checked against.',
        body: join(
          versionClause(ctx),
          'The options are drawn so you can read the question, but none of them will send a key: an option list that moved by one row turns "No" into "Yes, and don’t ask again".',
          'Answer it in the terminal.',
        ),
      }

    case 'waiting-unmodelled':
      return {
        title: 'The session is waiting for something chat can’t see.',
        body: join(
          'Its status says it needs input, but the terminal shows no prompt this app recognises — so there is nothing here to answer on your behalf.',
          ctx.detail,
          'The capture below is the session’s own screen.',
        ),
      }

    case 'transcript-stale':
      return {
        title: 'This conversation is behind the session.',
        body: join(
          'The session has been working for longer than the last confirmed entry accounts for, so what you are reading is true but incomplete.',
          ctx.detail,
          'Nothing has been lost — the terminal has the live screen.',
        ),
      }
  }
}

/** `Resets Aug 17, 4am (Europe/Amsterdam)` → `resets Aug 17, …`. */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}

/** Sentence assembly that drops what it does not have, so a missing fact costs a
 *  clause and never a stray space or an `undefined`. */
function join(...parts: readonly (string | null | undefined)[]): string {
  return parts.map((p) => p?.trim()).filter((p): p is string => !!p).join(' ')
}

/**
 * The version sentence, in three degrees of knowledge — because "we have not
 * checked this version" and "we do not even know which version this is" are
 * different admissions, and the second one is the more important of the two.
 */
function versionClause({ version, verifiedVersions }: AttentionContext): string {
  const verified = verifiedVersions?.length
    ? `checked against ${list(verifiedVersions)}`
    : 'checked against other versions'
  if (!version) {
    return `This app could not read the session’s Claude Code version from its startup banner, and the dialog mapping was only ${verified}.`
  }
  return `This session booted Claude Code ${version}; the dialog mapping was ${verified}.`
}

/** `['a','b','c']` → `a, b and c`. */
function list(items: readonly string[]): string {
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
