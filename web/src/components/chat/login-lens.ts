// The /login lens — TypeScript half.
//
// Twin of `server/src/sessions/login.rs`. Both read the SAME corpus
// (`server/tests/fixtures/login/cases.jsonl` and the captures beside it) and
// must agree on every case; `web/tests/unit/login-lens-parity.test.ts` and
// `server/tests/login_parity.rs` are the two halves of that contract.
//
// WHY TWO LENSES AT ALL. The server's reading is what makes the roster dot
// honest (a session parked on a credential prompt is `waiting`, not a green
// idle) and what the supervision freeze hangs off. This one draws the CARD, off
// the capture the chat surface is already polling (`use-peek-lens.ts`), so the
// card appears in the same tick the dialog does instead of one HTTP round trip
// later. Neither is exhaustive — both fall through to "no login here" — which
// is the right degrade (an unrecognised screen becomes the ordinary terminal,
// never a card that answers the wrong prompt) and exactly why the corpus has to
// be shared: a shape taught to one plane and forgotten on the other compiles
// clean in both languages.
//
// RELATIVE imports only, and none at all here: this module is pure and is run
// by `bun test` without alias config (same rule as `peek-lens.ts`).

export type LoginStage = 'method_select' | 'paste_prompt' | 'invalid' | 'success' | 'error'
/** `/login` (the account credential) vs `/design-login` (`user:design:read`).
 *  They print the byte-identical paste prompt, so the prompt cannot tell them
 *  apart — the lines above it can, and a card that guesses tells the user they
 *  are signing in to their account when they are not. */
export type LoginFlow = 'account' | 'design'

export interface LoginSighting {
  stage: LoginStage
  flow: LoginFlow
  /** The authorize URL, reassembled across the grid's hard wraps. */
  url?: string
  /** The method selector's labels, in TUI order. */
  options: string[]
  /** The verbatim rejection / error line, whole — across the wrap. */
  message?: string
  /** `Logged in as {email}`, when the success screen names it. */
  email?: string
}

/** The masked field's label, verbatim. */
export const PASTE_PROMPT = 'Paste code here if prompted'
const INVALID_LINE = 'Invalid code. Please make sure the full code was copied'
const METHOD_SELECT = 'Select login method:'
/** The authorize hosts. `claude.ai` is NOT one any more — the flow moved to
 *  `claude.com/cai/oauth/authorize` with `platform.claude.com` as the callback,
 *  and a lens that still allowlists the old host renders a card with no link. */
export const URL_HOSTS = ['claude.com', 'console.anthropic.com', 'platform.claude.com']

/** How far above the bottom of the capture the lens looks. */
const LOOKBACK = 60

/**
 * SGR (and every other escape) removed, because BOTH channels reach this
 * function and only one of them is plain.
 *
 * The server reads `capture_plain`; the chat surface polls `?ansi=1` (the
 * colour-true channel the Attention card's mini-view needs), and the native VT
 * re-emits SGR PER ROW — every line of that capture ends in `\x1b[0m`. So a
 * lens that matched on raw rows saw `Paste code here if prompted > \x1b[0m`,
 * failed its end-of-row anchor, and drew no card at all against a live session
 * while the server-side twin — reading the plain channel — happily reported
 * `waiting`. Found exactly that way, live, in `login-flow.spec.ts`.
 *
 * Stripping is a no-op on a plain capture, which is what keeps the two planes
 * reading the SAME corpus and agreeing.
 */
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -/]*[@-~]/g

function stripAnsi(s: string): string {
  return s.includes('\x1b') ? s.replace(ANSI_RE, '') : s
}

/** U+276F at column 0 with no digit after it — the TUI's own composer. Its
 *  presence BELOW a login marker proves the flow is over: Claude Code does not
 *  draw the composer under a live login dialog. (An option row is
 *  ` ❯ 1. …` — space-prefixed and numbered — so it is not this.) */
function isComposerRow(line: string): boolean {
  if (!line.startsWith('❯')) return false
  return !/^\d/.test(line.slice(1).trimStart())
}

function lastContentLine(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return i
  return -1
}

/** The rows a login flow could still own: from the bottom, up to `LOOKBACK`
 *  rows, stopping at the first composer row. */
