// focus-mode/last-send-recall.tsx — the "what did I just type?" recall surface.
//
// One feature cluster, three rendered shapes, glued by a tiny shared content
// piece so layout + a11y are identical across desktop and mobile:
//
//   • LastSendButton   — Lucide Quote icon, slots into BOTH focus headers.
//                        Hidden when the session has no last send.
//   • LastSendBar      — desktop-only glass strip directly under the header.
//                        Auto-shows on session mount with a non-empty last send,
//                        fades on first terminal keypress / scroll / click /
//                        8s timeout / explicit × press. Tap the bar (anywhere
//                        but the ×) → open the popover.
//   • LastSendPopover  — desktop Radix popover anchored to the icon. Shared
//                        content (heading + body + Copy).
//   • LastSendSheet    — mobile Vaul bottom sheet equivalent.
//
// SOURCE OF TRUTH. The session row (`ApiSession`) already carries
// `last_send_text` + `last_send_at` (server SessionView fields). No new fetch
// or hook; consumers read straight off the row. `useLastSend` is a thin shape
// helper that returns a typed view for the components.
//
// SCOPE. The full design lives in
// `docs/superpowers/specs/2026-06-04-last-user-prompt-design.md`. This module
// implements §4 (UX) and §6 (frontend) of that spec.

import * as React from 'react'
import { Drawer } from 'vaul'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  Bot,
  ChevronRight,
  Clipboard,
  History,
  Loader2,
  MessageSquareText,
  Search,
  X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import {
  displayLabel,
  sessionsApi,
  type ApiSession,
  type RecallEntry,
  type RecallResponse,
  type RecallScope,
} from '@/lib/api'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Stable shape: either both fields are present (real last send) or both null
 *  (no submission yet). The server pairs them; we mirror that contract on the
 *  read side so consumers don't have to defend against half-present pairs. */
export interface LastSend {
  text: string
  sentAt: Date
}

/** Read the last-send pair off a session row, returning `null` when there is
 *  no submission. Memoised on the two relevant fields so consumers don't
 *  rerender on unrelated session updates. */
export function useLastSend(
  session: Pick<ApiSession, 'last_send_text' | 'last_send_at'> | undefined,
): LastSend | null {
  return React.useMemo(() => {
    const text = session?.last_send_text
    const at = session?.last_send_at
    if (!text || !at) return null
    return { text, sentAt: new Date(at * 1000) }
  }, [session?.last_send_text, session?.last_send_at])
}

const ONE_SEC = 1_000
const ONE_MIN = 60 * ONE_SEC
const ONE_HOUR = 60 * ONE_MIN
const ONE_DAY = 24 * ONE_HOUR

/** Compact relative-time formatter for the recall headings ("2m ago" / "3h ago").
 *  We deliberately don't use `Intl.RelativeTimeFormat` here — the recall heading
 *  has very little horizontal real-estate and the dynamic strings ("in 2 minutes",
 *  "vorige week") wouldn't fit. */
export function formatRecallTime(sentAt: Date, now: Date = new Date()): string {
  const diff = Math.max(0, now.getTime() - sentAt.getTime())
  if (diff < 30 * ONE_SEC) return 'just now'
  if (diff < ONE_MIN) return `${Math.round(diff / ONE_SEC)}s ago`
  if (diff < ONE_HOUR) return `${Math.round(diff / ONE_MIN)}m ago`
  if (diff < ONE_DAY) return `${Math.round(diff / ONE_HOUR)}h ago`
  return `${Math.round(diff / ONE_DAY)}d ago`
}

/** Debounce a fast-changing value (search box) into a slow one. 150 ms keeps
 *  the popover responsive without firing a fetch on every keystroke. */
function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return debounced
}

// ── data hook ────────────────────────────────────────────────────────────────

const RECALL_PAGE_SIZE = 20

/** Cursor-paginated recall fetch. Re-fetches when any of the inputs change
 *  (TanStack keys handle that). Sessions are *not* re-fetched on window focus
 *  — the user is in the popover and shouldn't see flicker. */
