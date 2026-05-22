import * as React from 'react'
import { motion } from 'framer-motion'
import { Check, Copy, Eye, EyeOff } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** Tap-to-copy with inline confirmation. Never logs or persists the value — it
 *  goes straight to the clipboard. 44pt hit target, native press spring. */
export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  React.useEffect(() => () => clearTimeout(timer.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      return // clipboard blocked (insecure context) — no-op, no throw
    }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Button
      asChild
      variant="secondary"
      onClick={copy}
      aria-label={label}
      className={cn('h-11 gap-1.5', className)}
    >
      <motion.button whileTap={{ scale: 0.96 }} transition={springs.buttonPress}>
        {copied ? (
          <Check className="text-status-active" />
        ) : (
          <Copy />
        )}
        <span className="text-[13px]">{copied ? 'Copied' : label}</span>
      </motion.button>
    </Button>
  )
}

/** Show a secret the user already owns (their dashboard token). Masked by
 *  default; an explicit reveal toggle is required to see it, and the value is
 *  read from the runtime (never embedded in source). */
export function RevealableSecret({ value }: { value: string }) {
  const [shown, setShown] = React.useState(false)
  const display = value || '—'

  return (
    <div className="flex items-center gap-2">
      <code
        className={cn(
          'min-w-0 flex-1 truncate rounded-lg bg-secondary px-3 py-2 font-mono text-[13px]',
          shown ? 'text-foreground' : 'tracking-[0.2em] text-muted-foreground',
        )}
      >
        {value ? (shown ? display : '••••••••••••') : 'Not available'}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={shown ? 'Hide token' : 'Reveal token'}
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
        disabled={!value}
        className="size-11 shrink-0 text-muted-foreground"
      >
        {shown ? <EyeOff /> : <Eye />}
      </Button>
      <CopyButton value={value} label="Copy" className="shrink-0" />
    </div>
  )
}

/** API-key entry. Shows the server's MASKED preview as the current state and
 *  takes a new value to PATCH. Cleared after a successful save. */
export function MaskedKeyField({
  label,
  currentMasked,
  placeholder,
  saving,
  onSave,
}: {
  label: string
  currentMasked?: string
  placeholder: string
  saving?: boolean
  onSave: (value: string) => void
}) {
  const [value, setValue] = React.useState('')
  const [shown, setShown] = React.useState(false)
  const dirty = value.trim().length > 0

  function save() {
    if (!dirty || saving) return
    onSave(value.trim())
    setValue('')
    setShown(false)
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[15px] leading-tight text-foreground">{label}</span>
        <span className="font-mono text-[12px] text-muted-foreground">
          {currentMasked ? currentMasked : 'Not set'}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            type={shown ? 'text' : 'password'}
            value={value}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
            className="h-11 pr-11 font-mono text-[13px]"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={shown ? 'Hide' : 'Reveal'}
            aria-pressed={shown}
            onClick={() => setShown((s) => !s)}
            className="absolute right-0 top-0 size-11 text-muted-foreground"
          >
            {shown ? <EyeOff /> : <Eye />}
          </Button>
        </div>
        <Button
          asChild
          onClick={save}
          disabled={!dirty || saving}
          className="h-11 shrink-0"
        >
          <motion.button whileTap={{ scale: 0.96 }} transition={springs.buttonPress}>
            {saving ? 'Saving…' : 'Save'}
          </motion.button>
        </Button>
      </div>
    </div>
  )
}
