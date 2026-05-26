import * as React from 'react'
import { useEffect, useId, useMemo, useState } from 'react'
import { Drawer } from 'vaul'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  Check,
  ChevronDown,
  Loader2,
  Play,
  Plus,
  TerminalSquare,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useMediaQuery } from '@/hooks/use-media-query'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { listBoardSessions, type BoardSession, type NewBoardIssue } from '@/lib/api'
import { useLastCreateSession } from '@/stores/board-create-session-store'

/** The agent providers a spawned session can run (mirrors the new-session sheet
 *  + the server's session providers). */
const PROVIDERS = ['claude', 'shell'] as const
type Provider = (typeof PROVIDERS)[number]

/** SD-3: remember the last-picked agent across cards (and reloads) so the next
 *  task defaults to whatever you started last. */
const LAST_PROVIDER_KEY = 'supermux:board:last-provider'
function loadLastProvider(): Provider {
  if (typeof localStorage === 'undefined') return 'claude'
  const v = localStorage.getItem(LAST_PROVIDER_KEY)
  return (PROVIDERS as readonly string[]).includes(v ?? '')
    ? (v as Provider)
    : 'claude'
}

export interface BoardComposerProps {
  /** Create the card (lands in To do). Resolves once created. */
  onAdd: (input: NewBoardIssue) => Promise<void>
  /** Create + start an agent (lands in Doing). The `session` is null unless the
   *  user linked one via More — the route spawns a fresh session by default.
   *  `provider` is the agent picked inline in the composer (SD-3). */
  onAddAndStart: (input: NewBoardIssue, opts: { provider: string }) => Promise<void>
  /** Board-scoped default session (FEAT-BOARD-SESSION §B). When set, the session
   *  picker pre-selects this — used by per-session boards (their own session) +
   *  per-team boards (the team's lead session). `null` = no board scope; the
   *  composer falls back to the persisted last-used session. */
  defaultSession?: string | null
}

/**
 * Description-first composer at the top of the To do lane (BM2 §2.1). One
 * textarea is the whole surface; two primary actions collapse create + start
 * into a single move:
 *   • Add → creates the card in To do (no agent yet),
 *   • Add & Start → creates the card AND starts an agent (spawns a session by
 *     default), landing it in Doing.
 * A subtle, collapsed "More" reveals the optional fields (title, link an existing
 * session, acceptance lines, tags, due) — never shown by default.
 *
 * Keyboard (desktop): Enter = Add, ⌘/Ctrl-Enter = Add & Start.
 *
 * iOS-native finish: glass-free inline panel (it sits inside the lane), 10px
 * radii, ≥44pt actions, spring reveal for More, sentence-case copy.
 */
