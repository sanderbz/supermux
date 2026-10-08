/** Actionable send failures without exposing HTTP/session diagnostics as UI. */
export function sendFailureNote(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : undefined
  const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
  if (status === 409 && message && /unsent terminal draft/i.test(message)) {
    return 'Finish or clear the draft in Terminal, then retry.'
  }
  if (status === 0) return 'Connection interrupted. Your message is saved — retry when connected.'
  return message
}
