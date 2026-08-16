// The chat preview for an overview tile (fase A5 T5).
//
// §2.5's ZERO-NEW-REQUESTS rule is the whole design constraint: the only data
// source is the `chat_tail` field already riding the `sessions` SSE delta
// (`server/src/sessions/auto_actions.rs`'s `ChatTailGate` — change-gated, 1 s
// debounced, ≤200 chars per side). No tile may open a chat subscription, ever.
// Grep rule: `session-tile/**` contains no `useChatTail`, no `peekAnsi`, no
// `/chat` fetch.
//
// ABSENT ≠ EMPTY. `applyDelta` (`hooks/use-sessions.ts`) merges the delta
// key-by-key, so a delta WITHOUT `chat_tail` leaves the previous value in
// place. `undefined` therefore means "keep showing what you were showing", and
// is handled by the CALLER choosing `<TailPreview>` — never by this component
// rendering a blank box. The empty STRING is different and real: `user`/`agent`
// are `''` when the ring has not seen one yet (a resumed conversation seeded
// mid-turn), and that renders as one line rather than a hole.
//
// The geometry is `TailPreview`'s: this fills the same slot the tile's animated
// height container gives it, so tile heights are byte-identical at every
// density tier (asserted in `chat-tail-preview.test.tsx`).

// Relative, not `@/`: this module is rendered by `bun test`
// (`tests/unit/chat-tail-preview.test.tsx`), whose resolver reads the root
// tsconfig.json — which carries no `paths`. Same rule as the chat components.
import { cn } from '../../lib/utils'
import type { ChatTail } from '../../lib/api/sessions'

export interface ChatTailPreviewProps {
  tail: ChatTail
  /** Fill the parent height (the tile's animated preview container), exactly as
   *  `TailPreview`'s `fill` does. */
  fill?: boolean
  className?: string
}

/**
 * Two lines in the tile's own type scale: the last prompt in the P1 voice
 * (ink-2) over the last assistant line in the P2 voice (ink-3).
 *
 * Bottom-anchored and top-masked like the terminal tail it replaces, so the two
 * previews read as the same slot showing a different thing — which is exactly
 * what A5 changes about the overview, and all it changes (unread dots,
 * attention tiers, the rollup facepile and the fact ladder are B2).
 */
export function ChatTailPreview({ tail, fill, className }: ChatTailPreviewProps) {
  const user = tail.user.trim()
  const agent = tail.agent.trim()
  // Both empty is a legitimate state (a chat store that exists but has seen
  // nothing yet). One calm line beats an empty box with a mask on it.
  const empty = !user && !agent

  return (
    <div
      data-testid="chat-tail-preview"
      aria-hidden
      className={cn(
        'relative overflow-hidden px-3',
        fill && 'h-full',
        className,
      )}
      style={{
        // The same top fade the ANSI tail carries, so swapping the preview does
        // not swap the tile's edge treatment too.
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 24px)',
        maskImage: 'linear-gradient(to bottom, transparent 0, black 24px)',
      }}
    >
      <div className="absolute inset-x-3 bottom-2 flex flex-col justify-end gap-[3px]">
        {empty ? (
          <p className="m-0 truncate text-[11px] leading-[15px] text-ink-3">
            No messages yet
          </p>
        ) : (
          <>
            {user && (
              <p
                data-testid="chat-tail-user"
                className="m-0 truncate text-[11.5px] font-medium leading-[15px] text-ink-2"
              >
                {user}
              </p>
            )}
            {agent && (
              <p
                data-testid="chat-tail-agent"
                className="m-0 truncate text-[11px] leading-[15px] text-ink-3"
              >
                {agent}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
