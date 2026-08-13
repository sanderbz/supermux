// The A1 renderer switch: chat default (flag on), terminal ONE tap away.
// Plain segmented control on existing tokens; the same-cell crossfade and
// mounted-but-hidden retention are fase A5 (§6.2) — A1 swaps components.

import { cn } from '@/lib/utils'

export function RendererSwitch({
  value,
  onChange,
}: {
  value: 'chat' | 'terminal'
  onChange: (v: 'chat' | 'terminal') => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Session renderer"
      className="inline-flex overflow-hidden rounded-md border border-border text-[12px]"
    >
      {(['chat', 'terminal'] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={value === v}
          data-testid={`renderer-${v}`}
          onClick={() => onChange(v)}
          className={cn(
            'px-2.5 py-1 capitalize transition-colors',
            value === v
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {v}
        </button>
      ))}
    </div>
  )
}