function useRecall(
  sessionName: string,
  scope: RecallScope,
  q: string,
  includeSidechains: boolean,
  enabled: boolean,
) {
  return useInfiniteQuery<RecallResponse, Error>({
    queryKey: ['session-recall', sessionName, scope, q, includeSidechains],
    queryFn: ({ pageParam }) =>
      sessionsApi.recall(sessionName, {
        scope,
        q: q || undefined,
        includeSidechains,
        before: pageParam as string | undefined,
        limit: RECALL_PAGE_SIZE,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextBefore : undefined),
    enabled: enabled && !!sessionName,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  })
}

// ── shared content (used by both Popover and Sheet) ──────────────────────────

/** The rich panel rendered inside both popover (desktop) and sheet (mobile).
 *  One source of truth so the affordances are identical on both surfaces. */
function RecallPanel({
  sessionName,
  sessionLabel,
  initialRecall,
  variant,
}: {
  sessionName: string
  sessionLabel: string
  /** The session row's current `last_send` — used to show *something* on the
   *  very first render before the fetch resolves, so the popover never opens
   *  to an empty state when the user just sent a prompt. */
  initialRecall: LastSend
  /** `popover` caps height at the desktop popover bound; `sheet` lets the
   *  mobile drawer drive its own height. */
  variant: 'popover' | 'sheet'
}) {
  const [scope, setScope] = React.useState<RecallScope>('session')
  const [searchInput, setSearchInput] = React.useState('')
  const search = useDebouncedValue(searchInput, 150)
  const [includeSidechains, setIncludeSidechains] = React.useState(false)
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())

  const recall = useRecall(sessionName, scope, search, includeSidechains, true)
  const entries = React.useMemo<RecallEntry[]>(
    () => recall.data?.pages.flatMap((p) => p.entries) ?? [],
    [recall.data],
  )

  // Auto-expand the topmost entry exactly ONCE per uuid lifetime. Tracked in
  // a ref (not state) so the auto-expand never re-fires when the same uuid
  // returns to the top after a search clear / scope flip / stale refetch —
  // that would silently undo the user's explicit collapse.
  const autoExpandedRef = React.useRef<Set<string>>(new Set())
  const firstUuid = entries[0]?.uuid
  React.useEffect(() => {
    if (!firstUuid || autoExpandedRef.current.has(firstUuid)) return
    autoExpandedRef.current.add(firstUuid)
    setExpanded((prev) => {
      const next = new Set(prev)
      next.add(firstUuid)
      return next
    })
  }, [firstUuid])

  // Drop both Sets when the query identity changes (scope / search /
  // sub-agent toggle) — fresh page, fresh expansion model. Without this the
  // expanded Set would accumulate stale uuids across filters.
  React.useEffect(() => {
    autoExpandedRef.current = new Set()
    setExpanded(new Set())
  }, [sessionName, scope, search, includeSidechains])

  const toggleExpanded = React.useCallback((uuid: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(uuid)) next.delete(uuid)
      else next.add(uuid)
      return next
    })
  }, [])

  // Group consecutive entries from the same Claude session UUID (only matters
  // in Project scope; in Session scope every entry shares one sessionId).
  const groups = React.useMemo(() => groupBySession(entries), [entries])

  // Loading placeholder for the very first page render — falls back to the
  // session-row's `last_send` so the popover never *looks* empty during the
  // ~50ms first fetch.
  //
  // Gate on `!recall.data` (first mount, no page ever loaded), NOT on
  // `isLoading`. Without that distinction a scope flip or sub-agent toggle
  // makes `isLoading` true again with `entries === []` and the session-scope
  // seed flashes inside a Project-scope / filtered view. Combined with the
  // scope/search guard this is now belt + suspenders.
  const isFirstMount = !recall.data && entries.length === 0
  const showSeed =
    isFirstMount && scope === 'session' && !search && !includeSidechains
  const fallbackEntries: RecallEntry[] = React.useMemo(
    () =>
      showSeed
        ? [
            {
              uuid: `__seed-${initialRecall.sentAt.getTime()}`,
              ts: Math.floor(initialRecall.sentAt.getTime() / 1000),
              sessionId: sessionName,
              text: initialRecall.text,
              sidechain: false,
            },
          ]
        : [],
    [showSeed, initialRecall, sessionName],
  )
  const displayGroups =
    fallbackEntries.length > 0 ? groupBySession(fallbackEntries) : groups

  const scrollClass =
    variant === 'popover'
      ? 'max-h-[420px] overflow-y-auto'
      : 'flex-1 overflow-y-auto'

  return (
    <div className="flex w-full flex-col gap-2.5">
      {/* Tabs row — Session is the default; Project widens to the cwd. */}
      <Tabs
        value={scope}
        onValueChange={(v) => setScope(v as RecallScope)}
      >
        <TabsList className="h-8 w-full">
          <TabsTrigger value="session" className="flex-1 text-[12px]">
            This session
          </TabsTrigger>
          <TabsTrigger value="project" className="flex-1 text-[12px]">
            Project
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Search row */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search your prompts…"
          aria-label="Search prompts"
          className="h-8 w-full rounded-md border border-input bg-transparent pl-8 pr-2 text-[12.5px] shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {/* Entries list */}
      <div className={cn(scrollClass, '-mx-1 px-1')}>
        {recall.isError && (
          <div className="px-1 py-6 text-center text-[12px] text-muted-foreground">
            Couldn’t load history.
          </div>
        )}
        {!recall.isError && entries.length === 0 && !isFirstMount && (
          <div className="px-1 py-6 text-center text-[12px] text-muted-foreground">
            {search ? `No matches for “${search}”.` : 'No prompts yet.'}
          </div>
        )}
        <ul className="flex flex-col gap-1.5">
          {displayGroups.map((group, gi) => (
            <li key={`g-${gi}-${group.sessionId}`}>
              {scope === 'project' && group.sessionId !== sessionName && (
                <div className="flex items-center gap-1.5 px-1 pb-1 pt-2 text-[10.5px] uppercase tracking-wide text-muted-foreground/70">
                  <MessageSquareText className="size-3" />
                  <span className="truncate">
                    {group.sessionTitle || group.sessionId.slice(0, 8)}
                  </span>
                </div>
              )}
              <ul className="flex flex-col gap-1">
                {group.entries.map((entry, ei) => (
                  <RecallRow
                    key={entry.uuid}
                    entry={entry}
                    expanded={expanded.has(entry.uuid)}
                    // Stable callback (useCallback above) so React.memo on
                    // RecallRow actually short-circuits re-renders when a
                    // sibling row toggles its own expand state.
                    onToggle={toggleExpanded}
                    // Stagger the very first page render only — subsequent pages
                    // append seamlessly without re-animating earlier rows.
                    delay={recall.data ? Math.min(ei * 0.02, 0.18) : 0}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>

      {/* Footer: load-more + sub-agents toggle + label */}
      <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-2 text-[11px] text-muted-foreground">
        <button
          type="button"
          onClick={() => recall.fetchNextPage()}
          disabled={!recall.hasNextPage || recall.isFetchingNextPage}
          className={cn(
            'flex h-7 items-center gap-1 rounded-md px-2 transition-colors',
            'hover:bg-secondary hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:opacity-40',
          )}
        >
          {recall.isFetchingNextPage && (
            <Loader2 className="size-3 animate-spin" />
          )}
          {recall.hasNextPage
            ? `Load ${RECALL_PAGE_SIZE} more`
            : 'End of history'}
        </button>
        <label className="flex cursor-pointer items-center gap-1.5 select-none">
          <input
            type="checkbox"
            checked={includeSidechains}
            onChange={(e) => setIncludeSidechains(e.target.checked)}
            className="size-3 cursor-pointer accent-foreground"
          />
          <Bot className="size-3" />
          <span>Sub-agents</span>
        </label>
      </div>

      {/* Session label as a calm subscript — same affordance the old
          single-prompt body had so the user knows which session is in view. */}
      <p className="text-[10.5px] text-muted-foreground/60">{sessionLabel}</p>
    </div>
  )
}

interface RecallGroup {
  sessionId: string
  sessionTitle?: string
  entries: RecallEntry[]
}

function groupBySession(entries: RecallEntry[]): RecallGroup[] {
  const groups: RecallGroup[] = []
  for (const e of entries) {
    const last = groups[groups.length - 1]
    if (last && last.sessionId === e.sessionId) {
      last.entries.push(e)
    } else {
      groups.push({
        sessionId: e.sessionId,
        sessionTitle: e.sessionTitle,
        entries: [e],
      })
    }
  }
  return groups
}

/** Server cap for the prompt body. Mirrored from `PROMPT_MAX_CHARS` in
 *  `server/src/sessions/recall.rs` so we can show a "preview" hint when text
 *  hit the wire-side clamp. Single literal across two languages is acceptable
 *  here — drift would surface immediately (hint never / always shows). */
const RECALL_PROMPT_MAX_CHARS = 8000

interface RecallRowProps {
  entry: RecallEntry
  expanded: boolean
  onToggle: (uuid: string) => void
  delay: number
}

const RecallRow = React.memo(function RecallRow({
  entry,
  expanded,
  onToggle,
  delay,
}: RecallRowProps) {
  const reduceMotion = useReducedMotion()
  const [copied, setCopied] = React.useState(false)
  const copyTimer = React.useRef<number | null>(null)
  const onCopy = React.useCallback(
    async (e: React.MouseEvent | React.KeyboardEvent) => {
      e.stopPropagation()
      try {
        await navigator.clipboard.writeText(entry.text)
        setCopied(true)
        if (copyTimer.current) window.clearTimeout(copyTimer.current)
        copyTimer.current = window.setTimeout(() => setCopied(false), 1_400)
      } catch {
        // Clipboard can fail under permission-denied / non-secure contexts.
        // No error surface; the prompt body is still selectable.
      }
    },
    [entry.text],
  )
  React.useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  const handleToggle = React.useCallback(
    () => onToggle(entry.uuid),
    [onToggle, entry.uuid],
  )

  const truncated = entry.text.length >= RECALL_PROMPT_MAX_CHARS
  const initial = reduceMotion ? false : { opacity: 0, y: 4 }
  const animate = { opacity: 1, y: 0 }
  const transition = reduceMotion
    ? { duration: 0 }
    : { ...springs.smooth, delay }

  // Two real, sibling buttons (toggle + copy) inside a non-interactive row
  // wrapper. Avoids the button-in-button HTML the previous version had, and
  // gives both actions native keyboard / focus-visible behavior.
  return (
    <motion.li
      initial={initial}
      animate={animate}
      transition={transition}
      className="rounded-md border border-border/40 bg-card/30 px-2 py-1.5 hover:border-border/70"
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse prompt' : 'Expand prompt'}
          className="mt-0.5 flex shrink-0 cursor-pointer rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <motion.span
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={reduceMotion ? { duration: 0 } : springs.buttonPress}
            aria-hidden
            className="inline-flex"
          >
            <ChevronRight className="size-3.5" />
          </motion.span>
        </button>
        {/* Body is a div, not a button: it's a visual click target for sighted
            users (sit next to a real button it duplicates), but the chevron
            button is the canonical, screen-reader-announced toggle. Keeping
            this as a div avoids the previous nested-button HTML. */}
        <div
          onClick={handleToggle}
          className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-none"
        >
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="font-medium text-foreground/90">You</span>
              <span>·</span>
              <span>{formatRecallTime(new Date(entry.ts * 1000))}</span>
              {entry.sidechain && (
                <span
                  className="flex items-center gap-0.5 rounded bg-secondary px-1 py-px text-[9.5px] uppercase tracking-wide text-muted-foreground"
                  title="Sub-agent turn"
                >
                  <Bot className="size-2.5" />
                  agent
                </span>
              )}
            </span>
          </div>
          <p
            className={cn(
              'whitespace-pre-wrap break-words text-[12.5px] leading-snug text-foreground',
              expanded ? '' : 'line-clamp-3',
            )}
          >
            {entry.text}
          </p>
          {entry.reply && (
            // No AnimatePresence + key here: the previous shape forced a
            // full unmount/remount on every toggle of `expanded` and made
            // the reply visibly flash. The line-clamp class flips
            // instantly; that IS the desired interaction.
            <p
              className={cn(
                'mt-1 flex gap-1 whitespace-pre-wrap break-words text-[11.5px] leading-snug text-muted-foreground',
                expanded ? '' : 'line-clamp-1',
              )}
            >
              <span aria-hidden className="shrink-0">
                ↳
              </span>
              <span className="min-w-0">{entry.reply}</span>
            </p>
          )}
          {truncated && expanded && (
            <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
              preview · {RECALL_PROMPT_MAX_CHARS} chars max
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onCopy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              void onCopy(e)
            }
          }}
          aria-label={copied ? 'Prompt copied' : 'Copy prompt'}
          className={cn(
            'flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 text-muted-foreground transition-colors',
            'hover:bg-secondary hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <Clipboard className="size-3" />
          <span className="text-[10px]">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
    </motion.li>
  )
})

// ── LastSendButton (used in both headers) ────────────────────────────────────

export interface LastSendButtonProps {
  /** Toggled by the parent — the parent owns the popover/sheet open state so
   *  the bar (desktop) and the keyboard shortcut can drive it too. */
  onToggle: () => void
  /** Whether the recall surface is currently open (for `aria-expanded`). */
  open: boolean
  /** Forwarded to the button so the desktop popover can anchor here. */
  buttonRef?: React.Ref<HTMLButtonElement>
  /** Shortcut hint shown in the tooltip (desktop only; pass `undefined` on
   *  mobile to drop the suffix). */
  shortcutHint?: string
}

export function LastSendButton({
  onToggle,
  open,
  buttonRef,
  shortcutHint,
}: LastSendButtonProps) {
  const label = shortcutHint
    ? `Show prompt history (${shortcutHint})`
    : 'Show prompt history'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          ref={buttonRef}
          type="button"
          onClick={onToggle}
          whileTap={{ scale: 0.96 }}
          transition={springs.buttonPress}
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-foreground/80 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <History className="size-4" />
        </motion.button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// ── LastSendPopover (desktop) ────────────────────────────────────────────────

export interface LastSendPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  recall: LastSend
  session: Pick<ApiSession, 'name' | 'display_name'>
  /** The icon button — anchor for the popover. */
  anchorRef: React.RefObject<HTMLElement | null>
}

export function LastSendPopover({
  open,
  onOpenChange,
  recall,
  session,
  anchorRef,
}: LastSendPopoverProps) {
  // Radix Popover is anchored via `<PopoverTrigger>`; we use the anchor-only API
  // by rendering an invisible trigger that mirrors the icon button's geometry,
  // so the popover lands at the icon without us needing to embed it INSIDE the
  // header (which would couple the header to the popover state).
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <span
          // Position the invisible trigger over the real button via the anchorRef.
          // The popover content positions itself relative to this trigger.
          ref={(el) => {
            // Mirror the anchor's bounding box. Cheap (one ref read per render);
            // refreshed on open by Radix's collision logic.
            if (el && anchorRef.current) {
              const r = anchorRef.current.getBoundingClientRect()
              el.style.position = 'fixed'
              el.style.left = `${r.left}px`
              el.style.top = `${r.top}px`
              el.style.width = `${r.width}px`
              el.style.height = `${r.height}px`
              el.style.pointerEvents = 'none'
            }
          }}
          aria-hidden
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="glass w-[420px] max-w-[calc(100vw-1rem)] rounded-xl border border-border/60 p-3"
        role="dialog"
        aria-label="Prompt history"
      >
        <RecallPanel
          sessionName={session.name}
          sessionLabel={displayLabel(session)}
          initialRecall={recall}
          variant="popover"
        />
      </PopoverContent>
    </Popover>
  )
}

// ── LastSendSheet (mobile) ───────────────────────────────────────────────────

export interface LastSendSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  recall: LastSend
  session: Pick<ApiSession, 'name' | 'display_name'>
}

export function LastSendSheet({
  open,
  onOpenChange,
  recall,
  session,
}: LastSendSheetProps) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[60] bg-black/40" />
        <Drawer.Content
          aria-describedby={undefined}
          className={cn(
            'glass fixed inset-x-0 bottom-0 z-[60] flex max-h-[80vh] flex-col',
            'rounded-t-[10px] border-t border-border/60 pb-safe outline-none',
          )}
        >
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />
          <Drawer.Title className="px-4 pb-1 pt-3 text-[13px] font-semibold text-muted-foreground">
            Prompt history
          </Drawer.Title>
          <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-1">
            <RecallPanel
              sessionName={session.name}
              sessionLabel={displayLabel(session)}
              initialRecall={recall}
              variant="sheet"
            />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

// ── LastSendBar (desktop) — the auto-show glass strip ────────────────────────

export interface LastSendBarProps {
  recall: LastSend | null
  /** Resets the bar's auto-show effect when the user switches sessions. */
  sessionName: string
  /** Click on the bar (anywhere but ×) opens the popover. */
  onOpenRecall: () => void
}

/**
 * Glass strip rendered directly below the focus header (desktop only).
 *
 * VISIBILITY MODEL.
 *   Show whenever the session has a recall — i.e. the bar is the calm,
 *   persistent "what did I last say" reminder until the user explicitly
 *   dismisses it with × OR opens the popover (which carries the full text
 *   in front, making the bar redundant).
 *
 *   EARLIER REVISIONS auto-faded on terminal engagement (any keydown /
 *   pointerdown / wheel after appearance) + an 8s timer. That regressed:
 *   the bar would vanish while the user clicked into Claude's reply to
 *   copy text, while Claude was streaming output, or simply because they
 *   were reading. "Liever in meer scenarios laten staan dan irritant dat
 *   ie weg gaat terwijl ik m wou zien." So we keep it visible.
 *
 *   Triggers that DO hide the bar:
 *   - The × button (explicit user dismiss).
 *   - `onOpenRecall` (user opened the popover; the full text is now in front).
 *   - The recall going away (new session with no submission yet → no bar).
 *   - Session switch (the keyed mount in DesktopSplit replays the bar fresh).
 */
export function LastSendBar({ recall, sessionName, onOpenRecall }: LastSendBarProps) {
  const reduceMotion = useReducedMotion()
  const [dismissed, setDismissed] = React.useState(false)

  // Reset the dismissed flag on session change OR when the recall content
  // actually changes (new prompt came in via SSE — bring the bar back so the
  // user sees the fresh prompt without having to navigate away and back).
  React.useEffect(() => {
    setDismissed(false)
  }, [sessionName, recall?.text, recall?.sentAt.getTime()])

  const visible = !!recall && !dismissed
  const ariaLive = visible ? 'polite' : 'off'

  const openAndDismiss = React.useCallback(() => {
    setDismissed(true)
    onOpenRecall()
  }, [onOpenRecall])

  if (!recall) return null

  const enter = reduceMotion
    ? { opacity: 1, height: 32 }
    : { opacity: 1, height: 32, transition: { duration: 0.22 } }
  const exit = reduceMotion
    ? { opacity: 0, height: 0 }
    : { opacity: 0, height: 0, transition: { duration: 0.18 } }

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          layout="position"
          initial={{ opacity: 0, height: 0 }}
          animate={enter}
          exit={exit}
          aria-live={ariaLive}
          role="status"
          className="glass shrink-0 overflow-hidden border-b border-border/50 backdrop-blur-md"
        >
          <div className="flex h-8 items-center gap-2 px-3 text-[12px]">
            <button
              type="button"
              onClick={openAndDismiss}
              className="flex min-w-0 flex-1 items-center gap-2 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`You said ${formatRecallTime(recall.sentAt)}: ${recall.text}`}
            >
              <span className="shrink-0 font-medium text-foreground">
                You · {formatRecallTime(recall.sentAt)}
              </span>
              <span className="min-w-0 truncate italic text-foreground/85">
                “{recall.text}”
              </span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setDismissed(true)
              }}
              aria-label="Dismiss last prompt"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
