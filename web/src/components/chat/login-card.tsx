/**
 * The sign-in card — the one needs-input state that could not be answered here.
 * ─────────────────────────────────────────────────────────────────────────────
 * `/login` is pty-only. Before this card, a session that hit an expired
 * credential parked on `Paste code here if prompted > ` and the only way through
 * it was to open the terminal view and hand-type an OAuth code into a masked
 * field — from a phone, with no keyboard shortcuts, into a field where the
 * single character `c` silently clears everything you have typed. That is the
 * gap this closes.
 *
 * WHAT THE CARD IS RESPONSIBLE FOR, and what it refuses to do:
 *
 * · It shows the URL as a real, tappable link (`target=_blank`,
 *   `rel="noopener noreferrer"`) and offers a copy button for the device that
 *   is not the one you will sign in on. The URL is reassembled from the VT grid
 *   by `login-lens.ts`; if the reassembly produced nothing the card SAYS so and
 *   points at the terminal, rather than rendering a dead link.
 * · It takes the `code#state` string in a `type="password"` field, checks its
 *   shape locally (`loginCodeProblem`) so the common half-paste is named at the
 *   field instead of after a round trip through a live pty, and POSTs it.
 * · IT NEVER ECHOES THE CODE. Not in the field (masked), not in a confirmation,
 *   not in an error. The pty's own field masks it and so does this one; the
 *   server never stores it either (`login.rs`).
 * · It shows `Login successful` as a state that still NEEDS A PRESS, because it
 *   does: that Enter is what writes `hasCompletedOnboarding`, and a card that
 *   celebrated and stopped would leave every later session on the host booting
 *   into the first-run wizard with perfectly valid credentials.
 * · It never re-sends the prompt whose turn died. Claude Code retries that turn
 *   itself once the credential lands; a second copy runs the work twice.
 *
 * QR CODE — deliberately not here, and the reason is written down rather than
 * left as a gap: a hand-rolled encoder for a ~370-character URL is a few hundred
 * lines of Reed-Solomon and mask evaluation that nothing in this environment can
 * verify actually decodes, and an unverifiable QR on a credential flow is worse
 * than no QR (it looks authoritative and sends you nowhere). The link is
 * tappable on the device the user is already holding, and Copy covers the
 * hand-off to another one.
 *
 * Import rules, inherited from `chat-surface.tsx`: relative paths only (this
 * module is rendered by `bun test`), and `components/chat/ui` is imported from
 * here, never the reverse.
 */
import * as React from 'react'

import { cn } from '../../lib/utils'

import { loginCodeProblem, type LoginSighting, type ProviderAuth } from './login-lens'

export interface LoginCardProps {
  /** The current reading, or null when no login is on screen. */
  sighting: LoginSighting | null
  /** Is supervision frozen? Shown as the reassurance it is: nothing else is
   *  going to touch this session while you are off in a browser. */
  frozen?: boolean
  /** A request is in flight. */
  busy?: boolean
  /** The last failure from the server, verbatim. */
  error?: string | null
  /** Submit `code#state`. `retry` is true when the field was used before, which
   *  is what tells the server to clear it first (see `login::submit_code`). */
  onSubmitCode: (code: string, retry: boolean) => void
  /** Answer `Select login method:` with a row index. */
  onChooseMethod?: (index: number) => void
  /** The mandatory Enter on `Login successful`. */
  onConfirm?: () => void
  /** Abandon the flow (Esc + release the freeze). */
  onCancel?: () => void
  /** The way out that always works. */
  onOpenTerminal?: () => void
  surface?: 'phone' | 'desktop'
}

const CARD =
  'rounded-2xl border border-[var(--sm-hairline)] bg-[var(--sm-surface)] p-[14px_17px] shadow-[var(--sm-card-shadow)]'
const BTN =
  'inline-flex h-[34px] items-center rounded-full border border-[var(--sm-hairline)] px-[15px] text-[13.4px] font-medium disabled:opacity-45'

function Title({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[15px] font-medium leading-[1.4] tracking-[-0.15px] text-ink-0">
      {children}
    </h3>
  )
}

function Why({ children }: { children: React.ReactNode }) {
  return <p className="mt-[5px] text-[13.2px] leading-[1.45] text-ink-2">{children}</p>
}

