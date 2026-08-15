// The input plane's public surface. Import from here, never from the
// implementation files, so a call site never learns which plane it is on.

export type { KeyName, SessionInput } from './types'
export { restSessionInput } from './rest'
export type { RestRequest, RestSessionInputOptions } from './rest'
export { terminalSessionInput, TERMINAL_KEY_BYTES } from './terminal'
export type { TerminalLike, TerminalSource } from './terminal'
export { useTerminalInput } from './use-terminal-input'
export { inputRoutes } from './routes'
