// Onboarding / demo-agent API (M27 — Time to Wow).
//
// Additive per-feature module: it composes the existing `sessionsApi` (create +
// start) — it never re-implements the request layer. The barrel re-exports it
// so consumers `import { onboardingApi } from '@/lib/api'` like any other slice.
//
// `bootDemoAgent` is the one-tap "see supermux work in 30 seconds" affordance: it
// creates a session in the current working directory and boots it with the
// `/cso` skill prefilled (a fast, self-contained security review that produces
// visible output within seconds — the unboxing payoff). The session name is
// remembered in localStorage so "Run the 30-second demo" can later remove
// exactly that session without touching anything the user created.

import { sessionsApi, type ApiSession } from './sessions'
import { rememberDemoSession } from '../onboarding'

/** A short, URL/tmux-safe name for the demo session. */
function demoName(): string {
  const suffix = Math.random().toString(36).slice(2, 6)
  return `demo-${suffix}`
}

export const onboardingApi = {
  /** Create + boot a `/cso` code-reviewer demo agent in `dir`. Returns the new
   *  session so the caller can navigate into its focus view. The name is
   *  persisted as the demo session for the replay flow. */
  bootDemoAgent: async (dir: string): Promise<ApiSession> => {
    const name = demoName()
    const created = await sessionsApi.create({
      name,
      dir,
      provider: 'claude',
      desc: 'supermux demo — security review',
      command: '/cso',
    })
    const resolved = created?.name ?? name
    rememberDemoSession(resolved)
    // Boot tmux + send the `/cso` skill. Non-fatal: the row exists either way,
    // and the focus view can retry the start.
    try {
      await sessionsApi.start(resolved, '/cso')
    } catch {
      /* ignore — session created, start retryable from focus */
    }
    return { ...(created ?? ({} as ApiSession)), name: resolved }
  },

  /** Delete a session by name (used to clean up the demo agent before replay).
   *  Tolerates a 404 — a session already gone is exactly the desired state. */
  deleteSession: async (name: string): Promise<void> => {
    try {
      await sessionsApi.remove(name)
    } catch {
      /* already gone, or the endpoint rejected it — replay continues anyway */
    }
  },
}