/** The URL row: the link itself, and the copy that covers the second device. */
function UrlRow({ url, onOpenTerminal }: { url?: string; onOpenTerminal?: () => void }) {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [copied])

  // NO LINK IS AN HONEST STATE. The URL is scraped off a VT grid that hard-wraps
  // it; a capture that arrived mid-redraw, or a Claude Code that changed the
  // block, yields nothing — and a card that renders `href=""` looks like a
  // working button that goes nowhere.
  if (!url) {
    return (
      <Why>
        The sign-in link has not appeared on the screen yet. If it does not, open
        the{' '}
        <button type="button" className="underline" onClick={onOpenTerminal}>
          terminal
        </button>{' '}
        — the link is there.
      </Why>
    )
  }

  return (
    <div className="mt-[10px] flex flex-wrap items-center gap-[8px]">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(BTN, 'font-semibold bg-[var(--sm-fill-soft)]')}
        data-testid="login-open-link"
      >
        Open the sign-in page
      </a>
      <button
        type="button"
        className={BTN}
        data-testid="login-copy-link"
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }}
      >
        {copied ? 'Copied' : 'Copy link'}
      </button>
      {/* The whole URL, selectable, for the case where neither of the two
          controls above can work — a locked-down browser, a copy permission
          the user declined. It wraps rather than truncating: a URL you can
          only see half of is not a fallback. */}
      <code className="w-full break-all rounded-lg bg-[var(--sm-fill-soft)] px-[7px] py-[4px] font-mono text-[11.5px] text-ink-2">
        {url}
      </code>
    </div>
  )
}

/** The code field. `type=password` so the browser masks it, `autoComplete=off`
 *  so no manager offers to remember a single-use credential. */
function CodeField({
  busy,
  retry,
  serverError,
  onSubmit,
}: {
  busy?: boolean
  retry: boolean
  serverError?: string | null
  onSubmit: (code: string, retry: boolean) => void
}) {
  const [value, setValue] = React.useState('')
  const [problem, setProblem] = React.useState<string | null>(null)
  const id = React.useId()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const p = loginCodeProblem(value)
    setProblem(p)
    if (p) return
    onSubmit(value.trim(), retry)
    // Dropped the moment it is handed over. The component never keeps a
    // credential around for a re-render to put back on the screen.
    setValue('')
  }

  return (
    <form className="mt-[12px]" onSubmit={submit}>
      <label htmlFor={id} className="block text-[12.5px] text-ink-2">
        Paste the code from that page
      </label>
      <div className="mt-[6px] flex flex-wrap items-center gap-[8px]">
        <input
          id={id}
          type="password"
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={value}
          data-testid="login-code"
          placeholder="code#state"
          onChange={(e) => {
            setValue(e.target.value)
            if (problem) setProblem(null)
          }}
          className="min-w-[200px] flex-1 rounded-lg border border-[var(--sm-hairline)] bg-[var(--sm-fill-soft)] px-[10px] py-[7px] font-mono text-[13px] text-ink-0"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          data-testid="login-submit"
          className={cn(BTN, 'font-semibold bg-[var(--sm-fill-soft)]')}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
      {(problem || serverError) && (
        <p role="alert" className="mt-[7px] text-[12.5px] text-[var(--status-error,#c0392b)]">
          {problem ?? serverError}
        </p>
      )}
    </form>
  )
}

/**
 * The HONEST CARD for a non-Claude provider (AREA 3, item 3).
 *
 * supermux does not drive the other providers' device flows: their device-code
 * lifecycles, expiry windows and confirm steps are their own, and a
 * half-automation that gets one of them wrong burns a code the user then has to
 * chase. What it CAN do is stop the session reading as an idle green dot while
 * it sits on a sign-in screen — name the state, put the link and the one-time
 * code where a thumb can reach them, and hand over to the terminal for the rest.
 *
 * Deliberately no input of any kind. `Paste or type your API key` is a SECRET
 * field, and offering a web input for it here would put a long-lived API key
 * through a path this feature has not designed the storage rules for.
 */
export function ProviderAuthCard({
  auth,
  onOpenTerminal,
  surface = 'desktop',
}: {
  auth: ProviderAuth | null
  onOpenTerminal?: () => void
  surface?: 'phone' | 'desktop'
}): React.ReactElement | null {
  if (!auth) return null
  return (
    <section
      className={cn(CARD, surface === 'phone' ? 'mx-0' : 'ml-[44px] max-w-[592px]')}
      data-testid="provider-auth-card"
      data-kind={auth.kind}
      aria-label="Provider sign-in"
    >
      <Title>
        {auth.kind === 'api_key' ? 'This session wants an API key' : 'This session is signing in'}
      </Title>
      <Why>
        {auth.kind === 'device_code'
          ? 'Open the link, enter the code below, then come back — the terminal finishes on its own.'
          : auth.kind === 'api_key'
            ? 'It is asking for a key in a masked field. Keys are typed in the terminal, not here.'
            : 'It is asking how to sign in. Pick a method in the terminal.'}
      </Why>
      {auth.url && (
        <div className="mt-[10px]">
          <a
            href={auth.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(BTN, 'font-semibold bg-[var(--sm-fill-soft)]')}
            data-testid="provider-auth-link"
          >
            Open the sign-in page
          </a>
        </div>
      )}
      {auth.code && (
        <p className="mt-[10px] select-all font-mono text-[19px] tracking-[2px] text-ink-0">
          {auth.code}
        </p>
      )}
      <div className="mt-[13px]">
        <button type="button" className={BTN} onClick={onOpenTerminal}>
          Open terminal
        </button>
      </div>
    </section>
  )
}