function windowOf(lines: readonly string[]): [number, number] | null {
  const tail = lastContentLine(lines)
  if (tail < 0) return null
  const floor = Math.max(0, tail - LOOKBACK)
  let start = floor
  for (let i = tail; i >= floor; i--) {
    if (isComposerRow(lines[i])) {
      start = i + 1
      break
    }
  }
  return start > tail ? null : [start, tail]
}

/** The dismissal hints Claude Code prints UNDER a live dialog, verbatim. */
const FOOTER_HINTS = [
  'Esc to cancel',
  'Esc to exit',
  'Esc to go back',
  'Enter to confirm',
  'Enter to select',
  'Enter to continue',
  '↑/↓ to navigate',
  'Tab to amend',
  'ctrl+e to explain',
]

/**
 * A row the TUI draws BELOW the thing that is waiting — so it does NOT end a
 * dialog. Twin of `login.rs::is_chrome_row`, and the whole reason both exist:
 * Claude Code 2.1.233 draws
 *
 *     Paste code here if prompted >
 *
 *     Esc to cancel
 *
 * — blank rows and a dismissal footer under the field (plus, when the composer
 * box is on screen, its rule and the permission-mode row). A lens that asked "is
 * the LAST content row the paste prompt?" read `Esc to cancel`, matched nothing,
 * and drew no card at all while an OAuth code was live.
 *
 * Deliberately a SHORT list of the TUI's own furniture: an unrecognised screen
 * must still fall through to "no login here".
 */
function isChromeRow(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (t.startsWith('⏵')) return true
  if (t.includes('────') && t.replace(/[─━═ ]/g, '').length <= 40) return true
  return t.split('·').every((seg) => FOOTER_HINTS.includes(seg.trim().replace(/\.$/, '')))
}

/** The last row of the window that is not chrome — the element actually waiting. */
function lastLiveRow(lines: readonly string[], start: number, tail: number): number {
  for (let i = tail; i >= start; i--) if (!isChromeRow(lines[i])) return i
  return -1
}

/**
 * Is this row the LIVE paste prompt?
 *
 * The prompt is drawn with no trailing newline, so the live shape is the prompt
 * followed by whatever the FIELD holds — `*`/`•` on a version that masks it, and
 * (verified live on 2.1.233) the typed characters themselves on one that does
 * not. Both are accepted: a lens that only knew the masked shape went blind at
 * the exact moment a code was on the screen.
 *
 * What the field may NOT contain is whitespace, and that is what keeps a
 * paragraph quoting the prompt out of the card independently of the window rule.
 */
function isPasteRow(line: string): boolean {
  const i = line.indexOf(PASTE_PROMPT)
  if (i < 0) return false
  let rest = line.slice(i + PASTE_PROMPT.length).trimStart()
  if (rest.startsWith('>')) rest = rest.slice(1)
  return !/\s/.test(rest.trim())
}

const URL_CHAR = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/

function gridWidth(lines: readonly string[]): number {
  let w = 0
  for (const l of lines) w = Math.max(w, [...l].length)
  return w
}

/**
 * One LOGICAL line, rebuilt from the physical rows the grid holds it in.
 *
 * A hard wrap inserts nothing, so the rows concatenate raw. Used for the error
 * and rejection messages, which are English sentences and wrap on any real
 * terminal: reading only the first row gives "…Please try", which is not a
 * message and which no two terminal widths agree about.
 */
function joinWrapped(lines: readonly string[], at: number): string {
  const width = gridWidth(lines)
  let out = lines[at]
  let i = at
  while (width > 0 && [...lines[i]].length >= width) {
    i += 1
    const next = lines[i]
    if (next === undefined) break
    // A continuation starts at column 0 and has content.
    if (!next.trim() || /^\s/.test(next)) break
    out += next
  }
  return out.trim()
}

/**
 * Reassemble a hard-wrapped URL out of the VT grid — `capture-pane -p -J`'s job,
 * without tmux.
 *
 * A pty keeps no soft-wrap marker: a URL that ran past the right margin is N
 * full rows followed by a short one, every one of them starting at column 0. So
 * the join rule is the two facts a wrap leaves behind: the row above is FULL
 * (its length is the grid width, inferred as the longest row in the block), and
 * the row itself is unindented and made only of URL characters. Both are
 * required — the first alone swallows the next sentence whenever a line reaches
 * the margin, the second alone swallows any bare word after a short URL.
 *
 * KNOWN LIMIT, stated rather than papered over: a URL ending EXACTLY at the
 * margin followed by a bare unindented word of URL characters is
 * indistinguishable from a wrap. Nothing in the grid can separate them, every
 * captured login block puts a blank row after the URL, and the failure
 * announces itself — the authorize page rejects a mangled URL immediately.
 */