export function BoardComposer({
  onAdd,
  onAddAndStart,
  defaultSession = null,
}: BoardComposerProps) {
  const reduce = useReducedMotion()
  const fine = useMediaQuery('(pointer: fine)')
  const isMobile = useMediaQuery('(pointer: coarse)')
  const moreId = useId()

  // Persisted "last-used session" cell (FEAT-BOARD-SESSION §B). When the board
  // scope doesn't dictate a session (Main / All / a team without a live lead),
  // the composer falls back to this — updated on every successful submit.
  const [lastSession, setLastSession] = useLastCreateSession()

  const [description, setDescription] = useState('')
  const [title, setTitle] = useState('')
  // The picked session for the prominent picker. Resolution chain
  // (FEAT-BOARD-SESSION §B): `defaultSession` (board scope) → persisted
  // last-used → '' (no session). `''` is the explicit zero-attachment choice.
  const [session, setSession] = useState<string>(
    () => defaultSession ?? lastSession ?? '',
  )
  const [acceptance, setAcceptance] = useState('')
  const [due, setDue] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const [provider, setProvider] = useState<Provider>(loadLastProvider)
  const [sessions, setSessions] = useState<BoardSession[]>([])
  // Mobile session-picker sheet open/close. Mirrors the board-switcher / focus
  // session-picker-sheet (Vaul half-sheet, ≥44pt rows).
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false)

  // SD-3: persist the agent pick so the next card (and a reload) defaults to it.
  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LAST_PROVIDER_KEY, provider)
    }
  }, [provider])

  // When the board scope changes (the user switches to a per-session or
  // per-team board), re-apply the board's preferred session — but never
  // CLOBBER an in-progress draft (the user typed a description). The React docs'
  // "adjusting state in response to a prop change" pattern: compare the previous
  // and current `defaultSession` during RENDER and call setSession if needed (no
  // effect → no cascading render). React batches the resulting re-render before
  // committing, so this is the cheaper, idiomatic alternative to the
  // setState-in-effect lint flag.
  const [prevDefaultSession, setPrevDefaultSession] = useState(defaultSession)
  if (defaultSession !== prevDefaultSession) {
    setPrevDefaultSession(defaultSession)
    if (defaultSession != null && description.trim().length === 0) {
      setSession(defaultSession)
    }
  }

  // 'add' | 'start' tracks which action is in flight (distinct spinners).
  const [busy, setBusy] = useState<null | 'add' | 'start'>(null)
  const [error, setError] = useState<string | null>(null)

  // The session list now powers the PROMINENT picker, so load it eagerly the
  // first time it's needed (mobile sheet open OR desktop dropdown open OR More
  // open for back-compat). Cached in state — one fetch per composer mount.
  const needSessionList = sessionSheetOpen || moreOpen
  useEffect(() => {
    if (!needSessionList || sessions.length > 0) return
    let alive = true
    void listBoardSessions().then((s) => {
      if (alive) setSessions(s)
    })
    return () => {
      alive = false
    }
  }, [needSessionList, sessions.length])

  const trimmedDesc = description.trim()
  const canSubmit = trimmedDesc.length > 0

  function buildInput(): NewBoardIssue {
    const accLines = acceptance
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    return {
      description: trimmedDesc,
      title: title.trim() || undefined,
      session: session || null,
      due: due || null,
      tags: tags.length ? tags : undefined,
      acceptance: accLines.length ? accLines : undefined,
    }
  }

  function reset() {
    setDescription('')
    setTitle('')
    // Re-seed the session to the board scope (per-session / per-team default) or
    // the just-persisted last-used — same chain as first paint, so the NEXT card
    // creation starts where the previous one ended (zero clicks in the common
    // case, per FEAT-BOARD-SESSION §B).
    setSession(defaultSession ?? lastSession ?? '')
    setAcceptance('')
    setDue('')
    setTags([])
    setTagInput('')
    setMoreOpen(false)
  }

  async function run(mode: 'add' | 'start') {
    if (!canSubmit || busy) {
      if (!canSubmit) setError('Describe a task for the agent.')
      return
    }
    setBusy(mode)
    setError(null)
    try {
      const input = buildInput()
      if (mode === 'add') await onAdd(input)
      else await onAddAndStart(input, { provider })
      // Remember the session we just used, so the next card defaults to it on
      // Main / All (when no board scope applies). Includes the explicit
      // "(no session)" choice — '' is a meaningful pick the user might want
      // back next time.
      setLastSession(session)
      reset()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the task.')
    } finally {
      setBusy(null)
    }
  }

  function addTag(raw: string) {
    const t = raw.trim().replace(/,$/, '')
    if (t && !tags.includes(t)) setTags((prev) => [...prev, t])
    setTagInput('')
  }

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-background/80 p-2.5 shadow-sm">
      <textarea
        value={description}
        placeholder="Describe a task for an agent…"
        aria-label="Describe a task for an agent"
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          // Desktop shortcuts: ⌘/Ctrl-Enter = Add & Start; Enter = Add. On a
          // coarse pointer the two buttons own intent (Enter inserts a newline).
          if (e.key !== 'Enter' || !fine) return
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            void run('start')
          } else if (!e.shiftKey) {
            e.preventDefault()
            void run('add')
          }
        }}
        rows={2}
        className="flex w-full resize-none rounded-md border-0 bg-transparent px-1.5 py-1 text-base md:text-sm placeholder:text-muted-foreground focus-visible:outline-none"
      />

      {/* More — optional fields, collapsed by default. */}
      <AnimatePresence initial={false}>
        {moreOpen && (
          <motion.div
            id={moreId}
            key="more"
            initial={reduce ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={reduce ? { duration: 0 } : springs.snappy}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-3 px-1.5 pb-1 pt-1">
              <Labeled label="Title">
                <Input
                  value={title}
                  placeholder="Short summary (optional)"
                  onChange={(e) => setTitle(e.target.value)}
                  className="h-9"
                />
              </Labeled>

              {/* Agent + Due share a row. FEAT-BOARD-SESSION §B: the agent
                  toggle moved INTO More (was prominent before) since the prominent
                  slot now hosts the session picker — the more common dimension to
                  vary per-card. Default `claude`. */}
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="Agent">
                  <select
                    value={provider}
                    onChange={(e) => setProvider(e.target.value as Provider)}
                    aria-label="Which agent to start"
                    className="flex h-9 w-full cursor-pointer rounded-md border border-input bg-transparent px-2 text-sm capitalize shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p} className="capitalize">
                        {p}
                      </option>
                    ))}
                  </select>
                </Labeled>
                <Labeled label="Due">
                  <Input
                    type="date"
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                    className="h-9"
                  />
                </Labeled>
              </div>

              <Labeled label="Acceptance criteria">
                <textarea
                  value={acceptance}
                  placeholder="One per line"
                  onChange={(e) => setAcceptance(e.target.value)}
                  rows={2}
                  className="flex w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </Labeled>

              <Labeled label="Tags">
                <div className="flex flex-col gap-2">
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {tags.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                        >
                          {t}
                          <button
                            type="button"
                            aria-label={`Remove ${t}`}
                            onClick={() =>
                              setTags((prev) => prev.filter((x) => x !== t))
                            }
                            className="grid size-4 place-items-center rounded-full hover:bg-foreground/10"
                          >
                            <X className="size-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <Input
                    value={tagInput}
                    placeholder="Add a tag, press Enter"
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault()
                        addTag(tagInput)
                      }
                    }}
                    onBlur={() => tagInput && addTag(tagInput)}
                    className="h-9"
                  />
                </div>
              </Labeled>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {error && (
        <p className="px-1.5 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {/* More toggle + the PROMINENT session picker share one row
            (FEAT-BOARD-SESSION §B). The session picker replaced the inline
            agent toggle as the headline composer field — most cards SEND to a
            specific session; the Claude/Shell toggle is now advanced (in More).
            The two primary actions own the full lane width below. */}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            aria-expanded={moreOpen}
            aria-controls={moreId}
            onClick={() => setMoreOpen((v) => !v)}
            className="-my-1 inline-flex h-11 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <motion.span
              animate={{ rotate: moreOpen ? 180 : 0 }}
              transition={reduce ? { duration: 0 } : springs.snappy}
              className="inline-flex"
            >
              <ChevronDown className="size-3.5" />
            </motion.span>
            More
          </button>

          <SessionPicker
            value={session}
            sessions={sessions}
            isMobile={isMobile}
            sheetOpen={sessionSheetOpen}
            onSheetOpenChange={setSessionSheetOpen}
            onPick={setSession}
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void run('add')}
            disabled={!canSubmit || busy !== null}
            className="h-11 flex-1"
            title={fine ? 'Add to To do (Enter)' : 'Add to To do'}
          >
            {busy === 'add' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add
          </Button>
          <Button
            onClick={() => void run('start')}
            disabled={!canSubmit || busy !== null}
            className="h-11 flex-1"
            title={fine ? 'Create and start an agent (⌘↵)' : 'Create and start an agent'}
          >
            {busy === 'start' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            Add &amp; start
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Session picker (the prominent field; FEAT-BOARD-SESSION §B) ────────────────
//
// Mirrors the visual treatment of `board-switcher.tsx` (which itself mirrors the
// focus mode-menu pill + session-picker-sheet pattern), so the composer's picker
// reads as the SAME affordance — same chic pill on desktop, same Vaul half-sheet
// on mobile. DRY by visual pattern, not by component (the rows are simpler here:
// one bare list of session names plus an explicit "(no session)" entry).
//
// `value` is `''` for the explicit zero-attachment "(no session)" choice.
//
function SessionPicker({
  value,
  sessions,
  isMobile,
  sheetOpen,
  onSheetOpenChange,
  onPick,
}: {
  value: string
  sessions: BoardSession[]
  isMobile: boolean
  sheetOpen: boolean
  onSheetOpenChange: (open: boolean) => void
  onPick: (name: string) => void
}) {
  // Tolerate a board-scoped default (e.g. a per-team lead) that's not in the
  // live session cache yet: render it verbatim so the pill never reads "(no
  // session)" while the list is still loading.
  const options = useMemo(() => {
    const seen = new Set<string>()
    const out: { name: string; label: string }[] = [
      { name: '', label: '(no session)' },
    ]
    if (value && !sessions.some((s) => s.name === value)) {
      out.push({ name: value, label: value })
      seen.add(value)
    }
    for (const s of sessions) {
      if (seen.has(s.name)) continue
      out.push({ name: s.name, label: s.name })
    }
    return out
  }, [sessions, value])

  const label = value || '(no session)'
  const ariaLabel = `Session: ${label} — switch`

  const trigger = (onClick?: () => void) => (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.97 }}
      transition={springs.buttonPress}
      aria-label={ariaLabel}
      className={cn(
        'group inline-flex h-8 max-w-[60%] shrink items-center gap-1.5 rounded-full pl-2.5 pr-1.5',
        'bg-secondary text-xs font-medium leading-none text-foreground/90',
        'transition-colors hover:text-foreground active:bg-secondary/70',
        'data-[state=open]:bg-secondary data-[state=open]:text-foreground',
      )}
    >
      <TerminalSquare
        className="size-3.5 shrink-0 opacity-70"
        aria-hidden
      />
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDown
        className="size-3.5 shrink-0 opacity-50 transition-transform group-data-[state=open]:rotate-180"
        aria-hidden
      />
    </motion.button>
  )

  if (isMobile) {
    return (
      <>
        {trigger(() => onSheetOpenChange(true))}
        <SessionPickerSheet
          open={sheetOpen}
          onOpenChange={onSheetOpenChange}
          options={options}
          selected={value}
          onPick={(name) => {
            onPick(name)
            onSheetOpenChange(false)
          }}
        />
      </>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger()}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56 max-h-[60vh] overflow-y-auto">
        <DropdownMenuLabel className="text-muted-foreground">
          Send to session
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={onPick}>
          {options.map((o, idx) => (
            <React.Fragment key={`${idx}-${o.name}`}>
              {idx === 1 && options.length > 1 && <DropdownMenuSeparator />}
              <DropdownMenuRadioItem value={o.name} className="gap-2 py-2">
                {o.name ? (
                  <TerminalSquare
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                ) : (
                  <span className="size-4 shrink-0" aria-hidden />
                )}
                <span
                  className={cn(
                    'truncate text-sm',
                    !o.name && 'text-muted-foreground',
                  )}
                >
                  {o.label}
                </span>
              </DropdownMenuRadioItem>
            </React.Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SessionPickerSheet({
  open,
  onOpenChange,
  options,
  selected,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: { name: string; label: string }[]
  selected: string
  onPick: (name: string) => void
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[60] bg-black/40" />
        <Drawer.Content
          aria-describedby={undefined}
          className={cn(
            'glass fixed inset-x-0 bottom-0 z-[60] flex max-h-[70vh] flex-col',
            'rounded-t-[10px] border-t border-border/60 pb-safe outline-none',
          )}
        >
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />
          <Drawer.Title className="px-4 pb-1 pt-3 text-[13px] font-semibold text-muted-foreground">
            Send to session
          </Drawer.Title>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {options.map((o, idx) => {
              const isCurrent = o.name === selected
              return (
                <motion.button
                  key={`${idx}-${o.name}`}
                  type="button"
                  whileTap={{ scale: 0.98 }}
                  transition={springs.buttonPress}
                  onClick={() => onPick(o.name)}
                  className={cn(
                    'flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left',
                    isCurrent ? 'bg-secondary' : 'active:bg-secondary/60',
                  )}
                >
                  {o.name ? (
                    <TerminalSquare
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  ) : (
                    <span className="size-4 shrink-0" aria-hidden />
                  )}
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[15px] font-medium',
                      !o.name && 'text-muted-foreground',
                    )}
                  >
                    {o.label}
                  </span>
                  {isCurrent && (
                    <Check
                      className="size-4 shrink-0 text-primary"
                      aria-label="Current"
                    />
                  )}
                </motion.button>
              )
            })}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

function Labeled({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={cn('text-xs font-medium text-muted-foreground')}>
        {label}
      </span>
      {children}
    </label>
  )
}
