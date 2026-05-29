// /dev/term/:name — verification page (DEV-only; lazy-loaded so it never
// ships in production, matching the /dev/tiles convention). Renders a full-height
// <LiveTerminal> against a real backend session plus a tiny send-row so the
// reviewer can prove keystrokes flow back over the WS and replay/live bytes
// render. The connection state is mirrored top-right for the visual critic.
//
// Usage: boot a session named `demo` (or pass ?name=foo), then open
// /dev/term/demo against a running supermux-server.

import * as React from 'react'
import { useParams, useSearchParams } from 'react-router-dom'

import { LiveTerminal } from '@/components/terminal/live-terminal'
import type { UseLiveTermResult } from '@/hooks/use-live-term'
import { springs } from '@/lib/springs'
import { motion } from 'framer-motion'

// Default send-row chips (Esc/Tab/Ctrl-C/Ctrl-U).
const CHIPS = ['Esc', 'Tab', 'Ctrl-C', 'Ctrl-U'] as const

export default function DevTerm() {
  const { name: routeName } = useParams()
  const [params] = useSearchParams()
  const name = routeName ?? params.get('name') ?? 'demo'

  const termRef = React.useRef<UseLiveTermResult | null>(null)
  const [input, setInput] = React.useState('')

  const onSend = () => {
    if (!input) return
    termRef.current?.send(input + '\r')
    setInput('')
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 pt-safe">
        <h1 className="text-sm font-semibold tracking-tight">
          Live terminal · <span className="font-mono">{name}</span>
        </h1>
        <span className="ml-auto text-xs text-muted-foreground">
          Needs a running supermux-server + a session named &ldquo;{name}&rdquo;
        </span>
      </header>

      <div className="min-h-0 flex-1">
        <LiveTerminal name={name} onReady={(t) => (termRef.current = t)} />
      </div>

      {/* Dock-lite send row — verifies sendKey + send round-trips. */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-t border-border px-3 pb-safe">
        <div className="flex gap-1.5">
          {CHIPS.map((label) => (
            <motion.button
              key={label}
              type="button"
              whileTap={{ scale: 0.96 }}
              transition={springs.buttonPress}
              onClick={() => termRef.current?.sendKey(label)}
              className="flex h-9 min-w-11 items-center justify-center rounded-lg border border-border bg-secondary px-2.5 font-mono text-[13px] font-semibold text-secondary-foreground"
            >
              {label}
            </motion.button>
          ))}
        </div>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSend()
          }}
          placeholder="Type a command, Enter to send"
          className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-base outline-none focus:ring-2 focus:ring-ring"
        />
        <motion.button
          type="button"
          whileTap={{ scale: 0.96 }}
          transition={springs.buttonPress}
          onClick={onSend}
          className="flex h-9 items-center rounded-lg bg-primary px-4 text-[15px] font-semibold text-primary-foreground"
        >
          Send
        </motion.button>
      </div>
    </div>
  )
}
