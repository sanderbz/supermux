## Status (2026-08-17) — SHIPPED; the checkboxes below are history

> **The whole Grok-UI program shipped.** Track A (A1–A6) and Track B (B0–B5) are on
> `main`, together with the wave-1 follow-ups (#79–#85) and the session-state series
> (#86–#89). Landing PRs: **A1 #57 · A5 #72 · A6 #76 · B1 #69 (+ #70 perf gate) ·
> B2 #74 · B3 #75 · B4 #73 · B5 #78**. (A2–A4 landed earlier in the A-track sequence;
> their PR numbers are deliberately not guessed here.)
>
> **The checkbox state below is historical, not authoritative.** These plans were
> execution documents: boxes were ticked opportunistically while work was in flight,
> so an unticked box does *not* mean unshipped, and a ticked box is not evidence that
> the code exists (see the register's "finding 23 rule"). Nothing below has been
> back-edited to match reality — this note is the only reconciliation.
>
> **The authority on what is actually done and what is still owed** is the debt
> register snapshot committed alongside these plans:
> [`debt-register-2026-08-17.md`](./debt-register-2026-08-17.md), which was verified
> row-by-row against code on `origin/main`. That snapshot was generated at `6caafdf`
> (#87), i.e. just before #88 and #89 merged, and it is the reason this banner exists:
> the ledger and the code had drifted apart.

---

# Fase A4 — Interactivity (the chat surface starts driving the session)

**Worktree** `/opt/projects/supermux-a4` · **branch** `feat/a4-interactivity`, stacked on
`feat/a3-chat-surface` (which is stacked on `feat/b0-design-system`; A4 base = `67b9b89`).
**Master plan** `docs/superpowers/plans/2026-08-13-claude-chat-renderer.md` §3 (input plane),
§4.2 (P5/P9/P10), §4.3 (modal registry), §4.4 (watchdog + Attention card), §5.6 — it lives on the
unmerged branch `docs/grok-ui-plan`; read it with
`git show docs/grok-ui-plan:docs/superpowers/plans/2026-08-13-claude-chat-renderer.md`.
**Ground truth** `a0-findings.md` §3 (live dialog fingerprints + VERIFIED key maps, the BTab
hazard, the digit-key limitation) and §5 (the `/send` decision with its queue evidence);
verbatim captures in `a0-dialogs.md`.

> One sentence of scope: **A3 made the chat surface true; A4 makes it a control surface** — one
> renderer-agnostic input handle, a real composer, an optimistic echo that can admit it failed, and
> exactly two TUI dialog families the chat may answer on the user's behalf. Everything A4 adds is
> allowed to be *refused*: no action ships without a verification path back to the pty.

---

## 0. What already exists (read before writing a line)

### 0.1 Frozen from A1/A3 — the regression net

| file | owns | rule |
|---|---|---|
| `web/src/components/chat/entries.ts` | wire→display model, `RECEIPT_CAP`, `formatElapsed`, `stripEmojiPrefix` | pure, `chat-entries.test.ts` |
| `…/use-chat-turn.ts` | turn anchor, supersede gate, teardown, 1s ticker, `TURN_CONFIRM_TIMEOUT_MS` | A4 reads `turnStart`; changes no constant |
| `…/provisional.ts`, `…/latency.ts`, `…/flag.ts` | P13 heuristic, server-clock skew, eligibility | untouched |
| `…/conversation.tsx`, `…/chat-surface.tsx`, `…/live-layer.tsx`, `…/transcript-item.tsx`, `ui/*` | the approved boards | A4 adds props and slots; it does not restyle |
| `tests/unit/chat-*.test.*` | the net | must stay green, unedited, at every task boundary |

The A3 surface is **presentational and prop-fed** (`conversation.tsx` takes `items`, `overlay`,
`provisional` as a slot). A4 keeps that contract: every new network-touching thing arrives as a
prop or a slot from `chat-panel.tsx`, so `chat-conversation.test.tsx` /
`chat-surface.test.tsx` keep working without react-query and `/dev/chat-live` keeps rendering the
real component.

### 0.2 Server input endpoints that already exist (no server work needed for the input plane)

| endpoint | source | shape |
|---|---|---|
| `POST /api/sessions/{name}/send` | `lifecycle.rs:1126 send_text` | `{text}` — **appends Enter itself** (+ a provider submit gap; kimi 200 ms), stamps `last_send_at`, broadcasts a delta |
| `POST …/paste` | `lifecycle.rs:1185` | `{text, submit}` — bracketed paste; `submit:false` = insert without Enter |
| `POST …/keys` | `lifecycle.rs:1166` + `KEY_ALLOWLIST` `lifecycle.rs:1696` | `{keys}` — **no digits**: `Enter Escape Tab BTab Space BSpace Up Down Left Right Home End PageUp PageDown IC DC C-* M-* y n q F1-F12` |
| `GET …/peek?ansi=1&lines=N` | `lifecycle.rs:1227 peek_ansi` | colour-true capture, no lock, `""` when not running — already wrapped as `sessionsApi.peekAnsi` |
| `POST …/mode` | `mod.rs` `mode_handler` | `{mode}` → converges by pressing **BTab** — the hazard in §4.3 |
| `GET …/tracked-files` | `mod.rs:108` | `{ok, data:{files: string[]}}` |
| `GET …/git`, `POST /api/agents/delegate`, `GET/POST/DELETE …/steer` | — | A4 uses none of them in the composer (§5) |

**Widening `KEY_ALLOWLIST` to `0-9` is an unsigned owner item (a0-findings §8.4). A4 does not
depend on it**: every registry action is expressed as `Down×(n−1)` + `Enter`, and the digits on the
choice card are *hints* that also bind the local keyboard — they are never sent as keys.

### 0.3 What is NOT in this base

`feat/a2-chat-dataplane` (chat WS, tailer, parser, statusline tap) is a **sibling branch**. A4
codes against the shipped A1/A3 client APIs — `useChatTail` (`/recall?chat=true` poll + SSE
debounce), `sessionsApi.peekAnsi`, the sessions SSE — and every place A2 will take over is marked
in-code with a single comment form:

```ts
// A2-SEAM: replaced by the chat WS `entry` frame; this poll goes away, the
// reconcile below does not.
```

Seams A4 must mark, exactly: the pending-echo reconcile source (T4), the queued-pill source (T8),
the peek lens' poll cadence (T2), and the recall extension (T8 server change — A2's parser emits
the same `kind`).

---

## 1. Deliverables

```
web/src/lib/session-input/
  types.ts                  NEW  SessionInput + KeyName (the allowlist, as a type)
  rest.ts                   NEW  restSessionInput(name) — /send · /paste · /keys
  terminal.ts               NEW  terminalSessionInput(term) — adapter, NOT a shim
  index.ts                  NEW
web/src/lib/api/sessions.ts        +send / +paste / +keys / +trackedFiles (the client the app never had)
web/src/components/chat/
  peek-lens.ts              NEW (pure) capture → {bannerVersion, composerDraft, dialog}
  use-peek-lens.ts          NEW  ONE /peek?ansi=1 poll for the whole surface
  composer.tsx              NEW  the real composer (grow, Enter/Shift+Enter, IME, Stop)
  use-composer.ts           NEW  draft state, insert-at-caret, submit gating
  composer-insert.ts        NEW (pure) insertAtCaret / draft assembly
  pending.ts                NEW (pure) P10 state machine + reconcile + watchdog
  use-pending-sends.ts      NEW  the store + the 5s watchdog timer
  attention.ts              NEW (pure) cause → message (the honesty copy, in one place)
  attention-card.tsx        NEW  message + ANSI mini-view + Open terminal
  registry/claude.ts        NEW (pure) permission + plan-approval fingerprints, version-pinned
  registry/plan.ts          NEW (pure) option → key plan (Down×n + Enter), caret expectations
  registry/index.ts         NEW
  use-dialog-answer.ts      NEW  verify-caret → key → re-peek → dismissal check
  queued.ts                 NEW (pure) FIFO enqueue↔promotion matching
  slash.ts                  NEW (pure) pass-through vs picker-opening allowlist
  entity-picker.tsx         NEW (lazy) @files (tracked-files) + @sessions, / commands
  live-layer.tsx            EDIT  PermissionCard gains onChoose + registry state
  conversation.tsx          EDIT  +composer props, +pending echo, +queued pills, +attention slot
  chat-panel.tsx            EDIT  the wiring (input handle, lens, pending, registry)
  header-pill.tsx           EDIT  mode chip becomes actionable, gated on no-dialog-visible
web/src/components/focus-mode/desktop-split.tsx   EDIT  SessionInput at the call site
web/src/routes/focus/mobile.tsx                   EDIT  SessionInput at the call site
web/src/components/session-tile/tile.tsx          EDIT  SessionInput at the call site
web/src/routes/dev-chat-live.fixture.ts           EDIT  +6 interactive states
web/src/routes/dev-chat-live.tsx                  EDIT  +the states in the picker
server/src/sessions/recall.rs                     EDIT  queue-operation → kind `queued` (chat=true only)
web/tests/unit/
  session-input.test.ts   chat-peek-lens.test.ts   chat-composer-insert.test.ts
  chat-pending.test.ts    chat-registry.test.ts    chat-queued.test.ts
  chat-slash.test.ts      chat-attention.test.tsx  chat-interactive.test.tsx
web/tests/fixtures/tui/   NEW  the a0 captures, verbatim (perm-bash, perm-edit, plan, composer-idle,
                               composer-draft, banner)
```

Nothing outside these paths changes. `web/package.json` is not touched (**no new deps** — the
`@`/`/` picker is built from the existing Radix popover + `cmdk`-free list the palette already
uses; the ANSI mini-view is `lib/ansi.ts`, not a second xterm).

---

## 2. Tasks

TDD throughout: the pure module and its `bun test` first, then the hook, then the surface. Every
task ends green on `bun run test:unit` + `bun run lint`, and states its **perf impact** against the
A3 baseline of **174.71 KB gz app JS (budget 200)**. Running total is asserted in T12.

---

### T1 — `SessionInput`: one handle, two implementations, three call sites

**Why first:** everything else in A4 calls it, and it is the change that touches files outside
`components/chat/**` — landing it alone keeps the rest of the fase a chat-only diff.

1. `lib/session-input/types.ts`:

```ts
/** The keys the server will actually accept (`KEY_ALLOWLIST`, lifecycle.rs:1696).
 *  Typed, not stringly: a registry entry that asks for a digit must not compile. */
export type KeyName =
  | 'Enter' | 'Escape' | 'Tab' | 'BTab' | 'Space' | 'BSpace'
  | 'Up' | 'Down' | 'Left' | 'Right' | 'Home' | 'End' | 'PageUp' | 'PageDown'
  | 'C-c' | 'C-d' | 'C-g' | 'C-l' | 'C-r' | 'C-u' | 'y' | 'n' | 'q'

export interface SessionInput {
  /** Text + submit, atomically. The REST path appends Enter server-side. */
  submit(text: string): Promise<void>
  /** Text WITHOUT submit — bracketed paste. */
  insert(text: string): Promise<void>
  sendKey(name: KeyName): Promise<void>
  focus(): void
  blur(): void
}
```

2. `rest.ts` — `restSessionInput(name, { onFocus, onBlur })`: `submit → POST /send {text}`,
   `insert → POST /paste {text, submit:false}`, `sendKey → POST /keys {keys}`; `focus`/`blur`
   delegate to the React composer's ref (the REST plane has no cursor of its own).
3. `terminal.ts` — `terminalSessionInput(term: UseLiveTermResult)`: `submit → term.send(text + '\r')`
   (the byte path, unchanged from today's call sites), `insert → term.send(text)`,
   `sendKey → term.sendKey`, `focus/blur → term.focus/blur`.
4. **`UseLiveTermResult` is NOT declared to implement `SessionInput`, and `use-live-term.ts` is not
   edited.** The file header of `terminal.ts` records why, verbatim from master plan §3: its
   `send(cmd + '\r')` call sites would double-submit the moment `submit` were routed through REST
   `send_text`, which appends Enter itself. `tryOpenLinkAt`, `resync`, `copyAll` stay terminal-only
   and are reached through the existing ref, not through this interface.
5. The three parent surfaces build the handle once and pass it down:
   `desktop-split.tsx` (`termRef` → `terminalSessionInput`, or `restSessionInput` while
   `chatActive`), `routes/focus/mobile.tsx`, `components/session-tile/tile.tsx`. The dock, keybar,
   snippet panel, quick-keys, external-edit and attachment paths switch from `termRef.current?.send`
   to `input.insert` / `input.submit` / `input.sendKey` — **mechanical, one-for-one**, and this is
   what makes A5's mobile chat seam a prop change rather than a rewrite.

**Tests** (`session-input.test.ts`, no DOM):

```ts
test('rest submit posts /send with the raw text — never a trailing CR', async () => {
  const calls: { url: string; body: unknown }[] = []
  const input = restSessionInput('rt', { request: (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) }); return Promise.resolve({} as never)
  }})
  await input.submit('hello')
  expect(calls[0].url).toBe('/api/sessions/rt/send')
  expect(calls[0].body).toEqual({ text: 'hello' })   // the server adds Enter
})

test('rest insert never submits', async () => { /* → /paste {text, submit:false} */ })

test('terminal submit appends exactly one CR', () => {
  const sent: string[] = []
  const input = terminalSessionInput({ send: (t) => sent.push(t), sendKey: () => {}, focus(){}, blur(){} } as never)
  void input.submit('hello')
  expect(sent).toEqual(['hello\r'])
})

test('the two implementations expose the same surface', () => {
  expect(Object.keys(restSessionInput('x', stub)).sort())
    .toEqual(Object.keys(terminalSessionInput(termStub)).sort())
})
```

*DoD:* the app behaves identically with chat off (dock, keybar, snippets, Ctrl+G, attachments all
still write to the pty); `git diff` outside `components/chat/**` is substitutions, not logic.
**Perf: +0.4 KB gz** (three tiny modules, one API client block).

---

### T2 — The peek lens: one capture, four consumers

The draft guard, the dialog registry, the mode-chip gate and the Attention mini-view all need the
same thing — *what is on the pty right now* — and four independent `/peek` pollers on one session
would be both wasteful and inconsistent (two consumers could disagree about whether a dialog is
up). So there is **one** poll and **one** pure reader.

1. `peek-lens.ts` (pure, no imports beyond `lib/ansi` types):

```ts
export interface DialogSighting {
  family: 'permission' | 'plan'
  variant?: 'bash' | 'edit' | 'write'
  /** Whitespace-normalised option labels, in TUI order. */
  options: string[]
  /** 0-based caret row among the options, or null when no caret is visible. */
  caretIndex: number | null
  /** `~/.claude/plans/plan-<slug>.md`, when the footer exposes it. */
  planPath?: string
}
export interface PeekLens {
  /** `╭─── Claude Code v2.1.231 ───╮` → `2.1.231`. Null when the banner has scrolled off. */
  bannerVersion: string | null
  /** Non-empty text sitting at the TUI's `❯` composer, else null. */
  composerDraft: string | null
  dialog: DialogSighting | null
}
export function readLens(capture: string): PeekLens
```

Rules encoded from a0-findings §3, each one a comment citing its evidence:

- **whitespace-normalised token anchors only** — options wrap at 52 cols (captured live); never
  full-line equality;
- **`❯` alone is never a fingerprint** — live-confirmed collisions with the composer caret, an
  echoed prompt, resume rows, the trust fixture. The dialog caret is space-prefixed *and* sits on a
  line matching `^\s*❯?\s*\d+\.\s`;
- permission family = a `Do you want …?` line + an option line exactly `1. Yes` + footer containing
  `Esc to cancel · Tab to amend`; variant from `Bash command`/`ctrl+e to explain` vs
  `Create file`/`Edit file` + `(shift+tab)`;
- plan family = `Would you like to proceed?` **plus** `1. Yes, and use auto mode` **plus**
  `3. Tell Claude what to change` — the question differs from the permission family's by two words,
  so option-1 text is the discriminator, not the question;
- the composer draft is the text after the column-0 `❯` on the last composer line, **and only when
  no dialog is sighted** (a dialog's caret line is not a draft);
- ANSI is *stripped before matching* (fingerprints are token-based); colour is used nowhere as a
  matcher in v1 — the periwinkle/teal rule hues are recorded in comments as the future
  tie-breaker, because `preview_ansi` colour matching was never needed once option-1 text proved
  sufficient.

2. `use-peek-lens.ts`: one poll of `sessionsApi.peekAnsi(name, 60)`, cadence **1 s while a turn is
   live or a dialog is sighted, 4 s otherwise, paused when the tab is hidden**, plus an imperative
   `refresh()` that returns the fresh lens (the registry's verify-caret loop awaits it). It also
   captures the **boot-banner version once per session** with a single
   `peekAnsi(name, 10_000)` on first mount, cached in a module-level `Map<name, string|null>` — the
   banner scrolls off a 60-line window, and `claude --version` is the wrong pin because a running
   session keeps its boot binary (a0-findings, version ground truth).
   `// A2-SEAM: cadence becomes the WS `capture` frame; readLens is unchanged.`

**Tests** (`chat-peek-lens.test.ts`) — fixtures are the a0 captures copied **verbatim** into
`web/tests/fixtures/tui/`:

```ts
test('permission/bash: family, variant, options, caret at 0', () => {
  const lens = readLens(read('perm-bash.txt'))
  expect(lens.dialog?.family).toBe('permission')
  expect(lens.dialog?.variant).toBe('bash')
  expect(lens.dialog?.options.length).toBe(3)
  expect(lens.dialog?.caretIndex).toBe(0)
  expect(lens.composerDraft).toBeNull()
})

test('permission/edit is not read as bash (no ctrl+e footer, shift+tab in option 2)', …)

test('plan approval is not read as permission — option-1 text discriminates', () => {
  const lens = readLens(read('plan-approval.txt'))
  expect(lens.dialog?.family).toBe('plan')
  expect(lens.dialog?.planPath).toMatch(/^~\/\.claude\/plans\/plan-.*\.md$/)
})

test('options wrapped at 52 cols still match (whitespace-normalised)', () => {
  expect(readLens(read('perm-bash-52col.txt')).dialog?.family).toBe('permission')
})

test('an echoed ❯ prompt in scrollback is not a dialog', () =>
  expect(readLens(read('composer-idle.txt')).dialog).toBeNull())

test('a typed TUI draft is seen, an empty composer is not', () => {
  expect(readLens(read('composer-draft.txt')).composerDraft).toBe('half a thought')
  expect(readLens(read('composer-idle.txt')).composerDraft).toBeNull()
})

test('banner version', () =>
  expect(readLens(read('banner.txt')).bannerVersion).toBe('2.1.231'))
```

*DoD:* one network poller for the whole surface, provable by grepping the diff for `peekAnsi` (two
call sites: this hook and the pre-existing `provisional-tail.tsx`, whose 1 s poll stays as A1 wrote
it — folding it in is a tempting refactor and an A1-frozen-module violation).
**Perf: +1.3 KB gz.**

---

### T3 — The composer, live

`ui/composer.tsx` (B0) stays the *shell*; `components/chat/composer.tsx` becomes the behaviour, and
`composer-shell.tsx`'s read-only honesty line is replaced by a real input plane.

1. `composer-insert.ts` (pure): `insertAtCaret(draft, selection, text) → {draft, caret}` with the
   spacing rule (one space before an inserted token unless the draft already ends in whitespace or
   is empty; the caret lands after the token), and `attachmentSentence(paths)` reused verbatim from
   the mobile compose sheet's existing rule so a path drops in identically in both renderers.
2. `use-composer.ts`: draft state, `grow()` (`el.style.height='auto'` → `scrollHeight`, capped at
   the shell's `max-h-[120px]`), key handling:
   - `Enter` submits **unless** `e.shiftKey`, `e.nativeEvent.isComposing`, or `e.keyCode === 229`
     (the Android IME fallback the repo already handles in `lib/android-ime.ts` — reuse it, do not
     re-derive it);
   - `Shift+Enter` inserts `\n`;
   - `Escape` while Active → `input.sendKey('Escape')` (the Stop path, also reachable by the
     button); Escape with a non-empty draft clears the draft first (one Escape, one meaning);
   - the draft is per-session client state, kept across a renderer toggle (§6.2 carry-over) in a
     `Map<name, string>` in the panel, not in the store.
3. **Stop replaces Send while Active** — the trailing control of the B0 pill swaps in the same cell
   (`display:grid`, both children `1/1`, 260 ms opacity — the §11.6 crossfade already used by
   `SwapCell`), so nothing reflows on a status flip. Stop → `sendKey('Escape')`.
4. **Every insert surface writes into the REACT composer, never the TUI's.** The four paths master
   plan §3 names — attachment path-injection, dock slash segments, snippet insert, `@`/`/` picks —
   route through `insertAtCaret`. In the chat renderer the dock is currently hidden
   (`desktop-split.tsx` `!chatActive`); T3 un-hides the non-terminal dock actions by handing them
   `composer.insert` instead of `termRef.current?.send` (the raw-key joystick/keybar stays hidden —
   that is terminal-only by definition).
5. **Peek-verify before submit.** On submit: `const lens = await peek.refresh()`. If
   `lens.composerDraft` is non-empty → **do not send**; show the banner *"The terminal has an unsent
   draft"* + the draft's first 60 chars + a one-tap **Open terminal**, and keep the user's text in
   the React composer. If the refresh fails (session not running, request error) → submit anyway and
   let the watchdog (T4) be the honest layer; a peek outage must not make the app unusable. If a
   dialog is sighted → the composer submits nothing and points at the choice card (a `/send` while a
   permission dialog is open was never A0-tested — a0-findings §5 closing paragraph — so A4 refuses
   it rather than guessing).

**Tests** (`chat-composer-insert.test.ts` pure; `chat-interactive.test.tsx` static):

```ts
test('insertAtCaret spaces exactly once', () => {
  expect(insertAtCaret('fix', 3, '@src/main.rs').draft).toBe('fix @src/main.rs')
  expect(insertAtCaret('fix ', 4, '@src/main.rs').draft).toBe('fix @src/main.rs')
  expect(insertAtCaret('', 0, '/compact').draft).toBe('/compact')
})
test('caret lands after the inserted token', …)
test('Stop replaces Send while active', () => {
  const html = renderToStaticMarkup(<ChatComposer session={active} …/>)
  expect(html).toContain('data-testid="chat-stop"')
  expect(html).not.toContain('data-testid="chat-send"')
})
test('the read-only honesty line is gone once input is live', …)
```

The IME/Enter matrix is asserted in `chat-interactive.test.tsx` against the pure key handler
(`onComposerKeyDown(event-like) → 'submit' | 'newline' | 'stop' | 'pass'`) — extracted precisely so
it is testable without a DOM.

*DoD:* on the dogfood instance, typing + Enter sends; Shift+Enter grows the pill to 120 px then
scrolls; a draft left in the terminal blocks the send with the banner (verified by typing in the
TUI and then trying to send from chat).
**Perf: +2.1 KB gz.**

---

### T4 — P10 pending echo + the delivery watchdog

The mechanism master plan §4.4 calls inverted detection: *everything must confirm, or escalate.*

1. `pending.ts` (pure):

```ts
export type PendingState = 'sending' | 'unconfirmed' | 'undelivered'
export interface PendingSend { id: string; text: string; atMs: number; state: PendingState }

/** Trailing/leading whitespace + CRLF collapsed; nothing else. The transcript
 *  echoes the prompt verbatim (a0 §5), so an aggressive normaliser would match
 *  the WRONG message in a session that sends the same text twice. */
export function normalizeSend(text: string): string

/** Drop every pending whose text matches an unclaimed user entry stamped at or
 *  after (atMs − SKEW). One entry claims at most one pending (FIFO by atMs). */
export function reconcile(
  pending: readonly PendingSend[], entries: readonly ChatEntry[], nowMs: number,
): PendingSend[]

/** No matching entry AND no Active transition within WATCHDOG_MS → undelivered,
 *  regardless of status (master plan §4.4.1). */
export const WATCHDOG_MS = 5_000
export function watchdogState(
  p: PendingSend, ctx: { nowMs: number; sawActiveSince: (ms: number) => boolean },
): PendingState
```

2. `use-pending-sends.ts`: the store (per session), a submit path that pushes `sending` before the
   POST resolves and flips to `unconfirmed` on 2xx / `undelivered` on a rejected POST, the 1 s
   evaluation ride on the existing live-layer ticker (**no new interval**), and `retry(id)` /
   `dismiss(id)`.
   `// A2-SEAM: entries come from the WS instead of the recall poll; reconcile unchanged.`
3. Rendering: a pending send is a **P1 user bubble at reduced emphasis** with a state affordance
   (`sending` = nothing but the reduced opacity; `unconfirmed` = a 12 px `SystemLine`-weight
   "sending…"; `undelivered` = calm-orange `data-tone` line + **Retry** + **Open terminal**). It
   reconciles as a **no-op crossfade**, never a second entry-pop: the confirmed bubble lands in the
   transcript above and the pending cell fades out in the same grid cell — the identical technique
   `live-layer.tsx`'s `SwapCell` already uses for P13. Pending sends render **between the confirmed
   transcript and the live layer**, which is where a just-sent message actually belongs in time.
4. `undelivered` **raises the Attention card** (T5) with cause `send-unconfirmed`.

**Tests** (`chat-pending.test.ts`, pure — the whole point of the split):

```ts
test('a matching user entry reconciles the echo away', () => {
  const p = [mk('hello', 1_000)]
  expect(reconcile(p, [entry('hello', 1_002)], 2_000)).toEqual([])
})
test('the same text twice claims one entry each, oldest first', () => {
  const out = reconcile([mk('ping', 1_000), mk('ping', 1_100)], [entry('ping', 1_050)], 2_000)
  expect(out.map((x) => x.atMs)).toEqual([1_100])
})
test('an entry older than the send never claims it', …)
test('no entry + no active transition in 5s → undelivered', () => {
  expect(watchdogState(mk('x', 0), { nowMs: 5_001, sawActiveSince: () => false })).toBe('undelivered')
})
test('an Active transition within 5s holds it at unconfirmed even with no entry', () => {
  expect(watchdogState(mk('x', 0), { nowMs: 5_001, sawActiveSince: () => true })).toBe('unconfirmed')
})
test('status is irrelevant to the escalation (waiting/idle/active all escalate)', …)
```

*DoD:* on the dogfood instance, sending with the agent mid-turn shows the echo, then the queued pill
(T8), then the confirmed bubble — and killing the pty mid-send produces `undelivered` + the
Attention card within ~5 s.
**Perf: +1.6 KB gz.**

---

### T5 — The Attention card (the honesty surface)

One component, four causes, one copy module. `attention.ts` (pure) maps
`'send-unconfirmed' | 'dialog-unmapped' | 'registry-version-mismatch' | 'transcript-stale' | 'waiting-unmodelled'`
→ `{ title, body }`, so the honesty strings live in one testable place and cannot drift into
apologetic mush.

1. `attention-card.tsx`: title + body + **a read-only mini-view of `/peek?ansi=1`** + a 44 pt
   **Open terminal**.
2. **The mini-view is DOM, not a second terminal.** It renders the lens' raw capture through
   `parseAnsiLine` (`lib/ansi.ts` — truecolour-capable, already used by `provisional-tail.tsx`) into
   a `--terminal-fg`-on-`--terminal-bg` `pre`, max-height 220 px, own `overflow` box. Mounting
   `LiveTerminal` here would open a second WS **and resize the pty** — the one thing the chat
   renderer promises never to do (§8 "two views fight over the pty"). If a capture cannot be
   rendered faithfully (empty capture, session not running) the card degrades to **message only**,
   exactly as master plan §4.4 allows.
3. Presentation: desktop = an overlay scoped to the chat surface root (absolutely positioned inside
   `ChatSurface`, not a portal — the shell-scoped overlay of §11.4 is Track B; A4 uses the surface
   it owns and leaves a `TODO §11.4` where the shell overlay will adopt it). Mobile = the existing
   `ResponsiveSheet`. Motion: `springs.cardExpand` + a reduced-motion twin.
4. Inline vs expanded: the card appears **inline in the live layer** as a compact row (title +
   "Show terminal"), and expands into the overlay/sheet. An unmissable modal on every
   watchdog blip would train the user to dismiss it.

**Tests** (`chat-attention.test.tsx`, `renderToStaticMarkup`): each cause renders its own copy; the
mini-view emits styled spans for a truecolour capture and *nothing* for an empty one (message-only
degrade); the card always contains an Open-terminal control.

*DoD:* the five causes are reachable on `/dev/chat-live` (T10) and each names what is actually
wrong.
**Perf: +1.8 KB gz** (no xterm — the deliberate saving).

---

### T6 — The modal registry (pure), version-pinned

Two families, both live-verified. Everything else is detection-only → Attention card.

1. `registry/claude.ts`:

```ts
export interface RegistryEntry {
  id: 'permission.bash' | 'permission.edit' | 'permission.write' | 'plan.approval'
  family: 'permission' | 'plan'
  /** The CC versions this entry was CAPTURED against. */
  verifiedVersions: readonly string[]     // ['2.1.227','2.1.231']
  /** Card options, in TUI order, with what each one actually does. */
  options: readonly RegistryOption[]
}
export interface RegistryOption {
  label: string                 // the card's words
  tuiIndex: number              // 0-based row the caret must reach
  actOn: boolean                // false → rendered, disabled, with a reason
  disabledReason?: string
  effect: 'accept' | 'accept-session' | 'deny' | 'feedback'
}
```

Contents, straight from a0-findings §3 (each option carries its evidence in a comment):

- `permission.*`: `1. Yes` (accept, act-on), `2.` (act-on **only** for edit/write — BTab-verified;
  **Bash option 2 `actOn:false`**, reason *"what 'always allow' persists is unverified"*), `3. No`
  (deny, act-on), plus `Esc` → deny;
- `plan.approval`: the **real 2.1.231 labels** — `Yes, and use auto mode` / `Yes, manually approve
  edits` / `Tell Claude what to change` — all three act-on; **Esc is `actOn:false`** until the T12
  self-test captures it (a0 left it deliberately unverified).

2. `registry/plan.ts`:

```ts
/** Digits are NOT sendable (KEY_ALLOWLIST has no 0-9), so navigation is the plan.
 *  From the caret's CURRENT row, not from an assumed default — the caret has been
 *  observed moved by a concurrent client. */
export function keyPlan(from: number, to: number): KeyName[]   // ['Down','Down','Enter']
```

Wrapping is **not** assumed (no evidence CC's list wraps): moving up uses `Up`, never `Down`×N−1.

3. `pinFor(session)` — the **boot-banner** version from the lens (T2), never `claude --version`.
   `entryFor(lens, pinnedVersion)` returns `{entry, degraded: boolean}`; a sighting whose pinned
   version is not in `verifiedVersions` returns the entry with **every option hard-disabled** and a
   `registry-version-mismatch` Attention cause. Unknown families return `null` → `dialog-unmapped`.

**Tests** (`chat-registry.test.ts`, pure, over the same T2 fixtures):

```ts
test('bash option 2 is rendered but never actionable', () => {
  const o = entryFor(readLens(read('perm-bash.txt')), '2.1.231').entry!.options[1]
  expect(o.actOn).toBe(false); expect(o.disabledReason).toMatch(/unverified/i)
})
test('edit option 2 IS actionable (BTab-verified)', …)
test('plan Esc is not actionable in v1', …)
test('keyPlan from caret 0 to 2', () => expect(keyPlan(0, 2)).toEqual(['Down','Down','Enter']))
test('keyPlan upward uses Up', () => expect(keyPlan(2, 0)).toEqual(['Up','Up','Enter']))
test('keyPlan contains no digit, ever', () => {
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++)
    expect(keyPlan(a, b).some((k) => /^\d$/.test(k))).toBe(false)
})
test('an unpinned version hard-disables every option', () => {
  const r = entryFor(readLens(read('perm-bash.txt')), '2.2.0')
  expect(r.degraded).toBe(true)
  expect(r.entry!.options.every((o) => !o.actOn)).toBe(true)
})
```

*DoD:* the registry is a data file with a test per verified claim; no component imports it directly
except T7's hook.
**Perf: +1.2 KB gz.**

---

### T7 — Answering: P5 choice cards, act-on

`use-dialog-answer.ts` — the only module in the app that presses a key into a dialog. Its sequence,
per option, is fixed and each step is a refusal point:

```
1  verify-caret-BEFORE-send   lens = await peek.refresh()
                              the sighting must still be the same family/variant/options
                              (concurrent-client races were observed live, twice)
2  navigate                   for each key in keyPlan(lens.dialog.caretIndex, target):
                                 sendKey(key); lens = await peek.refresh()
                                 the caret must have moved by exactly one row → else ABORT
3  commit                     sendKey('Enter')
4  dismissal check            re-peek (2 attempts, 300 ms apart): the dialog must be GONE
                              → else ABORT into the Attention card
```

Abort at any step ⇒ **nothing further is sent**, the card returns to unanswered, and the Attention
card raises with the capture that confounded it. `answering` disables the whole card (no double-fire
on a slow pty).

Wiring:

1. `live-layer.tsx`'s `PermissionCard` gains `onChoose` and a `state` prop
   (`idle | answering | degraded`), sourced from the session's hook-driven `permission_request` (the
   fast trigger, ≪1 s) **cross-checked against the lens sighting** (the authority for *which* variant
   and *where the caret is*). Hook without sighting = the card renders unanswerable with a "checking
   the terminal…" line for one poll; sighting without hook = the card renders anyway (the lens is
   sufficient). The A3 honesty line ("Answer in the terminal") survives verbatim as the degraded
   state's copy.
2. **Plan approval** gets its own card, from the lens only (no `PermissionRequest` hook is verified
   for `ExitPlanMode` — T12's self-test records whether one fires; the plan does not assume it). The
   card shows the three real labels and, when `dialog.planPath` is present, offers
   **Read the full plan** — `filesApi` on `~/.claude/plans/plan-<slug>.md`, rendered by the existing
   lazy chat-markdown chunk (zero new bytes).
3. **Free text** — there is no in-dialog free-text row on 2.1.2xx:
   - permission → `sendKey('Escape')`, dismissal check, then focus the React composer with a
     pre-filled hint. The composer's send then carries the feedback (verified round-trip in A0);
   - plan → option 3 (`Tell Claude what to change`), then focus the composer.
   The card labels this affordance *"Say something instead"* and the code comments name the two
   sequences with their a0 evidence.
4. **The digits stay hints.** `kbd 1-3` renders as A3 drew it, and the *local* keyboard binds
   1..N → `onChoose(i)` while the card is focused. No digit is ever sent to the pty.
5. **Mode chip gate** (`header-pill.tsx`): the chip becomes actionable (`POST /mode`) **only when
   `lens.dialog == null`**. With a dialog up it renders disabled with the reason *"answer the
   dialog first"* — `POST /mode` converges by pressing **BTab**, and BTab inside a permission dialog
   *accepts it* (live-verified). Additionally: an `accept_edits` flip that arrives while a dialog is
   sighted is annotated in the system line as *"mode changed in the terminal"* rather than silently
   trusted — a0's "possibly-swallowed BTab" signature.
6. **Outcome inference** (dialog outcomes write nothing to the JSONL): accept ⇒ a `tool_result`
   receipt lands; deny/Esc ⇒ the `Interrupted · What should Claude do instead?` shape. The card
   crossfades into a `SystemLine` (`Allowed · Bash` / `Denied`) on whichever arrives first, and
   reconciles the mode chip from `SessionView.mode` regardless.

**Tests** (`chat-interactive.test.tsx` + a hermetic hook test with a scripted peek/send pair):

```ts
test('a moved caret aborts the sequence and sends no Enter', async () => {
  const rig = scriptedRig({ captures: [permAt(0), permAt(2) /* jumped */], })
  await rig.choose(1)
  expect(rig.sent).toEqual(['Down'])          // no Enter
  expect(rig.attention).toBe('dialog-unmapped')
})
test('a dialog that survives the commit raises Attention', …)
test('choosing option 3 on a permission sends Down,Down,Enter and nothing else', …)
test('a version-mismatched sighting renders no enabled button', …)
test('the mode chip is disabled while a dialog is sighted', …)
test('free-text on a permission sends Escape, then focuses the composer', …)
```

*DoD:* on the dogfood instance, a real `Bash` permission is answered from chat, twice (allow, deny),
and the terminal view confirms the outcome; a deliberately unpinned version degrades the card.
**Perf: +2.4 KB gz.**

---

### T8 — P9 queued pills (CC's own queue) + the cancel path

A0 measured the enqueue receipt at **158 ms** — a queued send is *real state*, not an optimistic
guess. But the A1 wire cannot see it: `server/src/sessions/recall.rs` `read_chat_turns` reads only
`user`/`assistant`/title lines, so `queue-operation` never reaches the client.

1. **Server (small, additive, `chat=true` only):** `read_chat_turns` also emits
   `{"type":"queue-operation","operation":"enqueue"|"dequeue"|"remove", …}` as `RecallEntry`s with
   `kind: Kind::Queued` and `label: operation`; `enqueue` carries `content` as `text`, `dequeue`
   carries none (138 B: `operation`/`timestamp`/`sessionId` — verified on the raw lines).
   `// A2-SEAM:` A2's parser emits the same kind, so the client is source-agnostic.
   Rust test: a fixture line of each operation parses into the three entries in order.
2. `queued.ts` (pure): **FIFO matching, because `dequeue` carries no id and no content** —
   `pendingQueue(entries)` walks oldest→newest, pushing on `enqueue`, popping the head on
   `dequeue`/`remove`, and confirms a promotion by matching the head's text against the next `user`
   entry. Returns the still-queued texts, in order.
3. Rendering: `P9` = a muted outline user bubble + a `queued` micro-badge, below the pending echoes,
   above the live layer; promotes to P1 via the same-cell crossfade on confirmation. A P10 pending
   whose text matches the head of the queue is **absorbed** (one message, one bubble — the echo
   becomes the pill rather than sitting beside it).
4. **Cancel — gated on evidence, not shipped on hope.** `remove` exists in the corpus, but no key
   sequence for it was ever verified. So v1 renders **Cancel** as an Open-terminal affordance, and
   T12's self-test captures what the TUI actually does to a queued prompt (expected: Esc clears the
   queue). If and only if that capture is clean and caret-verifiable does the button become a real
   `sendKey` — a same-day follow-up commit on this branch, with its fixture. This is the same rung
   the registry uses for Bash option 2 and plan-Esc, and it is deliberate: a Cancel that silently
   fails is worse than a Cancel that opens the terminal.

**Tests** (`chat-queued.test.ts`):

```ts
test('enqueue then dequeue leaves the queue empty', …)
test('two enqueues, one dequeue pops the OLDEST (FIFO — dequeue carries no id)', () => {
  expect(pendingQueue([enq('a', 1), enq('b', 2), deq(3)]).map((q) => q.text)).toEqual(['b'])
})
test('remove pops too', …)
test('a promotion is confirmed by the matching user entry, not by the dequeue', …)
test('a pending echo matching the queue head is absorbed, not doubled', …)
```

*DoD:* sending mid-turn from chat shows a queued pill within ~1 refetch, and it promotes to a normal
bubble when CC consumes it.
**Perf: +0.9 KB gz** (client); server change is not in the budget.

---

### T9 — `@`-files and `/`-commands in the composer

§5.6's anti-lookalike rule: chat must not be *less capable than the terminal at the app's actual
job.*

1. `slash.ts` (pure):

```ts
/** Text-safe: the TUI consumes them as text and runs them — chat may pass them through. */
export const PASS_THROUGH = ['/compact', '/clear', '/cost', '/status', '/review', '/pr-comments'] as const
/** These OPEN A PICKER in the TUI: sending them from chat leaves an interactive
 *  widget on a pty nobody is looking at (a0 §3, Family 4). */
export const PICKER_OPENING = ['/model', '/resume', '/rewind', '/config', '/agents', '/mcp', '/login'] as const
export function classifySlash(text: string): 'pass' | 'picker' | 'unknown'
```

`unknown` (a project/skill command from `GET /api/slash-commands`) is **pass-through with a note**:
those are user-authored prompts, not TUI widgets. A `picker` command is not sent at all — the
composer shows an inline hint (*"`/model` opens a picker in the terminal"*) + **Open terminal**.

2. `entity-picker.tsx` (lazy, dev-cheap): `@` opens a popover over
   `GET …/tracked-files` (paths, fuzzy-filtered client-side, existing list styling) **and** the
   sessions list (delegate targets — a session pick inserts a mention token; actually *dispatching*
   to another agent stays §13/Track B, so v1 inserts the name, it does not call
   `/api/agents/delegate`). `/` opens the slash popover over the existing `useSlashCommands()` cache
   (60 s staleTime, already in the app). Both **insert into the React composer** via
   `insertAtCaret` — never into the TUI.
3. Keyboard: `↑/↓` move, `Enter`/`Tab` accept, `Esc` closes the popover **without** reaching the
   composer's Escape handler (one Escape, one meaning — asserted in a test).

**Tests** (`chat-slash.test.ts` + one static render): the three classifications incl. an unknown
project command; `/model` never produces a submit; `@` inserts the path with the T3 spacing rule;
the picker's Escape does not trigger Stop.

*DoD:* `@` finds a tracked file and `/compact` runs from chat on the dogfood instance.
**Perf: +2.0 KB gz, lazily loaded** (the picker chunk is reached only on `@`/`/`, so the entry
budget sees ~0.3 KB of trigger code).

---

### T10 — `/dev/chat-live` gains one state per interactive surface

The bench is how the boards are held to account, and A4's surfaces are exactly the ones a
screenshot can catch lying. Six new states in `dev-chat-live.fixture.ts`, each shot in
desktop/phone × light/dark by the offline rig (memory: *Offline mobile UI review rig*):

| id | shows |
|---|---|
| `composing` | a real draft in the composer, Send enabled, `@`-picker open over tracked files |
| `stopping` | status `active` + a draft → the Stop control in place of Send |
| `pending` | one `sending`, one `unconfirmed`, one `undelivered` echo with Retry |
| `queued` | two queued pills + the confirmed bubble one of them promoted into |
| `answering` | the permission card mid-sequence (`answering` state) **and** the plan-approval card |
| `attention` | the Attention card expanded, with a truecolour mini-view of `perm-bash.txt` |

The fixtures reuse the same cast/pins the whole design system uses (that file's own rule), and
`dev-chat-live-fixture.test.ts` grows one assertion per state: every state id in `STATE_IDS`
resolves, and every new fixture's entries parse through `toDisplayList` without throwing.
The transport shim answers `peek?ansi=1` with the **verbatim a0 capture**, so the bench and the
registry tests read the same bytes.

*DoD:* `bun run dev` → `/dev/chat-live?state=attention&surface=phone&theme=dark&bare=1` screenshots
without a server.
**Perf: 0 KB** (dev-only route, `import.meta.env.DEV`-gated, never in a production chunk — asserted
in T12).

---

### T11 — Live self-test on a real session (the three deferred captures)

A4 is the fase that owes A0 its deferred evidence. On a **side-by-side dogfood instance on another
port** (memory: *Never restart this instance unasked*), with one real Claude session, capture and
record in the PR body:

1. **Plan-approval `Esc`** — expected ≈ option 3. Clean capture ⇒ flip `plan.approval` Esc to
   `actOn: true` with its fixture. Otherwise it stays disabled, and that is the answer.
2. **Bash permission option 2** — what, if anything, it persists (`~/.claude.json` `allowedTools`,
   `.claude/settings.local.json`, `~/.claude/settings.json`, before/after). Clean ⇒ `actOn: true`;
   inconclusive ⇒ it stays rendered-and-disabled.
3. **Queued-prompt cancel** — what the TUI does to a queued prompt (T8.4).
4. **Whether `ExitPlanMode` fires a `PermissionRequest` hook** — if it does, the plan card gets the
   same ≪1 s trigger the permission card has; if not, the lens remains its only source (already the
   coded assumption, so nothing breaks either way).
5. **The registry startup self-test**, on a live session: assert every pinned fingerprint against a
   fresh capture and record the boot-banner version. This is the mechanism §4.3 requires on every CC
   bump, and T11 is where it gets exercised for the first time.

Whatever is captured lands as a fixture in `web/tests/fixtures/tui/` in the same commit as the flag
it flips. **No option is enabled without a fixture.**

*DoD:* four questions answered in writing in the PR body, with captures.
**Perf: 0 KB.**

---

### T12 — Verification, budget, regression net

In this order, with real output pasted into the PR body (no claim without evidence):

```
cd /opt/projects/supermux-a4/web
bun run lint
bun run test:unit          # A1 + B0 + A3 + the nine new files, all green
bun run build:perf         # budget gate: app JS ≤ 200 KB gz (A3 baseline 174.71)
cd /opt/projects/supermux-a4 && cargo check           # the recall.rs change (debug only — never --release)
cargo test recall                                      # incl. the queue-operation fixture test
```

**Budget rule for A4: app JS must stay ≤ 186 KB gz** — the sum of the per-task estimates above is
**+13.7 KB** against 174.71 → ~188.4 KB, which is over. So one of the two lazy boundaries is
mandatory, not optional, and T12 is where it is proven:

- the `@`/`/` picker is `React.lazy` (T9) — the entry chunk pays ~0.3 KB, not 2.0;
- the registry + `use-dialog-answer` + the Attention card ride the **existing lazy chat chunk**
  (`desktop-split.tsx` already does `React.lazy(() => import('@/components/chat/chat-panel'))`), so
  they never reach the hero path.

With both, the expected entry delta is **≈ +5 KB** (session-input + api client + the trigger code)
and the chat chunk carries the rest. If `build:perf` shows the app JS jumping past 186, the fix is
the lazy boundary, never the budget — the A3 tripwire rule, restated.

Then the visual pass: `/dev/chat-ui` unchanged (A4 touches no B0 primitive — a diff there is a bug),
`/dev/chat-live` all states × both themes × both surfaces, held next to the board PNGs; and the
dogfood pass: one real session driven **entirely from chat** for one working session — send, queue
mid-turn, answer a permission, stop a turn, hit an undelivered send on purpose.

---

### T13 — PR

One PR, `feat/a4-interactivity` → `feat/a3-chat-surface` (keep the stack; the owner merges B0 → A3
first). Body: the six new bench screenshots × 2 themes, the perf table with the before/after gz
numbers, full test output, the T11 capture answers, and an explicit **"what chat can now do to your
session"** list — the four write paths (`/send`, `/paste`, `/keys`, `/mode`) with their guards.
Hand off; never self-merge (memory: *User reviews all merges*).

---

## 3. Constraints, restated as checkable rules

| rule | how it is checked |
|---|---|
| no new deps | `git diff web/package.json` is empty |
| perf budget | `bun run build:perf` ≤ 186 KB gz app JS; every task above states its delta |
| chat code stays lazy | `dist/assets` shows the chat chunk separate; no entry chunk statically imports `registry/` or `entity-picker` |
| `UseLiveTermResult` is not shimmed | `hooks/use-live-term.ts` is unchanged in the diff; `grep -r 'implements SessionInput' hooks/` is empty |
| no digit ever reaches the pty | the `keyPlan` property test (T6) + `grep -nE "keys: *['\"][0-9]" web/src` is empty |
| `POST /mode` is dialog-gated | the T7 test + `grep -n setMode` shows exactly one call site, behind `lens.dialog == null` |
| every registry action is verified | each `actOn: true` option has a fixture + a test naming its a0 evidence |
| version pin from the boot banner | `grep -rn "claude --version" web/src` is empty; `bannerVersion` is the only pin |
| one peek poller | exactly two `peekAnsi` call sites (the lens, the A1 provisional tail) |
| motion only from `springs.ts` | grep the diff for `cubic-bezier(` / `transition: all` |
| reduced-motion twin per motion | `useReducedMotion()` beside each `motion.*` |
| A1/A3 tests are the net | `chat-entries`, `chat-provisional`, `chat-latency`, `chat-flag`, `chat-grouping`, `chat-frames`, `chat-surface`, `chat-conversation` untouched and green |
| no colour literals | new files contain no `#rrggbb` (B0 tokens only) |
| a bench state per interactive surface | `dev-chat-live-fixture.test.ts` asserts all six new ids |

---

## 4. Risks

1. **A mis-send answers the wrong dialog.** The exact §4.3 hazard. Mitigation is layered and each
   layer is a refusal: version pin → verify-caret-before-send → one re-peek per navigation key →
   dismissal check → abort into Attention. The property test forbids digits, and no unverified
   option is ever enabled. Residual risk: a concurrent client resolving the dialog between the last
   peek and the Enter — bounded to one keystroke, and the dismissal check reports it.
2. **`POST /mode` swallows a BTab into a dialog.** Gated on `lens.dialog == null`, and an
   `accept_edits` flip observed while a dialog is sighted is *annotated*, not trusted.
3. **The peek lens is a screen-scraper and CC will change.** It is confined to one pure module with
   verbatim fixtures; a fingerprint miss degrades to the Attention card (visible), never to a wrong
   action (invisible). Every CC bump re-runs T11's self-test.
4. **Double-submit through the two input planes.** The reason `UseLiveTermResult` is not shimmed.
   The `terminalSessionInput` adapter is the only place a `\r` is appended, and the REST path never
   appends one — both pinned by tests.
5. **The composer's peek-verify adds latency to every send.** One `/peek` (~50 ms RTT measured in
   A0) before the POST. Accepted: it is the only thing standing between a chat send and a TUI draft
   getting silently concatenated. On peek failure the send proceeds and the watchdog covers it.
6. **The recall extension (T8) touches a hot server path.** Additive, `chat=true`-only, one match
   arm; covered by a Rust fixture test. It is also the one change A2 will supersede, so it is
   written to A2's kind, not to a private shape.
7. **Stacked-branch churn.** B0/A3 may take review edits; rebase `feat/a4-interactivity` on
   `feat/a3-chat-surface` before the PR, never merge main into it. Others build in this repo on
   rotating branches (memory: *Concurrent agents in repo*) — stay in the worktree.
8. **The bench can pass while the wire changed.** Fixtures are typed as the real
   `RecallResponse`/`TileSession`, so a wire change breaks the build, and the TUI fixtures are the
   a0 captures byte-for-byte.

---

## 5. Explicitly deferred (and to where)

- **The changes rail** (§5.6.1 — working-tree strip over `GET /git` + `tracked-files`, desktop side
  pane / mobile sheet) → **A5**, with the side pane it lives in. A4 uses `tracked-files` only as the
  `@`-picker's source, which is why the endpoint appears here at all.
- **The mobile focus seam** — mounting the chat renderer at `routes/focus/mobile.tsx` (keyboard-aware
  sheet, dock repack, the mobile trio) → **A5** with the 3-way switch and mounted-but-hidden
  retention. A4 *does* convert that call site to `SessionInput` (T1), so A5 is a prop change.
- **Overview/roster work** — chat-tail tiles, the roster's context%/cost column, per-tile renderer
  override → **A5/Track B §12**.
- **Steering in the composer** — never (a0 §5: `/steer` stays server-side dispatch; two queues
  behind one text box is the failure the `/send` decision avoids).
- **Real delegation from `@`** (`POST /api/agents/delegate`) → **Track B §13**; A4's `@session`
  inserts a mention, it does not dispatch.
- **Widening `KEY_ALLOWLIST` to `0-9`** → unsigned owner item. Nothing in A4 depends on it; when it
  lands, `registry/plan.ts` gains a digit fast-path behind a capability check and every test above
  keeps passing.
- **Context%/cost in the header pill** → needs A2's statusline tap (owner consent pending).
- **Token streaming, any new write surface beyond the four endpoints above** → out of Track A
  entirely (a0 fail-branch scope, unchanged).