export function LoginCard({
  sighting,
  frozen,
  busy,
  error,
  onSubmitCode,
  onChooseMethod,
  onConfirm,
  onCancel,
  onOpenTerminal,
  surface = 'desktop',
}: LoginCardProps): React.ReactElement | null {
  if (!sighting) return null
  const design = sighting.flow === 'design'
  const noun = design ? 'design-system access' : 'your Claude account'

  return (
    <section
      className={cn(CARD, surface === 'phone' ? 'mx-0' : 'ml-[44px] max-w-[592px]')}
      data-testid="login-card"
      data-stage={sighting.stage}
      data-flow={sighting.flow}
      aria-label={design ? 'Design-system sign-in' : 'Claude sign-in'}
    >
      {sighting.stage === 'method_select' && (
        <>
          <Title>Which account?</Title>
          <Why>Claude Code is asking how to sign in.</Why>
          <div className="mt-[13px] flex flex-wrap gap-[8px]">
            {sighting.options.map((label, i) => (
              <button
                key={label}
                type="button"
                className={cn(BTN, i === 0 && 'font-semibold bg-[var(--sm-fill-soft)]')}
                disabled={busy}
                onClick={() => onChooseMethod?.(i)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {(sighting.stage === 'paste_prompt' || sighting.stage === 'invalid') && (
        <>
          <Title>{design ? 'Authorise design access' : 'Sign in to Claude'}</Title>
          <Why>
            Open the page below, sign in, and paste the code it gives you back
            here. It signs in to {noun}.
          </Why>
          <UrlRow url={sighting.url} onOpenTerminal={onOpenTerminal} />
          {/* The CLI's own rejection line, verbatim — and the field stays put.
              A retry must never restart anything: the PKCE verifier that makes
              this code valid exists only inside the process that is waiting. */}
          {sighting.stage === 'invalid' && (
            <p role="alert" className="mt-[10px] text-[12.5px] text-[var(--status-error,#c0392b)]">
              {sighting.message ?? 'That code was not accepted.'} Try pasting the
              whole string again — the part after the <code>#</code> included.
            </p>
          )}
          <CodeField
            busy={busy}
            retry={sighting.stage === 'invalid'}
            serverError={error}
            onSubmit={onSubmitCode}
          />
        </>
      )}

      {sighting.stage === 'success' && (
        <>
          <Title>Signed in{sighting.email ? ` as ${sighting.email}` : ''}</Title>
          {/* NOT a formality. This press is what writes the onboarding flags;
              without it every later session on this host boots into the
              first-run wizard holding valid credentials. */}
          <Why>One more press to finish — Claude Code is waiting on it.</Why>
          <div className="mt-[13px] flex gap-[8px]">
            <button
              type="button"
              disabled={busy}
              data-testid="login-confirm"
              className={cn(BTN, 'font-semibold bg-[var(--sm-fill-soft)]')}
              onClick={onConfirm}
            >
              Finish
            </button>
          </div>
        </>
      )}

      {sighting.stage === 'error' && (
        <>
          <Title>Sign-in failed</Title>
          <Why>{sighting.message ?? 'Claude Code reported an error.'}</Why>
          <div className="mt-[13px] flex gap-[8px]">
            <button type="button" className={BTN} disabled={busy} onClick={onCancel}>
              Stop trying
            </button>
            <button type="button" className={BTN} onClick={onOpenTerminal}>
              Open terminal
            </button>
          </div>
        </>
      )}

      <footer className="mt-[12px] flex items-center justify-between gap-[8px] text-[11.8px] text-ink-2">
        {/* The freeze, said out loud. It is the reason the user can walk to
            another device without the session being restarted under them, and
            it is also why a schedule that was due will report a refusal. */}
        <span>{frozen ? 'Nothing else will write to this session until you finish.' : ''}</span>
        {sighting.stage !== 'success' && onCancel && (
          <button type="button" className="underline" onClick={onCancel} data-testid="login-cancel">
            Cancel
          </button>
        )}
      </footer>
    </section>
  )
}
