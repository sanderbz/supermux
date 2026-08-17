// The login flow's data plane — one action endpoint, no second poller.
//
// The READ comes from the capture the chat surface already polls
// (`use-peek-lens.ts` → `readLogin`), not from a `GET /login` of its own: the
// card must appear in the same tick the dialog does, and a surface that polls
// the same pty twice at two cadences is how two consumers end up disagreeing
// about which screen is up.
//
// The WRITE is `POST /api/sessions/{name}/login`, one route with an `action`.
// Every one of those actions is a keystroke into a live terminal, so they are
// serialised behind `busy` — two Enters racing on a credential field is not a
// state anybody has debugged.
//
// THE CODE IS A CREDENTIAL. It is passed straight to the POST and dropped: it is
// never put in state, never in a ref, never in an error message, never logged.
// The server does the same on its side (`login.rs`).

import * as React from 'react'

import { sessionRequest } from '@/lib/api'

import {
  readLogin,
  readProviderAuth,
  type LoginSighting,
  type LoginStage,
  type ProviderAuth,
} from './login-lens'

export interface LoginHandle {
  /** What is on the screen, read off the shared peek capture. */
  sighting: LoginSighting | null
  /** A codex / kimi device-auth screen — detected and explained, never driven
   *  (their device-code lifecycles are their own). Never set at the same time as
   *  `sighting`: one screen is one thing. */
  providerAuth: ProviderAuth | null
  /**
   * Is supervision actually frozen? Read from the server, not assumed.
   *
   * The card tells the user "nothing else will write to this session until you
   * finish", which is the reason they can walk to another device. That sentence
   * has to be a FACT, and the fact lives server-side (the detector tick freezes
   * on the screen; the API freezes on `start`). So it is fetched — once when a
   * login appears and again on every stage change, which is four requests for a
   * whole flow rather than a second poller.
   */
  frozen: boolean
  busy: boolean
  /** The last failure from the server, verbatim — including the 409 a frozen
   *  session answers with, which is a sentence the user can act on. */
  error: string | null
  submitCode: (code: string, retry: boolean) => void
  chooseMethod: (index: number) => void
  confirm: () => void
  cancel: () => void
  /** Begin a flow this app initiated (the "Sign in" affordance on an auth-dead
   *  session), rather than one the user typed `/login` for. */
  start: (design?: boolean) => void
}

type Action =
  | { action: 'start'; design: boolean }
  | { action: 'method'; index: number }
  | { action: 'code'; code: string; clear: boolean }
  | { action: 'confirm' }
  | { action: 'cancel' }

export function useLogin(name: string, capture: string): LoginHandle {
  const [busy, setBusy] = React.useState(false)
  const sighting = React.useMemo(() => readLogin(capture), [capture])
  const providerAuth = React.useMemo(
    () => (sighting ? null : readProviderAuth(capture)),
    [capture, sighting],
  )
  const stage = sighting?.stage ?? null

  // Both facts below are STAMPED WITH THE STAGE THEY BELONG TO and derived
  // during render, rather than reset from an effect. An effect that clears
  // state on a dependency change renders the stale value once first — and the
  // stale values here are the two that must never be shown: an "Invalid code"
  // from two stages ago sitting under the success card, and a freeze claim for
  // a login that is over. (It is also what `react-hooks/set-state-in-effect`
  // objects to, and the rule is right about this one.)
  const [errAt, setErrAt] = React.useState<{ stage: LoginStage | null; message: string } | null>(
    null,
  )
  const error = errAt && errAt.stage === stage ? errAt.message : null

  const [frozenAt, setFrozenAt] = React.useState<{ stage: LoginStage | null; value: boolean }>({
    stage: null,
    value: false,
  })
  const frozen = stage !== null && frozenAt.stage === stage && frozenAt.value

  // The freeze fact, asked for once per stage. No login on screen → no request
  // and no claim. The only `setState` is in the async callback, which is the
  // shape the rule above allows: this is a subscription to an external system,
  // not a reset.
  React.useEffect(() => {
    if (!stage) return
    let dead = false
    void sessionRequest<{ frozen?: boolean }>(
      `/api/sessions/${encodeURIComponent(name)}/login`,
    )
      .then((d) => {
        if (!dead) setFrozenAt({ stage, value: Boolean(d?.frozen) })
      })
      .catch(() => {
        // Could not ask → do not claim. The card simply omits the sentence.
        if (!dead) setFrozenAt({ stage, value: false })
      })
    return () => {
      dead = true
    }
  }, [name, stage])

  const post = React.useCallback(
    (body: Action) => {
      setBusy(true)
      setErrAt(null)
      void sessionRequest(`/api/sessions/${encodeURIComponent(name)}/login`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
        .catch((e: unknown) => {
          setErrAt({
            // Stamped with the stage the POST was made FROM: if the screen has
            // moved on by the time the rejection lands, the message belongs to
            // the screen that is gone and is derived away rather than shown
            // under the next one.
            stage,
            message: e instanceof Error ? e.message : 'That did not go through.',
          })
        })
        .finally(() => setBusy(false))
    },
    [name, stage],
  )

  return React.useMemo<LoginHandle>(
    () => ({
      sighting,
      providerAuth,
      frozen,
      busy,
      error,
      // `retry` → the server sends Ctrl-U first. Only on a retry: after a
      // rejection the field may still hold the refused attempt, and a paste
      // appended to it is refused forever. On a first attempt the field is
      // known-empty and a blind control byte would be the bigger risk.
      submitCode: (code, retry) => post({ action: 'code', code, clear: retry }),
      chooseMethod: (index) => post({ action: 'method', index }),
      confirm: () => post({ action: 'confirm' }),
      cancel: () => post({ action: 'cancel' }),
      start: (design = false) => post({ action: 'start', design }),
    }),
    [sighting, providerAuth, frozen, busy, error, post],
  )
}
