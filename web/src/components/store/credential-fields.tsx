/**
 * The one shared credential-field widget set for the store.
 *
 * `ConnectFlow` (the connect card / connector-detail connect step), the store's
 * `connector-detail` PlainField and `installed-panel` add/replace form all collect
 * the same thing — plain text fields + a masked secret with a reveal toggle. This
 * is that single implementation. Both visual treatments live behind one `chat`
 * flag: the frosted in-chat card (`chat`) and the plain store surface (default).
 *
 * Keeping ONE atom here is what makes "two secret-paste widgets in one store"
 * impossible — every surface renders the identical masking / label / paste box.
 */
import { Eye, EyeOff } from 'lucide-react'

// Relative imports only: this module is on the chat `ConnectCard`'s import chain
// (via connect-flow.tsx), and the chat unit runner resolves the root tsconfig
// with no `paths` alias — exactly like connect-flow.tsx / live-layer.tsx.
import { cn } from '../../lib/utils'
import { type CredentialField } from '../../lib/api/connectors'

/** A plain (non-secret) credential text field. */
export function CredentialTextField({
  field,
  chat = false,
  value,
  onChange,
}: {
  field: CredentialField
  chat?: boolean
  value: string
  onChange: (v: string) => void
}) {
  const id = `connect-${field.key}`
  return (
    <div className={chat ? '' : 'flex flex-col gap-1.5'}>
      <label
        htmlFor={id}
        className={cn('font-medium', chat ? 'block text-[12.6px] leading-[1.3] text-ink-2' : 'text-[12.5px] text-foreground')}
      >
        {field.title || field.key}
        {field.required && <span className={cn('ml-1', chat ? 'text-ink-3' : 'text-muted-foreground')}>*</span>}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={field.title || field.key}
        className={cn(
          chat
            ? 'mt-[4px] h-[34px] w-full rounded-[9px] border-[0.5px] border-hairline bg-fill-soft px-[10px] text-[13px] text-ink outline-none focus-visible:border-[color-mix(in_oklab,var(--sm-accent)_55%,transparent)]'
            : 'h-11 w-full rounded-xl border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring',
        )}
      />
    </div>
  )
}

/** A masked secret field with a show/hide reveal toggle. Reveal is controlled by
 *  the caller so the surrounding form owns the state. The input id is keyed off
 *  the field so two flows can mount without colliding ids. */
export function CredentialSecretField({
  field,
  chat = false,
  value,
  reveal,
  onReveal,
  onChange,
}: {
  field: CredentialField
  chat?: boolean
  value: string
  reveal: boolean
  onReveal: () => void
  onChange: (v: string) => void
}) {
  const id = `connect-${field.key}`
  return (
    <div className={chat ? '' : 'flex flex-col gap-1.5'}>
      <label
        htmlFor={id}
        className={cn('font-medium', chat ? 'block text-[12.6px] leading-[1.3] text-ink-2' : 'text-[12.5px] text-foreground')}
      >
        {field.title || 'API key'}
        {field.required && <span className={cn('ml-1', chat ? 'text-ink-3' : 'text-muted-foreground')}>*</span>}
      </label>
      <div className={cn('relative flex items-center', chat ? 'mt-[4px]' : '')}>
        <input
          id={id}
          type={reveal ? 'text' : 'password'}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste your key"
          data-testid={chat ? 'chat-connect-secret' : undefined}
          aria-label={field.title || 'API key'}
          className={cn(
            'w-full font-mono outline-none',
            chat
              ? 'h-[34px] rounded-[9px] border-[0.5px] border-hairline bg-fill-soft px-[10px] pr-[36px] text-[13px] text-ink focus-visible:border-[color-mix(in_oklab,var(--sm-accent)_55%,transparent)]'
              : 'h-11 rounded-xl border border-input bg-background px-3 pr-11 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring',
          )}
        />
        <button
          type="button"
          onClick={onReveal}
          aria-label={reveal ? 'Hide key' : 'Show key'}
          className={cn(
            'absolute grid place-items-center rounded-lg text-muted-foreground hover:text-foreground',
            chat ? 'right-[5px] size-[26px] rounded-[7px] text-ink-3 hover:bg-fill-soft' : 'right-1.5 size-8 hover:bg-muted',
          )}
        >
          {reveal ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      </div>
    </div>
  )
}

/** A credential field's default value coerced to a string ('' when none). */
export function defaultStr(f: CredentialField): string {
  if (f.default === undefined || f.default === null) return ''
  return typeof f.default === 'string' ? f.default : String(f.default)
}
