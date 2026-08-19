/**
 * The inline TAKE-THE-WHEEL card — the shared browser's human-in-the-loop moment.
 * ─────────────────────────────────────────────────────────────────────────────
 * A granted bot called `request_human_takeover(reason)` on the Shared Browser
 * connector: it hit a login, a 2FA prompt or a CAPTCHA and cannot go further
 * without a person. Instead of the agent asking for a password in chat (which it
 * must never do), ONE card slides into the transcript: tap **Take the wheel**,
 * the agent's live page opens on your phone, you finish the step, and closing
 * the panel hands control straight back — the agent resumes on the page you left
 * it on.
 *
 * It reuses `DialogShell` (from `choice-card.tsx`) so it is visually one family
 * with the question / permission / form / connect cards — same glass, same
 * eyebrow grammar.
 *
 * ## The pause is the lock, not a suggestion
 *
 * Opening the panel connects the takeover socket, which flips the server-side
 * drive lock to HUMAN. Every agent browser tool is refused (409) while it is
 * flipped — including reads and screenshots, so nothing you type into that login
 * form is legible to the agent. Closing the panel releases the lock, which is
 * exactly what wakes the parked agent.
 *
 * ## Why the panel is lazy
 *
 * `TakeoverPanel` carries a canvas renderer, a frame decoder and a WebSocket
 * client. Nothing in that belongs in the chat entry chunk for the 99% of turns
 * that never ask for a takeover, so it is reached only through `React.lazy` —
 * the same treatment as the entity picker and the markdown renderer.
 *
 * No `@/` alias imports in the runtime path (the unit runner resolves the root
 * tsconfig, which has no `paths`) — exactly like `connect-card.tsx`.
 */
import * as React from 'react'

import type { BrowserTakeoverInfo } from '../../../lib/api/sessions'
import type { TakeoverOptions } from '../../../lib/browser/takeover-socket'
import { cn } from '../../../lib/utils'

import { DialogShell } from './choice-card'

/** The heavy half: canvas + socket, only once someone actually takes the wheel. */
const TakeoverPanel = React.lazy(async () => ({
  default: (await import('../../browser/takeover-panel')).TakeoverPanel,
}))

/** The card's answer pills — the SAME geometry as `ChoiceButton`, so the
 *  takeover card sits in one family with the question / permission cards. */
const PILL =
  'inline-flex h-[34px] items-center gap-2 rounded-full border-[0.5px] border-hairline px-[15px] ' +
  'text-[13.4px] tracking-[-0.05px] text-ink sm-t-morph ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** THE AGENT'S OWN SENTENCE, ATTRIBUTED. The reason is written by the bot, not
 *  by supermux, and a card that renders it in its own voice is a surface for
 *  whatever the bot read on a page. Same quoted-evidence treatment the
 *  elicitation card gives an MCP server's message. */
function AgentSays({ who, children }: { who: string; children: string }) {
  return (
    <div className="mt-[9px] border-l-2 border-hairline pl-[11px]">
      <p
        data-testid="chat-takeover-reason"
        className="whitespace-pre-wrap text-[13.4px] leading-[1.45] text-ink"
      >
        {children}
      </p>
      <p className="mt-[3px] text-[11.5px] leading-[1.3] text-ink-3">what {who} says it needs</p>
    </div>
  )
}

export interface TakeoverCardProps {
  /** The ask, straight off the `sessions` SSE delta. */
  ask: BrowserTakeoverInfo
  /** Display name of the bot that asked (falls back to the session slug). */
  botName?: string
  /** Dismiss ("Not now"). */
  onDismiss?: () => void
  /** Test seam: render with the panel already open. */
  defaultOpen?: boolean
  /** Bench seam: a fake takeover socket, so the offline rig can shoot the LIVE
   *  driving overlay instead of its connecting skeleton. Production passes
   *  nothing and the panel opens the real socket. */
  panelOptions?: TakeoverOptions
}

