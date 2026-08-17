// Providers supermux once shipped and has since RETIRED.
//
// Removing a provider removes its launcher, its status detector and its tools
// panel — but NOT the rows people already created with it. Those live on in
// deployed databases (`provider` is a free-form string on the wire), so the app
// keeps meeting them on every list and every focus route. The contract, mirrored
// on the server in `sessions::RETIRED_PROVIDERS`:
//
//   * they RENDER — a retired row is never dropped, never a blank card, never a
//     crash from an exhaustive switch that forgot it exists;
//   * they are INERT — no Start, no Resume, no tools sheet, no "make it a team".
//     The server refuses `POST /start` with a 400, and an affordance that can
//     only produce an error is worse than no affordance;
//   * they SAY SO — one honest line explaining why the buttons are gone, and
//     what the user can still do (read the history, archive the row).
//
// The set only ever shrinks: creating a session on a retired provider is
// rejected at the API boundary, so nothing new can enter it.
const RETIRED_PROVIDERS = ['kimi'] as const

/** Display names for retired providers — the wire value is a lowercase slug and
 *  a sentence should not shout it. Falls back to the raw string. */
const RETIRED_LABELS: Readonly<Record<string, string>> = {
  kimi: 'Kimi Code',
}

/** True when this session's provider no longer exists in supermux. */
export function isRetiredProvider(provider?: string | null): boolean {
  return !!provider && (RETIRED_PROVIDERS as readonly string[]).includes(provider)
}

/** Human label for a retired provider (`kimi` → `Kimi Code`). */
export function retiredProviderLabel(provider?: string | null): string {
  if (!provider) return 'This provider'
  return RETIRED_LABELS[provider] ?? provider
}

/** The one-line explanation shown in place of the start affordances. Sentence
 *  case, no exclamation, says what is gone AND what still works. */
export function retiredProviderNote(provider?: string | null): string {
  return `${retiredProviderLabel(provider)} sessions are retired — this one can’t be started again. Its details stay readable; archive it when you’re done.`
}
