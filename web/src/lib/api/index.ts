// Barrel for the per-feature API modules. Re-exports the EXACT public surface
// the formerly-monolithic lib/api.ts had, so every existing
// `import … from '@/lib/api'` keeps resolving unchanged. Pure structural split
// — ZERO behavior change.
//
// client.ts holds shared primitives; only `ApiError` was part of the original
// public surface, so that is the single name re-exported from it here (the
// token/url/request helpers stay internal, as they were before the split).

export { ApiError } from './client'

export * from './sessions'
export * from './board'
export * from './boards'
export * from './scheduler'
export * from './files'
export * from './settings'
export * from './focus'
export * from './commands'
export * from './onboarding'
export * from './claude'
export * from './push'
export * from './teams-start'
export * from './teams'
export * from './hosts'
export * from './updates'