export function TakeoverCard({
  ask,
  botName,
  onDismiss,
  defaultOpen,
  panelOptions,
}: TakeoverCardProps) {
  const [open, setOpen] = React.useState(defaultOpen ?? false)
  const [dismissed, setDismissed] = React.useState(false)
  const who = botName?.trim() || ask.session

  // ESC closes the panel — which IS the hand-back, so it must be as easy to do
  // as it is to start.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (dismissed) return null

  return (
    <>
      <DialogShell
        eyebrow={<span className="text-ink-2">Shared browser</span>}
        question={`${who} needs you to take the wheel`}
        detail={<AgentSays who={who}>{ask.reason}</AgentSays>}
        why="You drive the agent's own page. It can't see or act on it until you hand back."
      >
        <div className="mt-[13px] flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="takeover-open"
            onClick={() => setOpen(true)}
            className={cn(
              PILL,
              // THE primary. A soft fill read as a peer of the outline "Not now"
              // (jury TAKEOVER_CARD): same value, same weight of border, so the
              // eye had to read both to find the action. The inverted
              // bubble-user pair is the app's own monochrome high-contrast fill
              // — no brand colour introduced, and it flips correctly with the
              // theme (near-black on light, near-white on dark).
              'border-transparent bg-bubble-user font-semibold text-bubble-user-ink',
              'shadow-[0_1px_2px_rgba(0,0,0,0.16),0_4px_12px_-6px_rgba(0,0,0,0.35)]',
            )}
          >
            Take the wheel
          </button>
          <button
            type="button"
            onClick={() => {
              setDismissed(true)
              onDismiss?.()
            }}
            className={cn(PILL, 'bg-transparent font-medium text-ink-2 hover:bg-fill-soft')}
          >
            Not now
          </button>
        </div>
      </DialogShell>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Shared browser — ${who}`}
          data-testid="takeover-overlay"
          className="fixed inset-0 z-50 flex flex-col bg-background/95 p-3 text-foreground backdrop-blur-xl"
        >
          {/* APP tokens, not the chat card's `--sm-*` scale: this chrome lives
              OUTSIDE the transcript (a full-screen surface over the whole app),
              where the chat scope's tokens are not in force. */}
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              {/* THE STATE, AS A CONTROL — not a caption. Who is driving is the
                  one thing this surface may never leave ambiguous, so it is a
                  designed pill (live dot + tinted container), the same grammar
                  the panel's own mode badge uses. */}
              <div
                data-testid="takeover-driving-pill"
                className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11.5px] font-semibold uppercase tracking-[0.4px] text-foreground ring-1 ring-inset ring-border"
              >
                <span
                  aria-hidden
                  className="size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
                />
                You are driving
              </div>
              <div className="mt-1 truncate text-[13px] text-muted-foreground">{ask.reason}</div>
              {/* THE BOUNDARY, RESTATED WHERE IT MATTERS. The card promised the
                  agent cannot watch; this is the screen the human types a
                  password into, so the promise is repeated here rather than
                  left three scrolls up the transcript. */}
              <div
                data-testid="takeover-trust-line"
                className="mt-0.5 truncate text-[12px] text-muted-foreground"
              >
                {who} can’t see this page while you drive.
              </div>
            </div>
            <button
              type="button"
              data-testid="takeover-handback"
              onClick={() => setOpen(false)}
              className={cn(
                'inline-flex h-9 shrink-0 items-center rounded-full bg-primary px-4',
                'text-[13px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              Hand back
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-border shadow-[var(--sm-card-shadow)]">
            <React.Suspense
              fallback={
                <div className="grid h-full place-items-center text-[13px] text-muted-foreground">
                  Opening the agent’s browser…
                </div>
              }
            >
              {/* `embedded`: the overlay owns the driving state AND the single
                  hand-back. Without it the panel drew its own mode badge and a
                  ghost "Take over" beside our "Hand back" — two controls for one
                  state (jury TAKEOVER_PANEL #2). */}
              <TakeoverPanel
                session={ask.session}
                options={panelOptions}
                embedded
                className="h-full"
              />
            </React.Suspense>
          </div>
        </div>
      ) : null}
    </>
  )
}
