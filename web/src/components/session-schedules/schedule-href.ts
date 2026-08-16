// Where "manage all schedules" goes — one function, one place (fase B4 T8.4).
//
// PURE AND IMPORT-FREE: it is the only thing in the tree that may know a
// scheduler route, and the `bun test` runner resolves no `@/` aliases.
//
// WHY THIS EXISTS AT ALL. B1 folded the standalone `/scheduler` route into
// Settings (`/settings#schedules`) and left a redirect behind. B4 was written
// while B1 was still in flight, so every B4 surface was built to depend on
// `components/scheduler/*` and on nothing route-shaped — with exactly one
// unavoidable exception, the "manage all schedules" link at the foot of the
// per-session sheet. That link goes through here, so if the fold is ever
// reverted, or a third home is chosen, ONE constant moves and no other file in
// the tree learns about it.

/**
 * Does the built app have the Settings → Schedules section?
 *
 * `true` since B1 landed (PR #69: `routes/scheduler.tsx` deleted,
 * `components/settings/schedules-section.tsx` added, `/scheduler` redirected to
 * `/settings#schedules` in `App.tsx`). This is a BUILD-TIME fact, not a runtime
 * one — the section either is in the bundle or it is not — so it is a constant
 * rather than a DOM probe that would have to run before the router mounts and
 * would be wrong on the first paint either way.
 *
 * Flip it if the fold is ever reverted; `scheduleAdminHref` and its test cover
 * both worlds.
 */
export const SETTINGS_HAS_SCHEDULES = true

/** The Settings section's anchor, in one place so a rename cannot half-land. */
export const SETTINGS_SCHEDULES_HASH = '#schedules'

/**
 * The href for "manage all schedules".
 *
 * @param folded whether the Settings section exists (defaults to the built
 *               app's answer). A parameter so both branches are reachable from
 *               a test without stubbing a module.
 */
export function scheduleAdminHref(folded: boolean = SETTINGS_HAS_SCHEDULES): string {
  return folded ? `/settings${SETTINGS_SCHEDULES_HASH}` : '/scheduler'
}