export function reassembleUrl(
  lines: readonly string[],
  accept: (u: string) => boolean = (u) => URL_HOSTS.some((h) => u.includes(h)),
): string | undefined {
  const width = gridWidth(lines)
  if (!width) return undefined
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].indexOf('https://')
    if (at < 0) continue
    let head = lines[i].slice(at)
    const sp = head.search(/\s/)
    const complete = sp >= 0
    if (complete) head = head.slice(0, sp)
    if (!accept(head)) continue
    let url = head
    if (!complete) {
      let prevFull = [...lines[i]].length >= width
      for (let j = i + 1; j < lines.length && prevFull; j++) {
        const next = lines[j]
        if (!next || /^\s/.test(next) || !URL_CHAR.test(next)) break
        url += next
        prevFull = [...next].length >= width
      }
    }
    return url
  }
  return undefined
}

function readFlow(block: string): LoginFlow {
  return block.includes('design login') ||
    block.includes('design credential') ||
    block.includes('Design-system access') ||
    block.includes('user%3Adesign')
    ? 'design'
    : 'account'
}

/** ` ❯ 1. Claude account with subscription · …` → the label. */
function readOptions(lines: readonly string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    let t = line.trimStart()
    if (t.startsWith('❯')) t = t.slice(1).trimStart()
    const m = /^(\d+)\.\s+(\S.*)$/.exec(t)
    if (!m) continue
    if (Number.parseInt(m[1], 10) !== out.length + 1) continue
    out.push(m[2].trim())
  }
  return out
}

/** Read one `/peek` capture. Pure and total: no capture throws, and a capture
 *  with no login on it reads as `null` rather than as a failure. */
export function readLogin(capture: string): LoginSighting | null {
  const lines = capture ? stripAnsi(capture).split('\n') : []
  const w = windowOf(lines)
  if (!w) return null
  const [start, tail] = w
  const win = lines.slice(start, tail + 1)
  const block = win.join('\n')
  const flow = readFlow(block)

  // Success first: it is the only stage that can sit under a finished paste
  // field, and reading it as "still waiting for a code" leaves the user staring
  // at an input box for a login that already worked.
  if (block.includes('Login successful') || block.includes('Logged in as')) {
    const line = win.find((l) => l.includes('Logged in as '))
    const email = line?.split('Logged in as ')[1]?.trim().replace(/\.$/, '')
    return {
      stage: 'success',
      flow,
      options: [],
      ...(email && email.includes('@') ? { email } : {}),
    }
  }

  // ANCHORED at the bottom, THROUGH THE CHROME — see `isChromeRow`.
  const live = lastLiveRow(lines, start, tail)
  if (live >= 0 && isPasteRow(lines[live])) {
    let at = -1
    for (let i = win.length - 1; i >= 0; i--) {
      if (win[i].includes(INVALID_LINE)) {
        at = i
        break
      }
    }
    const url = reassembleUrl(win)
    return {
      stage: at >= 0 ? 'invalid' : 'paste_prompt',
      flow,
      options: [],
      ...(url ? { url } : {}),
      ...(at >= 0 ? { message: joinWrapped(win, at) } : {}),
    }
  }

  if (block.includes(METHOD_SELECT)) {
    return { stage: 'method_select', flow, options: readOptions(win) }
  }

  for (let i = win.length - 1; i >= 0; i--) {
    const t = win[i].trim()
    if (
      t.startsWith('OAuth error:') ||
      t.startsWith('Login failed:') ||
      t.startsWith('Authentication failed:') ||
      t === 'Login interrupted' ||
      t === 'Authentication timeout' ||
      t.startsWith('OAuth state mismatch') ||
      t.includes(INVALID_LINE)
    ) {
      const url = reassembleUrl(win)
      return {
        stage: 'error',
        flow,
        options: [],
        ...(url ? { url } : {}),
        message: joinWrapped(win, i),
      }
    }
  }
  return null
}

