// Thin shim. The API client was split from this single monolith into per-feature
// modules under `./api/` (client + files/settings/board/scheduler/focus/sessions
// + a barrel) to end the recurring api.ts merge-conflict class:
// future frontend milestones each touch their own feature file instead of all
// appending here. Pure structural refactor — ZERO behavior change.
//
// This re-export keeps the public surface byte-identical, so every existing
// `import … from '@/lib/api'` (and any relative variant) resolves unchanged with
// no consumer edits. There is no default export to forward.

export * from './api/index'
