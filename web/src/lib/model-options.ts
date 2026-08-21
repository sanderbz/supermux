// The per-provider MODEL allowlist — the web mirror of the server's
// `lifecycle::resolve_model_flag` (an unknown id is a 400 there). One source of
// truth so the bot panel's live picker and the create sheet's Advanced picker
// offer the exact same set and never drift from the CLI's accepted `--model`
// ids. Pure data + a switch, no React/DOM deps, so it stays cheap to import
// from the entry-chunk create sheet without dragging the lazy bot-panel in.
//
// `''` = the provider default (send nothing on create / current launch line).
export function modelOptions(provider?: string): { value: string; label: string }[] {
  const p = (provider || '').toLowerCase()
  if (p === 'codex')
    return [
      { value: '', label: 'Default' },
      { value: 'gpt-5-codex', label: 'gpt-5-codex' },
      { value: 'gpt-5', label: 'gpt-5' },
      { value: 'o3', label: 'o3' },
      { value: 'o4-mini', label: 'o4-mini' },
    ]
  // Claude is the default provider (and the empty/unknown launcher case).
  if (p === 'claude' || p === '')
    return [
      { value: '', label: 'Default' },
      { value: 'opus', label: 'opus' },
      { value: 'sonnet', label: 'sonnet' },
      { value: 'haiku', label: 'haiku' },
    ]
  return []
}