/**
 * ONE SIGHTING, ONE CARD — does the sign-in card own this frame?
 *
 * `Select login method:` is read by BOTH lenses off the same capture: by this
 * one, which knows the three options and has a verified way to answer them, and
 * by `peek-lens.ts`, which reads three numbered rows under a caret, finds no
 * fingerprint for the screen, and correctly degrades to `family: 'unknown'` —
 * a card with every option disabled, under an attention row reading "Claude is
 * asking something chat can't answer."
 *
 * Both shipped, and one viewport carried all of it at once: enabled pills that
 * DID advance the flow, a second card repeating the same three options greyed
 * out, and a banner saying nobody could answer either. Two of those three
 * statements were false about the same screen at the same second.
 *
 * So the more specific reader wins, and this is that rule — pure, and here
 * rather than inline in the panel because it is the kind of precedence that gets
 * re-derived differently in a second place six months later.
 */
export function loginOwnsScreen(s: {
  sighting: LoginSighting | null
  providerAuth: ProviderAuth | null
}): boolean {
  return s.sighting != null || s.providerAuth != null
}

/* ── the credential ──────────────────────────────────────────────────────── */

/**
 * Is this a well-formed `code#state`? Mirrors `login.rs::validate_code`, and it
 * runs BEFORE the POST so the common mistake — pasting only the code half, or a
 * string the browser broke across lines — is named at the field instead of
 * costing a round trip through a live pty.
 *
 * Returns the reason it is not, or null when it is.
 */
export function loginCodeProblem(raw: string): string | null {
  const code = raw.trim()
  if (!code) return 'Paste the code from the browser page.'
  if (code.length > 512) return 'That is longer than a login code.'
  // Whitespace only — a `-` is perfectly ordinary inside an authorization code,
  // and rejecting it would refuse every valid paste.
  if (/\s/.test(code)) {
    return 'That has a line break or a space in it — paste the whole code#state string, unbroken.'
  }
  if (!code.includes('#')) {
    return 'That looks like only half of it: a login code contains a # joining the code to its state.'
  }
  return null
}

/** What is rendered in place of the code. The field is a credential; nothing on
 *  this surface ever echoes it back, the same way the pty's own field masks it. */
export function maskCode(code: string): string {
  return '•'.repeat(Math.min(code.trim().length, 48))
}

/* ── the other providers ─────────────────────────────────────────────────── */

/**
 * What a NON-Claude provider is blocked on.
 *
 * Deliberately smaller than a `LoginSighting`: supermux does not drive the other
 * providers' device flows — their device-code lifecycles are their own, and a
 * half-automation that gets the expiry or the confirm step wrong is worse than
 * nothing. The contract is an HONEST CARD: name the state, show the link and the
 * one-time code, say what to do, and hand over to the terminal.
 */
export type ProviderAuthKind = 'device_code' | 'api_key' | 'method_picker'

export interface ProviderAuth {
  kind: ProviderAuthKind
  url?: string
  /** The one-time code typed into the browser. Not a credential in the stored
   *  sense — it is meaningless without that browser session — but short-lived,
   *  so it is shown and never kept. */
  code?: string
}

/** `FKDL-XMQP` — a device code row: short, loud, no spaces. */
function looksLikeDeviceCode(line: string): boolean {
  const t = line.trim()
  return (
    t.length >= 6 &&
    t.length <= 16 &&
    /[A-Z0-9]/.test(t) &&
    /^[A-Z0-9-]+$/.test(t)
  )
}

/** Twin of `login.rs::read_provider_auth`, same window rule as `readLogin`. */
export function readProviderAuth(capture: string): ProviderAuth | null {
  const lines = capture ? stripAnsi(capture).split('\n') : []
  const w = windowOf(lines)
  if (!w) return null
  const win = lines.slice(w[0], w[1] + 1)
  const block = win.join('\n')

  if (block.includes('Paste or type your API key')) return { kind: 'api_key' }
  if (block.includes('Enter this one-time code') || block.includes('device code authorization')) {
    const at = win.findIndex((l) => l.includes('Enter this one-time code'))
    const code = at >= 0 ? win.slice(at + 1).find(looksLikeDeviceCode)?.trim() : undefined
    const url = reassembleUrl(win, () => true)
    return { kind: 'device_code', ...(url ? { url } : {}), ...(code ? { code } : {}) }
  }
  if (
    block.includes('Sign in with Device Code') ||
    (block.includes('Sign in with ChatGPT') && block.includes('Provide your own API key'))
  ) {
    return { kind: 'method_picker' }
  }
  return null
}
