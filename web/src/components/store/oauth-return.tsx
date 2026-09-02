/**
 * <OauthReturnEffect> — the boot-time half of the brokered sign-in.
 *
 * Mounted ONCE in <Layout>. When the URL carries `?oauth_pending=1` (the public
 * callback's success redirect) or `?connect_error=…` (its uniform failure), it
 * finishes the flow with the AUTHENTICATED `complete`, toasts the honest outcome
 * ("Connected as sander@… — <probe error>"), refetches the connector surfaces,
 * and strips the query from history (`replaceState`). All the logic is the pure
 * `handleOauthReturn`; this is only the React + router glue.
 */
import * as React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'

import { completeMcpOauth } from '@/lib/api/oauth'
import { browserPendingStore, handleOauthReturn, isOauthReturn, stripOauthParams } from '@/lib/oauth-pending'
import { CONNECTORS_KEY, sessionConnectorsKey } from '@/stores/connectors-store'
import { useToast } from '@/components/ui/use-toast'

export function OauthReturnEffect() {
  const { pathname, search, hash } = useLocation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { toast } = useToast()
  // One run per return URL (React strict-mode double effects included).
  const handled = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (!isOauthReturn(search)) return
    const key = `${pathname}${search}`
    if (handled.current === key) return
    handled.current = key
    const invalidate = (target?: string) => {
      void qc.invalidateQueries({ queryKey: CONNECTORS_KEY })
      // The SINGLE-card read too (`GET /api/connectors/{id}`, key `['connector', id]`):
      // it is what the store detail and the chat Connect card resolve "connected
      // as whom" from, and it now carries the accounts. Leaving it cached was the
      // last way the return could still paint a not-connected card over a
      // connector the server had just connected.
      void qc.invalidateQueries({ queryKey: ['connector'] })
      void qc.invalidateQueries({ queryKey: ['session-connectors'] })
      void qc.invalidateQueries({ queryKey: ['connector-grants'] })
      if (target) void qc.invalidateQueries({ queryKey: sessionConnectorsKey(target) })
    }
    void handleOauthReturn(search, {
      complete: completeMcpOauth,
      store: browserPendingStore(),
      toast: (message, tone) => toast({ message, tone: tone === 'error' ? 'error' : 'default', duration: 5000 }),
      invalidate,
    }).finally(() => {
      // Strip the return params so a reload / back never replays them.
      navigate(`${pathname}${stripOauthParams(search)}${hash}`, { replace: true })
    })
  }, [pathname, search, hash, navigate, qc, toast])

  return null
}
