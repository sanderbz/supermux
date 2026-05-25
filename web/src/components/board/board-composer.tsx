import { useEffect, useId, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Bot, ChevronDown, Loader2, Play, Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useMediaQuery } from '@/hooks/use-media-query'
import { listBoardSessions, type BoardSession, type NewBoardIssue } from '@/lib/api'

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
export function BoardComposer({ onAdd, onAddAndStart }: BoardComposerProps) {
  const reduce = useReducedMotion()
  const fine = useMediaQuery('(pointer: fine)')
  const moreId = useId()

  const [description, setDescription] = useState('')
  const [title, setTitle] = useState('')
  const [session, setSession] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [due, setDue] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const [provider, setProvider] = useState<Provider>(loadLastProvider)
  const [sessions, setSessions] = useState<BoardSession[]>([])

  // SD-3: persist the agent pick so the next card (and a reload) defaults to it.
  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LAST_PROVIDER_KEY, provider)
    }
  }, [provider])
  // 'add' | 'start' tracks which action is in flight (distinct spinners).
  const [busy, setBusy] = useState<null | 'add' | 'start'>(null)
  const [error, setError] = useState<string | null>(null)

  // Lazily load live sessions only once More is opened (the only place a user
  // can link an existing one) — keeps the resting composer zero-cost.
  useEffect(() => {
    if (!moreOpen || sessions.length > 0) return
    let alive = true
    void listBoardSessions().then((s) => {
      if (alive) setSessions(s)
    })
    return () => {
      alive = false
    }
  }, [moreOpen, sessions.length])

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
    setSession('')
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

              <div className="grid grid-cols-2 gap-2">
                <Labeled label="Existing session">
                  <select
                    value={session}
                    onChange={(e) => setSession(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">Spawn a new one</option>
                    {sessions.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
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
        {/* More toggle + inline agent picker share one row (SD-3): the agent is
            visible without expanding More, "just as small" as the More affordance.
            The two primary actions own the full lane width below (never clip in a
            ~300px lane). */}
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

          {/* Which agent to start. Borderless + text-xs to match the More toggle's
              weight; the value is remembered for the next card. Applies to
              "Add & start" (a plain Add lands in To do with no agent yet). */}
          <label className="-my-1 inline-flex h-11 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors focus-within:text-foreground hover:text-foreground">
            <Bot className="size-3.5" aria-hidden />
            <span className="sr-only">Which agent to start</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
              aria-label="Which agent to start"
              className="cursor-pointer rounded-md bg-transparent py-0 pl-0 pr-1 text-xs font-medium capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p} className="capitalize">
                  {p}
                </option>
              ))}
            </select>
          </label>
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
